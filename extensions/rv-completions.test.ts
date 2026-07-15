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
import { parseRvArgs, validateRvParsed } from "./rv-prompts.js";

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
  model({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, contextWindow: 400_000, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] }),
  model({ provider: "openai-codex", id: "gpt-5.6-terra", reasoning: true, contextWindow: 400_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh"] }),
  model({ provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true, contextWindow: 400_000, thinkingLevels: ["high", "xhigh"] }),
  model({ provider: "anthropic", id: "claude-opus-4-8", reasoning: true, contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh"] }),
  model({ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true, contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh"] }),
  model({ provider: "anthropic", id: "claude-fable-5", reasoning: true, contextWindow: 200_000, thinkingLevels: ["high", "xhigh"] }),
  model({ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true, contextWindow: 200_000, thinkingLevels: ["high", "xhigh"] }),
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
  it("puts fast-review models first for code presets", () => {
    const sig = extractSignals(["@src/a.ts"], {});
    const ranked = rankModelsForReview(MODELS, sig, DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ranked[0].id, "claude-sonnet-4-5");
  });

  it("puts complex/plan models first for plan mode", () => {
    const sig = extractSignals(["--mode", "plan"], {});
    const ranked = rankModelsForReview(MODELS, sig, DEFAULT_REVIEW_MODEL_PRIORITIES);
    assert.equal(ranked[0].id, "gpt-5.6-sol");
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
    const items = buildRvCompletions("--model openai-codex/gpt-5.6-sol:", deps);
    assert.ok(items);
    const labels = items!.map((i) => i.label);
    assert.ok(labels.includes("high"));
    assert.ok(labels.includes("xhigh"));
    assert.ok(items!.every((i) => i.value.startsWith("--model openai-codex/gpt-5.6-sol:")));
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

  it("empty top-level stays quiet: flags/hints, no preset wall", () => {
    const items = buildRvCompletions("", deps);
    const ui = rvUi("en");
    assert.ok(items);
    assert.ok(items!.some((i) => i.value === "-i" || i.label.includes("interactive")));
    assert.ok(items!.some((i) => i.label === ui.presetHint));
    assert.ok(!items!.some((i) => i.label === ui.codePreset));
  });

  it("-i / --interactive complete to the wizard trigger, not the flag soup", () => {
    for (const prefix of ["-i", "--interactive", "-"]) {
      const items = buildRvCompletions(prefix, { ...deps, strategy: "loop" });
      assert.ok(items?.some((i) => i.value === "-i" || i.value === "--interactive"), prefix);
      assert.ok(!items?.some((i) => i.label === "--max-rounds 1" || i.value.startsWith("--max-rounds 1")), prefix);
    }
  });

  it("presets appear only when the user asks for them", () => {
    const ui = rvUi("en");
    const quiet = buildRvCompletions("gpt", deps);
    assert.ok(!quiet?.some((i) => i.label === ui.codePreset));
    const asked = buildRvCompletions("preset", deps);
    assert.ok(asked?.some((i) => i.label === ui.codePreset), `got ${asked?.map((i) => i.label).join(",")}`);
    const zh = buildRvCompletions("预设", { ...deps, locale: "zh" });
    assert.ok(zh?.some((i) => i.label === rvUi("zh").codePreset), `got ${zh?.map((i) => i.label).join(",")}`);
  });

  it("/rv-loop empty top-level stays quiet; loop presets need explicit request", () => {
    const empty = buildRvCompletions("", { ...deps, strategy: "loop" });
    assert.ok(empty);
    assert.ok(!empty!.some((i) => /Loop closeout|关单/.test(i.label)));
    assert.ok(!empty!.some((i) => i.value.includes("--keep-session")));
    const asked = buildRvCompletions("preset", { ...deps, strategy: "loop" });
    assert.ok(asked?.some((i) => /Loop closeout/.test(i.label)));
  });

  it("Chinese locale labels are used when locale=zh", () => {
    const items = buildRvCompletions("预设", { ...deps, locale: "zh" });
    const ui = rvUi("zh");
    assert.ok(items?.some((i) => i.label === ui.codePreset));
    assert.ok(items?.some((i) => i.description?.includes("--model")));
  });

  it("/rv-loop bare model typing surfaces catalog matches as --model values", () => {
    const items = buildRvCompletions("gpt-5.6-sol", { ...deps, strategy: "loop" });
    assert.ok(items);
    assert.ok(items!.some((i) => i.value.includes("--model") && i.label.includes("gpt-5.6-sol")));
  });

  it("/rv-loop accepts full provider/model and offers thinking suffixes", () => {
    const items = buildRvCompletions("openai-codex/gpt-5.6-sol", { ...deps, strategy: "loop" });
    assert.ok(items);
    assert.ok(items!.some((i) => i.value === "--model openai-codex/gpt-5.6-sol"));
    assert.ok(items!.some((i) => i.value.startsWith("--model openai-codex/gpt-5.6-sol:")));
  });

  it("/rv-loop provider fragment still surfaces models", () => {
    const items = buildRvCompletions("openai-codex", { ...deps, strategy: "loop" });
    assert.ok(items);
    assert.ok(items!.some((i) => i.label.includes("openai-codex/") || i.value.includes("openai-codex/")));
  });

  it("/rv-models does not offer panel scene templates or targets", () => {
    const items = buildRvCompletions("", { ...deps, strategy: "models" });
    assert.ok(items);
    assert.ok(items!.every((i) => /model/i.test(i.label)));
    assert.ok(!items!.some((i) => i.value.includes("@src") || i.value.includes("--model")));
  });

  it("/rv-models completion never clears an already-entered prefix", () => {
    for (const prefix of ["unexpected target ", "unexpected target mod"]) {
      const items = buildRvCompletions(prefix, { models: [], strategy: "models" });
      assert.ok(items, prefix);
      assert.ok(items!.every((item) => item.value.startsWith(prefix)), prefix);
    }
  });

  it("multi-word semantic completion replaces its typed phrase suffix without duplicating it", () => {
    for (const prefix of ["@src code r", "@src code rev"]) {
      const items = buildRvCompletions(prefix, { ...deps, strategy: "panel", locale: "en" });
      const codeReview = items?.find((item) => item.label === "code review");
      assert.ok(codeReview, prefix);
      assert.equal(codeReview!.value, "@src code review");
      assert.doesNotMatch(codeReview!.value, /code code review/);
    }
  });

  it("/rv-loop flag completion includes --max-rounds and excludes --keep-session", () => {
    const maxRounds = buildRvCompletions("--max", { ...deps, strategy: "loop" });
    assert.ok(maxRounds?.some((i) => i.label === "--max-rounds"));
    const keep = buildRvCompletions("--keep", { ...deps, strategy: "loop" });
    assert.ok(!keep?.some((i) => i.label === "--keep-session"));
  });

  it("/rv-loop completes --reviewers values and panel strategy flags", () => {
    const flags = buildRvCompletions("--rev", { ...deps, strategy: "loop" });
    assert.ok(flags?.some((i) => i.label === "--reviewers"), `got ${flags?.map((i) => i.label)}`);
    const values = buildRvCompletions("--reviewers ", { ...deps, strategy: "loop" });
    assert.ok(values?.some((i) => i.label === "3"));
    const consensus = buildRvCompletions("--consensus ", { ...deps, strategy: "loop" });
    assert.ok(consensus?.some((i) => i.label === "quorum"));
    const panel = buildRvCompletions("--panel ", { ...deps, strategy: "loop" });
    assert.ok(panel?.some((i) => i.label === "code-experts"));
  });

  it("offers an explicit target boundary after completed flags so target text can be entered last", () => {
    const prefix = "--mode plan --panel code-experts ";
    const items = buildRvCompletions(prefix, { ...deps, strategy: "panel", locale: "en" });
    const boundary = items?.find((item) => item.label === "Start review target");
    assert.ok(boundary, `got ${items?.map((item) => item.label).join(", ")}`);
    assert.equal(boundary!.value, "--mode plan --panel code-experts -- ");

    const parsed = parseRvArgs(`${boundary!.value}code review the auth changes under @src`);
    assert.equal(parsed.mode, "plan");
    assert.equal(parsed.panel, "code-experts");
    assert.equal(parsed.target, "code review the auth changes under @src");
    assert.deepEqual(validateRvParsed(parsed), { ok: true });
  });

  it("hides --panel after --reviewers and vice versa", () => {
    const afterReviewers = buildRvCompletions("--reviewers 3 --p", { ...deps, strategy: "loop" });
    assert.ok(!afterReviewers?.some((i) => i.label === "--panel"));
    const afterPanel = buildRvCompletions("--panel code-experts --r", { ...deps, strategy: "loop" });
    assert.ok(!afterPanel?.some((i) => i.label === "--reviewers"));
  });

  it("--reviewer-model offers cascading id then model menus based on --reviewers count", () => {
    const ids = buildRvCompletions("--reviewers 3 --reviewer-model ", { ...deps, strategy: "loop" });
    assert.deepEqual(ids?.map((i) => i.label).sort(), ["r1=", "r2=", "r3="].sort());

    const models = buildRvCompletions("--reviewers 3 --reviewer-model r1=", { ...deps, strategy: "loop" });
    assert.ok(models?.some((i) => i.label.startsWith("r1=") && i.label.includes("/")), `got ${models?.map((i) => i.label)}`);

    const afterOne = buildRvCompletions(
      "--reviewers 2 --reviewer-model r1=openai-codex/gpt-5.6-sol --reviewer-model ",
      { ...deps, strategy: "loop" },
    );
    assert.ok(afterOne?.some((i) => i.label === "r2="));
    assert.ok(!afterOne?.some((i) => i.label === "r1="));
  });

  it("--reviewer-model with --panel code-experts uses role ids", () => {
    const ids = buildRvCompletions("--panel code-experts --reviewer-model ", { ...deps, strategy: "panel" });
    assert.ok(ids?.some((i) => i.label === "security="));
    assert.ok(ids?.some((i) => i.label === "correctness="));
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
    // Only a non-matching flash model: none of the code/plan/frontend preset needles hit.
    const nonMatching = [
      model({ provider: "zenmux", id: "gemini-3-flash", reasoning: false, contextWindow: 1_000_000, thinkingLevels: [] }),
    ];
    const empty = buildRvCompletions("", { models: nonMatching, priorities: DEFAULT_REVIEW_MODEL_PRIORITIES });
    assert.ok(empty);
    assert.ok(!empty!.some((i) => i.label === rvUi("en").codePreset));
    const asked = buildRvCompletions("preset", { models: nonMatching, priorities: DEFAULT_REVIEW_MODEL_PRIORITIES });
    assert.ok(!asked?.some((i) => i.label === rvUi("en").codePreset));
  });

  it("falls back gracefully when models are unavailable (static flags still work)", () => {
    const items = buildRvCompletions("--mode ", {});
    assert.ok(items);
    assert.ok(items!.some((i) => i.label === "code" || i.label === "plan" || i.label === "challenge"));
  });

  it("preserves entered targets when the model catalog is unavailable", () => {
    const valuePosition = buildRvCompletions("@src --model ", { models: [], strategy: "panel" });
    assert.ok(valuePosition);
    assert.ok(valuePosition!.every((item) => item.value.startsWith("@src --model ")));

    const bareModel = buildRvCompletions("@src gpt-5.6", { models: [], strategy: "panel" });
    assert.ok(bareModel);
    assert.ok(bareModel!.some((item) => item.value === "@src --model gpt-5.6"));
    assert.ok(bareModel!.every((item) => item.value.startsWith("@src ")));
  });
});
