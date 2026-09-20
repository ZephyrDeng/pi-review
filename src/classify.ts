// pi-review classify: scope-governor classification of review findings.
//
// Given the frozen task baseline and the findings from a previous review's
// PI_REVIEW_META_JSON, classify each finding with Jev (TypeSafe System One)
// as in-scope blocker / follow-up / stop-and-escalate — the classification
// the host agent otherwise makes by judgment in the loop closeout protocol.
//
// This is a Jev-only feature: the typed classification is the entire value.
// Without a key it exits blocked with an actionable message rather than
// pretending to classify.

import fs from "node:fs";

import { evaluateChoices, resolveJevConnection, type JevConnection, type JevFetch } from "./jev.js";
import { expandMaybeHome, fail } from "./utils.js";
import type { ParsedArgs, ReviewFinding } from "./types.js";

export const SCOPE_CLASSES = ["in_scope_blocker", "follow_up", "stop_and_escalate"] as const;
export type ScopeClass = (typeof SCOPE_CLASSES)[number];

/** Below this confidence the classification is advisory-only. */
export const CLASSIFY_CONFIDENCE_FLOOR = 0.5;

export interface ClassifiedFinding {
  id: string;
  summary: string;
  classification: ScopeClass;
  confidence: number;
  /** True when confidence is below CLASSIFY_CONFIDENCE_FLOOR — treat as unclassified. */
  uncertain: boolean;
}

export interface ClassifyResult {
  baselineChars: number;
  findings: ClassifiedFinding[];
  unclassified: string[];
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const CLASSIFY_CRITERIA: Record<ScopeClass, string> = {
  in_scope_blocker:
    "The finding is accepted, actionable, and required by the frozen task baseline; the host should fix it now before closeout.",
  follow_up:
    "The finding is valid but outside the frozen baseline or not required for safe closeout; record it without drive-by edits.",
  stop_and_escalate:
    "Ambiguous intent, architectural expansion, unsafe migration, blocked tooling, or anything requiring a human decision; stop rather than guess.",
};

/** Parse a meta file/stdin payload: a PI_REVIEW_META_JSON line or a bare meta JSON object. */
export function parseMetaFindings(text: string): ReviewFinding[] {
  // Loop runs emit one meta line per round — take the LAST one so classify
  // sees the final round's findings, not the stale round-1 set.
  const metaLines = text.split("\n").filter((line) => line.startsWith("PI_REVIEW_META_JSON: "));
  const raw = metaLines.length > 0 ? metaLines[metaLines.length - 1]!.slice("PI_REVIEW_META_JSON: ".length) : text.trim();
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    fail("classify: could not parse meta JSON — pipe a review's PI_REVIEW_META_JSON line or pass --meta <file>");
  }
  const findings = (meta as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    fail("classify: meta JSON has no findings array — is this a review meta record?");
  }
  return findings as ReviewFinding[];
}

/** Resolve the baseline text: @path reads the file, anything else is literal text. */
export function resolveBaseline(value: string): string {
  if (value.startsWith("@")) {
    const file = expandMaybeHome(value.slice(1))!;
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      fail(`classify: cannot read baseline file ${file}: ${(error as Error).message}`);
    }
  }
  return value;
}

/**
 * One Jev call: a Choice question per finding, all fanned out in parallel.
 * The baseline is the judge's only notion of scope; Jev never sees the code.
 */
export async function classifyFindings(
  connection: JevConnection,
  baseline: string,
  findings: ReviewFinding[],
  fetchImpl?: JevFetch,
): Promise<ClassifyResult> {
  const questions: Record<string, { instructions: string; criteria: Record<string, string> }> = {};
  const byId = new Map<string, ReviewFinding>();
  findings.forEach((finding, index) => {
    const id = finding.id ?? `F${index + 1}`;
    byId.set(id, finding);
    questions[id] = {
      instructions:
        `Classify review finding ${id} against the frozen task baseline: is it an in-scope blocker, a follow-up, or stop-and-escalate? ` +
        "Judge scope fit only — the finding's technical validity was already established by the reviewer.",
      criteria: { ...CLASSIFY_CRITERIA },
    };
  });

  const state = {
    baseline,
    findings: findings.map((finding, index) => ({
      id: finding.id ?? `F${index + 1}`,
      summary: finding.summary,
      path: finding.path ?? null,
      severity: finding.severity ?? null,
      actionable: finding.actionable,
    })),
  };
  const result = await evaluateChoices(connection, state, questions, fetchImpl);

  const classified: ClassifiedFinding[] = [];
  for (const [id, answer] of Object.entries(result.answers)) {
    const finding = byId.get(id)!;
    classified.push({
      id,
      summary: finding.summary,
      classification: answer.choice as ScopeClass,
      confidence: answer.confidence,
      uncertain: answer.confidence < CLASSIFY_CONFIDENCE_FLOOR,
    });
  }
  return {
    baselineChars: baseline.length,
    findings: classified,
    unclassified: result.missing,
    ...(result.model ? { model: result.model } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export function formatClassifyAscii(result: ClassifyResult): string {
  const lines = ["── pi-review classify " + "─".repeat(20)];
  const buckets: Record<ScopeClass, ClassifiedFinding[]> = {
    in_scope_blocker: [],
    follow_up: [],
    stop_and_escalate: [],
  };
  for (const finding of result.findings) buckets[finding.classification].push(finding);
  const label: Record<ScopeClass, string> = {
    in_scope_blocker: "In-scope",
    follow_up: "Follow-up",
    stop_and_escalate: "Escalate",
  };
  lines.push(`  Findings  ${result.findings.length} classified${result.model ? ` (${result.model})` : ""}`);
  for (const cls of SCOPE_CLASSES) {
    const bucket = buckets[cls];
    if (bucket.length > 0) lines.push(`  ${label[cls].padEnd(10)}  ${bucket.map((f) => f.id).join(", ")}`);
  }
  if (result.unclassified.length > 0) {
    lines.push(`  Unclassified: ${result.unclassified.join(", ")} (missing from model response)`);
  }
  lines.push("");
  for (const finding of result.findings) {
    const flag = finding.uncertain ? " (low confidence)" : "";
    lines.push(`  ${finding.id}  ${finding.classification.toUpperCase()}  ${finding.confidence.toFixed(2)}${flag}  ${finding.summary}`);
  }
  lines.push("─".repeat(41));
  return lines.join("\n");
}

export async function runClassify(parsed: ParsedArgs, stdinText: string): Promise<never> {
  const baselineRaw = parsed.baseline;
  if (!baselineRaw) {
    fail("classify: --baseline <text|@file> is required (the frozen task/scope)");
  }
  const metaText = parsed.metaFile
    ? (() => {
        try {
          return fs.readFileSync(expandMaybeHome(parsed.metaFile!)!, "utf8");
        } catch (error) {
          fail(`classify: cannot read --meta file: ${(error as Error).message}`);
        }
      })()
    : stdinText;
  if (!metaText || !metaText.trim()) {
    fail("classify: no meta input — pass --meta <file> or pipe a review's stderr/stdout in");
  }
  const findings = parseMetaFindings(metaText);
  const actionable = findings.filter((finding) => finding.actionable);
  if (actionable.length === 0) {
    process.stdout.write("── pi-review classify " + "─".repeat(20) + "\n  No actionable findings to classify.\n" + "─".repeat(41) + "\n");
    process.exit(0);
  }

  const connection = resolveJevConnection(process.env);
  if (!connection) {
    process.stderr.write(
      "pi-review: classify requires a TypeSafe API key: export TYPESAFE_API_KEY (see README — Jev enhancement mode).\n",
    );
    process.exit(4);
  }

  const baseline = resolveBaseline(baselineRaw);
  let result: ClassifyResult;
  try {
    result = await classifyFindings(connection, baseline, actionable);
  } catch (error) {
    process.stderr.write(`pi-review: classify failed: ${(error as Error).message}\n`);
    process.exit(4);
  }

  process.stdout.write(`${formatClassifyAscii(result)}\n`);
  process.stderr.write(`PI_REVIEW_CLASSIFY_JSON: ${JSON.stringify(result)}\n`);
  process.exit(0);
}
