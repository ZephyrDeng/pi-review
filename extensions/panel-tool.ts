import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { createPanelViewState, reducePanelEvent, spawnStreamingChild, type PanelViewState, type ReviewEvent } from "@zephyrdeng/pi-review";

type Theme = { fg: (color: "toolTitle" | "muted" | "error" | "success" | "accent", text: string) => string; bold: (text: string) => string };
type PanelToolDetails = { state: PanelViewState; error?: string };

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(extensionDir, "../bin/pi-review.js");

function duration(ms: number | undefined): string {
  if (!ms) return "0s";
  return `${Math.floor(ms / 1000)}s`;
}

function usageTokens(state: PanelViewState): string {
  return state.aggregate.usage ? `${state.aggregate.usage.totalTokens.toLocaleString()} tok` : "—";
}

function statusSymbol(status: string): string {
  return status === "completed" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : status === "running" ? "●" : "○";
}

function compactText(state: PanelViewState, theme: Theme, now = Date.now()): string {
  const elapsed = state.startedAt ? duration((state.completedAt ?? now) - state.startedAt) : "0s";
  const progress = `${state.aggregate.completed}/${state.aggregate.total} completed`;
  const header = theme.fg("toolTitle", theme.bold(`pi-review panel ${progress}`)) + theme.fg("muted", ` · ${state.phase} · ${elapsed} · ${usageTokens(state)}`);
  const rows = Object.values(state.reviewers).map((reviewer) => {
    const model = reviewer.model ? ` · ${reviewer.model}` : "";
    const thinking = reviewer.thinking ? ` · ${reviewer.thinking}` : "";
    const active = reviewer.activeTool ? ` · ${reviewer.activeTool}` : "";
    const activeSummary = reviewer.activeToolSummary ? ` · ${reviewer.activeToolSummary}` : "";
    const reviewerElapsed = reviewer.startedAt ? ` · ${duration((reviewer.completedAt ?? now) - reviewer.startedAt)}` : "";
    const idle = reviewer.status === "running" && reviewer.activityAt ? ` · idle ${duration(now - reviewer.activityAt)}` : "";
    const tokens = reviewer.usage ? ` · ${reviewer.usage.totalTokens.toLocaleString()} tok` : "";
    return `${theme.fg(reviewer.status === "failed" ? "error" : reviewer.status === "completed" ? "success" : "accent", statusSymbol(reviewer.status))} ${theme.fg("toolTitle", reviewer.reviewerId)}${theme.fg("muted", ` ${reviewer.role}${model}${thinking}${active}${activeSummary}${reviewerElapsed}${idle}${tokens}`)}`;
  });
  return [header, ...rows].join("\n");
}

function reviewerSummaryLines(state: PanelViewState): string[] {
  const fromMeta = state.meta?.reviewers ?? [];
  if (fromMeta.length > 0) {
    return fromMeta.map((reviewer) => {
      const live = state.reviewers[reviewer.reviewerId];
      const role = reviewer.role ? ` · ${reviewer.role}` : "";
      const model = reviewer.model ? ` · ${reviewer.model}` : "";
      const thinking = reviewer.thinking ? ` · ${reviewer.thinking}` : "";
      const head = `- ${reviewer.reviewerId}${role}${model}${thinking} · ${reviewer.status} · ${reviewer.verdict}`;
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
    const head = `- ${reviewer.reviewerId}${role}${model}${thinking} · ${status}${verdict}`;
    const findings = reviewer.submission?.result.findings?.map((finding) => finding.summary).filter(Boolean).slice(0, 5) ?? [];
    if (findings.length > 0) return `${head}\n  ${findings.map((summary) => `• ${summary}`).join("\n  ")}`;
    if (reviewer.error) return `${head}\n  • ${reviewer.error}`;
    return head;
  });
}

/** Full panel conclusion for the parent LLM (and expanded TUI markdown). */
export function buildPanelResultContent(state: PanelViewState, error?: string): string {
  const meta = state.meta;
  if (!meta && !error) return "Panel completed: unknown";
  if (!meta) return error ?? "Panel completed: unknown";

  const confirmed = meta.confirmedClusters.map((finding) => `- ${finding.summary} (${finding.supportingReviewerIds.join(", ")})`);
  const advisories = meta.advisories.map((finding) => `- ${finding.summary} (${finding.supportingReviewerIds.join(", ")})`);
  const provenance = meta.reviewers.map((reviewer) => {
    const role = reviewer.role ? ` · ${reviewer.role}` : "";
    const model = reviewer.model ? ` · ${reviewer.model}` : "";
    const thinking = reviewer.thinking ? ` · ${reviewer.thinking}` : "";
    return `- ${reviewer.reviewerId}${role}${model}${thinking} · ${reviewer.status}`;
  });
  const summaries = reviewerSummaryLines(state);
  const body = [
    "### Panel result",
    `Health: ${meta.panelHealth}; status: ${meta.status}.`,
    confirmed.length ? `### Confirmed findings\n${confirmed.join("\n")}` : "### Confirmed findings\nNone.",
    advisories.length ? `### Advisories\n${advisories.join("\n")}` : "### Advisories\nNone.",
    provenance.length ? `### Provenance\n${provenance.join("\n")}` : "### Provenance\nNone.",
    summaries.length ? `### Reviewer summaries\n${summaries.join("\n")}` : "### Reviewer summaries\nNone.",
  ].join("\n\n");
  return error ? `${body}\n\n### Error\n${error}` : body;
}

function finalMarkdown(state: PanelViewState): string {
  return buildPanelResultContent(state);
}

export function renderPanelResult(details: PanelToolDetails | undefined, expanded: boolean, theme: Theme, previous?: Component): Component {
  if (!details) return new Text(theme.fg("muted", "Panel review has no progress details."), 0, 0);
  if (!expanded) {
    const text = previous instanceof Text ? previous : new Text("", 0, 0);
    text.setText(compactText(details.state, theme));
    return text;
  }
  const container = new Container();
  container.addChild(new Text(compactText(details.state, theme), 0, 0));
  for (const reviewer of Object.values(details.state.reviewers)) {
    if (reviewer.recentActivity.length === 0) continue;
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", `${reviewer.reviewerId} activity`), 0, 0));
    container.addChild(new Text(reviewer.recentActivity.join("\n"), 0, 0));
  }
  const markdown = finalMarkdown(details.state);
  if (markdown) {
    container.addChild(new Spacer(1));
    // Pi supplies a Markdown theme to built-in renderers; plain text keeps this
    // extension portable across public API versions while still using Markdown.
    container.addChild(new Markdown(markdown, 0, 0, {
      heading: theme.bold,
      link: (text) => text,
      linkUrl: (text) => text,
      code: (text) => text,
      codeBlock: (text) => text,
      codeBlockBorder: (text) => text,
      quote: (text) => text,
      quoteBorder: (text) => text,
      hr: (text) => text,
      listBullet: (text) => text,
      bold: theme.bold,
      italic: (text) => text,
      strikethrough: (text) => text,
      underline: (text) => text,
    }));
  }
  if (details.error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", details.error), 0, 0));
  }
  return container;
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
      reviewerModels: Type.Optional(Type.Array(Type.String(), { description: "Per-reviewer models as id=provider/model (e.g. r1=openai/gpt-5.6-sol)." })),
      consensus: Type.Optional(Type.String({ description: "any | quorum | majority | unanimous" })),
      minAgree: Type.Optional(Type.Number({ description: "Quorum threshold when consensus=quorum" })),
      consensusModel: Type.Optional(Type.String({ description: "Model for semantic adjudication only" })),
      concurrency: Type.Optional(Type.Number({ description: "Bound parallel reviewers (≤ reviewer count)" })),
      model: Type.Optional(Type.String({ description: "Optional shared reviewer model." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      let state = createPanelViewState();
      let buffer = "";
      let stderr = "";
      const publish = () => onUpdate?.({ content: [{ type: "text", text: `Panel: ${state.aggregate.completed}/${state.aggregate.total} completed` }], details: { state } });
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
        return {
          content: [{ type: "text", text: `pi_review: ${paramError}` }],
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
      const child = await spawnStreamingChild(process.execPath, args, { cwd: process.cwd(), env: process.env, stdoutSink, stderrSink, signal, processGroup: true });
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
      text.setText(theme.fg("toolTitle", theme.bold("pi_review ")) + theme.fg("muted", `${width} · ${args.mode ?? "code"} · ${args.target}`));
      return text;
    },
    renderResult(result, { expanded }, theme, context) {
      return renderPanelResult(result.details as PanelToolDetails | undefined, expanded, theme, context.lastComponent);
    },
  });
}
