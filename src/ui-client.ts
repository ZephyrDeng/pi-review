// Browser renderer for the loopback dashboard (issue #4). Loaded as a plain
// ES module; resolves its sibling reducer and events endpoint relative to its
// own script URL so the page needs no server-injected config. All dynamic
// content is written through textContent, never innerHTML.

import { createPanelViewState, reducePanelEvent } from "./panel-view.js";
import type { PanelReviewerView, PanelViewState, ReviewerViewStatus } from "./panel-view.js";
import type { ReviewEvent } from "./review-events.js";
import type { FindingCluster, TokenUsage } from "./types.js";

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "–";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatUsage(usage: TokenUsage | undefined): string {
  if (!usage) return "– tokens";
  return `${usage.totalTokens.toLocaleString("en-US")} tokens`;
}

export function statusClass(status: ReviewerViewStatus): string {
  return `status status-${status}`;
}

/** Pure header summary line; kept separate from DOM writes so it is unit-testable. */
export function headerSummary(state: PanelViewState, now: number): string {
  const elapsed = state.startedAt !== undefined ? formatDuration((state.completedAt ?? now) - state.startedAt) : "–";
  const parts = [
    state.mode,
    state.phase,
    `${state.aggregate.completed}/${state.aggregate.total} completed`,
    elapsed,
    formatUsage(state.aggregate.usage),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function headerTitle(state: PanelViewState): string {
  return state.target ? `pi-review panel — ${state.target}` : "pi-review panel";
}

/** Pure reviewer detail line; excludes recent activity, which renders as its own block. */
export function reviewerDetailLine(reviewer: PanelReviewerView, now: number): string {
  const durationMs = reviewer.startedAt !== undefined ? (reviewer.completedAt ?? now) - reviewer.startedAt : undefined;
  const activityAgeMs = reviewer.status === "running" && reviewer.activityAt !== undefined ? now - reviewer.activityAt : undefined;
  return [
    reviewer.model ?? "default model",
    reviewer.thinking,
    reviewer.activeTool ? `tool: ${reviewer.activeTool}` : undefined,
    durationMs !== undefined ? formatDuration(durationMs) : undefined,
    formatUsage(reviewer.usage),
    activityAgeMs !== undefined ? `active ${formatDuration(activityAgeMs)} ago` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function findingDetailLine(cluster: FindingCluster): string {
  const support = cluster.supportingReviewerIds.length > 0
    ? `${cluster.supportCount} reviewer(s): ${cluster.supportingReviewerIds.join(", ")}`
    : `${cluster.supportCount} reviewer(s)`;
  return [cluster.severity, cluster.path, support].filter((part): part is string => Boolean(part)).join(" · ");
}

export function resultsSummary(meta: PanelViewState["meta"]): string {
  if (!meta) return "";
  return `Result: ${meta.status} (${meta.panelHealth})`;
}

// ---------------------------------------------------------------------------
// DOM glue — only executed inside a real browser.
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  return node;
}

function renderReviewerCard(reviewer: PanelReviewerView, now: number): HTMLElement {
  const card = el("article", { className: "reviewer-card" });
  if (reviewer.status === "queued" || reviewer.status === "running") {
    card.classList.add("is-loading");
  }
  const heading = el("h2");
  const statusLabel =
    reviewer.status === "queued" ? "loading"
      : reviewer.status === "running" ? "running"
        : reviewer.status;
  heading.append(
    `${reviewer.role} `,
    el("span", { className: statusClass(reviewer.status), text: statusLabel }),
  );
  card.append(heading, el("div", { className: "reviewer-detail", text: reviewerDetailLine(reviewer, now) }));
  if (reviewer.recentActivity.length > 0) {
    card.append(el("div", { className: "activity", text: reviewer.recentActivity.join("\n") }));
  } else if (reviewer.status === "queued") {
    card.append(el("div", { className: "activity loading-line", text: "waiting to start…" }));
  } else if (reviewer.status === "running") {
    card.append(el("div", { className: "activity loading-line", text: "working…" }));
  }
  if (reviewer.error) {
    card.append(el("div", { className: "activity", text: `error: ${reviewer.error}` }));
  }
  return card;
}

function renderFindingCluster(cluster: FindingCluster, advisory: boolean): HTMLElement {
  const wrapper = el("div", { className: advisory ? "finding advisory" : "finding" });
  wrapper.append(el("strong", { text: cluster.summary }), el("div", { text: findingDetailLine(cluster) }));
  return wrapper;
}

function render(state: PanelViewState): void {
  const now = Date.now();
  const title = document.getElementById("run-title");
  const meta = document.getElementById("run-meta");
  if (title) title.textContent = headerTitle(state);
  if (meta) meta.textContent = headerSummary(state, now);

  const reviewers = document.getElementById("reviewers");
  if (reviewers) {
    reviewers.replaceChildren(...Object.values(state.reviewers).map((reviewer) => renderReviewerCard(reviewer, now)));
  }

  const results = document.getElementById("results");
  if (results) {
    results.replaceChildren();
    if (state.meta) {
      results.append(el("h2", { text: resultsSummary(state.meta) }));
      if (state.meta.confirmedClusters.length > 0) {
        results.append(el("h3", { text: "Confirmed findings" }));
        results.append(...state.meta.confirmedClusters.map((cluster) => renderFindingCluster(cluster, false)));
      }
      if (state.meta.advisories.length > 0) {
        results.append(el("h3", { text: "Advisories" }));
        results.append(...state.meta.advisories.map((cluster) => renderFindingCluster(cluster, true)));
      }
      if (state.meta.confirmedClusters.length === 0 && state.meta.advisories.length === 0) {
        results.append(el("p", { text: "No findings reported." }));
      }
    }
  }
}

function bootstrap(): void {
  let state = createPanelViewState();
  render(state);

  const eventsUrl = new URL("../events", import.meta.url).toString();
  const source = new EventSource(eventsUrl);
  source.onmessage = (message) => {
    let event: ReviewEvent;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    state = reducePanelEvent(state, event);
    render(state);
  };
  source.onerror = () => {
    const meta = document.getElementById("run-meta");
    if (meta) meta.textContent = "reconnecting…";
  };
}

if (typeof document !== "undefined") bootstrap();
