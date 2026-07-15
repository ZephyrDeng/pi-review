import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "vitest";
import { spawnBufferedChild, spawnStreamingChild } from "./child-process.js";

function collectSink(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, chunks };
}

/** Resolve once the collected chunks match `pattern`, with a generous timeout
 *  so we never hang forever if the child never emits. */
function waitForOutput(chunks: string[], pattern: RegExp, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pattern.test(chunks.join(""))) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${pattern}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("spawnBufferedChild captures stdout", () => {
  const r = spawnBufferedChild(process.execPath, ["-e", "console.log('buf')"], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /buf/);
});

test("spawnStreamingChild reports signal when child is killed", async () => {
  const { stream } = collectSink();
  const r = await spawnStreamingChild(
    process.execPath,
    ["-e", "process.kill(process.pid, 'SIGTERM')"],
    { stdoutSink: stream, stderrSink: stream },
  );
  assert.equal(r.status, null);
  assert.equal(r.signal, "SIGTERM");
});

test("spawnStreamingChild forwards chunks and collects full stdout", async () => {
  const script = [
    "console.log('line1');",
    "setTimeout(() => console.log('line2'), 30);",
  ].join("");
  const { stream, chunks } = collectSink();
  const r = await spawnStreamingChild(process.execPath, ["-e", script], {
    stdoutSink: stream,
    stderrSink: stream,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /line1/);
  assert.match(r.stdout, /line2/);
  const forwarded = chunks.join("");
  assert.match(forwarded, /line1/);
  assert.match(forwarded, /line2/);
});

test("spawnStreamingChild keeps captured stdout bounded while forwarding all output", async () => {
  const script = "process.stdout.write('abcde'); process.stdout.write('fghij');";
  const { stream, chunks } = collectSink();
  const r = await spawnStreamingChild(process.execPath, ["-e", script], {
    stdoutSink: stream,
    stderrSink: stream,
    maxCaptureChars: 6,
  });

  assert.equal(r.status, 0);
  assert.equal(r.stdout, "efghij");
  assert.equal(chunks.join(""), "abcdefghij");
});

test("spawnStreamingChild terminates an opted-in process group when aborted", async () => {
  const controller = new AbortController();
  const { stream } = collectSink();
  const result = spawnStreamingChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdoutSink: stream,
    stderrSink: stream,
    signal: controller.signal,
    processGroup: true,
  });
  setTimeout(() => controller.abort(), 30);
  const child = await result;
  assert.equal(child.signal, "SIGTERM");
});

test("spawnStreamingChild escalates ignored SIGTERM to SIGKILL after the abort grace period", async () => {
  const controller = new AbortController();
  const { stream, chunks } = collectSink();
  // Register the ignore handler first, then stay alive until SIGKILL.
  const script = [
    "process.on('SIGTERM', () => { process.stdout.write('ignored\\n'); });",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join("");
  const result = spawnStreamingChild(process.execPath, ["-e", script], {
    stdoutSink: stream,
    stderrSink: stream,
    signal: controller.signal,
    processGroup: false,
    abortKillGraceMs: 50,
  });
  // Wait until the child has actually registered its SIGTERM handler and
  // signalled readiness, rather than a fixed delay — under parallel load the
  // child can take longer to start, and aborting before the handler is
  // installed would let SIGTERM kill it (observed as SIGTERM instead of SIGKILL).
  await waitForOutput(chunks, /ready/);
  controller.abort();
  const child = await result;
  assert.equal(child.signal, "SIGKILL");
  assert.match(chunks.join("") + child.stdout, /ready/);
});
