import assert from "node:assert/strict";
import { test } from "vitest";
import { formatLoopSummary, runReviewLoop } from "./loop.js";
import type { FindingCluster, PanelReviewMeta, ReviewStatus, Verdict } from "./types.js";

function cluster(summary: string, opts: { confirmed?: boolean; support?: number; actionableSupport?: number; reviewers?: string[] } = {}): FindingCluster {
  const support = opts.support ?? 1;
  return {
    id: "C1",
    summary,
    confirmed: opts.confirmed ?? false,
    supportCount: support,
    actionableSupportCount: opts.actionableSupport ?? support,
    supportingReviewerIds: opts.reviewers ?? ["r1"],
    sourceFindingIds: ["r1#F1"],
  };
}

function panelMeta(
  status: ReviewStatus,
  opts: {
    confirmed?: FindingCluster[];
    advisories?: FindingCluster[];
    configured?: number;
    successful?: number;
    policy?: string;
    threshold?: number;
    health?: string;
    durationMs?: number;
  } = {},
): PanelReviewMeta {
  const confirmed = opts.confirmed ?? [];
  const advisories = opts.advisories ?? [];
  const verdict: Verdict =
    status === "clean" ? "approve" : status === "has_findings" ? "request_changes" : status === "needs_human" ? "needs_clarification" : "blocked";
  return {
    strategy: "panel",
    reviewMode: "code",
    verdict,
    verdictSource: "parsed",
    status,
    findings: confirmed.map((c) => ({ id: c.id, summary: c.summary, actionable: true })),
    actionableCount: confirmed.length,
    durationMs: opts.durationMs ?? 100,
    model: null,
    configuredReviewers: opts.configured ?? 3,
    successfulReviewers: opts.successful ?? opts.configured ?? 3,
    consensusPolicy: (opts.policy ?? "quorum") as PanelReviewMeta["consensusPolicy"],
    consensusThreshold: opts.threshold ?? 2,
    panelHealth: (opts.health ?? (status === "blocked" ? "blocked" : status === "needs_human" ? "needs_human" : "healthy")) as PanelReviewMeta["panelHealth"],
    confirmedClusters: confirmed,
    advisories,
    reviewers: [],
    adjudicationUsed: false,
  };
}

const confirmedFinding = [cluster("Off-by-one", { confirmed: true, support: 2, actionableSupport: 2, reviewers: ["r1", "r2"] })];

test("panel loop stops after a clean first panel", async () => {
  let calls = 0;
  const result = await runReviewLoop(3, async () => {
    calls += 1;
    return { meta: panelMeta("clean"), exitCode: 0 };
  });
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "clean");
  assert.equal(result.exitCode, 0);
  assert.equal(result.rounds[0]!.panel?.confirmedCount, 0);
});

test("panel loop stops when a later panel becomes clean", async () => {
  const sequence = [
    { meta: panelMeta("has_findings", { confirmed: confirmedFinding }), exitCode: 1 },
    { meta: panelMeta("clean"), exitCode: 0 },
  ];
  const result = await runReviewLoop(3, async (i) => sequence[i - 1]!);
  assert.equal(result.stopReason, "clean");
  assert.deepEqual(result.rounds.map((r) => r.status), ["has_findings", "clean"]);
  assert.equal(result.rounds[0]!.panel?.confirmedCount, 1);
  assert.equal(result.rounds[1]!.panel?.confirmedCount, 0);
});

test("panel loop exhausts the budget while confirmed findings remain", async () => {
  let calls = 0;
  const result = await runReviewLoop(2, async () => {
    calls += 1;
    return { meta: panelMeta("has_findings", { confirmed: confirmedFinding }), exitCode: 1 };
  });
  assert.equal(calls, 2);
  assert.equal(result.stopReason, "budget_exhausted");
  assert.equal(result.exitCode, 1);
});

test("panel loop escalates blocked and needs-human panels immediately", async () => {
  for (const scenario of [
    { status: "blocked" as const, exit: 4, health: "blocked" },
    { status: "needs_human" as const, exit: 3, health: "needs_human" },
  ]) {
    let calls = 0;
    const result = await runReviewLoop(3, async () => {
      calls += 1;
      return { meta: panelMeta(scenario.status, { health: scenario.health }), exitCode: scenario.exit };
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, scenario.status);
    assert.equal(result.exitCode, scenario.exit);
  }
});

test("panel loop execution count: reviewer runs scale with executed rounds and early stop reduces runs", async () => {
  const reviewerCount = 3;
  let calls = 0;
  await runReviewLoop(5, async () => {
    calls += 1;
    return { meta: panelMeta("clean"), exitCode: 0 };
  });
  assert.equal(calls, 1);
  assert.equal(calls * reviewerCount, reviewerCount);

  let budgetCalls = 0;
  await runReviewLoop(2, async () => {
    budgetCalls += 1;
    return { meta: panelMeta("has_findings", { confirmed: confirmedFinding, configured: reviewerCount }), exitCode: 1 };
  });
  assert.equal(budgetCalls, 2);
  assert.equal(budgetCalls * reviewerCount, 6);
});

test("panel loop summary reports per-round support and consensus details", async () => {
  const sequence = [
    { meta: panelMeta("has_findings", { confirmed: confirmedFinding, advisories: [cluster("Typo")], configured: 3, successful: 3, policy: "quorum", threshold: 2, health: "healthy", durationMs: 1200 }), exitCode: 1 },
    { meta: panelMeta("clean", { configured: 3, successful: 3, policy: "quorum", threshold: 2, durationMs: 800 }), exitCode: 0 },
  ];
  const result = await runReviewLoop(3, async (i) => sequence[i - 1]!);
  const summary = formatLoopSummary(result);
  assert.match(summary, /pi-review loop/);
  assert.match(summary, /Round 1.*panel 3\/3.*1 confirmed \/ 1 advisory.*quorum≥2.*HEALTHY/);
  assert.match(summary, /Round 2.*panel 3\/3.*0 confirmed \/ 0 advisory/);
  assert.match(summary, /Stop.*clean/);
});
