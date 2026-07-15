import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
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
