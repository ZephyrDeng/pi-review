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
] as const;

export const MODE_HINTS: Record<string, string> = {
  code: "Code / diff / MR review",
  plan: "Architecture or plan review",
  challenge: "Adversarial plan review",
};

export const FLAG_HINTS: Record<string, string> = {
  "--mode": "Review mode: code | plan | challenge",
  "--model": "provider/model[:thinking]",
  "--thinking": "off | minimal | low | medium | high | xhigh",
  "--keep-session": "Keep session for /rv --continue follow-up",
  "--no-stream": "Buffer output until exit (not default)",
  "--continue": "Resume an existing review session",
};

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

export interface CompletionDeps {
  models?: ModelInfo[];
  primaryProvider?: string;
  priorities?: ReviewModelPriorities;
  locale?: RvLocale;
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
  // Contiguous matching for model ids (subsequence is too loose for ids like
  // "claude-opus" which would match "ope" via o-p...-e).
  const q = tail;
  const filtered = items.filter((it) => {
    const label = it.label;
    return (
      label.startsWith(q) ||
      label.includes(q) ||
      // also allow matching by bare id / provider segment
      label.split("/")[1]?.startsWith(q) ||
      label.split("/")[0]?.startsWith(q)
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

function sceneTemplates(
  models: ModelInfo[],
  sig: ReviewSignals,
  headPrefix: string,
  tail: string,
  deps: CompletionDeps,
): AutocompleteItem[] {
  const priorities = getPriorities(deps);
  const codePrimary = primaryPresetForProfile(models, "code", priorities);
  const planPrimary = primaryPresetForProfile(models, "plan", priorities);
  const frontendPrimary = primaryPresetForProfile(models, "frontend", priorities);

  const ui = rvUi(localeOf(deps));
  const templates: { cmd: string; label: string }[] = [];
  if (codePrimary) {
    const m = codePrimary.model;
    templates.push({
      cmd: `${ui.modeCode} --model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "xhigh")} @`,
      label: ui.codePreset,
    });
  }
  if (frontendPrimary) {
    const m = frontendPrimary.model;
    templates.push({
      cmd: `${ui.modeCode} --model ${m.label}${thinkingSuffixForModel(m, frontendPrimary.thinking)} @`,
      label: ui.frontendPreset,
    });
  }
  if (planPrimary) {
    const m = planPrimary.model;
    templates.push({
      cmd: `${ui.modePlan} --model ${m.label}${thinkingSuffixForModel(m, planPrimary.thinking ?? "high")} @`,
      label: ui.planPreset,
    });
    templates.push({
      cmd: `${ui.modeChallenge} ${ui.keepSession} --model ${m.label}${thinkingSuffixForModel(m, "xhigh")} @`,
      label: ui.challengePreset,
    });
  }

  return templates
    .filter((t) => fuzzyMatch(t.label, tail) || t.cmd.includes(tail))
    .map((t) => ({
      value: `${headPrefix}${t.cmd}`,
      label: t.label,
      description: t.cmd,
    }));
}

function flagItems(head: string[], tail: string, headPrefix: string): AutocompleteItem[] | null {
  // Don't re-suggest boolean flags already present.
  const present = new Set(head);
  const candidates = filterList(RV_FLAGS, tail).filter((f) => {
    if (f === "--keep-session" || f === "--no-stream") return !present.has(f);
    return true;
  });
  return wrap(candidates, headPrefix, FLAG_HINTS);
}

function topLevelCompletions(
  head: string[],
  tail: string,
  deps: CompletionDeps,
  headPrefix: string,
  sig: ReviewSignals,
): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = [];

  // Scene templates (only at top level, before any target/mode chosen is fine).
  if (deps.models?.length) {
    items.push(...sceneTemplates(deps.models, sig, headPrefix, tail, deps));
  }

  items.push(...semanticCompletionItems(localeOf(deps), tail, headPrefix, head));

  const ui = rvUi(localeOf(deps));
  const hasListModelsItem = items.some((i) => i.label === ui.listModels);
  if (
    !hasListModelsItem &&
    (fuzzyMatch(ui.modelsKeyword, tail) ||
      ui.modelsKeyword.startsWith(tail) ||
      fuzzyMatch("models", tail))
  ) {
    items.push({
      value: `${headPrefix}${ui.listModels}`,
      label: ui.listModels,
      description: ui.listModelsDesc,
    });
  }

  if (tail.startsWith("--")) {
    const flags = flagItems(head, tail, headPrefix);
    if (flags) items.push(...flags);
  }

  return items.length ? items : null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildRvCompletions(
  prefix: string,
  deps: CompletionDeps,
): AutocompleteItem[] | null {
  const { head, rawHead, tail, prev } = tokenizeArgPrefix(prefix);
  const joinedHead = rawHead.join(" ");
  const headPrefix = joinedHead ? `${joinedHead} ` : "";
  const sig = extractSignals(head, deps);

  // 1) --model value position (model list or :thinking suffix).
  if (prev === "--model") {
    const colonIdx = tail.lastIndexOf(":");
    if (colonIdx !== -1 && tail.slice(0, colonIdx).includes("/")) {
      const items = thinkingSuffixItems(tail, deps.models ?? [], headPrefix, sig, deps);
      return items;
    }
    return modelItems(deps.models ?? [], sig, headPrefix, tail, deps);
  }

  // 2) --mode value position.
  if (prev === "--mode") {
    return wrap(filterList(RV_MODE_VALUES, tail), headPrefix, MODE_HINTS);
  }

  // 3) --thinking value position.
  if (prev === "--thinking") {
    return wrap(filterList(THINKING_LEVELS, tail), headPrefix);
  }

  // 4) --continue value position: defer (no static list; handler owns it).
  if (prev === "--continue") return null;

  // 5) Flag completion (tail starts with "--").
  if (tail.startsWith("--")) {
    return flagItems(head, tail, headPrefix);
  }

  // 6) File attachment in progress → defer to built-in file completion.
  if (tail.startsWith("@")) return null;

  // 7) Top-level: scene templates + `models` + flags.
  return topLevelCompletions(head, tail, deps, headPrefix, sig);
}
