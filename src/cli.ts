#!/usr/bin/env node
import { parseArgs, usage } from "./args.js";
import { isInstallHelp } from "./install-args.js";
import { runModels, runReview } from "./review.js";
import { resolveConfig } from "./config.js";
import { installSkill, uninstallSkill } from "./skill.js";
import { runUpdate } from "./update.js";
import { runInstall } from "./install.js";

const parsed = parseArgs(process.argv.slice(2));
if (isInstallHelp(parsed)) usage(0);

if (parsed.command === "models") {
  const config = resolveConfig();
  runModels(config.piBin, parsed.search || []);
} else if (parsed.command === "update") {
  runUpdate();
} else if (parsed.command === "install") {
  runInstall({
    pi: parsed.installPi !== false,
    agents: parsed.installAgents !== false,
    agentArgs: parsed.extraArgs ?? [],
  });
} else if (parsed.command === "install-skill") {
  installSkill(parsed.extraArgs);
} else if (parsed.command === "uninstall-skill") {
  uninstallSkill(parsed.extraArgs);
} else {
  await runReview(parsed);
}
