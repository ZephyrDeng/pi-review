import assert from "node:assert/strict";
import { test } from "node:test";
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

function scriptedUi(answers: {
  selects?: string[];
  inputs?: string[];
  confirms?: boolean[];
}): InteractiveUi & { log: string[] } {
  const selects = [...(answers.selects ?? [])];
  const inputs = [...(answers.inputs ?? [])];
  const confirms = [...(answers.confirms ?? [])];
  const log: string[] = [];
  return {
    log,
    async select(title, options) {
      log.push(`select:${title} :: ${options.slice(0, 3).join(" | ")}`);
      return selects.shift() ?? options[0];
    },
    async input(title) {
      log.push(`input:${title}`);
      return inputs.shift() ?? "@src";
    },
    async confirm(title, message) {
      log.push(`confirm:${title}`);
      log.push(message.split("\n")[0] ?? "");
      return confirms.shift() ?? true;
    },
    notify(message) {
      log.push(`notify:${message}`);
    },
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

test("wizard assigns per-reviewer models through select dialogs", async () => {
  const ui = scriptedUi({
    inputs: ["@src"],
    selects: [
      "code review (code)",
      "Single gate (fix then re-run /rv-loop) · recommended",
      "1 · host fix point (recommended)",
      "Custom reviewer count 2–8 (r1..rN, pick models)",
      "3",
      "Pick separately for each reviewer",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "anthropic/claude-sonnet-4-5",
      "high",
      "openai-codex/gpt-5.6-sol",
      "xhigh",
      "quorum · at least min-agree agree (default)",
      "2",
    ],
    confirms: [true, true],
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
    confirms: [true, true],
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
    confirms: [true, true],
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
