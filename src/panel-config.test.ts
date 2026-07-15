import assert from "node:assert/strict";
import { test } from "vitest";
import { ArgsParseError } from "./args.js";
import {
  assignGenericReviewerRoles,
  resolvePanelConfig,
  resolveReviewerModelThinking,
  splitModelThinking,
} from "./panel-config.js";
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
  // Roles are distinct personas, not the old identical "Independent reviewer".
  const roles = resolved.reviewers.map((r) => r.role);
  assert.equal(roles.length, 3);
  assert.equal(new Set(roles).size, 3);
  for (const role of roles) {
    assert.notEqual(role, "Independent reviewer");
    assert.ok(role.length > 0);
  }
  assert.equal(resolved.consensus, "quorum");
  assert.equal(resolved.minAgree, 2);
  assert.equal(resolved.concurrency, 3);
  assert.equal(resolved.semanticEnabled, false);
});

test("assignGenericReviewerRoles returns unique labels within a panel", () => {
  const roles = assignGenericReviewerRoles(5);
  assert.equal(roles.length, 5);
  assert.equal(new Set(roles).size, 5);
  // Past the pool size, labels stay unique via suffix.
  const many = assignGenericReviewerRoles(10);
  assert.equal(many.length, 10);
  assert.equal(new Set(many).size, 10);
});

test("generic panel applies per-reviewer model overrides", () => {
  const resolved = resolvePanelConfig(
    baseParsed({
      reviewers: 3,
      reviewerModels: ["r1=openai-codex/gpt-5.6-sol", "r3=anthropic/claude-sonnet-4-5"],
    }),
    {},
  );
  assert.equal(resolved.reviewers[0]?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(resolved.reviewers[1]?.model, undefined);
  assert.equal(resolved.reviewers[2]?.model, "anthropic/claude-sonnet-4-5");
});

test("splitModelThinking strips trailing thinking and keeps provider colons", () => {
  assert.deepEqual(splitModelThinking("zenmux/deepseek/deepseek-v4-flash:low"), {
    model: "zenmux/deepseek/deepseek-v4-flash",
    thinking: "low",
  });
  assert.deepEqual(splitModelThinking("px:openai/agnes-2.0-flash:high"), {
    model: "px:openai/agnes-2.0-flash",
    thinking: "high",
  });
  assert.deepEqual(splitModelThinking("openai/gpt-5.6-sol"), {
    model: "openai/gpt-5.6-sol",
  });
  // Not a thinking level — leave intact (e.g. weird model id).
  assert.deepEqual(splitModelThinking("vendor/model:experimental"), {
    model: "vendor/model:experimental",
  });
});

test("per-reviewer model:thinking is split so low is not overridden by shared high", () => {
  const resolved = resolvePanelConfig(
    baseParsed({
      reviewers: 3,
      thinking: "high", // shared default must NOT clobber per-reviewer :low
      reviewerModels: [
        "r1=zenmux/deepseek/deepseek-v4-flash:low",
        "r2=zenmux/minimax/minimax-m3:low",
        "r3=px:openai/agnes-2.0-flash:low",
      ],
    }),
    {},
  );
  assert.equal(resolved.reviewers[0]?.model, "zenmux/deepseek/deepseek-v4-flash");
  assert.equal(resolved.reviewers[0]?.thinking, "low");
  assert.equal(resolved.reviewers[1]?.model, "zenmux/minimax/minimax-m3");
  assert.equal(resolved.reviewers[1]?.thinking, "low");
  assert.equal(resolved.reviewers[2]?.model, "px:openai/agnes-2.0-flash");
  assert.equal(resolved.reviewers[2]?.thinking, "low");

  // Effective resolution used by child spawn + identity display.
  for (const reviewer of resolved.reviewers) {
    const effective = resolveReviewerModelThinking(reviewer, { thinking: "high" });
    assert.equal(effective.thinking, "low");
    assert.ok(effective.model && !effective.model.endsWith(":low"), effective.model);
  }
});

test("named panel applies overrides by preset reviewer id", () => {
  const resolved = resolvePanelConfig(
    baseParsed({
      panel: "code-experts",
      reviewerModels: ["security=openai-codex/gpt-5.6-sol"],
    }),
    { "code-experts": codeExperts },
  );
  assert.equal(resolved.reviewers.find((r) => r.id === "security")?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(resolved.reviewers.find((r) => r.id === "correctness")?.model, undefined);
});

test("unknown reviewer id in --reviewer-model fails", () => {
  assert.throws(
    () => resolvePanelConfig(baseParsed({ reviewers: 2, reviewerModels: ["r9=openai/gpt"] }), {}),
    /unknown reviewer id/,
  );
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
  expectUsage({ panel: "empty" }, { empty: { description: "x", reviewers: [] } }, /at least two reviewers/);
});

test("panel preset with one reviewer is a usage error", () => {
  expectUsage({ panel: "solo" }, { solo: { description: "x", reviewers: [{ id: "r1", role: "role" }] } }, /at least two reviewers/);
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
    { broken: { description: "x", reviewers: [{ id: "r1", role: "" }, { id: "r2", role: "role" }] } },
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
