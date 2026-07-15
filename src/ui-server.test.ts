import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, afterEach } from "vitest";
import {
  createDashboardRequestListener,
  createRunDirectory,
  formatSseEvent,
  generateCapabilityToken,
  isAllowedHost,
  isAllowedOrigin,
  isValidToken,
  securityHeaders,
  splitCompleteLines,
  writeUrlFileAtomic,
} from "./ui-server.js";
import type { DashboardServerContext } from "./ui-server.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("generateCapabilityToken returns high-entropy, unique, URL-safe tokens", () => {
  const a = generateCapabilityToken();
  const b = generateCapabilityToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("isValidToken accepts only an exact match and rejects undefined/short candidates", () => {
  const token = generateCapabilityToken();
  assert.equal(isValidToken(token, token), true);
  assert.equal(isValidToken(`${token}x`, token), false);
  assert.equal(isValidToken(token.slice(0, -1), token), false);
  assert.equal(isValidToken(undefined, token), false);
  assert.equal(isValidToken("", token), false);
});

test("isAllowedHost accepts only loopback hostnames bound to the server's own port", () => {
  assert.equal(isAllowedHost("127.0.0.1:4100", 4100), true);
  assert.equal(isAllowedHost("localhost:4100", 4100), true);
  assert.equal(isAllowedHost("LOCALHOST:4100", 4100), true);
  assert.equal(isAllowedHost("[::1]:4100", 4100), true);
  assert.equal(isAllowedHost("127.0.0.1:9999", 4100), false);
  assert.equal(isAllowedHost("evil.example:4100", 4100), false);
  assert.equal(isAllowedHost("127.0.0.1", 4100), false);
  assert.equal(isAllowedHost(undefined, 4100), false);
  assert.equal(isAllowedHost("[::1", 4100), false);
});

test("isAllowedOrigin allows a missing Origin and exact loopback matches only", () => {
  assert.equal(isAllowedOrigin(undefined, 4100), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:4100", 4100), true);
  assert.equal(isAllowedOrigin("http://localhost:4100", 4100), true);
  assert.equal(isAllowedOrigin("http://[::1]:4100", 4100), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999", 4100), false);
  assert.equal(isAllowedOrigin("https://evil.example", 4100), false);
  assert.equal(isAllowedOrigin("null", 4100), false);
});

test("securityHeaders disables framing, remote assets, and caching", () => {
  const headers = securityHeaders();
  assert.match(headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Cache-Control"], "no-store");
});

test("createRunDirectory creates an owner-only directory", () => {
  const dir = createRunDirectory(`test-${generateCapabilityToken()}`, os.tmpdir());
  try {
    const stat = fs.statSync(dir);
    assert.ok(stat.isDirectory());
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeUrlFileAtomic leaves only the final file with no temp remnants", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-ui-test-"));
  try {
    const target = path.join(dir, "url.txt");
    writeUrlFileAtomic(target, "http://127.0.0.1:4100/run/abc");
    assert.equal(fs.readFileSync(target, "utf8"), "http://127.0.0.1:4100/run/abc\n");
    const remaining = fs.readdirSync(dir);
    assert.deepEqual(remaining, ["url.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatSseEvent emits an id: line for Last-Event-ID replay plus a data: line", () => {
  const frame = formatSseEvent(3, { type: "reviewer.started" });
  assert.equal(frame, 'id: 3\ndata: {"type":"reviewer.started"}\n\n');
});

test("splitCompleteLines buffers a trailing partial line across chunks", () => {
  const first = splitCompleteLines("", 'line-a\nline-b\npart');
  assert.deepEqual(first.lines, ["line-a", "line-b"]);
  assert.equal(first.leftover, "part");
  const second = splitCompleteLines(first.leftover, "ial\nline-c\n");
  assert.deepEqual(second.lines, ["partial", "line-c"]);
  assert.equal(second.leftover, "");
});

// ---------------------------------------------------------------------------
// HTTP/SSE integration
// ---------------------------------------------------------------------------

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

/** Collect SSE frames until `minFrames` arrive or the timeout fires, then close the connection. */
function collectSse(port: number, requestPath: string, headers: Record<string, string>, minFrames: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, headers }, (res) => {
      let body = "";
      const timer = setTimeout(() => {
        req.destroy();
        resolve(body);
      }, 2000);
      res.on("data", (c) => {
        body += c;
        if ((body.match(/^id: /gm) ?? []).length >= minFrames) {
          clearTimeout(timer);
          req.destroy();
          resolve(body);
        }
      });
      res.on("error", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

let activeServer: http.Server | undefined;
let activeDir: string | undefined;

afterEach(() => {
  if (activeServer) {
    activeServer.closeAllConnections();
    activeServer.close();
    activeServer = undefined;
  }
  if (activeDir) {
    fs.rmSync(activeDir, { recursive: true, force: true });
    activeDir = undefined;
  }
});

async function startTestServer(overrides: Partial<DashboardServerContext> = {}): Promise<{ port: number; token: string; eventsPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-ui-test-"));
  activeDir = dir;
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, "");
  const token = generateCapabilityToken();

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const ctx: DashboardServerContext = {
    token,
    port,
    eventsPath,
    html: "<!doctype html><title>pi-review dashboard</title>",
    staticAssets: { "panel-view.js": { contentType: "text/javascript; charset=utf-8", body: "export const x = 1;" } },
    pollIntervalMs: 20,
    ...overrides,
  };
  server.on("request", createDashboardRequestListener(ctx));
  activeServer = server;
  return { port, token, eventsPath };
}

test("dashboard serves the HTML page for a valid capability token", async () => {
  const { port, token } = await startTestServer();
  const res = await httpGet(port, `/run/${token}`, { Host: `127.0.0.1:${port}` });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /text\/html/);
  assert.match(res.body, /pi-review dashboard/);
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.match(String(res.headers["content-security-policy"] ?? ""), /frame-ancestors 'none'/);
});

test("dashboard rejects an invalid or wrong-length capability token with 404", async () => {
  const { port, token } = await startTestServer();
  const wrong = await httpGet(port, `/run/${token}x`, { Host: `127.0.0.1:${port}` });
  assert.equal(wrong.status, 404);
  const garbage = await httpGet(port, "/run/not-a-token", { Host: `127.0.0.1:${port}` });
  assert.equal(garbage.status, 404);
});

test("dashboard rejects a non-loopback Host header", async () => {
  const { port, token } = await startTestServer();
  const res = await httpGet(port, `/run/${token}`, { Host: "evil.example" });
  assert.equal(res.status, 400);
});

test("dashboard rejects a cross-origin request but allows a missing Origin", async () => {
  const { port, token } = await startTestServer();
  const bad = await httpGet(port, `/run/${token}`, { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  const ok = await httpGet(port, `/run/${token}`, { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` });
  assert.equal(ok.status, 200);
  const missing = await httpGet(port, `/run/${token}`, { Host: `127.0.0.1:${port}` });
  assert.equal(missing.status, 200);
});

test("dashboard serves a static asset under the token boundary and 404s unknown assets", async () => {
  const { port, token } = await startTestServer();
  const res = await httpGet(port, `/run/${token}/static/panel-view.js`, { Host: `127.0.0.1:${port}` });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /javascript/);
  assert.match(res.body, /export const x/);
  const missing = await httpGet(port, `/run/${token}/static/does-not-exist.js`, { Host: `127.0.0.1:${port}` });
  assert.equal(missing.status, 404);
});

test("dashboard SSE stream replays existing events then tails new appends in seq order", async () => {
  const { port, token, eventsPath } = await startTestServer();
  fs.appendFileSync(eventsPath, `${JSON.stringify({ v: 1, runId: "r1", seq: 1, at: 1, type: "panel.started" })}\n`);
  fs.appendFileSync(eventsPath, `${JSON.stringify({ v: 1, runId: "r1", seq: 2, at: 2, type: "reviewer.queued" })}\n`);

  const collecting = collectSse(port, `/run/${token}/events`, { Host: `127.0.0.1:${port}` }, 3);
  await new Promise((resolve) => setTimeout(resolve, 60));
  fs.appendFileSync(eventsPath, `${JSON.stringify({ v: 1, runId: "r1", seq: 3, at: 3, type: "reviewer.started" })}\n`);

  const body = await collecting;
  assert.match(body, /id: 1\n/);
  assert.match(body, /id: 2\n/);
  assert.match(body, /id: 3\n/);
  assert.match(body, /"type":"panel.started"/);
  assert.match(body, /"type":"reviewer.started"/);
});

test("dashboard SSE stream honors Last-Event-ID and only replays newer events", async () => {
  const { port, token, eventsPath } = await startTestServer();
  fs.appendFileSync(eventsPath, `${JSON.stringify({ v: 1, runId: "r1", seq: 1, at: 1, type: "panel.started" })}\n`);
  fs.appendFileSync(eventsPath, `${JSON.stringify({ v: 1, runId: "r1", seq: 2, at: 2, type: "reviewer.queued" })}\n`);
  fs.appendFileSync(eventsPath, `${JSON.stringify({ v: 1, runId: "r1", seq: 3, at: 3, type: "reviewer.started" })}\n`);

  const body = await collectSse(port, `/run/${token}/events`, { Host: `127.0.0.1:${port}`, "Last-Event-ID": "2" }, 1);
  assert.doesNotMatch(body, /id: 1\n/);
  assert.doesNotMatch(body, /id: 2\n/);
  assert.match(body, /id: 3\n/);
});

test("dashboard rejects non-GET/HEAD methods", async () => {
  const { port, token } = await startTestServer();
  const res = await new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/run/${token}`, method: "POST", headers: { Host: `127.0.0.1:${port}` } },
      (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(res.status, 405);
});
