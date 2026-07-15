import assert from "node:assert/strict";
import { test } from "node:test";
import { runPanelReviewOnce } from "./panel.js";
import type { ParsedArgs, ReviewEvent } from "./index.js";

test("an already-aborted panel emits deterministic reviewer cancellations and one final event", async () => {
  const controller = new AbortController();
  controller.abort();
  const events: ReviewEvent[] = [];
  const parsed: ParsedArgs = {
    command: "review",
    mode: "code",
    skills: [],
    payload: ["@src"],
    keepSession: false,
    stream: true,
    reviewers: 2,
  };

  const result = await runPanelReviewOnce(parsed, "", { signal: controller.signal, onEvent: (event) => events.push(event), emitFooter: false });
  assert.equal(result.exitCode, 4);
  assert.equal(result.meta.status, "blocked");
  assert.equal(events.filter((event) => event.type === "reviewer.cancelled").length, 2);
  assert.equal(events.filter((event) => event.type === "panel.completed").length, 1);
  assert.equal(events.at(-1)?.type, "panel.completed");
});
