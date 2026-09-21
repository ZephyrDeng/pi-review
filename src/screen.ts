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
  options: { fetchImpl?: JevFetch; patterns?: Record<string, ScreenPattern> } = {},
): Promise<ScreenResult> {
  const startedAt = Date.now();
  const catalog = options.patterns ?? SCREEN_PATTERNS;
  const patternIds = Object.keys(catalog);
  const questions: Record<string, string> = {};
  hunks.forEach((hunk, i) => {
    questions[`d${i}`] =
      `Does hunk "${hunk.id}" contain a real correctness, security, or data-loss defect that should block merge? ` +
      "Ignore style and hypothetical concerns.";
    patternIds.forEach((patternId, p) => {
      questions[`p${i}_${p}`] = `Does hunk "${hunk.id}" contain this defect: ${catalog[patternId]!.title}?`;
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
    const hits = patternIds.map((patternId, p) => ({ patternId, probability: result.probabilities[`p${i}_${p}`] }))
      .filter((hit): hit is { patternId: string; probability: number } => hit.probability !== undefined && hit.probability >= SCREEN_THRESHOLD)
      .sort((a, b) => b.probability - a.probability);

    for (const hit of hits) {
      const pattern = catalog[hit.patternId]!;
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
  process.exit(result.status === "clean" ? 0 : 1);
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
