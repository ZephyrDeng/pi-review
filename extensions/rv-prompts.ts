/** /rv* → parent-agent task text; strategy lives on the command, target stays natural language. */

import type { RvLocale } from "./rv-locale.js";
import { mergeSemanticIntoParsed, stripSemanticPhrases } from "./rv-semantic.js";

export const RV_MODES = ["code", "plan", "challenge"] as const;
export type RvMode = (typeof RV_MODES)[number];

/** Slash-command strategy. Target text after the command is always natural language. */
export const RV_STRATEGIES = ["panel", "loop", "models"] as const;
export type RvStrategy = (typeof RV_STRATEGIES)[number];

const FLAGS_REQUIRING_VALUE = ["--mode", "--model", "--thinking", "--continue", "--max-rounds"] as const;

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
  /** Natural-language review request exactly as the user typed it. */
  target: string;
};

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
  const rest: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    // Backward compatible: `/rv models` still works, but `/rv-models` is preferred.
    if (strategy === "panel" && t === "models" && rest.length === 0 && i === cleaned.length - 1) {
      modelsOnly = true;
      continue;
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
        rest.push(t);
        continue;
      }
      mode = cleaned[++i];
      continue;
    }
    if (t === "--model") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        rest.push(t);
        continue;
      }
      model = cleaned[++i];
      continue;
    }
    if (t === "--thinking") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        rest.push(t);
        continue;
      }
      thinking = cleaned[++i];
      continue;
    }
    if (t === "--continue") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        rest.push(t);
        continue;
      }
      continueHandle = cleaned[++i];
      continue;
    }
    if (t === "--max-rounds") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        rest.push(t);
        continue;
      }
      const n = Number(cleaned[++i]);
      if (Number.isFinite(n) && n > 0) maxRounds = Math.floor(n);
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
  if (parsed.maxRounds !== undefined && parsed.strategy !== "loop") {
    return { ok: false, message: "--max-rounds is only valid with /rv-loop." };
  }
  for (const flag of FLAGS_REQUIRING_VALUE) {
    if (parsed.target === flag) {
      return { ok: false, message: `Missing value for ${flag}.` };
    }
  }
  return { ok: true };
}

/** Same optional flags for initial review and --continue follow-up (all optional). */
export function buildPiReviewArgv(parsed: RvParsed, target: string): string[] {
  const parts = ["pi-review"];
  if (parsed.strategy === "loop") {
    parts.push("loop");
    if (parsed.maxRounds !== undefined) parts.push("--max-rounds", String(parsed.maxRounds));
  } else if (parsed.continueHandle) {
    parts.push("--continue", parsed.continueHandle);
  } else if (parsed.keepSession) {
    parts.push("--keep-session");
  }
  if (parsed.mode !== "code") parts.push("--mode", parsed.mode);
  if (parsed.model) parts.push("--model", parsed.model);
  if (parsed.thinking) parts.push("--thinking", parsed.thinking);
  if (parsed.noStream) parts.push("--no-stream");
  parts.push("--", target);
  return parts;
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
      ? "For /rv panel runs, call the pi_review custom tool. It launches pi-review in isolated reviewer sessions and renders panel progress live."
      : strategy === "loop"
        ? "For /rv-loop, follow the Loop closeout protocol in the pi-review skill. Use the shell CLI loop path; do not pretend the child can edit files."
        : "For /rv-models, only list models; do not start a review.",
    "CLI defaults: stream child output live. Do NOT add --no-stream or --progress-log unless the user explicitly asked.",
    "Do not edit, patch, commit, or implement findings unless the user asks separately.",
    "For pi_review panel runs, report the tool's rendered panel result and status. For CLI fallback, loop, and --continue runs, show the ASCII pi-review footer (lines starting with ── pi-review). Do not paste PI_REVIEW_META_JSON to the user; use Session from a CLI footer for /rv --continue.",
  ].join(" ");
}

export function buildRvOrchestrationPrompt(parsed: RvParsed, locale: RvLocale = "en"): string {
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

  const cliLine = buildPiReviewArgv(parsed, target).join(" ");

  const modelStep = parsed.model
    ? `Use model exactly as given: ${parsed.model}${parsed.thinking ? ` at thinking ${parsed.thinking}` : ""} (model must appear in pi-review models output).`
    : parsed.thinking
      ? `Run pi-review models first if needed; pick using skill references/model-selection.md (code / frontend / plan) or omit --model for Pi default. Use thinking ${parsed.thinking}.`
      : "Run pi-review models first if needed; pick using skill references/model-selection.md (code / frontend / plan) or omit --model for Pi default.";

  const continueNote = parsed.continueHandle
    ? "Continuing an existing review session. Optional --mode and --model match the same flags as an initial /rv run."
    : parsed.keepSession
      ? "Use --keep-session so the user can follow up with /rv --continue <handle>."
      : "";

  const strategyNote =
    parsed.strategy === "loop"
      ? `Strategy: loop closeout. Follow the Loop closeout protocol. Default budget is one review gate unless --max-rounds is set${parsed.maxRounds !== undefined ? ` (here: ${parsed.maxRounds})` : ""}.`
      : "Strategy: panel review via pi_review (code-experts by default).";

  const execution =
    parsed.strategy === "loop" || parsed.continueHandle || parsed.keepSession || parsed.noStream
      ? `Execute:\n${cliLine}`
      : [
          `Call pi_review with target=${JSON.stringify(target)}, mode=${JSON.stringify(parsed.mode)}, and any selected model/thinking values.`,
          "Treat target as a natural-language review request. Do not expand directory targets into multi-file lists.",
          "Follow the pi-review skill for remaining strategy matching (mode defaults, model choice, panel preset).",
        ].join(" ");

  return [
    parsed.continueHandle
      ? "Continue a prior pi-review session."
      : parsed.strategy === "loop"
        ? "Run a pi-review loop closeout for the target below."
        : "Run pi-review for the target below.",
    piHostRules(parsed.strategy),
    localeNote,
    strategyNote,
    modeBlock[parsed.mode] ??
      `Mode: ${parsed.mode}. Follow the preset named in review-presets.json when present.`,
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
];
