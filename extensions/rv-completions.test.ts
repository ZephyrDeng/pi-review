import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRvCompletions,
  extractSignals,
  fuzzyMatch,
  MODE_HINTS,
  rankModelsForReview,
  tokenizeArgPrefix,
  type ModelInfo,
} from "./rv-completions.js";
import { rvUi } from "./rv-locale.js";
import { DEFAULT_REVIEW_MODEL_PRIORITIES } from "./rv-model-priorities.js";

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

  it("carries primary provider on signals", () => {
    const sig = extractSignals([], { primaryProvider: "anthropic" });
    assert.equal(sig.primaryProvider, "anthropic");
  });
});

describe("rankModelsForReview", () => {
  it("puts preset code models first when registered", () => {
    const sig = extractSignals(["@src/a.ts"], {});
    const ranked = rankModelsForReview(MODELS, sig, DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ranked[0].id, "gpt-5.5");
  });

  it("puts preset plan models first for plan mode", () => {
    const sig = extractSignals(["--mode", "plan"], {});
    const ranked = rankModelsForReview(MODELS, sig, DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ranked[0].id, "claude-opus-4-6");
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
  const deps = {
    models: MODELS,
    primaryProvider: "anthropic",
    priorities: DEFAULT_REVIEW_MODEL_PRIORITIES,
  };

  it("returns dynamic model list after --model, with recommended marker on top items", () => {
    const items = buildRvCompletions("@x.md --model ", deps);
    assert.ok(items, "expected items");
    assert.ok(items!.some((i) => i.label === "openai/gpt-5.5"));
    const top = items!.find((i) => i.description?.includes("Suggested"));
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
    const ui = rvUi("en");
    assert.ok(items);
    assert.ok(items!.some((i) => i.label === ui.listModels));
    assert.ok(items!.some((i) => i.label === ui.codePreset));
    const tmpl = items!.find((i) => i.label === ui.codePreset)!;
    assert.match(tmpl.value, /--model .*@src/);
  });

  it("/rv-loop empty top-level offers loop presets instead of panel keep-session templates", () => {
    const items = buildRvCompletions("", { ...deps, strategy: "loop" });
    assert.ok(items);
    assert.ok(items!.some((i) => /Loop closeout/.test(i.label)));
    assert.ok(!items!.some((i) => /Challenge review \(preset\)/.test(i.label)));
    assert.ok(!items!.some((i) => i.value.includes("--keep-session")));
  });

  it("/rv-loop bare model typing surfaces catalog matches as --model values", () => {
    const items = buildRvCompletions("gpt-5.5", { ...deps, strategy: "loop" });
    assert.ok(items);
    assert.ok(items!.some((i) => i.value.includes("--model") && i.label.includes("gpt-5.5")));
  });

  it("/rv-models does not offer panel scene templates or targets", () => {
    const items = buildRvCompletions("", { ...deps, strategy: "models" });
    assert.ok(items);
    assert.ok(items!.every((i) => /model/i.test(i.label)));
    assert.ok(!items!.some((i) => i.value.includes("@src") || i.value.includes("--model")));
  });

  it("/rv-loop flag completion includes --max-rounds and excludes --keep-session", () => {
    const maxRounds = buildRvCompletions("--max", { ...deps, strategy: "loop" });
    assert.ok(maxRounds?.some((i) => i.label === "--max-rounds"));
    const keep = buildRvCompletions("--keep", { ...deps, strategy: "loop" });
    assert.ok(!keep?.some((i) => i.label === "--keep-session"));
  });

  it("does not duplicate list-models completion at top level", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const prefix of ["", "models", "list", "mod"]) {
        const items = buildRvCompletions(prefix, { ...deps, locale });
        if (!items?.length) continue;
        const ui = rvUi(locale);
        const listModelItems = items.filter((i) => i.label === ui.listModels);
        assert.ok(
          listModelItems.length <= 1,
          `locale=${locale} prefix=${JSON.stringify(prefix)} got ${listModelItems.length} "${ui.listModels}" items`,
        );
      }
    }
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

  it("omits preset scene templates when registry has no preset id match", () => {
    const nonReasoning = [{ ...MODELS[2], thinkingLevels: [] }] as ModelInfo[];
    const items = buildRvCompletions("", { models: nonReasoning, priorities: DEFAULT_REVIEW_MODEL_PRIORITIES });
    assert.ok(items);
    assert.ok(!items!.some((i) => i.label === rvUi("en").codePreset));
    assert.ok(items!.some((i) => i.label === rvUi("en").listModels));
  });

  it("falls back gracefully when models are unavailable (static flags still work)", () => {
    const items = buildRvCompletions("--mode ", {});
    assert.ok(items);
    assert.ok(items!.some((i) => i.label === "code" || i.label === "plan" || i.label === "challenge"));
  });
});
