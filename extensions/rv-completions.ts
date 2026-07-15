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
] as const;

export const MODE_HINTS: Record<string, string> = {
  code: "Code / diff / MR review",
  plan: "Architecture or plan review",
  challenge: "Adversarial plan review",
};

export const FLAG_HINTS: Record<string, string> = {
  "--mode": "Review mode: code | plan | challenge",
  "--model": "provider/model[:thinking] (short ids ok)",
  "--thinking": "off | minimal | low | medium | high | xhigh",
  "--keep-session": "Keep session for /rv --continue follow-up",
  "--no-stream": "Buffer output until exit (not default)",
  "--continue": "Resume an existing review session",
  "--max-rounds": "Loop budget ( /rv-loop only )",
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
  const strategy = deps.strategy ?? "panel";

  const ui = rvUi(localeOf(deps));
  const templates: { cmd: string; label: string; description?: string }[] = [];

  if (strategy === "models") {
    return [{
      value: headPrefix.trimEnd(),
      label: ui.listModels,
      description: ui.listModelsDesc,
    }].filter((t) => !tail || fuzzyMatch(t.label, tail) || fuzzyMatch("models", tail));
  }

  if (strategy === "loop") {
    if (codePrimary) {
      const m = codePrimary.model;
      templates.push({
        cmd: `--model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "high")} @src`,
        label: localeOf(deps) === "zh" ? "Loop 关单（代码）" : "Loop closeout (code)",
        description: localeOf(deps) === "zh" ? "宿主修 → 再审，直到 clean" : "Host fixes, re-review until clean",
      });
      templates.push({
        cmd: `--max-rounds 2 --model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "high")} fix until clean @src`,
        label: localeOf(deps) === "zh" ? "Loop 两轮关单" : "Loop closeout (2 rounds)",
      });
    }
    if (planPrimary) {
      const m = planPrimary.model;
      templates.push({
        cmd: `--mode plan --model ${m.label}${thinkingSuffixForModel(m, planPrimary.thinking ?? "high")} @docs`,
        label: localeOf(deps) === "zh" ? "Loop 关单（方案）" : "Loop closeout (plan)",
      });
    }
  } else {
    if (codePrimary) {
      const m = codePrimary.model;
      templates.push({
        cmd: `--model ${m.label}${thinkingSuffixForModel(m, codePrimary.thinking ?? "xhigh")} @src`,
        label: ui.codePreset,
        description: localeOf(deps) === "zh" ? "Panel 代码审查预设" : "Panel code review preset",
      });
    }
    if (frontendPrimary) {
      const m = frontendPrimary.model;
      templates.push({
        cmd: `--model ${m.label}${thinkingSuffixForModel(m, frontendPrimary.thinking)} @src`,
        label: ui.frontendPreset,
        description: localeOf(deps) === "zh" ? "Panel 前端/多模态预设" : "Panel frontend / multimodal preset",
      });
    }
    if (planPrimary) {
      const m = planPrimary.model;
      templates.push({
        cmd: `--mode plan --model ${m.label}${thinkingSuffixForModel(m, planPrimary.thinking ?? "high")} @docs`,
        label: ui.planPreset,
        description: localeOf(deps) === "zh" ? "Panel 方案审查预设" : "Panel plan review preset",
      });
      templates.push({
        cmd: `--mode challenge --keep-session --model ${m.label}${thinkingSuffixForModel(m, "xhigh")} @docs`,
        label: ui.challengePreset,
        description: localeOf(deps) === "zh" ? "Panel 对抗审查（可追问）" : "Panel challenge review (keep session)",
      });
    }
  }

  return templates
    .filter((t) => !tail || fuzzyMatch(t.label, tail) || t.cmd.includes(tail))
    .map((t) => ({
      value: `${headPrefix}${t.cmd}`,
      label: t.label,
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
  const allowed = RV_FLAGS.filter((f) => {
    if (strategy === "loop") {
      // Loop rejects keep-session / continue; max-rounds is loop-only.
      if (f === "--keep-session" || f === "--continue") return false;
      return true;
    }
    if (strategy === "models") return false;
    if (f === "--max-rounds") return false;
    return true;
  });
  const candidates = filterList(allowed, tail).filter((f) => {
    if (f === "--keep-session" || f === "--no-stream") return !present.has(f);
    return true;
  });
  return wrap(candidates, headPrefix, FLAG_HINTS);
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
  if (models.some((m) => m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))) {
    return true;
  }
  // short alphanumeric model-ish tokens (gpt55, kimi-k2)
  return /^[a-z0-9][a-z0-9._-]{1,}$/i.test(tail) && /[0-9]|gpt|claude|kimi|glm|opus|sonnet/i.test(tail);
}

function topLevelCompletions(
  head: string[],
  tail: string,
  deps: CompletionDeps,
  headPrefix: string,
  sig: ReviewSignals,
): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = [];
  const strategy = deps.strategy ?? "panel";

  if (strategy === "models") {
    // /rv-models takes no target; only remind the user.
    const ui = rvUi(localeOf(deps));
    if (!tail || fuzzyMatch(ui.listModels, tail) || fuzzyMatch("models", tail)) {
      items.push({ value: "", label: ui.listModels, description: `${ui.listModelsDesc} · no args needed` });
    }
    return items.length ? items : null;
  }

  // Scene templates for the active strategy.
  if (deps.models?.length) {
    items.push(...sceneTemplates(deps.models, sig, headPrefix, tail, deps));
  }

  // Panel keeps semantic phrases; loop only needs mode-ish phrases lightly.
  if (strategy === "panel") {
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

export function buildRvCompletions(
  prefix: string,
  deps: CompletionDeps,
): AutocompleteItem[] | null {
  const { head, rawHead, tail, prev } = tokenizeArgPrefix(prefix);
  const joinedHead = rawHead.join(" ");
  const headPrefix = joinedHead ? `${joinedHead} ` : "";
  const sig = extractSignals(head, deps);
  const strategy = deps.strategy ?? "panel";

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

  // 5) --continue value position: defer (no static list; handler owns it).
  if (prev === "--continue") return null;

  // 6) Flag completion (tail starts with "--").
  if (tail.startsWith("--")) {
    return flagItems(head, tail, headPrefix, strategy);
  }

  // 7) File attachment in progress → defer to built-in file completion.
  if (tail.startsWith("@")) return null;

  // 8) Top-level: strategy-aware templates + bare model hints + flags.
  return topLevelCompletions(head, tail, deps, headPrefix, sig);
}
