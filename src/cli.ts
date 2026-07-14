#!/usr/bin/env node
import { isInstallHelp, parseInstallCommand } from "./install-args.js";
import { isPanelActive, parseArgs, usage } from "./args.js";
import { readReviewStdin, runModels, runReview, runReviewOnce } from "./review.js";
import { formatLoopSummary, runReviewLoop } from "./loop.js";
import { runPanelReview, runPanelReviewOnce } from "./panel.js";
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
} else if (parsed.command === "loop") {
  const stdinText = readReviewStdin();
  const runOne = isPanelActive(parsed)
    ? () => runPanelReviewOnce(parsed, stdinText)
    : () => runReviewOnce(parsed, stdinText);
  const result = await runReviewLoop(parsed.maxRounds!, runOne);
  process.stdout.write(`${formatLoopSummary(result)}\n`);
  process.exit(result.exitCode);
} else if (isPanelActive(parsed)) {
  await runPanelReview(parsed);
} else {
  await runReview(parsed);
}
