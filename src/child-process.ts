import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

export type ChildRunResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export const DEFAULT_STREAM_CAPTURE_LIMIT = 50 * 1024 * 1024;

type SpawnCommon = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Start a separate process group so abort can terminate descendants too. */
  processGroup?: boolean;
};

function appendBoundedTail(current: string, chunk: string, limit: number): string {
  if (limit <= 0) return "";
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function spawnBufferedChild(
  command: string,
  argv: string[],
  options: SpawnCommon,
): ChildRunResult {
  const child = spawnSync(command, argv, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    error: child.error,
  };
}

export const DEFAULT_ABORT_KILL_GRACE_MS = 2_000;

export async function spawnStreamingChild(
  command: string,
  argv: string[],
  options: SpawnCommon & {
    stdoutSink?: NodeJS.WritableStream;
    stderrSink?: NodeJS.WritableStream;
    maxCaptureChars?: number;
    /** After SIGTERM, escalate to SIGKILL if the process is still alive. */
    abortKillGraceMs?: number;
  },
): Promise<ChildRunResult> {
  const stdoutSink = options.stdoutSink ?? process.stdout;
  const stderrSink = options.stderrSink ?? process.stderr;
  const maxCaptureChars = options.maxCaptureChars ?? DEFAULT_STREAM_CAPTURE_LIMIT;
  const abortKillGraceMs = options.abortKillGraceMs ?? DEFAULT_ABORT_KILL_GRACE_MS;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Preserve terminal signal delivery for ordinary streaming children.
      // Panel callers opt into a group so their abort signal reaches Pi descendants.
      detached: options.processGroup === true && process.platform !== "win32",
    };
    const child = spawn(command, argv, spawnOpts);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: ChildRunResult) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };

    const sendSignal = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (options.processGroup && process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else if (options.processGroup) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Process already gone.
        }
      }
    };

    const abort = () => {
      if (child.pid === undefined || settled) return;
      sendSignal("SIGTERM");
      if (process.platform === "win32") return;
      killTimer = setTimeout(() => {
        if (!settled) sendSignal("SIGKILL");
      }, Math.max(0, abortKillGraceMs));
      killTimer.unref?.();
    };

    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBoundedTail(stdout, chunk, maxCaptureChars);
      stdoutSink.write(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBoundedTail(stderr, chunk, maxCaptureChars);
      stderrSink.write(chunk);
    });

    child.on("error", (error) => {
      finish({
        status: null,
        signal: null,
        stdout,
        stderr,
        error,
      });
    });

    child.on("close", (status, signal) => {
      finish({
        status,
        signal,
        stdout,
        stderr,
      });
    });
  });
}
