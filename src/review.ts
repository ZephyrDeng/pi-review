import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ParsedArgs, ReviewMeta } from "./types.js";
import { spawnBufferedChild, spawnStreamingChild, type ChildRunResult } from "./child-process.js";
import { loadPresets, loadSystemPrompt } from "./presets.js";
import { splitPayload, buildPrompt } from "./prompt.js";
import { parseVerdict } from "./verdict.js";
import { makeRunSessionDir, newestJsonl } from "./session.js";
import { fail, hasPathSeparator, expandMaybeHome, normalizeTools } from "./utils.js";
import { resolveConfig } from "./config.js";

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    const fs = require("node:fs");
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function childEnv(piBin: string): NodeJS.ProcessEnv {
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

/** Ensures PI_REVIEW_META is on its own line after streamed child stdout. */
export function metaLinePrefix(childStdout: string, streamMode: boolean): string {
  if (!streamMode || !childStdout) return "";
  return childStdout.endsWith("\n") ? "" : "\n";
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

export async function runReview(parsed: ParsedArgs): Promise<void> {
  const config = resolveConfig();
  const presets = loadPresets(config.presetsFile);
  const preset = presets[parsed.mode];

  if (!preset) {
    fail(`unknown review mode: ${parsed.mode}\nAvailable modes: ${Object.keys(presets).join(", ")}`);
  }

  const stdinText = readStdin();
  const payload = splitPayload(parsed.payload);
  const prompt = buildPrompt(parsed.mode, preset, payload, stdinText);
  const args: string[] = ["-p"];
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

  const startedAt = Date.now();
  const spawnOpts = { cwd: process.cwd(), env: childEnv(config.piBin) };
  const child = parsed.stream
    ? await spawnStreamingChild(config.piBin, args, spawnOpts)
    : spawnBufferedChild(config.piBin, args, spawnOpts);
  const durationMs = Date.now() - startedAt;

  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  if (!parsed.stream) {
    if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
    if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
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
  }

  const meta: ReviewMeta = {
    reviewMode: parsed.mode,
    verdict: verdictInfo.verdict,
    verdictSource: verdictInfo.verdictSource,
    durationMs,
    model: parsed.model || preset.model || null,
    sessionHandle: sessionHandle || undefined,
    parseError: verdictInfo.parseError || undefined,
  };

  const metaPrefix = metaLinePrefix(stdout, parsed.stream);
  if (metaPrefix) process.stdout.write(metaPrefix);
  process.stdout.write(`PI_REVIEW_META: ${JSON.stringify(meta)}\n`);
  process.exit(child.status ?? (child.error || child.signal ? 1 : 0));
}
