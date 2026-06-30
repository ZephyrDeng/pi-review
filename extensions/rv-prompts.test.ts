import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiReviewArgv, parseRvArgs, validateRvParsed } from "./rv-prompts.js";

describe("parseRvArgs / validateRvParsed", () => {
  it("parses continue with optional mode and model", () => {
    const p = parseRvArgs("--continue abc123 --mode challenge --model zenmux/foo expand finding 2");
    assert.equal(p.continueHandle, "abc123");
    assert.equal(p.mode, "challenge");
    assert.equal(p.model, "zenmux/foo");
    assert.equal(p.target, "expand finding 2");
    assert.equal(validateRvParsed(p).ok, true);
  });

  it("passes custom preset mode through to CLI argv", () => {
    const p = parseRvArgs("--mode plan-bigbang @x.md");
    assert.equal(p.mode, "plan-bigbang");
    assert.equal(validateRvParsed(p).ok, true);
    assert.deepEqual(buildPiReviewArgv(p, "@x.md"), ["pi-review", "--mode", "plan-bigbang", "--", "@x.md"]);
  });

  it("rejects keep-session with continue", () => {
    const p = parseRvArgs("--keep-session --continue h -- foo");
    const v = validateRvParsed(p);
    assert.equal(v.ok, false);
  });

  it("buildPiReviewArgv matches for initial and continue", () => {
    const initial = parseRvArgs("--mode plan --model m/a @doc.md");
    assert.deepEqual(buildPiReviewArgv(initial, "@doc.md"), [
      "pi-review",
      "--mode",
      "plan",
      "--model",
      "m/a",
      "--",
      "@doc.md",
    ]);

    const cont = parseRvArgs("--continue h --mode plan --model m/a more");
    assert.deepEqual(buildPiReviewArgv(cont, "more"), [
      "pi-review",
      "--continue",
      "h",
      "--mode",
      "plan",
      "--model",
      "m/a",
      "--",
      "more",
    ]);
  });
});