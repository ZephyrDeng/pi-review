import { spawnSync } from "node:child_process";
import { DEFAULT_AGENT_SKILL_ARGS, installSkill } from "./skill.js";

const PI_PACKAGE = "npm:@zephyrdeng/pi-review";

function hasPiCli(): boolean {
  const result = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
  return result.status === 0;
}

function runPiInstall(): boolean {
  if (!hasPiCli()) {
    process.stderr.write(
      "pi-review install: Pi CLI not found — skipped Pi package. Install Pi from https://pi.dev then: pi install npm:@zephyrdeng/pi-review\n",
    );
    return false;
  }

  process.stdout.write(`Running: pi install ${PI_PACKAGE}\n`);
  const result = spawnSync("pi", ["install", PI_PACKAGE], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`pi-review install: pi install failed (exit ${result.status ?? "unknown"})\n`);
    return false;
  }
  process.stdout.write(
    "Pi: npm package registered (/rv extension + skill via pi.skills — no extra copy under ~/.agents for Pi).\n",
  );
  return true;
}

export interface InstallOptions {
  pi: boolean;
  agents: boolean;
  /** Forwarded to install-skill / skills CLI (e.g. --agent codex -y). */
  agentArgs: string[];
}

export function runInstall(options: InstallOptions): never {
  if (!options.pi && !options.agents) {
    process.stderr.write("pi-review install: nothing to do\n");
    process.exit(2);
  }

  let piOk = true;
  if (options.pi) {
    piOk = runPiInstall();
  }

  if (options.agents) {
    const args = options.agentArgs.length > 0 ? options.agentArgs : DEFAULT_AGENT_SKILL_ARGS;
    process.stdout.write(`Running: pi-review install-skill ${args.join(" ")}\n`);
    installSkill(args);
  }

  process.exit(piOk ? 0 : 1);
}