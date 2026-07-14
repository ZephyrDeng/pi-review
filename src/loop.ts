import { formatDurationMs } from "./meta-footer.js";
import { reviewExitCode } from "./review-result.js";
import type { ReviewRunResult, ReviewStatus, Verdict } from "./types.js";

export type LoopStopReason = "clean" | "budget_exhausted" | "needs_human" | "blocked";

export interface LoopRoundSummary {
  index: number;
  status: ReviewStatus;
  verdict: Verdict;
  durationMs: number;
  findingCount: number;
  actionableCount: number;
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
    lines.push(
      `  Round ${round.index}  ${displayEnum(round.status)} | ${displayEnum(round.verdict)} | ${round.actionableCount} actionable / ${round.findingCount} total | ${formatDurationMs(round.durationMs)}`,
    );
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
    rounds.push({
      index,
      status: meta.status,
      verdict: meta.verdict,
      durationMs: meta.durationMs,
      findingCount: meta.findings.length,
      actionableCount: meta.actionableCount,
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
