/**
 * Semantic /rv phrases (localized labels, not raw CLI flags in the input box).
 */

import type { RvParsed } from "./rv-prompts.js";
import type { RvLocale } from "./rv-locale.js";
import { rvUi } from "./rv-locale.js";

export type SemanticApply = {
  mode?: string;
  keepSession?: boolean;
  modelsOnly?: boolean;
  noStream?: boolean;
};

export type SemanticPhrase = {
  phrases: string[];
  apply: SemanticApply;
  completionValue: (locale: RvLocale) => string;
  completionDesc?: (locale: RvLocale) => string;
};

export const SEMANTIC_PHRASES: SemanticPhrase[] = [
  {
    phrases: ["code review", "代码审核", "代码审查", "审代码"],
    apply: { mode: "code" },
    completionValue: (l) => rvUi(l).modeCode,
    completionDesc: (l) => (l === "zh" ? "聚焦 diff / 正确性 / 测试" : "Diff, correctness, tests"),
  },
  {
    phrases: ["plan review", "方案审核", "方案评审", "架构审核", "审方案"],
    apply: { mode: "plan" },
    completionValue: (l) => rvUi(l).modePlan,
    completionDesc: (l) => (l === "zh" ? "架构 / 设计 / 产品方案" : "Architecture and design"),
  },
  {
    phrases: ["challenge review", "对抗性审核", "对抗审核", "挑战审核"],
    apply: { mode: "challenge" },
    completionValue: (l) => rvUi(l).modeChallenge,
    completionDesc: (l) => (l === "zh" ? "压力测试假设与风险" : "Adversarial plan pressure-test"),
  },
  {
    phrases: ["keep session for follow-up", "保留会话可追问", "保留会话", "keep session"],
    apply: { keepSession: true },
    completionValue: (l) => rvUi(l).keepSession,
    completionDesc: (l) => rvUi(l).keepSessionDesc,
  },
  {
    phrases: ["list models", "查看模型列表", "模型列表", "list available models"],
    apply: { modelsOnly: true },
    completionValue: (l) => rvUi(l).listModels,
    completionDesc: (l) => rvUi(l).listModelsDesc,
  },
];

export function stripSemanticPhrases(raw: string): { remainder: string; apply: SemanticApply } {
  let remainder = raw;
  const merged: SemanticApply = {};
  const sorted = [...SEMANTIC_PHRASES].flatMap((row) =>
    row.phrases.map((p) => ({ phrase: p, apply: row.apply })),
  );
  sorted.sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { phrase, apply } of sorted) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (!re.test(remainder)) continue;
    remainder = remainder.replace(re, " ").replace(/\s+/g, " ").trim();
    if (apply.mode) merged.mode = apply.mode;
    if (apply.keepSession) merged.keepSession = true;
    if (apply.modelsOnly) merged.modelsOnly = true;
    if (apply.noStream) merged.noStream = true;
  }
  return { remainder, apply: merged };
}

export function mergeSemanticIntoParsed(parsed: RvParsed, apply: SemanticApply): RvParsed {
  const out = { ...parsed };
  if (apply.mode) out.mode = apply.mode;
  if (apply.keepSession) out.keepSession = true;
  if (apply.modelsOnly) out.modelsOnly = true;
  if (apply.noStream) out.noStream = true;
  return out;
}

export function semanticCompletionItems(
  locale: RvLocale,
  tail: string,
  headPrefix: string,
  head: string[],
): { value: string; label: string; description?: string }[] {
  const present = new Set(head.map((h) => h.toLowerCase()));
  const q = tail.toLowerCase().trim();
  const items: { value: string; label: string; description?: string }[] = [];
  for (const row of SEMANTIC_PHRASES) {
    const value = row.completionValue(locale);
    if (present.has(value.toLowerCase())) continue;
    const matches =
      !q ||
      value.toLowerCase().includes(q) ||
      value.toLowerCase().startsWith(q) ||
      row.phrases.some((p) => p.toLowerCase().startsWith(q) || p.toLowerCase().includes(q));
    if (!matches) continue;
    items.push({
      value: `${headPrefix}${value}`,
      label: value,
      description: row.completionDesc?.(locale),
    });
  }
  return items;
}