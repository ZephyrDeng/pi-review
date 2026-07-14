// Pure panel aggregation — the primary test seam.
//
// Given reviewer submissions, a consensus policy, and an injected finding
// matcher, produce one aggregate panel result with no Pi and no I/O. Most
// consensus behaviour is deterministically testable here.
//
// Status precedence: runtime/child failure -> blocked; unsafe aggregation or
// reviewer clarification -> needs_human; confirmed actionable clusters ->
// has_findings; otherwise clean (may carry non-blocking advisories). A clean
// result is never produced silently when reviewers fail or aggregation is
// unsafe.

import {
  DEFAULT_PANEL_MIN_AGREE,
  type ConsensusPolicy,
  type FindingCluster,
  type PanelAggregationResult,
  type PanelHealth,
  type ReviewFinding,
  type ReviewerOutcome,
  type ReviewerSubmission,
  type ReviewStatus,
  type SourceFinding,
  type Verdict,
} from "./types.js";
import type { FindingMatcher } from "./matcher.js";

/** Effective actionable-support threshold for a consensus policy. */
export function effectiveThreshold(
  policy: ConsensusPolicy,
  configuredReviewers: number,
  minAgree?: number,
): number {
  switch (policy) {
    case "any":
      return 1;
    case "quorum":
      return minAgree ?? DEFAULT_PANEL_MIN_AGREE;
    case "majority":
      return Math.floor(configuredReviewers / 2) + 1;
    case "unanimous":
      return configuredReviewers;
  }
}

type ReviewerKind = "ok" | "needs_human" | "blocked";

function classifyReviewer(sub: ReviewerSubmission): {
  outcome: ReviewerOutcome;
  kind: ReviewerKind;
  contributed: boolean;
} {
  const { result, reviewerId, role, model, durationMs } = sub;
  const outcome: ReviewerOutcome = {
    reviewerId,
    ...(role ? { role } : {}),
    model: model ?? null,
    durationMs,
    status: result.status,
    verdict: result.verdict,
    verdictSource: result.verdictSource,
    contributed: false,
    ...(result.verdictSource === "runtime_error" && result.parseError
      ? { runtimeError: result.parseError }
      : {}),
    ...(result.verdictSource !== "runtime_error" && result.parseError
      ? { parseError: result.parseError }
      : {}),
  };

  if (result.verdictSource === "runtime_error" || result.status === "blocked") {
    return { outcome, kind: "blocked", contributed: false };
  }
  if (result.verdictSource === "fallback") {
    return { outcome, kind: "needs_human", contributed: false };
  }
  if (result.status === "needs_human") {
    return { outcome, kind: "needs_human", contributed: false };
  }
  return { outcome: { ...outcome, contributed: true }, kind: "ok", contributed: true };
}

function verdictForStatus(status: ReviewStatus): Verdict {
  switch (status) {
    case "clean":
      return "approve";
    case "has_findings":
      return "request_changes";
    case "needs_human":
      return "needs_clarification";
    case "blocked":
      return "blocked";
  }
}

function distinctReviewerIds(sourceFindings: SourceFinding[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const sf of sourceFindings) {
    if (!seen.has(sf.reviewerId)) {
      seen.add(sf.reviewerId);
      ordered.push(sf.reviewerId);
    }
  }
  return ordered.sort((a, b) => a.localeCompare(b));
}

function buildCluster(
  id: string,
  sourceFindings: SourceFinding[],
  threshold: number,
): FindingCluster {
  const supportingReviewerIds = distinctReviewerIds(sourceFindings);
  const actionableReviewers = new Set<string>();
  for (const sf of sourceFindings) {
    if (sf.finding.actionable) actionableReviewers.add(sf.reviewerId);
  }
  const actionableSupportCount = actionableReviewers.size;

  const canonical =
    sourceFindings.find((sf) => sf.finding.actionable) ?? sourceFindings[0]!;

  const firstPath = sourceFindings.map((sf) => sf.finding.path).find(Boolean);

  return {
    id,
    summary: canonical.finding.summary,
    ...(canonical.finding.severity ? { severity: canonical.finding.severity } : {}),
    ...(firstPath ? { path: firstPath } : {}),
    confirmed: actionableSupportCount >= threshold,
    supportCount: supportingReviewerIds.length,
    actionableSupportCount,
    supportingReviewerIds,
    sourceFindingIds: sourceFindings.map((sf) => sf.id),
  };
}

export interface PanelAggregationInput {
  reviewers: ReviewerSubmission[];
  policy: ConsensusPolicy;
  minAgree?: number;
  configuredReviewers: number;
  matcher: FindingMatcher;
}

function fallbackClusters(sourceFindings: SourceFinding[]): FindingCluster[] {
  return sourceFindings.map((sf, index) => buildCluster(`C${index + 1}`, [sf], Number.POSITIVE_INFINITY));
}

/**
 * Aggregate independent reviewer results into one panel result. Pure: no Pi,
 * no I/O. A throwing matcher is treated as a runtime aggregation failure
 * (blocked); matcher-reported errors are semantic failures (needs_human).
 */
export async function aggregatePanel(input: PanelAggregationInput): Promise<PanelAggregationResult> {
  const { reviewers, policy, configuredReviewers, matcher } = input;
  const threshold = effectiveThreshold(policy, configuredReviewers, input.minAgree);

  const classifications = reviewers.map((sub) => classifyReviewer(sub));
  const reviewerOutcomes = classifications.map((c) => c.outcome);
  const anyBlocked = classifications.some((c) => c.kind === "blocked");
  const anyNeedsHuman = classifications.some((c) => c.kind === "needs_human");

  // Collect source findings from contributing reviewers only.
  const sourceFindings: SourceFinding[] = [];
  for (const sub of reviewers) {
    const cls = classifications.find((c) => c.outcome.reviewerId === sub.reviewerId)!;
    if (!cls.contributed) continue;
    for (let index = 0; index < sub.result.findings.length; index += 1) {
      const finding = sub.result.findings[index]!;
      const sourceId = `${sub.reviewerId}#${finding.id ?? `F${index + 1}`}`;
      sourceFindings.push({ id: sourceId, reviewerId: sub.reviewerId, finding });
    }
  }
  const byId = new Map(sourceFindings.map((sf) => [sf.id, sf] as const));
  const allSourceIds = new Set(sourceFindings.map((sf) => sf.id));

  let groups: string[][] = [];
  let matcherErrors: string[] = [];
  let adjudicationUsed = false;
  let aggregationRuntimeFailure = false;

  if (sourceFindings.length > 0) {
    try {
      const match = await matcher.match(sourceFindings);
      groups = match.groups;
      matcherErrors = [...(match.errors ?? [])];
      adjudicationUsed = match.adjudicationUsed;
    } catch (error) {
      aggregationRuntimeFailure = true;
      matcherErrors = [`matcher runtime failure: ${(error as Error).message}`];
      groups = [];
    }
  }

  // Provenance invariant: every source finding must appear exactly once and no
  // unknown id may be accepted.
  const covered = new Set<string>();
  for (const group of groups) {
    for (const id of group) covered.add(id);
  }
  const invented = [...covered].filter((id) => !allSourceIds.has(id));
  const missing = [...allSourceIds].filter((id) => !covered.has(id));
  if (invented.length > 0) {
    matcherErrors.push(`matcher invented source finding ids: ${invented.join(", ")}`);
  }
  if (missing.length > 0) {
    matcherErrors.push(`matcher dropped source finding ids: ${missing.join(", ")}`);
  }
  const aggregationSemanticFailure = matcherErrors.length > 0;

  let clusters: FindingCluster[];
  if (aggregationRuntimeFailure || aggregationSemanticFailure) {
    // Cannot trust the clustering on any matcher failure. Fall back to one
    // advisory cluster per raw source finding so no finding content is lost
    // and provenance remains traceable even on the failure path.
    clusters = fallbackClusters(sourceFindings);
  } else {
    clusters = groups.map((group, index) =>
      buildCluster(`C${index + 1}`, group.map((id) => byId.get(id)!).filter(Boolean), threshold),
    );
  }

  const confirmedClusters = clusters.filter((c) => c.confirmed);
  const advisories = clusters.filter((c) => !c.confirmed);

  let panelHealth: PanelHealth;
  if (anyBlocked || aggregationRuntimeFailure) {
    panelHealth = "blocked";
  } else if (anyNeedsHuman || aggregationSemanticFailure) {
    panelHealth = "needs_human";
  } else {
    panelHealth = "healthy";
  }

  let status: ReviewStatus;
  if (panelHealth === "blocked") {
    status = "blocked";
  } else if (panelHealth === "needs_human") {
    status = "needs_human";
  } else if (confirmedClusters.length > 0) {
    status = "has_findings";
  } else {
    status = "clean";
  }

  const findings: ReviewFinding[] = confirmedClusters.map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    ...(c.severity ? { severity: c.severity } : {}),
    ...(c.path ? { path: c.path } : {}),
    summary: c.summary,
    actionable: true,
  }));

  const successfulReviewers = reviewerOutcomes.filter((r) => r.contributed).length;

  return {
    verdict: verdictForStatus(status),
    verdictSource: "parsed",
    status,
    findings,
    actionableCount: findings.length,
    ...(matcherErrors.length > 0 ? { parseError: matcherErrors.join("; ") } : {}),
    strategy: "panel",
    configuredReviewers,
    successfulReviewers,
    consensusPolicy: policy,
    consensusThreshold: threshold,
    panelHealth,
    confirmedClusters,
    advisories,
    reviewers: reviewerOutcomes,
    adjudicationUsed,
    ...(matcherErrors.length > 0 ? { adjudicationErrors: matcherErrors } : {}),
  };
}
