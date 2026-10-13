import type { TokenUsage } from "./types.js";

/**
 * Combine final usage from independent reviewer sessions.
 */
export function sumPanelUsage(usages: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = usages.filter((usage): usage is TokenUsage => Boolean(usage));
  if (present.length === 0) return undefined;
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  for (const usage of present) {
    total.input += usage.input;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.output += usage.output;
    total.reasoning += usage.reasoning;
    total.totalTokens += usage.totalTokens;
    if (typeof usage.costTotal === "number") total.costTotal = (total.costTotal ?? 0) + usage.costTotal;
  }
  return total;
}
