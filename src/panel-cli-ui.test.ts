import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, afterEach } from "vitest";

// End-to-end coverage for the `--ui web` CLI wiring (args -> cli.ts dispatch
// -> panel-ui.ts launcher -> detached ui-server-main.js). Spawns the
// compiled dist/cli.js directly (not tsx-from-source) because the detached
// server reads its sibling static assets from its own compiled location;
// `npm test` builds first, run `npm run build` before this file standalone.

function distCliPath(): string {
  return fileURLToPath(new URL("../dist/cli.js", import.meta.url));
}

function repoRoot(): string {
  return path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
}

function writeFakePi(tempDir: string): string {
  const fakePi = path.join(tempDir, "fake-pi");
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node
function line(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const text = "## Verdict\\napprove\\n\\n## Summary\\n- Fixture.\\n\\n## Findings\\nNo material findings.\\n\\n## Risks and Blind Spots\\nNone.\\n\\n## Open Questions\\nNone.\\n";
line({ type: "session", version: 3, id: "s1" });
line({ type: "agent_start" });
line({ type: "turn_start" });
line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "review" }] } });
line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "review" }] } });
line({ type: "message_start", message: { role: "assistant", content: [], model: "fake/model", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 } } });
line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text, partial: { role: "assistant" } } });
line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "fake/model", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 }, stopReason: "stop" } });
line({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 10, output: 5, totalTokens: 15 } } });
line({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "review" }] }, { role: "assistant", content: [{ type: "text", text }], responseModel: "fake/model" }] });
process.exit(0);
`,
  );
  fs.chmodSync(fakePi, 0o755);
  return fakePi;
}

function httpGet(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let tempDir = "";
let dashboardPort: number | undefined;

afterEach(() => {
  if (dashboardPort !== undefined) {
    try {
      const pid = execSync(`lsof -ti tcp:${dashboardPort} -sTCP:LISTEN`).toString().trim();
      if (pid) process.kill(Number(pid), "SIGTERM");
    } catch {
      /* lsof unavailable or nothing listening anymore; best-effort cleanup only */
    }
    dashboardPort = undefined;
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

test("pi-review --reviewers N --ui web prints a reachable dashboard URL and preserves the panel exit code", () => {
  assert.ok(fs.existsSync(distCliPath()), "dist/cli.js is missing — run `npm run build` before this test");

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-ui-cli-"));
  const fakePi = writeFakePi(tempDir);
  const urlFile = path.join(tempDir, "url.txt");

  const result = spawnSync(
    process.execPath,
    [distCliPath(), "--reviewers", "2", "--ui", "web", "--ui-url-file", urlFile, "--no-ui-open", "--", "@src"],
    {
      cwd: repoRoot(),
      env: { ...process.env, PI_BIN: fakePi },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const urlLine = result.stderr.split("\n").find((line) => line.startsWith("PI_REVIEW_UI_URL: "));
  assert.ok(urlLine, result.stderr);
  const url = new URL(urlLine!.slice("PI_REVIEW_UI_URL: ".length));
  dashboardPort = Number(url.port);

  assert.equal(fs.readFileSync(urlFile, "utf8").trim(), url.toString());
  return httpGet(dashboardPort, url.pathname).then((page) => {
    assert.equal(page.status, 200);
    assert.match(page.body, /pi-review panel/);
  });
}, 15_000);
