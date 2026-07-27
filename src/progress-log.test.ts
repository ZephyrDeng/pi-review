import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, afterEach } from "vitest";
import { JsonEventStream } from "./json-events.js";
import { ProgressLogWriter, slimProgressLine } from "./progress-log.js";

let tempDir = "";
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function updateLine(delta: string, snapshotText: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta,
      partial: {
        role: "assistant",
        content: [{ type: "text", text: snapshotText }],
        model: "prov/model",
        usage: { input: 10, output: 20, totalTokens: 30 },
        stopReason: null,
        responseId: "resp-1",
      },
    },
  });
}

test("slimProgressLine reduces the cumulative partial snapshot to its usage", () => {
  const line = updateLine("chunk", "x".repeat(50_000));
  const slimmed = slimProgressLine(line);
  assert.ok(slimmed.length < line.length / 100, `expected big reduction, got ${slimmed.length}/${line.length}`);

  const event = JSON.parse(slimmed);
  assert.equal(event.type, "message_update");
  assert.equal(event.assistantMessageEvent.type, "text_delta");
  assert.equal(event.assistantMessageEvent.delta, "chunk");
  assert.deepEqual(event.assistantMessageEvent.partial, { usage: { input: 10, output: 20, totalTokens: 30 } });
});

test("slimProgressLine reduces the duplicate top-level message snapshot too", () => {
  const line = JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "d", partial: { role: "assistant", content: [] } },
    message: { role: "assistant", content: [{ type: "text", text: "y".repeat(10_000) }], usage: { input: 1 } },
  });
  const event = JSON.parse(slimProgressLine(line));
  // partial had no usage, so the whole snapshot goes; message keeps only usage
  assert.equal("partial" in event.assistantMessageEvent, false);
  assert.deepEqual(event.message, { usage: { input: 1 } });
  assert.equal(event.assistantMessageEvent.delta, "d");
});

test("slimProgressLine leaves every other line byte-for-byte untouched", () => {
  const lines = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "full review" }] } }),
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "full" }] }] }),
    // payload merely mentions message_update; type differs, so no rewrite
    JSON.stringify({ type: "tool_execution_end", toolName: "read", content: "docs about message_update events" }),
    "not json at all",
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"trunc', // truncated line
    // no snapshots at all: nothing to slim
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "d" } }),
    // already slimmed lines re-slim as a no-op (idempotent)
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "d", partial: { usage: { input: 1 } } } }),
  ];
  for (const line of lines) {
    assert.equal(slimProgressLine(line), line);
  }
});

test("ProgressLogWriter slims complete lines across arbitrary chunk boundaries", async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-progress-log-"));
  const file = path.join(tempDir, "nested", "progress.jsonl");
  const writer = new ProgressLogWriter(file);

  const update = updateLine("delta-1", "z".repeat(5_000));
  const done = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } });
  const payload = `${update}\n${done}\n`;
  for (let index = 0; index < payload.length; index += 7) {
    writer.write(payload.slice(index, index + 7));
  }
  writer.write('{"type":"message_upd'); // trailing partial line (child killed mid-write)
  assert.equal(await writer.end(), undefined);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.equal(first.assistantMessageEvent.delta, "delta-1");
  assert.deepEqual(first.assistantMessageEvent.partial, { usage: { input: 10, output: 20, totalTokens: 30 } });
  assert.equal(lines[1], done);
  assert.equal(lines[2], '{"type":"message_upd');
});

test("ProgressLogWriter raw mode tees chunks verbatim and appends across writers", async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-progress-log-"));
  const file = path.join(tempDir, "raw.jsonl");
  const update = updateLine("delta-raw", "big".repeat(2_000));

  const writerA = new ProgressLogWriter(file, { raw: true });
  writerA.write(`${update}\n`);
  assert.equal(await writerA.end(), undefined);

  const writerB = new ProgressLogWriter(file, { raw: true });
  writerB.write(`${update}\n`);
  assert.equal(await writerB.end(), undefined);

  assert.equal(fs.readFileSync(file, "utf8"), `${update}\n${update}\n`);
});

test("ProgressLogWriter slim mode appends across writers with every line slimmed", async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-progress-log-"));
  const file = path.join(tempDir, "slim.jsonl");

  const writerA = new ProgressLogWriter(file);
  writerA.write(`${updateLine("a", "x".repeat(1_000))}\n`);
  assert.equal(await writerA.end(), undefined);

  const writerB = new ProgressLogWriter(file);
  writerB.write(`${updateLine("b", "y".repeat(1_000))}\n`);
  assert.equal(await writerB.end(), undefined);

  const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.assistantMessageEvent.delta), ["a", "b"]);
  for (const event of events) {
    assert.deepEqual(event.assistantMessageEvent.partial, { usage: { input: 10, output: 20, totalTokens: 30 } });
  }
});

// Regression guard for the core fix: a verbatim tee of cumulative snapshots is
// O(n^2) in message length; the slimmed stream must stay linear in the deltas.
// Real pi emits the snapshot twice per update (assistantMessageEvent.partial
// and a duplicate top-level message), so the fixture models both copies.
test("slimming keeps multi-delta streams linear instead of quadratic", () => {
  const chunk = "x".repeat(400);
  let cumulative = "";
  const rawLines: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    cumulative += chunk;
    const snapshot = { role: "assistant", content: [{ type: "text", text: cumulative }], usage: { input: 1, output: index } };
    rawLines.push(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: chunk, partial: snapshot },
      message: snapshot,
    }));
  }
  const rawBytes = rawLines.reduce((sum, line) => sum + line.length, 0);
  const slimBytes = rawLines.reduce((sum, line) => sum + slimProgressLine(line).length, 0);
  // Per-line overhead stays bounded, so the slim total is ~deltas + constant/line.
  const linearBound = rawLines.length * (chunk.length + 300);
  assert.ok(slimBytes < linearBound, `slim ${slimBytes} exceeded linear bound ${linearBound}`);
  assert.ok(slimBytes < rawBytes / 15, `slim ${slimBytes} vs raw ${rawBytes} — expected >15x reduction`);
});

// The strongest form of the replay guarantee: feeding the slimmed stream
// through pi-review's own live parser produces the same forwarded text,
// milestones, and final usage as the verbatim stream.
test("slimmed streams replay through JsonEventStream identically to raw", () => {
  const deltas = ["Hello ", "world", "!"];
  let cumulative = "";
  const rawLines: string[] = [
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
  ];
  for (const delta of deltas) {
    cumulative += delta;
    const snapshot = { role: "assistant", content: [{ type: "text", text: cumulative }], usage: { input: 5, output: 1 } };
    rawLines.push(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta, partial: snapshot },
      message: snapshot,
    }));
  }
  const usage = { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 12 };
  rawLines.push(JSON.stringify({ type: "message_end", message: { role: "assistant", responseId: "r1", content: [{ type: "text", text: cumulative }], usage } }));
  rawLines.push(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", responseId: "r1", content: [{ type: "text", text: cumulative }], usage }] }));

  function replay(lines: string[]) {
    const texts: string[] = [];
    const milestones: string[] = [];
    const stream = new JsonEventStream({
      onText: (chunk) => texts.push(chunk),
      onMilestone: (line) => milestones.push(line),
    });
    for (const line of lines) stream.feed(`${line}\n`);
    stream.flush();
    return { text: texts.join(""), milestones, usage: stream.usage() };
  }

  const raw = replay(rawLines);
  const slim = replay(rawLines.map((line) => slimProgressLine(line)));
  assert.deepEqual(slim, raw);
  assert.equal(raw.text, "Hello world!");
  assert.equal(raw.usage.usage?.totalTokens, 12);
});

test("ProgressLogWriter end() reports write errors instead of throwing", async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-progress-log-"));
  const dirTarget = path.join(tempDir, "target-is-a-directory");
  fs.mkdirSync(dirTarget, { recursive: true });

  const writer = new ProgressLogWriter(dirTarget);
  writer.write('{"type":"agent_start"}\n');
  const error = await writer.end();
  assert.ok(error instanceof Error, String(error));
});
