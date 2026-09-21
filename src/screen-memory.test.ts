import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  aggregateScreenMemory,
  formatScreenMemoryAscii,
  loadUserPatterns,
  parseScreenPatternsFile,
  readScreenMemory,
  recordScreenMemory,
  screenMemoryEnabled,
  screenMemoryFilePath,
  screenPatternsFilePath,
  MEMORY_ENTRY_KEEP,
  MEMORY_ENTRY_LIMIT,
  type FlaggedScreenHunk,
  type ScreenMemoryEntry,
} from "./screen-memory.js";

function tmpEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-mem-"));
  return { env: { PI_REVIEW_CONFIG: path.join(dir, "config.json") } as NodeJS.ProcessEnv, dir };
}

const FLAGGED: FlaggedScreenHunk = {
  path: "src/order.ts",
  hunk: "placeOrder",
  startLine: 10,
  endLine: 42,
  catchAll: 0.82,
  patterns: [],
  code: "for (let i = 0; i <= items.length; i++) {",
};

test("parseScreenPatternsFile validates entries and skips bad ones with warnings", () => {
  const load = parseScreenPatternsFile(
    JSON.stringify({
      patterns: {
        good_rule: { title: "T", severity: "major", category: "security", recommendation: "R" },
        "Bad-Id": { title: "T", severity: "major", category: "security", recommendation: "R" },
        bad_severity: { title: "T", severity: "fatal", category: "security", recommendation: "R" },
        bad_shape: "not an object",
      },
      disabled: ["noisy_rule", 42],
      unknown_key: "ignored",
    }),
    "test.json",
  );
  assert.deepEqual(Object.keys(load.patterns), ["good_rule"]);
  assert.deepEqual(load.disabled, ["noisy_rule"]);
  assert.equal(load.warnings.length, 4); // Bad-Id + bad_severity + bad_shape + non-string disabled entry
  assert.ok(load.warnings.some((w) => w.includes('"disabled"')));
});

test("parseScreenPatternsFile treats invalid JSON as empty with a warning", () => {
  const load = parseScreenPatternsFile("{nope", "broken.json");
  assert.deepEqual(load.patterns, {});
  assert.equal(load.warnings.length, 1);
});

test("loadUserPatterns merges machine file then PI_REVIEW_SCREEN_PATTERNS, last wins", () => {
  const { env, dir } = tmpEnv();
  fs.writeFileSync(
    screenPatternsFilePath(env),
    JSON.stringify({
      patterns: { a_rule: { title: "machine", severity: "minor", category: "correctness", recommendation: "r" } },
      disabled: ["d1"],
    }),
  );
  const extra = path.join(dir, "project.json");
  fs.writeFileSync(
    extra,
    JSON.stringify({
      patterns: {
        a_rule: { title: "project override", severity: "critical", category: "security", recommendation: "r2" },
        b_rule: { title: "project only", severity: "major", category: "data-loss", recommendation: "r" },
      },
      disabled: ["d2"],
    }),
  );
  const load = loadUserPatterns({ ...env, PI_REVIEW_SCREEN_PATTERNS: extra } as NodeJS.ProcessEnv);
  assert.equal(load.patterns.a_rule!.title, "project override");
  assert.equal(load.patterns.b_rule!.title, "project only");
  assert.deepEqual(load.disabled.sort(), ["d1", "d2"]);
  assert.equal(load.files.length, 2);
});

test("recordScreenMemory refreshes verdicts on re-flag, appends new hashes, and writes 0600", () => {
  const { env } = tmpEnv();
  const file = screenMemoryFilePath(env);
  recordScreenMemory([FLAGGED], env);
  recordScreenMemory([FLAGGED], env); // same hash: refreshes, seen++
  let entries = readScreenMemory(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.unmatched, true);
  assert.equal(entries[0]!.seen, 2);
  assert.deepEqual(entries[0]!.lines, [10, 42]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); // snippets can embed flagged secrets

  // a promoted pattern flips the stored verdict in place
  recordScreenMemory([{ ...FLAGGED, patterns: ["off_by_one_loop"] }], env);
  entries = readScreenMemory(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.unmatched, false);
  assert.deepEqual(entries[0]!.patterns, ["off_by_one_loop"]);
  assert.equal(entries[0]!.seen, 3);

  // changed code → new hash → new entry
  recordScreenMemory([{ ...FLAGGED, code: "different code body" }], env);
  entries = readScreenMemory(file);
  assert.equal(entries.length, 2);

  // disabled env writes nothing
  recordScreenMemory([{ ...FLAGGED, hunk: "other", code: "z" }], { ...env, PI_REVIEW_SCREEN_MEMORY: "0" } as NodeJS.ProcessEnv);
  assert.equal(readScreenMemory(file).length, 2);
  assert.equal(screenMemoryEnabled({ PI_REVIEW_SCREEN_MEMORY: "off" } as NodeJS.ProcessEnv), false);
});

test("recordScreenMemory caps the log at MEMORY_ENTRY_LIMIT", () => {
  const { env } = tmpEnv();
  const file = screenMemoryFilePath(env);
  const seed: ScreenMemoryEntry[] = Array.from({ length: MEMORY_ENTRY_LIMIT }, (_, i) => ({
    ts: "t",
    path: "f.ts",
    hunk: `h${i}`,
    lines: [1, 2],
    patterns: [],
    unmatched: true,
    hash: `seed${i}`,
  }));
  fs.writeFileSync(file, `${seed.map((e) => JSON.stringify(e)).join("\n")}\n`);
  recordScreenMemory([FLAGGED], env);
  const entries = readScreenMemory(file);
  assert.equal(entries.length, MEMORY_ENTRY_KEEP);
  assert.equal(entries[entries.length - 1]!.hunk, "placeOrder"); // newest kept
});

test("aggregateScreenMemory groups unmatched signals and counts pattern hits", () => {
  const entries: ScreenMemoryEntry[] = [
    { ts: "1", path: "a.ts", hunk: "f", lines: [1, 5], catchAll: 0.8, patterns: [], unmatched: true, hash: "1", code: "  first line\n  second" },
    { ts: "2", path: "a.ts", hunk: "f", lines: [1, 6], catchAll: 0.9, patterns: [], unmatched: true, hash: "2", code: "  changed first" },
    { ts: "3", path: "b.ts", hunk: "g", lines: [1, 3], patterns: ["sql_injection"], unmatched: false, hash: "3" },
    { ts: "4", path: "b.ts", hunk: "h", lines: [4, 9], patterns: ["sql_injection", "float_money"], unmatched: false, hash: "4" },
  ];
  const stats = aggregateScreenMemory(entries);
  assert.equal(stats.entries, 4);
  assert.equal(stats.files, 2);
  assert.equal(stats.unmatchedEntries, 2);
  assert.deepEqual(stats.patternHits, [
    { id: "sql_injection", count: 2 },
    { id: "float_money", count: 1 },
  ]);
  assert.equal(stats.unmatched.length, 1);
  assert.equal(stats.unmatched[0]!.count, 2);
  assert.equal(stats.unmatched[0]!.lastCatchAll, 0.9);
  assert.equal(stats.unmatched[0]!.sample, "changed first");
});

test("formatScreenMemoryAscii renders catalog, hits, and promotion hint", () => {
  const stats = aggregateScreenMemory([
    { ts: "1", path: "a.ts", hunk: "f", lines: [1, 5], catchAll: 0.8, patterns: [], unmatched: true, hash: "1", code: "code" },
  ]);
  const text = formatScreenMemoryAscii(stats, {
    file: "/tmp/mem.jsonl",
    patternsFile: "/tmp/screen-patterns.json",
    catalog: { builtin: 21, custom: 2, overrides: 1, disabled: 1, recording: true },
  });
  assert.ok(text.includes("21 builtin · 2 custom (1 overrides builtin) · 1 disabled"));
  assert.ok(text.includes("a.ts"));
  assert.ok(text.includes("screen-patterns.json"));

  const empty = formatScreenMemoryAscii(aggregateScreenMemory([]), {
    file: "/tmp/mem.jsonl",
    patternsFile: "/tmp/screen-patterns.json",
    catalog: { builtin: 21, custom: 0, overrides: 0, disabled: 0, recording: true },
  });
  assert.ok(empty.includes("none yet"));
});
