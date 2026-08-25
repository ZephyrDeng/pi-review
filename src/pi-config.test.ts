import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  configFilePath,
  loadReviewConfigFile,
  parseReviewConfig,
  resolveChildExtensions,
} from "./pi-config.js";

test("parseReviewConfig accepts an empty or full valid config", () => {
  assert.deepEqual(parseReviewConfig("{}"), { config: {}, warnings: [] });
  assert.deepEqual(parseReviewConfig('{"childExtensions": true}'), { config: { childExtensions: true }, warnings: [] });
  assert.deepEqual(parseReviewConfig('{"childExtensions": false}'), { config: { childExtensions: false }, warnings: [] });
});

test("parseReviewConfig ignores unknown keys for forward compatibility", () => {
  assert.deepEqual(parseReviewConfig('{"childExtensions": true, "futureKey": 42}'), {
    config: { childExtensions: true },
    warnings: [],
  });
});

test("parseReviewConfig treats null as explicitly unset", () => {
  assert.deepEqual(parseReviewConfig('{"childExtensions": null}'), { config: {}, warnings: [] });
});

test("parseReviewConfig leniently ignores a non-boolean value with a warning", () => {
  const load = parseReviewConfig('{"childExtensions": "true"}');
  assert.deepEqual(load.config, {});
  assert.equal(load.warnings.length, 1);
  assert.match(load.warnings[0]!, /childExtensions/);
  assert.match(load.warnings[0]!, /ignoring it/);

  const num = parseReviewConfig('{"childExtensions": 1}');
  assert.deepEqual(num.config, {});
  assert.equal(num.warnings.length, 1);
});

test("parseReviewConfig leniently handles invalid JSON and non-object roots with a warning", () => {
  const badJson = parseReviewConfig("not json");
  assert.deepEqual(badJson.config, {});
  assert.equal(badJson.warnings.length, 1);
  assert.match(badJson.warnings[0]!, /not valid JSON/);

  const arr = parseReviewConfig("[1, 2]");
  assert.deepEqual(arr.config, {});
  assert.equal(arr.warnings.length, 1);

  const nul = parseReviewConfig("null");
  assert.deepEqual(nul.config, {});
  assert.equal(nul.warnings.length, 1);
});

test("loadReviewConfigFile treats a missing file as the empty config with no warnings", () => {
  const missing = path.join(os.tmpdir(), `pi-review-config-missing-${Date.now()}.json`);
  assert.deepEqual(loadReviewConfigFile(missing), { config: {}, warnings: [] });
});

test("loadReviewConfigFile loads and validates an existing file", () => {
  const file = path.join(os.tmpdir(), `pi-review-config-${Date.now()}.json`);
  fs.writeFileSync(file, '{"childExtensions": true}');
  try {
    assert.deepEqual(loadReviewConfigFile(file), { config: { childExtensions: true }, warnings: [] });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("configFilePath defaults under the pi data dir and honors PI_REVIEW_CONFIG", () => {
  assert.equal(configFilePath({}), path.join(os.homedir(), ".pi", "pi-review", "config.json"));
  assert.equal(configFilePath({ PI_REVIEW_CONFIG: "/tmp/custom.json" }), "/tmp/custom.json");
});

test("resolveChildExtensions: env truthy values override config and default", () => {
  for (const value of ["1", "true", "KEEP", " 1 "]) {
    assert.deepEqual(resolveChildExtensions({ PI_REVIEW_CHILD_EXTENSIONS: value }, {}), { enabled: true, source: "env" });
    assert.deepEqual(resolveChildExtensions({ PI_REVIEW_CHILD_EXTENSIONS: value }, { childExtensions: false }), { enabled: true, source: "env" });
  }
});

test("resolveChildExtensions: env set to a non-truthy value forces isolation", () => {
  assert.deepEqual(resolveChildExtensions({ PI_REVIEW_CHILD_EXTENSIONS: "0" }, { childExtensions: true }), { enabled: false, source: "env" });
  assert.deepEqual(resolveChildExtensions({ PI_REVIEW_CHILD_EXTENSIONS: "no" }, { childExtensions: true }), { enabled: false, source: "env" });
});

test("resolveChildExtensions: unset or empty env falls through to config, then default", () => {
  assert.deepEqual(resolveChildExtensions({}, { childExtensions: true }), { enabled: true, source: "config" });
  assert.deepEqual(resolveChildExtensions({}, { childExtensions: false }), { enabled: false, source: "config" });
  assert.deepEqual(resolveChildExtensions({ PI_REVIEW_CHILD_EXTENSIONS: "" }, { childExtensions: true }), { enabled: true, source: "config" });
  assert.deepEqual(resolveChildExtensions({ PI_REVIEW_CHILD_EXTENSIONS: "  " }, { childExtensions: true }), { enabled: true, source: "config" });
  assert.deepEqual(resolveChildExtensions({}, {}), { enabled: false, source: "default" });
});
