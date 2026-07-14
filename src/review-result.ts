import type { ReviewFinding, ReviewStatus, StructuredReviewResult, VerdictInfo } from "./types.js";
import { parseVerdict } from "./verdict.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownSection(markdown: string, heading: string): string {
  const escaped = escapeRegExp(heading);
  return markdown.match(new RegExp(`(?:^|\\n)##\\s*${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"))?.[1]?.trim() ?? "";
}

function field(block: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  return block.match(new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim();
}

const SEVERITY_PREFIX = /^(critical|high|medium|low|info|warning)\s*[:—-]\s*/i;

interface FindingBlock {
  header: string;
  index: number;
  length: number;
  listId?: string;
}

function findingBlocks(section: string): FindingBlock[] {
  const headings = [...section.matchAll(/^###\s+(.+?)\s*$/gm)].map((match) => ({
    header: match[1]!,
    index: match.index ?? 0,
    length: match[0].length,
  }));
  if (headings.length > 0) return headings;

  return [...section.matchAll(/^(?:[-*]|(\d+)[.)])\s+(.+?)\s*$/gm)].map((match) => ({
    header: match[2]!,
    index: match.index ?? 0,
    length: match[0].length,
    ...(match[1] ? { listId: match[1] } : {}),
  }));
}

function parseStructuredFindings(markdown: string, verdictInfo: VerdictInfo): ReviewFinding[] {
  const section = markdownSection(markdown, "Findings");
  const blocks = findingBlocks(section);

  return blocks.map((entry, index) => {
    const plainHeader = entry.header.replace(/[*_]/g, "").trim();
    const idParts = plainHeader.match(/^([A-Za-z]+\d+|\d+)[.):\s-]+(.+)$/);
    let summary = (idParts?.[2] ?? plainHeader).trim();
    const severityFromHeader = summary.match(SEVERITY_PREFIX)?.[1]?.toLowerCase();
    summary = summary.replace(SEVERITY_PREFIX, "");
    const pathFromHeader = summary.match(/`([^`]+)`/)?.[1];
    if (pathFromHeader) summary = summary.replace(/`[^`]+`\s*[:—-]?\s*/, "");

    const blockStart = entry.index + entry.length;
    const blockEnd = blocks[index + 1]?.index ?? section.length;
    const block = section.slice(blockStart, blockEnd);
    const severity = field(block, "Severity")?.toLowerCase() ?? severityFromHeader;
    const rawPath = field(block, "Path")?.replace(/^`|`$/g, "") ?? pathFromHeader;
    const findingPath = rawPath && !/^(?:none|n\/a|-)$/i.test(rawPath) ? rawPath : undefined;
    const actionableField = field(block, "Actionable");
    const actionable = actionableField === undefined
      ? verdictInfo.verdict === "request_changes"
      : /^(?:yes|true)$/i.test(actionableField);
    const id = entry.listId ?? idParts?.[1];

    return {
      ...(id ? { id } : {}),
      ...(severity ? { severity } : {}),
      ...(findingPath ? { path: findingPath } : {}),
      summary: summary.replace(/[`*_]/g, "").trim(),
      actionable,
    };
  });
}

const REVIEW_EXIT_CODE: Record<ReviewStatus, number> = {
  clean: 0,
  has_findings: 1,
  needs_human: 3,
  blocked: 4,
};

export function reviewExitCode(status: ReviewStatus): number {
  return REVIEW_EXIT_CODE[status];
}

/** Derives the machine review contract from the human-readable conclusion. */
export function parseReviewResult(
  markdown: string,
  verdictInfo: VerdictInfo = parseVerdict(markdown),
): StructuredReviewResult {
  const findings = parseStructuredFindings(markdown, verdictInfo);
  const actionableCount = findings.filter((finding) => finding.actionable).length;

  let status: StructuredReviewResult["status"];
  switch (verdictInfo.verdict) {
    case "approve":
      status = "clean";
      break;
    case "request_changes":
      status = "has_findings";
      break;
    case "needs_clarification":
      status = "needs_human";
      break;
    case "blocked":
      status = "blocked";
      break;
  }

  if (verdictInfo.verdict === "approve" && actionableCount > 0) status = "has_findings";

  return {
    ...verdictInfo,
    status,
    findings,
    actionableCount,
  };
}
