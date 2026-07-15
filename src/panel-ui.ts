// Launcher glue for the loopback dashboard (issue #4). Spawns the detached
// server process, waits for its ready handshake over a temporary IPC
// channel, then fully detaches it so it outlives the review process. The
// returned onEvent listener is the only ongoing link between the review
// process and the dashboard: it appends redacted ReviewEvent v1 JSONL to the
// run directory, which the detached server tails independently.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRunDirectory, generateCapabilityToken, writeUrlFileAtomic, DEFAULT_UI_TTL_SECONDS } from "./ui-server.js";
import type { ReviewEventListener } from "./review-events.js";

export interface LaunchPanelUiOptions {
  uiUrlFile?: string;
  ttlSeconds?: number;
  /** Milliseconds to wait for the server's ready handshake before falling back to headless. */
  readyTimeoutMs?: number;
  /** Test-only override for the forked server entry point (defaults to the compiled sibling module). */
  serverEntryPath?: string;
}

export interface PanelUiLaunch {
  runDir: string;
  url: string;
  token: string;
  /** PID of the detached server process, for diagnostics or an explicit early stop. */
  pid: number;
  onEvent: ReviewEventListener;
}

function defaultServerEntry(): string {
  return fileURLToPath(new URL("./ui-server-main.js", import.meta.url));
}

interface ReadyMessage {
  ready: boolean;
  port?: number;
  error?: string;
}

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<ReadyMessage | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    const done = (result: ReadyMessage | undefined): void => {
      clearTimeout(timer);
      resolve(result);
    };
    child.once("message", (msg) => done(msg as ReadyMessage));
    child.once("error", () => done(undefined));
    child.once("exit", () => done(undefined));
  });
}

/** Start the dashboard; returns undefined (with a stderr warning already written) if startup fails. */
export async function launchPanelUi(options: LaunchPanelUiOptions = {}): Promise<PanelUiLaunch | undefined> {
  const runId = randomUUID();
  const token = generateCapabilityToken();
  const runDir = createRunDirectory(runId);
  const eventsPath = path.join(runDir, "events.jsonl");
  fs.writeFileSync(eventsPath, "");

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_UI_TTL_SECONDS;
  const logPath = path.join(runDir, "server.log");
  const logFd = fs.openSync(logPath, "a");

  let child: ChildProcess;
  try {
    child = fork(options.serverEntryPath ?? defaultServerEntry(), [runDir, token, String(ttlSeconds * 1000)], {
      detached: true,
      stdio: ["ignore", logFd, logFd, "ipc"],
    });
  } catch (error) {
    fs.closeSync(logFd);
    process.stderr.write(`pi-review: dashboard failed to start (${(error as Error).message}); continuing without --ui web\n`);
    return undefined;
  }

  const ready = await waitForReady(child, options.readyTimeoutMs ?? 5000);
  fs.closeSync(logFd);

  if (!ready?.ready || ready.port === undefined) {
    process.stderr.write(
      `pi-review: dashboard failed to start${ready?.error ? ` (${ready.error})` : ""}; continuing without --ui web (see ${logPath})\n`,
    );
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    return undefined;
  }

  const pid = child.pid!;
  child.disconnect();
  child.unref();

  const url = `http://127.0.0.1:${ready.port}/run/${token}`;
  process.stderr.write(`PI_REVIEW_UI_URL: ${url}\n`);
  if (options.uiUrlFile) writeUrlFileAtomic(options.uiUrlFile, url);

  return {
    runDir,
    url,
    token,
    pid,
    onEvent: (event) => {
      try {
        fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
      } catch {
        /* the dashboard is best-effort; a write failure must never break the review */
      }
    },
  };
}
