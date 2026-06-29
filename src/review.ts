import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ParsedArgs, ReviewPreset, ReviewMeta } from "./types.js";
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

export function runModels(piBin: string, args: string[]): never {
  const result = spawnSync(piBin, ["--list-models", ...args], {
    stdio: "inherit",
    env: childEnv(piBin),
  });
  process.exit(result.status ?? (result.error ? 1 : 0));
}

export function runReview(parsed: ParsedArgs): void {
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
  const child = spawnSync(config.piBin, args, {
    cwd: process.cwd(),
    env: childEnv(config.piBin),
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;

  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);

  if (parsed.keepSession) {
    sessionHandle = newestJsonl(runSessionDir);
  }

  let verdictInfo = parseVerdict(stdout);
  if ((child.status ?? 0) !== 0) {
    verdictInfo = {
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: child.error ? child.error.message : `child pi exited with status ${child.status}`,
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

  process.stdout.write(`PI_REVIEW_META: ${JSON.stringify(meta)}\n`);
  process.exit(child.status ?? (child.error ? 1 : 0));
}
