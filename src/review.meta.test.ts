import assert from "node:assert/strict";
import { test } from "node:test";
import { childRuntimeError, metaLinePrefix } from "./review.js";

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
