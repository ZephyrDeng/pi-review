import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, afterEach } from "vitest";

// These tests exercise the real detached server process, so they need a
// fresh `dist/ui-server-main.js` (the module reads its sibling static assets
// from its own compiled location). `npm test` runs `npm run build` first;
// run `npm run build` before invoking this file standalone.
function distEntry(): string {
  return fileURLToPath(new URL("../dist/ui-server-main.js", import.meta.url));
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpGet(port: number, requestPath: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let activeChild: ChildProcess | undefined;
let activeDir: string | undefined;

afterEach(() => {
  if (activeChild && activeChild.exitCode === null && !activeChild.killed) activeChild.kill("SIGKILL");
  activeChild = undefined;
  if (activeDir) {
    fs.rmSync(activeDir, { recursive: true, force: true });
    activeDir = undefined;
  }
});

interface SpawnedServer {
  child: ChildProcess;
  port: number;
  token: string;
  dir: string;
  eventsPath: string;
}

async function spawnServer(opts: { ttlMs?: number; ttlCheckIntervalMs?: number; preCompleted?: boolean } = {}): Promise<SpawnedServer> {
  const entry = distEntry();
  assert.ok(fs.existsSync(entry), "dist/ui-server-main.js is missing — run `npm run build` before this test");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-ui-main-test-"));
  activeDir = dir;
  const eventsPath = path.join(dir, "events.jsonl");
  const token = `test-token-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(
    eventsPath,
    opts.preCompleted
      ? `${JSON.stringify({ v: 1, runId: "r1", seq: 1, at: 1, type: "panel.completed", meta: { status: "clean" } })}\n`
      : "",
  );

  const args = [dir, token, String(opts.ttlMs ?? 900_000), String(opts.ttlCheckIntervalMs ?? 30_000)];
  const child = fork(entry, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  activeChild = child;

  const ready = await new Promise<{ ready: boolean; port?: number; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not send a ready message in time")), 5000);
    child.once("message", (msg) => {
      clearTimeout(timer);
      resolve(msg as { ready: boolean; port?: number; error?: string });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
  assert.equal(ready.ready, true, ready.error);
  return { child, port: ready.port!, token, dir, eventsPath };
}

test("ui-server-main serves the dashboard page, static assets, and SSE stream once ready", async () => {
  const { port, token } = await spawnServer();

  const page = await httpGet(port, `/run/${token}`, { Host: `127.0.0.1:${port}` });
  assert.equal(page.status, 200);
  assert.match(page.body, /pi-review panel/);

  const clientJs = await httpGet(port, `/run/${token}/static/ui-client.js`, { Host: `127.0.0.1:${port}` });
  assert.equal(clientJs.status, 200);
  assert.match(clientJs.body, /EventSource/);

  const reducerJs = await httpGet(port, `/run/${token}/static/panel-view.js`, { Host: `127.0.0.1:${port}` });
  assert.equal(reducerJs.status, 200);
  assert.match(reducerJs.body, /reducePanelEvent/);
}, 10_000);

test("every static asset's transitive relative imports are also served (the browser module graph resolves)", async () => {
  const { port, token } = await spawnServer();
  const entryPoints = ["ui-client.js", "panel-view.js"];
  const seen = new Set<string>();
  const pending = [...entryPoints];

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const res = await httpGet(port, `/run/${token}/static/${name}`, { Host: `127.0.0.1:${port}` });
    assert.equal(res.status, 200, `expected /static/${name} to be served (imported by the module graph)`);
    for (const match of res.body.matchAll(/from\s+"\.\/([^"]+)"/g)) pending.push(match[1]!);
  }
  assert.ok(seen.size >= 3, "expected to discover panel-view.js's transitive import too");
}, 10_000);

test("ui-server-main rejects a wrong capability token even once ready", async () => {
  const { port, token } = await spawnServer();
  const res = await httpGet(port, `/run/${token}-wrong`, { Host: `127.0.0.1:${port}` });
  assert.equal(res.status, 404);
}, 10_000);

test("ui-server-main removes the run directory on SIGTERM", async () => {
  const { child, dir } = await spawnServer();
  assert.ok(fs.existsSync(dir));

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
  assert.equal(fs.existsSync(dir), false);
}, 10_000);

test("ui-server-main self-terminates after the idle TTL once the run has completed", async () => {
  const { child, dir } = await spawnServer({ preCompleted: true, ttlMs: 30, ttlCheckIntervalMs: 20 });

  const exit = await new Promise<{ code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not self-terminate within the TTL window")), 3000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
  assert.equal(exit.code, 0);
  assert.equal(fs.existsSync(dir), false);
}, 10_000);

test("ui-server-main serves the markdown renderer static asset", async () => {
  const { port, token } = await spawnServer();
  const md = await httpGet(port, `/run/${token}/static/ui-markdown.js`, { Host: `127.0.0.1:${port}` });
  assert.equal(md.status, 200);
  assert.match(md.body, /parseMarkdown/);
}, 10_000);

test("ui-server-main exits and removes the run directory after a shutdown POST", async () => {
  const { child, port, token, dir } = await spawnServer();

  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/run/${token}/shutdown`, method: "POST", headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 202);

  const exit = await new Promise<{ code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not exit after shutdown POST")), 3000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
  assert.equal(exit.code, 0);
  assert.equal(fs.existsSync(dir), false);
}, 10_000);
