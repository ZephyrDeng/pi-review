import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseRvArgs } from "./rv-prompts.js";
import { stripSemanticPhrases } from "./rv-semantic.js";

describe("stripSemanticPhrases / parseRvArgs", () => {
  it("maps 方案审核 to plan mode", () => {
    const p = parseRvArgs("方案审核 @docs/plan.md");
    assert.equal(p.mode, "plan");
    assert.equal(p.target, "@docs/plan.md");
  });

  it("maps list models phrase to modelsOnly", () => {
    const p = parseRvArgs("查看模型列表");
    assert.equal(p.modelsOnly, true);
  });

  it("strips code review before flag parse", () => {
    const { remainder, apply } = stripSemanticPhrases("code review @src/a.ts");
    assert.equal(apply.mode, "code");
    assert.match(remainder, /@src\/a\.ts/);
  });
});