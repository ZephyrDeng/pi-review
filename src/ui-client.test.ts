import assert from "node:assert/strict";
import { test } from "vitest";
import { createPanelViewState, reducePanelEvent } from "./panel-view.js";
import type { ReviewEvent } from "./review-events.js";
import {
  findingDetailLine,
  formatDuration,
  formatUsage,
  headerSummary,
  headerTitle,
  resultsSummary,
  reviewerDetailLine,
  statusClass,
} from "./ui-client.js";

test("formatDuration renders seconds and minutes", () => {
  assert.equal(formatDuration(undefined), "–");
  assert.equal(formatDuration(-5), "–");
  assert.equal(formatDuration(4200), "4s");
  assert.equal(formatDuration(65000), "1m 5s");
});

test("formatUsage renders total tokens or a placeholder", () => {
  assert.equal(formatUsage(undefined), "– tokens");
  assert.equal(
    formatUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1234 }),
    "1,234 tokens",
  );
});

test("statusClass maps every reviewer status to a CSS class", () => {
  assert.equal(statusClass("queued"), "status status-queued");
  assert.equal(statusClass("failed"), "status status-failed");
});

function event<T extends ReviewEvent["type"]>(
  type: T,
  seq: number,
  payload: Omit<Extract<ReviewEvent, { type: T }>, "v" | "runId" | "seq" | "at" | "type">,
): Extract<ReviewEvent, { type: T }> {
  return { v: 1, runId: "run-1", seq, at: 1000 + seq, type, ...payload } as Extract<ReviewEvent, { type: T }>;
}

test("headerTitle and headerSummary reflect live reducer state", () => {
  let state = createPanelViewState();
  state = reducePanelEvent(
    state,
    event("panel.started", 1, { target: "@src", mode: "code", reviewers: [{ reviewerId: "r1", role: "Reviewer", model: null }] }),
  );
  assert.equal(headerTitle(state), "pi-review panel — @src");
  assert.match(headerSummary(state, 2000), /code · running · 0\/1 completed/);

  state = reducePanelEvent(state, event("reviewer.started", 2, { reviewerId: "r1" }));
  state = reducePanelEvent(
    state,
    event("reviewer.completed", 3, {
      reviewerId: "r1",
      submission: { reviewerId: "r1", role: "Reviewer", model: null, durationMs: 10, result: { status: "clean", verdict: "approve", verdictSource: "parsed", findings: [], actionableCount: 0 } },
    }),
  );
  assert.match(headerSummary(state, 2000), /1\/1 completed/);
});

test("reviewerDetailLine joins model, thinking, active tool, duration, usage, and activity age", () => {
  assert.equal(
    reviewerDetailLine(
      {
        reviewerId: "r1", role: "Reviewer", model: "openai/gpt", thinking: "high", status: "running",
        activeTool: "read", turns: 1, recentActivity: [], startedAt: 1000, activityAt: 4000,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 500 },
      },
      5000,
    ),
    "openai/gpt · high · tool: read · 4s · 500 tokens · active 1s ago",
  );
  assert.equal(
    reviewerDetailLine({ reviewerId: "r1", role: "Reviewer", model: null, status: "queued", turns: 0, recentActivity: [] }, 5000),
    "default model · – tokens",
  );
  assert.equal(
    reviewerDetailLine(
      { reviewerId: "r1", role: "Reviewer", model: null, status: "completed", turns: 0, recentActivity: [], startedAt: 1000, completedAt: 3000, activityAt: 3000 },
      9000,
    ),
    "default model · 2s · – tokens",
    "a completed reviewer's duration is fixed and does not keep growing with wall-clock time",
  );
});

test("findingDetailLine includes provenance and resultsSummary formats meta text", () => {
  assert.equal(
    findingDetailLine({ id: "C1", summary: "x", confirmed: true, supportCount: 2, actionableSupportCount: 2, supportingReviewerIds: ["r1", "r2"], sourceFindingIds: [], severity: "high", path: "src/x.ts" }),
    "high · src/x.ts · 2 reviewer(s): r1, r2",
  );
  assert.equal(
    findingDetailLine({ id: "C2", summary: "y", confirmed: false, supportCount: 1, actionableSupportCount: 1, supportingReviewerIds: [], sourceFindingIds: [] }),
    "1 reviewer(s)",
  );
  assert.equal(resultsSummary(undefined), "");
});

test("formatCompact steps through plain, K, and M ranges", async () => {
  const { formatCompact } = await import("./ui-client.js");
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(950), "950");
  assert.equal(formatCompact(12_345), "12.3K");
  assert.equal(formatCompact(276_300), "276K");
  assert.equal(formatCompact(1_234_567), "1.23M");
});

test("reduceClientExtras counts tool calls and accumulates full review text per reviewer", async () => {
  const { createClientExtras, reduceClientExtras, totalToolCalls } = await import("./ui-client.js");
  let extras = createClientExtras();
  extras = reduceClientExtras(extras, event("reviewer.tool.started", 1, { reviewerId: "r1", tool: "read" }));
  extras = reduceClientExtras(extras, event("reviewer.tool.started", 2, { reviewerId: "r1", tool: "grep" }));
  extras = reduceClientExtras(extras, event("reviewer.tool.started", 3, { reviewerId: "r2", tool: "read" }));
  extras = reduceClientExtras(extras, event("reviewer.text.delta", 4, { reviewerId: "r1", text: "## Find" }));
  extras = reduceClientExtras(extras, event("reviewer.text.delta", 5, { reviewerId: "r1", text: "ings" }));
  assert.equal(extras.toolCalls["r1"], 2);
  assert.equal(extras.toolCalls["r2"], 1);
  assert.equal(totalToolCalls(extras), 3);
  assert.equal(extras.fullText["r1"], "## Findings");
});

test("statusHeadline tracks phase while running and gate status once completed", async () => {
  const { statusHeadline } = await import("./ui-client.js");
  let state = createPanelViewState();
  assert.deepEqual(statusHeadline(state, "connecting"), { text: "Connecting", tone: "" });

  state = reducePanelEvent(
    state,
    event("panel.started", 1, { target: "@src", mode: "code", reviewers: [{ reviewerId: "r1", role: "Reviewer", model: null }] }),
  );
  assert.deepEqual(statusHeadline(state, "live"), { text: "Reviewing", tone: "" });

  state = reducePanelEvent(state, event("aggregation.started", 2, {}));
  assert.deepEqual(statusHeadline(state, "live"), { text: "Aggregating", tone: "" });

  const completed = reducePanelEvent(
    state,
    event("panel.completed", 3, {
      meta: {
        status: "clean", verdict: "approve", verdictSource: "parsed", findings: [], actionableCount: 0,
        reviewMode: "code", durationMs: 10, model: null,
        confirmedClusters: [], advisories: [], panelHealth: "healthy",
        configuredReviewers: 1, successfulReviewers: 1, consensusPolicy: "quorum", consensusThreshold: 2,
        reviewers: [], adjudicationUsed: false, strategy: "panel",
      },
    }),
  );
  assert.deepEqual(statusHeadline(completed, "live"), { text: "Clean", tone: "ok" });
});
