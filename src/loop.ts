import { formatDurationMs, formatUsage } from "./meta-footer.js";
import { reviewExitCode } from "./review-result.js";
import { compareRoundFindings, type RoundComparison } from "./round-compare.js";
import type { FindingMatcher } from "./matcher.js";
import type { PanelReviewMeta, ReviewMeta, ReviewRunResult, ReviewStatus, Verdict } from "./types.js";

export type LoopStopReason = "clean" | "budget_exhausted" | "needs_human" | "blocked" | "non_converging";
export type LoopUntilGoal = "clean";

/**
 * Product definition of the clean gate goal.
 * This is the only success stop for `--until clean`.
 */
export const LOOP_CLEAN_GOAL = {
  id: "clean" as const,
  /** One-line product definition for footers and prompts. */
  summary:
    "status=clean: no gate-blocking findings (single: no actionable findings; panel: no confirmed actionable clusters; advisories may remain)",
  /** Full goal contract for host agents. */
  definition: [
    "Clean goal (gate open):",
    "- Single review: status=clean (no actionable findings; non-actionable notes may remain).",
    "- Panel review: status=clean when there are zero confirmed actionable clusters.",
    "- Panel advisories (uncorroborated / non-confirmed) do NOT fail the clean goal.",
    "- needs_human / blocked never count as clean — escalate immediately.",
    "- has_findings means the clean goal is not met; host may fix confirmed/in-scope blockers and re-review.",
    "- Exit code 0 is required for a successful clean closeout.",
  ].join("\n"),
} as const;

export interface LoopRoundPanelSummary {
  configuredReviewers: number;
  successfulReviewers: number;
  confirmedCount: number;
  advisoryCount: number;
  consensusPolicy: string;
  consensusThreshold: number;
  panelHealth: string;
}

export interface LoopRoundSummary {
  index: number;
  status: ReviewStatus;
  verdict: Verdict;
  durationMs: number;
  findingCount: number;
  actionableCount: number;
  /** Thinking level requested for this round, if any. */
  thinking?: string;
  /** Token usage for this round, when available. */
  usage?: import("./types.js").TokenUsage;
  /** Present when the round evaluated a panel. */
  panel?: LoopRoundPanelSummary;
  /**
   * Cross-round comparison vs the previous round's actionable findings.
   * Present from round 2 onward when a matcher was supplied and the previous
   * round had actionable findings. Advisory bookkeeping; never gate input.
   */
  comparison?: RoundComparison;
}

export interface LoopReviewResult {
  rounds: LoopRoundSummary[];
  finalStatus: ReviewStatus;
  stopReason: LoopStopReason;
  exitCode: number;
  /** Stop goal for this loop (default: clean-or-budget when until is unset). */
  until?: LoopUntilGoal;
  /** Hard review-round budget. */
  maxRounds: number;
}

export type RunOneReview = (roundIndex: number) => Promise<ReviewRunResult>;

export interface RunReviewLoopOptions {
  maxRounds: number;
  /** When set to clean, the loop's declared goal is the clean gate (still hard-capped by maxRounds). */
  until?: LoopUntilGoal;
  /**
   * Matcher for cross-round finding comparison. When supplied, each round
   * after the first is diffed against the previous round's actionable
   * findings (persisting / added / resolved), and an until-clean loop stops
   * early as non_converging once the actionable set is identical across two
   * consecutive rounds — the tree does not change between rounds, so further
   * rounds are dice rolls, not progress.
   */
  matcher?: FindingMatcher;
}

function displayEnum(value: string): string {
  return value.replaceAll("_", " ").toUpperCase();
}

export function formatLoopSummary(result: LoopReviewResult): string {
  const lines = ["── pi-review loop " + "─".repeat(23)];
  if (result.until === "clean") {
    lines.push(`  Goal      clean`);
    lines.push(`  Clean     ${LOOP_CLEAN_GOAL.summary}`);
    lines.push(`  Budget    max-rounds ${result.maxRounds} (hard ceiling; not unlimited)`);
  }
  for (const round of result.rounds) {
    const tokenBit = round.usage ? ` | ${formatUsage(round.usage)}` : "";
    const thinkBit = round.thinking ? ` | think:${round.thinking}` : "";
    if (round.panel) {
      lines.push(
        `  Round ${round.index}  ${displayEnum(round.status)} | panel ${round.panel.successfulReviewers}/${round.panel.configuredReviewers} | ${round.panel.confirmedCount} confirmed / ${round.panel.advisoryCount} advisory | ${round.panel.consensusPolicy}≥${round.panel.consensusThreshold} | ${displayEnum(round.panel.panelHealth as string)}${thinkBit}${tokenBit} | ${formatDurationMs(round.durationMs)}`,
      );
    } else {
      lines.push(
        `  Round ${round.index}  ${displayEnum(round.status)} | ${displayEnum(round.verdict)} | ${round.actionableCount} actionable / ${round.findingCount} total${thinkBit}${tokenBit} | ${formatDurationMs(round.durationMs)}`,
      );
    }
    if (round.comparison) {
      lines.push(
        `           vs prev: =${round.comparison.persisting} persisting · +${round.comparison.added} new · -${round.comparison.resolved} resolved`,
      );
    }
  }
  lines.push(`  Stop     ${result.stopReason}`);
  lines.push(`  Exit     ${result.exitCode}`);
  lines.push("─".repeat(42));
  return lines.join("\n");
}

/**
 * Runs isolated review rounds through an injected single-run adapter.
 *
 * The CLI never edits files between rounds. `--until clean` declares the success
 * goal and labels the budget; host agents own fix-and-reinvoke when using /rv-loop.
 */
export async function runReviewLoop(
  maxRoundsOrOptions: number | RunReviewLoopOptions,
  runOneReview?: RunOneReview,
): Promise<LoopReviewResult> {
  const options: RunReviewLoopOptions =
    typeof maxRoundsOrOptions === "number"
      ? { maxRounds: maxRoundsOrOptions }
      : maxRoundsOrOptions;
  const maxRounds = options.maxRounds;
  const until = options.until;
  const runOne = typeof maxRoundsOrOptions === "number" ? runOneReview : runOneReview;
  if (!runOne) throw new TypeError("runOneReview is required");
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError("maxRounds must be a positive integer");
  }

  const rounds: LoopRoundSummary[] = [];
  let previousActionable: Array<{ id: string; summary: string; path?: string }> | undefined;
  for (let index = 1; index <= maxRounds; index += 1) {
    const run = await runOne(index);
    const { meta } = run;
    const panel = isPanelMeta(meta)
      ? {
          configuredReviewers: meta.configuredReviewers,
          successfulReviewers: meta.successfulReviewers,
          confirmedCount: meta.confirmedClusters.length,
          advisoryCount: meta.advisories.length,
          consensusPolicy: meta.consensusPolicy,
          consensusThreshold: meta.consensusThreshold,
          panelHealth: meta.panelHealth,
        }
      : undefined;
    const actionable = meta.findings
      .filter((finding) => finding.actionable)
      .map((finding, i) => ({ id: finding.id ?? `F${i + 1}`, summary: finding.summary, ...(finding.path ? { path: finding.path } : {}) }));

    // Cross-round comparison: advisory bookkeeping only. A matcher failure
    // degrades to "no comparison" — it must never kill the loop.
    let comparison: RoundComparison | undefined;
    if (options.matcher && previousActionable !== undefined) {
      try {
        comparison = await compareRoundFindings(previousActionable, actionable, options.matcher);
      } catch {
        comparison = undefined;
      }
    }

    rounds.push({
      index,
      status: meta.status,
      verdict: meta.verdict,
      durationMs: meta.durationMs,
      findingCount: meta.findings.length,
      actionableCount: meta.actionableCount,
      ...(meta.thinking ? { thinking: meta.thinking } : {}),
      ...(meta.usage ? { usage: meta.usage } : {}),
      ...(panel ? { panel } : {}),
      ...(comparison ? { comparison } : {}),
    });

    // Success goal or immediate escalation — never treat has_findings as clean.
    if (meta.status === "clean" || meta.status === "needs_human" || meta.status === "blocked") {
      return {
        rounds,
        finalStatus: meta.status,
        stopReason: meta.status,
        exitCode: reviewExitCode(meta.status),
        maxRounds,
        ...(until ? { until } : {}),
      };
    }

    // Non-convergence: under --until clean, an actionable set identical to the
    // previous round means the gate cannot move without host edits (the tree
    // is frozen between rounds), so more rounds are dice rolls. Stop early and
    // hand back to the host.
    if (
      until === "clean" &&
      comparison &&
      comparison.persisting > 0 &&
      comparison.added === 0 &&
      comparison.resolved === 0
    ) {
      return {
        rounds,
        finalStatus: "has_findings",
        stopReason: "non_converging",
        exitCode: reviewExitCode("has_findings"),
        maxRounds,
        until,
      };
    }

    previousActionable = actionable;
  }

  return {
    rounds,
    finalStatus: "has_findings",
    stopReason: "budget_exhausted",
    exitCode: reviewExitCode("has_findings"),
    maxRounds,
    ...(until ? { until } : {}),
  };
}

function isPanelMeta(meta: ReviewMeta): meta is PanelReviewMeta {
  return (meta as { strategy?: string }).strategy === "panel";
}
