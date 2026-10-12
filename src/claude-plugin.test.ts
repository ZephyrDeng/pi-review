import assert from "node:assert/strict";
import { test } from "vitest";
import { CLAUDE_PLUGIN_ID, claudePluginSteps, isPluginListed, SKILL_ARGS_WITHOUT_CLAUDE } from "./claude-plugin.js";

test("isPluginListed finds the plugin id in `claude plugin list --json`", () => {
  assert.equal(isPluginListed(JSON.stringify([{ id: "other@x" }, { id: CLAUDE_PLUGIN_ID }])), true);
  assert.equal(isPluginListed(JSON.stringify([{ id: "other@x" }])), false);
  assert.equal(isPluginListed("not json"), false);
  assert.equal(isPluginListed(JSON.stringify({ id: CLAUDE_PLUGIN_ID })), false);
});

test("claudePluginSteps installs once, then refreshes the marketplace before updating", () => {
  assert.deepEqual(claudePluginSteps(false), [["plugin", "install", "pi-review", "--marketplace", "ZephyrDeng/pi-review"]]);
  assert.deepEqual(claudePluginSteps(true), [
    ["plugin", "marketplace", "update", "pi-review"],
    ["plugin", "update", CLAUDE_PLUGIN_ID],
  ]);
});

test("skill refresh args leave Claude Code to the plugin", () => {
  assert.equal(SKILL_ARGS_WITHOUT_CLAUDE.includes("claude-code"), false);
  assert.ok(SKILL_ARGS_WITHOUT_CLAUDE.includes("codex"));
});
