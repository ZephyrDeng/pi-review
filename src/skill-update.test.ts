import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  DEFAULT_AGENT_SKILL_ARGS,
  DEFAULT_SKILL_AGENTS,
  expandSkillAgentArgs,
  listDirectSkillInstallTargets,
  resolveDirectSkillInstallTargets,
  selectedSkillAgents,
} from "./skill.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledSkillDir = path.join(packageRoot, "skills", "pi-review");
const bundledSkill = path.join(bundledSkillDir, "SKILL.md");
const bundledRefs = path.join(bundledSkillDir, "references");

test("DEFAULT_AGENT_SKILL_ARGS is non-interactive for common agents including agy", () => {
  assert.deepEqual(DEFAULT_SKILL_AGENTS, [
    "claude-code",
    "codex",
    "cursor",
    "antigravity",
    "antigravity-cli",
  ]);
  assert.deepEqual(DEFAULT_AGENT_SKILL_ARGS, ["-y", "--agent", ...DEFAULT_SKILL_AGENTS]);
});

test("expandSkillAgentArgs maps agy alias to skills CLI agent names", () => {
  assert.deepEqual(expandSkillAgentArgs(["-y", "--agent", "agy"]), [
    "-y",
    "--agent",
    "antigravity",
    "antigravity-cli",
  ]);
  assert.deepEqual(expandSkillAgentArgs(["--agent", "claude-code", "agy", "cursor"]), [
    "--agent",
    "claude-code",
    "antigravity",
    "antigravity-cli",
    "cursor",
  ]);
  assert.deepEqual(expandSkillAgentArgs(["--agent", "antigravity", "agy"]), [
    "--agent",
    "antigravity",
    "antigravity-cli",
  ]);
  assert.deepEqual(expandSkillAgentArgs(["--agent", "claude-code", "codex"]), [
    "--agent",
    "claude-code",
    "codex",
  ]);
});

test("listDirectSkillInstallTargets covers Claude Code and universal agy path", () => {
  const home = os.homedir();
  const targets = listDirectSkillInstallTargets();
  assert.deepEqual(
    targets.map((t) => t.id),
    ["claude-code", "agy"],
  );
  assert.equal(targets[0]!.dir, path.join(home, ".claude", "skills", "pi-review"));
  assert.equal(targets[1]!.dir, path.join(home, ".gemini", "config", "skills", "pi-review"));
});

test("selectedSkillAgents and resolveDirectSkillInstallTargets honor --agent filters", () => {
  assert.equal(selectedSkillAgents([]), "all");
  assert.equal(selectedSkillAgents(["-y", "--global"]), "all");
  assert.deepEqual(selectedSkillAgents(["--agent", "agy", "-y"]), [
    "antigravity",
    "antigravity-cli",
  ]);
  assert.deepEqual(selectedSkillAgents(["-a", "claude-code", "codex"]), [
    "claude-code",
    "codex",
  ]);
  assert.equal(selectedSkillAgents(["--all"]), "all");

  assert.deepEqual(
    resolveDirectSkillInstallTargets(["--agent", "agy"]).map((t) => t.id),
    ["agy"],
  );
  assert.deepEqual(
    resolveDirectSkillInstallTargets(["--agent", "claude-code"]).map((t) => t.id),
    ["claude-code"],
  );
  assert.deepEqual(
    resolveDirectSkillInstallTargets(["--agent", "antigravity-cli"]).map((t) => t.id),
    ["agy"],
  );
  assert.deepEqual(
    resolveDirectSkillInstallTargets(["--agent", "codex", "cursor"]).map((t) => t.id),
    [],
  );
  assert.deepEqual(
    resolveDirectSkillInstallTargets([]).map((t) => t.id),
    ["claude-code", "agy"],
  );
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
