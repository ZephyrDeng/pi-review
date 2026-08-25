import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { REVIEW_META_VERSION } from "./types.js";
import type { ParsedArgs, ReviewMeta, ReviewRunResult, StructuredReviewResult } from "./types.js";
import { spawnBufferedChild, spawnStreamingChild, type ChildRunResult } from "./child-process.js";
import { loadPresets, loadSystemPrompt } from "./presets.js";
import { splitPayload, normalizePayloadRefs, buildPrompt } from "./prompt.js";
import { parseVerdict } from "./verdict.js";
import { parseReviewResult, reviewExitCode } from "./review-result.js";
import { extractFinalText, extractUsage, JsonEventStream } from "./json-events.js";
import { ProgressLogWriter } from "./progress-log.js";
import type { TokenUsage } from "./types.js";
import { makeRunSessionDir, newestJsonl } from "./session.js";
import { fail, hasPathSeparator, expandMaybeHome, normalizeTools } from "./utils.js";
import { resolveConfig } from "./config.js";
import { splitModelProvider } from "./panel-config.js";
import { formatReviewMetaAscii, formatReviewMetaJsonLine } from "./meta-footer.js";
import { currentConfig, resolveChildExtensions } from "./pi-config.js";
import type { PiReviewConfig } from "./pi-config.js";

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

/**
 * Parse `pi --list-models` table output into distinct provider names.
 * Columns are space-padded; offsets are derived from the header row so
 * provider names are stable even if they contain spaces.
 */
export function parseModelCatalog(stdout: string): string[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.includes("provider") && l.includes("model"));
  if (headerIdx === -1) return [];
  const header = lines[headerIdx]!;
  const providerStart = header.indexOf("provider");
  const modelStart = header.indexOf("model");
  const providers = new Set<string>();
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const provider = line.slice(providerStart, modelStart).trim();
    if (provider) providers.add(provider);
  }
  return [...providers];
}

interface CatalogQuery {
  providers: Set<string>;
  /** False when `pi --list-models` itself failed; the query must not be cached or trusted. */
  ok: boolean;
}

const MODEL_CATALOG_CACHE = new Map<string, CatalogQuery>();

function catalogCacheKey(piBin: string, isolated: boolean): string {
  return `${piBin}|${isolated ? "no-ext" : "with-ext"}`;
}

function listProviders(piBin: string, isolated: boolean): CatalogQuery {
  const key = catalogCacheKey(piBin, isolated);
  const cached = MODEL_CATALOG_CACHE.get(key);
  if (cached) return cached;
  const args = ["--list-models", ...(isolated ? ["--no-extensions"] : [])];
  const result = spawnSync(piBin, args, {
    env: childEnv(piBin),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const query: CatalogQuery =
    result.status === 0 && result.stdout
      ? { providers: new Set(parseModelCatalog(result.stdout)), ok: true }
      : { providers: new Set<string>(), ok: false };
  // Only cache successful queries: a transient spawn failure (slow startup,
  // config read hiccup) must not poison the probe for the rest of the run.
  if (query.ok) MODEL_CATALOG_CACHE.set(key, query);
  return query;
}

export type ProviderProbe =
  | { kind: "available" }
  | { kind: "extension_only"; provider: string }
  | { kind: "unknown"; provider: string }
  | { kind: "indeterminate"; provider: string };

/**
 * Decide whether `provider` is usable by an isolated review child
 * (--no-extensions, issue #8). Missing from the isolated catalog but present
 * with host extensions loaded means the provider is registered by an
 * extension; the caller should surface a fix hint instead of a confusing
 * unknown-provider failure. A failed catalog query is `indeterminate`: the
 * caller must not block a possibly-valid provider on probe trouble.
 */
export function probeProviderAvailability(piBin: string, provider: string): ProviderProbe {
  const isolated = listProviders(piBin, true);
  if (!isolated.ok) return { kind: "indeterminate", provider };
  if (isolated.providers.has(provider)) return { kind: "available" };
  const withExtensions = listProviders(piBin, false);
  if (!withExtensions.ok) return { kind: "indeterminate", provider };
  if (withExtensions.providers.has(provider)) return { kind: "extension_only", provider };
  return { kind: "unknown", provider };
}

/** Human-readable fix hint for a provider that only exists via host extensions. */
export function extensionOnlyHintText(provider: string): string {
  return [
    `provider "${provider}" is registered by a Pi extension, but review children`,
    `run isolated with --no-extensions (issue #8).`,
    "",
    "Enable extension-registered providers persistently in the review config:",
    `    ~/.pi/pi-review/config.json  →  { "childExtensions": true }`,
    "(or override one run: PI_REVIEW_CHILD_EXTENSIONS=1 pi-review ...)",
  ].join("\n");
}

/** Human-readable message for a provider missing from the catalog entirely. */
export function unknownProviderHintText(provider: string): string {
  return [
    `provider "${provider}" was not found in the Pi model catalog (with or`,
    `without host extensions loaded). Check --provider / preset provider spelling.`,
  ].join("\n");
}

/**
 * When isolation is active and a provider is requested, block before spawning
 * the child if that provider only exists via host extensions (or is unknown),
 * and return a blocked review with an actionable hint. Returns undefined when
 * the review should proceed.
 */
export interface ProviderConfigBlock {
  structured: StructuredReviewResult;
  provider: string;
  extensionOnly: boolean;
}

export function configBlockForProvider(
  piBin: string,
  provider: string | undefined,
  model?: string,
): ProviderConfigBlock | undefined {
  const probeProvider = provider ?? (model ? splitModelProvider(model) : undefined);
  if (!probeProvider || childIsolationArgs().length === 0) return undefined;
  const probe = probeProviderAvailability(piBin, probeProvider);
  // available → proceed; indeterminate (catalog query failed) → proceed and
  // let the child surface its own accurate error rather than block on probe trouble.
  if (probe.kind === "available" || probe.kind === "indeterminate") return undefined;
  const extensionOnly = probe.kind === "extension_only";
  return {
    provider: probeProvider,
    extensionOnly,
    structured: {
      status: "blocked",
      verdict: "blocked",
      verdictSource: "config_error",
      parseError: extensionOnly ? extensionOnlyHintText(probeProvider) : unknownProviderHintText(probeProvider),
      findings: [],
      actionableCount: 0,
    },
  };
}

/** Isolate review children from host Pi extension side effects.
 *
 * Host extensions (usage HUDs, auto-reload bridges, etc.) may capture extension
 * ctx and touch it after session dispose/reload. That throws Pi's stale-context
 * error and can crash an otherwise successful reviewer child (issue #8).
 *
 * The effective value comes from the persistent review config
 * (childExtensions, ~/.pi/pi-review/config.json), overridden per process by
 * PI_REVIEW_CHILD_EXTENSIONS (1/true/keep enable, any other set value
 * disables). Bare CLI stays isolated (--no-extensions) until the config says
 * otherwise.
 */
export function childIsolationArgs(env: NodeJS.ProcessEnv = process.env, cfg?: PiReviewConfig): string[] {
  const decision = resolveChildExtensions(env, cfg ?? currentConfig(env).config);
  return decision.enabled ? [] : ["--no-extensions"];
}

/**
 * Build the catalog command args so the models command shows the same catalog
 * an actual review child would see: the effective isolation config applies
 * here too (F2: catalog and review must agree on extension-registered
 * providers).
 */
export function modelsArgs(args: string[], env: NodeJS.ProcessEnv = process.env, cfg?: PiReviewConfig): string[] {
  return ["--list-models", ...childIsolationArgs(env, cfg), ...args];
}

/** Prefer the larger of two captured stderr buffers; keep a readable stack tail. */
export const CHILD_STDERR_DIAGNOSTIC_LIMIT = 12_000;

export function formatChildRuntimeDetail(runtimeError: string, stderr: string, limit = CHILD_STDERR_DIAGNOSTIC_LIMIT): string {
  const tail = stderr.trim();
  if (!tail) return runtimeError;
  const clipped = tail.length > limit ? tail.slice(tail.length - limit) : tail;
  return `${runtimeError}\n--- child stderr ---\n${clipped}`;
}

/** Ensures the ASCII meta footer starts on its own line after streamed child stdout. */
export function metaLinePrefix(childStdout: string, streamMode: boolean): string {
  if (!streamMode || !childStdout) return "";
  return childStdout.endsWith("\n") ? "" : "\n";
}

/** True when the final text must be printed after exit instead of having streamed live.
 * With --mode json streaming, text deltas are forwarded live in streaming mode;
 * --progress-log no longer forces buffering (it only tees the event stream). */
export function progressLogBuffersOutput(streamMode: boolean, _hasProgressLog: boolean): boolean {
  return !streamMode;
}

export function childRuntimeError(child: Pick<ChildRunResult, "status" | "signal" | "error">): string | undefined {
  if (child.error) return child.error.message;
  if (child.signal) return `child pi terminated by signal ${child.signal}`;
  if ((child.status ?? 0) !== 0) return `child pi exited with status ${child.status}`;
  return undefined;
}

export function runModels(piBin: string, args: string[]): never {
  const result = spawnSync(piBin, modelsArgs(args), {
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

  const payload = normalizePayloadRefs(splitPayload(parsed.payload));
  const prompt = buildPrompt(parsed.mode, preset, payload, stdinText);
  // Always run the child in --mode json so token usage and semantic milestones
  // are available by default (no longer require --progress-log). The stream
  // emitter forwards readable text deltas to the terminal so the human still
  // sees the same live review prose.
  const args: string[] = ["-p", "--mode", "json"];
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

  // Isolate single-review children from host extension side effects (issue #8).
  args.push(...childIsolationArgs());

  // Block before spawning when the requested provider only exists via host
  // extensions (issue #8): the isolated child would otherwise die with a
  // confusing unknown-provider error. Surface an actionable hint so the host
  // agent knows to re-run with PI_REVIEW_CHILD_EXTENSIONS=1.
  const configBlock = configBlockForProvider(config.piBin, parsed.provider || preset.provider, parsed.model || preset.model);
  if (configBlock) {
    const hint = configBlock.structured.parseError ?? "";
    const meta: ReviewMeta = {
      metaVersion: REVIEW_META_VERSION,
      reviewMode: parsed.mode,
      ...configBlock.structured,
      durationMs: 0,
      model: parsed.model || preset.model || null,
      ...(parsed.thinking || preset.thinking ? { thinking: parsed.thinking || preset.thinking } : {}),
      ...(configBlock.extensionOnly
        ? { extensionHint: { provider: configBlock.provider, availableViaExtension: true } }
        : {}),
    };
    process.stdout.write(`${hint}\n\n`);
    process.stdout.write(`${formatReviewMetaAscii(meta)}\n`);
    const metaJsonDest = process.env.PI_REVIEW_META_STDOUT?.toLowerCase();
    const jsonLine = formatReviewMetaJsonLine(meta);
    if (metaJsonDest === "1" || metaJsonDest === "true" || metaJsonDest === "stdout") {
      process.stdout.write(jsonLine);
    } else {
      process.stderr.write(jsonLine);
    }
    return { meta, exitCode: reviewExitCode(meta.status) };
  }

  args.push(...(payload.attachableFileRefs ?? payload.fileRefs), prompt);

  let progressWriter: ProgressLogWriter | undefined;
  if (parsed.progressLog) {
    try {
      progressWriter = new ProgressLogWriter(parsed.progressLog, { raw: parsed.progressLogRaw });
    } catch (error) {
      fail(`failed to prepare --progress-log directory: ${(error as Error).message}`);
    }
  }

  const startedAt = Date.now();

  // In streaming mode the child always emits --mode json. A JsonEventStream
  // forwards readable text deltas to stdout and semantic milestones to stderr
  // while accumulating token usage; the same json lines also tee into the
  // progress-log file when --progress-log is set (slimmed unless --progress-log-raw).
  let streamParser: JsonEventStream | undefined;
  let streamUsage: TokenUsage | undefined;
  const stdoutSink = parsed.stream
    ? new Writable({
        write(chunk, _enc, cb) {
          const text = String(chunk);
          if (progressWriter) progressWriter.write(text);
          if (!streamParser) {
            streamParser = new JsonEventStream({
              onText: (c) => process.stdout.write(c),
              onMilestone: (line) => process.stderr.write(line),
            });
          }
          streamParser.feed(text);
          cb();
        },
      })
    : undefined;

  const spawnOpts = {
    cwd: process.cwd(),
    env: childEnv(config.piBin),
    ...(stdoutSink ? { stdoutSink } : {}),
  };
  const child = parsed.stream
    ? await spawnStreamingChild(config.piBin, args, spawnOpts)
    : spawnBufferedChild(config.piBin, args, spawnOpts);
  const durationMs = Date.now() - startedAt;

  if (streamParser) {
    streamParser.flush();
    streamUsage = streamParser.usage().usage;
  }
  if (stdoutSink) {
    // ensure newline separation after streamed text before the ASCII footer
    if (child.stdout && !child.stdout.endsWith("\n")) process.stdout.write("\n");
  }
  if (progressWriter) {
    const progressLogError = await progressWriter.end();
    if (progressLogError) {
      process.stderr.write(`pi-review: warning: --progress-log write failed: ${progressLogError.message}\n`);
    }
  }

  let stdout = child.stdout || "";
  const stderr = child.stderr || "";
  let extractedError: string | undefined;
  let extractedFatal = false;
  let extractedUsage: TokenUsage | undefined;
  // stderr is always captured on the child result; streaming mode may already
  // have forwarded milestones, but crash stacks still land here for diagnostics.
  if (parsed.stream) {
    // Text was already forwarded live by the stream parser; derive final text
    // and usage from the captured json stream.
    extractedUsage = streamUsage ?? extractUsage(stdout).usage;
    const extracted = extractFinalText(stdout);
    stdout = extracted.text;
    extractedError = extracted.error;
    extractedFatal = Boolean(extracted.fatal);
  } else {
    // Buffered mode: parse the captured json stream for text + usage.
    extractedUsage = extractUsage(stdout).usage;
    const extracted = extractFinalText(stdout);
    stdout = extracted.text;
    extractedError = extracted.error;
    extractedFatal = Boolean(extracted.fatal);
  }

  // Streaming mode already forwarded text deltas live via the stream parser,
  // so we never reprint. Buffered mode prints the extracted final text once.
  if (!parsed.stream && stdout) {
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
      parseError: formatChildRuntimeDetail(runtimeError, stderr),
    };
  } else if (extractedFatal) {
    verdictInfo = {
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: formatChildRuntimeDetail(extractedError || "child reported a fatal error", stderr),
    };
  } else if (extractedError) {
    verdictInfo = {
      ...verdictInfo,
      parseError: [verdictInfo.parseError, extractedError].filter(Boolean).join("; "),
    };
  }

  const structuredResult = parseReviewResult(stdout, verdictInfo);
  const thinking = parsed.thinking || preset.thinking;
  const meta: ReviewMeta = {
    metaVersion: REVIEW_META_VERSION,
    reviewMode: parsed.mode,
    ...structuredResult,
    durationMs,
    model: parsed.model || preset.model || null,
    ...(thinking ? { thinking } : {}),
    ...(extractedUsage ? { usage: extractedUsage } : {}),
    sessionHandle: sessionHandle || undefined,
  };

  // In streaming mode text was forwarded live; the ASCII footer starts on its
  // own line. In buffered mode the final text was just printed above.
  const metaPrefix = metaLinePrefix(stdout, !parsed.stream);
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
