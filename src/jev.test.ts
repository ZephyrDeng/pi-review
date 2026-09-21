import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createJevAdjudicator,
  evaluateNouls,
  hasJevApiKey,
  resolveJev,
  resolveJevConnection,
  withAdjudicationFallback,
  withUncertaintyEscalation,
  JevError,
  type JevConnection,
} from "./jev.js";
import type { AdjudicationResponse } from "./matcher.js";
import type { SourceFinding } from "./types.js";

const CONN: JevConnection = { apiKey: "test-key", baseUrl: "https://example.test", model: "jev-test" };

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("hasJevApiKey requires a non-blank TYPESAFE_API_KEY", () => {
  assert.equal(hasJevApiKey(env({})), false);
  assert.equal(hasJevApiKey(env({ TYPESAFE_API_KEY: "  " })), false);
  assert.equal(hasJevApiKey(env({ TYPESAFE_API_KEY: "sk-x" })), true);
});

test("resolveJev: env truthy overrides config and default", () => {
  assert.deepEqual(resolveJev(env({ PI_REVIEW_JEV: "1" }), {}), { enabled: true, source: "env" });
  assert.deepEqual(resolveJev(env({ PI_REVIEW_JEV: "true" }), { jev: false }), { enabled: true, source: "env" });
  assert.deepEqual(resolveJev(env({ PI_REVIEW_JEV: "on" }), {}), { enabled: true, source: "env" });
});

test("resolveJev: any other set env value disables", () => {
  assert.deepEqual(resolveJev(env({ PI_REVIEW_JEV: "0", TYPESAFE_API_KEY: "sk-x" }), {}), { enabled: false, source: "env" });
  assert.deepEqual(resolveJev(env({ PI_REVIEW_JEV: "off" }), { jev: true }), { enabled: false, source: "env" });
});

test("resolveJev: config beats the key-presence default", () => {
  assert.deepEqual(resolveJev(env({ TYPESAFE_API_KEY: "sk-x" }), { jev: false }), { enabled: false, source: "config" });
  assert.deepEqual(resolveJev(env({}), { jev: true }), { enabled: true, source: "config" });
});

test("resolveJev: default follows key presence (enhancement mode)", () => {
  assert.deepEqual(resolveJev(env({ TYPESAFE_API_KEY: "sk-x" }), {}), { enabled: true, source: "default" });
  assert.deepEqual(resolveJev(env({}), {}), { enabled: false, source: "default" });
});

test("resolveJevConnection honors overrides and never logs the key", () => {
  assert.equal(resolveJevConnection(env({})), undefined);
  const conn = resolveJevConnection(env({ TYPESAFE_API_KEY: "sk-secret" }))!;
  assert.equal(conn.baseUrl, "https://api.typesafe.ai");
  assert.equal(conn.model, "jev-latest");
  const custom = resolveJevConnection(env({ TYPESAFE_API_KEY: "sk", TYPESAFE_BASE_URL: "http://127.0.0.1:8787", PI_REVIEW_JEV_MODEL: "jev-1.13.0" }))!;
  assert.equal(custom.baseUrl, "http://127.0.0.1:8787");
  assert.equal(custom.model, "jev-1.13.0");
});

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

test("evaluateNouls sends one fan-out call and maps answers to probabilities", async () => {
  let sentBody: Record<string, unknown> | undefined;
  let sentAuth = "";
  const fetchImpl = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    sentBody = JSON.parse(init.body);
    sentAuth = init.headers.authorization;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-1.13.0",
        answers: { q1: { type: "noul", noul: 0.91 }, q2: { type: "noul", noul: 0.12 } },
        usage: { input_tokens: 100, output_tokens: 8 },
      }),
    };
  }) as unknown as typeof fetch;
  const result = await evaluateNouls(CONN, { x: 1 }, { q1: "same?", q2: "same?" }, fetchImpl);
  assert.equal(sentAuth, "Bearer test-key");
  assert.equal(sentBody!.model, "jev-test");
  const questions = sentBody!.questions as Record<string, { type: string }>;
  assert.equal(questions.q1!.type, "noul");
  assert.equal(questions.q2!.type, "noul");
  assert.deepEqual(result.probabilities, { q1: 0.91, q2: 0.12 });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 8 });
  assert.equal(result.model, "jev-1.13.0");
});

test("evaluateNouls reports missing/malformed answers without failing the call", async () => {
  const fetchImpl = mockFetch(200, { answers: { q1: { type: "noul", noul: 2 }, q3: { type: "noul", noul: 0.5 } } });
  const result = await evaluateNouls(CONN, {}, { q1: "a", q2: "b", q3: "c" }, fetchImpl);
  assert.deepEqual(result.probabilities, { q3: 0.5 });
  assert.deepEqual(result.missing.sort(), ["q1", "q2"]);
});

test("evaluateNouls throws JevError on http failure and missing answers object", async () => {
  await assert.rejects(evaluateNouls(CONN, {}, { q: "x" }, mockFetch(429, {})), JevError);
  await assert.rejects(evaluateNouls(CONN, {}, { q: "x" }, mockFetch(200, { nope: 1 })), JevError);
  const boom = (async () => { throw new Error("socket hangup"); }) as unknown as typeof fetch;
  await assert.rejects(evaluateNouls(CONN, {}, { q: "x" }, boom), /socket hangup/);
});

test("evaluateNouls retries transient 503/502/network failures then succeeds", async () => {
  const sequence: Array<{ status: number; body?: unknown; error?: Error }> = [
    { status: 503 },
    { status: 502 },
    { status: 200, body: { answers: { q: { type: "noul", noul: 0.7 } } } },
  ];
  let calls = 0;
  const fetchImpl = (async () => {
    const step = sequence[Math.min(calls++, sequence.length - 1)]!;
    if (step.error) throw step.error;
    return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => step.body };
  }) as unknown as typeof fetch;
  const result = await evaluateNouls(CONN, {}, { q: "a" }, fetchImpl);
  assert.equal(calls, 3);
  assert.deepEqual(result.probabilities, { q: 0.7 });
});

test("evaluateNouls retries network errors then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    if (calls++ === 0) throw new Error("socket hangup");
    return { ok: true, status: 200, json: async () => ({ answers: { q: { type: "noul", noul: 0.3 } } }) };
  }) as unknown as typeof fetch;
  const result = await evaluateNouls(CONN, {}, { q: "a" }, fetchImpl);
  assert.equal(calls, 2);
  assert.deepEqual(result.probabilities, { q: 0.3 });
});

test("evaluateNouls does not retry non-transient http errors", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return { ok: false, status: 403, json: async () => ({}) };
  }) as unknown as typeof fetch;
  await assert.rejects(evaluateNouls(CONN, {}, { q: "x" }, fetchImpl), /http 403/);
  assert.equal(calls, 1);
});

test("evaluateNouls gives up after MAX_ATTEMPTS on persistent 503", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return { ok: false, status: 503, json: async () => ({}) };
  }) as unknown as typeof fetch;
  await assert.rejects(evaluateNouls(CONN, {}, { q: "x" }, fetchImpl), /http 503/);
  assert.equal(calls, 3);
});

function candidate(anchorPath: string, ids: string[]): { anchorPath: string; findings: SourceFinding[] } {
  return {
    anchorPath,
    findings: ids.map((id) => ({
      id,
      reviewerId: id.split("#")[0]!,
      finding: { summary: `summary for ${id}`, actionable: true, path: anchorPath },
    })),
  };
}

test("createJevAdjudicator turns pair probabilities into per-pair merges", async () => {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, { type: string; noul: number }> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
    return { ok: true, status: 200, json: async () => ({ answers }) };
  }) as unknown as typeof fetch;
  const adjudicator = createJevAdjudicator(CONN, { fetchImpl });
  const response = await adjudicator.adjudicate({
    candidates: [candidate("src/a.ts", ["r1#F1", "r2#F1", "r2#F2"])],
  });
  // 3 findings in one group => 3 pair questions, all merged with confidence = probability.
  assert.equal(response.merges.length, 3);
  assert.ok(response.merges.every((m) => m.confidence === 0.9));
  assert.deepEqual(response.errors ?? [], []);
});

test("createJevAdjudicator: empty candidates short-circuit without a fetch", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; throw new Error("should not be called"); }) as unknown as typeof fetch;
  const adjudicator = createJevAdjudicator(CONN, { fetchImpl });
  const response = await adjudicator.adjudicate({ candidates: [] });
  assert.deepEqual(response, { merges: [] });
  assert.equal(called, false);
});

test("createJevAdjudicator omits pairs whose answers are missing (conservative no-merge)", async () => {
  const fetchImpl = mockFetch(200, { answers: { g0p0_1: { type: "noul", noul: 0.8 } } });
  const adjudicator = createJevAdjudicator(CONN, { fetchImpl });
  const response = await adjudicator.adjudicate({ candidates: [candidate("src/a.ts", ["r1#F1", "r2#F1"])] });
  assert.equal(response.merges.length, 1);
  assert.deepEqual(response.merges[0], { sourceFindingIds: ["r1#F1", "r2#F1"], confidence: 0.8 });
});

test("withAdjudicationFallback delegates and reports the engine switch", async () => {
  const calls: string[] = [];
  const primary = {
    async adjudicate(): Promise<AdjudicationResponse> { throw new JevError("http 500"); },
  };
  const fallback = {
    async adjudicate(): Promise<AdjudicationResponse> { calls.push("fallback"); return { merges: [] }; },
  };
  const notes: string[] = [];
  const wrapped = withAdjudicationFallback(primary, fallback, (m) => notes.push(m));
  assert.equal(wrapped.engine(), "jev");
  const response = await wrapped.adjudicator.adjudicate({ candidates: [] });
  assert.deepEqual(response, { merges: [] });
  assert.deepEqual(calls, ["fallback"]);
  assert.equal(wrapped.engine(), "pi");
  assert.match(wrapped.note()!, /jev adjudication failed/);
  assert.equal(notes.length, 1);
});

test("withAdjudicationFallback keeps jev engine when the primary succeeds", async () => {
  const primary = { async adjudicate(): Promise<AdjudicationResponse> { return { merges: [{ sourceFindingIds: ["a", "b"], confidence: 0.9 }] }; } };
  const fallback = { async adjudicate(): Promise<AdjudicationResponse> { throw new Error("must not run"); } };
  const wrapped = withAdjudicationFallback(primary, fallback);
  const response = await wrapped.adjudicator.adjudicate({ candidates: [] });
  assert.equal(response.merges.length, 1);
  assert.equal(wrapped.engine(), "jev");
  assert.equal(wrapped.note(), undefined);
});

test("withUncertaintyEscalation re-judges only the borderline band with the strong tier", async () => {
  const fast = {
    async adjudicate() {
      return {
        merges: [
          { sourceFindingIds: ["a", "b"], confidence: 0.95 }, // clear merge — untouched
          { sourceFindingIds: ["c", "d"], confidence: 0.1 },  // clear distinct — untouched
          { sourceFindingIds: ["e", "f"], confidence: 0.55 }, // borderline — escalated
        ],
      };
    },
  };
  const strongCalls: string[][] = [];
  const strong = {
    async adjudicate(request: { candidates: Array<{ findings: Array<{ id: string }> }> }) {
      strongCalls.push(request.candidates.flatMap((c) => c.findings.map((f) => f.id)));
      return { merges: [{ sourceFindingIds: ["e", "f"], confidence: 0.9 }] };
    },
  };
  let note: string | undefined;
  const cascade = withUncertaintyEscalation(fast as never, strong as never, (m) => { note = m; });
  const result = await cascade.adjudicate({
    candidates: [{
      anchorPath: "src/x.ts",
      findings: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, reviewerId: "r1", finding: { summary: id, actionable: true } })),
    }],
  } as never);
  // Strong tier saw ONLY the borderline findings
  assert.deepEqual(strongCalls, [["e", "f"]]);
  // Clear merges pass through; the borderline pair is replaced by the strong verdict
  assert.deepEqual(
    result.merges.map((m) => [m.sourceFindingIds, m.confidence]),
    [[["a", "b"], 0.95], [["c", "d"], 0.1], [["e", "f"], 0.9]],
  );
  assert.match(note!, /escalated 1 borderline pair/);
});

test("withUncertaintyEscalation keeps fast-tier judgments when the strong tier fails", async () => {
  const fast = { async adjudicate() { return { merges: [{ sourceFindingIds: ["a", "b"], confidence: 0.5 }] }; } };
  const strong = { async adjudicate() { throw new Error("pi down"); } };
  const cascade = withUncertaintyEscalation(fast as never, strong as never);
  const result = await cascade.adjudicate({
    candidates: [{ anchorPath: "x", findings: [{ id: "a", reviewerId: "r1", finding: { summary: "a", actionable: true } }, { id: "b", reviewerId: "r2", finding: { summary: "b", actionable: true } }] }],
  } as never);
  assert.deepEqual(result.merges, [{ sourceFindingIds: ["a", "b"], confidence: 0.5 }]);
});

test("withUncertaintyEscalation skips the strong tier when nothing is borderline", async () => {
  const fast = { async adjudicate() { return { merges: [{ sourceFindingIds: ["a", "b"], confidence: 0.9 }] }; } };
  let called = false;
  const strong = { async adjudicate() { called = true; return { merges: [] }; } };
  const cascade = withUncertaintyEscalation(fast as never, strong as never);
  await cascade.adjudicate({
    candidates: [{ anchorPath: "x", findings: [{ id: "a", reviewerId: "r1", finding: { summary: "a", actionable: true } }, { id: "b", reviewerId: "r2", finding: { summary: "b", actionable: true } }] }],
  } as never);
  assert.equal(called, false);
});
