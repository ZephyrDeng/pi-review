import fs from "node:fs";
import path from "node:path";
import type { PanelReviewerSpec, ReviewPreset, SplitPayload } from "./types.js";
import { VERDICTS } from "./types.js";
import type { AdjudicationCandidate } from "./matcher.js";

function contractSections(mode: string, preset: ReviewPreset): string[] {
  return [
    `You are running pi-review mode \`${mode}\`.`,
    "Your job is to produce a review conclusion only. Do not edit files, do not write files, do not produce patches, and do not claim implementation work was done.",
    preset.instructions || "Review the supplied material and return a concise conclusion.",
    `Output Markdown with exactly these top-level sections:\n\n## Verdict\nOne of: ${VERDICTS.join(" | ")}\n\n## Summary\nShort conclusion in 2-5 bullets.\n\n## Findings\nPrioritized findings. For every material finding, use this exact shape (increment IDs as F1, F2, ...):\n\n### F1: <summary>\n- Severity: critical | high | medium | low\n- Path: <path or none>\n- Actionable: yes | no\n- Evidence: <concrete evidence>\n- Impact: <why it matters>\n- Recommendation: <specific next step>\n\nSet Actionable to yes when the host must fix or consciously reject the finding before clean closeout. Use no for informational or explicitly out-of-scope follow-up findings. If there are no material findings, write "No material findings."\n\n## Risks and Blind Spots\nWhat could still be wrong, missing, or unverified.\n\n## Open Questions\nQuestions the parent agent or user should answer before acting. If none, write "None."`,
  ];
}

function targetSections(payload: SplitPayload, stdinText: string): string[] {
  const sections: string[] = [];
  const attachable = payload.attachableFileRefs ?? payload.fileRefs;
  const pathTargets = payload.pathTargets ?? [];
  if (payload.userText) {
    sections.push(`<user-request>\n${payload.userText}\n</user-request>`);
  }
  if (stdinText) {
    sections.push(`<stdin>\n${stdinText}\n</stdin>`);
  }
  if (pathTargets.length > 0) {
    sections.push(
      `Review these path targets with read-only tools (directories are not attached as files): ${pathTargets.join(" ")}`,
    );
  }
  if (attachable.length > 0) {
    sections.push(`Review the attached file reference(s): ${attachable.join(" ")}`);
  }
  if (!payload.userText && !stdinText && attachable.length === 0 && pathTargets.length === 0) {
    sections.push("No explicit target was provided. Return blocked and explain what input is required.");
  }
  return sections;
}

export function splitPayload(payload: string[]): SplitPayload {
  const fileRefs: string[] = [];
  const textParts: string[] = [];
  for (const item of payload) {
    if (item.startsWith("@")) fileRefs.push(item);
    else textParts.push(item);
  }
  return { fileRefs, userText: textParts.join(" ").trim() };
}

/** Classify @refs so directories become tool path targets instead of Pi file attachments. */
export function normalizePayloadRefs(payload: SplitPayload, cwd = process.cwd()): SplitPayload {
  const attachableFileRefs: string[] = [];
  const pathTargets: string[] = [];
  for (const ref of payload.fileRefs) {
    const raw = ref.startsWith("@") ? ref.slice(1) : ref;
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    try {
      if (fs.statSync(resolved).isDirectory()) {
        pathTargets.push(raw);
        continue;
      }
    } catch {
      // Missing paths still go as file refs so Pi/reviewer can report them.
    }
    attachableFileRefs.push(ref);
  }
  return {
    ...payload,
    attachableFileRefs,
    pathTargets,
  };
}

export function buildPrompt(mode: string, preset: ReviewPreset, payload: SplitPayload, stdinText: string): string {
  return [...contractSections(mode, preset), ...targetSections(payload, stdinText)].join("\n\n");
}

/**
 * Reviewer prompt for panel review: the shared review contract plus a stable
 * reviewer identity/role. Reviewers never receive another reviewer's output.
 */
export function buildReviewerPrompt(
  mode: string,
  preset: ReviewPreset,
  payload: SplitPayload,
  stdinText: string,
  reviewer?: PanelReviewerSpec,
): string {
  const preamble = reviewer
    ? [
        "You are an independent panel reviewer.",
        `- Reviewer ID: ${reviewer.id}`,
        `- Role: ${reviewer.role}`,
        "You cannot see other reviewers' findings. Submit your own independent conclusion only.",
      ].join("\n")
    : "";
  return [preamble, ...contractSections(mode, preset), ...targetSections(payload, stdinText)]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Strict clustering contract for the consensus adjudicator. It receives
 * structured findings only, returns cluster assignments with confidence, and
 * may not invent findings, drop findings, claim new evidence, or act as a
 * reviewer. It has no write tools.
 */
export function buildAdjudicatorPrompt(candidates: AdjudicationCandidate[]): string {
  const candidateBlocks = candidates.map((candidate, index) => {
    const items = candidate.findings.map(
      (sf) =>
        `- id: ${sf.id}\n  reviewer: ${sf.reviewerId}\n  path: ${sf.finding.path ?? "(none)"}\n  summary: ${sf.finding.summary}\n  actionable: ${sf.finding.actionable ? "yes" : "no"}`,
    );
    return `Candidate group ${index + 1} (shared path anchor: ${candidate.anchorPath || "(none)"}):\n${items.join("\n")}`;
  });

  return [
    "You are the consensus adjudicator for a panel code review. Your only job is to decide which findings describe the same underlying issue.",
    "You are aggregation-only. You may not invent new findings, drop findings, add evidence, or act as an additional reviewer. You have no write tools.",
    "Below are candidate groups of findings that share a file path but differ in wording. For each set of findings that you determine describe the same underlying issue, propose a merge.",
    "Only merge findings that genuinely describe the same underlying issue. When unsure, do not merge.",
    "Respond with one JSON object only, no prose, in this exact shape:",
    '{"merges":[{"sourceFindingIds":["r1#F1","r2#F1"],"confidence":0.9}]}',
    "`confidence` is a number between 0 and 1 expressing how sure you are that the listed findings are the same issue. Use 0 when unrelated. Every source id you reference must come from the candidates below.",
    "Candidate findings:",
    candidateBlocks.join("\n\n"),
  ].join("\n\n");
}
