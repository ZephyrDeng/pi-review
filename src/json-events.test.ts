import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFinalText, extractUsage, JsonEventStream } from "./json-events.js";

function lines(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

test("extractFinalText reads the final assistant text from agent_end", () => {
  const input = lines(
    { type: "session", id: "s1" },
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
    {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "review this" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "## Verdict\napprove\n\n" },
            { type: "text", text: "## Summary\nlooks good" },
          ],
          stopReason: "stop",
        },
      ],
    },
  );
  const result = extractFinalText(input);
  assert.equal(result.text, "## Verdict\napprove\n\n## Summary\nlooks good");
  assert.equal(result.error, undefined);
  assert.equal(result.fatal, undefined);
});

test("extractFinalText skips unparseable and empty lines", () => {
  const good = lines({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }],
  });
  const input = ["", "not json {{{", good, "", "}} also not json"].join("\n");
  const result = extractFinalText(input);
  assert.equal(result.text, "ok");
  assert.equal(result.error, undefined);
});

test("extractFinalText falls back to the last streamed assistant message when agent_end is missing", () => {
  const input = lines(
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first final" }] } },
  );
  const result = extractFinalText(input);
  assert.equal(result.text, "first final");
  assert.match(result.error ?? "", /agent_end/);
  assert.equal(result.fatal, undefined);
});

test("extractFinalText reports an error when no assistant content exists at all", () => {
  const input = lines({
    type: "agent_end",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  const result = extractFinalText(input);
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractFinalText marks a fatal stop reason", () => {
  const input = lines({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "provider rate limited",
      },
    ],
  });
  const result = extractFinalText(input);
  assert.equal(result.fatal, true);
  assert.equal(result.error, "provider rate limited");
});

test("extractFinalText handles empty input without throwing", () => {
  const result = extractFinalText("");
  assert.equal(result.text, "");
  assert.ok(result.error);
});

test("extractFinalText uses the last agent_end when the child retries", () => {
  const input = lines(
    {
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", content: [{ type: "text", text: "first attempt" }], stopReason: "error" }],
    },
    {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "final attempt" }], stopReason: "stop" }],
    },
  );
  const result = extractFinalText(input);
  assert.equal(result.text, "final attempt");
  assert.equal(result.fatal, undefined);
});

test("extractUsage accumulates tokens from message_end and agent_end", () => {
  const input = lines(
    { type: "session", id: "s1" },
    { type: "message_end", message: { role: "assistant", usage: { input: 44, output: 3, cacheRead: 17984, cacheWrite: 0, reasoning: 0, totalTokens: 18031, cost: { total: 0.025 } }, model: "hf:zai-org/GLM-5.2" } },
    { type: "agent_end", messages: [{ role: "assistant", responseModel: "zai-org/GLM-5.2" }] },
  );
  const result = extractUsage(input);
  assert.ok(result.usage);
  assert.equal(result.usage!.input, 44);
  assert.equal(result.usage!.output, 3);
  assert.equal(result.usage!.cacheRead, 17984);
  assert.equal(result.usage!.totalTokens, 18031);
  assert.equal(result.usage!.costTotal, 0.025);
  assert.equal(result.responseModel, "zai-org/GLM-5.2");
});

test("extractUsage returns undefined when no usage events exist", () => {
  const input = lines({ type: "session", id: "s1" }, { type: "agent_end", messages: [{ role: "assistant" }] });
  const result = extractUsage(input);
  assert.equal(result.usage, undefined);
  assert.equal(result.responseModel, undefined);
});

test("extractUsage sums output across multiple assistant turns", () => {
  const input = lines(
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150 } } },
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 30, totalTokens: 130 } } },
  );
  const result = extractUsage(input);
  assert.equal(result.usage!.output, 80);
  assert.equal(result.usage!.input, 100);
});

test("JsonEventStream forwards text deltas and emits milestones", () => {
  const texts: string[] = [];
  const milestones: string[] = [];
  const stream = new JsonEventStream({ onText: (c) => texts.push(c), onMilestone: (l) => milestones.push(l) });
  const input = lines(
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello ", partial: { role: "assistant" } } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world", partial: { role: "assistant" } } },
    { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Hello world" }], responseModel: "fake/model" }] },
  );
  stream.feed(input);
  stream.flush();
  assert.equal(texts.join(""), "Hello world");
  assert.ok(milestones.some((m) => /review started/.test(m)));
  assert.ok(milestones.some((m) => /review finished/.test(m)));
  const usage = stream.usage();
  assert.ok(usage.responseModel === "fake/model" || usage.responseModel === undefined);
});

test("JsonEventStream accumulates token usage from streamed events", () => {
  const stream = new JsonEventStream({ onText: () => {}, onMilestone: () => {} });
  stream.feed(lines(
    { type: "message_end", message: { role: "assistant", usage: { input: 200, output: 50, cacheRead: 100, cacheWrite: 0, reasoning: 10, totalTokens: 260 } } },
  ));
  stream.flush();
  const usage = stream.usage().usage;
  assert.ok(usage);
  assert.equal(usage!.input, 200);
  assert.equal(usage!.output, 50);
  assert.equal(usage!.cacheRead, 100);
  assert.equal(usage!.reasoning, 10);
});

test("JsonEventStream handles partial lines across chunks", () => {
  const texts: string[] = [];
  const stream = new JsonEventStream({ onText: (c) => texts.push(c), onMilestone: () => {} });
  // Feed a partial line, then complete it.
  stream.feed('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"par');
  stream.feed('tial","partial":{"role":"assistant"}}}\n');
  stream.flush();
  assert.equal(texts.join(""), "partial");
});

test("JsonEventStream skips unparseable lines without throwing", () => {
  const stream = new JsonEventStream({ onText: () => {}, onMilestone: () => {} });
  stream.feed("not json\n");
  stream.feed('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok","partial":{"role":"assistant"}}}\n');
  stream.flush();
  assert.equal(stream.usage().usage, undefined);
});
