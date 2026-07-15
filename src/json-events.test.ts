import assert from "node:assert/strict";
import { test } from "vitest";
import { extractFinalText, extractUsage, JsonEventStream } from "./json-events.js";

function lines(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const firstUsageSnapshot = {
  input: 100,
  output: 20,
  cacheRead: 50,
  cacheWrite: 2,
  reasoning: 5,
  totalTokens: 172,
  cost: { total: 0.1 },
};

const secondUsageSnapshot = {
  input: 30,
  output: 10,
  cacheRead: 170,
  cacheWrite: 0,
  reasoning: 2,
  totalTokens: 210,
  cost: { total: 0.12 },
};

function repeatedUsageEvents(): unknown[] {
  return [
    { type: "message_start", message: { role: "assistant", usage: firstUsageSnapshot } },
    {
      type: "message_update",
      message: { role: "assistant", usage: firstUsageSnapshot },
      assistantMessageEvent: { type: "text_delta", delta: "first", partial: { role: "assistant", usage: firstUsageSnapshot } },
    },
    { type: "message_end", message: { role: "assistant", usage: firstUsageSnapshot, model: "provider/model" } },
    { type: "turn_end", message: { role: "assistant", usage: firstUsageSnapshot } },
    {
      type: "message_update",
      message: { role: "assistant", usage: secondUsageSnapshot },
      assistantMessageEvent: { type: "text_delta", delta: "second", partial: { role: "assistant", usage: secondUsageSnapshot } },
    },
    { type: "message_end", message: { role: "assistant", usage: secondUsageSnapshot, responseModel: "provider/model" } },
    { type: "turn_end", message: { role: "assistant", usage: secondUsageSnapshot } },
    {
      type: "agent_end",
      messages: [
        { role: "assistant", usage: firstUsageSnapshot },
        { role: "assistant", usage: secondUsageSnapshot, responseModel: "provider/model" },
      ],
    },
  ];
}

const repeatedUsageExpected = {
  usage: {
    input: 130,
    output: 30,
    cacheRead: 220,
    cacheWrite: 2,
    reasoning: 7,
    totalTokens: 382,
    costTotal: 0.22,
  },
  responseModel: "provider/model",
};

const firstFallbackUsage = { input: 10, output: 2, totalTokens: 12 };
const secondFallbackUsage = { input: 20, output: 3, totalTokens: 23 };
const fallbackUsageExpected = {
  input: 30,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 35,
};

function fullAgentEndFallbackEvents(): unknown[] {
  return [{
    type: "agent_end",
    messages: [
      { role: "assistant", usage: { ...firstFallbackUsage, cost: { total: 0.01 } } },
      {
        role: "assistant",
        usage: { ...secondFallbackUsage, cost: { total: 0.02 } },
        responseModel: "fallback/model",
      },
    ],
  }];
}

function missingMessageEndUsageEvents(): unknown[] {
  return [
    {
      type: "message_end",
      message: { role: "assistant", responseId: "response-1", usage: firstFallbackUsage },
    },
    { type: "message_end", message: { role: "assistant", responseId: "response-2" } },
    {
      type: "agent_end",
      messages: [
        { role: "assistant", responseId: "response-1", usage: firstFallbackUsage },
        { role: "assistant", responseId: "response-2", usage: secondFallbackUsage },
      ],
    },
  ];
}

function multipleAgentFallbackEvents(): unknown[] {
  return [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", usage: firstFallbackUsage } },
    { type: "agent_end", messages: [{ role: "assistant", usage: firstFallbackUsage }] },
    { type: "agent_start" },
    { type: "agent_end", messages: [{ role: "assistant", usage: secondFallbackUsage }] },
  ];
}

function parseStreamUsage(events: unknown[]) {
  const stream = new JsonEventStream({ onText: () => {}, onMilestone: () => {} });
  stream.feed(lines(...events));
  stream.flush();
  return stream.usage();
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

test("extractUsage uses message_end usage and agent_end response model", () => {
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

test("extractUsage falls back to agent_end usage when message_end usage is absent", () => {
  assert.deepEqual(extractUsage(lines(...fullAgentEndFallbackEvents())), {
    usage: { ...fallbackUsageExpected, costTotal: 0.03 },
    responseModel: "fallback/model",
  });
});

test("extractUsage fills missing message_end usage from unseen agent_end response ids", () => {
  assert.deepEqual(extractUsage(lines(...missingMessageEndUsageEvents())).usage, fallbackUsageExpected);
});

test("extractUsage applies no-id agent_end fallback independently per agent run", () => {
  assert.deepEqual(extractUsage(lines(...multipleAgentFallbackEvents())).usage, fallbackUsageExpected);
});

test("extractUsage returns undefined when no usage events exist", () => {
  const input = lines({ type: "session", id: "s1" }, { type: "agent_end", messages: [{ role: "assistant" }] });
  const result = extractUsage(input);
  assert.equal(result.usage, undefined);
  assert.equal(result.responseModel, undefined);
});

test("extractUsage sums separately billed usage across multiple assistant turns", () => {
  const input = lines(
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150 } } },
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 30, totalTokens: 130 } } },
  );
  const result = extractUsage(input);
  assert.equal(result.usage!.output, 80);
  assert.equal(result.usage!.input, 200);
  assert.equal(result.usage!.totalTokens, 280);
});

test("extractUsage counts repeated usage snapshots once per completed assistant message", () => {
  assert.deepEqual(extractUsage(lines(...repeatedUsageEvents())), repeatedUsageExpected);
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

test("JsonEventStream attaches a redacted tool summary from tool args", () => {
  const activities: Array<{ type: string; tool?: string; summary?: string }> = [];
  const stream = new JsonEventStream({
    onText: () => {},
    onMilestone: () => {},
    onActivity: (event) => {
      if (event.type === "tool.started" || event.type === "tool.finished") activities.push(event);
    },
  });
  stream.feed(lines(
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/panel.ts" } },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false },
    { type: "tool_execution_start", toolCallId: "call-2", toolName: "grep", args: { pattern: "token=sk-secret-value", path: "src" } },
    { type: "tool_execution_end", toolCallId: "call-2", toolName: "grep", result: {}, isError: false },
  ));
  stream.flush();
  assert.deepEqual(activities, [
    { type: "tool.started", tool: "read", summary: "src/panel.ts" },
    { type: "tool.finished", tool: "read", summary: "src/panel.ts" },
    { type: "tool.started", tool: "grep", summary: "/token=[REDACTED] in src" },
    { type: "tool.finished", tool: "grep", summary: "/token=[REDACTED] in src" },
  ]);
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

test("JsonEventStream counts repeated usage snapshots once per completed assistant message", () => {
  const usageCosts: Array<number | undefined> = [];
  const stream = new JsonEventStream({
    onText: () => {},
    onMilestone: () => {},
    onActivity: (event) => {
      if (event.type === "usage") usageCosts.push(event.usage.costTotal);
    },
  });

  stream.feed(lines(...repeatedUsageEvents()));
  stream.flush();

  assert.deepEqual(stream.usage(), repeatedUsageExpected);
  assert.equal(usageCosts.at(-1), 0.22);
});

test("JsonEventStream falls back to agent_end usage when message_end usage is absent", () => {
  assert.deepEqual(parseStreamUsage(fullAgentEndFallbackEvents()), {
    usage: { ...fallbackUsageExpected, costTotal: 0.03 },
    responseModel: "fallback/model",
  });
});

test("JsonEventStream fills missing message_end usage from unseen agent_end response ids", () => {
  assert.deepEqual(parseStreamUsage(missingMessageEndUsageEvents()).usage, fallbackUsageExpected);
});

test("JsonEventStream applies no-id agent_end fallback independently per agent run", () => {
  assert.deepEqual(parseStreamUsage(multipleAgentFallbackEvents()).usage, fallbackUsageExpected);
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
