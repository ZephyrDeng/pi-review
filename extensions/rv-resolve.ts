/**
 * Human-friendly model / thinking resolution against a live Pi catalog.
 * Pure and testable: completion and /rv execution share the same rules.
 */

import type { ModelInfo } from "./rv-completions.js";
import { THINKING_LEVELS } from "./rv-completions.js";
import type { RvParsed } from "./rv-prompts.js";

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_ALIASES: Record<string, ThinkingLevel> = {
  off: "off",
  none: "off",
  "0": "off",
  false: "off",
  关闭: "off",
  无: "off",
  快: "off",
  fast: "off",
  minimal: "minimal",
  min: "minimal",
  最低: "minimal",
  low: "low",
  低: "low",
  medium: "medium",
  mid: "medium",
  med: "medium",
  中: "medium",
  中等: "medium",
  high: "high",
  高: "high",
  高思考: "high",
  xhigh: "xhigh",
  max: "xhigh",
  maximum: "xhigh",
  ultra: "xhigh",
  最高: "xhigh",
  最强: "xhigh",
  满思考: "xhigh",
};

/** Collapse separators so gpt5.5 / gpt_5_5 / GPT-5.5 share one key. Keep `/` for provider splits. */
export function normalizeModelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[^a-z0-9/]+/g, "")
    .replace(/\/+/g, "/");
}

export function canonicalizeThinking(raw: string | undefined): ThinkingLevel | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(key)) return key as ThinkingLevel;
  return THINKING_ALIASES[key] ?? THINKING_ALIASES[raw.trim()];
}

export type ThinkingResolve =
  | { status: "exact"; level: ThinkingLevel }
  | { status: "alias"; level: ThinkingLevel; from: string }
  | { status: "fallback"; level: ThinkingLevel; from: string; reason: string }
  | { status: "unsupported"; from: string; supported: string[] }
  | { status: "none" };

/** Map a user thinking token onto levels the model actually supports. */
export function resolveThinking(
  raw: string | undefined,
  supported: string[] = [...THINKING_LEVELS],
): ThinkingResolve {
  if (!raw?.trim()) return { status: "none" };
  const canonical = canonicalizeThinking(raw);
  if (!canonical) return { status: "none" };
  const levels = supported.length ? supported : [...THINKING_LEVELS];
  if (levels.includes(canonical)) {
    const rawIsCanonical = (THINKING_LEVELS as readonly string[]).includes(raw.trim().toLowerCase());
    return rawIsCanonical
      ? { status: "exact", level: canonical }
      : { status: "alias", level: canonical, from: raw };
  }
  const order = [...THINKING_LEVELS];
  const start = order.indexOf(canonical);
  for (let i = start; i >= 0; i--) {
    const level = order[i]!;
    if (levels.includes(level)) {
      return { status: "fallback", level, from: raw, reason: `${canonical} unsupported; using ${level}` };
    }
  }
  for (const level of order) {
    if (levels.includes(level)) {
      return { status: "fallback", level, from: raw, reason: `${canonical} unsupported; using ${level}` };
    }
  }
  return { status: "unsupported", from: raw, supported: levels };
}

export type ModelResolve =
  | { status: "exact"; model: ModelInfo; query: string }
  | { status: "unique"; model: ModelInfo; query: string; reason: string }
  | { status: "ambiguous"; query: string; candidates: ModelInfo[] }
  | { status: "none"; query: string };

function splitProviderModel(query: string): { provider?: string; id: string } {
  const cleaned = query.replace(/:.*$/, "").trim();
  const slash = cleaned.indexOf("/");
  if (slash === -1) return { id: cleaned };
  return { provider: cleaned.slice(0, slash), id: cleaned.slice(slash + 1) };
}

function scoreModel(model: ModelInfo, query: string, primaryProvider?: string): number {
  const q = normalizeModelKey(query.replace(/:.*$/, ""));
  if (!q) return -1;
  const label = normalizeModelKey(model.label);
  const id = normalizeModelKey(model.id);
  const provider = normalizeModelKey(model.provider);
  const { provider: qProvider, id: qId } = (() => {
    const slash = q.indexOf("/");
    if (slash === -1) return { id: q };
    return { provider: q.slice(0, slash), id: q.slice(slash + 1) };
  })();

  let score = 0;
  if (label === q) score = 1000;
  else if (id === q || id === qId) score = 900;
  else if (label.endsWith(`/${qId}`) || id.endsWith(qId)) score = 800;
  else if (id.includes(qId) || label.includes(q) || id.includes(q)) score = 600;
  else return -1;

  if (qProvider && provider === qProvider) score += 50;
  if (primaryProvider && model.provider === primaryProvider) score += 20;
  // Prefer longer/newer-looking ids when scores tie later.
  score += Math.min(model.id.length, 40) / 100;
  return score;
}

/** Resolve a user model token to catalog entries without inventing ids. */
export function resolveModelFromCatalog(
  query: string | undefined,
  models: ModelInfo[],
  primaryProvider?: string,
): ModelResolve {
  if (!query?.trim()) return { status: "none", query: "" };
  const raw = query.trim();
  // Allow provider/model:thinking in --model values.
  const modelQuery = raw.includes(":") && raw.includes("/") ? raw.slice(0, raw.lastIndexOf(":")) : raw;

  const exactLabel = models.find((m) => m.label === modelQuery);
  if (exactLabel) return { status: "exact", model: exactLabel, query: modelQuery };

  const exactIds = models.filter((m) => m.id === modelQuery);
  if (exactIds.length === 1) return { status: "exact", model: exactIds[0]!, query: modelQuery };
  if (exactIds.length > 1) {
    const preferred =
      (primaryProvider && exactIds.find((m) => m.provider === primaryProvider)) || exactIds[0]!;
    return {
      status: "unique",
      model: preferred,
      query: modelQuery,
      reason: `matched catalog id ${preferred.label}`,
    };
  }

  const ranked = models
    .map((model) => ({ model, score: scoreModel(model, modelQuery, primaryProvider) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score || b.model.id.localeCompare(a.model.id, undefined, { numeric: true }));

  if (ranked.length === 0) return { status: "none", query: modelQuery };
  const best = ranked[0]!;
  const top = ranked.filter((row) => Math.abs(row.score - best.score) < 1);
  // Treat as unique when one clear winner, or multiple share the same id across providers with a primary-provider preference.
  if (top.length === 1 || (best.score >= 800 && top.every((row) => row.model.id === best.model.id))) {
    const preferred =
      primaryProvider && top.some((row) => row.model.provider === primaryProvider)
        ? top.find((row) => row.model.provider === primaryProvider)!.model
        : best.model;
    return {
      status: "unique",
      model: preferred,
      query: modelQuery,
      reason: `matched catalog id ${preferred.label}`,
    };
  }
  // Collapse same-score different families into ambiguous list (cap 5).
  const candidates = ranked.slice(0, 5).map((row) => row.model);
  return { status: "ambiguous", query: modelQuery, candidates };
}

const BARE_THINKING = new Set<string>([
  ...THINKING_LEVELS,
  ...Object.keys(THINKING_ALIASES),
]);

/**
 * Pull trailing/leading model and thinking tokens out of free text when the user
 * omitted flags, e.g. "gpt-5.5 xhigh review auth" or "用 kimi 高思考看 @src".
 */
export function extractModelThinkingFromText(
  text: string,
  models: ModelInfo[],
  primaryProvider?: string,
): { model?: string; thinking?: string; target: string; notes: string[] } {
  if (!text.trim() || models.length === 0) return { target: text, notes: [] };
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const notes: string[] = [];
  let model: string | undefined;
  let thinking: string | undefined;
  const keep: string[] = [];

  for (const token of tokens) {
    const bare = token.replace(/^['"]|['"]$/g, "");
    if (!model) {
      const resolved = resolveModelFromCatalog(bare, models, primaryProvider);
      if (resolved.status === "exact" || resolved.status === "unique") {
        model = resolved.model.label;
        notes.push(`model ${bare} → ${model}`);
        // provider/model:thinking form
        if (bare.includes(":") && bare.includes("/")) {
          const level = bare.slice(bare.lastIndexOf(":") + 1);
          if (canonicalizeThinking(level)) thinking = canonicalizeThinking(level);
        }
        continue;
      }
    }
    if (!thinking && (BARE_THINKING.has(bare.toLowerCase()) || Boolean(canonicalizeThinking(bare)))) {
      const level = canonicalizeThinking(bare);
      if (level) {
        thinking = level;
        notes.push(`thinking ${bare} → ${level}`);
        continue;
      }
    }
    keep.push(token);
  }

  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), target: keep.join(" ").trim(), notes };
}

export type RvResolution = {
  parsed: RvParsed;
  notes: string[];
  ambiguousModels?: string[];
};

/** Apply catalog-aware normalization to a parsed /rv invocation. */
export function resolveRvParsed(
  parsed: RvParsed,
  models: ModelInfo[] = [],
  primaryProvider?: string,
): RvResolution {
  const notes: string[] = [];
  let next: RvParsed = { ...parsed };
  let ambiguousModels: string[] | undefined;

  // Inline --model provider/model:thinking
  if (next.model?.includes(":") && next.model.includes("/")) {
    const idx = next.model.lastIndexOf(":");
    const modelPart = next.model.slice(0, idx);
    const thinkingPart = next.model.slice(idx + 1);
    if (canonicalizeThinking(thinkingPart)) {
      next = { ...next, model: modelPart, thinking: next.thinking ?? thinkingPart };
      notes.push(`split --model thinking suffix :${thinkingPart}`);
    }
  }

  if (!next.model && !next.thinking && next.target && models.length > 0 && !next.modelsOnly) {
    const extracted = extractModelThinkingFromText(next.target, models, primaryProvider);
    if (extracted.model || extracted.thinking) {
      next = {
        ...next,
        ...(extracted.model ? { model: extracted.model } : {}),
        ...(extracted.thinking ? { thinking: extracted.thinking } : {}),
        target: extracted.target || next.target,
      };
      notes.push(...extracted.notes);
    }
  }

  if (next.model && models.length > 0) {
    const resolved = resolveModelFromCatalog(next.model, models, primaryProvider);
    if (resolved.status === "exact" || resolved.status === "unique") {
      if (resolved.model.label !== next.model) {
        notes.push(`model ${next.model} → ${resolved.model.label}`);
      }
      next = { ...next, model: resolved.model.label };
      if (next.thinking) {
        const thinking = resolveThinking(next.thinking, resolved.model.thinkingLevels);
        if (thinking.status === "exact" || thinking.status === "alias" || thinking.status === "fallback") {
          if (thinking.level !== next.thinking) {
            notes.push(
              thinking.status === "fallback"
                ? `thinking ${next.thinking} → ${thinking.level} (${thinking.reason})`
                : `thinking ${next.thinking} → ${thinking.level}`,
            );
          }
          next = { ...next, thinking: thinking.level };
        } else if (thinking.status === "unsupported") {
          notes.push(`thinking ${next.thinking} unsupported by ${resolved.model.label}; dropped`);
          const { thinking: _drop, ...rest } = next;
          next = rest;
        }
      }
    } else if (resolved.status === "ambiguous") {
      ambiguousModels = resolved.candidates.map((m) => m.label);
      notes.push(`model ${next.model} is ambiguous; candidates: ${ambiguousModels.join(", ")}`);
    } else {
      notes.push(`model ${next.model} not found in catalog; left unchanged for skill verification`);
    }
  } else if (next.thinking) {
    const thinking = resolveThinking(next.thinking);
    if (thinking.status === "exact" || thinking.status === "alias" || thinking.status === "fallback") {
      if (thinking.level !== next.thinking) notes.push(`thinking ${next.thinking} → ${thinking.level}`);
      next = { ...next, thinking: thinking.level };
    }
  }

  return { parsed: next, notes, ...(ambiguousModels ? { ambiguousModels } : {}) };
}
