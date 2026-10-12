// Claude Code plugin (live panel pane + skill) install/update through the
// `claude` CLI. Once the plugin is in, it is Claude Code's only copy of the
// skill: the standalone ~/.claude/skills/pi-review is removed and later skill
// refreshes leave claude-code out, so the session never lists the skill twice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_SKILL_AGENTS, runUninstallSkill } from "./skill.js";

export const CLAUDE_PLUGIN_ID = "pi-review@pi-review";
const MARKETPLACE_SOURCE = "ZephyrDeng/pi-review";

/** Skill install/refresh args for every default agent but Claude Code, which the plugin serves. */
export const SKILL_ARGS_WITHOUT_CLAUDE = ["-y", "--agent", ...DEFAULT_SKILL_AGENTS.filter((agent) => agent !== "claude-code")];

export interface ClaudePluginResult {
  status: "installed" | "updated" | "skipped" | "failed";
  message: string;
}

function claude(args: string[]) {
  return spawnSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
}

/** Whether `claude plugin list --json` output lists the plugin. Pure; unit-tested. */
export function isPluginListed(listJson: string, id = CLAUDE_PLUGIN_ID): boolean {
  try {
    const list = JSON.parse(listJson) as unknown;
    return Array.isArray(list) && list.some((entry) => (entry as { id?: unknown } | null)?.id === id);
  } catch {
    return false;
  }
}

/** The `claude` steps that bring the plugin to its latest commit. Pure; unit-tested. */
export function claudePluginSteps(isInstalled: boolean): string[][] {
  return isInstalled
    ? [["plugin", "marketplace", "update", "pi-review"], ["plugin", "update", CLAUDE_PLUGIN_ID]]
    : [["plugin", "install", "pi-review", "--marketplace", MARKETPLACE_SOURCE]];
}

/** Install the plugin, or update it when present. Never throws; the caller reports the result. */
export function syncClaudePlugin(): ClaudePluginResult {
  if (claude(["--version"]).status !== 0) {
    return { status: "skipped", message: "Claude Code CLI not found; skipped the Claude Code plugin" };
  }
  const isInstalled = isPluginListed(claude(["plugin", "list", "--json"]).stdout ?? "");
  for (const step of claudePluginSteps(isInstalled)) {
    process.stdout.write(`Running: claude ${step.join(" ")}\n`);
    const result = claude(step);
    if (result.status !== 0) {
      const reason = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").at(-1) ?? "";
      return { status: "failed", message: `claude ${step.join(" ")} failed${reason ? `: ${reason}` : ""}` };
    }
  }
  return isInstalled
    ? { status: "updated", message: "Claude Code plugin updated; restart Claude Code or run /reload-plugins" }
    : { status: "installed", message: "Claude Code plugin installed; restart Claude Code or run /reload-plugins" };
}

/** Drop the standalone Claude Code skill copy the plugin now replaces. */
export function removeStandaloneClaudeSkill(home = os.homedir()): void {
  if (!fs.existsSync(path.join(home, ".claude", "skills", "pi-review"))) return;
  process.stdout.write("Removing the standalone Claude Code skill; the plugin ships it now...\n");
  runUninstallSkill(["-y", "--agent", "claude-code"]);
}
