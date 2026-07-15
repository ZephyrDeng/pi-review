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

export async function spawnStreamingChild(
  command: string,
  argv: string[],
  options: SpawnCommon & {
    stdoutSink?: NodeJS.WritableStream;
    stderrSink?: NodeJS.WritableStream;
    maxCaptureChars?: number;
  },
): Promise<ChildRunResult> {
  const stdoutSink = options.stdoutSink ?? process.stdout;
  const stderrSink = options.stderrSink ?? process.stderr;
  const maxCaptureChars = options.maxCaptureChars ?? DEFAULT_STREAM_CAPTURE_LIMIT;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A separate process group lets cancellation reach Pi's descendants too.
      detached: process.platform !== "win32",
    };
    const child = spawn(command, argv, spawnOpts);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ChildRunResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };

    const abort = () => {
      if (child.pid === undefined || child.killed) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
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
