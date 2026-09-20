import assert from "node:assert/strict";
import { test } from "vitest";
import { formatLoopSummary, runReviewLoop } from "./loop.js";
import { DeterministicMatcher } from "./matcher.js";
import { REVIEW_META_VERSION } from "./types.js";
import type { ReviewMeta, ReviewStatus, Verdict } from "./types.js";

function meta(status: ReviewStatus, verdict: Verdict, durationMs = 100): ReviewMeta {
  return {
    metaVersion: REVIEW_META_VERSION,
    reviewMode: "code",
    verdict,
    verdictSource: "parsed",
    status,
    findings: status === "has_findings"
      ? [{ id: "F1", summary: "Fix the gate", actionable: true }]
      : [],
    actionableCount: status === "has_findings" ? 1 : 0,
    durationMs,
    model: "provider/model",
  };
}

test("loop stops after a clean first round", async () => {
  let calls = 0;
  const result = await runReviewLoop(3, async () => {
    calls += 1;
    return { meta: meta("clean", "approve"), exitCode: 0 };
  });

  assert.equal(calls, 1);
  assert.equal(result.stopReason, "clean");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.rounds.map((round) => round.index), [1]);
});

test("loop stops when a later round becomes clean", async () => {
  const sequence = [
    { meta: meta("has_findings", "request_changes", 120), exitCode: 1 },
    { meta: meta("clean", "approve", 80), exitCode: 0 },
  ];

  const result = await runReviewLoop(3, async (roundIndex) => sequence[roundIndex - 1]!);

  assert.equal(result.stopReason, "clean");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.rounds.map((round) => round.status), ["has_findings", "clean"]);
  assert.deepEqual(result.rounds.map((round) => round.durationMs), [120, 80]);
});

test("loop exhausts the budget while actionable findings remain", async () => {
  let calls = 0;
  const result = await runReviewLoop(2, async () => {
    calls += 1;
    return { meta: meta("has_findings", "request_changes"), exitCode: 1 };
  });

  assert.equal(calls, 2);
  assert.equal(result.stopReason, "budget_exhausted");
  assert.equal(result.finalStatus, "has_findings");
  assert.equal(result.exitCode, 1);
  assert.equal(result.rounds.length, 2);
});

test("loop escalates blocked and needs-human outcomes immediately", async () => {
  const scenarios = [
    { status: "blocked" as const, verdict: "blocked" as const, exitCode: 4 },
    { status: "needs_human" as const, verdict: "needs_clarification" as const, exitCode: 3 },
  ];

  for (const scenario of scenarios) {
    let calls = 0;
    const result = await runReviewLoop(3, async () => {
      calls += 1;
      return {
        meta: meta(scenario.status, scenario.verdict),
        exitCode: scenario.exitCode,
      };
    });

    assert.equal(calls, 1);
    assert.equal(result.stopReason, scenario.status);
    assert.equal(result.exitCode, scenario.exitCode);
  }
});

test("loop summary reports each round and final outcome", async () => {
  const sequence = [
    { meta: meta("has_findings", "request_changes", 1_200), exitCode: 1 },
    { meta: meta("clean", "approve", 800), exitCode: 0 },
  ];
  const result = await runReviewLoop(3, async (roundIndex) => sequence[roundIndex - 1]!);

  const summary = formatLoopSummary(result);
  assert.match(summary, /pi-review loop/);
  assert.match(summary, /Round 1.*HAS FINDINGS.*REQUEST CHANGES.*1\.2s/);
  assert.match(summary, /Round 2.*CLEAN.*APPROVE.*800ms/);
  assert.match(summary, /Stop.*clean/);
});

test("loop until clean declares the clean goal and still hard-caps the budget", async () => {
  let calls = 0;
  const result = await runReviewLoop(
    { maxRounds: 2, until: "clean" },
    async () => {
      calls += 1;
      return { meta: meta("has_findings", "request_changes"), exitCode: 1 };
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.until, "clean");
  assert.equal(result.maxRounds, 2);
  assert.equal(result.stopReason, "budget_exhausted");
  const summary = formatLoopSummary(result);
  assert.match(summary, /Goal\s+clean/);
  assert.match(summary, /no gate-blocking findings/);
  assert.match(summary, /Budget\s+max-rounds 2/);
  assert.match(summary, /Stop\s+budget_exhausted/);
});

test("loop until clean stops early when the clean goal is met", async () => {
  const result = await runReviewLoop(
    { maxRounds: 10, until: "clean" },
    async () => ({ meta: meta("clean", "approve"), exitCode: 0 }),
  );
  assert.equal(result.stopReason, "clean");
  assert.equal(result.until, "clean");
  assert.equal(result.exitCode, 0);
  assert.equal(result.rounds.length, 1);
});

test("until-clean loop stops as non_converging when the actionable set is stable across two rounds", async () => {
  const findingMeta = meta("has_findings", "request_changes");
  const result = await runReviewLoop(
    { maxRounds: 5, until: "clean", matcher: new DeterministicMatcher() },
    async () => ({ meta: findingMeta, exitCode: 1 }),
  );

  assert.equal(result.stopReason, "non_converging");
  assert.equal(result.exitCode, 1);
  assert.equal(result.rounds.length, 2);
  assert.deepEqual(result.rounds[1]!.comparison, { persisting: 1, added: 0, resolved: 0 });
});

test("until-clean loop keeps going while the finding set is still moving", async () => {
  const moving: ReviewMeta = {
    ...meta("has_findings", "request_changes"),
    findings: [{ id: "F1", summary: "Different bug", actionable: true }],
  };
  const sequence = [
    { meta: meta("has_findings", "request_changes"), exitCode: 1 },
    { meta: moving, exitCode: 1 },
    { meta: meta("clean", "approve"), exitCode: 0 },
  ];
  const result = await runReviewLoop(
    { maxRounds: 5, until: "clean", matcher: new DeterministicMatcher() },
    async (roundIndex) => sequence[roundIndex - 1]!,
  );

  assert.equal(result.stopReason, "clean");
  assert.equal(result.rounds.length, 3);
  assert.deepEqual(result.rounds[1]!.comparison, { persisting: 0, added: 1, resolved: 1 });
});

test("a matcher failure degrades to no comparison and never kills the loop", async () => {
  const broken = { match: async () => { throw new Error("boom"); } };
  const result = await runReviewLoop(
    { maxRounds: 2, matcher: broken },
    async () => ({ meta: meta("has_findings", "request_changes"), exitCode: 1 }),
  );
  assert.equal(result.stopReason, "budget_exhausted");
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[1]!.comparison, undefined);
});

test("loop summary renders the cross-round comparison line", async () => {
  const result = await runReviewLoop(
    { maxRounds: 2, matcher: new DeterministicMatcher() },
    async () => ({ meta: meta("has_findings", "request_changes"), exitCode: 1 }),
  );
  const text = formatLoopSummary(result);
  assert.match(text, /=1 persisting · \+0 new · -0 resolved/);
});
