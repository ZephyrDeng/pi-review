import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { buildReviewerArgs, adjudicatorArgs } from "./panel.js";
import { rulesEnabled, rulesExtensionArgs, rulesExtensionPath } from "./review.js";
import type { Config } from "./config.js";
import type { ParsedArgs } from "./types.js";

// Pin the config path so the machine's real ~/.pi/pi-review/config.json cannot
// flip childExtensions on during argv assertions.
const PINNED_ENV = { PI_REVIEW_CONFIG: "/tmp/pi-review-test-no-such-dir/config.json" } as NodeJS.ProcessEnv;

function parsedArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    mode: "code",
    provider: undefined,
    model: undefined,
    thinking: undefined,
    tools: undefined,
    skills: [],
    ...overrides,
  } as unknown as ParsedArgs;
}

function reviewerArgs(env: NodeJS.ProcessEnv, overrides: Partial<ParsedArgs> = {}): string[] {
  const config = { piBin: "pi" } as Config;
  return buildReviewerArgs(config, parsedArgs(overrides), {}, "review this", [], {}, undefined, "", env);
}

test("rulesExtensionPath resolves the shipped rules extension beside the module", () => {
  const resolved = rulesExtensionPath();
  assert.ok(resolved, "expected a rules-extension file next to review.ts");
  const base = path.basename(resolved);
  assert.ok(base === "rules-extension.js" || base === "rules-extension.ts", `unexpected ${base}`);
});

test("rulesEnabled defaults on and only the documented values disable it", () => {
  assert.equal(rulesEnabled({}, undefined), true);
  assert.equal(rulesEnabled({ PI_REVIEW_RULES: "" }, undefined), true);
  assert.equal(rulesEnabled({ PI_REVIEW_RULES: "1" }, undefined), true);
  assert.equal(rulesEnabled({ PI_REVIEW_RULES: "on" }, undefined), true);
  for (const value of ["0", "false", "off", "no", "FALSE", "Off"]) {
    assert.equal(rulesEnabled({ PI_REVIEW_RULES: value }, undefined), false, value);
  }
  assert.equal(rulesEnabled({}, true), false);
});

test("rulesExtensionArgs emits an explicit --extension after isolation", () => {
  const args = rulesExtensionArgs(PINNED_ENV);
  assert.equal(args[0], "--extension");
  assert.equal(path.basename(args[1]!), "rules-extension.ts");
  assert.deepEqual(rulesExtensionArgs({ ...PINNED_ENV, PI_REVIEW_RULES: "0" }), []);
  assert.deepEqual(rulesExtensionArgs({ ...PINNED_ENV, PI_REVIEW_RULES: "off" }), []);
  assert.deepEqual(rulesExtensionArgs(PINNED_ENV, true), []);
});

test("buildReviewerArgs loads rules explicitly while staying isolated", () => {
  const args = reviewerArgs(PINNED_ENV);
  assert.ok(args.includes("--no-extensions"), args.join(" "));
  assert.ok(args.includes("--extension"), args.join(" "));
  const extensionPath = args[args.indexOf("--extension") + 1]!;
  const base = path.basename(extensionPath);
  assert.ok(base === "rules-extension.js" || base === "rules-extension.ts", base);
  assert.ok(args.indexOf("--no-extensions") < args.indexOf("--extension"));
  assert.ok(args.indexOf("--extension") < args.indexOf("--no-session"));
});

test("buildReviewerArgs drops the rules extension on env or --no-rules opt-out", () => {
  assert.ok(!reviewerArgs({ ...PINNED_ENV, PI_REVIEW_RULES: "0" }).includes("--extension"));
  assert.ok(!reviewerArgs({ ...PINNED_ENV, PI_REVIEW_RULES: "false" }).includes("--extension"));
  assert.ok(!reviewerArgs(PINNED_ENV, { noRules: true }).includes("--extension"));
});

test("adjudicator argv is isolated and never loads the rules extension", () => {
  const args = adjudicatorArgs("openai/gpt-5", "system", "prompt", PINNED_ENV);
  assert.ok(args.includes("--no-extensions"), args.join(" "));
  assert.ok(args.includes("--no-tools"));
  assert.ok(!args.some((arg) => arg.includes("rules-extension")), args.join(" "));
});
