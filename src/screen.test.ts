import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  sliceHunks,
  screenHunks,
  formatScreenAscii,
  effectiveScreenPatterns,
  collectFlaggedHunks,
  SCREEN_PATTERNS,
  SCREEN_THRESHOLD,
  MAX_HUNKS_PER_FILE,
  MAX_QUESTIONS_PER_CALL,
} from "./screen.js";
import type { JevConnection } from "./jev.js";

const CONN: JevConnection = { apiKey: "test-key", baseUrl: "https://example.test", model: "jev-test" };

const FIXTURE = `import { randomUUID } from "node:crypto";

export interface Order {
  id: string;
}

export class OrderService {
  async getOrder(id: string): Promise<Order | undefined> {
    return undefined;
  }

  async placeOrder(customerId: string, items: unknown[]): Promise<void> {
    let total = 0;
    for (let i = 0; i <= items.length; i++) {
      total += 1;
    }
    if (total === 100.0) {
      return;
    }
  }

  async listPage(items: Order[], page: number): Promise<Order[]> {
    return items.slice(0, page - 1);
  }
}
`;

/** Mock System One: per-question probability map, missing ids fall back to `fallback`. */
function noulFetch(probabilities: Record<string, number>, fallback = 0.05): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = { type: "noul", noul: probabilities[id] ?? fallback };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 10 } }),
    };
  }) as unknown as typeof fetch;
}

test("sliceHunks splits at declarations with a header hunk and line ranges", () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const ids = hunks.map((h) => h.id);
  assert.deepEqual(ids, ["header", "Order", "OrderService", "getOrder", "placeOrder", "listPage"]);
  const placeOrder = hunks.find((h) => h.id === "placeOrder")!;
  assert.ok(placeOrder.code.includes("i <= items.length"));
  assert.ok(!placeOrder.code.includes("listPage"));
  assert.equal(placeOrder.startLine, FIXTURE.split("\n").findIndex((l) => l.includes("async placeOrder")) + 1);
  assert.ok(placeOrder.endLine > placeOrder.startLine);
});

test("sliceHunks skips control-flow keywords and empty headers", () => {
  const hunks = sliceHunks("x.ts", "export function main() {\n  if (a) {\n    for (let i = 0;;) {}\n  }\n}\n");
  assert.deepEqual(hunks.map((h) => h.id), ["main"]);
});

test("sliceHunks slices Python def/class and Go func/method declarations", () => {
  const py = `import os\n\n\ndef helper(x=[]):\n    x.append(1)\n\n\nclass Service:\n    def handle(self, req):\n        return req\n\n\nasync def fetch(url):\n    pass\n`;
  assert.deepEqual(sliceHunks("svc.py", py).map((h) => h.id), ["header", "helper", "Service", "handle", "fetch"]);

  const go = `package svc\n\nfunc placeOrder(items []Item) error {\n\treturn nil\n}\n\nfunc (s *Service) List(ctx context.Context) {\n}\n`;
  assert.deepEqual(sliceHunks("svc.go", go).map((h) => h.id), ["header", "placeOrder", "List"]);
});

test("sliceHunks does not split on with/except/case compound statements or bare calls", () => {
  const py = `def run():\n    with open(f) as fh:\n        data = fh.read()\n    try:\n        parse(data)\n    except (ValueError, KeyError):\n        pass\n`;
  assert.deepEqual(sliceHunks("run.py", py).map((h) => h.id), ["run"]);
});

test("sliceHunks falls back to one file hunk when no boundary matches", () => {
  const hunks = sliceHunks("plain.txt", "alpha\nbeta\ngamma\n");
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.id, "file");
  assert.equal(hunks[0]!.endLine, 4); // trailing newline counts as an empty 4th line
});

test("sliceHunks merges overflow into the last hunk instead of dropping code", () => {
  const text = Array.from({ length: 5 }, (_, i) => `export function f${i}() {\n  return ${i};\n}`).join("\n") + "\n";
  const hunks = sliceHunks("many.ts", text, 3);
  assert.equal(hunks.length, 3);
  assert.ok(hunks[2]!.code.includes("f4"));
  assert.ok(hunks[2]!.endLine === text.split("\n").length);
});

test("screenHunks assembles pattern-matched findings from templates", async () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const placeIdx = hunks.findIndex((h) => h.id === "placeOrder");
  const loopIdx = Object.keys(SCREEN_PATTERNS).indexOf("off_by_one_loop");
  const eqIdx = Object.keys(SCREEN_PATTERNS).indexOf("float_equality");
  const result = await screenHunks(CONN, hunks, {
    fetchImpl: noulFetch({ [`d${placeIdx}`]: 0.96, [`p${placeIdx}_${loopIdx}`]: 0.98, [`p${placeIdx}_${eqIdx}`]: 0.8 }),
  });
  assert.equal(result.status, "has_findings");
  assert.equal(result.findings.length, 2);
  const first = result.findings[0]!;
  assert.equal(first.summary, SCREEN_PATTERNS.off_by_one_loop.title);
  assert.equal(first.severity, "critical");
  assert.equal(first.actionable, true);
  assert.equal(first.path, "order-service.ts");
  assert.equal(first.location?.startLine, hunks[placeIdx]!.startLine);
  assert.ok(first.details!.includes("off_by_one_loop"));
  assert.equal(first.recommendation, SCREEN_PATTERNS.off_by_one_loop.recommendation);
});

test("screenHunks emits an unmatched-signal finding when only the catch-all fires", async () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const getIdx = hunks.findIndex((h) => h.id === "getOrder");
  const result = await screenHunks(CONN, hunks, { fetchImpl: noulFetch({ [`d${getIdx}`]: 0.9 }) });
  assert.equal(result.status, "has_findings");
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0]!.summary.includes("matched no known pattern"));
  assert.ok(result.findings[0]!.recommendation!.includes("pi-review"));
});

test("screenHunks reports clean when everything is below threshold", async () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const result = await screenHunks(CONN, hunks, { fetchImpl: noulFetch({}) });
  assert.equal(result.status, "clean");
  assert.equal(result.findings.length, 0);
  assert.equal(result.questions, hunks.length * (Object.keys(SCREEN_PATTERNS).length + 1));
  assert.equal(result.calls, 1);
});

test("screenHunks chunks question volumes past the per-call cap", async () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const perHunk = Object.keys(SCREEN_PATTERNS).length + 1;
  const expectedCalls = Math.ceil((hunks.length * perHunk) / MAX_QUESTIONS_PER_CALL);
  assert.ok(expectedCalls >= 1);
  // Force chunking with a tiny cap by screening many copies.
  const many = Array.from({ length: Math.ceil(MAX_QUESTIONS_PER_CALL / perHunk) + 1 }, () => hunks).flat();
  const result = await screenHunks(CONN, many, { fetchImpl: noulFetch({}) });
  assert.ok(result.calls >= 2);
  assert.equal(result.status, "clean");
});

test("screenHunks screens against a caller-supplied catalog", async () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const placeIdx = hunks.findIndex((h) => h.id === "placeOrder");
  const custom = {
    my_rule: {
      title: "A custom defect rule",
      severity: "minor" as const,
      category: "correctness" as const,
      recommendation: "Fix it.",
    },
  };
  const result = await screenHunks(CONN, hunks, {
    patterns: custom,
    fetchImpl: noulFetch({ [`p${placeIdx}_0`]: 0.9 }),
  });
  assert.equal(result.questions, hunks.length * 2); // catch-all + 1 custom pattern
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.summary, "A custom defect rule");
  assert.ok(result.findings[0]!.details!.includes("my_rule"));
});

test("effectiveScreenPatterns merges user files and honors disabled ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-screen-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(
    path.join(dir, "screen-patterns.json"),
    JSON.stringify({
      patterns: {
        team_rule: { title: "Team rule", severity: "minor", category: "correctness", recommendation: "Do it." },
        off_by_one_loop: { title: "Team override of off-by-one", severity: "minor", category: "correctness", recommendation: "Fix." },
      },
      disabled: ["missing_validation", "nonexistent_id"],
    }),
  );
  const env = { PI_REVIEW_CONFIG: configPath } as NodeJS.ProcessEnv;
  const { patterns, warnings } = effectiveScreenPatterns(env);
  assert.equal(patterns.team_rule!.title, "Team rule");
  assert.equal(patterns.off_by_one_loop!.title, "Team override of off-by-one");
  assert.equal(patterns.missing_validation, undefined);
  assert.ok(warnings.some((w) => w.includes("nonexistent_id")));
  // builtin count: 21 shipped patterns; override replaced one, disable removed one
  assert.equal(Object.keys(patterns).length, Object.keys(SCREEN_PATTERNS).length + 1 - 1);
});

test("collectFlaggedHunks pairs flagged reports with their code", () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const reports = hunks.map((h, i) => ({
    id: h.id,
    path: h.path,
    startLine: h.startLine,
    endLine: h.endLine,
    defectProbability: i === 0 ? 0.9 : 0.1,
    patterns: i === 1 ? ["string_sort"] : [],
  }));
  const flagged = collectFlaggedHunks(
    { status: "has_findings", findings: [], hunkReports: reports, questions: 0, calls: 1, durationMs: 1 },
    hunks,
  );
  assert.equal(flagged.length, 2);
  assert.equal(flagged[0]!.hunk, hunks[0]!.id);
  assert.equal(flagged[0]!.code, hunks[0]!.code);
  assert.deepEqual(flagged[1]!.patterns, ["string_sort"]);
});

test("screenHunks treats missing answers as no-signal", async () => {
  const hunks = sliceHunks("order-service.ts", FIXTURE);
  const result = await screenHunks(CONN, hunks, {
    fetchImpl: (async (_url: string, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: {} }), // every answer omitted
    })) as unknown as typeof fetch,
  });
  assert.equal(result.status, "clean");
  assert.equal(result.hunkReports.length, hunks.length);
  assert.ok(result.hunkReports.every((h) => h.defectProbability === undefined));
});

test("formatScreenAscii renders status, hunks, and finding lines", () => {
  const text = formatScreenAscii({
    status: "has_findings",
    findings: [
      {
        id: "S1",
        severity: "critical",
        path: "a.ts",
        summary: "SQL injection via string interpolation",
        actionable: true,
        location: { startLine: 3, endLine: 9 },
      },
    ],
    hunkReports: [{ id: "h", path: "a.ts", startLine: 3, endLine: 9, defectProbability: 0.9, patterns: ["sql_injection"] }],
    questions: 9,
    calls: 1,
    durationMs: 900,
  });
  assert.ok(text.includes("has_findings"));
  assert.ok(text.includes("S1"));
  assert.ok(text.includes("a.ts:3-9"));
  assert.ok(SCREEN_THRESHOLD > 0 && SCREEN_THRESHOLD < 1);
});
