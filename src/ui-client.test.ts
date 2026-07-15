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
