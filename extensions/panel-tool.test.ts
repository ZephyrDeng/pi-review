import assert from "node:assert/strict";
import { test } from "node:test";
import { createPanelViewState, reducePanelEvent } from "@zephyrdeng/pi-review";
import { buildPanelResultContent, panelToolParamError, registerPanelReviewTool, renderPanelResult } from "./panel-tool.js";

const theme = {
  fg: (_color: "toolTitle" | "muted" | "error" | "success" | "accent", text: string) => text,
  bold: (text: string) => text,
};

test("panel tool boundary rejects single-reviewer and out-of-range widths", () => {
  assert.match(panelToolParamError({ target: "@src", reviewers: 1 }) ?? "", /between 2 and 8/);
  assert.match(panelToolParamError({ target: "@src", reviewers: 9 }) ?? "", /between 2 and 8/);
  assert.match(panelToolParamError({ target: "@src", panel: "code-experts", reviewers: 2 }) ?? "", /cannot be combined/);
  assert.equal(panelToolParamError({ target: "@src", reviewers: 2 }), undefined);
  assert.equal(panelToolParamError({ target: "@src", panel: "code-experts" }), undefined);
});

test("registered pi_review rejects reviewers=1 before spawning the panel CLI", async () => {
  let registered: { execute: (...args: any[]) => Promise<any> } | undefined;
  registerPanelReviewTool({
    registerTool(tool: { execute: (...args: any[]) => Promise<any> }) {
      registered = tool;
    },
  } as never);
  assert.ok(registered);
  const result = await registered!.execute(
    "tool-call",
    { target: "@src", reviewers: 1 },
    new AbortController().signal,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /between 2 and 8/);
});

test("Pi panel renderer exposes compact reviewer progress and expanded activity", () => {
  const now = Date.now();
  const started = reducePanelEvent(createPanelViewState(), {
    v: 1,
    runId: "run-1",
    seq: 1,
    at: now,
    type: "panel.started",
    target: "@src",
    mode: "code",
    reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt", thinking: "high" }],
  });
  const reviewerStarted = reducePanelEvent(started, { v: 1, runId: "run-1", seq: 2, at: now, type: "reviewer.started", reviewerId: "security" });
  const running = reducePanelEvent(reviewerStarted, { v: 1, runId: "run-1", seq: 3, at: now - 4500, type: "reviewer.tool.started", reviewerId: "security", tool: "read", summary: "src/panel.ts" });
  const compact = renderPanelResult({ state: running }, false, theme).render(120).join("\n");
  const expanded = renderPanelResult({ state: running }, true, theme).render(120).join("\n");
  assert.match(compact, /pi-review panel 0\/1 completed/);
  assert.match(compact, /security Security · openai\/gpt · high · read · src\/panel\.ts · 0s · idle 4s/);
  assert.match(expanded, /security activity/);
});

test("Pi panel renderer expands final findings and reviewer provenance", () => {
  const now = Date.now();
  let state = reducePanelEvent(createPanelViewState(), {
    v: 1,
    runId: "run-1",
    seq: 1,
    at: now,
    type: "panel.started",
    target: "@src",
    mode: "code",
    reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt", thinking: "high" }],
  });
  state = reducePanelEvent(state, {
    v: 1,
    runId: "run-1",
    seq: 2,
    at: now,
    type: "panel.completed",
    meta: {
      strategy: "panel",
      reviewMode: "code",
      status: "has_findings",
      verdict: "request_changes",
      verdictSource: "parsed",
      findings: [],
      actionableCount: 1,
      durationMs: 1200,
      model: "openai/gpt",
      configuredReviewers: 1,
      successfulReviewers: 1,
      consensusPolicy: "quorum",
      consensusThreshold: 1,
      panelHealth: "healthy",
      confirmedClusters: [{ id: "C1", summary: "Auth bypass", supportingReviewerIds: ["security"], sourceFindingIds: ["F1"], confirmed: true, severity: "high", path: "src/auth.ts", supportCount: 1, actionableSupportCount: 1 }],
      advisories: [{ id: "C2", summary: "Naming nit", supportingReviewerIds: ["security"], sourceFindingIds: ["F2"], confirmed: false, supportCount: 1, actionableSupportCount: 0 }],
      reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt", thinking: "high", durationMs: 1100, status: "has_findings", verdict: "request_changes", verdictSource: "parsed", contributed: true }],
      adjudicationUsed: false,
    },
  });
  const expanded = renderPanelResult({ state }, true, theme).render(120).join("\n");
  assert.match(expanded, /Confirmed findings/);
  assert.match(expanded, /Auth bypass/);
  assert.match(expanded, /Advisories/);
  assert.match(expanded, /Naming nit/);
  assert.match(expanded, /Provenance/);
  assert.match(expanded, /security · Security · openai\/gpt · high · has_findings/);

  state = reducePanelEvent(createPanelViewState(), {
    v: 1,
    runId: "run-2",
    seq: 1,
    at: now,
    type: "panel.completed",
    meta: {
      strategy: "panel",
      reviewMode: "code",
      status: "clean",
      verdict: "approve",
      verdictSource: "parsed",
      findings: [],
      actionableCount: 0,
      durationMs: 10,
      model: null,
      configuredReviewers: 0,
      successfulReviewers: 0,
      consensusPolicy: "quorum",
      consensusThreshold: 1,
      panelHealth: "healthy",
      confirmedClusters: [],
      advisories: [],
      reviewers: [],
      adjudicationUsed: false,
    },
  });
  const empty = renderPanelResult({ state }, true, theme).render(120).join("\n");
  assert.match(empty, /Confirmed findings[\s\S]*None\./);
  assert.match(empty, /Advisories[\s\S]*None\./);
  assert.match(empty, /Provenance[\s\S]*None\./);
});

test("panel tool content carries full conclusion for the parent LLM", () => {
  const now = Date.now();
  let state = reducePanelEvent(createPanelViewState(), {
    v: 1,
    runId: "run-content",
    seq: 1,
    at: now,
    type: "panel.started",
    target: "@src",
    mode: "code",
    reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt", thinking: "high" }],
  });
  state = reducePanelEvent(state, {
    v: 1,
    runId: "run-content",
    seq: 2,
    at: now,
    type: "reviewer.completed",
    reviewerId: "security",
    submission: {
      reviewerId: "security",
      role: "Security",
      model: "openai/gpt",
      thinking: "high",
      durationMs: 100,
      result: {
        status: "has_findings",
        verdict: "request_changes",
        verdictSource: "parsed",
        actionableCount: 1,
        findings: [{ summary: "Auth bypass in session cookie", actionable: true, path: "src/auth.ts" }],
      },
    },
  });
  state = reducePanelEvent(state, {
    v: 1,
    runId: "run-content",
    seq: 3,
    at: now,
    type: "panel.completed",
    meta: {
      strategy: "panel",
      reviewMode: "code",
      status: "has_findings",
      verdict: "request_changes",
      verdictSource: "parsed",
      findings: [],
      actionableCount: 1,
      durationMs: 1200,
      model: "openai/gpt",
      configuredReviewers: 1,
      successfulReviewers: 1,
      consensusPolicy: "quorum",
      consensusThreshold: 1,
      panelHealth: "healthy",
      confirmedClusters: [{ id: "C1", summary: "Auth bypass", supportingReviewerIds: ["security"], sourceFindingIds: ["F1"], confirmed: true, severity: "high", path: "src/auth.ts", supportCount: 1, actionableSupportCount: 1 }],
      advisories: [{ id: "C2", summary: "Naming nit", supportingReviewerIds: ["security"], sourceFindingIds: ["F2"], confirmed: false, supportCount: 1, actionableSupportCount: 0 }],
      reviewers: [{ reviewerId: "security", role: "Security", model: "openai/gpt", thinking: "high", durationMs: 1100, status: "has_findings", verdict: "request_changes", verdictSource: "parsed", contributed: true }],
      adjudicationUsed: false,
    },
  });

  const content = buildPanelResultContent(state);
  assert.match(content, /### Confirmed findings/);
  assert.match(content, /Auth bypass/);
  assert.match(content, /### Advisories/);
  assert.match(content, /Naming nit/);
  assert.match(content, /### Provenance/);
  assert.match(content, /security · Security · openai\/gpt · high · has_findings/);
  assert.match(content, /### Reviewer summaries/);
  assert.match(content, /Auth bypass in session cookie/);

  const expanded = renderPanelResult({ state }, true, theme).render(160).join("\n");
  assert.match(expanded, /Reviewer summaries/);
  assert.match(expanded, /Auth bypass in session cookie/);
});
