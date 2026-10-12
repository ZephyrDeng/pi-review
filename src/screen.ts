// pi-review screen: gate-grade Jev screening — typed judgments only, no LLM
// prose generation on this path.
//
// Each file is sliced into declaration-level hunks deterministically; System
// One calls fan out a catch-all Noul plus one Noul per catalog defect pattern
// per hunk, batched under Jev token budgets with only each batch's hunks in
// state (docs/research/jev-screen-token-budget.md); hits assemble
// ReviewFinding-shaped results from pattern templates. Catalog misses still surface as "unmatched defect signal"
// findings, so the gate never silently drops a strong catch-all signal —
// deeper review (full `pi-review`) is the escape hatch, not silent loss.
// Mechanism and measurements: docs/research/jev-screening-case.md.
//
// The catalog grows from use: user pattern files (screen-patterns.json) merge
// over the builtin set, and flagged hunks append to screen-memory.jsonl so
// recurring unmatched signals can be promoted into patterns — see
// screen-memory.ts and `pi-review screen-memory`.

import fs from "node:fs";

import {
  evaluateNouls,
  resolveJevConnection,
  GENERIC_NOUL_CRITERIA,
  JevError,
  type JevConnection,
  type JevFetch,
  type JevUsage,
} from "./jev.js";
import {
  aggregateScreenMemory,
  formatScreenMemoryAscii,
  loadUserPatterns,
  readScreenMemory,
  recordScreenMemory,
  screenMemoryEnabled,
  screenMemoryFilePath,
  screenPatternsFilePath,
  type FlaggedScreenHunk,
} from "./screen-memory.js";
import { expandMaybeHome, fail } from "./utils.js";
import type { ParsedArgs, ReviewFinding } from "./types.js";

/** Probability floor for both the catch-all and per-pattern questions. */
export const SCREEN_THRESHOLD = 0.6;

/** ponytail: beyond this many hunks per file the tail merges into the last hunk; deeper review owns huge files. */
export const MAX_HUNKS_PER_FILE = 40;

/** The screening API accepted 561 Nouls in one call; chunk with headroom below that. */
export const MAX_QUESTIONS_PER_CALL = 480;

/**
 * Per-request token budgets at 75% of jev-1.13's documented limits
 * (docs.typesafe.ai/models): 64k for state + all questions, 32k for state +
 * the longest question. See docs/research/jev-screen-token-budget.md.
 */
export const BATCH_TOKEN_BUDGET = 48_000;
export const STATE_TOKEN_BUDGET = 24_000;

/** Line-halving levels per piece after the server still reports max_tokens_exceeded. */
export const MAX_REACTIVE_SPLITS = 3;

const SCREEN_TASK =
  "Screen code hunks for real defects worth blocking a merge on. Judge each hunk independently against the supplied code.";

/**
 * shortcut: chars-per-token heuristic (ASCII/3, other UTF-16 units 1:1) — the API has no
 * token-count endpoint and reactive halving covers underestimates; calibrate from
 * usage.input_tokens if it proves too conservative.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other;
}

export interface ScreenPattern {
  title: string;
  severity: string;
  category: "correctness" | "security" | "data-loss" | "performance";
  recommendation: string;
}

/**
 * Defect-pattern catalog. Coverage is the product knob: a hit assembles the
 * finding from the template with zero LLM prose; a miss falls back to the
 * catch-all finding. Add patterns as history shows repeated misses.
 */
export const SCREEN_PATTERNS: Record<string, ScreenPattern> = {
  off_by_one_loop: {
    title: "Off-by-one loop bound reads past array end",
    severity: "critical",
    category: "correctness",
    recommendation: "Change `i <= arr.length` to `i < arr.length`.",
  },
  unawaited_async: {
    title: "Async call not awaited (fire-and-forget)",
    severity: "critical",
    category: "data-loss",
    recommendation: "await the promise or explicitly handle rejection; silent persistence loss otherwise.",
  },
  sql_injection: {
    title: "SQL injection via string interpolation",
    severity: "critical",
    category: "security",
    recommendation: "Use parameterized queries instead of template-string interpolation.",
  },
  slice_off_by_one: {
    title: "slice() end index off by one drops an element",
    severity: "major",
    category: "correctness",
    recommendation: "Use `slice(start, end)` — end is already exclusive.",
  },
  float_money: {
    title: "Float accumulation for money",
    severity: "major",
    category: "correctness",
    recommendation: "Use integer cents or a decimal library for monetary sums.",
  },
  float_equality: {
    title: "Exact float equality in branch condition",
    severity: "major",
    category: "correctness",
    recommendation: "Compare with an epsilon or restructure; `===` on computed floats is unreliable.",
  },
  cache_aliasing: {
    title: "Mutable cached object shared by reference",
    severity: "minor",
    category: "correctness",
    recommendation: "Clone on read/write or freeze cached values.",
  },
  missing_validation: {
    title: "Missing input validation",
    severity: "minor",
    category: "correctness",
    recommendation: "Validate arguments at the trust boundary.",
  },
  // --- Extended catalog: patterns distilled from community rule sets
  // (Semgrep registry, ESLint/typescript-eslint, SonarSource, CWE Top 25).
  // All are hunk-local yes/no judgments — cross-hunk taint stays with full review.
  hardcoded_secret: {
    title: "Hardcoded credential, API key, or private key embedded in source",
    severity: "critical",
    category: "security",
    recommendation: "Move secrets to environment or a secret store; rotate the exposed value.",
  },
  command_injection: {
    title: "OS command built by interpolating user-controlled input",
    severity: "critical",
    category: "security",
    recommendation: "Use execFile/spawn with an argv array or validate input against an allowlist.",
  },
  xss_inner_html: {
    title: "Unescaped data written to innerHTML or dangerouslySetInnerHTML",
    severity: "critical",
    category: "security",
    recommendation: "Render with textContent or sanitize through a vetted library.",
  },
  path_traversal: {
    title: "User-controlled input joined into a filesystem path without normalization",
    severity: "critical",
    category: "security",
    recommendation: "Confine to a base directory and reject .. segments after resolve().",
  },
  weak_random: {
    title: "Weak RNG (Math.random or equivalent) used for a security-sensitive value",
    severity: "major",
    category: "security",
    recommendation: "Use crypto.randomBytes/randomUUID or another CSPRNG for tokens and ids.",
  },
  regex_redos: {
    title: "Regex with nested quantifiers can backtrack catastrophically (ReDoS)",
    severity: "major",
    category: "security",
    recommendation: "Rewrite without nested quantifiers over overlapping classes, or cap input length.",
  },
  truthy_default: {
    title: "`value || fallback` treats valid falsy values (0, \"\", false) as missing",
    severity: "major",
    category: "correctness",
    recommendation: "Use `value ?? fallback` or an explicit null/undefined check.",
  },
  string_sort: {
    title: "Array .sort() without a comparator orders numbers lexicographically",
    severity: "major",
    category: "correctness",
    recommendation: "Pass a comparator, e.g. `arr.sort((a, b) => a - b)`.",
  },
  ignored_error: {
    title: "Error return value or promise rejection left unhandled",
    severity: "major",
    category: "correctness",
    recommendation: "Check the error result or attach .catch; silent failure hides corruption.",
  },
  mutable_default_arg: {
    title: "Mutable default argument shared across calls (e.g. def f(items=[]))",
    severity: "major",
    category: "correctness",
    recommendation: "Default to None/null and allocate a fresh object inside the body.",
  },
  bare_except: {
    title: "Catch-all exception handler swallows errors silently",
    severity: "minor",
    category: "correctness",
    recommendation: "Catch specific exceptions and log or re-raise unexpected ones.",
  },
  unclosed_resource: {
    title: "Opened resource (file, response body, connection) not closed on every path",
    severity: "major",
    category: "data-loss",
    recommendation: "Use try/finally, defer, or a context manager to guarantee close.",
  },
  await_in_loop: {
    title: "await inside a loop serializes independent async work",
    severity: "minor",
    category: "performance",
    recommendation: "Batch with bounded Promise.all unless ordering is required.",
  },
};

export interface ScreenHunk {
  id: string;
  path: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  code: string;
}

const CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "else", "do", "return", "new",
  // Compound statements / keywords that could otherwise capture as a name:
  // `with open(...)`, `except (A, B)`, `match (a, b)`, `case (1, 2)`,
  // `assert (x, y)`, `elif (cond)`, `func`/`def` anonymous-style lines.
  "with", "except", "match", "case", "assert", "elif", "func", "def",
]);

/**
 * Declaration-boundary heuristic: function/class/interface/type/arrow
 * declarations, method signatures, Python `def`, and Go `func` (including
 * methods with a receiver). The method-signature tail requires a `:`/`{`
 * (type annotation, return type, or body open) so a bare call like `foo()`
 * never becomes a boundary. Language-agnostic enough for TS/JS/Python/Go-style
 * sources; a file with no recognizable boundaries becomes one hunk.
 */
const BOUNDARY =
  /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:abstract\s+)?class\s+(\w+)|(?:export\s+)?interface\s+(\w+)|(?:export\s+)?type\s+(\w+)\s*=|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:async\s+)?def\s+(\w+)\s*\(|func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(|(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?:\{|[:\w\[\]<>|, ]+\{?)\s*$)/;

export function sliceHunks(path: string, text: string, maxHunks: number = MAX_HUNKS_PER_FILE): ScreenHunk[] {
  const lines = text.split("\n");
  const boundaries: Array<{ index: number; name: string }> = [];
  lines.forEach((line, index) => {
    const match = BOUNDARY.exec(line);
    if (!match) return;
    const name = match.slice(1).find((group) => group !== undefined);
    if (!name || CONTROL_KEYWORDS.has(name)) return;
    boundaries.push({ index, name });
  });

  const seen = new Map<string, number>();
  const uniqueId = (base: string): string => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };

  const hunks: ScreenHunk[] = [];
  const push = (base: string, startIndex: number, endIndex: number): void => {
    const code = lines.slice(startIndex, endIndex + 1).join("\n");
    if (!code.trim()) return;
    hunks.push({ id: uniqueId(base), path, startLine: startIndex + 1, endLine: endIndex + 1, code });
  };

  if (boundaries.length === 0) {
    push("file", 0, lines.length - 1);
    return hunks;
  }
  push("header", 0, boundaries[0]!.index - 1);
  boundaries.forEach((boundary, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1]!.index - 1 : lines.length - 1;
    push(boundary.name, boundary.index, end);
  });

  // Merge overflow into the last hunk rather than dropping tail code.
  if (hunks.length > maxHunks) {
    const kept = hunks.slice(0, maxHunks);
    const last = kept[kept.length - 1]!;
    const tail = hunks[hunks.length - 1]!;
    last.endLine = tail.endLine;
    last.code = lines.slice(last.startLine - 1, last.endLine).join("\n");
    return kept;
  }
  return hunks;
}

export interface ScreenHunkReport {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Catch-all probability; absent when the API omitted the answer. */
  defectProbability?: number;
  /** Matched pattern ids, highest probability first. */
  patterns: string[];
}

/** A hunk piece the API kept rejecting as too large; its coverage is missing. */
export interface ScreenUnscreened {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
}

export interface ScreenResult {
  /** `incomplete`: no findings, but some code went unscreened — never a pass. */
  status: "clean" | "has_findings" | "incomplete";
  findings: ReviewFinding[];
  /** One report per input hunk; pieces of a split hunk merge into it. */
  hunkReports: ScreenHunkReport[];
  unscreened?: ScreenUnscreened[];
  questions: number;
  calls: number;
  durationMs: number;
  model?: string;
  usage?: JevUsage;
}

/** A screenable slice of one input hunk: the whole hunk unless it had to be split to fit. */
interface ScreenPiece {
  hunkIndex: number;
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  /** Reactive (server-rejected) halvings so far. */
  splits: number;
}

/** A piece plus its questions, keyed `d{key}` / `p{key}_{pattern}` within any request. */
interface ScreenUnit {
  piece: ScreenPiece;
  key: number;
  questions: Array<{ id: string; text: string; tokens: number }>;
  stateTokens: number;
}

function pieceStateEntry(piece: ScreenPiece) {
  return { id: piece.id, path: piece.path, lines: `${piece.startLine}-${piece.endLine}`, code: piece.code };
}

/** Halve by lines, or by characters for a single line; undefined when it cannot shrink. Whitespace-only halves drop. */
function halvePiece(piece: ScreenPiece): ScreenPiece[] | undefined {
  const lines = piece.code.split("\n");
  let halves: ScreenPiece[];
  if (lines.length > 1) {
    const mid = Math.ceil(lines.length / 2);
    halves = [
      { ...piece, id: `${piece.id}/1`, endLine: piece.startLine + mid - 1, code: lines.slice(0, mid).join("\n") },
      { ...piece, id: `${piece.id}/2`, startLine: piece.startLine + mid, code: lines.slice(mid).join("\n") },
    ];
  } else {
    const chars = Array.from(piece.code);
    if (chars.length < 2) return undefined;
    const mid = Math.ceil(chars.length / 2);
    halves = [
      { ...piece, id: `${piece.id}/1`, code: chars.slice(0, mid).join("") },
      { ...piece, id: `${piece.id}/2`, code: chars.slice(mid).join("") },
    ];
  }
  return halves.filter((half) => half.code.trim());
}

interface ScreenTotals {
  probabilities: Record<string, number>;
  calls: number;
  questions: number;
  usage?: JevUsage;
  model?: string;
}

/**
 * One batch: state carries only this batch's pieces; questions chunk past
 * MAX_QUESTIONS_PER_CALL or the token budget left after state. Probabilities
 * commit only when every chunk succeeds, so a rejected batch leaves no partial
 * answers behind; usage and calls count as they happen. Missing answers read as
 * "no" (conservative).
 */
async function evaluateBatch(
  connection: JevConnection,
  batch: ScreenUnit[],
  taskTokens: number,
  totals: ScreenTotals,
  fetchImpl: JevFetch,
): Promise<void> {
  const state = { task: SCREEN_TASK, hunks: batch.map((unit) => pieceStateEntry(unit.piece)) };
  const questionBudget = BATCH_TOKEN_BUDGET - (taskTokens + batch.reduce((sum, unit) => sum + unit.stateTokens, 0));
  const all = batch.flatMap((unit) => unit.questions);
  const chunks: Array<typeof all> = [];
  let chunk: typeof all = [];
  let chunkTokens = 0;
  for (const question of all) {
    if (chunk.length > 0 && (chunk.length >= MAX_QUESTIONS_PER_CALL || chunkTokens + question.tokens > questionBudget)) {
      chunks.push(chunk);
      chunk = [];
      chunkTokens = 0;
    }
    chunk.push(question);
    chunkTokens += question.tokens;
  }
  if (chunk.length > 0) chunks.push(chunk);

  const probabilities: Record<string, number> = {};
  for (const part of chunks) {
    const questions = Object.fromEntries(part.map((question) => [question.id, question.text]));
    const result = await evaluateNouls(connection, state, questions, fetchImpl, GENERIC_NOUL_CRITERIA);
    Object.assign(probabilities, result.probabilities);
    totals.calls += 1;
    if (result.usage) {
      totals.usage = {
        inputTokens: (totals.usage?.inputTokens ?? 0) + result.usage.inputTokens,
        outputTokens: (totals.usage?.outputTokens ?? 0) + result.usage.outputTokens,
      };
    }
    totals.model = result.model ?? totals.model;
  }
  Object.assign(totals.probabilities, probabilities);
  totals.questions += all.length;
}

/** Screen pre-sliced hunks; pure of filesystem and process exit so tests drive it with a mocked fetch. */
export async function screenHunks(
  connection: JevConnection,
  hunks: ScreenHunk[],
  options: { fetchImpl?: JevFetch; patterns?: Record<string, ScreenPattern> } = {},
): Promise<ScreenResult> {
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalog = options.patterns ?? SCREEN_PATTERNS;
  const patternIds = Object.keys(catalog);
  const taskTokens = estimateTokens(JSON.stringify({ task: SCREEN_TASK, hunks: [] }));
  const questionTokens = (text: string) =>
    estimateTokens(JSON.stringify({ type: "noul", instructions: text, criteria: GENERIC_NOUL_CRITERIA })) + 4;

  let nextKey = 0;
  const toUnit = (piece: ScreenPiece, key = nextKey++): ScreenUnit => {
    const texts: Array<[string, string]> = [
      [
        `d${key}`,
        `Does hunk "${piece.id}" contain a real correctness, security, or data-loss defect that should block merge? ` +
          "Ignore style and hypothetical concerns.",
      ],
      ...patternIds.map((patternId, p): [string, string] => [
        `p${key}_${p}`,
        `Does hunk "${piece.id}" contain this defect: ${catalog[patternId]!.title}?`,
      ]),
    ];
    return {
      piece,
      key,
      questions: texts.map(([id, text]) => ({ id, text, tokens: questionTokens(text) })),
      stateTokens: estimateTokens(JSON.stringify(pieceStateEntry(piece))) + 1,
    };
  };
  const maxQuestion = (unit: ScreenUnit) => Math.max(...unit.questions.map((question) => question.tokens));
  const fitsAlone = (unit: ScreenUnit) => taskTokens + unit.stateTokens + maxQuestion(unit) <= STATE_TOKEN_BUDGET;

  // Pre-split hunks whose code alone breaks the state budget; keys stay sequential so
  // inputs that fit produce exactly the pre-batching request.
  const preSplit = (piece: ScreenPiece): ScreenPiece[] => {
    if (fitsAlone(toUnit(piece, -1))) return [piece];
    const halves = halvePiece(piece);
    return halves ? halves.flatMap(preSplit) : [piece];
  };
  const units = hunks
    .flatMap((hunk, hunkIndex) =>
      preSplit({ hunkIndex, id: hunk.id, path: hunk.path, startLine: hunk.startLine, endLine: hunk.endLine, code: hunk.code, splits: 0 }),
    )
    .map((piece) => toUnit(piece));

  // Greedy source-order packing under both token budgets and the question cap.
  const batches: ScreenUnit[][] = [];
  let current: ScreenUnit[] = [];
  let stateTokens = taskTokens;
  let questionTotal = 0;
  let questionCount = 0;
  let longest = 0;
  for (const unit of units) {
    const unitQuestions = unit.questions.reduce((sum, question) => sum + question.tokens, 0);
    const unitLongest = maxQuestion(unit);
    if (
      current.length > 0 &&
      (stateTokens + unit.stateTokens + Math.max(longest, unitLongest) > STATE_TOKEN_BUDGET ||
        stateTokens + unit.stateTokens + questionTotal + unitQuestions > BATCH_TOKEN_BUDGET ||
        questionCount + unit.questions.length > MAX_QUESTIONS_PER_CALL)
    ) {
      batches.push(current);
      current = [];
      stateTokens = taskTokens;
      questionTotal = 0;
      questionCount = 0;
      longest = 0;
    }
    current.push(unit);
    stateTokens += unit.stateTokens;
    questionTotal += unitQuestions;
    questionCount += unit.questions.length;
    longest = Math.max(longest, unitLongest);
  }
  if (current.length > 0) batches.push(current);

  // Degrade on max_tokens_exceeded only: halve the batch, then halve the piece by lines;
  // never resend an identical request. Any other error aborts the screen.
  const totals: ScreenTotals = { probabilities: {}, calls: 0, questions: 0 };
  const screened: ScreenUnit[] = [];
  const unscreened: ScreenUnscreened[] = [];
  while (batches.length > 0) {
    const batch = batches.shift()!;
    try {
      await evaluateBatch(connection, batch, taskTokens, totals, fetchImpl);
      screened.push(...batch);
      continue;
    } catch (error) {
      if (!(error instanceof JevError) || error.code !== "max_tokens_exceeded") throw error;
    }
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      batches.unshift(batch.slice(0, mid), batch.slice(mid));
      continue;
    }
    const { piece } = batch[0]!;
    const halves = piece.splits < MAX_REACTIVE_SPLITS ? halvePiece(piece) : undefined;
    if (halves && halves.length > 0) {
      batches.unshift(...halves.map((half) => [toUnit({ ...half, splits: piece.splits + 1 })]));
      continue;
    }
    unscreened.push({
      id: piece.id,
      path: piece.path,
      startLine: piece.startLine,
      endLine: piece.endLine,
      reason: "max_tokens_exceeded",
    });
  }

  screened.sort(
    (a, b) =>
      a.piece.hunkIndex - b.piece.hunkIndex ||
      a.piece.startLine - b.piece.startLine ||
      (a.piece.id < b.piece.id ? -1 : a.piece.id > b.piece.id ? 1 : 0),
  );
  const findings: ReviewFinding[] = [];
  const merged = hunks.map(() => ({ catchAll: undefined as number | undefined, patterns: new Map<string, number>() }));
  for (const { piece, key } of screened) {
    const catchAll = totals.probabilities[`d${key}`];
    const hits = patternIds.map((patternId, p) => ({ patternId, probability: totals.probabilities[`p${key}_${p}`] }))
      .filter((hit): hit is { patternId: string; probability: number } => hit.probability !== undefined && hit.probability >= SCREEN_THRESHOLD)
      .sort((a, b) => b.probability - a.probability);

    for (const hit of hits) {
      const pattern = catalog[hit.patternId]!;
      findings.push({
        id: `S${findings.length + 1}`,
        severity: pattern.severity,
        path: piece.path,
        summary: pattern.title,
        actionable: true,
        details:
          `Evidence: hunk "${piece.id}" (${piece.path}:${piece.startLine}-${piece.endLine}) matched defect pattern ` +
          `"${hit.patternId}" (p=${hit.probability.toFixed(2)}, category=${pattern.category}).`,
        recommendation: pattern.recommendation,
        location: { startLine: piece.startLine, endLine: piece.endLine },
      });
    }
    if (hits.length === 0 && catchAll !== undefined && catchAll >= SCREEN_THRESHOLD) {
      findings.push({
        id: `S${findings.length + 1}`,
        severity: "major",
        path: piece.path,
        summary: `Possible defect in "${piece.id}" matched no known pattern — needs deeper review`,
        actionable: true,
        details:
          `Evidence: the screening catch-all scored p=${catchAll.toFixed(2)} for hunk "${piece.id}" ` +
          `(${piece.path}:${piece.startLine}-${piece.endLine}) but every catalog pattern scored below ${SCREEN_THRESHOLD}.`,
        recommendation: "Run a full `pi-review` on this file for evidence-backed findings.",
        location: { startLine: piece.startLine, endLine: piece.endLine },
      });
    }
    const report = merged[piece.hunkIndex]!;
    if (catchAll !== undefined) report.catchAll = Math.max(report.catchAll ?? 0, catchAll);
    for (const hit of hits) {
      report.patterns.set(hit.patternId, Math.max(report.patterns.get(hit.patternId) ?? 0, hit.probability));
    }
  }

  const hunkReports: ScreenHunkReport[] = hunks.map((hunk, i) => {
    const report = merged[i]!;
    return {
      id: hunk.id,
      path: hunk.path,
      startLine: hunk.startLine,
      endLine: hunk.endLine,
      ...(report.catchAll !== undefined ? { defectProbability: report.catchAll } : {}),
      patterns: [...report.patterns].sort((a, b) => b[1] - a[1]).map(([patternId]) => patternId),
    };
  });

  return {
    status: findings.length > 0 ? "has_findings" : unscreened.length > 0 ? "incomplete" : "clean",
    findings,
    hunkReports,
    ...(unscreened.length > 0 ? { unscreened } : {}),
    questions: totals.questions,
    calls: totals.calls,
    durationMs: Date.now() - startedAt,
    ...(totals.model ? { model: totals.model } : {}),
    ...(totals.usage ? { usage: totals.usage } : {}),
  };
}

/** The flag rule shared by the ASCII report and memory capture. */
function isFlaggedReport(report: ScreenHunkReport): boolean {
  return (report.defectProbability ?? 0) >= SCREEN_THRESHOLD || report.patterns.length > 0;
}

/**
 * Flagged hunks paired back with their code, in the shape the memory log
 * stores. hunkReports and hunks share order and length by construction.
 */
export function collectFlaggedHunks(result: ScreenResult, hunks: ScreenHunk[]): FlaggedScreenHunk[] {
  const flagged: FlaggedScreenHunk[] = [];
  result.hunkReports.forEach((report, i) => {
    if (!isFlaggedReport(report)) return;
    const hunk = hunks[i]!;
    flagged.push({
      path: report.path,
      hunk: report.id,
      startLine: report.startLine,
      endLine: report.endLine,
      catchAll: report.defectProbability,
      patterns: report.patterns,
      code: hunk.code,
    });
  });
  return flagged;
}

/**
 * Builtin catalog + user pattern files − disabled ids. The effective catalog
 * is rebuilt per run so edits to screen-patterns.json take effect immediately.
 */
export function effectiveScreenPatterns(env: NodeJS.ProcessEnv): {
  patterns: Record<string, ScreenPattern>;
  warnings: string[];
} {
  const user = loadUserPatterns(env);
  const patterns: Record<string, ScreenPattern> = { ...SCREEN_PATTERNS, ...user.patterns };
  for (const id of user.disabled) {
    if (id in patterns) {
      // A patterns file committed to a repo can silently weaken a CI gate —
      // make every builtin removal audible, louder for critical severity.
      const severityNote = SCREEN_PATTERNS[id]?.severity === "critical" ? " (critical severity)" : "";
      if (id in SCREEN_PATTERNS) {
        user.warnings.push(`disabled pattern "${id}" removes a builtin${severityNote} entry`);
      }
      delete patterns[id];
    } else {
      user.warnings.push(`disabled pattern "${id}" is not in the catalog; ignoring it`);
    }
  }
  return { patterns, warnings: user.warnings };
}

export function formatScreenAscii(result: ScreenResult): string {
  const lines = ["── pi-review screen " + "─".repeat(20)];
  const flagged = result.hunkReports.filter(isFlaggedReport);
  lines.push(`  Status     ${result.status}`);
  lines.push(
    `  Hunks      ${result.hunkReports.length} screened, ${flagged.length} flagged ` +
      `(${result.questions} questions, ${result.calls} call${result.calls === 1 ? "" : "s"}, ${(result.durationMs / 1000).toFixed(1)}s)`,
  );
  lines.push(`  Findings   ${result.findings.length}`);
  if (result.findings.length > 0) {
    lines.push("");
    for (const finding of result.findings) {
      const where = finding.path ? `${finding.path}:${finding.location?.startLine ?? "?"}-${finding.location?.endLine ?? "?"}` : "?";
      lines.push(`  ${finding.id}  ${(finding.severity ?? "?").toUpperCase()}  ${where}`);
      lines.push(`      ${finding.summary}`);
    }
  }
  const unscreened = result.unscreened ?? [];
  if (unscreened.length > 0) {
    lines.push("");
    lines.push(`  Unscreened ${unscreened.length} piece${unscreened.length === 1 ? "" : "s"} exceeded the Jev token limit — coverage incomplete, not a pass`);
    for (const piece of unscreened) {
      lines.push(`      ${piece.path}:${piece.startLine}-${piece.endLine}  (${piece.id})`);
    }
  }
  lines.push("─".repeat(39));
  return lines.join("\n");
}

export async function runScreen(parsed: ParsedArgs): Promise<never> {
  const paths = parsed.screenPaths ?? [];
  if (paths.length === 0) {
    fail("screen: provide files to screen: pi-review screen <@files|paths...>");
  }
  const connection = resolveJevConnection(process.env);
  if (!connection) {
    process.stderr.write(
      "pi-review: screen requires a TypeSafe API key: export TYPESAFE_API_KEY (see README — Jev enhancement mode).\n",
    );
    process.exit(4);
  }

  const catalog = effectiveScreenPatterns(process.env);
  for (const warning of catalog.warnings) {
    process.stderr.write(`pi-review: screen patterns: ${warning}\n`);
  }

  const hunks: ScreenHunk[] = [];
  for (const raw of paths) {
    const file = expandMaybeHome(raw.startsWith("@") ? raw.slice(1) : raw)!;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      fail(`screen: cannot read ${file}: ${(error as Error).message}`);
    }
    hunks.push(...sliceHunks(file, text));
  }
  if (hunks.length === 0) {
    fail("screen: no screenable content — every file was empty");
  }

  let result: ScreenResult;
  try {
    result = await screenHunks(connection, hunks, { patterns: catalog.patterns });
  } catch (error) {
    process.stderr.write(`pi-review: screen failed: ${(error as Error).message}\n`);
    process.exit(4);
  }

  recordScreenMemory(collectFlaggedHunks(result, hunks), process.env);

  process.stdout.write(`${formatScreenAscii(result)}\n`);
  process.stderr.write(`PI_REVIEW_SCREEN_JSON: ${JSON.stringify(result)}\n`);
  process.exit(result.status === "clean" ? 0 : result.status === "has_findings" ? 1 : 4);
}

/** `pi-review screen-memory`: report the accumulated signal log and catalog state. */
export function runScreenMemory(env: NodeJS.ProcessEnv = process.env): never {
  const file = screenMemoryFilePath(env);
  const entries = readScreenMemory(file);
  const user = loadUserPatterns(env);
  for (const warning of user.warnings) {
    process.stderr.write(`pi-review: screen patterns: ${warning}\n`);
  }
  const stats = aggregateScreenMemory(entries);
  const overrides = Object.keys(user.patterns).filter((id) => id in SCREEN_PATTERNS).length;
  const catalogMeta = {
    builtin: Object.keys(SCREEN_PATTERNS).length,
    custom: Object.keys(user.patterns).length,
    overrides,
    disabled: user.disabled.length,
    recording: screenMemoryEnabled(env),
  };
  process.stdout.write(
    `${formatScreenMemoryAscii(stats, { file, patternsFile: screenPatternsFilePath(env), catalog: catalogMeta })}\n`,
  );
  process.stderr.write(
    `PI_REVIEW_SCREEN_MEMORY_JSON: ${JSON.stringify({ file, catalog: catalogMeta, ...stats })}\n`,
  );
  process.exit(0);
}
