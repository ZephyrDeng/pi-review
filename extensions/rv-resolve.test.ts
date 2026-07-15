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
  {
    provider: "px:anthropic",
    id: "claude-opus-4-8",
    label: "px:anthropic/claude-opus-4-8",
    name: "opus-px",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["high", "xhigh"],
  },
  {
    provider: "px:anthropic",
    id: "claude-sonnet-4-5",
    label: "px:anthropic/claude-sonnet-4-5",
    name: "sonnet-px",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["medium", "high"],
  },
  {
    provider: "px:anthropic",
    id: "claude-haiku-4-5",
    label: "px:anthropic/claude-haiku-4-5",
    name: "haiku-px",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["low", "medium"],
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

test("extractModelThinkingFromText never rewrites natural-language targets", () => {
  const original = "review high memory usage under @src";
  const extracted = extractModelThinkingFromText(original, models, "openai-codex");
  assert.equal(extracted.target, original);
  assert.equal(extracted.model, undefined);
  assert.equal(extracted.thinking, undefined);
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

test("resolveRvParsed keeps natural-language targets verbatim", () => {
  const target = "review high memory usage under @src";
  const resolved = resolveRvParsed(baseParsed({ target }), models);
  assert.equal(resolved.parsed.target, target);
  assert.equal(resolved.parsed.model, undefined);
  assert.equal(resolved.parsed.thinking, undefined);
});

test("resolveRvParsed resolves short names inside --reviewer-model mappings", () => {
  const resolved = resolveRvParsed(
    baseParsed({
      reviewers: 2,
      reviewerModels: ["r1=gpt-5.5:最高", "r2=kimi"],
    }),
    models,
    "openai-codex",
  );
  assert.deepEqual(resolved.parsed.reviewerModels, [
    "r1=openai-codex/gpt-5.5:xhigh",
    "r2=wafer.ai/Kimi-K2.6",
  ]);
  assert.ok(resolved.notes.some((note) => /reviewer-model r1/.test(note)));
});

test("px:anthropic exact catalog ids keep provider colons", () => {
  for (const label of [
    "px:anthropic/claude-opus-4-8",
    "px:anthropic/claude-sonnet-4-5",
    "px:anthropic/claude-haiku-4-5",
  ]) {
    const resolved = resolveModelFromCatalog(label, models);
    assert.equal(resolved.status, "exact", label);
    if (resolved.status === "exact") assert.equal(resolved.model.label, label);
  }

  const withThinking = resolveRvParsed(
    baseParsed({ model: "px:anthropic/claude-opus-4-8:xhigh" }),
    models,
  );
  assert.equal(withThinking.parsed.model, "px:anthropic/claude-opus-4-8");
  assert.equal(withThinking.parsed.thinking, "xhigh");
  assert.ok(withThinking.notes.some((note) => /thinking suffix/.test(note)));
});
