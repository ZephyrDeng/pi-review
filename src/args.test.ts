import assert from "node:assert/strict";
import { test } from "node:test";
import { ArgsParseError, parseReviewCommand } from "./args.js";

test("review remains the default and explicit command", () => {
  assert.equal(parseReviewCommand(["--", "@src"]).command, "review");
  assert.equal(parseReviewCommand(["review", "--", "@src"]).command, "review");
});

test("loop parses max rounds and shared review options", () => {
  const parsed = parseReviewCommand([
    "loop",
    "--max-rounds",
    "5",
    "--mode",
    "challenge",
    "--model",
    "provider/model",
    "--",
    "@docs/design.md",
    "focus on rollback",
  ]);

  assert.equal(parsed.command, "loop");
  assert.equal(parsed.maxRounds, 5);
  assert.equal(parsed.mode, "challenge");
  assert.equal(parsed.model, "provider/model");
  assert.deepEqual(parsed.payload, ["@docs/design.md", "focus on rollback"]);
});

test("loop uses a small default review budget", () => {
  const parsed = parseReviewCommand(["loop", "--", "@src"]);

  assert.equal(parsed.command, "loop");
  assert.equal(parsed.maxRounds, 3);
});

test("loop rejects invalid max-rounds values as usage errors", () => {
  for (const value of ["0", "-1", "1.5", "many", "9007199254740992"]) {
    assert.throws(
      () => parseReviewCommand(["loop", "--max-rounds", value, "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError
        && error.exitCode === 2
        && /positive integer/.test(error.message),
    );
  }
});

test("loop rejects session reuse and review rejects loop-only flags", () => {
  for (const sessionArgs of [
    ["--keep-session"],
    ["--continue", "/tmp/session.jsonl"],
    ["--name", "gate"],
  ]) {
    assert.throws(
      () => parseReviewCommand(["loop", ...sessionArgs, "--", "@src"]),
      /loop cannot be used/,
    );
  }

  assert.throws(
    () => parseReviewCommand(["review", "--max-rounds", "2", "--", "@src"]),
    /only be used with loop/,
  );
});
