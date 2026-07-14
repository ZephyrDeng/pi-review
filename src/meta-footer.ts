import type { PanelReviewMeta, ReviewMeta } from "./types.js";

const VERDICT_DISPLAY: Record<ReviewMeta["verdict"], { label: string; mark: string }> = {
  approve: { label: "APPROVE", mark: "✓" },
  request_changes: { label: "REQUEST CHANGES", mark: "!" },
  needs_clarification: { label: "NEEDS CLARIFICATION", mark: "?" },
  blocked: { label: "BLOCKED", mark: "×" },
};

const STATUS_DISPLAY: Record<ReviewMeta["status"], string> = {
  clean: "CLEAN",
  has_findings: "HAS FINDINGS",
  needs_human: "NEEDS HUMAN",
  blocked: "BLOCKED",
};

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Format a token count with K/M/B units (1024-based). */
export function formatTokens(n: number): string {
  if (n < 1024) return `${n}`;
  const units = ["K", "M", "B"];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value < 100 ? 1 : 0;
  return `${value.toFixed(digits)}${units[unitIndex]}`;
}

/** Format a token-usage breakdown as "in/out/cache/reason" for compact display. */
export function formatUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }): string {
  return `${formatTokens(usage.input)}in / ${formatTokens(usage.output)}out / ${formatTokens(usage.cacheRead + usage.cacheWrite)}cache / ${formatTokens(usage.reasoning)}reason`;
}

function padLabel(label: string, width: number): string {
  return label.length >= width ? label : label + " ".repeat(width - label.length);
}

/** Human-readable ASCII footer for terminals and Pi chat. */
export function formatReviewMetaAscii(meta: ReviewMeta): string {
  const v = VERDICT_DISPLAY[meta.verdict];
  const labelW = 10;
  const lines: string[] = [
    "── pi-review " + "─".repeat(28),
    `  ${padLabel("Verdict", labelW)}  ${v.mark} ${v.label}`,
    `  ${padLabel("Status", labelW)}  ${STATUS_DISPLAY[meta.status]}`,
    `  ${padLabel("Mode", labelW)}  ${meta.reviewMode}`,
  ];
  if (meta.findings.length > 0) {
    lines.push(`  ${padLabel("Findings", labelW)}  ${meta.actionableCount} actionable / ${meta.findings.length} total`);
  }
  if (meta.model) lines.push(`  ${padLabel("Model", labelW)}  ${meta.model}`);
  if (meta.thinking) lines.push(`  ${padLabel("Thinking", labelW)}  ${meta.thinking}`);
  if (meta.usage) lines.push(`  ${padLabel("Tokens", labelW)}  ${formatUsage(meta.usage)}`);
  lines.push(`  ${padLabel("Duration", labelW)}  ${formatDurationMs(meta.durationMs)}`);
  if (meta.sessionHandle) {
    lines.push(`  ${padLabel("Session", labelW)}  ${meta.sessionHandle}`);
    lines.push(`  ${padLabel("", labelW)}  (use /rv --continue <path>)`);
  }
  if (meta.parseError) {
    lines.push(`  ${padLabel("Note", labelW)}  ${meta.parseError}`);
  }
  lines.push("─".repeat(42));
  return lines.join("\n");
}

/** Machine-readable line for scripts (written to stderr by default). */
export function formatReviewMetaJsonLine(meta: ReviewMeta): string {
  return `PI_REVIEW_META_JSON: ${JSON.stringify(meta)}\n`;
}

/** Human-readable Markdown body for a panel evaluation (confirmed findings + advisories). */
export function formatPanelFindingsMarkdown(meta: PanelReviewMeta): string {
  const lines: string[] = [];
  if (meta.confirmedClusters.length > 0) {
    lines.push("## Panel Findings (confirmed)");
    for (const c of meta.confirmedClusters) {
      lines.push(`### ${c.id}: ${c.summary}`);
      if (c.severity) lines.push(`- Severity: ${c.severity}`);
      if (c.path) lines.push(`- Path: ${c.path}`);
      lines.push(`- Support: ${c.supportCount}/${meta.configuredReviewers} reviewers (${c.actionableSupportCount} actionable)`);
      lines.push(`- Reviewers: ${c.supportingReviewerIds.join(", ")}`);
      lines.push(`- Source findings: ${c.sourceFindingIds.join(", ")}`);
    }
  }
  if (meta.advisories.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Panel Advisories (non-blocking — do not affect gate status)");
    for (const c of meta.advisories) {
      lines.push(`### ${c.id}: ${c.summary}`);
      if (c.severity) lines.push(`- Severity: ${c.severity}`);
      if (c.path) lines.push(`- Path: ${c.path}`);
      lines.push(`- Support: ${c.supportCount}/${meta.configuredReviewers} reviewers (${c.actionableSupportCount} actionable)`);
      lines.push(`- Reviewers: ${c.supportingReviewerIds.join(", ")}`);
      lines.push(`- Source findings: ${c.sourceFindingIds.join(", ")}`);
      lines.push(`- Confirmed: no`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "";
}

/** Human-readable ASCII footer for a panel evaluation. */
export function formatPanelMetaAscii(meta: PanelReviewMeta): string {
  const labelW = 10;
  const lines: string[] = [
    "── pi-review panel " + "─".repeat(21),
    `  ${padLabel("Status", labelW)}  ${STATUS_DISPLAY[meta.status]}`,
    `  ${padLabel("Health", labelW)}  ${meta.panelHealth.toUpperCase()}`,
    `  ${padLabel("Mode", labelW)}  ${meta.reviewMode}`,
    `  ${padLabel("Reviewers", labelW)}  ${meta.successfulReviewers}/${meta.configuredReviewers} successful`,
    `  ${padLabel("Consensus", labelW)}  ${meta.consensusPolicy} (threshold ${meta.consensusThreshold})`,
    `  ${padLabel("Confirmed", labelW)}  ${meta.confirmedClusters.length} actionable`,
    `  ${padLabel("Advisories", labelW)}  ${meta.advisories.length} non-blocking`,
  ];
  if (meta.panelPreset) lines.push(`  ${padLabel("Panel", labelW)}  ${meta.panelPreset}`);
  if (meta.thinking) lines.push(`  ${padLabel("Thinking", labelW)}  ${meta.thinking}`);
  if (meta.usage) lines.push(`  ${padLabel("Tokens", labelW)}  ${formatUsage(meta.usage)}`);
  if (meta.adjudicationUsed) lines.push(`  ${padLabel("Adjudicator", labelW)}  used`);
  if (meta.adjudicationErrors?.length) {
    lines.push(`  ${padLabel("Note", labelW)}  ${meta.adjudicationErrors.join("; ")}`);
  }
  lines.push(`  ${padLabel("Duration", labelW)}  ${formatDurationMs(meta.durationMs)}`);
  lines.push("  Reviewers:");
  for (const r of meta.reviewers) {
    const bits = [
      r.reviewerId,
      STATUS_DISPLAY[r.status],
      r.verdict,
      ...(r.role ? [`role:${r.role.split(" ")[0]}`] : []),
      ...(r.model ? [r.model] : []),
      ...(r.thinking ? [`think:${r.thinking}`] : []),
      ...(r.usage ? [formatUsage(r.usage)] : []),
      formatDurationMs(r.durationMs),
    ];
    lines.push(`    - ${bits.join(" | ")}`);
  }
  lines.push("─".repeat(42));
  return lines.join("\n");
}