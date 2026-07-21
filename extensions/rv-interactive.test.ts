import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelInfo } from "./rv-completions.js";
import {
  runRvInteractiveWizard,
  shouldRunInteractiveWizard,
  stripInteractiveToken,
  type InteractiveUi,
} from "./rv-interactive.js";
import type { RvParsed } from "./rv-prompts.js";

const models: ModelInfo[] = [
  {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    label: "openai-codex/gpt-5.6-sol",
    name: "sol",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["high", "xhigh"],
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    label: "anthropic/claude-sonnet-4-5",
    name: "sonnet",
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ["high", "xhigh"],
  },
];

// 12 models across 3 providers (5/4/3) — above the MODEL_PICKER_THRESHOLD of 8,
// so the wizard offers provider browse / search / ranked list / skip.
// code-profile presets match claude-sonnet-4-5 and gpt-5.6-luna (ranked first).
const manyModels: ModelInfo[] = [
  // anthropic (5)
  { provider: "anthropic", id: "claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5", name: "sonnet", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "anthropic", id: "claude-opus-4", label: "anthropic/claude-opus-4", name: "opus", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "anthropic", id: "claude-haiku-5", label: "anthropic/claude-haiku-5", name: "haiku", reasoning: false, contextWindow: 200000, thinkingLevels: [] },
  { provider: "anthropic", id: "claude-fable-5", label: "anthropic/claude-fable-5", name: "fable", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "anthropic", id: "claude-solomon", label: "anthropic/claude-solomon", name: "solomon", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  // openai (4)
  { provider: "openai", id: "gpt-5.6-sol", label: "openai/gpt-5.6-sol", name: "sol", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "openai", id: "gpt-5.6-luna", label: "openai/gpt-5.6-luna", name: "luna", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "openai", id: "gpt-5.5", label: "openai/gpt-5.5", name: "gpt55", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "openai", id: "o3", label: "openai/o3", name: "o3", reasoning: true, contextWindow: 200000, thinkingLevels: ["high"] },
  // google (3)
  { provider: "google", id: "gemini-3-pro", label: "google/gemini-3-pro", name: "pro", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "google", id: "gemini-3-flash", label: "google/gemini-3-flash", name: "flash", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "medium"] },
  { provider: "google", id: "gemma-3", label: "google/gemma-3", name: "gemma", reasoning: false, contextWindow: 200000, thinkingLevels: [] },
];

function seed(over: Partial<RvParsed> = {}): RvParsed {
  return {
    strategy: "loop",
    mode: "code",
    keepSession: false,
    noStream: false,
    modelsOnly: false,
    target: "",
    ...over,
  };
}

/** Push this into `selects` to simulate the user pressing Esc on that select step. */
const SELECT_CANCEL = "__cancel__";

function scriptedUi(answers: {
  selects?: string[];
  inputs?: string[];
  confirms?: boolean[];
  customModelPickerResults?: (string | "__skip__" | undefined)[];
}): InteractiveUi & { log: string[]; confirmMessages: string[] } {
  const selects = [...(answers.selects ?? [])];
  const inputs = [...(answers.inputs ?? [])];
  const confirms = [...(answers.confirms ?? [])];
  const pickerResults = [...(answers.customModelPickerResults ?? [])];
  const log: string[] = [];
  const confirmMessages: string[] = [];
  return {
    log,
    confirmMessages,
    async select(title, options) {
      log.push(`select:${title} :: ${options.slice(0, 3).join(" | ")}`);
      const next = selects.length > 0 ? selects.shift() : options[0];
      return next === SELECT_CANCEL ? undefined : next;
    },
    async input(title) {
      log.push(`input:${title}`);
      return inputs.shift() ?? "@src";
    },
    async confirm(title, message) {
      log.push(`confirm:${title}`);
      log.push(message.split("\n")[0] ?? "");
      confirmMessages.push(message);
      return confirms.shift() ?? true;
    },
    notify(message) {
      log.push(`notify:${message}`);
    },
    ...(answers.customModelPickerResults
      ? {
          async customModelPicker(input: { title: string; ranked: unknown[]; allowSkip: boolean }) {
            log.push(`customModelPicker:${input.title} :: ranked=${input.ranked.length} skip=${input.allowSkip}`);
            return pickerResults.shift();
          },
        }
      : {}),
  };
}

test("shouldRunInteractiveWizard triggers on empty or --interactive", () => {
  assert.equal(shouldRunInteractiveWizard("", seed()), true);
  assert.equal(shouldRunInteractiveWizard("interactive", seed()), true);
  assert.equal(shouldRunInteractiveWizard("--interactive @src", seed({ target: "@src" })), true);
  assert.equal(shouldRunInteractiveWizard("-i @src", seed({ target: "@src" })), true);
  assert.equal(shouldRunInteractiveWizard("@src -i", seed({ target: "@src" })), true);
  assert.equal(shouldRunInteractiveWizard("--reviewers 3 @src", seed({ target: "@src", reviewers: 3 })), false);
});

test("stripInteractiveToken removes the trigger token", () => {
  assert.equal(stripInteractiveToken("interactive @src"), "@src");
  assert.equal(stripInteractiveToken("--interactive"), "");
  assert.equal(stripInteractiveToken("@src --interactive"), "@src");
  assert.equal(stripInteractiveToken("-i @src"), "@src");
  assert.equal(stripInteractiveToken("@src -i"), "@src");
  assert.equal(stripInteractiveToken("--reviewers 3 -i @src"), "--reviewers 3 @src");
});

test("wizard chooses mode before asking for a missing natural-language target", async () => {
  const ui = scriptedUi({
    selects: ["plan review (plan)"],
    inputs: ["review the auth design"],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel", reviewers: 1, model: "openai-codex/gpt-5.6-sol" }),
    models,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.mode, "plan");
  assert.equal(result!.target, "review the auth design");
  const modeStep = ui.log.findIndex((entry) => entry === "select:Review mode :: code review (code) | plan review (plan) | challenge review (challenge)");
  const targetStep = ui.log.findIndex((entry) => entry === "input:Review target (natural language or @path)");
  assert.ok(modeStep >= 0 && targetStep >= 0 && modeStep < targetStep, ui.log.join("\n"));
});

test("wizard assigns per-reviewer models through select dialogs", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single gate (fix then re-run /rv-loop) · recommended",
      "1 · host fix point (recommended)",
      "Custom reviewer count 2–8 (r1..rN, pick models)",
      "3",
      "Pick a model for each reviewer",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "anthropic/claude-sonnet-4-5",
      "high",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "quorum · at least min-agree agree (default)",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "loop",
    seed: seed(),
    models,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.target, "@src");
  assert.equal(result!.reviewers, 3);
  assert.equal(result!.maxRounds, 1); // wizard always asks; first option kept
  assert.equal(result!.until, undefined);
  assert.equal(result!.consensus, "quorum");
  assert.equal(result!.minAgree, 2);
  assert.deepEqual(result!.reviewerModels, [
    "r1=openai-codex/gpt-5.6-sol:xhigh",
    "r2=anthropic/claude-sonnet-4-5:high",
    "r3=openai-codex/gpt-5.6-sol:xhigh",
  ]);
  // Confirm summary shows every reviewer's resolved model, not a raw reviewer-models dump.
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /reviewer models: r1=openai-codex\/gpt-5\.6-sol:xhigh, r2=anthropic\/claude-sonnet-4-5:high, r3=openai-codex\/gpt-5\.6-sol:xhigh/);
});

test("wizard keeps an explicit single-reviewer non-panel choice", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Skip (Pi default)",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.reviewers, 1);
  assert.equal(result!.panel, undefined);
  assert.equal(result!.consensus, undefined);
  // Single-reviewer summary keeps the `model:` line and shows the Pi default placeholder.
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /model: Pi default/);
});

test("wizard can use code-experts preset and shared model", async () => {
  const ui = scriptedUi({
    inputs: ["review auth"],
    selects: [
      "code review (code)",
      "Single gate (fix then re-run /rv-loop) · recommended",
      "1 · host fix point (recommended)",
      "Preset code-experts (correctness/security/testing)",
      "Same model for all reviewers",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "quorum · at least min-agree agree (default)",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "loop",
    seed: seed(),
    models,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.panel, "code-experts");
  assert.deepEqual(result!.reviewerModels, [
    "correctness=openai-codex/gpt-5.6-sol:xhigh",
    "security=openai-codex/gpt-5.6-sol:xhigh",
    "testing=openai-codex/gpt-5.6-sol:xhigh",
  ]);
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /reviewer models: correctness=openai-codex\/gpt-5\.6-sol:xhigh, security=openai-codex\/gpt-5\.6-sol:xhigh, testing=openai-codex\/gpt-5\.6-sol:xhigh/);
});

test("wizard can skip model assignment and use Pi's default model for every reviewer", async () => {
  const ui = scriptedUi({
    inputs: ["review auth"],
    selects: [
      "code review (code)",
      "Single gate (fix then re-run /rv-loop) · recommended",
      "1 · host fix point (recommended)",
      "Preset code-experts (correctness/security/testing)",
      "Use Pi's default model (resolved at runtime)",
      "quorum · at least min-agree agree (default)",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "loop",
    seed: seed(),
    models,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.panel, "code-experts");
  // No per-reviewer overrides and no shared --model: every reviewer resolves at runtime.
  assert.equal(result!.reviewerModels, undefined);
  assert.equal(result!.model, undefined);
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /reviewer models: correctness=Pi default, security=Pi default, testing=Pi default/);
});

test("wizard cancels when the user escapes the model-assignment select", async () => {
  const ui = scriptedUi({
    inputs: ["review auth"],
    selects: [
      "code review (code)",
      "Single gate (fix then re-run /rv-loop) · recommended",
      "1 · host fix point (recommended)",
      "Preset code-experts (correctness/security/testing)",
      SELECT_CANCEL,
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "loop",
    seed: seed(),
    models,
    locale: "en",
  });

  assert.equal(result, undefined);
});

test("wizard can select until-clean with a hard budget", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "until clean · review→fix→re-review until clean (hard budget)",
      "10 · default",
      "Preset code-experts (correctness/security/testing)",
      "Same model for all reviewers",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "quorum · at least min-agree agree (default)",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "loop",
    seed: seed(),
    models,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.until, "clean");
  assert.equal(result!.maxRounds, 10);
  assert.equal(result!.panel, "code-experts");
});

// --- Model picker with a large catalog (> MODEL_PICKER_THRESHOLD) ---
// These exercise the provider browse / search / ranked-list / skip chooser that
// replaces the old flat `labels.slice(0, 40)` list. With <= 8 models the wizard
// still uses the flat list (covered by the tests above with the 2-model fixture).

test("wizard model picker browses by provider for a large catalog", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Browse by provider (arrows switch provider, enter drills in)",
      "▸ anthropic (5)",
      "anthropic/claude-sonnet-4-5",
      "xhigh",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.reviewers, 1);
  assert.equal(result!.panel, undefined);
  assert.equal(result!.model, "anthropic/claude-sonnet-4-5");
  assert.equal(result!.thinking, "xhigh");
  // The provider picker was actually visited.
  assert.ok(ui.log.some((e) => e.startsWith("select:Model · pick provider")), ui.log.join("\n"));
});

test("wizard model picker can switch providers via the back entry", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Browse by provider (arrows switch provider, enter drills in)",
      "▸ anthropic (5)",
      "← Switch provider",
      "  openai (4)",
      "openai/gpt-5.6-luna",
      "xhigh",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, "openai/gpt-5.6-luna");
  assert.equal(result!.thinking, "xhigh");
  // Provider list was shown twice (initial + after switching back).
  const providerPicks = ui.log.filter((e) => e.startsWith("select:Model · pick provider"));
  assert.equal(providerPicks.length, 2, ui.log.join("\n"));
});

test("wizard model picker searches by keyword", async () => {
  const ui = scriptedUi({
    inputs: ["@src", "claude"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Search models (type a provider or model keyword)",
      "anthropic/claude-opus-4",
      "high",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, "anthropic/claude-opus-4");
  assert.equal(result!.thinking, "high");
  assert.ok(ui.log.some((e) => e.startsWith("input:Model · search")), ui.log.join("\n"));
  assert.ok(ui.log.some((e) => e.startsWith("select:Model · results (5)")), ui.log.join("\n"));
});

test("wizard model picker re-prompts when a search has no matches", async () => {
  const ui = scriptedUi({
    inputs: ["@src", "zzz", "claude"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Search models (type a provider or model keyword)",
      "anthropic/claude-sonnet-4-5",
      "xhigh",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, "anthropic/claude-sonnet-4-5");
  assert.ok(ui.log.some((e) => e.includes(`No models match "zzz"`)), ui.log.join("\n"));
  // Search input was called twice (first miss + retry).
  const searchInputs = ui.log.filter((e) => e.startsWith("input:Model · search"));
  assert.equal(searchInputs.length, 2, ui.log.join("\n"));
});

test("wizard model picker can use the full ranked list", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Ranked list (all models)",
      "openai/gpt-5.6-luna",
      "xhigh",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, "openai/gpt-5.6-luna");
  assert.equal(result!.thinking, "xhigh");
});

test("wizard model picker supports skip for a large catalog", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      "Skip (Pi default)",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, undefined);
  assert.equal(result!.thinking, undefined);
});

// --- Inline searchable model picker (custom component, TUI path) ---
// When the host provides `customModelPicker`, the wizard uses the inline
// searchable picker for every catalog size (it supersedes the select-based
// flow). These tests stub `customModelPicker` and verify the wizard maps its
// result to model / skip / cancel correctly.

test("inline picker: chosen label sets model + thinking", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
      // thinking select still happens after the picker resolves to a label
      "xhigh",
    ],
    confirms: [true],
    customModelPickerResults: ["anthropic/claude-sonnet-4-5"],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, "anthropic/claude-sonnet-4-5");
  assert.equal(result!.thinking, "xhigh");
  assert.ok(ui.log.some((e) => e.startsWith("customModelPicker:Model ")), ui.log.join("\n"));
});

test("inline picker: skip sentinel leaves model unset", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
    ],
    confirms: [true],
    customModelPickerResults: ["__skip__"],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.equal(result!.model, undefined);
  assert.equal(result!.thinking, undefined);
});

test("inline picker: cancel (undefined) cancels the whole wizard", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single reviewer non-panel (no consensus; shell single review)",
    ],
    confirms: [true],
    customModelPickerResults: [undefined],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models: manyModels,
    locale: "en",
  });

  assert.equal(result, undefined);
});

test("inline picker: per-reviewer models resolve through repeated picker calls", async () => {
  const uiPanel = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single gate (fix then re-run /rv-loop) · recommended",
      "1 · host fix point (recommended)",
      "Custom reviewer count 2–8 (r1..rN, pick models)",
      "3",
      "Pick a model for each reviewer",
      // thinking selects for r1, r2, r3
      "xhigh",
      "high",
      "xhigh",
      "quorum · at least min-agree agree (default)",
      "2",
    ],
    confirms: [true],
    customModelPickerResults: [
      "openai/gpt-5.6-luna",
      "anthropic/claude-opus-4",
      "google/gemini-3-pro",
    ],
  });

  const result = await runRvInteractiveWizard(uiPanel, {
    strategy: "loop",
    seed: seed(),
    models: manyModels,
    locale: "en",
  });

  assert.ok(result);
  assert.deepEqual(result!.reviewerModels, [
    "r1=openai/gpt-5.6-luna:xhigh",
    "r2=anthropic/claude-opus-4:high",
    "r3=google/gemini-3-pro:xhigh",
  ]);
  // The picker was invoked once per reviewer.
  const pickerCalls = uiPanel.log.filter((e) => e.startsWith("customModelPicker:"));
  assert.equal(pickerCalls.length, 3, uiPanel.log.join("\n"));
});

test("wizard (zh) per-reviewer branch routes on the exact zh option label", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "代码审查 (code)",
      "预设 code-experts（正确性/安全/测试）",
      "每位 reviewer 分别选择模型",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "anthropic/claude-sonnet-4-5",
      "high",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "quorum · 至少 min-agree 人同意（默认）",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models,
    locale: "zh",
  });

  assert.ok(result);
  assert.equal(result!.panel, "code-experts");
  assert.deepEqual(result!.reviewerModels, [
    "correctness=openai-codex/gpt-5.6-sol:xhigh",
    "security=anthropic/claude-sonnet-4-5:high",
    "testing=openai-codex/gpt-5.6-sol:xhigh",
  ]);
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /reviewer 模型: correctness=openai-codex\/gpt-5\.6-sol:xhigh, security=anthropic\/claude-sonnet-4-5:high, testing=openai-codex\/gpt-5\.6-sol:xhigh/);
});

test("wizard (zh) Pi-default branch skips model prompts and shows the zh placeholder per reviewer", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "代码审查 (code)",
      "预设 code-experts（正确性/安全/测试）",
      "使用 Pi 默认模型（运行时解析实际模型）",
      "quorum · 至少 min-agree 人同意（默认）",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models,
    locale: "zh",
  });

  assert.ok(result);
  assert.equal(result!.panel, "code-experts");
  assert.equal(result!.reviewerModels, undefined);
  assert.equal(result!.model, undefined);
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /reviewer 模型: correctness=Pi 默认, security=Pi 默认, testing=Pi 默认/);
  // No model picker step ran: the wizard never offered a model list select.
  assert.ok(!ui.log.some((entry) => entry.startsWith("select:共用模型") || entry.startsWith("select:模型 · ")), ui.log.join("\n"));
});

test("wizard (zh) shared-model branch writes the same token for every reviewer id", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "代码审查 (code)",
      "预设 code-experts（正确性/安全/测试）",
      "所有 reviewer 使用同一模型",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "quorum · 至少 min-agree 人同意（默认）",
      "2",
    ],
    confirms: [true],
  });

  const result = await runRvInteractiveWizard(ui, {
    strategy: "panel",
    seed: seed({ strategy: "panel" }),
    models,
    locale: "zh",
  });

  assert.ok(result);
  assert.equal(result!.panel, "code-experts");
  assert.deepEqual(result!.reviewerModels, [
    "correctness=openai-codex/gpt-5.6-sol:xhigh",
    "security=openai-codex/gpt-5.6-sol:xhigh",
    "testing=openai-codex/gpt-5.6-sol:xhigh",
  ]);
  const summary = ui.confirmMessages.at(-1) ?? "";
  assert.match(summary, /reviewer 模型: correctness=openai-codex\/gpt-5\.6-sol:xhigh, security=openai-codex\/gpt-5\.6-sol:xhigh, testing=openai-codex\/gpt-5\.6-sol:xhigh/);
  // The shared-model picker (zh title) actually ran.
  assert.ok(ui.log.some((entry) => entry.startsWith("select:共用模型")), ui.log.join("\n"));
});
