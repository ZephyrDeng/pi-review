import { formatDurationMs, formatUsage } from "./meta-footer.js";
import { reviewExitCode } from "./review-result.js";
import type { PanelReviewMeta, ReviewMeta, ReviewRunResult, ReviewStatus, Verdict } from "./types.js";

export type LoopStopReason = "clean" | "budget_exhausted" | "needs_human" | "blocked";

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
}

export type RunOneReview = (roundIndex: number) => Promise<ReviewRunResult>;

function displayEnum(value: string): string {
  return value.replaceAll("_", " ").toUpperCase();
}

export function formatLoopSummary(result: LoopReviewResult): string {
  const lines = ["── pi-review loop " + "─".repeat(23)];
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

/** Runs isolated review rounds through an injected single-run adapter. */
export async function runReviewLoop(
  maxRounds: number,
  runOneReview: RunOneReview,
): Promise<LoopReviewResult> {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError("maxRounds must be a positive integer");
  }

  const rounds: LoopRoundSummary[] = [];
  for (let index = 1; index <= maxRounds; index += 1) {
    const run = await runOneReview(index);
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

    if (meta.status === "clean" || meta.status === "needs_human" || meta.status === "blocked") {
      return {
        rounds,
        finalStatus: meta.status,
        stopReason: meta.status,
        exitCode: reviewExitCode(meta.status),
      };
    }
  }

  return {
    rounds,
    finalStatus: "has_findings",
    stopReason: "budget_exhausted",
    exitCode: reviewExitCode("has_findings"),
  };
}

function isPanelMeta(meta: ReviewMeta): meta is PanelReviewMeta {
  return (meta as { strategy?: string }).strategy === "panel";
}
