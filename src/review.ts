import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ParsedArgs, ReviewMeta, ReviewRunResult } from "./types.js";
import { spawnBufferedChild, spawnStreamingChild, type ChildRunResult } from "./child-process.js";
import { loadPresets, loadSystemPrompt } from "./presets.js";
import { splitPayload, buildPrompt } from "./prompt.js";
import { parseVerdict } from "./verdict.js";
import { parseReviewResult, reviewExitCode } from "./review-result.js";
import { extractFinalText } from "./json-events.js";
import { makeRunSessionDir, newestJsonl } from "./session.js";
import { fail, hasPathSeparator, expandMaybeHome, normalizeTools } from "./utils.js";
import { resolveConfig } from "./config.js";
import { formatReviewMetaAscii, formatReviewMetaJsonLine } from "./meta-footer.js";

export function readReviewStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

export function childEnv(piBin: string): NodeJS.ProcessEnv {
  const pathEntries = [
    hasPathSeparator(piBin) ? path.dirname(piBin) : undefined,
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".pi", "agent", "bin"),
    path.join(os.homedir(), ".n", "bin"),
    process.env.PATH || "",
  ].filter(Boolean) as string[];

  return {
    ...process.env,
    PATH: [...new Set(pathEntries.join(":").split(":").filter(Boolean))].join(":"),
  };
}

/** Ensures the ASCII meta footer starts on its own line after streamed child stdout. */
export function metaLinePrefix(childStdout: string, streamMode: boolean): string {
  if (!streamMode || !childStdout) return "";
  return childStdout.endsWith("\n") ? "" : "\n";
}

/** True when the final text must be printed after exit instead of having streamed live. */
export function progressLogBuffersOutput(streamMode: boolean, hasProgressLog: boolean): boolean {
  return !streamMode || hasProgressLog;
}

export function childRuntimeError(child: Pick<ChildRunResult, "status" | "signal" | "error">): string | undefined {
  if (child.error) return child.error.message;
  if (child.signal) return `child pi terminated by signal ${child.signal}`;
  if ((child.status ?? 0) !== 0) return `child pi exited with status ${child.status}`;
  return undefined;
}

export function runModels(piBin: string, args: string[]): never {
  const result = spawnSync(piBin, ["--list-models", ...args], {
    stdio: "inherit",
    env: childEnv(piBin),
  });
  process.exit(result.status ?? (result.error ? 1 : 0));
}

export async function runReviewOnce(parsed: ParsedArgs, stdinText = readReviewStdin()): Promise<ReviewRunResult> {
  const config = resolveConfig();
  const presets = loadPresets(config.presetsFile);
  const preset = presets[parsed.mode];

  if (!preset) {
    fail(`unknown review mode: ${parsed.mode}\nAvailable modes: ${Object.keys(presets).join(", ")}`);
  }

  const payload = splitPayload(parsed.payload);
  const prompt = buildPrompt(parsed.mode, preset, payload, stdinText);
  const args: string[] = ["-p"];
  if (parsed.progressLog) args.push("--mode", "json");
  const systemPrompt = loadSystemPrompt(config.systemPromptFile);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  if (parsed.provider || preset.provider) args.push("--provider", (parsed.provider || preset.provider)!);
  if (parsed.model || preset.model) args.push("--model", (parsed.model || preset.model)!);
  if (parsed.thinking || preset.thinking) args.push("--thinking", (parsed.thinking || preset.thinking)!);
  const tools = parsed.tools || normalizeTools(preset.tools);
  if (tools) args.push("--tools", tools);

  const presetSkills = Array.isArray(preset.skillPaths) ? preset.skillPaths : [];
  for (const skill of [...presetSkills, ...parsed.skills]) {
    args.push("--skill", expandMaybeHome(skill)!);
  }

  let runSessionDir: string | undefined;
  let sessionHandle: string | undefined;

  if (parsed.continueHandle) {
    sessionHandle = expandMaybeHome(parsed.continueHandle);
    args.push("--session", sessionHandle!);
  } else if (parsed.keepSession) {
    runSessionDir = makeRunSessionDir(config.sessionsRoot, parsed.mode);
    args.push("--session-dir", runSessionDir);
    args.push("--name", parsed.name || `pi-review:${parsed.mode}`);
  } else {
    args.push("--no-session");
  }

  args.push(...payload.fileRefs, prompt);

  let progressStream: fs.WriteStream | undefined;
  let progressStreamError: Error | undefined;
  if (parsed.progressLog) {
    try {
      fs.mkdirSync(path.dirname(parsed.progressLog), { recursive: true });
    } catch (error) {
      fail(`failed to prepare --progress-log directory: ${(error as Error).message}`);
    }
    progressStream = fs.createWriteStream(parsed.progressLog, { flags: "a" });
    progressStream.on("error", (error) => {
      progressStreamError = error;
    });
  }

  const startedAt = Date.now();
  const spawnOpts = {
    cwd: process.cwd(),
    env: childEnv(config.piBin),
    ...(progressStream ? { stdoutSink: progressStream } : {}),
  };
  const child = parsed.stream
    ? await spawnStreamingChild(config.piBin, args, spawnOpts)
    : spawnBufferedChild(config.piBin, args, spawnOpts);
  const durationMs = Date.now() - startedAt;

  if (progressStream) {
    await new Promise<void>((resolve) => progressStream!.end(() => resolve()));
    if (progressStreamError) {
      process.stderr.write(`pi-review: warning: --progress-log write failed: ${progressStreamError.message}\n`);
    }
  }

  let stdout = child.stdout || "";
  const stderr = child.stderr || "";
  let extractedError: string | undefined;
  let extractedFatal = false;
  if (parsed.progressLog) {
    const extracted = extractFinalText(stdout);
    stdout = extracted.text;
    extractedError = extracted.error;
    extractedFatal = Boolean(extracted.fatal);
  }

  const bufferedPrint = progressLogBuffersOutput(parsed.stream, Boolean(parsed.progressLog));
  if (bufferedPrint && stdout) {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (!parsed.stream && stderr) {
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  }

  if (parsed.keepSession) {
    sessionHandle = newestJsonl(runSessionDir);
  }

  let verdictInfo = parseVerdict(stdout);
  const runtimeError = childRuntimeError(child);
  if (runtimeError) {
    verdictInfo = {
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: runtimeError,
    };
  } else if (extractedFatal) {
    verdictInfo = {
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: extractedError,
    };
  } else if (extractedError) {
    verdictInfo = {
      ...verdictInfo,
      parseError: [verdictInfo.parseError, extractedError].filter(Boolean).join("; "),
    };
  }

  const structuredResult = parseReviewResult(stdout, verdictInfo);
  const meta: ReviewMeta = {
    reviewMode: parsed.mode,
    ...structuredResult,
    durationMs,
    model: parsed.model || preset.model || null,
    sessionHandle: sessionHandle || undefined,
  };

  const metaPrefix = metaLinePrefix(stdout, !bufferedPrint);
  if (metaPrefix) process.stdout.write(metaPrefix);
  process.stdout.write(`${formatReviewMetaAscii(meta)}\n`);
  const metaJsonDest = process.env.PI_REVIEW_META_STDOUT?.toLowerCase();
  const jsonLine = formatReviewMetaJsonLine(meta);
  if (metaJsonDest === "1" || metaJsonDest === "true" || metaJsonDest === "stdout") {
    process.stdout.write(jsonLine);
  } else {
    process.stderr.write(jsonLine);
  }
  return {
    meta,
    exitCode: reviewExitCode(meta.status),
  };
}

/** CLI-compatible single review entrypoint. */
export async function runReview(parsed: ParsedArgs): Promise<never> {
  const result = await runReviewOnce(parsed);
  process.exit(result.exitCode);
}
