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

function runCli(fakePi: string, verdict: string, childExit = "0") {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    [...tsxLoaderArgs(), cliPath, "--no-stream", "--", "@src"],
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

test("single-review CLI maps structured status to gate exit codes", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-cli-exit-"));
  const fakePi = path.join(tempDir, "fake-pi");
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
const verdict = process.env.FAKE_REVIEW_VERDICT;
const findings = verdict === "request_changes"
  ? "### F1: Fix the gate\\n- Severity: high\\n- Path: src/cli.ts\\n- Actionable: yes"
  : "No material findings.";
const text = "## Verdict\\n" + verdict + "\\n\\n## Summary\\n- Fixture.\\n\\n## Findings\\n" + findings + "\\n\\n## Risks and Blind Spots\\nNone.\\n\\n## Open Questions\\nNone.\\n";
function line(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
line({ type: "session", version: 3, id: "s1" });
line({ type: "agent_start" });
line({ type: "turn_start" });
line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "review" }] } });
line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "review" }] } });
line({ type: "message_start", message: { role: "assistant", content: [], model: "fake/model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 } } });
line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text, partial: { role: "assistant" } } });
line({ type: "message_update", assistantMessageEvent: { type: "text_end", content: text, partial: { role: "assistant" } } });
line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "fake/model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150 }, stopReason: "stop" } });
line({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, totalTokens: 150 } } });
line({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "review" }] }, { role: "assistant", content: [{ type: "text", text }], responseModel: "fake/model" }] });
process.exit(Number(process.env.FAKE_REVIEW_EXIT ?? "0"));
`);
  fs.chmodSync(fakePi, 0o755);

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
  }
});
