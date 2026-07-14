import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeterministicMatcher,
  SemanticMatcher,
  deterministicKey,
  normalizePath,
  normalizeSummary,
  type SemanticAdjudicator,
} from "./matcher.js";
import type { ReviewFinding, SourceFinding } from "./types.js";

function sf(id: string, reviewerId: string, finding: ReviewFinding): SourceFinding {
  return { id, reviewerId, finding };
}

function finding(summary: string, opts: { path?: string; actionable?: boolean } = {}): ReviewFinding {
  return { summary, actionable: opts.actionable ?? true, ...(opts.path ? { path: opts.path } : {}) };
}

test("normalizePath strips leading ./ and quotes and lowercases", () => {
  assert.equal(normalizePath("`./src/cli.ts`"), "src/cli.ts");
  assert.equal(normalizePath("SRC/CLI.TS"), "src/cli.ts");
  assert.equal(normalizePath(undefined), "");
});

test("normalizeSummary collapses punctuation and whitespace", () => {
  assert.equal(normalizeSummary("Off-by-one  in the loop!"), "off by one in the loop");
  assert.equal(normalizeSummary("`*Null* _deref_`"), "null deref");
});

test("deterministicKey combines path and normalized summary", () => {
  assert.equal(deterministicKey({ path: "src/cli.ts", summary: "Off-by-one" }), "src/cli.ts::off by one");
  assert.equal(deterministicKey({ summary: "No path" }), "::no path");
});

test("DeterministicMatcher merges same path + same summary across reviewers", () => {
  const findings = [
    sf("r1#F1", "r1", finding("Off-by-one in loop", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one in loop", { path: "./src/cli.ts" })),
  ];
  const result = new DeterministicMatcher().match(findings);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.sort(), ["r1#F1", "r2#F1"]);
  assert.equal(result.adjudicationUsed, false);
  assert.deepEqual(result.errors, []);
});

test("DeterministicMatcher keeps different bugs in the same path separate", () => {
  const findings = [
    sf("r1#F1", "r1", finding("Null deref", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("Race condition", { path: "src/cli.ts" })),
  ];
  const result = new DeterministicMatcher().match(findings);
  assert.equal(result.groups.length, 2);
});

test("DeterministicMatcher does not merge across incompatible paths", () => {
  const findings = [
    sf("r1#F1", "r1", finding("same summary", { path: "src/a.ts" })),
    sf("r2#F1", "r2", finding("same summary", { path: "src/b.ts" })),
  ];
  const result = new DeterministicMatcher().match(findings);
  assert.equal(result.groups.length, 2);
});

function adjudicator(response: ReturnType<SemanticAdjudicator["adjudicate"]>): SemanticAdjudicator {
  return { adjudicate: () => response };
}

test("SemanticMatcher merges different-wording same-path findings when adjudicator confirms", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.9 }] })),
  );
  const result = await matcher.match(findings);
  assert.equal(result.adjudicationUsed, true);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]!.sort(), ["r1#F1", "r2#F1"]);
});

test("SemanticMatcher leaves low-confidence matches separate", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.3 }] })),
  );
  const result = await matcher.match(findings);
  assert.equal(result.groups.length, 2);
});

test("SemanticMatcher rejects invented source ids as errors and does not merge them", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r9#F1"], confidence: 0.9 }] })),
  );
  const result = await matcher.match(findings);
  assert.ok(result.errors.some((e) => /invented/.test(e)));
  assert.equal(result.groups.length, 2);
});

test("SemanticMatcher reports malformed merges array as an error", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(adjudicator(Promise.resolve({ merges: "not-an-array" as unknown as never[] })));
  const result = await matcher.match(findings);
  assert.ok(result.errors.some((e) => /merges is not an array/.test(e)));
  assert.equal(result.groups.length, 2);
});

test("SemanticMatcher ignores missing ids silently is not allowed: missing ids stay unmerged", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
    sf("r3#F1", "r3", finding("third issue", { path: "src/cli.ts" })),
  ];
  // Adjudicator only mentions two; the third must remain its own cluster.
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.9 }] })),
  );
  const result = await matcher.match(findings);
  assert.equal(result.groups.length, 2);
  const flat = result.groups.flat();
  assert.deepEqual(flat.sort(), ["r1#F1", "r2#F1", "r3#F1"]);
});

test("SemanticMatcher skips merges with invalid confidence and reports them", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 1.7 }] })),
  );
  const result = await matcher.match(findings);
  assert.ok(result.errors.some((e) => /invalid confidence/.test(e)));
  assert.equal(result.groups.length, 2);
});

test("SemanticMatcher rejects merges across different path anchors", async () => {
  // Two candidate groups: src/a.ts and src/b.ts, each ambiguous.
  const findings = [
    sf("r1#F1", "r1", finding("a wording one", { path: "src/a.ts" })),
    sf("r2#F1", "r2", finding("a wording two", { path: "src/a.ts" })),
    sf("r1#F2", "r1", finding("b wording one", { path: "src/b.ts" })),
    sf("r2#F2", "r2", finding("b wording two", { path: "src/b.ts" })),
  ];
  // Adjudicator tries to merge across a.ts and b.ts — must be rejected.
  const matcher = new SemanticMatcher(
    adjudicator(
      Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r2#F2"], confidence: 0.9 }] }),
    ),
  );
  const result = await matcher.match(findings);
  assert.ok(result.errors.some((e) => /across different path anchors/.test(e)));
  // No cross-path merge happened; each finding stays in its own cluster.
  const flat = result.groups.flat().sort();
  assert.deepEqual(flat, ["r1#F1", "r1#F2", "r2#F1", "r2#F2"]);
});

test("SemanticMatcher honors a within-candidate merge", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("a wording one", { path: "src/a.ts" })),
    sf("r2#F1", "r2", finding("a wording two", { path: "src/a.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.9 }] })),
  );
  const result = await matcher.match(findings);
  assert.equal(result.groups.length, 1);
});

test("F6: a malformed (non-object) merge entry is reported as an error, not silently skipped", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: ["not-an-object", null, 42] as unknown as never[] })),
  );
  const result = await matcher.match(findings);
  assert.ok(result.errors.some((e) => /malformed merge entry/.test(e)), `got ${result.errors.join(";")}`);
  assert.equal(result.groups.length, 2);
});

test("F6: a merge with non-array sourceFindingIds is reported as an error", async () => {
  const findings = [
    sf("r1#F1", "r1", finding("loop bound is wrong", { path: "src/cli.ts" })),
    sf("r2#F1", "r2", finding("off-by-one iteration", { path: "src/cli.ts" })),
  ];
  const matcher = new SemanticMatcher(
    adjudicator(Promise.resolve({ merges: [{ sourceFindingIds: "r1#F1,r2#F1", confidence: 0.9 }] as never })),
  );
  const result = await matcher.match(findings);
  assert.ok(result.errors.some((e) => /non-array sourceFindingIds/.test(e)));
  assert.equal(result.groups.length, 2);
});
