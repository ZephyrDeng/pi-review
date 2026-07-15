import assert from "node:assert/strict";
import { test } from "node:test";
import { createPanelViewState, reducePanelEvent } from "@zephyrdeng/pi-review";
import { renderPanelResult } from "./panel-tool.js";

const theme = {
  fg: (_color: "toolTitle" | "muted" | "error" | "success" | "accent", text: string) => text,
  bold: (text: string) => text,
};

test("Pi panel renderer exposes compact reviewer progress and expanded activity", () => {
  const started = reducePanelEvent(createPanelViewState(), {
    v: 1,
    runId: "run-1",
    seq: 1,
    at: 1000,
    type: "panel.started",
    target: "@src",
    mode: "code",
    reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt" }],
  });
  const running = reducePanelEvent(started, { v: 1, runId: "run-1", seq: 2, at: 1010, type: "reviewer.tool.started", reviewerId: "security", tool: "read" });
  const compact = renderPanelResult({ state: running }, false, theme).render(120).join("\n");
  const expanded = renderPanelResult({ state: running }, true, theme).render(120).join("\n");
  assert.match(compact, /pi-review panel 0\/1 completed/);
  assert.match(compact, /security Security · read/);
  assert.match(expanded, /security activity/);
});
