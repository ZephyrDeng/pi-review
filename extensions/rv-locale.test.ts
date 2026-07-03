import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectRvLocale } from "./rv-locale.js";

describe("detectRvLocale", () => {
  it("returns zh when recent messages are mostly Chinese", () => {
    assert.equal(detectRvLocale(["帮我看一下这个方案", "好的"]), "zh");
  });

  it("returns en for English-only samples", () => {
    assert.equal(detectRvLocale(["Please review this diff", "Thanks"]), "en");
  });

  it("defaults to en when empty", () => {
    assert.equal(detectRvLocale([]), "en");
  });
});