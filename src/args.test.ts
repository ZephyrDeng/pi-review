import assert from "node:assert/strict";
import { test } from "vitest";
import { ArgsParseError, parseArgs, parsePanelSubcommand, parseReviewCommand } from "./args.js";

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

test("--no-rules parses as an optional flag, absent by default", () => {
  assert.equal(parseReviewCommand(["--", "@src"]).noRules, undefined);
  assert.equal(parseReviewCommand(["--no-rules", "--", "@src"]).noRules, true);
  assert.equal(parseReviewCommand(["loop", "--no-rules", "--", "@src"]).noRules, true);
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

test("--progress-log-raw modifies --progress-log and cannot stand alone", () => {
  const parsed = parseReviewCommand([
    "--progress-log", "/tmp/progress.jsonl", "--progress-log-raw", "--", "@src",
  ]);
  assert.equal(parsed.progressLog, "/tmp/progress.jsonl");
  assert.equal(parsed.progressLogRaw, true);

  const slimParsed = parseReviewCommand(["--progress-log", "/tmp/progress.jsonl", "--", "@src"]);
  assert.equal(slimParsed.progressLogRaw, undefined);

  assert.throws(
    () => parseReviewCommand(["--progress-log-raw", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /--progress-log-raw requires --progress-log/.test(error.message),
  );
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

test("panel dashboard flags parse for an active panel", () => {
  const parsed = parseReviewCommand([
    "--reviewers", "2", "--ui", "web", "--ui-url-file", "/tmp/url.txt", "--ui-ttl", "60", "--", "@src",
  ]);
  assert.equal(parsed.ui, "web");
  assert.equal(parsed.uiUrlFile, "/tmp/url.txt");
  assert.equal(parsed.uiTtlSeconds, 60);
  assert.equal(parsed.uiOpen, undefined, "auto-open stays on by default");
});

test("--no-ui-open turns off the browser auto-open and requires --ui web", () => {
  const parsed = parseReviewCommand(["--reviewers", "2", "--ui", "web", "--no-ui-open", "--", "@src"]);
  assert.equal(parsed.uiOpen, false);
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--no-ui-open", "--", "@src"]),
    /require --ui web/,
  );
});

test("--ui only accepts web", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--ui", "terminal", "--", "@src"]),
    /--ui must be web/,
  );
});

test("--ui web requires an active panel", () => {
  assert.throws(
    () => parseReviewCommand(["--ui", "web", "--", "@src"]),
    /--ui web requires an active panel/,
  );
});

test("loop rejects --ui web because the dashboard tracks one panel run, not a loop", () => {
  assert.throws(
    () => parseReviewCommand(["loop", "--reviewers", "2", "--ui", "web", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /loop cannot be used/.test(error.message),
  );
});

test("--ui-url-file and --ui-ttl require --ui web", () => {
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--ui-url-file", "/tmp/url.txt", "--", "@src"]),
    /require --ui web/,
  );
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--ui-ttl", "60", "--", "@src"]),
    /require --ui web/,
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

test("reviewers + panel prefers panel and drops reviewers (agent-friendly)", () => {
  for (const count of ["3", "1"]) {
    const parsed = parseReviewCommand(["--reviewers", count, "--panel", "code-experts", "--", "@src"]);
    assert.equal(parsed.panel, "code-experts");
    assert.equal(parsed.reviewers, undefined);
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

test("--consensus-retries parses non-negative integers including 0 and requires an active panel", () => {
  assert.equal(parseReviewCommand(["--reviewers", "2", "--consensus-retries", "0", "--", "@src"]).consensusRetries, 0);
  assert.equal(parseReviewCommand(["--reviewers", "2", "--consensus-retries", "3", "--", "@src"]).consensusRetries, 3);
  for (const bad of ["-1", "1.5", "abc"]) {
    assert.throws(
      () => parseReviewCommand(["--reviewers", "2", "--consensus-retries", bad, "--", "@src"]),
      (error: unknown) => error instanceof ArgsParseError && /non-negative integer/.test(error.message),
    );
  }
  assert.throws(
    () => parseReviewCommand(["--consensus-retries", "1", "--", "@src"]),
    (error: unknown) => error instanceof ArgsParseError && /panel options require/.test(error.message),
  );
});

test("artifact reuse and partial rerun flags parse, deduplicate, and enforce dependencies", () => {
  const parsed = parseReviewCommand([
    "--reuse-reviewers", "/tmp/run-1",
    "--only-reviewers", "r1,r2",
    "--only-reviewers", "r2,security",
    "--run-dir", "/tmp/run-2",
    "--", "@src",
  ]);
  assert.equal(parsed.reuseReviewers, "/tmp/run-1");
  assert.deepEqual(parsed.onlyReviewers, ["r1", "r2", "security"]);
  assert.equal(parsed.runDir, "/tmp/run-2");

  const failed = parseReviewCommand(["--reuse-reviewers", "/tmp/run-1", "--rerun-failed", "--", "@src"]);
  assert.equal(failed.rerunFailed, true);

  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--only-reviewers", "r1", "--", "@src"]),
    /require --reuse-reviewers/,
  );
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--rerun-failed", "--", "@src"]),
    /require --reuse-reviewers/,
  );
  assert.throws(
    () => parseReviewCommand(["--reuse-reviewers", "/tmp/run-1", "--only-reviewers", "r1", "--rerun-failed", "--", "@src"]),
    /cannot be used together/,
  );
  for (const badId of ["", ",", "../x", "a/b", "__proto__", "constructor", "-r1", ".r1"]) {
    assert.throws(
      () => parseReviewCommand(["--reuse-reviewers", "/tmp/run-1", "--only-reviewers", badId, "--", "@src"]),
      ArgsParseError,
    );
  }
  assert.throws(
    () => parseReviewCommand(["--reviewers", "1", "--reuse-reviewers", "/tmp/run-1", "--", "@src"]),
    /requires a multi-reviewer panel/,
  );
  assert.throws(
    () => parseReviewCommand(["--reviewers", "2", "--run-dir", "   ", "--", "@src"]),
    /--run-dir cannot be empty/,
  );
  assert.throws(
    () => parseReviewCommand(["loop", "--reuse-reviewers", "/tmp/run-1", "--", "@src"]),
    /loop cannot be used with/,
  );
});

test("modeExplicit distinguishes explicit --mode / positional mode from default", () => {
  assert.equal(parseReviewCommand(["--reviewers", "2", "--", "@src"]).modeExplicit, undefined);
  assert.equal(parseReviewCommand(["--reviewers", "2", "--mode", "plan", "--", "@src"]).modeExplicit, true);
  assert.equal(parseReviewCommand(["plan", "--reviewers", "2", "--", "@src"]).modeExplicit, true);
});

test("parsePanelSubcommand parses `panel reaggregate` with overrides and rejects invalid input", () => {
  const parsed = parsePanelSubcommand([
    "reaggregate",
    "/tmp/panel-run",
    "--consensus-model", "openai/gpt-5.5",
    "--consensus-retries", "2",
    "--consensus", "majority",
    "--run-dir", "/tmp/out",
    "--output-format", "events-jsonl",
  ]);
  assert.equal(parsed.command, "panel-reaggregate");
  assert.equal(parsed.reuseReviewers, "/tmp/panel-run");
  assert.equal(parsed.consensusModel, "openai/gpt-5.5");
  assert.equal(parsed.consensusRetries, 2);
  assert.equal(parsed.consensus, "majority");
  assert.equal(parsed.runDir, "/tmp/out");
  assert.equal(parsed.outputFormat, "events-jsonl");

  const pathAfterFlags = parseArgs(["panel", "reaggregate", "--consensus", "quorum", "--min-agree", "2", "/tmp/meta.json"]);
  assert.equal(pathAfterFlags.command, "panel-reaggregate");
  assert.equal(pathAfterFlags.reuseReviewers, "/tmp/meta.json");
  assert.equal(pathAfterFlags.minAgree, 2);

  const withUi = parsePanelSubcommand([
    "reaggregate",
    "/tmp/panel-run",
    "--ui", "web",
    "--no-ui-open",
    "--ui-ttl", "30",
  ]);
  assert.equal(withUi.ui, "web");
  assert.equal(withUi.uiOpen, false);
  assert.equal(withUi.uiTtlSeconds, 30);
  assert.throws(
    () => parsePanelSubcommand(["reaggregate", "/tmp/panel-run", "--no-ui-open"]),
    /require --ui web/,
  );

  assert.throws(() => parsePanelSubcommand(["reaggregate"]), /requires a run directory or meta file/);
  assert.throws(() => parsePanelSubcommand(["unknown"]), /expected subcommand "reaggregate/);
  assert.throws(() => parsePanelSubcommand(["reaggregate", "/tmp/a", "/tmp/b"]), /unexpected extra argument/);
  assert.throws(() => parsePanelSubcommand(["reaggregate", "/tmp/a", "--unknown"]), /unknown option/);
  assert.throws(
    () => parsePanelSubcommand(["reaggregate", "/tmp/a", "--consensus", "any", "--min-agree", "2"]),
    /only meaningful with --consensus quorum/,
  );
  assert.throws(
    () => parsePanelSubcommand(["--help"]),
    (error: unknown) => error instanceof ArgsParseError && error.exitCode === 0,
  );
});
