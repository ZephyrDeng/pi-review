import assert from "node:assert/strict";
import { test } from "vitest";
import { runPanelReviewOnce, shouldPreserveSubmissionOnAbort } from "./panel.js";
import type { ParsedArgs, ReviewEvent, ReviewerSubmission } from "./index.js";

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

test("panel abort preserves already-finished reviewer submissions instead of rewriting them as cancelled", () => {
  const finished: ReviewerSubmission = {
    reviewerId: "security",
    role: "Security",
    model: "openai/gpt",
    durationMs: 1200,
    result: {
      status: "has_findings",
      verdict: "request_changes",
      verdictSource: "parsed",
      findings: [{ summary: "Auth bypass", actionable: true }],
      actionableCount: 1,
    },
  };
  const interrupted: ReviewerSubmission = {
    reviewerId: "correctness",
    role: "Correctness",
    model: "openai/gpt",
    durationMs: 400,
    result: {
      status: "blocked",
      verdict: "blocked",
      verdictSource: "runtime_error",
      parseError: "child pi terminated by signal SIGTERM",
      findings: [],
      actionableCount: 0,
    },
  };
  assert.equal(shouldPreserveSubmissionOnAbort(finished), true);
  assert.equal(shouldPreserveSubmissionOnAbort(interrupted), false);
});
