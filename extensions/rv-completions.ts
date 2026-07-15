/**
 * Pure, testable /rv argument-completion logic.
 *
 * Avoids pi types so tokenizer + preset ordering can be unit-tested.
 * Completion `value` must include the typed head (pi-tui replaces the whole arg).
 */

import { type RvLocale, rvUi } from "./rv-locale.js";
import { semanticCompletionItems, SEMANTIC_PHRASES } from "./rv-semantic.js";
import {
  loadReviewModelPriorities,
  primaryPresetForProfile,
  rankModelsWithPresets,
  resolvePresetOrderedModels,
  resolveReviewProfile,
  type ReviewModelPriorities,
  type ReviewProfile,
} from "./rv-model-priorities.js";

export type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
};

export const RV_MODE_VALUES = ["code", "plan", "challenge"] as const;
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const RV_FLAGS = [
  "--mode",
  "--model",
  "--thinking",
  "--keep-session",
  "--no-stream",
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

export const MODE_HINTS: Record<string, string> = {
  code: "Code / diff / MR review",
  plan: "Architecture or plan review",
  challenge: "Adversarial plan review",
};

export const CONSENSUS_HINTS: Record<string, string> = {
  any: "Any single actionable reviewer confirms",
  quorum: "At least --min-agree reviewers (default 2)",
  majority: "floor(n/2)+1 reviewers",
  unanimous: "All reviewers must agree",
};

export const PANEL_PRESET_HINTS: Record<string, string> = {
  "code-experts": "correctness + security + testing (quorum 2)",
};

export const FLAG_HINTS: Record<string, string> = {
  "--mode": "Review mode: code | plan | challenge",
  "--model": "provider/model[:thinking] (short ids ok)",
  "--thinking": "off | minimal | low | medium | high | xhigh",
  "--keep-session": "Keep session for /rv --continue follow-up",
  "--no-stream": "Buffer output until exit (not default)",
  "--continue": "Resume an existing review session",
  "--max-rounds": "Loop hard budget: how many review gates (not reviewer count)",
  "--until": "Loop stop goal: clean",
  "--reviewers": "Panel width: independent reviewers per gate (1-8)",
  "--panel": "Named expert panel preset (cannot combine with --reviewers)",
  "--reviewer-model": "Per-reviewer model: pick rK= then model (repeatable)",
  "--consensus": "any | quorum | majority | unanimous",
  "--min-agree": "Quorum threshold (quorum only)",
  "--consensus-model": "Model for semantic adjudication only",
  "--concurrency": "Bound parallel reviewers (≤ reviewers)",
};

/** Infer reviewer ids available for --reviewer-model secondary menu. */
export function reviewerIdsForHead(head: string[]): string[] {
  const panelIdx = head.indexOf("--panel");
  if (panelIdx >= 0) {
    const name = head[panelIdx + 1];
    if (name === "code-experts") return ["correctness", "security", "testing"];
    // Unknown preset: still offer generic slots as a fallback.
  }
  const reviewersIdx = head.indexOf("--reviewers");
  if (reviewersIdx >= 0) {
    const n = Number(head[reviewersIdx + 1]);
    if (Number.isSafeInteger(n) && n >= 1 && n <= 8) {
      return Array.from({ length: n }, (_, i) => `r${i + 1}`);
    }
  }
  // Default panel path (/rv without width): code-experts style ids.
  return ["correctness", "security", "testing"];
}

function assignedReviewerIds(head: string[]): Set<string> {
  const assigned = new Set<string>();
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== "--reviewer-model") continue;
    const value = head[i + 1] ?? "";
    const eq = value.indexOf("=");
    if (eq > 0) assigned.add(value.slice(0, eq));
  }
  return assigned;
}

/** Minimal model metadata we need; converted from the host's Model registry. */
export interface ModelInfo {
  provider: string;
  id: string;
  /** `${provider}/${id}` */
  label: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  /** Lowercased thinking levels the model actually supports; empty if non-reasoning. */
  thinkingLevels: string[];
}

export interface ReviewSignals {
  mode: string;
  hasTarget: boolean;
  targetExt?: string;
  /** Provider of the host session's primary model, for cross-vendor bonus. */
  primaryProvider?: string;
}

export type CompletionStrategy = "panel" | "loop" | "models";

export interface CompletionDeps {
  models?: ModelInfo[];
  primaryProvider?: string;
  priorities?: ReviewModelPriorities;
  locale?: RvLocale;
  /** Slash-command strategy so completions stay relevant for /rv, /rv-loop, /rv-models. */
  strategy?: CompletionStrategy;
}

function localeOf(deps: CompletionDeps): RvLocale {
  return deps.locale ?? "en";
}

function modeFromSemanticHead(head: string[]): string | undefined {
  const joined = head.join(" ").toLowerCase();
  for (const row of SEMANTIC_PHRASES) {
    if (!row.apply.mode) continue;
    for (const p of row.phrases) {
      if (joined.includes(p.toLowerCase())) return row.apply.mode;
    }
  }
  return undefined;
}

function getPriorities(deps: CompletionDeps): ReviewModelPriorities {
  return deps.priorities ?? loadReviewModelPriorities();
}

export function reviewProfileForSignals(sig: ReviewSignals): ReviewProfile {
  return resolveReviewProfile(sig.mode, sig.targetExt);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export interface TokenizedArgs {
  /** Fully typed tokens before the in-progress tail. */
  head: string[];
  /** Raw head tokens (quotes preserved) for safe reconstruction. */
  rawHead: string[];
  /** The token currently being typed (may be ""). */
  tail: string;
  /** Last token of `head`, or null. Used to detect value-position flags. */
  prev: string | null;
}

const TOKEN_RE = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;

export function tokenizeArgPrefix(prefix: string): TokenizedArgs {
  const lastSpace = prefix.lastIndexOf(" ");
  if (lastSpace === -1) {
    return { head: [], rawHead: [], tail: prefix, prev: null };
  }
  const headRaw = prefix.slice(0, lastSpace);
  const tail = prefix.slice(lastSpace + 1);
  const matches = headRaw.match(TOKEN_RE) ?? [];
  const rawHead = matches.slice();
  const head = matches.map((t) => t.replace(/^['"]|['"]$/g, ""));
  const prev = head.length > 0 ? head[head.length - 1] : null;
  return { head, rawHead, tail, prev };
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------


function extOf(token: string): string | undefined {
  const cleaned = token.replace(/^['"]|['"]$/g, "").replace(/^@/, "");
  const m = cleaned.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : undefined;
}

export function extractSignals(head: string[], deps: CompletionDeps): ReviewSignals {
  const target = head.find((t) => t.startsWith("@"));
  const modeIdx = head.indexOf("--mode");
  const mode =
    (modeIdx >= 0 ? head[modeIdx + 1] : undefined) ?? modeFromSemanticHead(head) ?? "code";
  return {
    mode,
    hasTarget: Boolean(target),
    targetExt: target ? extOf(target) : undefined,
    primaryProvider: deps.primaryProvider,
  };
}

// ---------------------------------------------------------------------------
// Model ordering: registry + preset priorities (no LLM)
// ---------------------------------------------------------------------------

export function rankModelsForReview(
  models: ModelInfo[],
  sig: ReviewSignals,
  priorities?: ReviewModelPriorities,
): ModelInfo[] {
  const profile = reviewProfileForSignals(sig);
  return rankModelsWithPresets(models, profile, priorities ?? loadReviewModelPriorities());
}

function presetDescription(
  presetLabel: string,
  profile: ReviewProfile,
  presetRank: number | undefined,
  locale: RvLocale,
): string {
  if (presetRank === undefined) return "";
  const ui = rvUi(locale);
  return `${ui.presetTier(presetRank)} · ${profile} · ${presetLabel}`;
}

// ---------------------------------------------------------------------------
// Fuzzy filtering (subsequence match, case-insensitive)
// ---------------------------------------------------------------------------

export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

function filterList(list: readonly string[], query: string): string[] {
  if (!query) return [...list];
  const prefixed = list.filter((item) => item.startsWith(query));
  if (prefixed.length) return prefixed;
  // Only fall back to subsequence matching when nothing starts with the query.
  return list.filter((item) => fuzzyMatch(item, query));
}

function uniqueFlat(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const v of list) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Completion builders
// ---------------------------------------------------------------------------

function wrap(
  candidates: string[],
  headPrefix: string,
  hints?: Record<string, string>,
): AutocompleteItem[] | null {
  if (candidates.length === 0) return null;
  return candidates.map((c) => ({
    value: `${headPrefix}${c}`,
    label: c,
    description: hints?.[c],
  }));
}

function thinkingDescription(level: string, sig: ReviewSignals, locale: RvLocale): string {
  const recommended = sig.mode === "code" ? "high" : "xhigh";
  const star = level === recommended ? rvUi(locale).thinkingSuggested : "";
  const map: Record<string, string> = {
    off: "No thinking (fastest)",
    minimal: "Minimal thinking",
    low: "Low effort",
    medium: "Medium effort",
    high: "High effort (common for review)",
    xhigh: "Max effort (plan/challenge)",
  };
  return `${star}${map[level] ?? level}`;
}

function contextLabel(ctx: number): string {
  if (ctx >= 1_000_000) return "1M+ ctx";
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k ctx`;
  return `${ctx} ctx`;
}

function modelItems(
  models: ModelInfo[],
  sig: ReviewSignals,
  headPrefix: string,
  tail: string,
  deps: CompletionDeps,
): AutocompleteItem[] | null {
  const priorities = getPriorities(deps);
  const profile = reviewProfileForSignals(sig);
  const presetRows = resolvePresetOrderedModels(models, profile, priorities);
  const presetByLabel = new Map(presetRows.map((p) => [p.model.label, p]));
  const ranked = rankModelsWithPresets(models, profile, priorities);
  const items = ranked.map((m) => {
    const preset = presetByLabel.get(m.label);
    const tag = profile;
    return {
      value: `${headPrefix}${m.label}`,
      label: m.label,
      description: [
        preset ? presetDescription(preset.presetLabel, profile, preset.presetRank, localeOf(deps)) : "",
        tag,
        m.reasoning ? "reasoning" : "",
        contextLabel(m.contextWindow),
        preset?.thinking ? `preset thinking ${preset.thinking}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
  // Contiguous + separator-insensitive matching for human short names
  // (gpt55 / gpt-5.5 / openai/gpt-5.5). Avoid raw subsequence matching.
  const q = tail.toLowerCase();
  const qKey = q.replace(/[^a-z0-9/]+/g, "");
  const filtered = items.filter((it) => {
    const label = it.label.toLowerCase();
    const labelKey = label.replace(/[^a-z0-9/]+/g, "");
    const id = label.split("/")[1] ?? "";
    const provider = label.split("/")[0] ?? "";
    const idKey = id.replace(/[^a-z0-9]+/g, "");
    return (
      label.startsWith(q) ||
      label.includes(q) ||
      id.startsWith(q) ||
      provider.startsWith(q) ||
      labelKey.includes(qKey) ||
      idKey.includes(qKey.replace(/\//g, ""))
    );
  });
  return filtered.length ? filtered : null;
}

function thinkingSuffixItems(
  tail: string,
  models: ModelInfo[],
  headPrefix: string,
  sig: ReviewSignals,
  deps: CompletionDeps,
): AutocompleteItem[] | null {
  const colonIdx = tail.lastIndexOf(":");
  const modelPart = tail.slice(0, colonIdx);
  const levelPart = tail.slice(colonIdx + 1);
  if (!modelPart.includes("/")) return null;

  const exact = models.filter((m) => m.label === modelPart);
  const pool = exact.length
    ? exact
    : models.filter((m) => m.label.startsWith(modelPart) || m.id.startsWith(modelPart));
  if (pool.length === 0) return null;

  const levels = uniqueFlat(pool.map((m) => m.thinkingLevels));
  const filtered = filterList(levels, levelPart);
  if (filtered.length === 0) return null;
  return filtered.map((level) => ({
    value: `${headPrefix}${modelPart}:${level}`,
    label: level,
    description: thinkingDescription(level, sig, localeOf(deps)),
  }));
}

function thinkingSuffixForModel(m: ModelInfo, want?: string): string {
  const lvl =
    want && m.thinkingLevels.includes(want)
      ? want
      : want && m.thinkingLevels.includes("high")
        ? "high"
        : m.thinkingLevels.includes("xhigh")
          ? "xhigh"
          : m.thinkingLevels.includes("high")
            ? "high"
            : (m.thinkingLevels[0] ?? "");
  return lvl ? `:${lvl}` : "";
}

/** Presets are opt-in to avoid drowning flag/model completions. */
export function wantsPresetCompletions(tail: string): boolean {
  const q = tail.trim().toLowerCase();
  if (!q) return false;
  return /^(preset|模板|预设|推荐|code|plan|front|challenge|代码|方案|前端|对抗|loop|关单)/i.test(q)
    || /preset|模板|预设|推荐|code review|plan review|frontend|challenge|代码审核|方案审核|前端|对抗|关单/i.test(q);
}

function sceneTemplates(
  models: ModelInfo[],
  sig: ReviewSignals,
  headPrefix: string,
  tail: string,
  deps: CompletionDeps,
): AutocompleteItem[] {
  // Empty top-level should stay quiet: flags + model typing first.
  if (!wantsPresetCompletions(tail)) return [];

  const priorities = getPriorities(deps);
  const codePrimary = primaryPresetForProfile(models, "code", priorities);
  const planPrimary = primaryPresetForProfile(models, "plan", priorities);
  const frontendPrimary = primaryPresetForProfile(models, "frontend", priorities);
  const strategy = deps.strategy ?? "panel";
  const ui = rvUi(localeOf(deps));
  const templates: { cmd: string; label: string; description?: string }[] = [];

  if (strategy === "models") {
    return [{
      value: `${headPrefix}${tail}`,
      label: ui.listModels,
      description: ui.listModelsDesc,
    }].filter((t) => !tail || fuzzyMatch(t.label, tail) || fuzzyMatch("models", tail));
  }

  if (strategy === "loop") {
    if (codePrimary) {
      const m = codePrimary.model;
      const cmd1 = `--model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "high")} @src`;
      templates.push({
        cmd: cmd1,
        label: ui.loopCodePreset,
        description: `${ui.loopCodeDesc} · ${cmd1}`,
      });
      const cmd2 = `--max-rounds 2 --model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "high")} fix until clean @src`;
      templates.push({
        cmd: cmd2,
        label: ui.loopTwoRounds,
        description: cmd2,
      });
    }
    if (planPrimary) {
      const m = planPrimary.model;
      const cmd = `--mode plan --model ${m.label}${thinkingSuffixForModel(m, planPrimary.thinking ?? "high")} @docs`;
      templates.push({
        cmd,
        label: ui.loopPlanPreset,
        description: cmd,
      });
    }
  } else {
    if (codePrimary) {
      const m = codePrimary.model;
      const cmd = `--model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "xhigh")} @src`;
      templates.push({ cmd, label: ui.codePreset, description: cmd });
    }
    if (frontendPrimary) {
      const m = frontendPrimary.model;
      const cmd = `--model ${m.label}${thinkingSuffixForModel(m, frontendPrimary.thinking)} @src`;
      templates.push({ cmd, label: ui.frontendPreset, description: cmd });
    }
    if (planPrimary) {
      const m = planPrimary.model;
      const planCmd = `--mode plan --model ${m.label}${thinkingSuffixForModel(m, planPrimary.thinking ?? "high")} @docs`;
      templates.push({ cmd: planCmd, label: ui.planPreset, description: planCmd });
      const challengeCmd = `--mode challenge --keep-session --model ${m.label}${thinkingSuffixForModel(m, "xhigh")} @docs`;
      templates.push({ cmd: challengeCmd, label: ui.challengePreset, description: challengeCmd });
    }
  }

  return templates
    .filter((t) => {
      const q = tail.trim().toLowerCase();
      if (!q || q === "preset" || q === "预设" || q === "模板" || q === "推荐") return true;
      return fuzzyMatch(t.label, tail) || t.cmd.toLowerCase().includes(q) || fuzzyMatch(t.description ?? "", tail);
    })
    .map((t) => ({
      value: `${headPrefix}${t.cmd}`,
      label: t.label,
      // Put the full command in description so the TUI shows what will be inserted.
      description: t.description ?? t.cmd,
    }));
}

function flagItems(
  head: string[],
  tail: string,
  headPrefix: string,
  strategy: CompletionStrategy = "panel",
): AutocompleteItem[] | null {
  // Don't re-suggest boolean flags already present.
  const present = new Set(head);
  const hasReviewers = head.includes("--reviewers");
  const hasPanel = head.includes("--panel");
  const allowed = RV_FLAGS.filter((f) => {
    if (strategy === "models") return false;
    if (strategy === "loop") {
      // Loop rejects keep-session / continue; max-rounds is loop-only.
      if (f === "--keep-session" || f === "--continue") return false;
      return true;
    }
    // Panel strategy (/rv): no loop-only flags (single gate).
    if (f === "--max-rounds" || f === "--until") return false;
    return true;
  }).filter((f) => {
    // Mutually exclusive panel selectors.
    if (f === "--reviewers" && hasPanel) return false;
    if (f === "--panel" && hasReviewers) return false;
    return true;
  });
  const candidates = filterList(allowed, tail).filter((f) => {
    if (f === "--keep-session" || f === "--no-stream") return !present.has(f);
    // Value flags: hide if already present once.
    if ([
      "--mode", "--model", "--thinking", "--continue", "--max-rounds", "--until",
      "--reviewers", "--panel", "--consensus", "--min-agree", "--consensus-model", "--concurrency",
    ].includes(f) && present.has(f)) return false;
    // --reviewer-model is repeatable; keep offering until every reviewer id is assigned.
    if (f === "--reviewer-model") {
      const ids = reviewerIdsForHead(head);
      const assigned = assignedReviewerIds(head);
      if (ids.length > 0 && ids.every((id) => assigned.has(id))) return false;
    }
    return true;
  });
  return wrap(candidates, headPrefix, FLAG_HINTS);
}

function reviewerModelCompletions(
  head: string[],
  tail: string,
  headPrefix: string,
  deps: CompletionDeps,
  sig: ReviewSignals,
): AutocompleteItem[] | null {
  const ids = reviewerIdsForHead(head);
  const assigned = assignedReviewerIds(head);
  const eq = tail.indexOf("=");

  // Secondary menu stage 1: pick reviewer id → inserts `id=`
  if (eq === -1) {
    const open = ids.filter((id) => !assigned.has(id) || tail.startsWith(id));
    const filtered = filterList(open.length ? open : ids, tail);
    if (!filtered.length) return null;
    return filtered.map((id) => ({
      value: `${headPrefix}${id}=`,
      label: `${id}=`,
      description: localeOf(deps) === "zh"
        ? `为 ${id} 选择模型（下一级）`
        : `Choose model for ${id} (next step)`,
    }));
  }

  // Secondary menu stage 2: after `id=`, offer catalog models.
  const reviewerId = tail.slice(0, eq);
  const modelQuery = tail.slice(eq + 1);
  const models = deps.models ?? [];
  if (!models.length) {
    // Still help shape the token when registry is cold.
    if (!modelQuery) {
      return [{
        value: `${headPrefix}${reviewerId}=`,
        label: `${reviewerId}=<model>`,
        description: localeOf(deps) === "zh" ? "输入 provider/model 或短名" : "Type provider/model or short id",
      }];
    }
    return [{
      value: `${headPrefix}${reviewerId}=${modelQuery}`,
      label: `${reviewerId}=${modelQuery}`,
      description: localeOf(deps) === "zh" ? "使用输入的模型 token" : "Use typed model token",
    }];
  }
  const ranked = modelItems(models, sig, "", modelQuery, deps) ?? [];
  if (!ranked.length) return null;
  return ranked.map((item) => ({
    value: `${headPrefix}${reviewerId}=${item.label}`,
    label: `${reviewerId}=${item.label}`,
    description: item.description,
  }));
}

function looksLikeModelQuery(tail: string, models: ModelInfo[] = []): boolean {
  if (!tail || tail.startsWith("-") || tail.startsWith("@")) return false;
  // provider/model, bare id fragments, or model:thinking
  if (tail.includes("/") || tail.includes(":")) return true;
  if (/^(gpt|claude|kimi|glm|opus|sonnet|deepseek|minimax|o[0-9]|gemini|openai|anthropic|codex|zenmux|moonshot|px)/i.test(tail)) {
    return true;
  }
  // Match against live catalog providers / ids so short provider names complete.
  const q = tail.toLowerCase();
  if (q.length >= 2 && models.some((m) => m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))) {
    return true;
  }
  // short alphanumeric model-ish tokens (gpt55, kimi-k2)
  return /^[a-z0-9][a-z0-9._-]{1,}$/i.test(tail) && /[0-9]|gpt|claude|kimi|glm|opus|sonnet/i.test(tail);
}

function topLevelCompletions(
  head: string[],
  rawHead: string[],
  tail: string,
  deps: CompletionDeps,
  headPrefix: string,
  sig: ReviewSignals,
): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = [];
  const strategy = deps.strategy ?? "panel";
  const ui = rvUi(localeOf(deps));

  if (strategy === "models") {
    // /rv-models takes no target; only remind the user.
    if (!tail || fuzzyMatch(ui.listModels, tail) || fuzzyMatch("models", tail)) {
      items.push({ value: `${headPrefix}${tail}`, label: ui.listModels, description: ui.listModelsDesc });
    }
    return items.length ? items : null;
  }

  // After completing options, make the target boundary explicit. This lets a
  // Tab-first flow safely append natural language without a value-taking flag
  // accidentally consuming it.
  if (!tail && !head.includes("--") && head.some((token) => token.startsWith("--"))) {
    const zh = localeOf(deps) === "zh";
    items.push({
      value: `${headPrefix}-- `,
      label: zh ? "开始输入审查目标" : "Start review target",
      description: zh
        ? "参数已结束，接下来输入自然语言或 @路径"
        : "Finish options, then type natural language or @path",
    });
  }

  // Quiet empty top-level: interactive wizard first, then a few flags.
  if (!tail) {
    const zh = localeOf(deps) === "zh";
    items.push({
      value: `${headPrefix}-i`,
      label: zh ? "-i · 交互向导（推荐）" : "-i · interactive wizard (recommended)",
      description: zh
        ? "对话框选择人数、模型、思考强度 — 不用 Tab"
        : "Dialog picker for reviewers, models, thinking — no tab",
    });
    const flags = flagItems(head, "--", headPrefix, strategy) ?? [];
    items.push(...flags.slice(0, 5));
    items.push({
      value: headPrefix,
      label: ui.presetHint,
      description: localeOf(deps) === "zh" ? "需要模板时再输入「预设」" : "Type preset when you want templates",
    });
    return items.length ? items : null;
  }

  // Opt-in scene templates only.
  if (deps.models?.length) {
    items.push(...sceneTemplates(deps.models, sig, headPrefix, tail, deps));
  }

  // Panel keeps semantic phrases when the user is typing mode-ish text.
  if (strategy === "panel" && !looksLikeModelQuery(tail, deps.models ?? [])) {
    items.push(...semanticCompletionItems(localeOf(deps), tail, headPrefix, head, rawHead));
    const hasListModelsItem = items.some((i) => i.label === ui.listModels);
    if (
      !hasListModelsItem &&
      (fuzzyMatch(ui.modelsKeyword, tail) ||
        ui.modelsKeyword.startsWith(tail) ||
        fuzzyMatch("models", tail) ||
        fuzzyMatch(ui.listModels, tail))
    ) {
      items.push({
        value: `${headPrefix}${ui.listModels}`,
        label: ui.listModels,
        description: ui.listModelsDesc,
      });
    }
  }

  // Bare model typing: `/rv-loop gpt-5.5` / `/rv openai-codex/gpt-5.5`
  // Also support `/rv openai-codex/gpt-5.5:` thinking suffixes without requiring --model first.
  if (deps.models?.length && looksLikeModelQuery(tail, deps.models)) {
    const colonIdx = tail.lastIndexOf(":");
    if (colonIdx !== -1 && tail.slice(0, colonIdx).includes("/")) {
      const thinking = thinkingSuffixItems(tail, deps.models, `${headPrefix}--model `, sig, deps);
      if (thinking?.length) items.unshift(...thinking);
    } else {
      const modelMatches = modelItems(deps.models, sig, `${headPrefix}--model `, tail, deps);
      if (modelMatches?.length) {
        // Prefer inserting as --model <id> so the parser/resolver gets a clean flag.
        items.unshift(
          ...modelMatches.map((item) => ({
            ...item,
            description: [item.description, strategy === "loop" ? "loop model" : "panel model"].filter(Boolean).join(" · "),
          })),
        );
        // If the user already typed an exact catalog id, also offer thinking suffixes.
        const exact = deps.models.find((m) => m.label === tail || m.id === tail);
        if (exact?.thinkingLevels?.length) {
          for (const level of exact.thinkingLevels) {
            items.unshift({
              value: `${headPrefix}--model ${exact.label}:${level}`,
              label: `${exact.label}:${level}`,
              description: thinkingDescription(level, sig, localeOf(deps)),
            });
          }
        }
      }
    }
  } else if (!deps.models?.length && looksLikeModelQuery(tail)) {
    // Registry-cold fallback: preserve every already-entered argument while
    // wrapping the typed token as --model. Pi replaces the whole arg string.
    items.unshift({
      value: `${headPrefix}--model ${tail}`,
      label: `--model ${tail}`,
      description: localeOf(deps) === "zh"
        ? "模型目录尚未加载；保留现有目标并在执行时解析"
        : "Catalog not loaded; preserve target and resolve at execution",
    });
  }

  if (tail.startsWith("--")) {
    const flags = flagItems(head, tail, headPrefix, strategy);
    if (flags) items.push(...flags);
  }

  return items.length ? items : null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function interactiveTriggerCompletions(
  tail: string,
  headPrefix: string,
  strategy: CompletionStrategy,
  locale: RvLocale,
): AutocompleteItem[] | null {
  const q = tail.trim().toLowerCase();
  // Only intercept pure interactive triggers, not unrelated flags like --input.
  if (!q || !(/^(-i|--i|--in|--int|--inter|--interactive|interactive|i)$/i.test(q) || q === "-")) {
    // Allow "-i" / "--interactive" / "interactive" prefixes while typing.
    if (!/^(interactive|--interactive|-i)/i.test(q) && q !== "-") return null;
  }
  if (q.startsWith("--") && !q.startsWith("--i") && !q.startsWith("--interactive")) return null;
  if (q.startsWith("-") && q !== "-" && !q.startsWith("-i") && !q.startsWith("--")) return null;

  const zh = locale === "zh";
  const label = zh ? "交互向导（对话框选模型）" : "Interactive wizard (dialog model picker)";
  const description = strategy === "loop"
    ? (zh ? "方向键选择 reviewer / 模型，无需 Tab 补全" : "Arrow-key pick reviewers & models; no tab completion")
    : (zh ? "方向键配置 panel 审查" : "Arrow-key configure panel review");
  return [{
    value: `${headPrefix}-i`,
    label: `-i · ${label}`,
    description,
  }, {
    value: `${headPrefix}--interactive`,
    label: `--interactive · ${label}`,
    description,
  }];
}

export function buildRvCompletions(
  prefix: string,
  deps: CompletionDeps,
): AutocompleteItem[] | null {
  const { head, rawHead, tail, prev } = tokenizeArgPrefix(prefix);
  const joinedHead = rawHead.join(" ");
  const headPrefix = joinedHead ? `${joinedHead} ` : "";
  const sig = extractSignals(head, deps);
  const strategy = deps.strategy ?? "panel";

  // 0) Interactive wizard triggers — do not fall through to the flag soup.
  if (!prev && strategy !== "models") {
    const interactive = interactiveTriggerCompletions(tail, headPrefix, strategy, localeOf(deps));
    if (interactive) return interactive;
  }

  // 1) --model value position (model list or :thinking suffix).
  if (prev === "--model") {
    const models = deps.models ?? [];
    if (models.length === 0) {
      return [{
        value: `${headPrefix}${tail}`,
        label: tail || "<provider/model>",
        description: localeOf(deps) === "zh"
          ? "模型目录尚未加载；继续输入 provider/model 或短名"
          : "Catalog not loaded; type provider/model or short id",
      }];
    }
    const colonIdx = tail.lastIndexOf(":");
    if (colonIdx !== -1 && tail.slice(0, colonIdx).includes("/")) {
      const items = thinkingSuffixItems(tail, models, headPrefix, sig, deps);
      return items;
    }
    return modelItems(models, sig, headPrefix, tail, deps);
  }

  // 2) --mode value position.
  if (prev === "--mode") {
    return wrap(filterList(RV_MODE_VALUES, tail), headPrefix, MODE_HINTS);
  }

  // 3) --thinking value position.
  if (prev === "--thinking") {
    return wrap(filterList(THINKING_LEVELS, tail), headPrefix);
  }

  // 4) --max-rounds value position (loop only).
  if (prev === "--max-rounds") {
    if (strategy !== "loop") return null;
    const rounds = ["1", "2", "3"];
    return wrap(filterList(rounds, tail), headPrefix, {
      "1": "One gate, then host fix point",
      "2": "Two review gates",
      "3": "Three review gates",
    });
  }

  // 4b) --until value position (loop only).
  if (prev === "--until") {
    if (strategy !== "loop") return null;
    return wrap(filterList(["clean"], tail), headPrefix, {
      clean: "Stop only when the clean gate is met (hard-capped by --max-rounds)",
    });
  }

  // 5) --reviewers value position (panel width per gate).
  if (prev === "--reviewers") {
    const counts = ["2", "3", "4", "5"];
    return wrap(filterList(counts, tail), headPrefix, {
      "2": "Two independent reviewers · then set --reviewer-model r1=…",
      "3": "Three independent reviewers · then set --reviewer-model r1=…",
      "4": "Four independent reviewers",
      "5": "Five independent reviewers",
    });
  }

  // 5b) --reviewer-model cascading menu: id= then model list.
  if (prev === "--reviewer-model") {
    return reviewerModelCompletions(head, tail, headPrefix, deps, sig);
  }

  // 6) --panel value position.
  if (prev === "--panel") {
    return wrap(filterList(Object.keys(PANEL_PRESET_HINTS), tail), headPrefix, PANEL_PRESET_HINTS);
  }

  // 7) --consensus value position.
  if (prev === "--consensus") {
    return wrap(filterList(Object.keys(CONSENSUS_HINTS), tail), headPrefix, CONSENSUS_HINTS);
  }

  // 8) --min-agree value position.
  if (prev === "--min-agree") {
    return wrap(filterList(["2", "3", "4"], tail), headPrefix, {
      "2": "Default quorum threshold",
      "3": "Stricter quorum",
      "4": "Very strict quorum",
    });
  }

  // 9) --concurrency value position.
  if (prev === "--concurrency") {
    return wrap(filterList(["1", "2", "3", "4"], tail), headPrefix, {
      "1": "Serial reviewers",
      "2": "Up to 2 in parallel",
      "3": "Up to 3 in parallel",
      "4": "Up to 4 in parallel",
    });
  }

  // 10) --consensus-model value position: reuse model list when available.
  if (prev === "--consensus-model") {
    const models = deps.models ?? [];
    if (models.length === 0) {
      return [{
        value: `${headPrefix}${tail}`,
        label: tail || "<provider/model>",
        description: "Catalog not loaded; type provider/model or short id",
      }];
    }
    return modelItems(models, sig, headPrefix, tail, deps);
  }

  // 11) --continue value position: defer (no static list; handler owns it).
  if (prev === "--continue") return null;

  // 6) Flag completion (tail starts with "--").
  if (tail.startsWith("--")) {
    return flagItems(head, tail, headPrefix, strategy);
  }

  // 7) File attachment in progress → defer to built-in file completion.
  if (tail.startsWith("@")) return null;

  // 8) Top-level: strategy-aware templates + bare model hints + flags.
  return topLevelCompletions(head, rawHead, tail, deps, headPrefix, sig);
}
