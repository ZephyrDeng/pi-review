import { formatDurationMs, formatUsage } from "./meta-footer.js";
import { reviewExitCode } from "./review-result.js";
import type { PanelReviewMeta, ReviewMeta, ReviewRunResult, ReviewStatus, Verdict } from "./types.js";

export type LoopStopReason = "clean" | "budget_exhausted" | "needs_human" | "blocked";
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
