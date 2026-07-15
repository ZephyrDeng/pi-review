// Panel review orchestration: run N independent reviewer child sessions with
// bounded concurrency, aggregate their structured findings into one panel
// result, and emit a single aggregate footer + metadata record. Reviewers and
// the consensus adjudicator remain review-only (no write tools, --no-session).

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { PANEL_READ_ONLY_TOOLS } from "./types.js";
import type {
  ParsedArgs,
  PanelReviewMeta,
  ReviewerSubmission,
  StructuredReviewResult,
  VerdictInfo,
} from "./types.js";
export { PANEL_READ_ONLY_TOOLS } from "./types.js";
import { spawnStreamingChild } from "./child-process.js";
import { childEnv, childRuntimeError, readReviewStdin } from "./review.js";
import { loadPanelPresets, loadPresets, loadSystemPrompt } from "./presets.js";
import { splitPayload, normalizePayloadRefs, buildReviewerPrompt, buildAdjudicatorPrompt } from "./prompt.js";
import { parseVerdict } from "./verdict.js";
import { parseReviewResult, reviewExitCode } from "./review-result.js";
import { extractFinalText, JsonEventStream } from "./json-events.js";
import type { TokenUsage } from "./types.js";
import { fail, expandMaybeHome } from "./utils.js";
import { resolveConfig, type Config } from "./config.js";
import { resolvePanelConfig, resolveReviewerModelThinking, type ResolvedPanelConfig } from "./panel-config.js";
import { aggregatePanel } from "./panel-aggregate.js";
import { sumPanelUsage } from "./panel-usage.js";
import { SemanticMatcher, type AdjudicationCandidate, type SemanticAdjudicator } from "./matcher.js";
import { formatPanelMetaAscii, formatPanelFindingsMarkdown, formatReviewMetaJsonLine } from "./meta-footer.js";
import { createReviewEventEmitter, redactReviewEventPayload, redactReviewMetaPayload, type ReviewEvent, type ReviewEventListener } from "./review-events.js";
import { launchPanelUi } from "./panel-ui.js";

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

function buildReviewerArgs(
  config: Config,
  parsed: ParsedArgs,
  preset: { tools?: string[] | string; thinking?: string; provider?: string; model?: string; skillPaths?: string[] },
  prompt: string,
  fileRefs: string[],
  reviewer: { provider?: string; model?: string; thinking?: string },
  progressLog: string | undefined,
  systemPrompt: string,
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

  let progressStream: fs.WriteStream | undefined;
  if (progressLog) {
    fs.mkdirSync(path.dirname(progressLog), { recursive: true });
    progressStream = fs.createWriteStream(progressLog, { flags: "a" });
  }

  // Reviewers always run in --mode json. A JsonEventStream accumulates token
  // usage and emits reviewer-prefixed milestones to stderr; reviewer prose is
  // NOT forwarded to stdout so concurrent reviewers never interleave (issue #2
  // progress isolation). The raw json lines tee into the progress-log file.
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
          emit("reviewer.usage", { reviewerId: reviewer.id, usage: event.usage });
          break;
      }
    },
  });
  const stdoutSink = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      if (progressStream) progressStream.write(text);
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
  if (progressStream) {
    await new Promise<void>((resolve) => progressStream!.end(() => resolve()));
  }

  let stdout = child.stdout || "";
  const runtimeError = childRuntimeError(child);
  // Surface a captured reviewer stderr tail only when the child failed, so
  // concurrent reviewer diagnostics never interleave on the shared terminal.
  const reviewerStderr = stderrChunks.join("");

  let extractedError: string | undefined;
  let extractedFatal = false;
  const reviewerUsage = streamParser.usage().usage;
  {
    const extracted = extractFinalText(stdout);
    stdout = extracted.text;
    extractedError = extracted.error;
    extractedFatal = Boolean(extracted.fatal);
  }

  let verdictInfo: VerdictInfo = parseVerdict(stdout);

  if (runtimeError) {
    const detail = [runtimeError, reviewerStderr.slice(-2000)].filter(Boolean).join("; ");
    verdictInfo = { verdict: "blocked", verdictSource: "runtime_error", parseError: detail };
  } else if (extractedFatal) {
    const detail = [extractedError, reviewerStderr.slice(-2000)].filter(Boolean).join("; ");
    verdictInfo = { verdict: "blocked", verdictSource: "runtime_error", parseError: detail };
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
      const prompt = buildAdjudicatorPrompt(request.candidates as AdjudicationCandidate[]);
      // The adjudicator is aggregation-only: it must not inspect the repository
      // as an additional reviewer and has no write capability. Disable all tools
      // and run with no session — it returns JSON purely from the structured
      // findings embedded in the prompt.
      const args: string[] = ["-p", "--no-session", "--no-tools", "--append-system-prompt", adjudicatorSystemPrompt];
      if (consensusModel) args.push("--model", consensusModel);
      args.push(prompt);

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
function resolvePanel(parsed: ParsedArgs, config: Config): ResolvedPanelConfig {
  const panelPresets = loadPanelPresets(config.panelPresetsFile);
  try {
    return resolvePanelConfig(parsed, panelPresets);
  } catch (error) {
    if (error instanceof Error) fail(error.message);
    throw error;
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
): ReviewerSubmission {
  return {
    reviewerId: reviewer.id,
    role: reviewer.role,
    model: reviewer.model ?? null,
    ...(reviewer.thinking ? { thinking: reviewer.thinking } : {}),
    ...(usage ? { usage } : {}),
    durationMs,
    result: { status: "blocked", verdict: "blocked", verdictSource: "runtime_error", parseError: message, findings: [], actionableCount: 0 },
  };
}

/** Keep finished reviewer results on abort; only rewrite interrupted/runtime-cancelled work. */
export function shouldPreserveSubmissionOnAbort(submission: ReviewerSubmission): boolean {
  return submission.result.verdictSource !== "runtime_error";
}

/** Run one complete panel evaluation and return the aggregate result (no exit). */
export async function runPanelReviewOnce(
  parsed: ParsedArgs,
  stdinText = readReviewStdin(),
  options: PanelRunOptions = {},
): Promise<{ meta: PanelReviewMeta; exitCode: number }> {
  const config = resolveConfig();
  const resolved = resolvePanel(parsed, config);
  const presets = loadPresets(config.presetsFile);
  const preset = presets[parsed.mode];
  if (!preset) {
    fail(`unknown review mode: ${parsed.mode}\nAvailable modes: ${Object.keys(presets).join(", ")}`);
  }
  const systemPrompt = loadSystemPrompt(config.systemPromptFile);
  // Validate tool capability before lifecycle emission so a malformed preset
  // cannot leave events-jsonl consumers with a partial stream.
  try {
    resolvePanelReviewerTools(parsed.tools || preset.tools);
  } catch (error) {
    if (error instanceof Error) fail(error.message);
    throw error;
  }
  const payload = normalizePayloadRefs(splitPayload(parsed.payload));
  const emit = createReviewEventEmitter(randomUUID(), (event) => {
    if (parsed.outputFormat === "events-jsonl") process.stdout.write(`${JSON.stringify(event)}\n`);
    options.onEvent?.(event);
  });
  const reviewerIdentities = resolved.reviewers.map((reviewer) => {
    const { model, thinking } = resolveReviewerModelThinking(reviewer, {
      model: parsed.model || preset.model,
      thinking: parsed.thinking || preset.thinking,
    });
    return {
      reviewerId: reviewer.id,
      role: reviewer.role,
      model: model ?? null,
      ...(thinking ? { thinking } : {}),
    };
  });
  emit("panel.started", { target: parsed.payload.join(" "), mode: parsed.mode, ...(resolved.presetName ? { panelPreset: resolved.presetName } : {}), reviewers: reviewerIdentities });
  for (const reviewer of resolved.reviewers) emit("reviewer.queued", { reviewerId: reviewer.id });

  const startedAt = Date.now();
  const submissions = await mapWithConcurrency(
    resolved.reviewers,
    resolved.concurrency,
    async (reviewer) => {
      if (options.signal?.aborted) {
        const message = "panel review cancelled";
        emit("reviewer.cancelled", { reviewerId: reviewer.id, message });
        return cancelledSubmission(reviewer, message);
      }
      const reviewerStart = Date.now();
      emit("reviewer.started", { reviewerId: reviewer.id });
      const prompt = buildReviewerPrompt(parsed.mode, preset, payload, stdinText, reviewer);
      const progressLog = reviewerProgressLog(parsed.progressLog, reviewer.id);
      const submission = await runReviewerChild({
        config,
        parsed,
        preset,
        prompt,
        fileRefs: payload.attachableFileRefs ?? payload.fileRefs,
        reviewer,
        progressLog,
        systemPrompt,
        signal: options.signal,
        emit,
        quietProgress: parsed.outputFormat === "events-jsonl",
      });
      const completed = { ...submission, durationMs: Date.now() - reviewerStart };
      if (options.signal?.aborted) {
        if (shouldPreserveSubmissionOnAbort(completed)) {
          emit("reviewer.completed", { reviewerId: reviewer.id, submission: completed });
          return completed;
        }
        emit("reviewer.cancelled", { reviewerId: reviewer.id, message: "panel review cancelled" });
        return cancelledSubmission(reviewer, "panel review cancelled", completed.durationMs, completed.usage);
      } else if (completed.result.verdictSource === "runtime_error") {
        emit("reviewer.failed", { reviewerId: reviewer.id, message: completed.result.parseError ?? "reviewer failed" });
      } else {
        emit("reviewer.completed", { reviewerId: reviewer.id, submission: completed });
      }
      return completed;
    },
  );

  // Semantic adjudication is on by default (issue #2 Decision 27): when
  // ambiguous same-path candidates exist, a constrained adjudicator clusters
  // them. --consensus-model overrides the adjudicator model; otherwise fall
  // back to the shared review model / Pi default. Exact matches never invoke
  // the adjudicator, so this stays cheap when there is nothing ambiguous.
  const adjudicatorModel = resolved.consensusModel ?? parsed.model ?? preset.model ?? undefined;
  emit("aggregation.started", {});
  const matcher = new SemanticMatcher(createAdjudicator(config, adjudicatorModel, options.signal));

  const aggregate = await aggregatePanel({
    reviewers: submissions,
    policy: resolved.consensus,
    ...(resolved.minAgree !== undefined ? { minAgree: resolved.minAgree } : {}),
    configuredReviewers: resolved.reviewerCount,
    matcher,
  });

  // Panel-level thinking: only surface a single value when every reviewer agrees;
  // otherwise omit (footer used to show shared/preset high while rows were :low).
  const reviewerThinkings = submissions.map((s) => s.thinking).filter((t): t is string => Boolean(t));
  const uniqueThinkings = [...new Set(reviewerThinkings)];
  const panelThinking =
    uniqueThinkings.length === 1
      ? uniqueThinkings[0]
      : uniqueThinkings.length > 1
        ? "mixed"
        : parsed.thinking || preset.thinking;

  const panelMeta: PanelReviewMeta = {
    ...aggregate,
    reviewMode: parsed.mode,
    durationMs: Date.now() - startedAt,
    model: parsed.model || preset.model || null,
    thinking: panelThinking,
    usage: sumPanelUsage(submissions.map((s) => s.usage)),
    ...(resolved.presetName ? { panelPreset: resolved.presetName } : {}),
  };

  const eventPanelMeta = redactReviewEventPayload(panelMeta);
  const footerPanelMeta = redactReviewMetaPayload(panelMeta);
  emit("panel.completed", { meta: eventPanelMeta });
  if (options.emitFooter !== false && parsed.outputFormat !== "events-jsonl") emitPanelFooter(footerPanelMeta);
  return { meta: panelMeta, exitCode: reviewExitCode(panelMeta.status) };
}

/** Run one panel evaluation wired to SIGINT/SIGTERM cancellation and exit with its gate exit code. */
async function runPanelReviewToExit(parsed: ParsedArgs, options: PanelRunOptions = {}): Promise<never> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const result = await runPanelReviewOnce(parsed, readReviewStdin(), { ...options, signal: controller.signal });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  process.exit(result.exitCode);
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
  });
  return runPanelReviewToExit(parsed, launch ? { onEvent: launch.onEvent } : {});
}
