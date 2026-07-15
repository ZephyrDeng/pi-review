import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { DEFAULT_AGENT_SKILL_ARGS } from "./skill.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledSkillDir = path.join(packageRoot, "skills", "pi-review");
const bundledSkill = path.join(bundledSkillDir, "SKILL.md");
const bundledRefs = path.join(bundledSkillDir, "references");

test("DEFAULT_AGENT_SKILL_ARGS is non-interactive for common agents", () => {
  assert.deepEqual(DEFAULT_AGENT_SKILL_ARGS, ["-y", "--agent", "claude-code", "codex", "cursor"]);
});

test("bundled skill ships SKILL.md and references assets for update fallback", () => {
  assert.equal(fs.existsSync(bundledSkill), true);
  assert.equal(fs.existsSync(bundledRefs), true);
  assert.ok(fs.readdirSync(bundledRefs).length > 0);
});

test("usage documents update as package + skill", async () => {
  const argsSource = fs.readFileSync(path.join(packageRoot, "src", "args.ts"), "utf8");
  assert.match(argsSource, /pi-review update\s+Update package \+ agent skill content/);
});
