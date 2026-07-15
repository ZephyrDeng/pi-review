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

function compactText(state: PanelViewState, theme: Theme): string {
  const elapsed = state.startedAt ? duration((state.completedAt ?? Date.now()) - state.startedAt) : "0s";
  const progress = `${state.aggregate.completed}/${state.aggregate.total} completed`;
  const header = theme.fg("toolTitle", theme.bold(`pi-review panel ${progress}`)) + theme.fg("muted", ` · ${state.phase} · ${elapsed} · ${usageTokens(state)}`);
  const rows = Object.values(state.reviewers).map((reviewer) => {
    const active = reviewer.activeTool ? ` · ${reviewer.activeTool}` : "";
    const elapsed = reviewer.startedAt ? ` · ${duration((reviewer.completedAt ?? Date.now()) - reviewer.startedAt)}` : "";
    const tokens = reviewer.usage ? ` · ${reviewer.usage.totalTokens.toLocaleString()} tok` : "";
    return `${theme.fg(reviewer.status === "failed" ? "error" : reviewer.status === "completed" ? "success" : "accent", statusSymbol(reviewer.status))} ${theme.fg("toolTitle", reviewer.reviewerId)}${theme.fg("muted", ` ${reviewer.role}${active}${elapsed}${tokens}`)}`;
  });
  return [header, ...rows].join("\n");
}

function finalMarkdown(state: PanelViewState): string {
  const meta = state.meta;
  if (!meta) return "";
  const confirmed = meta.confirmedClusters.map((finding) => `- ${finding.summary} (${finding.supportingReviewerIds.join(", ")})`);
  const advisories = meta.advisories.map((finding) => `- ${finding.summary} (${finding.supportingReviewerIds.join(", ")})`);
  return [
    "### Panel result",
    `Health: ${meta.panelHealth}; status: ${meta.status}.`,
    confirmed.length ? `### Confirmed findings\n${confirmed.join("\n")}` : "### Confirmed findings\nNone.",
    advisories.length ? `### Advisories\n${advisories.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
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

export function registerPanelReviewTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pi_review",
    label: "Pi Review Panel",
    description: "Run an isolated read-only pi-review panel and render each reviewer live.",
    renderShell: "self",
    parameters: Type.Object({
      target: Type.String({ description: "Review target, such as @src or a code-review brief." }),
      mode: Type.Optional(Type.String({ description: "Review mode; defaults to code." })),
      panel: Type.Optional(Type.String({ description: "Named panel preset; defaults to code-experts." })),
      model: Type.Optional(Type.String({ description: "Optional reviewer model." })),
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
      const args = [cliPath, "--panel", params.panel ?? "code-experts", "--mode", params.mode ?? "code", "--output-format", "events-jsonl"];
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
        content: [{ type: "text", text: error ?? `Panel completed: ${state.meta?.status ?? "unknown"}` }],
        details,
        ...(error ? { isError: true } : {}),
      };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("pi_review ")) + theme.fg("muted", `${args.panel ?? "code-experts"} · ${args.mode ?? "code"} · ${args.target}`));
      return text;
    },
    renderResult(result, { expanded }, theme, context) {
      return renderPanelResult(result.details as PanelToolDetails | undefined, expanded, theme, context.lastComponent);
    },
  });
}
