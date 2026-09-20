// Cross-round finding comparison for loop review.
//
// Reuses the panel matcher's "same underlying issue?" machinery verbatim: the
// previous round's actionable findings and the current round's are tagged as
// two pseudo-reviewers ("prev" / "curr") and run through the same
// deterministic-first, optionally Jev-adjudicated matching. A group spanning
// both rounds is a persisting finding; curr-only is new; prev-only is no
// longer detected.
//
// Within one loop process the tree never changes between rounds, so this
// measures finding *stability* across independent review sessions — which is
// also the non-convergence signal: an identical actionable set twice in a row
// means further rounds on the same tree cannot change the gate.

import type { FindingMatcher } from "./matcher.js";
import type { SourceFinding } from "./types.js";

/** Minimal finding shape needed for cross-round comparison. */
export interface RoundFindingRef {
  id: string;
  summary: string;
  path?: string;
}

export interface RoundComparison {
  /** Current-round findings semantically present in the previous round too. */
  persisting: number;
  /** Current-round findings with no previous-round counterpart. */
  added: number;
  /** Previous-round findings with no current-round counterpart. */
  resolved: number;
}

/**
 * Compare two rounds' actionable findings through the injected matcher.
 * Advisory by construction: ids are namespaced by round, so a match can never
 * invent or lose findings — worst case is a missed merge (reported as
 * added+resolved), never a false one.
 */
export async function compareRoundFindings(
  previous: RoundFindingRef[],
  current: RoundFindingRef[],
  matcher: FindingMatcher,
): Promise<RoundComparison> {
  const tag = (round: "prev" | "curr") => (f: RoundFindingRef): SourceFinding => ({
    id: `${round}#${f.id}`,
    reviewerId: round,
    finding: { summary: f.summary, actionable: true, ...(f.path ? { path: f.path } : {}) },
  });
  const result = await matcher.match([...previous.map(tag("prev")), ...current.map(tag("curr"))]);

  const prevMatched = new Set<string>();
  const currMatched = new Set<string>();
  for (const group of result.groups) {
    const prevIds = group.filter((id) => id.startsWith("prev#"));
    const currIds = group.filter((id) => id.startsWith("curr#"));
    if (prevIds.length === 0 || currIds.length === 0) continue;
    for (const id of prevIds) prevMatched.add(id);
    for (const id of currIds) currMatched.add(id);
  }
  return {
    persisting: currMatched.size,
    added: current.length - currMatched.size,
    resolved: previous.length - prevMatched.size,
  };
}
