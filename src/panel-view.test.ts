import assert from "node:assert/strict";
import { test } from "node:test";
import { createPanelViewState, reducePanelEvent } from "./panel-view.js";
import type { ReviewEvent } from "./review-events.js";

function event<T extends ReviewEvent["type"]>(
  type: T,
  seq: number,
  payload: Omit<Extract<ReviewEvent, { type: T }>, "v" | "runId" | "seq" | "at" | "type">,
): Extract<ReviewEvent, { type: T }> {
  return { v: 1, runId: "run-1", seq, at: 1000 + seq, type, ...payload } as Extract<ReviewEvent, { type: T }>;
}

test("panel reducer produces the same final state during live delivery and replay", () => {
  const events: ReviewEvent[] = [
    event("panel.started", 1, { target: "@src", mode: "code", reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt", thinking: "high" }] }),
    event("reviewer.queued", 2, { reviewerId: "security" }),
    event("reviewer.started", 3, { reviewerId: "security" }),
    event("reviewer.tool.started", 4, { reviewerId: "security", tool: "read", summary: "src/panel.ts" }),
    event("reviewer.usage", 5, { reviewerId: "security", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 2, totalTokens: 14 } }),
    event("reviewer.completed", 6, { reviewerId: "security", submission: { reviewerId: "security", role: "Security", model: "openai/gpt", durationMs: 20, result: { status: "clean", verdict: "approve", verdictSource: "parsed", findings: [], actionableCount: 0 } } }),
    event("aggregation.started", 7, {}),
  ];

  const live = events.reduce(reducePanelEvent, createPanelViewState());
  const replay = events.reduce(reducePanelEvent, createPanelViewState());
  assert.deepEqual(replay, live);
  assert.equal(live.reviewers.security?.status, "completed");
  assert.equal(live.reviewers.security?.activeTool, undefined);
  assert.equal(live.reviewers.security?.activeToolSummary, undefined);
  assert.equal(live.aggregate.completed, 1);
  assert.equal(live.phase, "aggregating");
});

test("panel reducer keeps the active tool summary while a tool is running", () => {
  let state = reducePanelEvent(createPanelViewState(), event("panel.started", 1, {
    target: "@src",
    mode: "code",
    reviewers: [{ reviewerId: "security", role: "Security", model: null }],
  }));
  state = reducePanelEvent(state, event("reviewer.tool.started", 2, { reviewerId: "security", tool: "read", summary: "src/panel.ts" }));
  assert.equal(state.reviewers.security?.activeTool, "read");
  assert.equal(state.reviewers.security?.activeToolSummary, "src/panel.ts");
  state = reducePanelEvent(state, event("reviewer.tool.finished", 3, { reviewerId: "security", tool: "read" }));
  assert.equal(state.reviewers.security?.activeTool, undefined);
  assert.equal(state.reviewers.security?.activeToolSummary, undefined);
});

test("terminal panel usage reuses the CLI aggregation semantics", () => {
  const now = Date.now();
  let state = reducePanelEvent(createPanelViewState(), {
    v: 1, runId: "run-usage", seq: 1, at: now, type: "panel.started", target: "@src", mode: "code",
    reviewers: [{ reviewerId: "r1", role: "one", model: null }, { reviewerId: "r2", role: "two", model: null }],
  });
  state = reducePanelEvent(state, { v: 1, runId: "run-usage", seq: 2, at: now, type: "reviewer.usage", reviewerId: "r1", usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, reasoning: 5, totalTokens: 110 } });
  state = reducePanelEvent(state, { v: 1, runId: "run-usage", seq: 3, at: now, type: "reviewer.usage", reviewerId: "r2", usage: { input: 80, output: 30, cacheRead: 10, cacheWrite: 0, reasoning: 7, totalTokens: 110 } });
  assert.deepEqual(state.aggregate.usage, { input: 180, output: 40, cacheRead: 30, cacheWrite: 0, reasoning: 12, totalTokens: 220 });
});

test("panel reducer ignores duplicates, unknown events, and out-of-order delivery", () => {
  const started = event("panel.started", 1, { target: "@src", mode: "code", reviewers: [] });
  const state = reducePanelEvent(createPanelViewState(), started);
  const duplicate = reducePanelEvent(state, started);
  const unknown = reducePanelEvent(duplicate, { v: 1, runId: "run-1", seq: 2, at: 1002, type: "future.event" } as unknown as ReviewEvent);
  const later = reducePanelEvent(unknown, event("aggregation.started", 3, {}));
  const outOfOrder = reducePanelEvent(later, event("aggregation.started", 2, {}));
  assert.equal(outOfOrder.lastSeq, 3);
  assert.equal(outOfOrder.phase, "aggregating");
});
