/**
 * Pure, testable /rv argument-completion logic.
 *
 * This module deliberately avoids importing pi types so the tokenizer, state
 * machine, and model scorer can be unit-tested with `node:test` and reused
 * across hosts. The thin runtime adapter (registry capture + AutocompleteItem
 * shaping) lives in `review.ts`.
 *
 * Completion items are returned "续写式": `value` always carries the already-typed
 * head tokens because pi-tui's `applyCompletion` replaces the *entire* argument
 * text after the slash command with `item.value`.
 */

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
  code: "代码 / diff / MR 审核",
  plan: "架构 / 计划评审",
  challenge: "对抗性方案评审",
};

export const FLAG_HINTS: Record<string, string> = {
  "--mode": "审核模式 code|plan|challenge",
  "--model": "provider/model[:thinking]",
  "--thinking": "off|minimal|low|medium|high|xhigh",
  "--keep-session": "保留会话，可用 /rv --continue 追问",
  "--no-stream": "缓冲输出到结束（非默认）",
  "--continue": "继续既有 review 会话",
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

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "cc", "cpp", "h", "hpp", "cs", "php", "swift", "scala", "sh", "sql",
  "vue", "svelte",
]);
const PLAN_EXTS = new Set(["md", "markdown", "txt", "rst", "adoc"]);

function extOf(token: string): string | undefined {
  const cleaned = token.replace(/^['"]|['"]$/g, "").replace(/^@/, "");
  const m = cleaned.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : undefined;
}

export function extractSignals(head: string[], deps: CompletionDeps): ReviewSignals {
  const target = head.find((t) => t.startsWith("@"));
  const modeIdx = head.indexOf("--mode");
  const mode = modeIdx >= 0 ? head[modeIdx + 1] : "code";
  return {
    mode,
    hasTarget: Boolean(target),
    targetExt: target ? extOf(target) : undefined,
    primaryProvider: deps.primaryProvider,
  };
}

// ---------------------------------------------------------------------------
// Model scoring (P2 rule engine — pure, no LLM in the completion hot path)
// ---------------------------------------------------------------------------

export function scoreModelForReview(
  m: ModelInfo,
  sig: ReviewSignals,
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  if (m.reasoning) {
    score += 3;
    reasons.push("reasoning");
  }
  if (m.contextWindow >= 200_000) score += 2;
  else if (m.contextWindow >= 100_000) score += 1;
  if (sig.primaryProvider && m.provider !== sig.primaryProvider) {
    score += 1;
    reasons.push("跨厂商交叉审核");
  }
  if ((sig.mode === "plan" || sig.mode === "challenge") && m.thinkingLevels.includes("xhigh")) {
    score += 2;
    reasons.push("xhigh 思考");
  } else if (m.thinkingLevels.includes("high")) {
    score += 1;
  }
  if (sig.targetExt && PLAN_EXTS.has(sig.targetExt) && m.reasoning) {
    score += 1;
    reasons.push("适合文档评审");
  }
  return { score, reason: reasons.filter(Boolean).join(" · ") };
}

export function rankModelsForReview(
  models: ModelInfo[],
  sig: ReviewSignals,
): ModelInfo[] {
  return models
    .map((m) => ({ m, s: scoreModelForReview(m, sig).score }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
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

function thinkingDescription(level: string, sig: ReviewSignals): string {
  const recommended = sig.mode === "code" ? "high" : "xhigh";
  const star = level === recommended ? "★ 推荐 " : "";
  const map: Record<string, string> = {
    off: "不思考（最快）",
    minimal: "极简思考",
    low: "低强度",
    medium: "中强度",
    high: "高强度（review 默认）",
    xhigh: "极致思考（plan/challenge 推荐）",
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
): AutocompleteItem[] | null {
  const ranked = rankModelsForReview(models, sig);
  const items = ranked.map((m, i) => {
    const { score, reason } = scoreModelForReview(m, sig);
    const recommended = i < 3 && score > 0;
    const tag =
      sig.mode === "plan" || sig.mode === "challenge" ? "plan/challenge" : "review";
    return {
      value: `${headPrefix}${m.label}`,
      label: m.label,
      description: [
        recommended ? "★ 推荐" : "",
        tag,
        m.reasoning ? "reasoning" : "",
        contextLabel(m.contextWindow),
        reason,
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
    description: thinkingDescription(level, sig),
  }));
}

function sceneTemplates(
  top: ModelInfo | undefined,
  headPrefix: string,
  tail: string,
): AutocompleteItem[] {
  if (!top) return [];
  const pref = (m: ModelInfo, want: string): string => {
    if (m.thinkingLevels.includes(want)) return want;
    if (m.thinkingLevels.includes("high")) return "high";
    return m.thinkingLevels[0] ?? "";
  };
  const suffix = (want: string): string => {
    const lvl = pref(top, want);
    return lvl ? `:${lvl}` : "";
  };

  const templates = [
    {
      cmd: `--mode code --model ${top.label}${suffix("high")} @`,
      label: "审代码改动（推荐配置）",
    },
    {
      cmd: `--mode plan --model ${top.label}${suffix("high")} @`,
      label: "架构 / 计划评审",
    },
    {
      cmd: `--mode challenge --keep-session --model ${top.label}${suffix("xhigh")} @`,
      label: "对抗性方案评审（可追问）",
    },
  ];
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
  const ranked = deps.models?.length ? rankModelsForReview(deps.models, sig) : [];
  items.push(...sceneTemplates(ranked[0], headPrefix, tail));

  // `models` keyword.
  if (fuzzyMatch("models", tail) || "models".startsWith(tail)) {
    items.push({
      value: `${headPrefix}models`,
      label: "models",
      description: "仅列出 pi-review 可用模型",
    });
  }

  // Flags.
  const flags = flagItems(head, tail, headPrefix);
  if (flags) items.push(...flags);

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
      const items = thinkingSuffixItems(tail, deps.models ?? [], headPrefix, sig);
      return items;
    }
    return modelItems(deps.models ?? [], sig, headPrefix, tail);
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
