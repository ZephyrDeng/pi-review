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
/** Placeholder values that mean "not supplied" for optional single-value fields (Path, Lines). */
const NONE_PLACEHOLDER = /^(?:none|n\/a|-)$/i;
/** A single line ("42") or an inclusive line range ("42-58"); anything else is not parseable. */
const LINE_RANGE_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;

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

/** Join the reviewer's Evidence/Impact fields into `details`, preserving labels and tolerating partial content. */
function joinDetails(evidence: string | undefined, impact: string | undefined): string | undefined {
  const parts: string[] = [];
  if (evidence) parts.push(`Evidence: ${evidence}`);
  if (impact) parts.push(`Impact: ${impact}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Parse the optional Lines/Side fields into a location. Non-numeric, zero,
 * negative, or inverted (endLine < startLine) values are dropped rather than
 * fabricated. `side` is only ever set to "base"; every other value (absent,
 * unrecognized, or explicitly "working") is omitted, meaning "working".
 */
function parseFindingLocation(block: string): ReviewFinding["location"] {
  const raw = field(block, "Lines");
  if (!raw || NONE_PLACEHOLDER.test(raw)) return undefined;
  const match = raw.match(LINE_RANGE_PATTERN);
  if (!match) return undefined;
  const startLine = Number(match[1]);
  const endLine = match[2] !== undefined ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(startLine) || startLine <= 0) return undefined;
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= 0 || endLine < startLine)) return undefined;
  const side = field(block, "Side")?.toLowerCase() === "base" ? ("base" as const) : undefined;
  return {
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    ...(side ? { side } : {}),
  };
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
    const findingPath = rawPath && !NONE_PLACEHOLDER.test(rawPath) ? rawPath : undefined;
    const actionableField = field(block, "Actionable");
    const actionable = actionableField === undefined
      ? verdictInfo.verdict === "request_changes"
      : /^(?:yes|true)$/i.test(actionableField);
    const id = entry.listId ?? idParts?.[1];
    const details = joinDetails(field(block, "Evidence"), field(block, "Impact"));
    const recommendation = field(block, "Recommendation");
    const location = parseFindingLocation(block);

    return {
      ...(id ? { id } : {}),
      ...(severity ? { severity } : {}),
      ...(findingPath ? { path: findingPath } : {}),
      summary: summary.replace(/[`*_]/g, "").trim(),
      actionable,
      ...(details ? { details } : {}),
      ...(recommendation ? { recommendation } : {}),
      ...(location ? { location } : {}),
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
