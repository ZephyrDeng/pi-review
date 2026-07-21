import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, afterEach } from "vitest";

let tempDir = "";
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function tsxLoaderArgs(): string[] {
  // Reuse an already-loaded tsx loader when present (e.g. running tests via
  // `npx tsx --test`), so we don't double-register. Under vitest the worker's
  // execArgv has no tsx, so fall back to the project-local tsx package which
  // Node resolves from node_modules via `--import tsx`.
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length - 1; index += 1) {
    const flag = process.execArgv[index];
    const value = process.execArgv[index + 1];
    if ((flag === "--require" || flag === "--import") && value?.includes("tsx")) {
      args.push(flag, value);
      index += 1;
    }
  }
  return args.length ? args : ["--import", "tsx"];
}

function cliPath(): string {
  return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

function repoRoot(): string {
  return path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
}

function writeFakePi(tempDir: string): string {
  const fakePi = path.join(tempDir, "fake-pi");
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || "";
const scenario = process.env.FAKE_PANEL_SCENARIO || "agree-bug";
const idMatch = prompt.match(/Reviewer ID:\\s*(\\S+)/);
const reviewerId = idMatch ? idMatch[1] : "r1";
const bug = "### F1: Off-by-one in loop\\n- Severity: high\\n- Path: src/cli.ts\\n- Actionable: yes\\n- Evidence: x\\n- Impact: y\\n- Recommendation: z";
const longBug = "### F1: " + "x".repeat(700) + "\\n- Severity: high\\n- Path: src/cli.ts\\n- Actionable: yes\\n- Evidence: x\\n- Impact: y\\n- Recommendation: z";
function emit(text) {
  function line(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
  line({ type: "session", version: 3, id: "s1" });
  line({ type: "agent_start" });
  line({ type: "turn_start" });
  line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "review" }] } });
  line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "review" }] } });
  line({ type: "message_start", message: { role: "assistant", content: [], model: "fake/model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 } } });
  line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text, partial: { role: "assistant" } } });
  line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "fake/model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 }, stopReason: "stop" } });
  line({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, totalTokens: 150 } } });
  line({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "review" }] }, { role: "assistant", content: [{ type: "text", text }], responseModel: "fake/model" }] });
}
function out(verdict, findings) {
  emit("## Verdict\\n" + verdict + "\\n\\n## Summary\\n- Fixture.\\n\\n## Findings\\n" + findings + "\\n\\n## Risks and Blind Spots\\nNone.\\n\\n## Open Questions\\nNone.\\n");
}
const bugReporters = ["r1", "r2", "correctness", "security"];
if (scenario === "runtime-fail" && reviewerId === "r2") { process.stderr.write("child crashed\\n"); process.exit(9); }
if (scenario === "agree-bug") {
  if (bugReporters.includes(reviewerId)) out("request_changes", bug);
  else out("approve", "No material findings.");
} else if (scenario === "all-clean") {
  out("approve", "No material findings.");
} else if (scenario === "long-finding") {
  out("request_changes", longBug);
} else if (scenario === "singleton") {
  if (reviewerId === "r1" || reviewerId === "correctness") out("request_changes", bug);
  else out("approve", "No material findings.");
}
process.exit(0);
`,
  );
  fs.chmodSync(fakePi, 0o755);
  return fakePi;
}

function runPanelCli(fakePi: string, scenario: string, extraArgs: string[]) {
  return spawnSync(
    process.execPath,
    [...tsxLoaderArgs(), cliPath(), ...extraArgs, "--", "@src"],
    {
      cwd: repoRoot(),
      env: { ...process.env, PI_BIN: fakePi, FAKE_PANEL_SCENARIO: scenario },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

function metaRecord(result: { stderr: string; stdout: string }): Record<string, unknown> | undefined {
  const lines = [...result.stderr.split("\n"), ...result.stdout.split("\n")];
  const metaLine = lines.find((line) => line.startsWith("PI_REVIEW_META_JSON: "));
  if (!metaLine) return undefined;
  return JSON.parse(metaLine.slice("PI_REVIEW_META_JSON: ".length));
}

test("panel review with two corroborating reviewers confirms one finding and exits 1", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "agree-bug", ["--reviewers", "3", "--consensus", "quorum", "--min-agree", "2"]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  const meta = metaRecord(result);
  assert.ok(meta, result.stderr);
  assert.equal(meta!.status, "has_findings");
  assert.equal(meta!.strategy, "panel");
  assert.equal(meta!.configuredReviewers, 3);
  assert.equal(meta!.consensusPolicy, "quorum");
  assert.equal(meta!.consensusThreshold, 2);
  assert.equal((meta!.confirmedClusters as unknown[]).length, 1);
  assert.equal((meta!.advisories as unknown[]).length, 0);
  assert.equal((meta!.reviewers as unknown[]).length, 3);
  assert.equal((meta!.confirmedClusters as Array<{ supportCount: number }>)[0]!.supportCount, 2);

  // No --model configured for any reviewer: each still surfaces the model pi
  // actually ran on (via responseModel), and the panel Model line reflects it
  // too since every reviewer converged on the same one.
  const reviewerMetas = meta!.reviewers as Array<{ model: string | null; responseModel?: string }>;
  for (const r of reviewerMetas) {
    assert.equal(r.model, null);
    assert.equal(r.responseModel, "fake/model");
  }
  assert.equal(meta!.model, "fake/model");
  assert.match(result.stdout, /Model\s+fake\/model/);
});

test("panel review keeps an explicitly configured reviewer model even when the provider reports a different one", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "agree-bug", [
    "--reviewers", "3",
    "--consensus", "quorum", "--min-agree", "2",
    "--reviewer-model", "r1=configured/explicit-model:low",
  ]);
  assert.equal(result.status, 1, result.stderr);
  const meta = metaRecord(result);
  assert.ok(meta, result.stderr);
  const reviewerMetas = meta!.reviewers as Array<{ reviewerId: string; model: string | null; responseModel?: string; thinking?: string }>;

  // Trailing :thinking still splits off and wins over any shared thinking.
  const r1 = reviewerMetas.find((r) => r.reviewerId === "r1")!;
  assert.equal(r1.model, "configured/explicit-model");
  assert.equal(r1.thinking, "low");
  // The provider-reported model is still recorded for machine consumption...
  assert.equal(r1.responseModel, "fake/model");
  // ...but display precedence keeps the configured model, never overridden.
  const r1Line = result.stdout.split("\n").find((line) => line.includes("- r1 |"));
  assert.ok(r1Line, result.stdout);
  assert.match(r1Line!, /configured\/explicit-model/);
  assert.doesNotMatch(r1Line!, /fake\/model/);

  // Reviewers without an override still surface the actual provider model.
  const r2 = reviewerMetas.find((r) => r.reviewerId === "r2")!;
  assert.equal(r2.model, null);
  assert.equal(r2.responseModel, "fake/model");

  // Mixed configured + discovered models across the panel -> panel-level "mixed".
  assert.equal(meta!.model, "mixed");
  // The sentinel also reaches the human-readable ASCII footer Model line.
  assert.match(result.stdout, /Model\s+mixed/);
});

test("panel review where all reviewers approve is clean and exits 0", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "all-clean", ["--reviewers", "3"]);
  assert.equal(result.status, 0, result.stderr);
  const meta = metaRecord(result);
  assert.ok(meta);
  assert.equal(meta!.status, "clean");
  assert.equal((meta!.confirmedClusters as unknown[]).length, 0);
  assert.equal((meta!.advisories as unknown[]).length, 0);
});

test("panel review with a singleton finding keeps it advisory and stays clean under quorum", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "singleton", ["--reviewers", "3", "--consensus", "quorum", "--min-agree", "2"]);
  assert.equal(result.status, 0, result.stderr);
  const meta = metaRecord(result);
  assert.ok(meta);
  assert.equal(meta!.status, "clean");
  assert.equal((meta!.confirmedClusters as unknown[]).length, 0);
  assert.equal((meta!.advisories as unknown[]).length, 1);
  assert.equal((meta!.advisories as Array<{ supportCount: number }>)[0]!.supportCount, 1);
});

test("panel review with a reviewer runtime failure is blocked and exits 4", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "runtime-fail", ["--reviewers", "3"]);
  assert.equal(result.status, 4, result.stderr);
  const meta = metaRecord(result);
  assert.ok(meta);
  assert.equal(meta!.status, "blocked");
  assert.equal(meta!.panelHealth, "blocked");
  assert.equal((meta!.confirmedClusters as unknown[]).length, 0);
});

test("panel review emits exactly one aggregate metadata record", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "agree-bug", ["--reviewers", "3"]);
  const allLines = [...result.stderr.split("\n"), ...result.stdout.split("\n")];
  const metaLines = allLines.filter((line) => line.startsWith("PI_REVIEW_META_JSON: "));
  assert.equal(metaLines.length, 1, `expected one aggregate meta record, got ${metaLines.length}`);
});

test("panel rejects session reuse flags with usage exit 2", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  fs.rmSync(tempDir, { recursive: true, force: true });
  const result = runPanelCli("pi", "agree-bug", ["--reviewers", "3", "--keep-session"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /panel cannot be used with/);
});

test("panel loop runs one full panel per round and reports a panel summary", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = spawnSync(
    process.execPath,
    [...tsxLoaderArgs(), cliPath(), "loop", "--reviewers", "3", "--max-rounds", "1", "--", "@src"],
    { cwd: repoRoot(), env: { ...process.env, PI_BIN: fakePi, FAKE_PANEL_SCENARIO: "agree-bug" }, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /pi-review loop/);
  assert.match(result.stdout, /panel 3\/3/);
});

test("named panel preset propagates panelPreset to metadata and output", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "agree-bug", ["--panel", "code-experts", "--consensus", "quorum", "--min-agree", "2"]);
  assert.equal(result.status, 1, result.stderr);
  const meta = metaRecord(result);
  assert.ok(meta, result.stderr);
  assert.equal(meta!.status, "has_findings");
  assert.equal(meta!.strategy, "panel");
  assert.equal(meta!.panelPreset, "code-experts");
  assert.equal(meta!.configuredReviewers, 3);
  assert.equal((meta!.confirmedClusters as unknown[]).length, 1);
  assert.equal((meta!.confirmedClusters as Array<{ supportCount: number }>)[0]!.supportCount, 2);
  assert.match(result.stdout, /Panel\s+code-experts/);
});

test("named panel preset reviewer ids appear in supporting reviewer ids", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "agree-bug", ["--panel", "code-experts", "--consensus", "quorum", "--min-agree", "2"]);
  const meta = metaRecord(result);
  assert.ok(meta);
  const cluster = (meta!.confirmedClusters as Array<{ supportingReviewerIds: string[] }>)[0]!;
  assert.deepEqual(cluster.supportingReviewerIds.sort(), ["correctness", "security"]);
});

test("panel events-jsonl emits only normalized lifecycle events and carries the final metadata", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);

  const result = runPanelCli(fakePi, "agree-bug", ["--reviewers", "3", "--output-format", "events-jsonl"]);
  assert.equal(result.status, 1, result.stderr);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string; seq: number; meta?: { status?: string } });
  assert.equal(events[0]?.type, "panel.started");
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.at(-1)?.type, "panel.completed");
  assert.equal(events.at(-1)?.meta?.status, "has_findings");
  assert.doesNotMatch(result.stdout, /PI_REVIEW_META_JSON|── pi-review/);
});

test("panel events-jsonl keeps the default CLI gate metadata semantics", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);
  const args = ["--reviewers", "3", "--consensus", "quorum", "--min-agree", "2"];
  const human = runPanelCli(fakePi, "agree-bug", args);
  const eventStream = runPanelCli(fakePi, "agree-bug", [...args, "--output-format", "events-jsonl"]);
  const humanMeta = metaRecord(human);
  const eventMeta = JSON.parse(eventStream.stdout.trim().split("\n").at(-1)!).meta as Record<string, unknown>;
  assert.equal(eventStream.status, human.status);
  assert.equal(eventMeta.status, humanMeta!.status);
  assert.deepEqual(eventMeta.confirmedClusters, humanMeta!.confirmedClusters);
  assert.deepEqual(eventMeta.advisories, humanMeta!.advisories);
  assert.equal(eventMeta.panelHealth, humanMeta!.panelHealth);
});

test("panel keeps full redacted findings for the CLI while bounding renderer events", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);
  const args = ["--reviewers", "2", "--consensus", "quorum", "--min-agree", "2"];
  const human = runPanelCli(fakePi, "long-finding", args);
  const events = runPanelCli(fakePi, "long-finding", [...args, "--output-format", "events-jsonl"]);
  assert.match(human.stdout, /x{700}/);
  const completed = JSON.parse(events.stdout.trim().split("\n").at(-1)!) as { meta: { confirmedClusters: Array<{ summary: string }> } };
  assert.ok(completed.meta.confirmedClusters[0]!.summary.length <= 512);
});

test("panel rejects disallowed tools before writing a partial event stream", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-panel-cli-"));
  const fakePi = writeFakePi(tempDir);
  const result = runPanelCli(fakePi, "agree-bug", ["--reviewers", "2", "--tools", "bash", "--output-format", "events-jsonl"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /panel reviewers only allow/);
});
