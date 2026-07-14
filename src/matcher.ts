// Finding clustering for panel review.
//
// Two-phase matching: deterministic exact matching on stable anchors first,
// then an injected semantic adjudicator may merge ambiguous candidate groups
// (same path, different wording). The adjudicator may never invent source
// IDs, drop source IDs, or act as another reviewer; low-confidence matches
// are not merged so that uncertain similarity cannot manufacture quorum.

import { SEMANTIC_MATCH_CONFIDENCE_THRESHOLD, type SourceFinding } from "./types.js";

/** Result of matching a set of source findings into clusters. */
export interface MatchResult {
  /**
   * Each group is a list of source finding IDs that represent the same
   * underlying issue. Every input source ID must appear in exactly one group.
   */
  groups: string[][];
  /** Matcher-detected problems (invented IDs, missing IDs, malformed output). */
  errors: string[];
  /** True when a semantic adjudicator was actually consulted. */
  adjudicationUsed: boolean;
}

/** A finding matcher clusters source findings into groups. */
export interface FindingMatcher {
  match(findings: SourceFinding[]): MatchResult | Promise<MatchResult>;
}

/** Normalize a path anchor so reviewers that phrase paths slightly differently still match. */
export function normalizePath(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}

/** Normalize a finding summary for deterministic comparison. */
export function normalizeSummary(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/[*_`]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic cluster key: shared path anchor plus normalized summary. */
export function deterministicKey(finding: { path?: string; summary: string }): string {
  return `${normalizePath(finding.path)}::${normalizeSummary(finding.summary)}`;
}

/**
 * Phase-one matcher: clusters findings that share a path anchor AND a
 * normalized summary. Findings with different paths never merge here; findings
 * with the same path but different wording form separate clusters and become
 * candidates for semantic adjudication.
 */
export class DeterministicMatcher implements FindingMatcher {
  match(findings: SourceFinding[]): MatchResult {
    const byKey = new Map<string, string[]>();
    const order: string[] = [];
    for (const sf of findings) {
      const key = deterministicKey(sf.finding);
      const group = byKey.get(key);
      if (group) {
        group.push(sf.id);
      } else {
        const ids = [sf.id];
        byKey.set(key, ids);
        order.push(key);
      }
    }
    return {
      groups: order.map((key) => byKey.get(key)!),
      errors: [],
      adjudicationUsed: false,
    };
  }
}

/** A candidate group sharing a path anchor but differing in wording. */
export interface AdjudicationCandidate {
  anchorPath: string;
  findings: SourceFinding[];
}

/** Request sent to a semantic adjudicator. */
export interface AdjudicationRequest {
  candidates: AdjudicationCandidate[];
}

/** A proposed merge of source finding IDs into one cluster. */
export interface AdjudicationMerge {
  sourceFindingIds: string[];
  confidence: number;
}

/** Response from a semantic adjudicator. */
export interface AdjudicationResponse {
  merges: AdjudicationMerge[];
  errors?: string[];
}

/**
 * A constrained semantic adjudicator. It receives structured findings only and
 * returns proposed merges with confidence. It may not invent source IDs, drop
 * source IDs, claim new evidence, or act as another reviewer.
 */
export interface SemanticAdjudicator {
  adjudicate(request: AdjudicationRequest): AdjudicationResponse | Promise<AdjudicationResponse>;
}

/**
 * Phase-two matcher: deterministic first, then an injected adjudicator may
 * merge ambiguous same-path candidates. Low-confidence matches are not merged.
 * Invented or missing source IDs are reported as errors and never merged.
 */
export class SemanticMatcher implements FindingMatcher {
  private readonly deterministic = new DeterministicMatcher();
  constructor(private readonly adjudicator: SemanticAdjudicator) {}

  async match(findings: SourceFinding[]): Promise<MatchResult> {
    const det = this.deterministic.match(findings);
    if (det.groups.length <= 1) {
      return { ...det, adjudicationUsed: false };
    }

    const byId = new Map<string, SourceFinding>();
    for (const sf of findings) byId.set(sf.id, sf);

    // Group deterministic clusters by path anchor to find ambiguous candidates:
    // same path, more than one deterministic cluster (i.e. different wording).
    const clustersByPath = new Map<string, SourceFinding[][]>();
    for (const group of det.groups) {
      const first = byId.get(group[0]!)!;
      const anchor = normalizePath(first.finding.path);
      const list = clustersByPath.get(anchor);
      if (list) list.push(group.map((id) => byId.get(id)!));
      else clustersByPath.set(anchor, [group.map((id) => byId.get(id)!)]);
    }

    const candidates: AdjudicationCandidate[] = [];
    for (const [anchorPath, clusters] of clustersByPath) {
      if (clusters.length > 1) {
        candidates.push({ anchorPath, findings: clusters.flat() });
      }
    }

    if (candidates.length === 0) {
      return { ...det, adjudicationUsed: false };
    }

    // A throwing adjudicator is a runtime failure; let it propagate so the
    // aggregator can map it to blocked rather than a silent semantic merge.
    const response = await this.adjudicator.adjudicate({ candidates });

    const candidateIds = new Set<string>();
    const idToCandidate = new Map<string, number>();
    candidates.forEach((candidate, candidateIndex) => {
      for (const sf of candidate.findings) {
        candidateIds.add(sf.id);
        idToCandidate.set(sf.id, candidateIndex);
      }
    });

    const errors: string[] = [];
    if (response.errors?.length) errors.push(...response.errors);

    if (!Array.isArray(response.merges)) {
      return {
        groups: det.groups,
        errors: ["malformed adjudicator response: merges is not an array", ...errors],
        adjudicationUsed: true,
      };
    }

    // Union-find over deterministic groups; only candidate IDs may merge.
    const groupIndex = new Map<string, number>();
    det.groups.forEach((group, index) => {
      for (const id of group) groupIndex.set(id, index);
    });
    const parent = det.groups.map((_, index) => index);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!];
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (const merge of response.merges ?? []) {
      if (!Array.isArray(merge.sourceFindingIds) || merge.sourceFindingIds.length < 2) continue;
      const unknown = merge.sourceFindingIds.filter((id) => !candidateIds.has(id));
      if (unknown.length > 0) {
        errors.push(`adjudicator invented source finding ids: ${unknown.join(", ")}`);
        continue;
      }
      // A merge must stay within a single candidate group (same path anchor).
      // Cross-path merges would create false consensus across different files.
      const candidateIndices = new Set(merge.sourceFindingIds.map((id) => idToCandidate.get(id)!));
      if (candidateIndices.size > 1) {
        errors.push(`adjudicator merged findings across different path anchors: ${merge.sourceFindingIds.join(", ")}`);
        continue;
      }
      const ids = merge.sourceFindingIds;
      if (ids.length < 2) continue;
      const confidence = Number(merge.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        errors.push(`adjudicator returned invalid confidence for merge of ${ids.join(", ")}`);
        continue;
      }
      if (confidence < SEMANTIC_MATCH_CONFIDENCE_THRESHOLD) continue;
      const rootIndex = groupIndex.get(ids[0]!);
      if (rootIndex === undefined) continue;
      for (let i = 1; i < ids.length; i += 1) {
        const idx = groupIndex.get(ids[i]!);
        if (idx !== undefined) union(rootIndex, idx);
      }
    }

    const merged = new Map<number, string[]>();
    for (let index = 0; index < det.groups.length; index += 1) {
      const root = find(index);
      const list = merged.get(root);
      if (list) list.push(...det.groups[index]!);
      else merged.set(root, [...det.groups[index]!]);
    }

    // Preserve a stable order: by first source id within each merged group.
    const groups = [...merged.values()].map((ids) => {
      const sorted = [...ids].sort((a, b) => a.localeCompare(b));
      return sorted;
    });
    groups.sort((a, b) => a[0]!.localeCompare(b[0]!));

    return { groups, errors, adjudicationUsed: true };
  }
}
