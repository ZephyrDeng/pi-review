import assert from "node:assert/strict";
import { test } from "vitest";
import { aggregatePanel, effectiveThreshold } from "./panel-aggregate.js";
import { DeterministicMatcher, SemanticMatcher, type FindingMatcher } from "./matcher.js";
import type {
  ConsensusPolicy,
  ReviewFinding,
  ReviewerSubmission,
  ReviewStatus,
  SourceFinding,
  StructuredReviewResult,
  VerdictInfo,
} from "./types.js";

function finding(
  summary: string,
  opts: { id?: string; actionable?: boolean; path?: string; severity?: string } = {},
): ReviewFinding {
  return {
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.severity ? { severity: opts.severity } : {}),
    ...(opts.path ? { path: opts.path } : {}),
    summary,
    actionable: opts.actionable ?? true,
  };
}

function review(
  status: ReviewStatus,
  findings: ReviewFinding[],
  verdictSource: VerdictInfo["verdictSource"] = "parsed",
  parseError?: string,
): StructuredReviewResult {
  const verdict =
    status === "clean"
      ? "approve"
      : status === "has_findings"
        ? "request_changes"
        : status === "needs_human"
          ? "needs_clarification"
          : "blocked";
  return {
    verdict,
    verdictSource,
    status,
    findings,
    actionableCount: findings.filter((f) => f.actionable).length,
    ...(parseError ? { parseError } : {}),
  };
}

function submission(
  reviewerId: string,
  result: StructuredReviewResult,
  opts: { role?: string; model?: string | null; durationMs?: number } = {},
): ReviewerSubmission {
  return {
    reviewerId,
    ...(opts.role ? { role: opts.role } : {}),
    model: opts.model ?? null,
    durationMs: opts.durationMs ?? 100,
    result,
  };
}

/** Matcher that groups by a caller-supplied key over the source finding. */
function matcherByKey(keyFn: (sf: SourceFinding) => string): FindingMatcher {
  return {
    async match(findings) {
      const map = new Map<string, string[]>();
      for (const sf of findings) {
        const key = keyFn(sf);
        const group = map.get(key);
        if (group) group.push(sf.id);
        else map.set(key, [sf.id]);
      }
      return { groups: [...map.values()], errors: [], adjudicationUsed: false };
    },
  };
}

function fakeMatcher(groups: string[][], errors: string[] = []): FindingMatcher {
  return { async match() { return { groups, errors, adjudicationUsed: false }; } };
}

const bugA = (actionable = true) => finding("Off-by-one in loop", { id: "F1", path: "src/cli.ts", severity: "high", actionable });
const bugB = (actionable = true) => finding("Missing null check", { id: "F1", path: "src/util.ts", severity: "medium", actionable });

/** Three reviewers: r1+r2 report bug A, r3 reports bug B. */
function matrixFixture(): ReviewerSubmission[] {
  return [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("has_findings", [bugA()])),
    submission("r3", review("has_findings", [bugB()])),
  ];
}

function byPathSummary(): FindingMatcher {
  return matcherByKey((sf) => `${sf.finding.path ?? ""}::${sf.finding.summary}`);
}

test("corroboration: two reviewers reporting the same actionable bug confirm one cluster; a singleton stays advisory", async () => {
  const result = await aggregatePanel({
    reviewers: matrixFixture(),
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 3,
    matcher: byPathSummary(),
  });

  assert.equal(result.status, "has_findings");
  assert.equal(result.confirmedClusters.length, 1);
  const cluster = result.confirmedClusters[0]!;
  assert.equal(cluster.summary, "Off-by-one in loop");
  assert.equal(cluster.supportCount, 2);
  assert.equal(cluster.actionableSupportCount, 2);
  assert.deepEqual(cluster.supportingReviewerIds, ["r1", "r2"]);
  assert.equal(result.advisories.length, 1);
  assert.equal(result.advisories[0]!.summary, "Missing null check");
  assert.equal(result.advisories[0]!.supportCount, 1);
  assert.equal(result.advisories[0]!.confirmed, false);
});

test("no double-count: duplicate equivalent findings from one reviewer contribute support one", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA(), finding("Off-by-one in loop", { id: "F2", path: "src/cli.ts" })])),
    submission("r2", review("clean", [])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });

  assert.equal(result.confirmedClusters.length, 0);
  assert.equal(result.advisories.length, 1);
  assert.equal(result.advisories[0]!.supportCount, 1);
  assert.deepEqual(result.advisories[0]!.supportingReviewerIds, ["r1"]);
  assert.equal(result.advisories[0]!.sourceFindingIds.length, 2);
});

test("false-merge: two different bugs in the same path remain separate clusters", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [finding("Null deref", { id: "F1", path: "src/cli.ts" })])),
    submission("r2", review("has_findings", [finding("Race condition", { id: "F1", path: "src/cli.ts" })])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "any",
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });

  assert.equal(result.confirmedClusters.length, 2);
  assert.deepEqual(
    result.confirmedClusters.map((c) => c.summary).sort(),
    ["Null deref", "Race condition"],
  );
});

test("different-wording: semantically equivalent findings cluster when the matcher confirms equivalence", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [finding("loop bound is wrong", { id: "F1", path: "src/cli.ts" })])),
    submission("r2", review("has_findings", [finding("off-by-one iteration", { id: "F1", path: "src/cli.ts" })])),
  ];
  // Injected matcher simulates an adjudicator that confirmed equivalence (same path).
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: matcherByKey((sf) => sf.finding.path ?? ""),
  });

  assert.equal(result.status, "has_findings");
  assert.equal(result.confirmedClusters.length, 1);
  assert.equal(result.confirmedClusters[0]!.supportCount, 2);
});

test("path-conflict: findings with incompatible paths are not merged even when summaries match", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [finding("same summary", { id: "F1", path: "src/a.ts" })])),
    submission("r2", review("has_findings", [finding("same summary", { id: "F1", path: "src/b.ts" })])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "any",
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });

  assert.equal(result.confirmedClusters.length, 2);
});

test("actionability: two informational observations do not confirm; mixed support exposes both counts", async () => {
  const informational = [
    submission("r1", review("has_findings", [bugA(false)])),
    submission("r2", review("has_findings", [bugA(false)])),
  ];
  const infoResult = await aggregatePanel({
    reviewers: informational,
    policy: "any",
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });
  assert.equal(infoResult.status, "clean");
  assert.equal(infoResult.confirmedClusters.length, 0);
  assert.equal(infoResult.advisories.length, 1);
  assert.equal(infoResult.advisories[0]!.actionableSupportCount, 0);

  const mixed = [
    submission("r1", review("has_findings", [bugA(true)])),
    submission("r2", review("has_findings", [bugA(false)])),
  ];
  const mixedResult = await aggregatePanel({
    reviewers: mixed,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });
  const cluster = mixedResult.advisories[0]!;
  assert.equal(cluster.supportCount, 2);
  assert.equal(cluster.actionableSupportCount, 1);
  assert.equal(cluster.confirmed, false);
  assert.equal(mixedResult.status, "clean");
});

test("policy matrix: the same fixture evaluates under any, quorum, majority, and unanimous", async () => {
  const expected: Record<ConsensusPolicy, { threshold: number; confirmed: number; advisories: number; status: ReviewStatus }> = {
    any: { threshold: 1, confirmed: 2, advisories: 0, status: "has_findings" },
    quorum: { threshold: 2, confirmed: 1, advisories: 1, status: "has_findings" },
    majority: { threshold: 2, confirmed: 1, advisories: 1, status: "has_findings" },
    unanimous: { threshold: 3, confirmed: 0, advisories: 2, status: "clean" },
  };

  for (const policy of ["any", "quorum", "majority", "unanimous"] as ConsensusPolicy[]) {
    const want = expected[policy];
    assert.equal(effectiveThreshold(policy, 3, policy === "quorum" ? 2 : undefined), want.threshold);
    const result = await aggregatePanel({
      reviewers: matrixFixture(),
      policy,
      ...(policy === "quorum" ? { minAgree: 2 } : {}),
      configuredReviewers: 3,
      matcher: byPathSummary(),
    });
    assert.equal(result.consensusThreshold, want.threshold, `${policy} threshold`);
    assert.equal(result.confirmedClusters.length, want.confirmed, `${policy} confirmed`);
    assert.equal(result.advisories.length, want.advisories, `${policy} advisories`);
    assert.equal(result.status, want.status, `${policy} status`);
  }
});

test("default matrix: one reviewer is threshold one; two and above default to quorum two", () => {
  assert.equal(effectiveThreshold("quorum", 1, 1), 1);
  assert.equal(effectiveThreshold("any", 1), 1);
  assert.equal(effectiveThreshold("majority", 1), 1);
  assert.equal(effectiveThreshold("unanimous", 1), 1);
  assert.equal(effectiveThreshold("quorum", 2), 2);
  assert.equal(effectiveThreshold("quorum", 5), 2);
  assert.equal(effectiveThreshold("majority", 5), 3);
  assert.equal(effectiveThreshold("unanimous", 5), 5);
});

test("a clean panel with no confirmed clusters is clean even with advisories", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("clean", [])),
    submission("r3", review("clean", [])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 3,
    matcher: byPathSummary(),
  });
  assert.equal(result.status, "clean");
  assert.equal(result.confirmedClusters.length, 0);
  assert.equal(result.advisories.length, 1);
  assert.equal(result.actionableCount, 0);
});

test("panel health: child runtime failure yields blocked, never clean", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("blocked", [bugA()], "runtime_error", "child pi exited with status 1")),
    submission("r3", review("has_findings", [bugA()])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 3,
    matcher: byPathSummary(),
  });
  assert.equal(result.panelHealth, "blocked");
  assert.equal(result.status, "blocked");
  assert.equal(result.successfulReviewers, 2);
  assert.equal(result.reviewers[1]!.contributed, false);
});

test("panel health: unstructured dirty output yields needs-human, never clean", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("needs_human", [], "fallback", "Could not parse ## Verdict as a known enum")),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });
  assert.equal(result.panelHealth, "needs_human");
  assert.equal(result.status, "needs_human");
});

test("panel health: unresolved clarification yields needs-human", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("needs_human", [], "parsed")),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });
  assert.equal(result.status, "needs_human");
});

test("aggregation semantic failure (matcher errors) yields needs-human", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("has_findings", [bugA()])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: fakeMatcher([["r1#F1", "r2#F1"]], ["adjudicator invented source finding ids: r9#F1"]),
  });
  assert.equal(result.status, "needs_human");
  assert.equal(result.panelHealth, "needs_human");
  assert.ok(result.adjudicationErrors?.some((e) => /invented/.test(e)));
});

test("aggregation runtime failure (matcher throws) yields blocked", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("has_findings", [bugA()])),
  ];
  const throwingMatcher: FindingMatcher = { async match() { throw new Error("adjudicator child crashed"); } };
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: throwingMatcher,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.panelHealth, "blocked");
});

test("provenance: every raw finding appears exactly once; unknown source ids are rejected", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA(), finding("Typo", { id: "F2", path: "src/util.ts" })])),
    submission("r2", review("has_findings", [bugA()])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: new DeterministicMatcher(),
  });
  const allSourceIds = result.confirmedClusters.concat(result.advisories).flatMap((c) => c.sourceFindingIds);
  assert.equal(allSourceIds.length, 3);
  assert.equal(new Set(allSourceIds).size, 3);
  assert.deepEqual(allSourceIds.sort(), ["r1#F1", "r1#F2", "r2#F1"].sort());
  assert.equal(result.confirmedClusters.length, 1);
  assert.equal(result.advisories.length, 1);
});

test("provenance: a matcher that drops a finding is rejected as needs-human and preserves dropped findings as advisories", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA()])),
    submission("r2", review("has_findings", [bugA()])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: fakeMatcher([["r1#F1"]]),
  });
  assert.equal(result.status, "needs_human");
  assert.ok(result.adjudicationErrors?.some((e) => /dropped/.test(e)));
  // Dropped finding content is preserved as advisories, not silently lost.
  assert.equal(result.advisories.length, 2);
  assert.deepEqual(result.advisories.flatMap((c) => c.sourceFindingIds).sort(), ["r1#F1", "r2#F1"]);
});

test("top-level findings contain confirmed clusters only; advisories are separate", async () => {
  const result = await aggregatePanel({
    reviewers: matrixFixture(),
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 3,
    matcher: byPathSummary(),
  });
  assert.equal(result.findings.length, result.confirmedClusters.length);
  assert.equal(result.actionableCount, result.confirmedClusters.length);
  for (const f of result.findings) assert.equal(f.actionable, true);
  assert.equal(result.advisories.every((c) => !c.confirmed), true);
});

test("semantic matcher integration confirms a different-wording cluster through an injected adjudicator", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [finding("loop bound is wrong", { id: "F1", path: "src/cli.ts" })])),
    submission("r2", review("has_findings", [finding("off-by-one iteration", { id: "F1", path: "src/cli.ts" })])),
  ];
  const adjudicator = {
    async adjudicate() {
      return { merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.9 }] };
    },
  };
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: new SemanticMatcher(adjudicator),
  });
  assert.equal(result.adjudicationUsed, true);
  assert.equal(result.status, "has_findings");
  assert.equal(result.confirmedClusters.length, 1);
});

test("low-confidence semantic matches remain separate advisories (no manufactured quorum)", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [finding("loop bound is wrong", { id: "F1", path: "src/cli.ts" })])),
    submission("r2", review("has_findings", [finding("off-by-one iteration", { id: "F1", path: "src/cli.ts" })])),
  ];
  const adjudicator = {
    async adjudicate() {
      return { merges: [{ sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.3 }] };
    },
  };
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: new SemanticMatcher(adjudicator),
  });
  assert.equal(result.confirmedClusters.length, 0);
  assert.equal(result.advisories.length, 2);
});

test("F1: dirty verdict (request_changes) with zero parseable findings yields needs-human, never clean", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [], "parsed")),
    submission("r2", review("has_findings", [], "parsed")),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });
  assert.equal(result.status, "needs_human");
  assert.equal(result.panelHealth, "needs_human");
  assert.equal(result.confirmedClusters.length, 0);
});

test("F7: duplicate finding ids from one reviewer stay unique by construction and each appears once", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [
      finding("same bug", { id: "F1", path: "src/cli.ts" }),
      finding("same bug", { id: "F1", path: "src/cli.ts" }),
    ])),
    submission("r2", review("has_findings", [finding("same bug", { id: "F1", path: "src/cli.ts" })])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: byPathSummary(),
  });
  // Three source findings (r1 has two with same model id, but internal ids r1#F1, r1#F2 are unique)
  const allSourceIds = result.confirmedClusters.concat(result.advisories).flatMap((c) => c.sourceFindingIds);
  assert.equal(allSourceIds.length, 3);
  assert.equal(new Set(allSourceIds).size, 3);
  assert.deepEqual(allSourceIds.sort(), ["r1#F1", "r1#F2", "r2#F1"].sort());
});

test("F7: a matcher that assigns a source id to multiple groups is rejected as needs-human", async () => {
  const reviewers = [
    submission("r1", review("has_findings", [bugA(), finding("Typo", { id: "F2", path: "src/util.ts" })])),
    submission("r2", review("has_findings", [bugA()])),
  ];
  const result = await aggregatePanel({
    reviewers,
    policy: "quorum",
    minAgree: 2,
    configuredReviewers: 2,
    matcher: fakeMatcher([["r1#F1", "r2#F1"], ["r1#F1", "r1#F2"]]),
  });
  assert.equal(result.status, "needs_human");
  assert.ok(result.adjudicationErrors?.some((e) => /multiple groups/.test(e)));
});
