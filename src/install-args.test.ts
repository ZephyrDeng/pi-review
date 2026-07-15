import assert from "node:assert/strict";
import { test } from "vitest";
import { parseInstallCommand } from "./install-args.js";

test("install defaults to pi + agents", () => {
  const p = parseInstallCommand([]);
  assert.equal(p.command, "install");
  assert.equal(p.installPi, true);
  assert.equal(p.installAgents, true);
});

test("install --pi-only", () => {
  const p = parseInstallCommand(["--pi-only"]);
  assert.equal(p.installPi, true);
  assert.equal(p.installAgents, false);
});

test("install --agents-only forwards args", () => {
  const p = parseInstallCommand(["--agents-only", "--agent", "codex", "-y"]);
  assert.equal(p.installPi, false);
  assert.equal(p.installAgents, true);
  assert.deepEqual(p.extraArgs, ["--agent", "codex", "-y"]);
});