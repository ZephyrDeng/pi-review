import type { ReviewPreset, SplitPayload } from "./types.js";
import { VERDICTS } from "./types.js";

export function splitPayload(payload: string[]): SplitPayload {
  const fileRefs: string[] = [];
  const textParts: string[] = [];
  for (const item of payload) {
    if (item.startsWith("@")) fileRefs.push(item);
    else textParts.push(item);
  }
  return { fileRefs, userText: textParts.join(" ").trim() };
}

export function buildPrompt(mode: string, preset: ReviewPreset, payload: SplitPayload, stdinText: string): string {
  const sections: string[] = [
    `You are running pi-review mode \`${mode}\`.`,
    "Your job is to produce a review conclusion only. Do not edit files, do not write files, do not produce patches, and do not claim implementation work was done.",
    preset.instructions || "Review the supplied material and return a concise conclusion.",
    `Output Markdown with exactly these top-level sections:\n\n## Verdict\nOne of: ${VERDICTS.join(" | ")}\n\n## Summary\nShort conclusion in 2-5 bullets.\n\n## Findings\nPrioritized findings. For every material finding, use this exact shape (increment IDs as F1, F2, ...):\n\n### F1: <summary>\n- Severity: critical | high | medium | low\n- Path: <path or none>\n- Actionable: yes | no\n- Evidence: <concrete evidence>\n- Impact: <why it matters>\n- Recommendation: <specific next step>\n\nSet Actionable to yes when the host must fix or consciously reject the finding before clean closeout. Use no for informational or explicitly out-of-scope follow-up findings. If there are no material findings, write "No material findings."\n\n## Risks and Blind Spots\nWhat could still be wrong, missing, or unverified.\n\n## Open Questions\nQuestions the parent agent or user should answer before acting. If none, write "None."`,
  ];

  if (payload.userText) {
    sections.push(`<user-request>\n${payload.userText}\n</user-request>`);
  }
  if (stdinText) {
    sections.push(`<stdin>\n${stdinText}\n</stdin>`);
  }
  if (payload.fileRefs.length > 0) {
    sections.push(`Review the attached file reference(s): ${payload.fileRefs.join(" ")}`);
  }
  if (!payload.userText && !stdinText && payload.fileRefs.length === 0) {
    sections.push("No explicit target was provided. Return blocked and explain what input is required.");
  }

  return sections.join("\n\n");
}
