import type { VerdictInfo } from "./types.js";
import { VERDICTS } from "./types.js";

export function parseVerdict(stdout: string): VerdictInfo {
  const headingMatch = stdout.match(/(?:^|\n)##\s*Verdict\s*\n+([\s\S]*?)(?=\n##\s+|$)/i);
  const candidates: string[] = [];
  if (headingMatch) candidates.push(headingMatch[1]);
  candidates.push(stdout);

  for (const text of candidates) {
    const normalized = text.toLowerCase().replace(/[`*_]/g, " ");
    for (const verdict of VERDICTS) {
      const pattern = new RegExp(`(^|[^a-z_])${verdict.replace("_", "[_ -]")}([^a-z_]|$)`, "i");
      if (pattern.test(normalized)) return { verdict, verdictSource: "parsed" };
    }
  }

  return {
    verdict: "needs_clarification",
    verdictSource: "fallback",
    parseError: "Could not parse ## Verdict as a known enum",
  };
}
