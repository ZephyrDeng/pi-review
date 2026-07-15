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
  assert.equal(parsed.until, undefined);
});

test("loop --until clean sets goal and a hard default budget of 10", () => {
  const parsed = parseReviewCommand(["loop", "--until", "clean", "--", "@src"]);
  assert.equal(parsed.until, "clean");
  assert.equal(parsed.maxRounds, 10);
  assert.equal(parsed.maxRoundsExplicit, undefined);
});

test("loop --until clean keeps an explicit --max-rounds budget", () => {
  const parsed = parseReviewCommand([
    "loop", "--until", "clean", "--max-rounds", "7", "--", "@src",
  ]);
  assert.equal(parsed.until, "clean");
  assert.equal(parsed.maxRounds, 7);
  assert.equal(parsed.maxRoundsExplicit, true);
});

test("loop rejects unknown --until goals and non-loop --until", () => {
  assert.throws(
    () => parseReviewCommand(["loop", "--until", "perfect", "--", "@src"]),
    /only supports clean/,
  );
  assert.throws(
    () => parseReviewCommand(["--until", "clean", "--", "@src"]),
    /only be used with loop/,
  );
});

test("value-taking CLI flags reject a following flag instead of consuming it as the value", () => {
  const valueFlags = [
    "--mode", "--continue", "--model", "--provider", "--thinking", "--skill", "--tools", "--name",
    "--progress-log", "--max-rounds", "--until", "--reviewers", "--panel", "--reviewer-model",
    "--consensus", "--min-agree", "--consensus-model", "--concurrency", "--output-format",
  ];
  for (const flag of valueFlags) {
    assert.throws(
      () => parseReviewCommand(["loop", flag, "--no-stream", "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError && error.message === `${flag} requires a value`,
      flag,
    );
  }
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

test("panel options parse for review and loop", () => {
  const parsed = parseReviewCommand([
    "--reviewers", "3", "--consensus", "quorum", "--min-agree", "2", "--concurrency", "2", "--", "@src",
  ]);
  assert.equal(parsed.reviewers, 3);
  assert.equal(parsed.consensus, "quorum");
  assert.equal(parsed.minAgree, 2);
  assert.equal(parsed.concurrency, 2);

  const loopParsed = parseReviewCommand([
    "loop", "--reviewers", "3", "--consensus", "quorum", "--min-agree", "2", "--max-rounds", "2", "--", "@src",
  ]);
  assert.equal(loopParsed.command, "loop");
  assert.equal(loopParsed.reviewers, 3);
  assert.equal(loopParsed.maxRounds, 2);

  const withModels = parseReviewCommand([
    "--reviewers", "3",
    "--reviewer-model", "r1=openai-codex/gpt-5.6-sol",
    "--reviewer-model", "r2=anthropic/claude-sonnet-4-5",
    "--", "@src",
  ]);
  assert.deepEqual(withModels.reviewerModels, [
    "r1=openai-codex/gpt-5.6-sol",
    "r2=anthropic/claude-sonnet-4-5",
  ]);

  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--reviewer-model", "not-a-mapping", "--", "@src"]),
    /reviewer-model must look like/,
  );

  const panelParsed = parseReviewCommand(["--panel", "code-experts", "--consensus", "majority", "--", "@src"]);
  assert.equal(panelParsed.panel, "code-experts");
  assert.equal(panelParsed.consensus, "majority");
});

test("panel event output format parses as an opt-in machine contract", () => {
  const parsed = parseReviewCommand(["--reviewers", "2", "--output-format", "events-jsonl", "--", "@src"]);
  assert.equal(parsed.outputFormat, "events-jsonl");
});

test("loop rejects events-jsonl because its human loop summary has a separate stdout contract", () => {
  assert.throws(
    () => parseReviewCommand(["loop", "--reviewers", "2", "--output-format", "events-jsonl", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /loop cannot be used/.test(error.message),
  );
});

test("panel rejects shell access as a usage error before execution begins", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--tools", "read,bash", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /panel reviewers only allow/.test(error.message),
  );
});

test("reviewer count must be a positive integer within the limit", () => {
  for (const value of ["0", "-1", "1.5", "many"]) {
    assert.throws(
      () => parseReviewCommand(["--reviewers", value, "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError && /positive integer/.test(error.message),
    );
  }
  assert.throws(
    () => parseReviewCommand(["--reviewers", "9", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /between 1 and 8/.test(error.message),
  );
});

test("minimum agreement must be a positive integer and cannot exceed reviewers", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "3", "--min-agree", "0", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /positive integer/.test(error.message),
  );
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--consensus", "quorum", "--min-agree", "3", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /cannot exceed reviewer count 2/.test(error.message),
  );
});

test("unsupported consensus policy is a usage error", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "3", "--consensus", "supermajority", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /unknown consensus policy/.test(error.message),
  );
});

test("min-agree is only meaningful with quorum consensus", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "3", "--consensus", "majority", "--min-agree", "2", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /only meaningful with --consensus quorum/.test(error.message),
  );
});

test("reviewers and panel cannot be combined (any reviewer count)", () => {
  for (const count of ["3", "1"]) {
    assert.throws(
      () => parseReviewCommand(["--reviewers", count, "--panel", "code-experts", "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError && /cannot be used with --panel/.test(error.message),
    );
  }
});

test("panel options require an active panel (reviewers > 1 or panel)", () => {
  for (const args of [
    ["--consensus", "any"],
    ["--min-agree", "2"],
    ["--concurrency", "2"],
    ["--consensus-model", "openai/gpt-5.5"],
  ]) {
    assert.throws(
      () => parseReviewCommand([...args, "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError && /panel options require/.test(error.message),
    );
  }
});

test("panel cannot be used with session reuse flags", () => {
  for (const sessionArgs of [
    ["--keep-session"],
    ["--continue", "/tmp/session.jsonl"],
    ["--name", "gate"],
  ]) {
    assert.throws(
      () => parseReviewCommand(["--reviewers", "3", ...sessionArgs, "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError && /panel cannot be used with/.test(error.message),
    );
  }
});

test("concurrency cannot exceed reviewer count", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--concurrency", "5", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /--concurrency 5 cannot exceed reviewer count 2/.test(error.message),
  );
});

test("single reviewer with no panel flags keeps existing single-review parsing", () => {
  const parsed = parseReviewCommand(["--reviewers", "1", "--", "@src"]);
  assert.equal(parsed.reviewers, 1);
  assert.equal(parsed.panel, undefined);
});
