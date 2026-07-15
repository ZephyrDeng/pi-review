/** /rv* → parent-agent task text; strategy lives on the command, target stays natural language. */

import type { RvLocale } from "./rv-locale.js";
import { mergeSemanticIntoParsed, stripSemanticPhrases } from "./rv-semantic.js";

export const RV_MODES = ["code", "plan", "challenge"] as const;
export type RvMode = (typeof RV_MODES)[number];

/** Slash-command strategy. Target text after the command is always natural language. */
export const RV_STRATEGIES = ["panel", "loop", "models"] as const;
export type RvStrategy = (typeof RV_STRATEGIES)[number];

const FLAGS_REQUIRING_VALUE = [
  "--mode",
  "--model",
  "--thinking",
  "--continue",
  "--max-rounds",
  "--until",
  "--reviewers",
  "--panel",
  "--reviewer-model",
  "--consensus",
  "--min-agree",
  "--consensus-model",
  "--concurrency",
] as const;

export const RV_CONSENSUS_POLICIES = ["any", "quorum", "majority", "unanimous"] as const;
export type RvConsensusPolicy = (typeof RV_CONSENSUS_POLICIES)[number];
export const RV_MAX_REVIEWERS = 8;

export type RvParsed = {
  /** Selected by the slash command (/rv, /rv-loop, /rv-models), not by rewriting the target. */
  strategy: RvStrategy;
  mode: string;
  model?: string;
  thinking?: string;
  keepSession: boolean;
  noStream: boolean;
  continueHandle?: string;
  modelsOnly: boolean;
  /** Optional loop budget when strategy is loop. */
  maxRounds?: number;
  /** Set when --max-rounds was present but not a strict positive safe integer. */
  maxRoundsError?: string;
  /** Loop stop goal. Only `clean` is supported. */
  until?: "clean";
  untilError?: string;
  /** Panel width: independent reviewers for one gate (and each loop round). */
  reviewers?: number;
  reviewersError?: string;
  /** Named panel preset (e.g. code-experts). Cannot combine with --reviewers. */
  panel?: string;
  /** Per-reviewer model overrides: id=provider/model (repeatable). */
  reviewerModels?: string[];
  reviewerModelsError?: string;
  consensus?: RvConsensusPolicy;
  consensusError?: string;
  minAgree?: number;
  minAgreeError?: string;
  consensusModel?: string;
  concurrency?: number;
  concurrencyError?: string;
  /** Set when a known value-taking flag was present without a value. */
  missingValueError?: string;
  /** Natural-language review request exactly as the user typed it. */
  target: string;
};

/** Same strict rule as CLI `parsePositiveInteger`: /^[1-9]\d*$/ and safe integer. */
export function parseStrictPositiveSafeInteger(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a safe positive integer`);
  }
  return parsed;
}

/** /rv-loop host fix-point default (skill closeout), not the CLI loop default of 3. */
export const RV_LOOP_DEFAULT_MAX_ROUNDS = 1;
/** Host-cycle budget when /rv-loop --until clean is set without an explicit --max-rounds. */
export const RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS = 10;

/** Shared clean-goal definition for /rv-loop --until clean. */
export const RV_CLEAN_GOAL = {
  id: "clean" as const,
  summary:
    "status=clean: no gate-blocking findings (single: no actionable findings; panel: no confirmed actionable clusters; advisories may remain)",
  hostProtocol: [
    "Until-clean host protocol (you are the only editor):",
    "1. Goal: status=clean and exit 0. Advisories may remain; confirmed/actionable findings do not.",
    "2. Run one review gate (CLI may still use --max-rounds as a hard ceiling inside that process).",
    "3. If clean → stop and close out with proof.",
    "4. If has_findings → fix only accepted in-scope blockers, rerun proof, then re-invoke /rv-loop --until clean.",
    "5. If needs_human/blocked → escalate immediately; never claim clean.",
    "6. Hard budget: stop after max-rounds host cycles (default 10 with --until clean) and report remaining findings.",
    "7. Never pretend the child can edit. Never loop forever on an unchanged tree.",
  ].join("\n"),
} as const;

export type RvValidation =
  | { ok: true }
  | { ok: false; message: string };

export function parseRvArgs(raw: string, strategy: RvStrategy = "panel"): RvParsed {
  const { remainder, apply: semanticApply } = stripSemanticPhrases(raw);
  const tokens = remainder.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = tokens.map((t) => t.replace(/^['"]|['"]$/g, ""));

  let mode = "code";
  let model: string | undefined;
  let thinking: string | undefined;
  let keepSession = false;
  let noStream = false;
  let continueHandle: string | undefined;
  let modelsOnly = strategy === "models";
  let maxRounds: number | undefined;
  let maxRoundsError: string | undefined;
  let until: "clean" | undefined;
  let untilError: string | undefined;
  let reviewers: number | undefined;
  let reviewersError: string | undefined;
  let panel: string | undefined;
  let reviewerModels: string[] | undefined;
  let reviewerModelsError: string | undefined;
  let consensus: RvConsensusPolicy | undefined;
  let consensusError: string | undefined;
  let minAgree: number | undefined;
  let minAgreeError: string | undefined;
  let consensusModel: string | undefined;
  let concurrency: number | undefined;
  let concurrencyError: string | undefined;
  let missingValueError: string | undefined;
  const rest: string[] = [];
  const markMissingValue = (flag: string) => {
    missingValueError ??= `Missing value for ${flag}.`;
  };

  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    // Conventional option terminator: everything after `--` is target text.
    if (t === "--") {
      rest.push(...cleaned.slice(i + 1));
      break;
    }
    // Backward compatible: `/rv models` still works, but `/rv-models` is preferred.
    if (strategy === "panel" && t === "models" && rest.length === 0 && i === cleaned.length - 1) {
      modelsOnly = true;
      continue;
    }
    // An @path is always review-target syntax, never a flag value. Reject the
    // preceding flag as missing instead of swallowing the target as its value.
    if ((FLAGS_REQUIRING_VALUE as readonly string[]).includes(t)) {
      const next = cleaned[i + 1];
      if (!next || next.startsWith("--") || next.startsWith("@")) {
        markMissingValue(t);
        continue;
      }
    }
    if (t === "--keep-session") {
      keepSession = true;
      continue;
    }
    if (t === "--no-stream") {
      noStream = true;
      continue;
    }
    if (t === "--mode") {
      const m = cleaned[i + 1];
      if (!m || m.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      mode = cleaned[++i];
      continue;
    }
    if (t === "--model") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      model = cleaned[++i];
      continue;
    }
    if (t === "--thinking") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      thinking = cleaned[++i];
      continue;
    }
    if (t === "--continue") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      continueHandle = cleaned[++i];
      continue;
    }
    if (t === "--max-rounds") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      try {
        maxRounds = parseStrictPositiveSafeInteger("--max-rounds", raw);
        maxRoundsError = undefined;
      } catch (error) {
        maxRounds = undefined;
        maxRoundsError = error instanceof Error ? error.message : "--max-rounds must be a positive integer";
      }
      continue;
    }
    if (t === "--until") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      if (raw === "clean") {
        until = "clean";
        untilError = undefined;
      } else {
        until = undefined;
        untilError = `--until only supports clean (${RV_CLEAN_GOAL.summary})`;
      }
      continue;
    }
    if (t === "--reviewers") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      try {
        reviewers = parseStrictPositiveSafeInteger("--reviewers", raw);
        reviewersError = undefined;
      } catch (error) {
        reviewers = undefined;
        reviewersError = error instanceof Error ? error.message : "--reviewers must be a positive integer";
      }
      continue;
    }
    if (t === "--panel") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      panel = cleaned[++i];
      continue;
    }
    if (t === "--reviewer-model") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      if (!/^[A-Za-z0-9_.-]+\S*=\S+$/.test(raw) && !/^[A-Za-z0-9_.-]+=\S+$/.test(raw)) {
        reviewerModelsError = "--reviewer-model must look like id=provider/model (e.g. r1=openai/gpt-5.6-sol)";
      } else {
        reviewerModels = [...(reviewerModels ?? []), raw];
      }
      continue;
    }
    if (t === "--consensus") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      if ((RV_CONSENSUS_POLICIES as readonly string[]).includes(raw)) {
        consensus = raw as RvConsensusPolicy;
        consensusError = undefined;
      } else {
        consensus = undefined;
        consensusError = `--consensus must be one of ${RV_CONSENSUS_POLICIES.join(" | ")}`;
      }
      continue;
    }
    if (t === "--min-agree") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      try {
        minAgree = parseStrictPositiveSafeInteger("--min-agree", raw);
        minAgreeError = undefined;
      } catch (error) {
        minAgree = undefined;
        minAgreeError = error instanceof Error ? error.message : "--min-agree must be a positive integer";
      }
      continue;
    }
    if (t === "--consensus-model") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      consensusModel = cleaned[++i];
      continue;
    }
    if (t === "--concurrency") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        markMissingValue(t);
        continue;
      }
      const raw = cleaned[++i]!;
      try {
        concurrency = parseStrictPositiveSafeInteger("--concurrency", raw);
        concurrencyError = undefined;
      } catch (error) {
        concurrency = undefined;
        concurrencyError = error instanceof Error ? error.message : "--concurrency must be a positive integer";
      }
      continue;
    }
    rest.push(t);
  }

  const effectiveStrategy: RvStrategy = modelsOnly ? "models" : strategy;
  return mergeSemanticIntoParsed(
    {
      strategy: effectiveStrategy,
      mode,
      model,
      thinking,
      keepSession,
      noStream,
      continueHandle,
      modelsOnly,
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(maxRoundsError ? { maxRoundsError } : {}),
      ...(until ? { until } : {}),
      ...(untilError ? { untilError } : {}),
      ...(reviewers !== undefined ? { reviewers } : {}),
      ...(reviewersError ? { reviewersError } : {}),
      ...(panel ? { panel } : {}),
      ...(reviewerModels ? { reviewerModels } : {}),
      ...(reviewerModelsError ? { reviewerModelsError } : {}),
      ...(consensus ? { consensus } : {}),
      ...(consensusError ? { consensusError } : {}),
      ...(minAgree !== undefined ? { minAgree } : {}),
      ...(minAgreeError ? { minAgreeError } : {}),
      ...(consensusModel ? { consensusModel } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(concurrencyError ? { concurrencyError } : {}),
      ...(missingValueError ? { missingValueError } : {}),
      target: rest.join(" ").trim(),
    },
    semanticApply,
  );
}

export function validateRvParsed(parsed: RvParsed): RvValidation {
  if (parsed.strategy === "loop" && (parsed.keepSession || parsed.continueHandle)) {
    return { ok: false, message: "/rv-loop does not support --keep-session or --continue." };
  }
  if (parsed.keepSession && parsed.continueHandle) {
    return { ok: false, message: "--keep-session and --continue cannot be used together." };
  }
  if (parsed.missingValueError) return { ok: false, message: parsed.missingValueError };
  if (parsed.maxRoundsError) return { ok: false, message: parsed.maxRoundsError };
  if (parsed.untilError) return { ok: false, message: parsed.untilError };
  if (parsed.reviewersError) return { ok: false, message: parsed.reviewersError };
  if (parsed.reviewerModelsError) return { ok: false, message: parsed.reviewerModelsError };
  if (parsed.consensusError) return { ok: false, message: parsed.consensusError };
  if (parsed.minAgreeError) return { ok: false, message: parsed.minAgreeError };
  if (parsed.concurrencyError) return { ok: false, message: parsed.concurrencyError };
  if (parsed.maxRounds !== undefined && parsed.strategy !== "loop") {
    return { ok: false, message: "--max-rounds is only valid with /rv-loop." };
  }
  if (parsed.until !== undefined && parsed.strategy !== "loop") {
    return { ok: false, message: "--until is only valid with /rv-loop." };
  }
  if (parsed.reviewers !== undefined && parsed.panel) {
    return { ok: false, message: "--reviewers cannot be used with --panel" };
  }
  if (parsed.reviewers !== undefined && (parsed.reviewers < 1 || parsed.reviewers > RV_MAX_REVIEWERS)) {
    return { ok: false, message: `--reviewers must be between 1 and ${RV_MAX_REVIEWERS}` };
  }
  const hasPanelOnlyOptions =
    parsed.consensus !== undefined ||
    parsed.minAgree !== undefined ||
    parsed.consensusModel !== undefined ||
    parsed.concurrency !== undefined ||
    (parsed.reviewerModels?.length ?? 0) > 0;
  if (parsed.reviewers === 1 && hasPanelOnlyOptions) {
    return { ok: false, message: "panel options require --reviewers > 1 or --panel" };
  }
  if (parsed.minAgree !== undefined) {
    if (parsed.consensus && parsed.consensus !== "quorum") {
      return { ok: false, message: "--min-agree is only valid with --consensus quorum" };
    }
    if (parsed.reviewers !== undefined && parsed.minAgree > parsed.reviewers) {
      return { ok: false, message: `--min-agree ${parsed.minAgree} cannot exceed reviewers ${parsed.reviewers}` };
    }
  }
  if (parsed.concurrency !== undefined && parsed.reviewers !== undefined && parsed.concurrency > parsed.reviewers) {
    return { ok: false, message: `--concurrency ${parsed.concurrency} cannot exceed reviewers ${parsed.reviewers}` };
  }
  for (const flag of FLAGS_REQUIRING_VALUE) {
    if (parsed.target === flag) {
      return { ok: false, message: `Missing value for ${flag}.` };
    }
  }
  return { ok: true };
}

/** Shell-safe single argument for Execute: lines shown to the parent agent. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  // Prefer single quotes; only escape embedded single quotes.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Same optional flags for initial review and --continue follow-up (all optional). */
export function buildPiReviewArgv(parsed: RvParsed, target: string): string[] {
  const parts = ["pi-review"];
  if (parsed.strategy === "loop") {
    parts.push("loop");
    if (parsed.until === "clean") {
      parts.push("--until", "clean");
      // Until-clean always carries an explicit hard budget (never unlimited).
      parts.push(
        "--max-rounds",
        String(parsed.maxRounds ?? RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS),
      );
    } else {
      // Host fix-point default for /rv-loop is one gate; CLI `pi-review loop` still defaults to 3.
      parts.push("--max-rounds", String(parsed.maxRounds ?? RV_LOOP_DEFAULT_MAX_ROUNDS));
    }
  } else if (parsed.continueHandle) {
    parts.push("--continue", parsed.continueHandle);
  } else if (parsed.keepSession) {
    parts.push("--keep-session");
  }
  if (parsed.mode !== "code") parts.push("--mode", parsed.mode);
  if (parsed.model) parts.push("--model", parsed.model);
  if (parsed.thinking) parts.push("--thinking", parsed.thinking);
  if (parsed.noStream) parts.push("--no-stream");
  if (parsed.panel) parts.push("--panel", parsed.panel);
  if (parsed.reviewers !== undefined) parts.push("--reviewers", String(parsed.reviewers));
  for (const mapping of parsed.reviewerModels ?? []) parts.push("--reviewer-model", mapping);
  if (parsed.consensus) parts.push("--consensus", parsed.consensus);
  if (parsed.minAgree !== undefined) parts.push("--min-agree", String(parsed.minAgree));
  if (parsed.consensusModel) parts.push("--consensus-model", parsed.consensusModel);
  if (parsed.concurrency !== undefined) parts.push("--concurrency", String(parsed.concurrency));
  parts.push("--", target);
  return parts;
}

/** Format argv as a shell-safe command line for orchestration prompts. */
export function formatPiReviewCommandLine(parsed: RvParsed, target: string): string {
  return buildPiReviewArgv(parsed, target).map(shellQuote).join(" ");
}

/** Build the native pi_review tool call instruction without dropping panel config. */
export function buildPiReviewToolCallInstruction(parsed: RvParsed, target: string): string {
  const fields: string[] = [
    `target=${JSON.stringify(target)}`,
    `mode=${JSON.stringify(parsed.mode)}`,
  ];
  if (parsed.panel) fields.push(`panel=${JSON.stringify(parsed.panel)}`);
  if (parsed.reviewers !== undefined) fields.push(`reviewers=${parsed.reviewers}`);
  if (parsed.reviewerModels?.length) fields.push(`reviewerModels=${JSON.stringify(parsed.reviewerModels)}`);
  if (parsed.consensus) fields.push(`consensus=${JSON.stringify(parsed.consensus)}`);
  if (parsed.minAgree !== undefined) fields.push(`minAgree=${parsed.minAgree}`);
  if (parsed.consensusModel) fields.push(`consensusModel=${JSON.stringify(parsed.consensusModel)}`);
  if (parsed.concurrency !== undefined) fields.push(`concurrency=${parsed.concurrency}`);
  if (parsed.model) fields.push(`model=${JSON.stringify(parsed.model)}`);
  if (parsed.thinking) fields.push(`thinking=${JSON.stringify(parsed.thinking)}`);
  // Default panel when /rv has no explicit width/preset: keep code-experts.
  if (parsed.strategy === "panel" && !parsed.panel && parsed.reviewers === undefined) {
    fields.push(`panel=${JSON.stringify("code-experts")}`);
  }
  return `Call pi_review with ${fields.join(", ")}. Treat target as a natural-language review request. Do not expand directory targets into multi-file lists. Do not drop panel/reviewers/reviewerModels/consensus fields.`;
}

export function orchestrationLocaleNote(locale: RvLocale = "en"): string {
  if (locale === "zh") {
    return "用中文向用户总结（模型目录、选型理由、review 结论）；技术 id 如 provider/model 可保留英文。";
  }
  return "Summarize for the user in English (catalog, model rationale, review conclusion); keep technical ids such as provider/model as listed.";
}

function piHostRules(strategy: RvStrategy): string {
  return [
    "Follow the pi-review skill.",
    "Host: Pi interactive session (/rv*).",
    "Slash commands select strategy only: /rv = panel review, /rv-loop = loop closeout, /rv-models = model catalog.",
    "Everything after the command is a natural-language review request. Path mentions like @src are fine as text.",
    "Do not expand directory targets into multi-file lists. Strategy matching beyond the slash command (mode defaults, model choice, panel preset, path-vs-file handling) lives in the pi-review skill and CLI.",
    strategy === "panel"
      ? "For /rv panel runs, call the pi_review custom tool. Exception: explicit --reviewers 1 is a non-panel single review and must use the shell CLI path; never replace it with the default code-experts panel."
      : strategy === "loop"
        ? "For /rv-loop, follow the Loop closeout protocol in the pi-review skill. Use the shell CLI loop path; do not pretend the child can edit files."
        : "For /rv-models, only list models; do not start a review.",
    "CLI defaults: stream child output live. Do NOT add --no-stream or --progress-log unless the user explicitly asked.",
    "Do not edit, patch, commit, or implement findings unless the user asks separately.",
    "For pi_review panel runs, report the tool's rendered panel result and status. For CLI fallback, loop, and --continue runs, show the ASCII pi-review footer (lines starting with ── pi-review). Do not paste PI_REVIEW_META_JSON to the user; use Session from a CLI footer for /rv --continue.",
  ].join(" ");
}

export function buildRvOrchestrationPrompt(
  parsed: RvParsed,
  locale: RvLocale = "en",
  resolutionNotes: string[] = [],
): string {
  const localeNote = orchestrationLocaleNote(locale);
  if (parsed.modelsOnly || parsed.strategy === "models") {
    return [
      "Run the pi-review model catalog step.",
      piHostRules("models"),
      localeNote,
      "Execute: pi-review models",
      "Summarize briefly: provider count and 2–3 model IDs that fit code vs frontend vs plan/challenge (see pi-review skill references/model-selection.md).",
      "Do not start a review until the user supplies a natural-language target via /rv or /rv-loop.",
    ].join("\n\n");
  }

  const followUpDefault = "follow up on the previous review";
  const target = parsed.target || (parsed.continueHandle ? followUpDefault : "");

  if (!target && !parsed.continueHandle) {
    return [
      parsed.strategy === "loop" ? "/rv-loop needs a review target." : "/rv needs a review target.",
      "Usage:",
      "  /rv [--mode code|plan|challenge] [--model provider/model] [--keep-session] <natural-language target>",
      "  /rv-loop [--mode ...] [--model ...] [--max-rounds n] <natural-language target>",
      "  /rv-models",
      "  /rv --continue <handle> [--mode ...] [--model ...] [follow-up text]",
      "Examples: /rv @src | /rv review the auth changes | /rv-loop fix until clean @src | /rv-models",
    ].join("\n");
  }

  const modeBlock: Record<string, string> = {
    code: [
      "Mode: code (default).",
      "Focus: correctness, regressions, security, concurrency, API contracts, edge cases, tests.",
      "Use read-only inspection via pi-review; no file mutations.",
    ].join(" "),
    plan: [
      "Mode: plan.",
      "Review architecture, design, or strategy through engineering, product, security, QA, ops, and DX lenses.",
      "Identify fatal flaws, trade-offs, sequencing risks, and minimal changes to de-risk the plan.",
    ].join(" "),
    challenge: [
      "Mode: challenge (adversarial).",
      "Pressure-test assumptions, boundaries, dependencies, failure modes, migration, and missing evidence.",
      "One-shot conclusion; do not run a live Q&A interview.",
    ].join(" "),
  };

  const cliLine = formatPiReviewCommandLine(parsed, target);

  const resolutionStep = resolutionNotes.length
    ? `Resolved user shortcuts against the live model catalog:\n${resolutionNotes.map((note) => `- ${note}`).join("\n")}`
    : "";

  const modelStep = parsed.model
    ? `Use model exactly as resolved: ${parsed.model}${parsed.thinking ? ` at thinking ${parsed.thinking}` : ""}. Prefer this exact catalog id; do not invent a different provider/model.`
    : parsed.thinking
      ? `Run pi-review models first if needed; pick using skill references/model-selection.md (code / frontend / plan) or omit --model for Pi default. Use thinking ${parsed.thinking}.`
      : "Run pi-review models first if needed; pick using skill references/model-selection.md (code / frontend / plan) or omit --model for Pi default.";

  const continueNote = parsed.continueHandle
    ? "Continuing an existing review session. Optional --mode and --model match the same flags as an initial /rv run."
    : parsed.keepSession
      ? "Use --keep-session so the user can follow up with /rv --continue <handle>."
      : "";

  const singleReviewer = parsed.strategy === "panel" && parsed.reviewers === 1 && !parsed.panel;
  const strategyNote =
    parsed.strategy === "loop"
      ? parsed.until === "clean"
        ? [
            "Strategy: loop until clean (host-driven).",
            `Clean goal: ${RV_CLEAN_GOAL.summary}.`,
            `Hard budget: --max-rounds ${parsed.maxRounds ?? RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS} (never unlimited).`,
            RV_CLEAN_GOAL.hostProtocol,
            "CLI child remains review-only; you own every fix and re-invocation.",
          ].join("\n")
        : `Strategy: loop closeout. Follow the Loop closeout protocol. /rv-loop defaults to --max-rounds ${RV_LOOP_DEFAULT_MAX_ROUNDS} (host fix point after each gate); explicit value here: ${parsed.maxRounds ?? RV_LOOP_DEFAULT_MAX_ROUNDS}. Note: bare CLI "pi-review loop" still defaults to 3.`
      : singleReviewer
        ? "Strategy: explicit single-reviewer, non-panel review via shell CLI. Do not call pi_review and do not substitute code-experts."
        : "Strategy: panel review via pi_review (code-experts by default unless reviewers/panel are set).";

  // Shell path for loop/continue/keep-session/no-stream. Native tool path for ordinary /rv panels.
  // Always preserve panel width, per-reviewer models, and consensus fields.
  const untilCleanHostLoop =
    parsed.strategy === "loop" && parsed.until === "clean"
      ? [
          "Host until-clean cycle (required):",
          "A) Execute the shell CLI command below once (one process / one or more internal review rounds).",
          "B) Read the ASCII footer Stop/Exit and status.",
          "C) If Stop=clean and Exit=0 → done. Report clean goal met.",
          "D) If has_findings / exit 1 → fix accepted in-scope blockers only, run proof, then re-execute the same command (count as next host cycle).",
          "E) If needs_human/blocked → stop and escalate.",
          `F) Stop after ${parsed.maxRounds ?? RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS} host cycles even if not clean; never infinite-loop on an unchanged tree.`,
        ].join("\n")
      : "";

  const execution =
    parsed.strategy === "loop" || parsed.continueHandle || parsed.keepSession || parsed.noStream || singleReviewer
      ? `Execute exactly (already shell-quoted; do not re-quote or drop flags):\n${cliLine}`
      : buildPiReviewToolCallInstruction(parsed, target);

  return [
    parsed.continueHandle
      ? "Continue a prior pi-review session."
      : parsed.strategy === "loop"
        ? parsed.until === "clean"
          ? "Run a pi-review until-clean closeout for the target below."
          : "Run a pi-review loop closeout for the target below."
        : singleReviewer
          ? "Run a single-reviewer non-panel pi-review for the target below."
          : "Run pi-review for the target below.",
    piHostRules(parsed.strategy),
    localeNote,
    strategyNote,
    untilCleanHostLoop,
    modeBlock[parsed.mode] ??
      `Mode: ${parsed.mode}. Follow the preset named in review-presets.json when present.`,
    resolutionStep,
    modelStep,
    continueNote,
    execution,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const RV_COMPLETIONS: { value: string; hint: string }[] = [
  { value: "@", hint: "path mention after @ (e.g. @src or @src/foo.ts); passed as natural-language target text" },
  { value: "models", hint: "list pi-review models only" },
  { value: "--mode code", hint: "code / diff / MR review" },
  { value: "--mode plan", hint: "architecture or plan review" },
  { value: "--mode challenge", hint: "adversarial plan review" },
  { value: "--model ", hint: "provider/model from pi-review models" },
  { value: "--thinking ", hint: "off|minimal|low|medium|high|xhigh" },
  { value: "--keep-session", hint: "persist session for follow-up" },
  { value: "--no-stream", hint: "rare: buffer until exit (not default in Pi)" },
  { value: "--continue ", hint: "resume session; same optional flags as initial /rv" },
  { value: "--max-rounds ", hint: "loop hard budget / review gates (not reviewer count)" },
  { value: "--until clean", hint: "loop goal: host re-review until clean gate (hard-capped by --max-rounds)" },
  { value: "--reviewers ", hint: "panel width: independent reviewers per gate (1-8)" },
  { value: "--panel ", hint: "named panel preset (e.g. code-experts)" },
  { value: "--reviewer-model ", hint: "per-reviewer model: r1=provider/model (repeatable)" },
  { value: "--consensus ", hint: "any|quorum|majority|unanimous" },
  { value: "--min-agree ", hint: "quorum threshold (quorum only)" },
  { value: "--concurrency ", hint: "bound parallel reviewers" },
];
