import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CHILD_STDERR_DIAGNOSTIC_LIMIT,
  childIsolationArgs,
  formatChildRuntimeDetail,
} from "./review.js";
import { buildReviewerArgs } from "./panel.js";
import type { Config } from "./config.js";
import type { ParsedArgs } from "./types.js";

test("childIsolationArgs defaults to --no-extensions for host isolation", () => {
  assert.deepEqual(childIsolationArgs({}), ["--no-extensions"]);
  assert.deepEqual(childIsolationArgs({ PI_REVIEW_CHILD_EXTENSIONS: "" }), ["--no-extensions"]);
  assert.deepEqual(childIsolationArgs({ PI_REVIEW_CHILD_EXTENSIONS: "0" }), ["--no-extensions"]);
});

test("childIsolationArgs can opt back into host extensions", () => {
  assert.deepEqual(childIsolationArgs({ PI_REVIEW_CHILD_EXTENSIONS: "1" }), []);
  assert.deepEqual(childIsolationArgs({ PI_REVIEW_CHILD_EXTENSIONS: "true" }), []);
  assert.deepEqual(childIsolationArgs({ PI_REVIEW_CHILD_EXTENSIONS: "KEEP" }), []);
});

test("formatChildRuntimeDetail preserves a multi-line child stack tail", () => {
  const stack = [
    "file:///tmp/runner.js:358",
    "            throw new Error(this.staleMessage);",
    "                  ^",
    "",
    "Error: This extension ctx is stale after session replacement or reload.",
  ].join("\n");
  const detail = formatChildRuntimeDetail("child pi exited with status 1", stack);
  assert.match(detail, /child pi exited with status 1/);
  assert.match(detail, /--- child stderr ---/);
  assert.match(detail, /extension ctx is stale/);
  assert.match(detail, /runner\.js:358/);
});

test("formatChildRuntimeDetail keeps runtime error alone when stderr is empty or blank", () => {
  assert.equal(formatChildRuntimeDetail("child pi exited with status 1", ""), "child pi exited with status 1");
  assert.equal(formatChildRuntimeDetail("child pi exited with status 1", "   \n\t  "), "child pi exited with status 1");
});

test("formatChildRuntimeDetail clips oversized stderr from the tail", () => {
  const marker = "UNIQUE_HEAD_MARKER";
  const huge = `${marker}${"a".repeat(CHILD_STDERR_DIAGNOSTIC_LIMIT + 50)}TAIL`;
  const detail = formatChildRuntimeDetail("boom", huge);
  assert.ok(!detail.includes(marker), "head of oversized stderr must be dropped");
  assert.match(detail, /TAIL$/);
  assert.ok(detail.length < huge.length);
});

test("buildReviewerArgs isolates children with --no-extensions by default", () => {
  const config = { piBin: "pi" } as Config;
  const parsed = {
    mode: "code",
    provider: undefined,
    model: undefined,
    thinking: undefined,
    tools: undefined,
    skills: [],
  } as unknown as ParsedArgs;
  const args = buildReviewerArgs(
    config,
    parsed,
    {},
    "review this",
    [],
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" },
    undefined,
    "system",
    {},
  );
  assert.ok(args.includes("--no-extensions"), `expected isolation flag in ${args.join(" ")}`);
  assert.ok(args.includes("--no-session"));
  assert.ok(args.indexOf("--no-extensions") < args.indexOf("--no-session"));
});

test("buildReviewerArgs honors PI_REVIEW_CHILD_EXTENSIONS opt-out", () => {
  const config = { piBin: "pi" } as Config;
  const parsed = {
    mode: "code",
    provider: undefined,
    model: undefined,
    thinking: undefined,
    tools: undefined,
    skills: [],
  } as unknown as ParsedArgs;
  const args = buildReviewerArgs(
    config,
    parsed,
    {},
    "review this",
    [],
    {},
    undefined,
    "",
    { PI_REVIEW_CHILD_EXTENSIONS: "1" },
  );
  assert.ok(!args.includes("--no-extensions"));
});
