import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "claude-plugin");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

const STALE = "claude-plugin copies are stale: run `node scripts/sync-claude-plugin.mjs`";

test("claude-plugin/vendor matches src/", () => {
  for (const name of files(path.join(plugin, "vendor"))) {
    assert.equal(fs.readFileSync(path.join(plugin, "vendor", name), "utf8"), fs.readFileSync(path.join(root, "src", name), "utf8"), `${name}: ${STALE}`);
  }
});

test("claude-plugin/skills matches skills/", () => {
  const source = path.join(root, "skills");
  const copy = path.join(plugin, "skills");
  assert.deepEqual(files(copy), files(source), STALE);
  for (const name of files(source)) {
    assert.equal(fs.readFileSync(path.join(copy, name), "utf8"), fs.readFileSync(path.join(source, name), "utf8"), `${name}: ${STALE}`);
  }
});

test("the plugin folder carries no package manifest, so installing it runs no npm ci", () => {
  for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb"]) {
    assert.equal(fs.existsSync(path.join(plugin, name)), false, `claude-plugin/${name} must not exist`);
  }
});
