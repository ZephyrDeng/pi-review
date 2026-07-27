import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, afterEach } from "vitest";
import { extractFinalText, extractUsage } from "./json-events.js";

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

function runCli(fakePi: string, verdict: string, childExit = "0", extraArgs: string[] = ["--no-stream"]) {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    [...tsxLoaderArgs(), cliPath, ...extraArgs, "--", "@src"],
    {
      cwd: path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
      env: {
        ...process.env,
        PI_BIN: fakePi,
        FAKE_REVIEW_VERDICT: verdict,
        FAKE_REVIEW_EXIT: childExit,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

test("invalid loop arguments print usage and exit 2", () => {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [...tsxLoaderArgs(), cliPath, "loop", "--max-rounds", "0", "--", "@src"],
    { encoding: "utf8", timeout: 30_000 },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--max-rounds must be a positive integer/);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /pi-review loop/);
});

function writeFakePi(dir: string): string {
  const fakePi = path.join(dir, "fake-pi");
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
const verdict = process.env.FAKE_REVIEW_VERDICT;
const findings = verdict === "request_changes"
  ? "### F1: Fix the gate\\n- Severity: high\\n- Path: src/cli.ts\\n- Lines: 10-20\\n- Side: base\\n- Actionable: yes\\n- Evidence: The gate returns 0 on a dirty verdict.\\n- Impact: CI reports success despite findings.\\n- Recommendation: Map status to a non-zero exit code."
  : "No material findings.";
const text = "## Verdict\\n" + verdict + "\\n\\n## Summary\\n- Fixture.\\n\\n## Findings\\n" + findings + "\\n\\n## Risks and Blind Spots\\nNone.\\n\\n## Open Questions\\nNone.\\n";
function line(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
line({ type: "session", version: 3, id: "s1" });
line({ type: "agent_start" });
line({ type: "turn_start" });
line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "review" }] } });
line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "review" }] } });
line({ type: "message_start", message: { role: "assistant", content: [], model: "fake/model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 } } });
line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text, partial: { role: "assistant", content: [{ type: "text", text }] } }, message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 } } });
line({ type: "message_update", assistantMessageEvent: { type: "text_end", content: text, partial: { role: "assistant", content: [{ type: "text", text }] } } });
line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "fake/model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 }, stopReason: "stop" } });
line({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, totalTokens: 150 } } });
line({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "review" }] }, { role: "assistant", content: [{ type: "text", text }], responseModel: "fake/model" }] });
process.exit(Number(process.env.FAKE_REVIEW_EXIT ?? "0"));
`);
  fs.chmodSync(fakePi, 0o755);
  return fakePi;
}

test("single-review CLI maps structured status to gate exit codes", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-cli-exit-"));
  const fakePi = writeFakePi(tempDir);

  const scenarios = [
    { verdict: "approve", childExit: "0", expectedStatus: "clean", expectedExit: 0 },
    { verdict: "request_changes", childExit: "0", expectedStatus: "has_findings", expectedExit: 1 },
    { verdict: "needs_clarification", childExit: "0", expectedStatus: "needs_human", expectedExit: 3 },
    { verdict: "approve", childExit: "9", expectedStatus: "blocked", expectedExit: 4 },
  ];

  for (const scenario of scenarios) {
    const result = runCli(fakePi, scenario.verdict, scenario.childExit);
    assert.equal(result.error, undefined);
    assert.equal(result.status, scenario.expectedExit, result.stderr);
    const metaLine = result.stderr.split("\n").find((line) => line.startsWith("PI_REVIEW_META_JSON: "));
    assert.ok(metaLine, result.stderr);
    const meta = JSON.parse(metaLine.slice("PI_REVIEW_META_JSON: ".length));
    assert.equal(meta.status, scenario.expectedStatus);
    // Issue #6: every emission carries the metaVersion discriminator, and the
    // request_changes scenario's finding carries the enriched fields end to
    // end (Markdown -> parser -> PI_REVIEW_META_JSON on stderr).
    assert.equal(meta.metaVersion, 1);
    if (scenario.verdict === "request_changes") {
      assert.deepEqual(meta.findings, [
        {
          id: "F1",
          severity: "high",
          path: "src/cli.ts",
          summary: "Fix the gate",
          actionable: true,
          details: "Evidence: The gate returns 0 on a dirty verdict.\n\nImpact: CI reports success despite findings.",
          recommendation: "Map status to a non-zero exit code.",
          location: { startLine: 10, endLine: 20, side: "base" },
        },
      ]);
    }
  }
});

test("--progress-log writes slimmed events by default and verbatim with --progress-log-raw", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-cli-exit-"));
  const fakePi = writeFakePi(tempDir);

  const slimLog = path.join(tempDir, "progress.jsonl");
  const slimRun = runCli(fakePi, "approve", "0", ["--progress-log", slimLog]);
  assert.equal(slimRun.error, undefined);
  assert.equal(slimRun.status, 0, slimRun.stderr);
  const slimEvents = fs.readFileSync(slimLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const slimUpdates = slimEvents.filter((event) => event.type === "message_update");
  assert.ok(slimUpdates.length >= 2, `expected message_update events, got ${slimUpdates.length}`);
  for (const event of slimUpdates) {
    // fixture partials carry role+content but no usage, so the snapshot goes entirely
    assert.equal(event.assistantMessageEvent?.partial, undefined, JSON.stringify(event).slice(0, 200));
    // the duplicate top-level message snapshot reduces to its usage
    if (event.message !== undefined) {
      assert.deepEqual(event.message, { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 } });
    }
  }
  const textDelta = slimUpdates.find((event) => event.assistantMessageEvent?.type === "text_delta");
  assert.ok(typeof textDelta?.assistantMessageEvent?.delta === "string" && textDelta.assistantMessageEvent.delta.includes("## Verdict"));
  // Positive contract: the slimmed log still replays through pi-review's own
  // event parser — full review text and authoritative usage survive slimming.
  const slimReplayText = fs.readFileSync(slimLog, "utf8");
  const replay = extractFinalText(slimReplayText);
  assert.equal(replay.error, undefined);
  assert.ok(replay.text.includes("## Verdict"));
  assert.equal(extractUsage(slimReplayText).usage?.totalTokens, 150);
  // Message boundaries keep the authoritative record, so the slimmed log still
  // reconstructs the review; block-level text_end content is not cumulative
  // and stays too.
  const slimEnd = slimEvents.find((event) => event.type === "message_end" && event.message?.role === "assistant");
  assert.ok(slimEnd?.message?.content?.[0]?.text?.includes("## Verdict"));
  const textEnd = slimUpdates.find((event) => event.assistantMessageEvent?.type === "text_end");
  assert.equal(typeof textEnd?.assistantMessageEvent?.content, "string");

  const rawLog = path.join(tempDir, "progress-raw.jsonl");
  const rawRun = runCli(fakePi, "approve", "0", ["--progress-log", rawLog, "--progress-log-raw"]);
  assert.equal(rawRun.error, undefined);
  assert.equal(rawRun.status, 0, rawRun.stderr);
  const rawUpdates = fs.readFileSync(rawLog, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "message_update");
  assert.ok(rawUpdates.some((event) => Array.isArray(event.assistantMessageEvent?.partial?.content)));
  assert.ok(rawUpdates.some((event) => Array.isArray(event.message?.content)));
  assert.ok(fs.statSync(rawLog).size > fs.statSync(slimLog).size);
});
