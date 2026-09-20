// Finding clustering for panel review.
//
// Two-phase matching: deterministic exact matching on stable anchors first,
// then an injected semantic adjudicator may merge ambiguous candidate groups
// (same path, different wording). The adjudicator may never invent source
// IDs, drop source IDs, or act as another reviewer; low-confidence matches
// are not merged so that uncertain similarity cannot manufacture quorum.

import fs from "node:fs";
import path from "node:path";

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
export interface MatcherOptions {
  /**
   * Base directory for resolving relative finding paths before comparison.
   * Defaults to the process cwd; panel runs pass the single directory target
   * when there is one, so a reviewer answering `calc.ts` corroborates one
   * answering `/abs/target/calc.ts`.
   */
  baseDir?: string;
}

/** Normalize a path anchor so reviewers that phrase paths slightly differently still match. */
export function normalizePath(value: string | undefined, baseDir: string = process.cwd()): string {
  if (!value) return "";
  const cleaned = value.replace(/^['"`]|['"`]$/g, "").trim();
  if (!cleaned) return "";
  // Resolve against baseDir so absolute and relative spellings of the same
  // file share one anchor, then canonicalize symlinks so macOS's /tmp and
  // /private/tmp (etc.) also converge — reviewers pick either spelling at
  // random, and a split anchor strands an otherwise identical finding as a
  // separate advisory. realpath fails on nonexistent paths → keep resolved.
  const resolved = path.resolve(baseDir, cleaned);
  try {
    return fs.realpathSync(resolved).toLowerCase();
  } catch {
    return resolved.toLowerCase();
  }
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
export function deterministicKey(finding: { path?: string; summary: string }, baseDir?: string): string {
  return `${normalizePath(finding.path, baseDir)}::${normalizeSummary(finding.summary)}`;
}

/**
 * Phase-one matcher: clusters findings that share a path anchor AND a
 * normalized summary. Findings with different paths never merge here; findings
 * with the same path but different wording form separate clusters and become
 * candidates for semantic adjudication.
 */
export class DeterministicMatcher implements FindingMatcher {
  constructor(private readonly options: MatcherOptions = {}) {}

  match(findings: SourceFinding[]): MatchResult {
    const byKey = new Map<string, string[]>();
    const order: string[] = [];
    for (const sf of findings) {
      const key = deterministicKey(sf.finding, this.options.baseDir);
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
 * Clusters merge by complete linkage: every cross-cluster pair of
 * deterministic groups must clear the confidence threshold, so one confident
 * edge cannot chain distinct issues into a single cluster. Invented or
 * missing source IDs are reported as errors and never merged.
 */
export class SemanticMatcher implements FindingMatcher {
  private readonly deterministic: DeterministicMatcher;
  constructor(
    private readonly adjudicator: SemanticAdjudicator,
    private readonly options: MatcherOptions = {},
  ) {
    this.deterministic = new DeterministicMatcher(options);
  }

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
      const anchor = normalizePath(first.finding.path, this.options.baseDir);
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

    // Deterministic-group level merge evidence. The adjudicator's merges are
    // expanded to unordered pairs of deterministic-group indices: a 3-id
    // merge (the Pi adjudicator's cluster form) marks every internal pair,
    // while Jev's pairwise questions already arrive one pair per merge.
    // Findings inside one deterministic group (exact path+summary duplicates)
    // share the group's fate, so a merge naming one member links them all.
    const groupIndex = new Map<string, number>();
    det.groups.forEach((group, index) => {
      for (const id of group) groupIndex.set(id, index);
    });
    const pairId = (a: number, b: number) => (a < b ? a * 65536 + b : b * 65536 + a);
    const pairConfidence = new Map<number, number>();

    for (const merge of response.merges ?? []) {
      if (!merge || typeof merge !== "object" || Array.isArray(merge)) {
        errors.push("adjudicator returned a malformed merge entry (not an object)");
        continue;
      }
      if (!Array.isArray(merge.sourceFindingIds)) {
        errors.push("adjudicator returned a merge with non-array sourceFindingIds");
        continue;
      }
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
      if (ids.length < 2) continue; // no-op, not malformed
      const confidence = Number(merge.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        errors.push(`adjudicator returned invalid confidence for merge of ${ids.join(", ")}`);
        continue;
      }
      // Below-threshold confidence is recorded as evidence, never merges: it
      // blocks a complete-linkage merge instead of silently chaining.
      const indices = [...new Set(ids.map((id) => groupIndex.get(id)!))];
      for (let i = 0; i < indices.length; i += 1) {
        for (let j = i + 1; j < indices.length; j += 1) {
          const key = pairId(indices[i]!, indices[j]!);
          pairConfidence.set(key, Math.max(pairConfidence.get(key) ?? 0, confidence));
        }
      }
    }

    // Complete-linkage merging, strongest link first: two clusters merge only
    // when every cross-cluster pair clears the confidence threshold. A pair
    // the adjudicator never proposed (or proposed below the threshold) blocks
    // the merge, so transitive chains across distinct issues cannot form.
    const clusters = det.groups.map((_, index) => [index]);
    for (;;) {
      let bestConfidence = Number.NEGATIVE_INFINITY;
      let bestI = -1;
      let bestJ = -1;
      for (let i = 0; i < clusters.length; i += 1) {
        for (let j = i + 1; j < clusters.length; j += 1) {
          let min = Number.POSITIVE_INFINITY;
          for (const a of clusters[i]!) {
            for (const b of clusters[j]!) {
              const confidence = pairConfidence.get(pairId(a, b)) ?? 0;
              if (confidence < min) min = confidence;
            }
          }
          if (min >= SEMANTIC_MATCH_CONFIDENCE_THRESHOLD && min > bestConfidence) {
            bestConfidence = min;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestI === -1) break;
      clusters[bestI]!.push(...clusters[bestJ]!);
      clusters.splice(bestJ, 1);
    }

    // Preserve a stable order: by first source id within each merged group.
    const groups = clusters.map((cluster) =>
      cluster.flatMap((index) => det.groups[index]!).sort((a, b) => a.localeCompare(b)),
    );
    groups.sort((a, b) => a[0]!.localeCompare(b[0]!));

    return { groups, errors, adjudicationUsed: true };
  }
}
