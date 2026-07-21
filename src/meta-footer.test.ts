import assert from "node:assert/strict";
import { test } from "vitest";
import { formatCost, formatDurationMs, formatPanelMetaAscii, formatReviewMetaAscii, formatReviewMetaJsonLine, formatTokens, formatUsage } from "./meta-footer.js";
import type { PanelReviewMeta, ReviewMeta } from "./types.js";

const sample: ReviewMeta = {
  reviewMode: "code",
  verdict: "request_changes",
  verdictSource: "parsed",
  status: "has_findings",
  findings: [
    {
      id: "F1",
      severity: "high",
      path: "src/cli.ts",
      summary: "Dirty reviews exit zero",
      actionable: true,
    },
  ],
  actionableCount: 1,
  durationMs: 383_500,
  model: "zai/glm-5.2",
  sessionHandle: "/tmp/sessions/run-abc/session.jsonl",
};

test("formatDurationMs formats sub-minute and minutes", () => {
  assert.equal(formatDurationMs(450), "450ms");
  assert.equal(formatDurationMs(383_500), "6m 24s");
});

test("formatReviewMetaAscii includes verdict and session hint", () => {
  const ascii = formatReviewMetaAscii(sample);
  assert.match(ascii, /REQUEST CHANGES/);
  assert.match(ascii, /HAS FINDINGS/);
  assert.match(ascii, /1 actionable/);
  assert.match(ascii, /6m 24s/);
  assert.match(ascii, /session\.jsonl/);
  assert.match(ascii, /--continue/);
  assert.doesNotMatch(ascii, /PI_REVIEW_META_JSON/);
});

test("formatReviewMetaJsonLine is one JSON line", () => {
  const line = formatReviewMetaJsonLine(sample);
  assert.ok(line.startsWith("PI_REVIEW_META_JSON: "));
  const json = JSON.parse(line.slice("PI_REVIEW_META_JSON: ".length).trim());
  assert.equal(json.reviewMode, "code");
  assert.equal(json.verdict, "request_changes");
  assert.equal(json.verdictSource, "parsed");
  assert.equal(json.durationMs, 383_500);
  assert.equal(json.model, "zai/glm-5.2");
  assert.equal(json.sessionHandle, "/tmp/sessions/run-abc/session.jsonl");
  assert.equal(json.status, "has_findings");
  assert.equal(json.actionableCount, 1);
  assert.deepEqual(json.findings, sample.findings);
});

test("formatTokens scales with K/M/B units", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(512), "512");
  assert.equal(formatTokens(1024), "1.0K");
  assert.equal(formatTokens(18031), "17.6K");
  assert.equal(formatTokens(1_500_000), "1.4M");
  assert.equal(formatTokens(2_500_000_000), "2.3B");
});

test("formatCost preserves useful precision for small costs", () => {
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.05), "$0.05");
  assert.equal(formatCost(0.0001), "$0.0001");
});

test("formatUsage renders in/out/cache/reason breakdown", () => {
  const text = formatUsage({ input: 1024, output: 512, cacheRead: 2048, cacheWrite: 0, reasoning: 100 });
  assert.match(text, /in 1\.0K/);
  assert.match(text, /out 512/);
  assert.match(text, /cache 2\.0K/);
  assert.match(text, /reason 100/);
});

test("ASCII footer shows thinking, tokens, cost, and duration when present", () => {
  const meta = { ...sample, thinking: "xhigh", usage: { input: 1024, output: 512, cacheRead: 2048, cacheWrite: 0, reasoning: 0, totalTokens: 3584, costTotal: 0.1234 } };
  const ascii = formatReviewMetaAscii(meta);
  assert.match(ascii, /Thinking\s+xhigh/);
  assert.match(ascii, /Tokens\s+in .*out .*cache/);
  assert.match(ascii, /Cost\s+\$0\.1234/);
  assert.match(ascii, /Duration\s+6m 24s/);
});

const panelSample: PanelReviewMeta = {
  strategy: "panel",
  reviewMode: "code",
  status: "has_findings",
  verdict: "request_changes",
  verdictSource: "parsed",
  findings: [],
  actionableCount: 0,
  durationMs: 1200,
  model: "provider/model-a",
  configuredReviewers: 2,
  successfulReviewers: 2,
  consensusPolicy: "quorum",
  consensusThreshold: 2,
  panelHealth: "healthy",
  confirmedClusters: [],
  advisories: [],
  reviewers: [
    { reviewerId: "r1", role: "one", model: "provider/model-a", durationMs: 100, status: "clean", verdict: "approve", verdictSource: "parsed", contributed: true },
    { reviewerId: "r2", role: "two", model: null, responseModel: "provider/model-a", durationMs: 100, status: "clean", verdict: "approve", verdictSource: "parsed", contributed: true },
  ],
  adjudicationUsed: false,
};

test("panel ASCII footer shows a top-level Model line when every reviewer's effective model agrees", () => {
  const ascii = formatPanelMetaAscii(panelSample);
  assert.match(ascii, /Model\s+provider\/model-a/);
});

test("panel ASCII footer renders the mixed sentinel on the Model line as-is", () => {
  const ascii = formatPanelMetaAscii({ ...panelSample, model: "mixed" });
  assert.match(ascii, /Model\s+mixed/);
});

test("panel ASCII footer omits the Model line when no panel-level model is known", () => {
  const ascii = formatPanelMetaAscii({ ...panelSample, model: null });
  assert.doesNotMatch(ascii, /Model/);
});

test("panel ASCII footer reviewer rows fall back to the response model when unconfigured", () => {
  const ascii = formatPanelMetaAscii(panelSample);
  // r1 has an explicit configured model; r2 has none and falls back to responseModel.
  assert.match(ascii, /r1 \| CLEAN \| approve \| role:one \| provider\/model-a/);
  assert.match(ascii, /r2 \| CLEAN \| approve \| role:two \| provider\/model-a/);
});