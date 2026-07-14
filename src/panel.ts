// Panel review orchestration: run N independent reviewer child sessions with
// bounded concurrency, aggregate their structured findings into one panel
// result, and emit a single aggregate footer + metadata record. Reviewers and
// the consensus adjudicator remain review-only (no write tools, --no-session).

import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import type {
  ParsedArgs,
  PanelReviewMeta,
  ReviewerSubmission,
  StructuredReviewResult,
  VerdictInfo,
} from "./types.js";
import { spawnBufferedChild, spawnStreamingChild } from "./child-process.js";
import { childEnv, childRuntimeError, readReviewStdin } from "./review.js";
import { loadPanelPresets, loadPresets, loadSystemPrompt } from "./presets.js";
import { splitPayload, buildReviewerPrompt, buildAdjudicatorPrompt } from "./prompt.js";
import { parseVerdict } from "./verdict.js";
import { parseReviewResult, reviewExitCode } from "./review-result.js";
import { extractFinalText, JsonEventStream } from "./json-events.js";
import type { TokenUsage } from "./types.js";
import { fail, expandMaybeHome, normalizeTools } from "./utils.js";
import { resolveConfig, type Config } from "./config.js";
import { resolvePanelConfig, type ResolvedPanelConfig } from "./panel-config.js";
import { aggregatePanel } from "./panel-aggregate.js";
import { SemanticMatcher, type AdjudicationCandidate, type SemanticAdjudicator } from "./matcher.js";
import { formatPanelMetaAscii, formatPanelFindingsMarkdown, formatReviewMetaJsonLine, formatUsage, formatTokens } from "./meta-footer.js";

/** Emit the aggregate panel footer (ASCII + JSON) like a single review. */
/** Sum token usage across reviewers (prompt-scoped fields as maxima, output as additive). */
function sumUsage(usages: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = usages.filter((u): u is TokenUsage => Boolean(u));
  if (present.length === 0) return undefined;
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  for (const u of present) {
    total.input = Math.max(total.input, u.input);
    total.cacheRead = Math.max(total.cacheRead, u.cacheRead);
    total.cacheWrite = Math.max(total.cacheWrite, u.cacheWrite);
    total.output += u.output;
    total.reasoning = Math.max(total.reasoning, u.reasoning);
    total.totalTokens = Math.max(total.totalTokens, u.totalTokens);
    if (typeof u.costTotal === "number") total.costTotal = (total.costTotal ?? 0) + u.costTotal;
  }
  return total;
}

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

/** Tools that can mutate the working tree — forbidden for panel reviewers. */
const WRITE_TOOLS = new Set([
  "edit", "write", "apply_patch", "create_file", "create", "patch",
  "str_replace_editor", "file_editor", "delete", "move",
]);

/** Force a read-only tool allowlist for panel reviewers (issue #2 review-only security). */
function readOnlyTools(tools: string | undefined): string | undefined {
  if (!tools) return undefined;
  const kept = tools
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !WRITE_TOOLS.has(t));
  if (kept.length === 0) return "read,grep,find,ls";
  return kept.join(",");
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
  const model = reviewer.model || parsed.model || preset.model;
  const thinking = reviewer.thinking || parsed.thinking || preset.thinking;
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  const tools = readOnlyTools(parsed.tools || normalizeTools(preset.tools));
  if (tools) args.push("--tools", tools);

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
}

async function runReviewerChild(input: ReviewerRunInput): Promise<ReviewerSubmission> {
  const { config, parsed, preset, prompt, fileRefs, reviewer, progressLog, systemPrompt } = input;
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
    onMilestone: (line) => process.stderr.write(`  [${reviewer.id}] ${line}`),
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
  const model = reviewer.model || parsed.model || preset.model || null;
  const thinking = reviewer.thinking || parsed.thinking || preset.thinking;

  return {
    reviewerId: reviewer.id,
    role: reviewer.role,
    model,
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
      const prompt = buildAdjudicatorPrompt(request.candidates as AdjudicationCandidate[]);
      // The adjudicator is aggregation-only: it must not inspect the repository
      // as an additional reviewer and has no write capability. Disable all tools
      // and run with no session — it returns JSON purely from the structured
      // findings embedded in the prompt.
      const args: string[] = ["-p", "--no-session", "--no-tools", "--append-system-prompt", adjudicatorSystemPrompt];
      if (consensusModel) args.push("--model", consensusModel);
      args.push(prompt);

      const child = spawnBufferedChild(config.piBin, args, {
        cwd: process.cwd(),
        env: childEnv(config.piBin),
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

/** Run one complete panel evaluation and return the aggregate result (no exit). */
export async function runPanelReviewOnce(parsed: ParsedArgs, stdinText = readReviewStdin()): Promise<{ meta: PanelReviewMeta; exitCode: number }> {
  const config = resolveConfig();
  const resolved = resolvePanel(parsed, config);
  const presets = loadPresets(config.presetsFile);
  const preset = presets[parsed.mode];
  if (!preset) {
    fail(`unknown review mode: ${parsed.mode}\nAvailable modes: ${Object.keys(presets).join(", ")}`);
  }
  const systemPrompt = loadSystemPrompt(config.systemPromptFile);
  const payload = splitPayload(parsed.payload);

  const startedAt = Date.now();
  const submissions = await mapWithConcurrency(
    resolved.reviewers,
    resolved.concurrency,
    async (reviewer) => {
      const reviewerStart = Date.now();
      const prompt = buildReviewerPrompt(parsed.mode, preset, payload, stdinText, reviewer);
      const progressLog = reviewerProgressLog(parsed.progressLog, reviewer.id);
      const submission = await runReviewerChild({
        config,
        parsed,
        preset,
        prompt,
        fileRefs: payload.fileRefs,
        reviewer,
        progressLog,
        systemPrompt,
      });
      return { ...submission, durationMs: Date.now() - reviewerStart };
    },
  );

  // Semantic adjudication is on by default (issue #2 Decision 27): when
  // ambiguous same-path candidates exist, a constrained adjudicator clusters
  // them. --consensus-model overrides the adjudicator model; otherwise fall
  // back to the shared review model / Pi default. Exact matches never invoke
  // the adjudicator, so this stays cheap when there is nothing ambiguous.
  const adjudicatorModel = resolved.consensusModel ?? parsed.model ?? preset.model ?? undefined;
  const matcher = new SemanticMatcher(createAdjudicator(config, adjudicatorModel));

  const aggregate = await aggregatePanel({
    reviewers: submissions,
    policy: resolved.consensus,
    ...(resolved.minAgree !== undefined ? { minAgree: resolved.minAgree } : {}),
    configuredReviewers: resolved.reviewerCount,
    matcher,
  });

  const panelMeta: PanelReviewMeta = {
    ...aggregate,
    reviewMode: parsed.mode,
    durationMs: Date.now() - startedAt,
    model: parsed.model || preset.model || null,
    thinking: parsed.thinking || preset.thinking,
    usage: sumUsage(submissions.map((s) => s.usage)),
    ...(resolved.presetName ? { panelPreset: resolved.presetName } : {}),
  };

  emitPanelFooter(panelMeta);
  return { meta: panelMeta, exitCode: reviewExitCode(panelMeta.status) };
}

/** CLI-compatible panel review entrypoint. */
export async function runPanelReview(parsed: ParsedArgs): Promise<never> {
  const result = await runPanelReviewOnce(parsed);
  process.exit(result.exitCode);
}
