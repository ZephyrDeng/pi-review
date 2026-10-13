// The Claude Code plugin lives in claude-plugin/, a folder with no package.json
// or lockfile, so installing it never runs `npm ci` over the repo's dev tree.
// Its hooks import the panel reducer and ship the skill from copies made here;
// src/claude-plugin-sync.test.ts fails when a copy drifts from its source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "claude-plugin");
const VENDOR = ["panel-view.ts", "panel-usage.ts", "review-events.ts", "types.ts"];

fs.rmSync(path.join(plugin, "vendor"), { recursive: true, force: true });
fs.mkdirSync(path.join(plugin, "vendor"));
for (const name of VENDOR) fs.copyFileSync(path.join(root, "src", name), path.join(plugin, "vendor", name));

fs.rmSync(path.join(plugin, "skills"), { recursive: true, force: true });
fs.cpSync(path.join(root, "skills"), path.join(plugin, "skills"), { recursive: true });
