// pi-review screen: gate-grade Jev screening — typed judgments only, no LLM
// prose generation on this path.
//
// Each file is sliced into declaration-level hunks deterministically; one
// System One call fans out a catch-all Noul plus one Noul per catalog defect
// pattern per hunk; hits assemble ReviewFinding-shaped results from pattern
// templates. Catalog misses still surface as "unmatched defect signal"
// findings, so the gate never silently drops a strong catch-all signal —
// deeper review (full `pi-review`) is the escape hatch, not silent loss.
// Mechanism and measurements: docs/research/jev-screening-case.md.

import fs from "node:fs";

import {
  evaluateNouls,
  resolveJevConnection,
  GENERIC_NOUL_CRITERIA,
  type JevConnection,
  type JevFetch,
  type JevUsage,
} from "./jev.js";
import { expandMaybeHome, fail } from "./utils.js";
import type { ParsedArgs, ReviewFinding } from "./types.js";

/** Probability floor for both the catch-all and per-pattern questions. */
export const SCREEN_THRESHOLD = 0.6;

/** ponytail: beyond this many hunks per file the tail merges into the last hunk; deeper review owns huge files. */
export const MAX_HUNKS_PER_FILE = 40;

/** The screening API accepted 561 Nouls in one call; chunk with headroom below that. */
export const MAX_QUESTIONS_PER_CALL = 480;

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
};

const PATTERN_IDS = Object.keys(SCREEN_PATTERNS);

export interface ScreenHunk {
  id: string;
  path: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  code: string;
}

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "else", "do", "return", "new"]);

/**
 * Declaration-boundary heuristic: function/class/interface/type/arrow
 * declarations and method signatures. Language-agnostic enough for TS/JS/Go-
 * style sources; a file with no recognizable boundaries becomes one hunk.
 */
const BOUNDARY =
  /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:abstract\s+)?class\s+(\w+)|(?:export\s+)?interface\s+(\w+)|(?:export\s+)?type\s+(\w+)\s*=|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:\w\[\]<>|, ]*\{?\s*$)/;

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

export interface ScreenResult {
  status: "clean" | "has_findings";
  findings: ReviewFinding[];
  hunkReports: ScreenHunkReport[];
  questions: number;
  calls: number;
  durationMs: number;
  model?: string;
  usage?: JevUsage;
}

/**
 * Fan out every question in one call, chunking sequentially past
 * MAX_QUESTIONS_PER_CALL. Missing answers read as "no" (conservative).
 */
async function evaluateChunked(
  connection: JevConnection,
  state: unknown,
  questions: Record<string, string>,
  fetchImpl?: JevFetch,
): Promise<{ probabilities: Record<string, number>; calls: number; usage?: JevUsage; model?: string }> {
  const entries = Object.entries(questions);
  const probabilities: Record<string, number> = {};
  let calls = 0;
  let usage: JevUsage | undefined;
  let model: string | undefined;
  for (let offset = 0; offset < entries.length; offset += MAX_QUESTIONS_PER_CALL) {
    const chunk = Object.fromEntries(entries.slice(offset, offset + MAX_QUESTIONS_PER_CALL));
    const result = await evaluateNouls(connection, state, chunk, fetchImpl ?? fetch, GENERIC_NOUL_CRITERIA);
    Object.assign(probabilities, result.probabilities);
    calls += 1;
    if (result.usage) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + result.usage.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + result.usage.outputTokens,
      };
    }
    model = result.model ?? model;
  }
  return { probabilities, calls, ...(usage ? { usage } : {}), ...(model ? { model } : {}) };
}

/** Screen pre-sliced hunks; pure of filesystem and process exit so tests drive it with a mocked fetch. */
export async function screenHunks(
  connection: JevConnection,
  hunks: ScreenHunk[],
  options: { fetchImpl?: JevFetch } = {},
): Promise<ScreenResult> {
  const startedAt = Date.now();
  const questions: Record<string, string> = {};
  hunks.forEach((hunk, i) => {
    questions[`d${i}`] =
      `Does hunk "${hunk.id}" contain a real correctness, security, or data-loss defect that should block merge? ` +
      "Ignore style and hypothetical concerns.";
    PATTERN_IDS.forEach((patternId, p) => {
      questions[`p${i}_${p}`] = `Does hunk "${hunk.id}" contain this defect: ${SCREEN_PATTERNS[patternId]!.title}?`;
    });
  });

  const state = {
    task: "Screen code hunks for real defects worth blocking a merge on. Judge each hunk independently against the supplied code.",
    hunks: hunks.map((hunk) => ({
      id: hunk.id,
      path: hunk.path,
      lines: `${hunk.startLine}-${hunk.endLine}`,
      code: hunk.code,
    })),
  };
  const result = await evaluateChunked(connection, state, questions, options.fetchImpl);

  const findings: ReviewFinding[] = [];
  const hunkReports: ScreenHunkReport[] = [];
  hunks.forEach((hunk, i) => {
    const catchAll = result.probabilities[`d${i}`];
    const hits = PATTERN_IDS.map((patternId, p) => ({ patternId, probability: result.probabilities[`p${i}_${p}`] }))
      .filter((hit): hit is { patternId: string; probability: number } => hit.probability !== undefined && hit.probability >= SCREEN_THRESHOLD)
      .sort((a, b) => b.probability - a.probability);

    for (const hit of hits) {
      const pattern = SCREEN_PATTERNS[hit.patternId]!;
      findings.push({
        id: `S${findings.length + 1}`,
        severity: pattern.severity,
        path: hunk.path,
        summary: pattern.title,
        actionable: true,
        details:
          `Evidence: hunk "${hunk.id}" (${hunk.path}:${hunk.startLine}-${hunk.endLine}) matched defect pattern ` +
          `"${hit.patternId}" (p=${hit.probability.toFixed(2)}, category=${pattern.category}).`,
        recommendation: pattern.recommendation,
        location: { startLine: hunk.startLine, endLine: hunk.endLine },
      });
    }
    if (hits.length === 0 && catchAll !== undefined && catchAll >= SCREEN_THRESHOLD) {
      findings.push({
        id: `S${findings.length + 1}`,
        severity: "major",
        path: hunk.path,
        summary: `Possible defect in "${hunk.id}" matched no known pattern — needs deeper review`,
        actionable: true,
        details:
          `Evidence: the screening catch-all scored p=${catchAll.toFixed(2)} for hunk "${hunk.id}" ` +
          `(${hunk.path}:${hunk.startLine}-${hunk.endLine}) but every catalog pattern scored below ${SCREEN_THRESHOLD}.`,
        recommendation: "Run a full `pi-review` on this file for evidence-backed findings.",
        location: { startLine: hunk.startLine, endLine: hunk.endLine },
      });
    }
    hunkReports.push({
      id: hunk.id,
      path: hunk.path,
      startLine: hunk.startLine,
      endLine: hunk.endLine,
      ...(catchAll !== undefined ? { defectProbability: catchAll } : {}),
      patterns: hits.map((hit) => hit.patternId),
    });
  });

  return {
    status: findings.length > 0 ? "has_findings" : "clean",
    findings,
    hunkReports,
    questions: Object.keys(questions).length,
    calls: result.calls,
    durationMs: Date.now() - startedAt,
    ...(result.model ? { model: result.model } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export function formatScreenAscii(result: ScreenResult): string {
  const lines = ["── pi-review screen " + "─".repeat(20)];
  const flagged = result.hunkReports.filter((h) => (h.defectProbability ?? 0) >= SCREEN_THRESHOLD || h.patterns.length > 0);
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
    result = await screenHunks(connection, hunks);
  } catch (error) {
    process.stderr.write(`pi-review: screen failed: ${(error as Error).message}\n`);
    process.exit(4);
  }

  process.stdout.write(`${formatScreenAscii(result)}\n`);
  process.stderr.write(`PI_REVIEW_SCREEN_JSON: ${JSON.stringify(result)}\n`);
  process.exit(result.status === "clean" ? 0 : 1);
}
