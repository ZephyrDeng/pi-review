#!/usr/bin/env node
// Detached loopback dashboard server process (issue #4). panel-ui.ts spawns
// this via child_process.fork with a temporary IPC channel for the initial
// ready handshake, then fully detaches it: this process outlives the review
// process so a browser can reconnect/replay for the configured idle TTL.
// It never talks back to the parent after the handshake — it only tails the
// shared events.jsonl artifact on disk.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardRequestListener, MAX_RUN_LIFETIME_MS } from "./ui-server.js";
import type { DashboardServerContext } from "./ui-server.js";
import { renderDashboardHtml } from "./ui-html.js";
import type { ReviewEvent } from "./review-events.js";

const TTL_CHECK_INTERVAL_MS = 30_000;

function readTextAsset(name: string): string {
  return fs.readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

function isRunComplete(eventsPath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(eventsPath, "utf8");
  } catch {
    return false;
  }
  for (const line of content.split("\n")) {
    if (!line.includes("panel.completed")) continue;
    try {
      if ((JSON.parse(line) as ReviewEvent).type === "panel.completed") return true;
    } catch {
      /* malformed/partial line; ignore */
    }
  }
  return false;
}

function main(): void {
  const [runDir, token, ttlMsArg, ttlCheckIntervalArg] = process.argv.slice(2);
  if (!runDir || !token || !ttlMsArg || !Number.isFinite(Number(ttlMsArg))) {
    process.stderr.write("pi-review-ui-server: expected <runDir> <token> <ttlMs> [ttlCheckIntervalMs]\n");
    process.exitCode = 1;
    return;
  }
  const ttlMs = Number(ttlMsArg);
  // Test-only override; production always uses the default 30s cadence.
  const ttlCheckIntervalMs = ttlCheckIntervalArg && Number.isFinite(Number(ttlCheckIntervalArg))
    ? Number(ttlCheckIntervalArg)
    : TTL_CHECK_INTERVAL_MS;
  const eventsPath = path.join(runDir, "events.jsonl");

  let staticAssets: DashboardServerContext["staticAssets"];
  let html: string;
  try {
    staticAssets = {
      // panel-view.js's transitive runtime import (panel-usage.js) must be
      // served too, or the browser's ES module graph fails to resolve it.
      "panel-view.js": { contentType: "text/javascript; charset=utf-8", body: readTextAsset("panel-view.js") },
      "panel-usage.js": { contentType: "text/javascript; charset=utf-8", body: readTextAsset("panel-usage.js") },
      "ui-client.js": { contentType: "text/javascript; charset=utf-8", body: readTextAsset("ui-client.js") },
    };
    html = renderDashboardHtml({ runPath: `/run/${token}` });
  } catch (error) {
    process.send?.({ ready: false, error: (error as Error).message });
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  let completedAt: number | undefined;
  let shuttingDown = false;
  const server4 = http.createServer();
  const server6 = http.createServer();

  const ttlTimer = setInterval(() => {
    const now = Date.now();
    if (completedAt === undefined && isRunComplete(eventsPath)) completedAt = now;
    if (completedAt !== undefined && now - completedAt > ttlMs) {
      shutdown(0);
      return;
    }
    if (now - startedAt > MAX_RUN_LIFETIME_MS) shutdown(0);
  }, ttlCheckIntervalMs);

  function shutdown(exitCode: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ttlTimer);
    for (const server of [server4, server6]) {
      try {
        server.closeAllConnections();
        server.close();
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    process.exit(exitCode);
  }

  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  server4.once("error", (error) => {
    process.send?.({ ready: false, error: (error as Error).message });
    shutdown(1);
  });

  server4.listen(0, "127.0.0.1", () => {
    const address = server4.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const ctx: DashboardServerContext = { token, port, eventsPath, html, staticAssets };
    const listener = createDashboardRequestListener(ctx);
    server4.on("request", listener);

    // Best-effort IPv6 loopback: never widen to 0.0.0.0, and a bind failure
    // here (dual-stack quirks, IPv6 disabled) must not affect the IPv4 path.
    server6.on("error", () => {});
    server6.on("request", listener);
    server6.listen(port, "::1");

    process.send?.({ ready: true, port });
  });
}

main();
