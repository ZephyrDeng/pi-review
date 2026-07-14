import assert from "node:assert/strict";
import { test } from "node:test";
import { childRuntimeError, metaLinePrefix, progressLogBuffersOutput } from "./review.js";

test("metaLinePrefix adds newline when streamed stdout lacks trailing newline", () => {
  assert.equal(metaLinePrefix("hello", true), "\n");
  assert.equal(metaLinePrefix("hello\n", true), "");
  assert.equal(metaLinePrefix("", true), "");
});

test("metaLinePrefix is empty in buffered mode", () => {
  assert.equal(metaLinePrefix("hello", false), "");
});

test("childRuntimeError treats spawn errors as runtime errors", () => {
  assert.equal(
    childRuntimeError({ status: null, signal: null, error: new Error("spawn ENOENT") }),
    "spawn ENOENT",
  );
});

test("progressLogBuffersOutput buffers only in non-streaming mode", () => {
  assert.equal(progressLogBuffersOutput(true, true), false);
  assert.equal(progressLogBuffersOutput(true, false), false);
  assert.equal(progressLogBuffersOutput(false, false), true);
  assert.equal(progressLogBuffersOutput(false, true), true);
});
