import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyFindings,
  formatClassifyAscii,
  parseMetaFindings,
  CLASSIFY_CONFIDENCE_FLOOR,
} from "./classify.js";
import type { JevConnection } from "./jev.js";
import type { ReviewFinding } from "./types.js";

const CONN: JevConnection = { apiKey: "test-key", baseUrl: "https://example.test", model: "jev-test" };

function finding(id: string, summary: string): ReviewFinding {
  return { id, summary, actionable: true };
}

function choiceFetch(mapping: Record<string, [string, number]>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const [choice, confidence] = mapping[id] ?? ["follow_up", 0.6];
      answers[id] = { type: "choice", choice, confidence };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 200, output_tokens: 12 } }),
    };
  }) as unknown as typeof fetch;
}

test("parseMetaFindings accepts a PI_REVIEW_META_JSON line", () => {
  const line = `PI_REVIEW_META_JSON: ${JSON.stringify({ findings: [{ id: "F1", summary: "bug", actionable: true }] })}`;
  const findings = parseMetaFindings(`some stderr\n${line}\nmore`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.id, "F1");
});

test("parseMetaFindings accepts a bare meta JSON object", () => {
  const findings = parseMetaFindings(JSON.stringify({ findings: [{ summary: "bug", actionable: true }] }));
  assert.equal(findings.length, 1);
});

test("classifyFindings fans out one Choice per finding and maps answers", async () => {
  const result = await classifyFindings(
    CONN,
    "baseline: fix the login crash",
    [finding("F1", "login crash on empty password"), finding("F2", "sidebar color drift")],
    choiceFetch({ F1: ["in_scope_blocker", 0.93], F2: ["follow_up", 0.71] }),
  );
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]!.classification, "in_scope_blocker");
  assert.equal(result.findings[0]!.confidence, 0.93);
  assert.equal(result.findings[0]!.uncertain, false);
  assert.equal(result.findings[1]!.classification, "follow_up");
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 12 });
});

test("classifyFindings flags low confidence as uncertain", async () => {
  const result = await classifyFindings(
    CONN,
    "baseline",
    [finding("F1", "murky one")],
    choiceFetch({ F1: ["stop_and_escalate", CLASSIFY_CONFIDENCE_FLOOR - 0.01] }),
  );
  assert.equal(result.findings[0]!.classification, "stop_and_escalate");
  assert.equal(result.findings[0]!.uncertain, true);
});

test("classifyFindings rejects a choice outside the criteria (never invents a class)", async () => {
  const badFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ answers: { F1: { type: "choice", choice: "made_up_class", confidence: 0.9 } } }),
  })) as unknown as typeof fetch;
  const result = await classifyFindings(CONN, "baseline", [finding("F1", "x")], badFetch);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.unclassified, ["F1"]);
});

test("classifyFindings assigns fallback ids when findings lack them", async () => {
  const result = await classifyFindings(CONN, "baseline", [{ summary: "no id", actionable: true }], choiceFetch({}));
  assert.equal(result.findings[0]!.id, "F1");
});

test("formatClassifyAscii groups by class and marks uncertainty", () => {
  const text = formatClassifyAscii({
    baselineChars: 10,
    findings: [
      { id: "F1", summary: "crash", classification: "in_scope_blocker", confidence: 0.9, uncertain: false },
      { id: "F2", summary: "murky", classification: "stop_and_escalate", confidence: 0.3, uncertain: true },
    ],
    unclassified: [],
    model: "jev-1.13.0",
  });
  assert.match(text, /In-scope\s+F1/);
  assert.match(text, /Escalate\s+F2/);
  assert.match(text, /F2  STOP_AND_ESCALATE  0\.30 \(low confidence\)/);
});

test("parseMetaFindings takes the LAST meta line (loop output, one per round)", () => {
  const round1 = `PI_REVIEW_META_JSON: ${JSON.stringify({ findings: [{ id: "F1", summary: "round one", actionable: true }] })}`;
  const round2 = `PI_REVIEW_META_JSON: ${JSON.stringify({ findings: [{ id: "F9", summary: "final round", actionable: true }] })}`;
  const findings = parseMetaFindings(`${round1}\n${round2}\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.id, "F9");
});

test("classifyFindings rejects prototype-chain choice names", async () => {
  const badFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ answers: { F1: { type: "choice", choice: "constructor", confidence: 0.99 } } }),
  })) as unknown as typeof fetch;
  const result = await classifyFindings(CONN, "baseline", [finding("F1", "x")], badFetch);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.unclassified, ["F1"]);
});
