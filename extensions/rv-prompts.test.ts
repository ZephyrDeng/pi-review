import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPiReviewArgv,
  buildPiReviewToolCallInstruction,
  buildRvOrchestrationPrompt,
  formatPiReviewCommandLine,
  orchestrationLocaleNote,
  parseRvArgs,
  shellQuote,
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
    assert.match(prompt, /rendered panel result and status/);
    assert.match(prompt, /ASCII pi-review footer/);
    assert.doesNotMatch(prompt, /PI_REVIEW_META:/);
  });

  it("new /rv runs pass the user target as natural-language text without expanding paths", () => {
    const prompt = buildRvOrchestrationPrompt(parseRvArgs("@src"));
    assert.match(prompt, /Call pi_review with target="@src"/);
    assert.match(prompt, /natural-language review request/);
    assert.match(prompt, /Do not expand directory targets into multi-file lists/);
    assert.match(prompt, /panel="code-experts"/);
    assert.match(prompt, /Do not drop panel\/reviewers\/reviewerModels\/consensus fields/);
    assert.match(prompt, /Slash commands select strategy only/);
    assert.doesNotMatch(prompt, /@src\/panel\.ts|@src\/json-events\.ts/);
  });

  it("panel orchestration preserves reviewers/consensus/reviewerModels for pi_review", () => {
    const parsed = parseRvArgs(
      "--reviewers 3 --consensus quorum --min-agree 2 --reviewer-model r1=openai-codex/gpt-5.6-sol @src",
    );
    const instruction = buildPiReviewToolCallInstruction(parsed, "@src");
    assert.match(instruction, /reviewers=3/);
    assert.match(instruction, /consensus="quorum"/);
    assert.match(instruction, /minAgree=2/);
    assert.match(instruction, /reviewerModels=\["r1=openai-codex\/gpt-5\.6-sol"\]/);
    assert.doesNotMatch(instruction, /panel="code-experts"/);
  });

  it("explicit reviewers=1 uses the shell single-review path, never default code-experts", () => {
    const parsed = parseRvArgs("--reviewers 1 @src", "panel");
    const prompt = buildRvOrchestrationPrompt(parsed);
    assert.match(prompt, /single-reviewer|single review/i);
    assert.match(prompt, /pi-review --reviewers 1 -- @src/);
    assert.doesNotMatch(prompt, /Call pi_review/);
    assert.doesNotMatch(prompt, /panel="code-experts"/);
  });

  it("shell command lines quote hostile natural-language targets", () => {
    assert.equal(shellQuote("safe@src"), "safe@src");
    assert.match(shellQuote("foo; rm -rf /"), /^'foo; rm -rf \/'$/);
    const parsed = parseRvArgs("loop-target", "loop");
    // Force a hostile target through the formatter.
    const line = formatPiReviewCommandLine({ ...parsed, target: "x; rm -rf /tmp/pwned" }, "x; rm -rf /tmp/pwned");
    assert.match(line, /'x; rm -rf \/tmp\/pwned'/);
    assert.doesNotMatch(line, /rm -rf \/tmp\/pwned(?!')/);
  });

  it("/rv-loop selects the loop strategy while keeping the target as natural language", () => {
    const parsed = parseRvArgs("@src", "loop");
    assert.equal(parsed.strategy, "loop");
    assert.equal(parsed.target, "@src");
    assert.deepEqual(buildPiReviewArgv(parsed, "@src"), ["pi-review", "loop", "--max-rounds", "1", "--", "@src"]);
    const prompt = buildRvOrchestrationPrompt(parsed);
    assert.match(prompt, /Strategy: loop closeout/);
    assert.match(prompt, /Execute exactly \(already shell-quoted; do not re-quote or drop flags\):\npi-review loop --max-rounds 1 -- @src/);
    assert.doesNotMatch(prompt, /Call pi_review with target/);
  });

  it("/rv-loop --max-rounds uses strict positive safe integers", () => {
    for (const bad of ["0", "1.5", "many", "9007199254740992"]) {
      const parsed = parseRvArgs(`--max-rounds ${bad} @src`, "loop");
      const validation = validateRvParsed(parsed);
      assert.equal(validation.ok, false, bad);
      if (!validation.ok) assert.match(validation.message, /positive integer|safe positive integer/);
    }
    const ok = parseRvArgs("--max-rounds 2 @src", "loop");
    assert.equal(validateRvParsed(ok).ok, true);
    assert.equal(ok.maxRounds, 2);
    assert.deepEqual(buildPiReviewArgv(ok, "@src"), ["pi-review", "loop", "--max-rounds", "2", "--", "@src"]);
  });

  it("/rv-loop defaults argv max-rounds to the host fix-point budget of 1", () => {
    const parsed = parseRvArgs("fix until clean @src", "loop");
    assert.equal(parsed.maxRounds, undefined);
    assert.equal(parsed.until, undefined);
    assert.deepEqual(buildPiReviewArgv(parsed, parsed.target), [
      "pi-review",
      "loop",
      "--max-rounds",
      "1",
      "--",
      "fix until clean @src",
    ]);
    const prompt = buildRvOrchestrationPrompt(parsed);
    assert.match(prompt, /defaults to --max-rounds 1/);
  });

  it("/rv-loop --until clean declares the clean goal and a hard budget", () => {
    const parsed = parseRvArgs("--until clean @src", "loop");
    assert.equal(validateRvParsed(parsed).ok, true);
    assert.equal(parsed.until, "clean");
    assert.deepEqual(buildPiReviewArgv(parsed, "@src"), [
      "pi-review",
      "loop",
      "--until",
      "clean",
      "--max-rounds",
      "10",
      "--",
      "@src",
    ]);
    const prompt = buildRvOrchestrationPrompt(parsed);
    assert.match(prompt, /until-clean closeout|until clean/i);
    assert.match(prompt, /no gate-blocking findings/);
    assert.match(prompt, /Host until-clean cycle/);
    assert.match(prompt, /--until clean --max-rounds 10/);
  });

  it("/rv-loop --until clean keeps an explicit max-rounds budget", () => {
    const parsed = parseRvArgs("--until clean --max-rounds 4 @src", "loop");
    assert.equal(parsed.until, "clean");
    assert.equal(parsed.maxRounds, 4);
    assert.deepEqual(buildPiReviewArgv(parsed, "@src"), [
      "pi-review",
      "loop",
      "--until",
      "clean",
      "--max-rounds",
      "4",
      "--",
      "@src",
    ]);
  });

  it("parses panel strategy flags for /rv and /rv-loop", () => {
    const loop = parseRvArgs("--reviewers 3 --consensus quorum --min-agree 2 --concurrency 2 @src", "loop");
    assert.equal(loop.reviewers, 3);
    assert.equal(loop.consensus, "quorum");
    assert.equal(loop.minAgree, 2);
    assert.equal(loop.concurrency, 2);
    assert.equal(validateRvParsed(loop).ok, true);
    assert.deepEqual(buildPiReviewArgv(loop, "@src"), [
      "pi-review",
      "loop",
      "--max-rounds",
      "1",
      "--reviewers",
      "3",
      "--consensus",
      "quorum",
      "--min-agree",
      "2",
      "--concurrency",
      "2",
      "--",
      "@src",
    ]);

    const panel = parseRvArgs("--panel code-experts --consensus majority @src");
    assert.equal(panel.panel, "code-experts");
    assert.equal(panel.consensus, "majority");
    assert.deepEqual(buildPiReviewArgv(panel, "@src"), [
      "pi-review",
      "--panel",
      "code-experts",
      "--consensus",
      "majority",
      "--",
      "@src",
    ]);
  });

  it("rejects incompatible panel strategy combinations", () => {
    const both = parseRvArgs("--reviewers 3 --panel code-experts @src", "loop");
    assert.equal(validateRvParsed(both).ok, false);

    const badConsensus = parseRvArgs("--reviewers 3 --consensus nope @src", "loop");
    assert.equal(validateRvParsed(badConsensus).ok, false);

    const minAgreeTooHigh = parseRvArgs("--reviewers 2 --consensus quorum --min-agree 3 @src", "loop");
    assert.equal(validateRvParsed(minAgreeTooHigh).ok, false);

    const concurrencyTooHigh = parseRvArgs("--reviewers 2 --concurrency 5 @src", "loop");
    assert.equal(validateRvParsed(concurrencyTooHigh).ok, false);
  });

  it("rejects missing flag values even when a natural-language target follows", () => {
    const allValueFlags = [
      "--mode",
      "--model",
      "--thinking",
      "--continue",
      "--max-rounds",
      "--until",
      "--reviewers",
      "--panel",
      "--reviewer-model",
      "--consensus",
      "--min-agree",
      "--consensus-model",
      "--concurrency",
    ] as const;
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["--model --thinking high @src", "--model"],
      ["--reviewers --panel code-experts @src", "--reviewers"],
      ...allValueFlags.map((flag) => [`${flag} @src`, flag] as const),
    ];
    for (const [raw, flag] of cases) {
      const parsed = parseRvArgs(raw, "loop");
      const validation = validateRvParsed(parsed);
      assert.equal(validation.ok, false, raw);
      if (!validation.ok) assert.match(validation.message, new RegExp(`Missing value for ${flag}`));
      assert.doesNotMatch(parsed.target, new RegExp(flag));
    }
  });

  it("keeps target text after an explicit -- separator when a preceding flag is missing", () => {
    const parsed = parseRvArgs("--model -- @src", "panel");
    const validation = validateRvParsed(parsed);
    assert.equal(validation.ok, false);
    if (!validation.ok) assert.match(validation.message, /Missing value for --model/);
    assert.equal(parsed.target, "@src");
  });

  it("rejects panel-only options for explicit single-reviewer mode", () => {
    for (const raw of [
      "--reviewers 1 --consensus quorum @src",
      "--reviewers 1 --min-agree 1 @src",
      "--reviewers 1 --reviewer-model r1=openai/gpt-5.5 @src",
      "--reviewers 1 --consensus-model openai/gpt-5.5 @src",
      "--reviewers 1 --concurrency 1 @src",
    ]) {
      const validation = validateRvParsed(parseRvArgs(raw, "panel"));
      assert.equal(validation.ok, false, raw);
      if (!validation.ok) assert.match(validation.message, /panel options require --reviewers > 1 or --panel/);
    }
  });

  it("parses repeatable --reviewer-model mappings into argv", () => {
    const parsed = parseRvArgs(
      "--reviewers 3 --reviewer-model r1=openai-codex/gpt-5.6-sol --reviewer-model r2=anthropic/claude-sonnet-4-5 @src",
      "loop",
    );
    assert.deepEqual(parsed.reviewerModels, [
      "r1=openai-codex/gpt-5.6-sol",
      "r2=anthropic/claude-sonnet-4-5",
    ]);
    assert.equal(validateRvParsed(parsed).ok, true);
    assert.deepEqual(buildPiReviewArgv(parsed, "@src"), [
      "pi-review",
      "loop",
      "--max-rounds",
      "1",
      "--reviewers",
      "3",
      "--reviewer-model",
      "r1=openai-codex/gpt-5.6-sol",
      "--reviewer-model",
      "r2=anthropic/claude-sonnet-4-5",
      "--",
      "@src",
    ]);
  });

  it("/rv-models selects the models strategy", () => {
    const parsed = parseRvArgs("", "models");
    assert.equal(parsed.strategy, "models");
    assert.equal(parsed.modelsOnly, true);
    const prompt = buildRvOrchestrationPrompt(parsed);
    assert.match(prompt, /Execute: pi-review models/);
  });

  it("orchestration includes catalog resolution notes when provided", () => {
    const prompt = buildRvOrchestrationPrompt(
      parseRvArgs("--model openai-codex/gpt-5.5 @src"),
      "en",
      ["model gpt-5.5 → openai-codex/gpt-5.5", "thinking 最高 → xhigh"],
    );
    assert.match(prompt, /Resolved user shortcuts against the live model catalog/);
    assert.match(prompt, /model gpt-5\.5 → openai-codex\/gpt-5\.5/);
    assert.match(prompt, /thinking 最高 → xhigh/);
    assert.match(prompt, /Use model exactly as resolved: openai-codex\/gpt-5\.5/);
  });

  it("continuations retain the session-aware CLI path", () => {
    const prompt = buildRvOrchestrationPrompt(parseRvArgs("--continue /tmp/review.jsonl @src/foo.ts"));
    assert.match(prompt, /Execute exactly \(already shell-quoted; do not re-quote or drop flags\):\npi-review --continue \/tmp\/review\.jsonl -- @src\/foo\.ts/);
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
