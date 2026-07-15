import assert from "node:assert/strict";
import { test } from "vitest";
import { compareSemver } from "./update.js";

test("compareSemver orders patch/minor/major", () => {
  assert.equal(compareSemver("0.7.1", "0.8.0"), -1);
  assert.equal(compareSemver("0.8.0", "0.7.1"), 1);
  assert.equal(compareSemver("0.8.0", "0.8.0"), 0);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
  assert.equal(compareSemver("v0.8.0", "0.8.0"), 0);
});

test("compareSemver treats update direction as current → latest only when latest is newer", () => {
  const current = "0.7.1";
  const latest = "0.8.0";
  assert.ok(compareSemver(current, latest) < 0, "registry newer → should upgrade");
  assert.ok(compareSemver(latest, current) > 0, "local newer → must not install @latest");
});
