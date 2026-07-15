import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  createPanelViewState,
  formatCost,
  formatDurationMs,
  formatPanelMetaAscii,
  formatTokens,
  formatUsage,
  reducePanelEvent,
  spawnStreamingChild,
  type PanelReviewMeta,
  type PanelViewState,
  type ReviewEvent,
} from "@zephyrdeng/pi-review";

type Theme = { fg: (color: "toolTitle" | "muted" | "error" | "success" | "accent", text: string) => string; bold: (text: string) => string };
type PanelToolDetails = { state: PanelViewState; error?: string };
type PanelUi = { setStatus?: (key: string, text: string | undefined) => void };
type PanelToolContext = { ui?: PanelUi };

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(extensionDir, "../bin/pi-review.js");
const PANEL_TOOL_DISPLAY_NAME = "Pi Review Panel";
const PANEL_STATUS_KEY = "pi-review";
const LIVE_TICK_MS = 2000;

function duration(ms: number | undefined): string {
  if (!ms) return "0s";
  return `${Math.floor(ms / 1000)}s`;
}

function usageTokens(state: PanelViewState): string {
  const usage = state.aggregate.usage;
  if (!usage) return "—";
  const cost = typeof usage.costTotal === "number" ? formatCost(usage.costTotal) : "n/a";
  return `${formatTokens(usage.totalTokens)} tok · cost ${cost}`;
}

function statusSymbol(status: string): string {
  return status === "completed" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : status === "running" ? "●" : "○";
}

function compactText(state: PanelViewState, theme: Theme, now = Date.now()): string {
  const elapsed = state.startedAt ? duration((state.completedAt ?? now) - state.startedAt) : "0s";
  const progress = `${state.aggregate.completed}/${state.aggregate.total} completed`;
  const header = theme.fg("toolTitle", theme.bold(`${PANEL_TOOL_DISPLAY_NAME} ${progress}`)) + theme.fg("muted", ` · ${state.phase} · ${elapsed} · ${usageTokens(state)}`);
  const rows = Object.values(state.reviewers).map((reviewer) => {
    const lifecycle = ` · ${reviewer.status}`;
    const model = reviewer.model ? ` · ${reviewer.model}` : "";
    const thinking = reviewer.thinking ? ` · ${reviewer.thinking}` : "";
    const active = reviewer.activeTool ? ` · ${reviewer.activeTool}` : "";
    const activeSummary = reviewer.activeToolSummary ? ` · ${reviewer.activeToolSummary}` : "";
    const reviewerElapsed = reviewer.startedAt ? ` · ${duration((reviewer.completedAt ?? now) - reviewer.startedAt)}` : "";
    const idle = reviewer.status === "running" && reviewer.activityAt ? ` · idle ${duration(now - reviewer.activityAt)}` : "";
    const tokens = reviewer.usage ? ` · ${formatTokens(reviewer.usage.totalTokens)} tok` : "";
    const cost = reviewer.usage ? ` · cost ${typeof reviewer.usage.costTotal === "number" ? formatCost(reviewer.usage.costTotal) : "n/a"}` : "";
    return `${theme.fg(reviewer.status === "failed" ? "error" : reviewer.status === "completed" ? "success" : "accent", statusSymbol(reviewer.status))} ${theme.fg("toolTitle", reviewer.reviewerId)}${theme.fg("muted", ` ${reviewer.role}${lifecycle}${model}${thinking}${active}${activeSummary}${reviewerElapsed}${idle}${tokens}${cost}`)}`;
  });
  return [header, ...rows].join("\n");
}

/** Expand hint that respects configured keybindings when available. */
export function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

/** Plain-text findings list (no markdown). Pi TUI does not render markdown. */
export function formatFindingsPlain(meta: PanelReviewMeta): string {
  const lines: string[] = [];
  if (meta.confirmedClusters.length > 0) {
    lines.push("Confirmed findings:");
    for (const c of meta.confirmedClusters) {
      const bits = [
        c.summary,
        c.severity,
        c.path,
        `${c.supportCount}/${meta.configuredReviewers} reviewers`,
        c.supportingReviewerIds.join(", "),
      ].filter(Boolean);
      lines.push(`  - ${bits.join(" · ")}`);
    }
  }
  if (meta.advisories.length > 0) {
    lines.push("Advisories (non-blocking):");
    for (const c of meta.advisories) {
      const bits = [
        c.summary,
        c.severity,
        c.path,
        `${c.supportCount}/${meta.configuredReviewers} reviewers`,
        c.supportingReviewerIds.join(", "),
      ].filter(Boolean);
      lines.push(`  - ${bits.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

function reviewerSummaryLines(state: PanelViewState): string[] {
  const fromMeta = state.meta?.reviewers ?? [];
  if (fromMeta.length > 0) {
    return fromMeta.map((reviewer) => {
      const live = state.reviewers[reviewer.reviewerId];
      const role = reviewer.role ? ` · ${reviewer.role}` : "";
      const model = reviewer.model ? ` · ${reviewer.model}` : "";
      const thinking = reviewer.thinking ? ` · ${reviewer.thinking}` : "";
      const usage = reviewer.usage ? ` · ${formatTokens(reviewer.usage.totalTokens)} tok · ${formatUsage(reviewer.usage)}` : "";
      const cost = reviewer.usage ? ` · cost ${typeof reviewer.usage.costTotal === "number" ? formatCost(reviewer.usage.costTotal) : "n/a"}` : "";
      const head = `- ${reviewer.reviewerId}${role}${model}${thinking} · ${reviewer.status} · ${reviewer.verdict} · ${formatDurationMs(reviewer.durationMs)}${usage}${cost}`;
      const findings = live?.submission?.result.findings?.map((finding) => finding.summary).filter(Boolean).slice(0, 5) ?? [];
      if (findings.length > 0) return `${head}\n  ${findings.map((summary) => `• ${summary}`).join("\n  ")}`;
      if (reviewer.runtimeError || reviewer.parseError) return `${head}\n  • ${reviewer.runtimeError ?? reviewer.parseError}`;
      if (live?.error) return `${head}\n  • ${live.error}`;
      return head;
    });
  }
  return Object.values(state.reviewers).map((reviewer) => {
    const role = reviewer.role ? ` · ${reviewer.role}` : "";
    const model = reviewer.model ? ` · ${reviewer.model}` : "";
    const thinking = reviewer.thinking ? ` · ${reviewer.thinking}` : "";
    const status = reviewer.submission?.result.status ?? reviewer.status;
    const verdict = reviewer.submission?.result.verdict ? ` · ${reviewer.submission.result.verdict}` : "";
    const durationMs = reviewer.startedAt ? (reviewer.completedAt ?? Date.now()) - reviewer.startedAt : undefined;
    const usage = reviewer.usage ? ` · ${formatTokens(reviewer.usage.totalTokens)} tok · ${formatUsage(reviewer.usage)}` : "";
    const cost = reviewer.usage ? ` · cost ${typeof reviewer.usage.costTotal === "number" ? formatCost(reviewer.usage.costTotal) : "n/a"}` : "";
    const head = `- ${reviewer.reviewerId}${role}${model}${thinking} · ${status}${verdict}${durationMs !== undefined ? ` · ${formatDurationMs(durationMs)}` : ""}${usage}${cost}`;
    const findings = reviewer.submission?.result.findings?.map((finding) => finding.summary).filter(Boolean).slice(0, 5) ?? [];
    if (findings.length > 0) return `${head}\n  ${findings.map((summary) => `• ${summary}`).join("\n  ")}`;
    if (reviewer.error) return `${head}\n  • ${reviewer.error}`;
    return head;
  });
}

/**
 * Full panel conclusion for the parent LLM and expanded TUI.
 * Pure plain text / ASCII only — Pi does not render markdown in tool results.
 */
export function buildPanelResultContent(state: PanelViewState, error?: string): string {
  const meta = state.meta;
  if (!meta && !error) return "Panel completed: unknown";
  if (!meta) return error ?? "Panel completed: unknown";

  const findings = formatFindingsPlain(meta);
  const ascii = formatPanelMetaAscii(meta);
  const summaries = reviewerSummaryLines(state);
  const parts = [
    findings,
    ascii,
    summaries.length ? `Reviewer summaries:\n${summaries.join("\n")}` : "",
    error ? `Error:\n${error}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

function ambientStatus(state: PanelViewState, now = Date.now()): string {
  const elapsed = state.startedAt ? duration((state.completedAt ?? now) - state.startedAt) : "0s";
  const running = state.aggregate.running;
  const phase = state.phase === "aggregating" ? "aggregating" : state.phase;
  const runningBit = running > 0 ? ` · ${running} running` : "";
  return `● panel ${state.aggregate.completed}/${state.aggregate.total}${runningBit} · ${phase} · ${elapsed}`;
}

function setAmbientStatus(ctx: PanelToolContext | undefined, text: string | undefined): void {
  try {
    ctx?.ui?.setStatus?.(PANEL_STATUS_KEY, text);
  } catch {
    // Non-interactive / print hosts may not implement status chrome.
  }
}

/**
 * Stable tool-result component reused across onUpdate renders.
 * Collapsed and expanded paths mutate the same child instances instead of rebuilding trees.
 */
export class PanelResultView implements Component {
  private readonly compact = new Text("", 0, 0);
  private readonly activity = new Text("", 0, 0);
  private readonly conclusion = new Text("", 0, 0);
  private readonly error = new Text("", 0, 0);
  private showActivity = false;
  private showConclusion = false;
  private showError = false;

  update(details: PanelToolDetails, expanded: boolean, theme: Theme, isPartial = false, now = Date.now()): void {
    const body = compactText(details.state, theme, now);
    if (!expanded) {
      // Discoverability: host expand binding (default ctrl+o).
      this.compact.setText(`${body}\n${expandHint()}`);
      this.showActivity = false;
      this.showConclusion = false;
      this.showError = Boolean(details.error);
      if (details.error) this.error.setText(theme.fg("error", details.error));
      return;
    }

    this.compact.setText(body);
    const activityBlocks = Object.values(details.state.reviewers)
      .filter((reviewer) => reviewer.recentActivity.length > 0)
      .map((reviewer) => `${theme.fg("muted", `${reviewer.reviewerId} activity`)}\n${reviewer.recentActivity.join("\n")}`);
    this.showActivity = activityBlocks.length > 0;
    if (this.showActivity) this.activity.setText(activityBlocks.join("\n\n"));

    // Plain Text only — Pi does not render markdown in tool result components.
    const conclusion = !isPartial && details.state.meta ? buildPanelResultContent(details.state) : "";
    this.showConclusion = Boolean(conclusion);
    if (conclusion) this.conclusion.setText(conclusion);

    this.showError = Boolean(details.error);
    if (details.error) this.error.setText(theme.fg("error", details.error));
  }

  invalidate(): void {
    this.compact.invalidate();
    this.activity.invalidate();
    this.conclusion.invalidate();
    this.error.invalidate();
  }

  render(width: number): string[] {
    const lines = [...this.compact.render(width)];
    if (this.showActivity) {
      lines.push("");
      lines.push(...this.activity.render(width));
    }
    if (this.showConclusion) {
      lines.push("");
      lines.push(...this.conclusion.render(width));
    }
    if (this.showError) {
      lines.push("");
      lines.push(...this.error.render(width));
    }
    return lines;
  }
}

export function renderPanelResult(details: PanelToolDetails | undefined, expanded: boolean, theme: Theme, previous?: Component, isPartial = false, now = Date.now()): Component {
  if (!details) return new Text(theme.fg("muted", isPartial ? `${PANEL_TOOL_DISPLAY_NAME} · starting…` : "Panel review has no progress details."), 0, 0);
  const view = previous instanceof PanelResultView ? previous : new PanelResultView();
  view.update(details, expanded, theme, isPartial, now);
  return view;
}

export type PanelToolParams = {
  target: string;
  panel?: string;
  reviewers?: number;
};

/** Runtime guard for direct tool calls; schema validation is not the only boundary. */
export function panelToolParamError(params: PanelToolParams): string | undefined {
  if (params.reviewers !== undefined) {
    if (!Number.isSafeInteger(params.reviewers) || params.reviewers < 2 || params.reviewers > 8) {
      return "reviewers must be an integer between 2 and 8; use the shell CLI for a single reviewer";
    }
    if (params.panel) return "panel cannot be combined with reviewers";
  }
  return undefined;
}

export function registerPanelReviewTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pi_review",
    label: "Pi Review Panel",
    description: "Run an isolated read-only pi-review panel and render each reviewer live.",
    renderShell: "self",
    parameters: Type.Object({
      target: Type.String({ description: "Review target as given by the user, such as @src, @src/foo.ts, or a free-text brief. Directories stay tool path targets; only real files are attached." }),
      mode: Type.Optional(Type.String({ description: "Review mode; defaults to code." })),
      panel: Type.Optional(Type.String({ description: "Named panel preset; defaults to code-experts when reviewers is omitted." })),
      reviewers: Type.Optional(Type.Number({ minimum: 2, maximum: 8, description: "Independent reviewer count (2-8). Cannot combine with panel; single review uses the shell CLI." })),
      reviewerModels: Type.Optional(Type.Array(Type.String(), { description: "Per-reviewer models as id=provider/model[:thinking] (e.g. r1=openai/gpt-5.6-sol:low). Trailing :thinking wins over shared thinking." })),
      consensus: Type.Optional(Type.String({ description: "any | quorum | majority | unanimous" })),
      minAgree: Type.Optional(Type.Number({ description: "Quorum threshold when consensus=quorum" })),
      consensusModel: Type.Optional(Type.String({ description: "Model for semantic adjudication only" })),
      concurrency: Type.Optional(Type.Number({ description: "Bound parallel reviewers (≤ reviewer count)" })),
      model: Type.Optional(Type.String({ description: "Optional shared reviewer model." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let state = createPanelViewState();
      let buffer = "";
      let stderr = "";
      const toolCtx = ctx as PanelToolContext | undefined;
      const publish = () => {
        onUpdate?.({ content: [{ type: "text", text: `${PANEL_TOOL_DISPLAY_NAME}: ${state.aggregate.completed}/${state.aggregate.total} completed` }], details: { state } });
        if (state.phase === "running" || state.phase === "aggregating") {
          setAmbientStatus(toolCtx, ambientStatus(state));
        }
      };
      const consume = (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            state = reducePanelEvent(state, JSON.parse(line) as ReviewEvent);
            publish();
          } catch {
            // Only the stable pi-review event protocol reaches this stream.
          }
        }
      };
      const stdoutSink = new Writable({ write(chunk, _encoding, callback) { consume(String(chunk)); callback(); } });
      const stderrSink = new Writable({
        write(chunk, _encoding, callback) {
          const next = stderr + String(chunk);
          stderr = next.length > 2000 ? next.slice(-2000) : next;
          callback();
        },
      });
      // Preserve the full panel configuration and enforce the panel-only tool boundary.
      const paramError = panelToolParamError(params);
      if (paramError) {
        setAmbientStatus(toolCtx, undefined);
        return {
          content: [{ type: "text", text: `${PANEL_TOOL_DISPLAY_NAME}: ${paramError}` }],
          details: { state, error: paramError },
          isError: true,
        };
      }
      const args = [cliPath, "--mode", params.mode ?? "code", "--output-format", "events-jsonl"];
      if (params.reviewers !== undefined) {
        args.push("--reviewers", String(params.reviewers));
      } else {
        args.push("--panel", params.panel ?? "code-experts");
      }
      for (const mapping of params.reviewerModels ?? []) args.push("--reviewer-model", mapping);
      if (params.consensus) args.push("--consensus", params.consensus);
      if (params.minAgree !== undefined) args.push("--min-agree", String(params.minAgree));
      if (params.consensusModel) args.push("--consensus-model", params.consensusModel);
      if (params.concurrency !== undefined) args.push("--concurrency", String(params.concurrency));
      if (params.model) args.push("--model", params.model);
      if (params.thinking) args.push("--thinking", params.thinking);
      args.push("--", params.target);

      // Keep elapsed/idle labels fresh even when the child is quiet between events.
      const tick = setInterval(() => {
        if (state.phase === "running" || state.phase === "aggregating") publish();
      }, LIVE_TICK_MS);
      tick.unref?.();

      let child: Awaited<ReturnType<typeof spawnStreamingChild>>;
      try {
        setAmbientStatus(toolCtx, ambientStatus(state));
        child = await spawnStreamingChild(process.execPath, args, { cwd: process.cwd(), env: process.env, stdoutSink, stderrSink, signal, processGroup: true });
      } finally {
        clearInterval(tick);
        setAmbientStatus(toolCtx, undefined);
      }
      if (buffer.trim()) {
        const tail = buffer;
        buffer = "";
        consume(`${tail}\n`);
      }
      const error = child.error
        ? child.error.message
        : state.meta
          ? undefined
          : [`pi-review ended before a final event (${child.status ?? child.signal ?? "unknown"})`, stderr.trim()].filter(Boolean).join(": ");
      const details: PanelToolDetails = { state, ...(error ? { error } : {}) };
      return {
        // Parent LLM must receive the full conclusion; details remain the TUI rendering source.
        content: [{ type: "text", text: buildPanelResultContent(state, error) }],
        details,
        ...(error ? { isError: true } : {}),
      };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const width = args.reviewers !== undefined ? `reviewers=${args.reviewers}` : (args.panel ?? "code-experts");
      text.setText(theme.fg("toolTitle", theme.bold(`${PANEL_TOOL_DISPLAY_NAME} `)) + theme.fg("muted", `${width} · ${args.mode ?? "code"} · ${args.target}`));
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return renderPanelResult(result.details as PanelToolDetails | undefined, expanded, theme, context.lastComponent, isPartial);
    },
  });
}
