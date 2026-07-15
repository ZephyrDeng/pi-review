// Loopback dashboard HTTP/SSE server (issue #4). Binds only to loopback
// addresses, protects every run with a high-entropy capability token, and
// streams the normalized ReviewEvent v1 JSONL artifact so a browser can
// replay/reconnect without touching the review process directly.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Default idle TTL (seconds) the dashboard stays up after the run completes. */
export const DEFAULT_UI_TTL_SECONDS = 900;

/** Hard safeguard so an orphaned dashboard process never runs forever, even if the run never completes. */
export const MAX_RUN_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** High-entropy per-run capability token embedded in the dashboard URL path. */
export function generateCapabilityToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Constant-time token comparison; a length mismatch alone must not leak timing. */
export function isValidToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Reject every Host header except loopback names bound to the server's own port. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  let portPart: string | undefined;
  if (hostHeader.startsWith("[")) {
    const closeIndex = hostHeader.indexOf("]");
    if (closeIndex === -1) return false;
    hostname = hostHeader.slice(0, closeIndex + 1);
    const rest = hostHeader.slice(closeIndex + 1);
    portPart = rest.startsWith(":") ? rest.slice(1) : undefined;
  } else {
    const colonIndex = hostHeader.lastIndexOf(":");
    if (colonIndex === -1) {
      hostname = hostHeader;
      portPart = undefined;
    } else {
      hostname = hostHeader.slice(0, colonIndex);
      portPart = hostHeader.slice(colonIndex + 1);
    }
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) return false;
  return portPart === String(port);
}

/** Allow a missing Origin (same-origin GET/EventSource often omit it) or an exact loopback match. */
export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
  if (originHeader === undefined) return true;
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  return allowed.has(originHeader);
}

/** Restrictive headers on every response: no remote assets, no framing, no caching of sensitive state. */
export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/** Create the per-run temp directory with owner-only permissions where supported. */
export function createRunDirectory(runId: string, baseDir: string = os.tmpdir()): string {
  const dir = path.join(baseDir, "pi-review-ui", runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Write the dashboard URL via temp-file + rename so readers never see a partial write. */
export function writeUrlFileAtomic(filePath: string, url: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${url}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/** One SSE frame: `id:` enables browser Last-Event-ID replay on reconnect. */
export function formatSseEvent(seq: number, event: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Split newline-delimited text into complete lines plus a leftover partial line for the next chunk. */
export function splitCompleteLines(buffered: string, chunk: string): { lines: string[]; leftover: string } {
  const combined = buffered + chunk;
  const lines = combined.split("\n");
  const leftover = lines.pop() ?? "";
  return { lines: lines.filter((line) => line.length > 0), leftover };
}

export interface DashboardAsset {
  contentType: string;
  body: string;
}

export interface DashboardServerContext {
  token: string;
  port: number;
  eventsPath: string;
  html: string;
  staticAssets: Record<string, DashboardAsset>;
  /** Invoked when the page POSTs /run/:token/shutdown (fired when the closer countdown finishes). */
  onShutdown?: () => void;
  /** Test-only: shrink the tail-poll interval below the 200ms production default. */
  pollIntervalMs?: number;
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://internal").pathname;
  } catch {
    return "/";
  }
}

function writeStatus(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function serveEvents(req: IncomingMessage, res: ServerResponse, ctx: DashboardServerContext): void {
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");

  const lastEventIdHeader = req.headers["last-event-id"];
  const initialLastSeq =
    typeof lastEventIdHeader === "string" && /^\d+$/.test(lastEventIdHeader) ? Number(lastEventIdHeader) : 0;
  let lastSentSeq = initialLastSeq;
  let leftover = "";

  const sendLine = (line: string): void => {
    let parsed: { seq?: unknown } | undefined;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed.seq !== "number" || parsed.seq <= lastSentSeq) return;
    lastSentSeq = parsed.seq;
    res.write(formatSseEvent(parsed.seq, parsed));
  };

  const consume = (chunk: string): void => {
    const { lines, leftover: rest } = splitCompleteLines(leftover, chunk);
    leftover = rest;
    for (const line of lines) sendLine(line);
  };

  let initial = "";
  try {
    initial = fs.readFileSync(ctx.eventsPath, "utf8");
  } catch {
    initial = "";
  }
  let offset = Buffer.byteLength(initial, "utf8");
  consume(initial);

  let stopped = false;
  const pollIntervalMs = ctx.pollIntervalMs ?? 200;
  const poll = setInterval(() => {
    if (stopped) return;
    fs.stat(ctx.eventsPath, (err, stat) => {
      if (err || stopped || stat.size <= offset) return;
      const stream = fs.createReadStream(ctx.eventsPath, { start: offset, end: stat.size - 1, encoding: "utf8" });
      let buf = "";
      stream.on("data", (c) => {
        buf += c;
      });
      stream.on("end", () => {
        offset = stat.size;
        if (buf) consume(buf);
      });
    });
  }, pollIntervalMs);

  const heartbeat = setInterval(() => {
    try {
      res.write(":hb\n\n");
    } catch {
      /* connection already gone; cleanup runs on the close event */
    }
  }, 15000);

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

/** Build the dashboard's HTTP request handler. All routes live under /run/:token for one auth boundary. */
export function createDashboardRequestListener(
  ctx: DashboardServerContext,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!isAllowedHost(req.headers.host, ctx.port)) {
      writeStatus(res, 400, {}, "bad host");
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, ctx.port)) {
      writeStatus(res, 403, {}, "bad origin");
      return;
    }

    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      writeStatus(res, 405, { Allow: "GET, HEAD, POST" }, "method not allowed");
      return;
    }

    const pathname = safePathname(req.url);
    const match = pathname.match(/^\/run\/([^/]+)((?:\/.*)?)$/);
    if (!match || !isValidToken(match[1], ctx.token)) {
      writeStatus(res, 404, {}, "not found");
      return;
    }
    const rest = match[2] || "/";

    // The shutdown beacon is the only POST route; every other path stays GET/HEAD.
    if (rest === "/shutdown") {
      if (method !== "POST") {
        writeStatus(res, 405, { Allow: "POST" }, "method not allowed");
        return;
      }
      writeStatus(res, 202, {}, "shutting down");
      ctx.onShutdown?.();
      return;
    }
    if (method === "POST") {
      writeStatus(res, 405, { Allow: "GET, HEAD" }, "method not allowed");
      return;
    }

    if (rest === "/" || rest === "") {
      res.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" });
      res.end(ctx.html);
      return;
    }
    if (rest === "/events") {
      serveEvents(req, res, ctx);
      return;
    }
    const staticMatch = rest.match(/^\/static\/([^/]+)$/);
    if (staticMatch) {
      const asset = ctx.staticAssets[staticMatch[1]];
      if (!asset) {
        writeStatus(res, 404, {}, "not found");
        return;
      }
      res.writeHead(200, { ...securityHeaders(), "Content-Type": asset.contentType });
      res.end(asset.body);
      return;
    }
    writeStatus(res, 404, {}, "not found");
  };
}
