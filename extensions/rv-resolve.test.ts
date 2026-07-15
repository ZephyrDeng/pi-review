import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "./rv-completions.js";
import {
  canonicalizeThinking,
  extractModelThinkingFromText,
  normalizeModelKey,
  resolveModelFromCatalog,
  resolveRvParsed,
  resolveThinking,
} from "./rv-resolve.js";
import type { RvParsed } from "./rv-prompts.js";

const models: ModelInfo[] = [
  {
    provider: "openai-codex",
    id: "gpt-5.5",
    label: "openai-codex/gpt-5.5",
    name: "gpt-5.5",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  },
  {
    provider: "openai",
    id: "gpt-5.5",
    label: "openai/gpt-5.5",
    name: "gpt-5.5",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["medium", "high"],
  },
  {
    provider: "wafer.ai",
    id: "Kimi-K2.6",
    label: "wafer.ai/Kimi-K2.6",
    name: "Kimi",
    reasoning: true,
    contextWindow: 128000,
    thinkingLevels: ["low", "high"],
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-8",
    label: "anthropic/claude-opus-4-8",
    name: "opus",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["high", "xhigh"],
  },
];

function baseParsed(over: Partial<RvParsed> = {}): RvParsed {
  return {
    strategy: "panel",
    mode: "code",
    keepSession: false,
    noStream: false,
    modelsOnly: false,
    target: "@src",
    ...over,
  };
}

test("normalizeModelKey collapses separators", () => {
  assert.equal(normalizeModelKey("GPT-5.5"), "gpt55");
  assert.equal(normalizeModelKey("gpt_5_5"), "gpt55");
  assert.equal(normalizeModelKey("openai-codex/gpt-5.5"), "openaicodex/gpt55");
});

test("thinking aliases and model-supported fallback", () => {
  assert.equal(canonicalizeThinking("最高"), "xhigh");
  assert.equal(canonicalizeThinking("max"), "xhigh");
  assert.deepEqual(resolveThinking("xhigh", ["low", "medium", "high"]), {
    status: "fallback",
    level: "high",
    from: "xhigh",
    reason: "xhigh unsupported; using high",
  });
  assert.equal(resolveThinking("high", ["low", "medium", "high"]).status, "exact");
});

test("model catalog resolves short ids and prefers primary provider", () => {
  const unique = resolveModelFromCatalog("gpt-5.5", models, "openai-codex");
  assert.equal(unique.status, "unique");
  if (unique.status === "unique") assert.equal(unique.model.label, "openai-codex/gpt-5.5");

  const exact = resolveModelFromCatalog("openai/gpt-5.5", models);
  assert.equal(exact.status, "exact");

  const kimi = resolveModelFromCatalog("kimi", models);
  assert.equal(kimi.status, "unique");
  if (kimi.status === "unique") assert.equal(kimi.model.label, "wafer.ai/Kimi-K2.6");
});

test("extractModelThinkingFromText pulls bare tokens out of natural language", () => {
  const extracted = extractModelThinkingFromText("gpt-5.5 最高 review auth under @src", models, "openai-codex");
  assert.equal(extracted.model, "openai-codex/gpt-5.5");
  assert.equal(extracted.thinking, "xhigh");
  assert.match(extracted.target, /review auth under @src/);
});

test("resolveRvParsed normalizes flags and inline model:thinking", () => {
  const resolved = resolveRvParsed(
    baseParsed({ model: "gpt-5.5", thinking: "最高" }),
    models,
    "openai-codex",
  );
  assert.equal(resolved.parsed.model, "openai-codex/gpt-5.5");
  assert.equal(resolved.parsed.thinking, "xhigh");
  assert.ok(resolved.notes.some((note) => /model gpt-5\.5/.test(note)));

  const inline = resolveRvParsed(baseParsed({ model: "openai/gpt-5.5:xhigh" }), models);
  assert.equal(inline.parsed.model, "openai/gpt-5.5");
  assert.equal(inline.parsed.thinking, "high"); // model only supports up to high
  assert.ok(inline.notes.some((note) => /thinking/.test(note)));
});

test("resolveRvParsed extracts model tokens from target text", () => {
  const resolved = resolveRvParsed(
    baseParsed({ target: "use kimi high on @src" }),
    models,
  );
  assert.equal(resolved.parsed.model, "wafer.ai/Kimi-K2.6");
  assert.equal(resolved.parsed.thinking, "high");
  assert.match(resolved.parsed.target, /@src/);
});
