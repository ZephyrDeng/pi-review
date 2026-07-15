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

/** Strip only a trailing `:thinking` suffix; preserve provider colons such as `px:anthropic/...`. */
export function stripTrailingThinkingSuffix(value: string): { model: string; thinking?: string } {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return { model: value };
  const after = value.slice(idx + 1).trim();
  // Thinking suffixes are bare levels, never path-like fragments containing `/`.
  if (!after || after.includes("/") || !canonicalizeThinking(after)) return { model: value };
  return { model: value.slice(0, idx), thinking: after };
}

/** Collapse separators so gpt5.5 / gpt_5_5 / GPT-5.5 share one key. Keep `/` and provider `:`. */
export function normalizeModelKey(value: string): string {
  const { model } = stripTrailingThinkingSuffix(value);
  return model
    .toLowerCase()
    .replace(/[^a-z0-9:/]+/g, "")
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
  const q = normalizeModelKey(stripTrailingThinkingSuffix(query).model);
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
  // Only strip a trailing thinking suffix; keep provider colons (px:anthropic/...).
  const modelQuery = stripTrailingThinkingSuffix(raw).model;

  const exactLabel = models.find((m) => m.label === modelQuery || m.label === raw);
  if (exactLabel) return { status: "exact", model: exactLabel, query: modelQuery };

  const exactIds = models.filter((m) => m.id === modelQuery || m.id === raw);
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

/**
 * Natural-language targets must stay verbatim. Model/thinking come only from
 * explicit flags or an unambiguous `--model provider/model:thinking` suffix.
 * This helper is retained for tests/docs as a no-rewrite identity.
 */
export function extractModelThinkingFromText(
  text: string,
  _models: ModelInfo[] = [],
  _primaryProvider?: string,
): { model?: string; thinking?: string; target: string; notes: string[] } {
  return { target: text, notes: [] };
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

  // Inline --model provider/model:thinking only when the suffix is a real thinking level.
  // Providers such as `px:anthropic/...` must keep their colon.
  if (next.model) {
    const split = stripTrailingThinkingSuffix(next.model);
    if (split.thinking && split.model !== next.model) {
      next = { ...next, model: split.model, thinking: next.thinking ?? split.thinking };
      notes.push(`split --model thinking suffix :${split.thinking}`);
    }
  }

  // Never rewrite natural-language targets by scavenging bare thinking/model words.

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

  // Resolve each --reviewer-model id=model[:thinking] the same way as --model.
  if (next.reviewerModels?.length && models.length > 0) {
    const resolvedMappings: string[] = [];
    for (const mapping of next.reviewerModels) {
      const eq = mapping.indexOf("=");
      if (eq <= 0) {
        resolvedMappings.push(mapping);
        continue;
      }
      const id = mapping.slice(0, eq);
      const rawModel = mapping.slice(eq + 1);
      const split = stripTrailingThinkingSuffix(rawModel);
      const hit = resolveModelFromCatalog(split.model, models, primaryProvider);
      if (hit.status === "exact" || hit.status === "unique") {
        let thinking = split.thinking;
        if (thinking) {
          const t = resolveThinking(thinking, hit.model.thinkingLevels);
          if (t.status === "exact" || t.status === "alias" || t.status === "fallback") thinking = t.level;
          else thinking = undefined;
        }
        const token = thinking ? `${hit.model.label}:${thinking}` : hit.model.label;
        if (token !== rawModel) notes.push(`reviewer-model ${id}: ${rawModel} → ${token}`);
        resolvedMappings.push(`${id}=${token}`);
      } else if (hit.status === "ambiguous") {
        notes.push(`reviewer-model ${id}: ${rawModel} ambiguous; left unchanged`);
        resolvedMappings.push(mapping);
      } else {
        notes.push(`reviewer-model ${id}: ${rawModel} not in catalog; left unchanged`);
        resolvedMappings.push(mapping);
      }
    }
    next = { ...next, reviewerModels: resolvedMappings };
  }

  return { parsed: next, notes, ...(ambiguousModels ? { ambiguousModels } : {}) };
}
