// Pure state reducer shared by the Pi renderer and future event consumers.

import type { PanelReviewMeta, ReviewerSubmission, TokenUsage } from "./types.js";
import type { ReviewEvent, ReviewerIdentity } from "./review-events.js";
import { sumPanelUsage } from "./panel-usage.js";

export type ReviewerViewStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type PanelPhase = "idle" | "running" | "aggregating" | "completed";

export interface PanelReviewerView extends ReviewerIdentity {
  status: ReviewerViewStatus;
  activeTool?: string;
  activeToolSummary?: string;
  activityAt?: number;
  startedAt?: number;
  completedAt?: number;
  turns: number;
  usage?: TokenUsage;
  recentActivity: string[];
  submission?: ReviewerSubmission;
  error?: string;
}

export interface PanelViewState {
  runId?: string;
  lastSeq: number;
  target?: string;
  mode?: string;
  panelPreset?: string;
  startedAt?: number;
  completedAt?: number;
  phase: PanelPhase;
  reviewers: Record<string, PanelReviewerView>;
  aggregate: { total: number; queued: number; running: number; completed: number; failed: number; cancelled: number; usage?: TokenUsage };
  meta?: PanelReviewMeta;
}

const ACTIVITY_LIMIT = 8;

export function createPanelViewState(): PanelViewState {
  return {
    lastSeq: 0,
    phase: "idle",
    reviewers: {},
    aggregate: { total: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
  };
}

function addActivity(reviewer: PanelReviewerView, activity: string): PanelReviewerView {
  return { ...reviewer, recentActivity: [...reviewer.recentActivity, activity].slice(-ACTIVITY_LIMIT) };
}

function fallbackReviewer(reviewerId: string): PanelReviewerView {
  return { reviewerId, role: reviewerId, model: null, status: "queued", turns: 0, recentActivity: [] };
}

function withAggregate(state: PanelViewState): PanelViewState {
  const statuses = Object.values(state.reviewers).map((reviewer) => reviewer.status);
  const usage = sumPanelUsage(Object.values(state.reviewers).map((reviewer) => reviewer.usage));
  return {
    ...state,
    aggregate: {
      total: statuses.length,
      queued: statuses.filter((status) => status === "queued").length,
      running: statuses.filter((status) => status === "running").length,
      completed: statuses.filter((status) => status === "completed").length,
      failed: statuses.filter((status) => status === "failed").length,
      cancelled: statuses.filter((status) => status === "cancelled").length,
      ...(usage ? { usage } : {}),
    },
  };
}

/** Unknown, duplicate, out-of-order, and other-run events leave state intact. */
export function reducePanelEvent(state: PanelViewState, event: ReviewEvent): PanelViewState {
  const knownTypes = new Set<ReviewEvent["type"]>([
    "panel.started", "reviewer.queued", "reviewer.started", "reviewer.turn.started", "reviewer.tool.started", "reviewer.tool.finished", "reviewer.text.delta", "reviewer.usage", "reviewer.completed", "reviewer.failed", "reviewer.cancelled", "aggregation.started", "panel.completed",
  ]);
  if (!knownTypes.has(event.type) || event.seq <= state.lastSeq || (state.runId && event.runId !== state.runId)) return state;

  let next: PanelViewState = { ...state, runId: event.runId, lastSeq: event.seq };
  if (event.type === "panel.started") {
    const reviewers = Object.fromEntries(event.reviewers.map((identity) => [identity.reviewerId, { ...identity, status: "queued" as const, turns: 0, recentActivity: [] }]));
    return withAggregate({ ...next, target: event.target, mode: event.mode, ...(event.panelPreset ? { panelPreset: event.panelPreset } : {}), startedAt: event.at, phase: "running", reviewers });
  }
  if (event.type === "aggregation.started") return withAggregate({ ...next, phase: "aggregating" });
  if (event.type === "panel.completed") {
    const completed = withAggregate({ ...next, phase: "completed", completedAt: event.at, meta: event.meta });
    return { ...completed, aggregate: { ...completed.aggregate, ...(event.meta.usage ? { usage: event.meta.usage } : {}) } };
  }

  const reviewerId = event.reviewerId;
  const previous = state.reviewers[reviewerId] ?? fallbackReviewer(reviewerId);
  let reviewer: PanelReviewerView = previous;
  switch (event.type) {
    case "reviewer.queued":
      reviewer = { ...previous, status: "queued", activityAt: event.at };
      break;
    case "reviewer.started":
      reviewer = addActivity({ ...previous, status: "running", startedAt: event.at, activityAt: event.at }, "review started");
      break;
    case "reviewer.turn.started":
      reviewer = addActivity({ ...previous, status: "running", turns: event.turn, activityAt: event.at }, `turn ${event.turn}`);
      break;
    case "reviewer.tool.started":
      reviewer = addActivity({ ...previous, status: "running", activeTool: event.tool, activeToolSummary: event.summary, activityAt: event.at }, `tool ${event.tool}${event.summary ? `: ${event.summary}` : ""}`);
      break;
    case "reviewer.tool.finished":
      reviewer = addActivity({ ...previous, status: "running", activeTool: undefined, activeToolSummary: undefined, activityAt: event.at }, `tool ${event.tool} finished${event.summary ? `: ${event.summary}` : ""}`);
      break;
    case "reviewer.text.delta":
      reviewer = addActivity({ ...previous, status: "running", activityAt: event.at }, event.text);
      break;
    case "reviewer.usage":
      reviewer = { ...previous, usage: event.usage, activityAt: event.at };
      break;
    case "reviewer.completed":
      reviewer = addActivity({ ...previous, status: "completed", activeTool: undefined, activeToolSummary: undefined, completedAt: event.at, activityAt: event.at, usage: event.submission.usage ?? previous.usage, submission: event.submission }, "review completed");
      break;
    case "reviewer.failed":
      reviewer = addActivity({ ...previous, status: "failed", activeTool: undefined, activeToolSummary: undefined, completedAt: event.at, activityAt: event.at, error: event.message }, event.message);
      break;
    case "reviewer.cancelled":
      reviewer = addActivity({ ...previous, status: "cancelled", activeTool: undefined, activeToolSummary: undefined, completedAt: event.at, activityAt: event.at, ...(event.message ? { error: event.message } : {}) }, event.message ?? "review cancelled");
      break;
  }
  next = { ...next, reviewers: { ...state.reviewers, [reviewerId]: reviewer } };
  return withAggregate(next);
}
