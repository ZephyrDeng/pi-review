import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { detectRvLocale } from "./rv-locale.js";

describe("detectRvLocale", () => {
  it("returns zh when recent messages are mostly Chinese", () => {
    assert.equal(detectRvLocale(["帮我看一下这个方案", "好的"]), "zh");
  });

  it("returns en for English-only samples", () => {
    assert.equal(detectRvLocale(["Please review this diff", "Thanks"], { LANG: "en_US.UTF-8" }), "en");
  });

  it("defaults to system zh when samples empty", () => {
    assert.equal(detectRvLocale([], { LANG: "zh_CN.UTF-8" }), "zh");
    assert.equal(detectRvLocale([], { LANG: "en_US.UTF-8" }), "en");
  });

  it("prefers zh for mixed samples with any meaningful Chinese", () => {
    assert.equal(
      detectRvLocale(["Please review this diff", "帮我看下鉴权"]),
      "zh",
    );
  });
});