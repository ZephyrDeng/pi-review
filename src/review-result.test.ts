import assert from "node:assert/strict";
import { test } from "vitest";
import { parseReviewResult, reviewExitCode } from "./review-result.js";

test("approve with no material findings is clean", () => {
  const result = parseReviewResult(`
## Verdict
approve

## Summary
- Ready to ship.

## Findings
No material findings.

## Risks and Blind Spots
None.

## Open Questions
None.
`);

  assert.equal(result.verdict, "approve");
  assert.equal(result.status, "clean");
  assert.deepEqual(result.findings, []);
  assert.equal(result.actionableCount, 0);
});

test("request_changes exposes structured actionable findings", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Summary
- The loop accepts an invalid budget.

## Findings
### F1: Validate the round budget
- Severity: high
- Path: src/args.ts
- Actionable: yes
- Evidence: Zero rounds bypasses the review gate.
- Impact: CI can report success without a review.
- Recommendation: Reject values below one.

## Risks and Blind Spots
None.

## Open Questions
None.
`);

  assert.equal(result.status, "has_findings");
  assert.deepEqual(result.findings, [
    {
      id: "F1",
      severity: "high",
      path: "src/args.ts",
      summary: "Validate the round budget",
      actionable: true,
      details: "Evidence: Zero rounds bypasses the review gate.\n\nImpact: CI can report success without a review.",
      recommendation: "Reject values below one.",
    },
  ]);
  assert.equal(result.actionableCount, 1);
});

test("partial Markdown findings use verdict-aware actionable defaults", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Summary
- The round budget is unsafe.

## Findings
### High: \`src/args.ts\` accepts zero rounds
- Evidence: --max-rounds 0 reaches the runner.
- Impact: The gate can skip all reviews.
- Recommendation: Require a positive integer.

## Risks and Blind Spots
None.

## Open Questions
None.
`);

  assert.deepEqual(result.findings, [
    {
      severity: "high",
      path: "src/args.ts",
      summary: "accepts zero rounds",
      actionable: true,
      details: "Evidence: --max-rounds 0 reaches the runner.\n\nImpact: The gate can skip all reviews.",
      recommendation: "Require a positive integer.",
    },
  ]);
  assert.equal(result.actionableCount, 1);
  assert.equal(result.status, "has_findings");
});

test("legacy top-level finding lists remain machine-readable", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Summary
- CI does not fail closed.

## Findings
1. **High** — \`src/cli.ts\`: Dirty reviews still exit zero
   - Evidence: runReview forwards the child exit code.
   - Impact: A review gate passes with actionable findings.
   - Recommendation: Map structured status to a stable exit code.

## Risks and Blind Spots
None.

## Open Questions
None.
`);

  assert.deepEqual(result.findings, [
    {
      id: "1",
      severity: "high",
      path: "src/cli.ts",
      summary: "Dirty reviews still exit zero",
      actionable: true,
      details: "Evidence: runReview forwards the child exit code.\n\nImpact: A review gate passes with actionable findings.",
      recommendation: "Map structured status to a stable exit code.",
    },
  ]);
});

test("a path, line range, and explicit base side produce a fully enriched finding (issue #6)", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Off-by-one in the paginator
- Severity: high
- Path: src/paginate.ts
- Lines: 12-40
- Side: base
- Actionable: yes
- Evidence: The loop reads one page past the last valid index.
- Impact: The final page silently returns stale data.
- Recommendation: Clamp the upper bound to the page count.
`);

  assert.deepEqual(result.findings, [
    {
      id: "F1",
      severity: "high",
      path: "src/paginate.ts",
      summary: "Off-by-one in the paginator",
      actionable: true,
      details: "Evidence: The loop reads one page past the last valid index.\n\nImpact: The final page silently returns stale data.",
      recommendation: "Clamp the upper bound to the page count.",
      location: { startLine: 12, endLine: 40, side: "base" },
    },
  ]);
});

test("a single Lines value with no Side keeps only startLine (side defaults to working, omitted)", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Missing null check
- Path: src/util.ts
- Lines: 42
- Actionable: yes
- Evidence: The accessor runs before the null guard.
- Impact: A null dereference crashes the request handler.
- Recommendation: Move the guard above the accessor.
`);

  assert.deepEqual(result.findings[0]!.location, { startLine: 42 });
});

test("an explicit Side: working omits the side key (documented as equivalent to the default)", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Off-by-one in the paginator
- Path: src/paginate.ts
- Lines: 10-20
- Side: working
- Actionable: yes
`);

  const location = result.findings[0]!.location;
  assert.deepEqual(location, { startLine: 10, endLine: 20 });
  assert.ok(location && !("side" in location), "side must be omitted, not stored as the literal \"working\"");
});

test("a file-level finding without Lines omits location but keeps details/recommendation", () => {
  const result = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Missing test coverage for the export path
- Path: src/export.ts
- Actionable: yes
- Evidence: No test exercises the CSV export branch.
- Impact: A regression in export formatting would go undetected.
- Recommendation: Add a unit test for the CSV branch.
`);

  const finding = result.findings[0]!;
  assert.equal(finding.location, undefined);
  assert.equal(
    finding.details,
    "Evidence: No test exercises the CSV export branch.\n\nImpact: A regression in export formatting would go undetected.",
  );
  assert.equal(finding.recommendation, "Add a unit test for the CSV branch.");
});

test("malformed or absent Lines values are dropped rather than fabricated", () => {
  const locationFor = (lines: string) =>
    parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Some finding
- Path: src/x.ts
- Lines: ${lines}
- Actionable: yes
`).findings[0]!.location;

  assert.equal(locationFor("around line 12"), undefined, "non-numeric");
  assert.equal(locationFor("0"), undefined, "zero");
  assert.equal(locationFor("-5"), undefined, "negative");
  assert.equal(locationFor("40-12"), undefined, "inverted range");
  assert.equal(locationFor("0-10"), undefined, "non-positive start with an otherwise valid end");
  assert.equal(locationFor("12.5"), undefined, "decimal is not a valid line number");
  assert.equal(locationFor("12-40 approx"), undefined, "trailing text after a range is not parseable");
  // NONE_PLACEHOLDER covers all three "not supplied" spellings, matching Path's own convention.
  assert.equal(locationFor("none"), undefined, "explicit none is equivalent to omitting the field");
  assert.equal(locationFor("n/a"), undefined, "n/a is equivalent to omitting the field");
  assert.equal(locationFor("-"), undefined, "a bare dash is equivalent to omitting the field");
});

test("details tolerates partial Evidence/Impact content and omits itself when both are absent", () => {
  const evidenceOnly = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Evidence only
- Path: src/a.ts
- Actionable: yes
- Evidence: Only evidence was supplied.
`).findings[0]!;
  assert.equal(evidenceOnly.details, "Evidence: Only evidence was supplied.");
  assert.equal(evidenceOnly.recommendation, undefined);

  const impactOnly = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Impact only
- Path: src/b.ts
- Actionable: yes
- Impact: Only impact was supplied.
`).findings[0]!;
  assert.equal(impactOnly.details, "Impact: Only impact was supplied.");

  const neither = parseReviewResult(`
## Verdict
request_changes

## Findings
### F1: Neither
- Path: src/c.ts
- Actionable: yes
`).findings[0]!;
  assert.equal(neither.details, undefined);
  assert.equal(neither.recommendation, undefined);
});

test("an actionable finding overrides an approve verdict", () => {
  const result = parseReviewResult(`
## Verdict
approve

## Findings
### F1: Fix before closeout
- Severity: medium
- Actionable: true

## Risks and Blind Spots
None.

## Open Questions
None.
`);

  assert.equal(result.status, "has_findings");
  assert.equal(result.actionableCount, 1);
});

test("non-actionable findings without a path keep approve clean", () => {
  const result = parseReviewResult(`
## Verdict
approve

## Findings
### F1: Track a future improvement
- Severity: low
- Path: none
- Actionable: no
`);

  assert.equal(result.status, "clean");
  assert.deepEqual(result.findings, [
    {
      id: "F1",
      severity: "low",
      summary: "Track a future improvement",
      actionable: false,
    },
  ]);
});

test("clarification, parse fallback, and runtime failures escalate", () => {
  const clarification = parseReviewResult(`
## Verdict
needs_clarification

## Findings
### F1: Confirm the intended contract
- Severity: high
- Actionable: yes
`);
  assert.equal(clarification.status, "needs_human");

  const fallback = parseReviewResult("## Findings\nNo material findings.");
  assert.equal(fallback.status, "needs_human");
  assert.equal(fallback.verdictSource, "fallback");
  assert.match(fallback.parseError ?? "", /Could not parse/);

  const runtime = parseReviewResult(`
## Findings
### F1: Retry the child
- Severity: high
- Actionable: yes
`, {
    verdict: "blocked",
    verdictSource: "runtime_error",
    parseError: "child pi exited with status 1",
  });
  assert.equal(runtime.status, "blocked");
  assert.equal(runtime.verdictSource, "runtime_error");
});

test("review statuses map to stable gate exit codes", () => {
  assert.equal(reviewExitCode("clean"), 0);
  assert.equal(reviewExitCode("has_findings"), 1);
  assert.equal(reviewExitCode("needs_human"), 3);
  assert.equal(reviewExitCode("blocked"), 4);
});
