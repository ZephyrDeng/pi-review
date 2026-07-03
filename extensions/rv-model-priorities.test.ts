import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    m("openai", "gpt-5.5"),
    m("zhipu", "glm-5.2-chat"),
    m("moonshot", "kimi-k2.7-preview"),
    m("moonshot", "kimi-k2.5"),
    m("anthropic", "claude-opus-4-8"),
    m("anthropic", "claude-opus-4-6"),
    m("deepseek", "deepseek-v4-pro"),
  ];

  it("picks newest kimi when versionPrefer 2.7", () => {
    const entry: PresetModelEntry = { idContains: "kimi", versionPrefer: "2.7" };
    const hit = matchPresetEntry(registry, entry);
    assert.ok(hit);
    assert.match(hit!.id, /2\.7|k2\.7/i);
  });

  it("ranks gpt-5.5 first for code presets", () => {
    const ordered = rankModelsWithPresets(registry, "code", DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ordered[0].id, "gpt-5.5");
    assert.equal(ordered[1].id, "glm-5.2-chat");
  });

  it("ranks claude-opus-4-8 before older opus for plan", () => {
    const ordered = rankModelsWithPresets(registry, "plan", DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ordered[0].id, "claude-opus-4-8");
  });
});