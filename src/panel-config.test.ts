import assert from "node:assert/strict";
import { test } from "node:test";
import { ArgsParseError } from "./args.js";
import { resolvePanelConfig } from "./panel-config.js";
import type { PanelPreset, ParsedArgs } from "./types.js";

function baseParsed(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "review",
    mode: "code",
    skills: [],
    payload: ["@src"],
    keepSession: false,
    stream: true,
    ...overrides,
  };
}

const codeExperts: PanelPreset = {
  description: "Code expert panel",
  reviewers: [
    { id: "correctness", role: "Correctness reviewer" },
    { id: "security", role: "Security reviewer" },
    { id: "testing", role: "Testing reviewer" },
  ],
};

test("generic panel builds N anonymous reviewers with default quorum two", () => {
  const resolved = resolvePanelConfig(baseParsed({ reviewers: 3 }), {});
  assert.equal(resolved.presetName, undefined);
  assert.equal(resolved.reviewerCount, 3);
  assert.deepEqual(resolved.reviewers.map((r) => r.id), ["r1", "r2", "r3"]);
  assert.equal(resolved.consensus, "quorum");
  assert.equal(resolved.minAgree, 2);
  assert.equal(resolved.concurrency, 3);
  assert.equal(resolved.semanticEnabled, false);
});

test("generic panel respects explicit consensus and min-agree", () => {
  const resolved = resolvePanelConfig(baseParsed({ reviewers: 5, consensus: "majority" }), {});
  assert.equal(resolved.consensus, "majority");
  assert.equal(resolved.minAgree, undefined);
});

test("named panel uses preset reviewers and defaults", () => {
  const resolved = resolvePanelConfig(baseParsed({ panel: "code-experts" }), { "code-experts": codeExperts });
  assert.equal(resolved.presetName, "code-experts");
  assert.equal(resolved.reviewerCount, 3);
  assert.deepEqual(resolved.reviewers.map((r) => r.id), ["correctness", "security", "testing"]);
  assert.equal(resolved.consensus, "quorum");
  assert.equal(resolved.minAgree, 2);
});

test("named panel allows CLI consensus to override preset defaults", () => {
  const resolved = resolvePanelConfig(
    baseParsed({ panel: "code-experts", consensus: "majority" }),
    { "code-experts": codeExperts },
  );
  assert.equal(resolved.consensus, "majority");
  assert.equal(resolved.minAgree, undefined);
});

test("named panel allows CLI min-agree to override preset default under quorum", () => {
  const resolved = resolvePanelConfig(
    baseParsed({ panel: "code-experts", consensus: "quorum", minAgree: 3 }),
    { "code-experts": codeExperts },
  );
  assert.equal(resolved.consensus, "quorum");
  assert.equal(resolved.minAgree, 3);
});

test("named panel can enable semantic adjudication via consensusModel", () => {
  const resolved = resolvePanelConfig(
    baseParsed({ panel: "code-experts", consensusModel: "openai/gpt-5.5" }),
    { "code-experts": codeExperts },
  );
  assert.equal(resolved.semanticEnabled, true);
  assert.equal(resolved.consensusModel, "openai/gpt-5.5");
});

function expectUsage(parsed: Partial<ParsedArgs>, presets: Record<string, PanelPreset>, pattern: RegExp): void {
  assert.throws(
    () => resolvePanelConfig(baseParsed(parsed), presets),
    (error: unknown) => error instanceof ArgsParseError && error.exitCode === 2 && pattern.test(error.message),
  );
}

test("unknown panel preset is a usage error", () => {
  expectUsage({ panel: "missing" }, { "code-experts": codeExperts }, /unknown panel preset: missing/);
});

test("panel preset with no reviewers is a usage error", () => {
  expectUsage({ panel: "empty" }, { empty: { description: "x", reviewers: [] } }, /at least one reviewer/);
});

test("panel preset exceeding the reviewer limit is a usage error", () => {
  const tooMany: PanelPreset = {
    description: "x",
    reviewers: Array.from({ length: 9 }, (_, i) => ({ id: `r${i + 1}`, role: "role" })),
  };
  expectUsage({ panel: "big" }, { big: tooMany }, /max 8/);
});

test("panel preset with a reviewer missing id or role is a usage error", () => {
  expectUsage(
    { panel: "broken" },
    { broken: { description: "x", reviewers: [{ id: "r1", role: "" }] } },
    /missing id or role/,
  );
});

test("impossible quorum (min-agree greater than reviewer count) is a usage error", () => {
  expectUsage(
    { panel: "code-experts", consensus: "quorum", minAgree: 4 },
    { "code-experts": codeExperts },
    /cannot exceed reviewer count 3/,
  );
});

test("min-agree with a non-quorum policy (from preset combination) is a usage error", () => {
  const presetWithMin: PanelPreset = { ...codeExperts, consensus: "any", minAgree: 2 };
  expectUsage(
    { panel: "code-experts" },
    { "code-experts": presetWithMin },
    /only meaningful with quorum/,
  );
});

test("concurrency greater than reviewer count is a usage error", () => {
  expectUsage(
    { reviewers: 2, concurrency: 5 },
    {},
    /--concurrency 5 cannot exceed reviewer count 2/,
  );
});
