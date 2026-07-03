import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRvCompletions,
  extractSignals,
  fuzzyMatch,
  MODE_HINTS,
  rankModelsForReview,
  scoreModelForReview,
  tokenizeArgPrefix,
  type ModelInfo,
} from "./rv-completions.js";

function model(partial: Partial<ModelInfo> & Pick<ModelInfo, "provider" | "id">): ModelInfo {
  return {
    label: `${partial.provider}/${partial.id}`,
    name: partial.id,
    reasoning: false,
    contextWindow: 200_000,
    thinkingLevels: ["off", "low", "medium", "high"],
    ...partial,
  };
}

const MODELS: ModelInfo[] = [
  model({ provider: "anthropic", id: "claude-opus-4-6", reasoning: true, contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh"] }),
  model({ provider: "openai", id: "gpt-5.5", reasoning: true, contextWindow: 400_000, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] }),
  model({ provider: "zenmux", id: "gemini-3-flash", reasoning: false, contextWindow: 1_000_000, thinkingLevels: [] }),
];

describe("tokenizeArgPrefix", () => {
  it("splits head and tail on the last space", () => {
    const t = tokenizeArgPrefix("@src/foo.ts --model ope");
    assert.deepEqual(t.head, ["@src/foo.ts", "--model"]);
    assert.equal(t.tail, "ope");
    assert.equal(t.prev, "--model");
  });

  it("treats a single token as tail with empty head", () => {
    const t = tokenizeArgPrefix("--mode");
    assert.deepEqual(t.head, []);
    assert.equal(t.tail, "--mode");
    assert.equal(t.prev, null);
  });

  it("handles trailing space as empty tail", () => {
    const t = tokenizeArgPrefix("@a.ts ");
    assert.deepEqual(t.head, ["@a.ts"]);
    assert.equal(t.tail, "");
    assert.equal(t.prev, "@a.ts");
  });

  it("strips surrounding quotes in head tokens", () => {
    const t = tokenizeArgPrefix('"@a b.ts" --mode ');
    assert.deepEqual(t.head, ["@a b.ts", "--mode"]);
    assert.deepEqual(t.rawHead, ['"@a b.ts"', "--mode"]);
    assert.equal(t.prev, "--mode");
  });
});

describe("extractSignals", () => {
  it("detects target extension and explicit mode", () => {
    const sig = extractSignals(["@docs/design.md", "--mode", "plan"], {});
    assert.equal(sig.mode, "plan");
    assert.equal(sig.targetExt, "md");
    assert.equal(sig.hasTarget, true);
  });

  it("defaults mode to code", () => {
    const sig = extractSignals(["@src/foo.ts"], {});
    assert.equal(sig.mode, "code");
    assert.equal(sig.targetExt, "ts");
  });

  it("carries primary provider for cross-vendor bonus", () => {
    const sig = extractSignals([], { primaryProvider: "anthropic" });
    assert.equal(sig.primaryProvider, "anthropic");
  });
});

describe("scoreModelForReview / rankModelsForReview", () => {
  it("scores reasoning + cross-vendor + xhigh higher than a cheap non-reasoning model", () => {
    const sig = { mode: "challenge", hasTarget: true, targetExt: "md", primaryProvider: "anthropic" };
    const opus = scoreModelForReview(MODELS[0], sig);
    const gpt = scoreModelForReview(MODELS[1], sig);
    const flash = scoreModelForReview(MODELS[2], sig);
    assert.ok(gpt.score > opus.score, `gpt (${gpt.score}) should beat opus (${opus.score}) for challenge+cross-vendor`);
    assert.ok(opus.score > flash.score, "opus should beat the non-reasoning flash");
    assert.ok(flash.score >= 2, "flash still gets context-window points");
  });

  it("ranks descending by score", () => {
    const sig = { mode: "plan", hasTarget: false, primaryProvider: "anthropic" };
    const ranked = rankModelsForReview(MODELS, sig);
    assert.equal(ranked[0].id, "gpt-5.5");
    assert.equal(ranked[ranked.length - 1].id, "gemini-3-flash");
  });
});

describe("fuzzyMatch", () => {
  it("matches subsequence case-insensitively", () => {
    assert.equal(fuzzyMatch("anthropic/claude-opus-4-6", "aclaude"), true);
    assert.equal(fuzzyMatch("Anthropic/Claude", "acl"), true);
    assert.equal(fuzzyMatch("openai/gpt-5.5", "zzz"), false);
  });
});

describe("buildRvCompletions", () => {
  const deps = { models: MODELS, primaryProvider: "anthropic" };

  it("returns dynamic model list after --model, with recommended marker on top items", () => {
    const items = buildRvCompletions("@x.md --model ", deps);
    assert.ok(items, "expected items");
    assert.ok(items!.some((i) => i.label === "openai/gpt-5.5"));
    const top = items!.find((i) => i.description?.includes("★ 推荐"));
    assert.ok(top, "expected at least one recommended item");
    // value carries the head so applyCompletion replaces the whole arg safely
    assert.ok(top!.value.startsWith("@x.md --model "));
  });

  it("filters models by a partial query", () => {
    const items = buildRvCompletions("--model ope", deps);
    assert.ok(items);
    assert.ok(items!.every((i) => i.label.includes("openai")));
  });

  it("completes thinking suffix after provider/id: for a reasoning model", () => {
    const items = buildRvCompletions("--model openai/gpt-5.5:", deps);
    assert.ok(items);
    const labels = items!.map((i) => i.label);
    assert.ok(labels.includes("high"));
    assert.ok(labels.includes("xhigh"));
    assert.ok(items!.every((i) => i.value.startsWith("--model openai/gpt-5.5:")));
  });

  it("does not offer thinking suffix for a non-reasoning model", () => {
    const items = buildRvCompletions("--model zenmux/gemini-3-flash:", deps);
    // flash has empty thinkingLevels → no suffix candidates
    assert.equal(items, null);
  });

  it("completes --mode values with hints", () => {
    const items = buildRvCompletions("--mode pl", deps);
    assert.ok(items);
    assert.deepEqual(items!.map((i) => i.label), ["plan"]);
    assert.equal(items![0].description, MODE_HINTS["plan"]);
  });

  it("completes --thinking levels", () => {
    const items = buildRvCompletions("--thinking h", deps);
    assert.ok(items);
    assert.deepEqual(items!.map((i) => i.label).sort(), ["high"]);
  });

  it("completes flags when tail starts with --", () => {
    const items = buildRvCompletions("--keep", deps);
    assert.ok(items);
    assert.deepEqual(items!.map((i) => i.label), ["--keep-session"]);
    assert.ok(items![0].value === "--keep-session");
  });

  it("defers to built-in file completion when tail starts with @", () => {
    assert.equal(buildRvCompletions("@src/foo", deps), null);
  });

  it("defers --continue value to the handler (no static list)", () => {
    assert.equal(buildRvCompletions("--continue abc", deps), null);
  });

  it("offers scene templates + models keyword at empty top level", () => {
    const items = buildRvCompletions("", deps);
    assert.ok(items);
    assert.ok(items!.some((i) => i.label === "models"));
    assert.ok(items!.some((i) => i.label.startsWith("审代码改动")));
    // template values end with " @" so the user can keep typing a path
    const tmpl = items!.find((i) => i.label.startsWith("审代码改动"))!;
    assert.ok(tmpl.value.endsWith(" @"));
  });

  it("every returned value preserves the head prefix (整段替换安全)", () => {
    const cases = ["@a.ts --mode ", "@a.ts --model ", "@a.ts --thinking ", "@a.ts --"];
    for (const c of cases) {
      const items = buildRvCompletions(c, deps);
      if (!items) continue;
      for (const it of items) {
        assert.ok(
          it.value.startsWith(c),
          `value "${it.value}" must preserve head "${c}"`,
        );
      }
    }
  });

  it("preserves quotes in headPrefix for paths with spaces (note #2 fix)", () => {
    const items = buildRvCompletions('"@a b.ts" --model ', deps);
    assert.ok(items);
    for (const it of items) {
      assert.ok(
        it.value.startsWith('"@a b.ts" --model '),
        `value "${it.value}" must preserve quoted head`,
      );
    }
  });

  it("scene templates omit the thinking colon for non-reasoning models (note #1 fix)", () => {
    const nonReasoning = [{ ...MODELS[2], thinkingLevels: [] }] as ModelInfo[];
    const items = buildRvCompletions("", { models: nonReasoning });
    assert.ok(items);
    const tmpl = items!.find((i) => i.label.startsWith("审代码改动"));
    assert.ok(tmpl, "expected a scene template even for non-reasoning models");
    // Must NOT contain a dangling colon like `gemini-3-flash: @`
    assert.doesNotMatch(tmpl!.value, /flash:\s@/);
    assert.match(tmpl!.value, /flash @/);
  });

  it("falls back gracefully when models are unavailable (static flags still work)", () => {
    const items = buildRvCompletions("--mode ", {});
    assert.ok(items);
    assert.ok(items!.some((i) => i.label === "code" || i.label === "plan" || i.label === "challenge"));
  });
});
