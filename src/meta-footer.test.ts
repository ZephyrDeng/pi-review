import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDurationMs, formatReviewMetaAscii, formatReviewMetaJsonLine } from "./meta-footer.js";
import type { ReviewMeta } from "./types.js";

const sample: ReviewMeta = {
  reviewMode: "code",
  verdict: "request_changes",
  verdictSource: "parsed",
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
  assert.match(ascii, /6m 24s/);
  assert.match(ascii, /session\.jsonl/);
  assert.match(ascii, /--continue/);
  assert.doesNotMatch(ascii, /PI_REVIEW_META_JSON/);
});

test("formatReviewMetaJsonLine is one JSON line", () => {
  const line = formatReviewMetaJsonLine(sample);
  assert.ok(line.startsWith("PI_REVIEW_META_JSON: "));
  const json = JSON.parse(line.slice("PI_REVIEW_META_JSON: ".length).trim());
  assert.equal(json.verdict, "request_changes");
});