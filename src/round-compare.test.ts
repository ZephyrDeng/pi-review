import assert from "node:assert/strict";
import { test } from "vitest";
import { compareRoundFindings } from "./round-compare.js";
import { DeterministicMatcher, SemanticMatcher, type SemanticAdjudicator } from "./matcher.js";

const det = new DeterministicMatcher();

test("identical sets: all persisting, nothing added or resolved", async () => {
  const prev = [{ id: "F1", summary: "Off-by-one in loop", path: "src/cli.ts" }];
  const curr = [{ id: "F1", summary: "off-by-one in loop", path: "./src/cli.ts" }];
  const result = await compareRoundFindings(prev, curr, det);
  assert.deepEqual(result, { persisting: 1, added: 0, resolved: 0 });
});

test("disjoint sets: everything added and resolved", async () => {
  const prev = [{ id: "F1", summary: "Off-by-one", path: "src/a.ts" }];
  const curr = [{ id: "F1", summary: "SQL injection", path: "src/b.ts" }];
  const result = await compareRoundFindings(prev, curr, det);
  assert.deepEqual(result, { persisting: 0, added: 1, resolved: 1 });
});

test("partial overlap: one persists, one resolved, one added", async () => {
  const prev = [
    { id: "F1", summary: "Off-by-one", path: "src/a.ts" },
    { id: "F2", summary: "Old bug now fixed", path: "src/b.ts" },
  ];
  const curr = [
    { id: "F1", summary: "Off-by-one", path: "src/a.ts" },
    { id: "F2", summary: "Brand new bug", path: "src/c.ts" },
  ];
  const result = await compareRoundFindings(prev, curr, det);
  assert.deepEqual(result, { persisting: 1, added: 1, resolved: 1 });
});

test("wording drift across rounds merges via a Jev-style adjudicator", async () => {
  // Deterministic matching cannot merge these; a semantic adjudicator can.
  const adjudicator: SemanticAdjudicator = {
    adjudicate: async () => ({ merges: [{ sourceFindingIds: ["prev#F1", "curr#F1"], confidence: 0.9 }] }),
  };
  const matcher = new SemanticMatcher(adjudicator);
  const prev = [{ id: "F1", summary: "Off-by-one in loop bound", path: "src/cli.ts" }];
  const curr = [{ id: "F1", summary: "Loop can iterate past the array end", path: "src/cli.ts" }];
  const result = await compareRoundFindings(prev, curr, matcher);
  assert.deepEqual(result, { persisting: 1, added: 0, resolved: 0 });
});

test("a persisting finding reported by two rounds counts once per round", async () => {
  // Round N had two reviewers' worth of duplicates collapsed upstream; here
  // prev has one finding, curr has two differently-worded instances of it.
  const adjudicator: SemanticAdjudicator = {
    adjudicate: async ({ candidates }) => ({
      merges: [{ sourceFindingIds: candidates.flatMap((c) => c.findings.map((f) => f.id)), confidence: 0.9 }],
    }),
  };
  const matcher = new SemanticMatcher(adjudicator);
  const prev = [{ id: "F1", summary: "eval executes user input", path: "src/x.ts" }];
  const curr = [
    { id: "F1", summary: "arbitrary code execution via eval", path: "src/x.ts" },
    { id: "F2", summary: "unsanitized string reaches eval", path: "src/x.ts" },
  ];
  const result = await compareRoundFindings(prev, curr, matcher);
  assert.deepEqual(result, { persisting: 2, added: 0, resolved: 0 });
});

test("empty previous round: everything is added", async () => {
  const curr = [{ id: "F1", summary: "Bug", path: "src/a.ts" }];
  const result = await compareRoundFindings([], curr, det);
  assert.deepEqual(result, { persisting: 0, added: 1, resolved: 0 });
});
