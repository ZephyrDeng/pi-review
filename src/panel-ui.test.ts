import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, afterEach } from "vitest";
import { launchPanelUi } from "./panel-ui.js";

// launchPanelUi forks the compiled dashboard server, so these tests need a
// fresh `dist/ui-server-main.js` (see ui-server-main.test.ts for the same
// requirement). `npm test` builds first; run `npm run build` before
// invoking this file standalone.
function serverEntry(): string {
  return fileURLToPath(new URL("../dist/ui-server-main.js", import.meta.url));
}

function httpGet(port: number, requestPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let activePid: number | undefined;
let activeRunDir: string | undefined;
let activeUrlFile: string | undefined;

afterEach(() => {
  if (activePid !== undefined) {
    try {
      process.kill(activePid, "SIGTERM");
    } catch {
      /* already exited */
    }
    activePid = undefined;
  }
  if (activeRunDir) {
    fs.rmSync(activeRunDir, { recursive: true, force: true });
    activeRunDir = undefined;
  }
  if (activeUrlFile) {
    fs.rmSync(path.dirname(activeUrlFile), { recursive: true, force: true });
    activeUrlFile = undefined;
  }
});

test("launchPanelUi starts the dashboard, prints its URL, and writes the URL file atomically", async () => {
  assert.ok(fs.existsSync(serverEntry()), "dist/ui-server-main.js is missing — run `npm run build` before this test");

  const urlFileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-ui-launch-test-"));
  const urlFile = path.join(urlFileDir, "url.txt");
  activeUrlFile = urlFile;

  const writes: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    writes.push(String(chunk));
    return originalWrite(chunk as never, ...(rest as []));
  }) as typeof process.stderr.write;

  let launch;
  try {
    launch = await launchPanelUi({ serverEntryPath: serverEntry(), uiUrlFile: urlFile, ttlSeconds: 900 });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(launch);
  activePid = launch!.pid;
  activeRunDir = launch!.runDir;

  assert.match(launch!.url, /^http:\/\/127\.0\.0\.1:\d+\/run\/[A-Za-z0-9_-]+$/);
  assert.ok(writes.some((line) => line.includes(`PI_REVIEW_UI_URL: ${launch!.url}`)));
  assert.equal(fs.readFileSync(urlFile, "utf8"), `${launch!.url}\n`);

  const url = new URL(launch!.url);
  const page = await httpGet(Number(url.port), url.pathname, { Host: `127.0.0.1:${url.port}` });
  assert.equal(page.status, 200);
}, 10_000);

test("launchPanelUi's onEvent listener appends events the running server can replay over SSE", async () => {
  const launch = await launchPanelUi({ serverEntryPath: serverEntry(), ttlSeconds: 900 });
  assert.ok(launch);
  activePid = launch!.pid;
  activeRunDir = launch!.runDir;

  launch!.onEvent({ v: 1, runId: "run-1", seq: 1, at: 1, type: "panel.started", target: "@src", mode: "code", reviewers: [] });

  const url = new URL(launch!.url);
  const body = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: Number(url.port), path: `${url.pathname}/events`, headers: { Host: `127.0.0.1:${url.port}` } },
      (res) => {
        let acc = "";
        const timer = setTimeout(() => {
          req.destroy();
          resolve(acc);
        }, 1500);
        res.on("data", (c) => {
          acc += c;
          if (acc.includes("panel.started")) {
            clearTimeout(timer);
            req.destroy();
            resolve(acc);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.match(body, /"type":"panel\.started"/);
}, 10_000);

test("launchPanelUi falls back to headless when the server entry point cannot be spawned", async () => {
  const writes: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    writes.push(String(chunk));
    return originalWrite(chunk as never, ...(rest as []));
  }) as typeof process.stderr.write;

  let launch;
  try {
    launch = await launchPanelUi({ serverEntryPath: "/nonexistent/ui-server-main.js", readyTimeoutMs: 500 });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(launch, undefined);
  assert.ok(writes.some((line) => line.includes("dashboard failed to start")));
}, 10_000);
