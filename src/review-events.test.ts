import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewEventEmitter, redactReviewEventText } from "./review-events.js";

test("ReviewEvent v1 emits a monotonic, replayable panel lifecycle", () => {
  const events: Array<{ type: string; seq: number; runId: string }> = [];
  const emit = createReviewEventEmitter("run-1", (event) => events.push(event));

  emit("panel.started", { target: "@src", mode: "code", reviewers: [] });
  emit("aggregation.started", {});

  assert.deepEqual(events.map((event) => event.type), ["panel.started", "aggregation.started"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.deepEqual([...new Set(events.map((event) => event.runId))], ["run-1"]);
});

test("ReviewEvent v1 redacts obvious secrets and bounds renderer text", () => {
  const text = redactReviewEventText(`token=sk-secret-value ${"x".repeat(900)}`);
  assert.doesNotMatch(text, /sk-secret-value/);
  assert.ok(text.length <= 512);
});
