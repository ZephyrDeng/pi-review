import assert from "node:assert/strict";
import { test } from "node:test";
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
    },
  ]);
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
