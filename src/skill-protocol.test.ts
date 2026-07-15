import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const skillPath = fileURLToPath(new URL("../skills/pi-review/SKILL.md", import.meta.url));

test("shipped skill defines bounded host-owned loop closeout", () => {
  const skill = fs.readFileSync(skillPath, "utf8");

  for (const required of [
    "Freeze the scope baseline",
    "in-scope blocker",
    "follow-up",
    "stop-and-escalate",
    "two non-converging",
    "Never ask the child review session to implement fixes",
    "explicit human acceptance",
  ]) {
    assert.match(skill, new RegExp(required, "i"));
  }
});

test("shipped skill documents Panel Review, consensus, and advisories", () => {
  const skill = fs.readFileSync(skillPath, "utf8");

  for (const required of [
    "Panel review",
    "confirmed finding",
    "advisory",
    "quorum",
    "majority",
    "unanimous",
    "host-only fixes",
    "cost multipl",
  ]) {
    assert.match(skill, new RegExp(required, "i"), `skill missing: ${required}`);
  }
});
