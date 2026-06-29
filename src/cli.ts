#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { runModels, runReview } from "./review.js";
import { resolveConfig } from "./config.js";
import { installSkill, uninstallSkill } from "./skill.js";

const parsed = parseArgs(process.argv.slice(2));

if (parsed.command === "models") {
  const config = resolveConfig();
  runModels(config.piBin, parsed.search || []);
} else if (parsed.command === "install-skill") {
  installSkill();
} else if (parsed.command === "uninstall-skill") {
  uninstallSkill();
} else {
  runReview(parsed);
}
