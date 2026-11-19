// Panel review orchestration: run N independent reviewer child sessions with
// bounded concurrency, aggregate their structured findings into one panel
// result, and emit a single aggregate footer + metadata record. Reviewers and
// the consensus adjudicator remain review-only (no write tools, --no-session).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { PANEL_READ_ONLY_TOOLS, REVIEW_META_VERSION } from "./types.js";
import type {
  ExtensionHint,
  ParsedArgs,
  PanelReviewMeta,
  ReviewerSubmission,
  StructuredReviewResult,
  VerdictInfo,
} from "./types.js";
export { PANEL_READ_ONLY_TOOLS } from "./types.js";
import { spawnStreamingChild } from "./child-process.js";
import { childEnv, childIsolationArgs, childRuntimeError, configBlockForProvider, formatChildRuntimeDetail, readReviewStdin, assertRulesExtension, rulesExtensionArgs } from "./review.js";
import { loadPanelPresets, loadPresets, loadSystemPrompt } from "./presets.js";
import { splitPayload, normalizePayloadRefs, buildReviewerPrompt, buildAdjudicatorPrompt } from "./prompt.js";
import { parseVerdict } from "./verdict.js";
import { parseReviewResult, reviewExitCode } from "./review-result.js";
import { extractFinalText, JsonEventStream } from "./json-events.js";
import { ProgressLogWriter } from "./progress-log.js";
import type { TokenUsage } from "./types.js";
import { fail, expandMaybeHome } from "./utils.js";
import { resolveConfig, type Config } from "./config.js";
import { parseReviewerModelOverrides, resolvePanelConfig, resolveReusedPanelConfig, resolveReviewerModelThinking, type ResolvedPanelConfig } from "./panel-config.js";
import { aggregatePanel, isContributingSubmission, resolvePanelEffectiveModel } from "./panel-aggregate.js";
import { createPanelRunStore, loadPanelArtifact, PANEL_ARTIFACT_SCHEMA_VERSION, type LoadedPanelArtifact } from "./panel-artifacts.js";
import { sumPanelUsage } from "./panel-usage.js";
import { SemanticMatcher, type AdjudicationCandidate, type SemanticAdjudicator } from "./matcher.js";
import { createJevAdjudicator, hasJevApiKey, resolveJev, resolveJevConnection, withAdjudicationFallback, withUncertaintyEscalation } from "./jev.js";
import { currentConfig } from "./pi-config.js";
import { formatPanelMetaAscii, formatPanelFindingsMarkdown, formatReviewMetaJsonLine } from "./meta-footer.js";
import { createReviewEventEmitter, redactReviewEventPayload, redactReviewMetaPayload, type ReviewEvent, type ReviewEventListener } from "./review-events.js";
import { createPaneEventSink, launchPanelUi } from "./panel-ui.js";
import { payloadTargets, verificationForReview, withVerificationSection } from "./verify.js";

/** Emit the aggregate panel footer (ASCII + JSON) like a single review. */
export function emitPanelFooter(meta: PanelReviewMeta): void {
  // Issue #2 Decision 39: confirmed findings are the primary Findings section;
  // advisories are clearly separated and labelled non-blocking.
  const body = formatPanelFindingsMarkdown(meta);
  if (body) process.stdout.write(`${body}\n\n`);
  process.stdout.write(`${formatPanelMetaAscii(meta)}\n`);
  const metaJsonDest = process.env.PI_REVIEW_META_STDOUT?.toLowerCase();
  const jsonLine = formatReviewMetaJsonLine(meta);
  if (metaJsonDest === "1" || metaJsonDest === "true" || metaJsonDest === "stdout") {
    process.stdout.write(jsonLine);
  } else {
    process.stderr.write(jsonLine);
  }
}

function reviewerProgressLog(baseProgressLog: string | undefined, reviewerId: string): string | undefined {
  if (!baseProgressLog) return undefined;
  const base = baseProgressLog.replace(/\.jsonl$/i, "");
  return `${base}.r${reviewerId}.jsonl`;
}

/** The hard panel boundary. Shell access gets a separate verified profile in a future change. */
const PANEL_READ_ONLY_TOOL_SET = new Set<string>(PANEL_READ_ONLY_TOOLS);

/** Resolve reviewer tools through the hard allowlist; rejected requests cannot silently widen access. */
export function resolvePanelReviewerTools(tools: string | string[] | undefined): string {
  const requested = (Array.isArray(tools) ? tools : tools?.split(",") ?? PANEL_READ_ONLY_TOOLS)
    .map((tool) => tool.trim())
    .filter(Boolean);
  const disallowed = requested.filter((tool) => !PANEL_READ_ONLY_TOOL_SET.has(tool));
  if (disallowed.length > 0) {
    throw new Error(`panel reviewers only allow ${PANEL_READ_ONLY_TOOLS.join(",")}; rejected: ${disallowed.join(",")}`);
  }
  return [...new Set(requested.length > 0 ? requested : PANEL_READ_ONLY_TOOLS)].join(",");
}

/** Build argv for one isolated reviewer child. Exported for issue #8 isolation tests. */
export function buildReviewerArgs(
  config: Config,
  parsed: ParsedArgs,
  preset: { tools?: string[] | string; thinking?: string; provider?: string; model?: string; skillPaths?: string[] },
  prompt: string,
  fileRefs: string[],
  reviewer: { provider?: string; model?: string; thinking?: string },
  progressLog: string | undefined,
  systemPrompt: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = ["-p", "--mode", "json"];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  const provider = reviewer.provider || parsed.provider || preset.provider;
  const { model, thinking } = resolveReviewerModelThinking(reviewer, {
    model: parsed.model || preset.model,
    thinking: parsed.thinking || preset.thinking,
  });
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  args.push("--tools", resolvePanelReviewerTools(parsed.tools || preset.tools));

  const presetSkills = Array.isArray(preset.skillPaths) ? preset.skillPaths : [];
  for (const skill of [...presetSkills, ...parsed.skills]) {
    args.push("--skill", expandMaybeHome(skill)!);
  }

  // Host extensions can crash the child via stale extension ctx after dispose
  // (issue #8). Keep reviewers isolated unless the operator opts out. Our own
  // rules loader is an explicit --extension, which --no-extensions still allows.
  assertRulesExtension(env, parsed.noRules);
  args.push(...childIsolationArgs(env));
  args.push(...rulesExtensionArgs(env, parsed.noRules));
  args.push("--no-session");
  args.push(...fileRefs, prompt);
  return args;
}

interface ReviewerRunInput {
  config: Config;
  parsed: ParsedArgs;
  preset: { tools?: string[] | string; thinking?: string; provider?: string; model?: string; skillPaths?: string[] };
  prompt: string;
  fileRefs: string[];
  reviewer: { id: string; role: string; provider?: string; model?: string; thinking?: string };
  progressLog: string | undefined;
  systemPrompt: string;
  signal?: AbortSignal;
  emit?: ReturnType<typeof createReviewEventEmitter>;
  quietProgress?: boolean;
}

async function runReviewerChild(input: ReviewerRunInput): Promise<ReviewerSubmission> {
  const { config, parsed, preset, prompt, fileRefs, reviewer, progressLog, systemPrompt, signal, emit, quietProgress } = input;
  const args = buildReviewerArgs(config, parsed, preset, prompt, fileRefs, reviewer, progressLog, systemPrompt);

  // Block this reviewer before spawning when its provider only exists via host
  // extensions (issue #8): the isolated child would otherwise fail with a
  // confusing unknown-provider error. The hint tells the host agent to re-run
  // with PI_REVIEW_CHILD_EXTENSIONS=1.
  const effectiveReviewerModel = resolveReviewerModelThinking(reviewer, {
    model: parsed.model || preset.model,
    thinking: parsed.thinking || preset.thinking,
  });
  const configBlock = configBlockForProvider(
    config.piBin,
    reviewer.provider || parsed.provider || preset.provider,
    effectiveReviewerModel.model,
  );
  if (configBlock) {
    return {
      reviewerId: reviewer.id,
      role: reviewer.role,
      model: effectiveReviewerModel.model ?? null,
      durationMs: 0,
      result: configBlock.structured,
      ...(configBlock.extensionOnly
        ? { extensionHint: { provider: configBlock.provider, availableViaExtension: true } }
        : {}),
    };
  }

  let progressWriter: ProgressLogWriter | undefined;
  if (progressLog) {
    try {
      progressWriter = new ProgressLogWriter(progressLog, { raw: parsed.progressLogRaw });
    } catch (error) {
      // The progress log is an observability convenience; never kill a
      // reviewer run because its directory cannot be created.
      if (!quietProgress) {
        process.stderr.write(`  [${reviewer.id}] pi-review: warning: --progress-log unavailable: ${(error as Error).message}\n`);
      }
    }
  }

  // Reviewers always run in --mode json. A JsonEventStream accumulates token
  // usage and emits reviewer-prefixed milestones to stderr; reviewer prose is
  // NOT forwarded to stdout so concurrent reviewers never interleave (issue #2
  // progress isolation). The json lines tee into the progress-log file
  // (slimmed unless --progress-log-raw).
  const streamParser = new JsonEventStream({
    onText: () => { /* reviewer prose is captured, not displayed */ },
    onMilestone: (line) => { if (!quietProgress) process.stderr.write(`  [${reviewer.id}] ${line}`); },
    onActivity: (event) => {
      if (!emit) return;
      switch (event.type) {
        case "turn.started":
          emit("reviewer.turn.started", { reviewerId: reviewer.id, turn: event.turn });
          break;
        case "tool.started":
          emit("reviewer.tool.started", { reviewerId: reviewer.id, tool: event.tool, ...(event.summary ? { summary: event.summary } : {}) });
          break;
        case "tool.finished":
          emit("reviewer.tool.finished", { reviewerId: reviewer.id, tool: event.tool, ...(event.summary ? { summary: event.summary } : {}) });
          break;
        case "text.delta":
          emit("reviewer.text.delta", { reviewerId: reviewer.id, text: event.text });
          break;
        case "usage":
          emit("reviewer.usage", { reviewerId: reviewer.id, usage: event.usage, ...(event.responseModel ? { responseModel: event.responseModel } : {}) });
          break;
      }
    },
  });
  const stdoutSink = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      if (progressWriter) progressWriter.write(text);
      streamParser.feed(text);
      cb();
    },
  });

  const stderrChunks: string[] = [];
  const stderrSink = new Writable({ write(chunk, _enc, cb) { stderrChunks.push(String(chunk)); cb(); } });

  const child = await spawnStreamingChild(config.piBin, args, {
    cwd: process.cwd(),
    env: childEnv(config.piBin),
    stdoutSink,
    stderrSink,
    signal,
    processGroup: true,
  });
  streamParser.flush();
  if (progressWriter) {
    const progressLogError = await progressWriter.end();
    if (progressLogError && !quietProgress) {
      process.stderr.write(`  [${reviewer.id}] pi-review: warning: --progress-log write failed: ${progressLogError.message}\n`);
    }
  }

  let stdout = child.stdout || "";
  const runtimeError = childRuntimeError(child);
  // Prefer the spawn helper's own capture, then the sink buffer. Keep enough of
  // the tail for full Node uncaught stacks (issue #8 diagnostics).
  const reviewerStderr = child.stderr || stderrChunks.join("");

  let extractedError: string | undefined;
  let extractedFatal = false;
  const { usage: reviewerUsage, responseModel } = streamParser.usage();
  {
    const extracted = extractFinalText(stdout);
    stdout = extracted.text;
    extractedError = extracted.error;
    extractedFatal = Boolean(extracted.fatal);
  }

  let verdictInfo: VerdictInfo = parseVerdict(stdout);

  if (runtimeError) {
    verdictInfo = {
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: formatChildRuntimeDetail(runtimeError, reviewerStderr),
    };
  } else if (extractedFatal) {
    verdictInfo = {
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: formatChildRuntimeDetail(extractedError || "child reported a fatal error", reviewerStderr),
    };
  } else if (extractedError) {
    verdictInfo = { ...verdictInfo, parseError: [verdictInfo.parseError, extractedError].filter(Boolean).join("; ") };
  }

  const structured: StructuredReviewResult = parseReviewResult(stdout, verdictInfo);
  const { model, thinking } = resolveReviewerModelThinking(reviewer, {
    model: parsed.model || preset.model,
    thinking: parsed.thinking || preset.thinking,
  });

  return {
    reviewerId: reviewer.id,
    role: reviewer.role,
    model: model ?? null,
    ...(thinking ? { thinking } : {}),
    ...(reviewerUsage ? { usage: reviewerUsage } : {}),
    ...(responseModel ? { responseModel } : {}),
    durationMs: 0, // set by caller wrapper
    result: structured,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Adjudicator argv (consensus clustering only): no rules extension, isolated
 * from host extensions, no session, no tools. Pure so tests never spawn pi.
 */
export function adjudicatorArgs(
  consensusModel: string | undefined,
  adjudicatorSystemPrompt: string,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [
    "-p",
    ...childIsolationArgs(env),
    "--no-session",
    "--no-tools",
    "--append-system-prompt",
    adjudicatorSystemPrompt,
  ];
  if (consensusModel) args.push("--model", consensusModel);
  args.push(prompt);
  return args;
}

/** Real semantic adjudicator: spawns a review-only Pi session with the consensus model. */
function createAdjudicator(
  config: Config,
  consensusModel: string | undefined,
  signal?: AbortSignal,
): SemanticAdjudicator {
  // Dedicated JSON-only system prompt. The adjudicator must NOT inherit the
  // review Markdown output contract (system-prompt.md), which would conflict
  // with the strict JSON clustering response and break parsing.
  const adjudicatorSystemPrompt = [
    "You are the consensus adjudicator for a panel code review.",
    "Your only output is one JSON object matching the requested clustering schema.",
    "Do not output Markdown, prose, or any other format. Do not review code quality.",
    "You may not invent findings, drop findings, or act as a reviewer.",
  ].join("\n");
  return {
    async adjudicate(request) {
      if (signal?.aborted) throw new Error("panel review cancelled before adjudication");
      const prompt = buildAdjudicatorPrompt(
        request.candidates as AdjudicationCandidate[],
        request.previousErrors,
        request.priorAttempts,
      );
      // The adjudicator is aggregation-only: it must not inspect the repository
      // as an additional reviewer and has no write capability. Disable all tools
      // and run with no session — it returns JSON purely from the structured
      // findings embedded in the prompt. Also isolate from host extensions
      // (issue #8) so a usage HUD / reload bridge cannot crash adjudication.
      // It never loads the rules extension (`rules-extension` absent from argv).
      const args = adjudicatorArgs(consensusModel, adjudicatorSystemPrompt, prompt);

      const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      const child = await spawnStreamingChild(config.piBin, args, {
        cwd: process.cwd(),
        env: childEnv(config.piBin),
        stdoutSink: sink,
        stderrSink: sink,
        signal,
        processGroup: true,
      });
      const runtimeError = childRuntimeError(child);
      if (runtimeError) {
        throw new Error(runtimeError);
      }
      const stdout = (child.stdout || "").trim();
      const jsonStart = stdout.indexOf("{");
      const jsonEnd = stdout.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        return { merges: [], errors: ["adjudicator returned no parseable JSON object"] };
      }
      try {
        const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
        if (!parsed || !Array.isArray(parsed.merges)) {
          return { merges: [], errors: ["adjudicator response missing a merges array"] };
        }
        return {
          merges: parsed.merges,
          ...(Array.isArray(parsed.errors) ? { errors: parsed.errors.map(String) } : {}),
        };
      } catch (error) {
        return { merges: [], errors: [`failed to parse adjudicator response: ${(error as Error).message}`] };
      }
    },
  };
}

/** Resolve the panel config or fail with a usage error. */
function resolvePanel(
  parsed: ParsedArgs,
  config: Config,
  artifact?: LoadedPanelArtifact,
): ResolvedPanelConfig {
  const panelPresets = loadPanelPresets(config.panelPresetsFile);
  try {
    if (artifact) {
      return resolveReusedPanelConfig(parsed, artifact, panelPresets);
    }
    return resolvePanelConfig(parsed, panelPresets);
  } catch (error) {
    if (error instanceof Error) fail(error.message);
    throw error;
  }
}

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export interface PanelRunOptions {
  onEvent?: ReviewEventListener;
  signal?: AbortSignal;
  emitFooter?: boolean;
}

function cancelledSubmission(
  reviewer: { id: string; role: string; provider?: string; model?: string; thinking?: string },
  message: string,
  durationMs = 0,
  usage?: TokenUsage,
  startedAt?: number,
  completedAt?: number,
): ReviewerSubmission {
  return {
    reviewerId: reviewer.id,
    role: reviewer.role,
    model: reviewer.model ?? null,
    ...(reviewer.thinking ? { thinking: reviewer.thinking } : {}),
    ...(usage ? { usage } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    durationMs,
    result: { status: "blocked", verdict: "blocked", verdictSource: "runtime_error", parseError: message, findings: [], actionableCount: 0 },
  };
}

/** Keep finished reviewer results on abort; only rewrite interrupted/runtime-cancelled work. */
export function shouldPreserveSubmissionOnAbort(submission: ReviewerSubmission): boolean {
  return submission.result.verdictSource !== "runtime_error";
}

/**
 * Collect every extension-only provider hint from reviewer submissions,
 * deduplicated by provider (first occurrence wins). Returns undefined when no
 * reviewer was blocked on an extension provider.
 */
export function collectPanelExtensionHints(submissions: ReviewerSubmission[]): ExtensionHint[] | undefined {
  const seen = new Set<string>();
  const hints: ExtensionHint[] = [];
  for (const submission of submissions) {
    const hint = submission.extensionHint;
    if (!hint || seen.has(hint.provider)) continue;
    seen.add(hint.provider);
    hints.push(hint);
  }
  return hints.length > 0 ? hints : undefined;
}

/** Run one complete panel evaluation and return the aggregate result (no exit). */
export async function runPanelReviewOnce(
  parsed: ParsedArgs,
  stdinText?: string,
  options: PanelRunOptions = {},
): Promise<{ meta: PanelReviewMeta; exitCode: number }> {
  const config = resolveConfig();

  let artifact: LoadedPanelArtifact | undefined;
  if (parsed.reuseReviewers) {
    try {
      artifact = loadPanelArtifact(parsed.reuseReviewers);
    } catch (error) {
      fail((error as Error).message);
    }
  }

  const resolved = resolvePanel(parsed, config, artifact);
  const effectiveMode = parsed.modeExplicit
    ? parsed.mode
    : (artifact?.manifest.mode || parsed.mode);
  const presets = loadPresets(config.presetsFile);
  const preset = presets[effectiveMode];

  const knownReviewerIds = new Set(resolved.reviewers.map((r) => r.id));
  let rerunIds: Set<string>;
  if (!artifact) {
    rerunIds = new Set(knownReviewerIds);
  } else if (parsed.command === "panel-reaggregate" || (!parsed.onlyReviewers && !parsed.rerunFailed)) {
    rerunIds = new Set();
  } else if (parsed.onlyReviewers) {
    const unknown = parsed.onlyReviewers.filter((id) => !knownReviewerIds.has(id));
    if (unknown.length > 0) {
      fail(
        `--only-reviewers unknown reviewer id(s): ${unknown.join(", ")}. Available: ${[...knownReviewerIds].join(", ")}`,
      );
    }
    rerunIds = new Set(parsed.onlyReviewers);
  } else {
    rerunIds = new Set(
      resolved.reviewers
        .filter((r) => {
          const prev = artifact!.submissionsById.get(r.id);
          return !prev || !isContributingSubmission(prev);
        })
        .map((r) => r.id),
    );
  }

  if (artifact) {
    if (parsed.runDir) {
      const targetRunDir = canonicalPath(expandMaybeHome(parsed.runDir.trim())!);
      const sourceCanonical = canonicalPath(artifact.sourcePath);
      const targetMetaPath = canonicalPath(path.join(targetRunDir, "meta.json"));
      if (targetRunDir === sourceCanonical || targetMetaPath === sourceCanonical) {
        fail(
          "--run-dir cannot overwrite the --reuse-reviewers source artifact; choose a different output directory",
        );
      }
    }
    if (parsed.reviewerModels?.length) {
      const overrideIds = [...parseReviewerModelOverrides(parsed.reviewerModels).keys()];
      const nonRerunOverrides = overrideIds.filter((id) => !rerunIds.has(id));
      if (nonRerunOverrides.length > 0) {
        fail(
          `--reviewer-model specified for reused reviewer(s) not being rerun: ${nonRerunOverrides.join(", ")}. Include them in --only-reviewers (or --rerun-failed) to rerun with a new model.`,
        );
      }
    }
    const corruptReused = resolved.reviewers
      .filter((r) => !rerunIds.has(r.id) && artifact!.corruptReviewers?.has(r.id))
      .map((r) => `${r.id} (${artifact!.corruptReviewers!.get(r.id)})`);
    if (corruptReused.length > 0) {
      fail(
        `artifact ${artifact.sourcePath} has corrupted reviewer submission(s): ${corruptReused.join("; ")}. Pass --only-reviewers or --rerun-failed to rerun them.`,
      );
    }
    const missingReused = resolved.reviewers
      .filter((r) => !rerunIds.has(r.id) && !artifact!.submissionsById.has(r.id))
      .map((r) => r.id);
    if (missingReused.length > 0) {
      fail(
        `artifact ${artifact.sourcePath} is missing reviewer submission(s) for: ${missingReused.join(", ")}. Pass --only-reviewers or --rerun-failed to run them.`,
      );
    }
  }

  if (rerunIds.size > 0) {
    if (!preset) {
      fail(`unknown review mode: ${effectiveMode}\nAvailable modes: ${Object.keys(presets).join(", ")}`);
    }
    // Validate tool capability before lifecycle emission so a malformed preset
    // cannot leave events-jsonl consumers with a partial stream.
    try {
      resolvePanelReviewerTools(parsed.tools || preset.tools);
    } catch (error) {
      if (error instanceof Error) fail(error.message);
      throw error;
    }
  }
  const effectivePreset = preset ?? { description: effectiveMode };

  const resolvedStdin =
    stdinText !== undefined
      ? stdinText
      : rerunIds.size > 0
        ? readReviewStdin()
        : "";

  const effectivePayloadArgs =
    parsed.payload.length > 0
      ? parsed.payload
      : (artifact?.manifest.payload ??
         (artifact?.manifest.target ? [artifact.manifest.target] : []));

  if (
    artifact?.sourceKind === "meta-file" &&
    rerunIds.size > 0 &&
    effectivePayloadArgs.length === 0 &&
    !resolvedStdin.trim()
  ) {
    fail(
      `rerunning reviewer(s) from standalone meta file ${artifact.sourcePath} requires an explicit review target (pass -- <@files|text...> or pipe stdin, or pass a panel run directory)`,
    );
  }

  const effectiveSharedModel =
    parsed.command === "panel-reaggregate"
      ? artifact?.manifest.sharedModel
      : (parsed.model ?? artifact?.manifest.sharedModel);
  const effectiveSharedProvider = parsed.provider ?? artifact?.manifest.sharedProvider;
  const effectiveSharedThinking = parsed.thinking ?? artifact?.manifest.sharedThinking;
  const effectiveConsensusModel =
    parsed.consensusModel ??
    (parsed.command === "panel-reaggregate" ? parsed.model : undefined) ??
    resolved.consensusModel;

  const payload = normalizePayloadRefs(splitPayload(effectivePayloadArgs));
  // Anchor base: with exactly one directory target, resolve relative finding
  // paths against it so `calc.ts` and `/abs/target/calc.ts` corroborate.
  const matcherBaseDir =
    payload.pathTargets && payload.pathTargets.length === 1
      ? path.resolve(payload.pathTargets[0]!)
      : artifact?.manifest.matcherBaseDir;

  const runId = randomUUID();
  const emit = createReviewEventEmitter(runId, (event) => {
    if (parsed.outputFormat === "events-jsonl") process.stdout.write(`${JSON.stringify(event)}\n`);
    options.onEvent?.(event);
  });
  const targetText =
    effectivePayloadArgs.length > 0 ? effectivePayloadArgs.join(" ") : (artifact?.manifest.target ?? "");
  const reviewerIdentities = resolved.reviewers.map((reviewer) => {
    if (!rerunIds.has(reviewer.id) && artifact) {
      const reusedSub = artifact.submissionsById.get(reviewer.id);
      return {
        reviewerId: reviewer.id,
        role: reviewer.role,
        model: reusedSub?.model ?? reusedSub?.responseModel ?? null,
        ...(reusedSub?.thinking ? { thinking: reusedSub.thinking } : {}),
      };
    }
    const { model, thinking } = resolveReviewerModelThinking(reviewer, {
      model: effectiveSharedModel || effectivePreset.model,
      thinking: effectiveSharedThinking || effectivePreset.thinking,
    });
    return {
      reviewerId: reviewer.id,
      role: reviewer.role,
      model: model ?? null,
      ...(thinking ? { thinking } : {}),
    };
  });

  let store: ReturnType<typeof createPanelRunStore>;
  try {
    store = createPanelRunStore({
      runId,
      runDir: parsed.runDir,
      onWarning: (message) => {
        if (parsed.outputFormat !== "events-jsonl") {
          process.stderr.write(`pi-review: warning: ${message}\n`);
        }
      },
    });
  } catch (error) {
    fail((error as Error).message);
  }
  store?.writeManifest({
    schemaVersion: PANEL_ARTIFACT_SCHEMA_VERSION,
    runId,
    createdAt: new Date().toISOString(),
    mode: effectiveMode,
    ...(resolved.presetName ? { panelPreset: resolved.presetName } : {}),
    reviewers: resolved.reviewers,
    consensusPolicy: resolved.consensus,
    ...(resolved.minAgree !== undefined ? { minAgree: resolved.minAgree } : {}),
    ...(effectiveConsensusModel ? { consensusModel: effectiveConsensusModel } : {}),
    consensusRetries: resolved.consensusRetries,
    ...(effectiveSharedModel ? { sharedModel: effectiveSharedModel } : {}),
    ...(effectiveSharedProvider ? { sharedProvider: effectiveSharedProvider } : {}),
    ...(effectiveSharedThinking ? { sharedThinking: effectiveSharedThinking } : {}),
    ...(matcherBaseDir ? { matcherBaseDir } : {}),
    ...(targetText ? { target: targetText } : {}),
    ...(effectivePayloadArgs.length > 0 ? { payload: effectivePayloadArgs } : {}),
    ...(artifact ? { reusedFrom: artifact.sourcePath } : {}),
    ...(artifact ? { rerunReviewerIds: [...rerunIds] } : {}),
  });

  emit("panel.started", {
    target: targetText,
    mode: effectiveMode,
    ...(resolved.presetName ? { panelPreset: resolved.presetName } : {}),
    reviewers: reviewerIdentities,
  });
  for (const reviewer of resolved.reviewers) emit("reviewer.queued", { reviewerId: reviewer.id });

  // Opt-in verification: one shared run before any reviewer starts, never per
  // reviewer. Its own durationMs lives in meta.verification, outside the review timer.
  const verification =
    rerunIds.size > 0
      ? await verificationForReview(parsed, parsed.outputFormat === "events-jsonl", payloadTargets(payload))
      : undefined;

  const startedAt = Date.now();
  const submissionsById = new Map<string, ReviewerSubmission>();

  for (const reviewer of resolved.reviewers) {
    if (rerunIds.has(reviewer.id)) continue;
    const reused: ReviewerSubmission = {
      ...artifact!.submissionsById.get(reviewer.id)!,
      reused: true,
    };
    submissionsById.set(reviewer.id, reused);
    store?.writeReviewer(reused);
    if (parsed.outputFormat !== "events-jsonl") {
      process.stderr.write(`  [${reviewer.id}] reused from ${artifact!.sourcePath}\n`);
    }
    if (reused.result.verdictSource === "runtime_error") {
      if (reused.usage) {
        emit("reviewer.usage", {
          reviewerId: reviewer.id,
          usage: reused.usage,
          ...(reused.responseModel ? { responseModel: reused.responseModel } : {}),
        });
      }
      emit("reviewer.failed", {
        reviewerId: reviewer.id,
        message: reused.result.parseError ?? "reviewer failed",
      });
    } else {
      emit("reviewer.completed", { reviewerId: reviewer.id, submission: reused });
    }
  }

  const reviewersToRun = resolved.reviewers.filter((reviewer) => rerunIds.has(reviewer.id));
  if (reviewersToRun.length > 0) {
    const systemPrompt = loadSystemPrompt(config.systemPromptFile);
    const reviewerParsed: ParsedArgs = {
      ...parsed,
      ...(effectiveSharedModel !== undefined ? { model: effectiveSharedModel } : {}),
      ...(effectiveSharedProvider !== undefined ? { provider: effectiveSharedProvider } : {}),
      ...(effectiveSharedThinking !== undefined ? { thinking: effectiveSharedThinking } : {}),
    };
    const ran = await mapWithConcurrency(
      reviewersToRun,
      resolved.concurrency,
      async (reviewer) => {
        if (options.signal?.aborted) {
          const message = "panel review cancelled";
          const now = Date.now();
          emit("reviewer.cancelled", { reviewerId: reviewer.id, message });
          const cancelled = cancelledSubmission(reviewer, message, 0, undefined, now, now);
          store?.writeReviewer(cancelled);
          return cancelled;
        }
        const reviewerStart = Date.now();
        emit("reviewer.started", { reviewerId: reviewer.id });
        const prompt = withVerificationSection(
          buildReviewerPrompt(effectiveMode, effectivePreset, payload, resolvedStdin, reviewer),
          verification,
        );
        const progressLog = reviewerProgressLog(parsed.progressLog, reviewer.id);
        const submission = await runReviewerChild({
          config,
          parsed: reviewerParsed,
          preset: effectivePreset,
          prompt,
          fileRefs: payload.attachableFileRefs ?? payload.fileRefs,
          reviewer,
          progressLog,
          systemPrompt,
          signal: options.signal,
          emit,
          quietProgress: parsed.outputFormat === "events-jsonl",
        });
        const reviewerEnd = Date.now();
        const completed: ReviewerSubmission = {
          ...submission,
          startedAt: reviewerStart,
          completedAt: reviewerEnd,
          durationMs: Math.max(0, reviewerEnd - reviewerStart),
        };
        let finalSubmission = completed;
        if (options.signal?.aborted) {
          if (shouldPreserveSubmissionOnAbort(completed)) {
            emit("reviewer.completed", { reviewerId: reviewer.id, submission: completed });
          } else {
            emit("reviewer.cancelled", { reviewerId: reviewer.id, message: "panel review cancelled" });
            finalSubmission = cancelledSubmission(
              reviewer,
              "panel review cancelled",
              completed.durationMs,
              completed.usage,
              reviewerStart,
              reviewerEnd,
            );
          }
        } else if (completed.result.verdictSource === "runtime_error") {
          emit("reviewer.failed", { reviewerId: reviewer.id, message: completed.result.parseError ?? "reviewer failed" });
        } else {
          emit("reviewer.completed", { reviewerId: reviewer.id, submission: completed });
        }
        store?.writeReviewer(finalSubmission);
        return finalSubmission;
      },
    );
    for (const sub of ran) {
      submissionsById.set(sub.reviewerId, sub);
    }
  }

  const submissions = resolved.reviewers.map((r) => submissionsById.get(r.id)!);

  // Semantic adjudication is on by default (issue #2 Decision 27): when
  // ambiguous same-path candidates exist, a constrained adjudicator clusters
  // them. Exact matches never invoke the adjudicator, so this stays cheap
  // when there is nothing ambiguous.
  //
  // Engine selection: an explicit --consensus-model keeps the review-only Pi
  // adjudicator (the operator asked for an LLM). Otherwise the Jev
  // enhancement (enabled by config/key presence) turns adjudication into one
  // typed System One call; any Jev failure degrades to the Pi adjudicator.
  const adjudicatorModel =
    effectiveConsensusModel ?? effectiveSharedModel ?? effectivePreset.model ?? undefined;
  emit("aggregation.started", {});
  const piAdjudicator = createAdjudicator(config, adjudicatorModel, options.signal);
  const jevDecision = resolveJev(process.env, currentConfig(process.env).config);
  const explicitCliAdjudicatorModel =
    parsed.consensusModel !== undefined ||
    (parsed.command === "panel-reaggregate" && parsed.model !== undefined);
  const jevEnvOverride =
    jevDecision.source === "env" && jevDecision.enabled && !explicitCliAdjudicatorModel;
  const jevRequested =
    jevEnvOverride || (jevDecision.enabled && effectiveConsensusModel === undefined);
  const jevConnection = jevRequested ? resolveJevConnection(process.env) : undefined;
  let adjudicator: SemanticAdjudicator = piAdjudicator;
  let jevWrapper: ReturnType<typeof withAdjudicationFallback> | undefined;
  let adjudicationFallbackNote: string | undefined;
  if (jevRequested) {
    if (jevConnection) {
      // Cascade: Jev answers every pair in one typed call; only the borderline
      // band (0.3-0.7) is re-judged by the Pi adjudicator in a single extra
      // call. Clear cases never pay for an LLM; uncertain ones get a second
      // opinion (guards the transitive-merge chaining failure from review C9).
      const cascaded = withUncertaintyEscalation(
        createJevAdjudicator(jevConnection, { signal: options.signal }),
        piAdjudicator,
        (message) => {
          adjudicationFallbackNote = adjudicationFallbackNote ? `${adjudicationFallbackNote}; ${message}` : message;
        },
        { maxRetries: resolved.consensusRetries, signal: options.signal },
      );
      jevWrapper = withAdjudicationFallback(
        cascaded,
        piAdjudicator,
        (message) => {
          adjudicationFallbackNote = adjudicationFallbackNote ? `${adjudicationFallbackNote}; ${message}` : message;
          if (parsed.outputFormat !== "events-jsonl") process.stderr.write(`pi-review: warning: ${message}\n`);
        },
        options.signal,
      );
      adjudicator = jevWrapper.adjudicator;
    } else {
      adjudicationFallbackNote = "jev adjudication is enabled but TYPESAFE_API_KEY is not set; used the Pi adjudicator";
    }
  }
  const matcher = new SemanticMatcher(adjudicator, {
    ...(matcherBaseDir ? { baseDir: matcherBaseDir } : {}),
    maxRetries: resolved.consensusRetries,
  });

  const rawAggregate = await aggregatePanel({
    reviewers: submissions,
    policy: resolved.consensus,
    ...(resolved.minAgree !== undefined ? { minAgree: resolved.minAgree } : {}),
    configuredReviewers: resolved.reviewerCount,
    matcher,
  });
  const aggregate =
    options.signal?.aborted && rawAggregate.status !== "blocked"
      ? {
          ...rawAggregate,
          status: "blocked" as const,
          verdict: "blocked" as const,
          verdictSource: "runtime_error" as const,
          panelHealth: "blocked" as const,
          confirmedClusters: [],
          findings: [],
          actionableCount: 0,
          parseError: rawAggregate.parseError ?? "panel review cancelled",
        }
      : rawAggregate;

  // Panel-level thinking: only surface a single value when every reviewer agrees;
  // otherwise omit (footer used to show shared/preset high while rows were :low).
  const reviewerThinkings = submissions.map((s) => s.thinking).filter((t): t is string => Boolean(t));
  const uniqueThinkings = [...new Set(reviewerThinkings)];
  const panelThinking =
    uniqueThinkings.length === 1
      ? uniqueThinkings[0]
      : uniqueThinkings.length > 1
        ? "mixed"
        : effectiveSharedThinking || effectivePreset.thinking;

  // Panel-level model: same one-value-or-mixed rule as thinking, over each
  // reviewer's effective model (configured, else provider-reported) so an
  // unconfigured panel still surfaces the model every reviewer actually ran on.
  const panelModel = resolvePanelEffectiveModel(submissions, effectiveSharedModel || effectivePreset.model || null);

  // Surface every extension-only provider hint so machine consumers of
  // PI_REVIEW_META_JSON can detect that re-running with
  // PI_REVIEW_CHILD_EXTENSIONS=1 is required (issue #8).
  const extensionHints = collectPanelExtensionHints(submissions);
  const completedAt = Date.now();

  const panelMeta: PanelReviewMeta = {
    ...aggregate,
    metaVersion: REVIEW_META_VERSION,
    reviewMode: effectiveMode,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    model: panelModel,
    thinking: panelThinking,
    usage: sumPanelUsage(submissions.map((s) => s.usage)),
    ...(extensionHints && extensionHints.length > 0 ? { extensionHints } : {}),
    ...(verification ? { verification } : {}),
    ...(resolved.presetName ? { panelPreset: resolved.presetName } : {}),
    ...(matcherBaseDir ? { matcherBaseDir } : {}),
    ...(store ? { runDir: store.runDir } : {}),
    ...(artifact ? { reusedFrom: artifact.sourcePath } : {}),
    // The engine is only meaningful when adjudication actually ran; read it
    // back from the wrapper so a Jev failure that fell back to Pi is reported
    // as "pi", not as the initially attempted "jev".
    ...(aggregate.adjudicationUsed ? { adjudicationEngine: jevWrapper?.engine() ?? "pi" } : {}),
    ...(aggregate.adjudicationUsed && adjudicationFallbackNote ? { adjudicationFallbackNote } : {}),
  };

  const eventPanelMeta = redactReviewEventPayload(panelMeta);
  const footerPanelMeta = redactReviewMetaPayload(panelMeta);
  store?.writeMeta(footerPanelMeta);
  emit("panel.completed", { meta: eventPanelMeta });
  if (options.emitFooter !== false && parsed.outputFormat !== "events-jsonl") emitPanelFooter(footerPanelMeta);
  return { meta: footerPanelMeta, exitCode: reviewExitCode(footerPanelMeta.status) };
}

/** Run one panel evaluation wired to SIGINT/SIGTERM cancellation and exit with its gate exit code. */
async function runPanelReviewToExit(parsed: ParsedArgs, options: PanelRunOptions = {}): Promise<never> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const result = await runPanelReviewOnce(
    parsed,
    parsed.command === "panel-reaggregate" ? "" : undefined,
    { ...options, signal: controller.signal },
  );
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  process.exit(result.exitCode);
}

/** Re-aggregate a persisted panel run without invoking any reviewer sessions. */
export async function runPanelReaggregateOnce(
  parsed: ParsedArgs,
  options: PanelRunOptions = {},
): Promise<{ meta: PanelReviewMeta; exitCode: number }> {
  return runPanelReviewOnce(parsed, "", options);
}

/** CLI-compatible panel reaggregate entrypoint. */
export async function runPanelReaggregate(parsed: ParsedArgs): Promise<never> {
  return runPanelReviewToExit(parsed);
}

/** CLI-compatible panel review entrypoint. */
export async function runPanelReview(parsed: ParsedArgs): Promise<never> {
  return runPanelReviewToExit(parsed);
}

/**
 * CLI-compatible panel review entrypoint with the loopback dashboard (issue
 * #4). The dashboard server is a detached process: this review process still
 * appends normalized events and exits with the existing review exit code
 * immediately once the run completes, regardless of the dashboard's own
 * idle-TTL lifetime.
 */
export async function runPanelReviewWithUi(parsed: ParsedArgs): Promise<never> {
  const launch = await launchPanelUi({
    ...(parsed.uiUrlFile ? { uiUrlFile: parsed.uiUrlFile } : {}),
    ...(parsed.uiTtlSeconds !== undefined ? { ttlSeconds: parsed.uiTtlSeconds } : {}),
    openBrowser: parsed.uiOpen !== false,
  });
  return runPanelReviewToExit(parsed, launch ? { onEvent: launch.onEvent } : {});
}

/**
 * CLI-compatible panel review entrypoint for a host pane (`PI_REVIEW_UI=pane`,
 * set by the Claude Code plugin): events land where the pane reads them and
 * no dashboard server or browser starts, even when `--ui web` was passed.
 */
export async function runPanelReviewInPane(parsed: ParsedArgs): Promise<never> {
  if (parsed.ui === "web") process.stderr.write("pi-review: PI_REVIEW_UI=pane, the host pane shows this panel; --ui web skipped\n");
  return runPanelReviewToExit(parsed, { onEvent: createPaneEventSink() });
}
