import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  DEFAULT_REVIEW_MODEL_PRIORITIES,
  matchPresetEntry,
  rankModelsWithPresets,
  resolveReviewProfile,
  type PresetModelEntry,
} from "./rv-model-priorities.js";
import type { ModelInfo } from "./rv-completions.js";

function m(provider: string, id: string, extra?: Partial<ModelInfo>): ModelInfo {
  return {
    provider,
    id,
    label: `${provider}/${id}`,
    name: id,
    reasoning: true,
    contextWindow: 200_000,
    thinkingLevels: ["high", "xhigh"],
    ...extra,
  };
}

describe("resolveReviewProfile", () => {
  it("uses plan profile for plan/challenge mode", () => {
    assert.equal(resolveReviewProfile("plan", "ts"), "plan");
    assert.equal(resolveReviewProfile("challenge", "md"), "plan");
  });

  it("uses frontend profile for vue/svelte/css targets", () => {
    assert.equal(resolveReviewProfile("code", "vue"), "frontend");
    assert.equal(resolveReviewProfile("code", "css"), "frontend");
  });

  it("defaults to code profile", () => {
    assert.equal(resolveReviewProfile("code", "ts"), "code");
  });
});

describe("matchPresetEntry", () => {
  const registry = [
    m("openai-codex", "gpt-5.6-sol"),
    m("openai-codex", "gpt-5.6-terra"),
    m("openai-codex", "gpt-5.6-luna"),
    m("zhipu", "glm-5.2-chat"),
    m("moonshot", "kimi-k2.7-code"),
    m("moonshot", "kimi-k2.5"),
    m("anthropic", "claude-opus-4-8"),
    m("anthropic", "claude-opus-4-6"),
    m("anthropic", "claude-sonnet-4-5"),
    m("anthropic", "claude-fable-5"),
    m("deepseek", "deepseek-v4-pro"),
    m("deepseek", "deepseek-v4-flash"),
    m("xai", "grok-4.5"),
    m("minimax", "minimax-m3"),
  ];

  it("picks newest kimi when versionPrefer 2.7", () => {
    const entry: PresetModelEntry = { idContains: "kimi", versionPrefer: "2.7" };
    const hit = matchPresetEntry(registry, entry);
    assert.ok(hit);
    assert.match(hit!.id, /2\.7|k2\.7/i);
  });

  it("ranks fast-review models first for code presets", () => {
    const ordered = rankModelsWithPresets(registry, "code", DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ordered[0].id, "claude-sonnet-4-5");
    assert.equal(ordered[1].id, "deepseek-v4-flash");
    assert.ok(ordered.some((row) => row.id === "gpt-5.6-terra"));
    assert.ok(ordered.some((row) => row.id === "gpt-5.6-luna"));
  });

  it("ranks complex/plan models with sol then opus then fable", () => {
    const ordered = rankModelsWithPresets(registry, "plan", DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ordered[0].id, "gpt-5.6-sol");
    assert.equal(ordered[1].id, "claude-opus-4-8");
    assert.equal(ordered[2].id, "claude-fable-5");
    assert.ok(ordered.some((row) => row.id === "deepseek-v4-pro"));
    assert.ok(ordered.some((row) => row.id === "grok-4.5"));
  });

  it("ranks vision/frontend with claude then gpt then kimi", () => {
    const ordered = rankModelsWithPresets(registry, "frontend", DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.match(ordered[0].id, /claude/i);
    assert.ok(ordered.some((row) => /gpt/i.test(row.id)));
    assert.ok(ordered.some((row) => /kimi/i.test(row.id) && /2\.7/i.test(row.id)));
  });
});
