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
  assert.equal(live.aggregate.completed, 1);
  assert.equal(live.phase, "aggregating");
});

test("panel reducer ignores duplicates, unknown events, and out-of-order delivery", () => {
  const started = event("panel.started", 1, { target: "@src", mode: "code", reviewers: [] });
  const state = reducePanelEvent(createPanelViewState(), started);
  const duplicate = reducePanelEvent(state, started);
  const unknown = reducePanelEvent(duplicate, { v: 1, runId: "run-1", seq: 2, at: 1002, type: "future.event" } as unknown as ReviewEvent);
  assert.equal(unknown.lastSeq, 1);
  assert.equal(unknown.phase, "running");
});
