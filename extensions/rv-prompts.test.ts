import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPiReviewArgv,
  buildRvOrchestrationPrompt,
  orchestrationLocaleNote,
  parseRvArgs,
  validateRvParsed,
} from "./rv-prompts.js";

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

  it("parses --no-stream into CLI argv", () => {
    const p = parseRvArgs("--no-stream @src/foo.ts");
    assert.equal(p.noStream, true);
    assert.equal(p.target, "@src/foo.ts");
    assert.deepEqual(buildPiReviewArgv(p, "@src/foo.ts"), [
      "pi-review",
      "--no-stream",
      "--",
      "@src/foo.ts",
    ]);
  });

  it("parses --thinking and threads it into CLI argv", () => {
    const p = parseRvArgs("--thinking xhigh --model openai/gpt-5.5 @x.md");
    assert.equal(p.thinking, "xhigh");
    assert.equal(p.model, "openai/gpt-5.5");
    assert.deepEqual(buildPiReviewArgv(p, "@x.md"), [
      "pi-review",
      "--model",
      "openai/gpt-5.5",
      "--thinking",
      "xhigh",
      "--",
      "@x.md",
    ]);
  });

  it("models orchestration includes locale note and model-selection reference", () => {
    const p = parseRvArgs("models");
    const zh = buildRvOrchestrationPrompt(p, "zh");
    assert.match(zh, /用中文向用户总结/);
    assert.match(zh, /model-selection/);
    assert.match(orchestrationLocaleNote("en"), /English/);
  });

  it("orchestration prompt forbids default no-stream and progress-log in Pi", () => {
    const p = parseRvArgs("@src/foo.ts");
    const prompt = buildRvOrchestrationPrompt(p);
    assert.match(prompt, /Do NOT add --no-stream or --progress-log/);
    assert.match(prompt, /ASCII pi-review footer/);
    assert.doesNotMatch(prompt, /PI_REVIEW_META:/);
  });

  it("continuations retain the session-aware CLI path", () => {
    const prompt = buildRvOrchestrationPrompt(parseRvArgs("--continue /tmp/review.jsonl @src/foo.ts"));
    assert.match(prompt, /Execute:\npi-review --continue \/tmp\/review\.jsonl -- @src\/foo\.ts/);
    assert.doesNotMatch(prompt, /Call pi_review with target/);
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
