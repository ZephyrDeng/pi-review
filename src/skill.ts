import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BUNDLED_SKILL = path.join(PACKAGE_ROOT, "skills", "pi-review", "SKILL.md");
const REPO = "ZephyrDeng/pi-review";

function hasSkillsCli(): boolean {
  const result = spawnSync("npx", ["skills", "--version"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
  return result.status === 0;
}

function installViaSkillsCli(args: string[]): boolean {
  const global = args.includes("-g") || args.includes("--global") ? [] : ["-g"];
  const result = spawnSync("npx", ["skills", "add", REPO, ...global, "--skill", "pi-review", ...args], {
    stdio: "inherit",
    encoding: "utf8",
  });
  return result.status === 0;
}

function uninstallViaSkillsCli(args: string[]): boolean {
  const global = args.includes("-g") || args.includes("--global") ? [] : ["-g"];
  const result = spawnSync("npx", ["skills", "remove", "pi-review", ...global, ...args], {
    stdio: "inherit",
    encoding: "utf8",
  });
  return result.status === 0;
}

function installDirect(): void {
  if (!fs.existsSync(BUNDLED_SKILL)) {
    process.stderr.write(`pi-review: bundled SKILL.md not found at ${BUNDLED_SKILL}\n`);
    process.exit(1);
  }

  const targetDir = path.join(os.homedir(), ".claude", "skills", "pi-review");
  const targetFile = path.join(targetDir, "SKILL.md");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(BUNDLED_SKILL, targetFile);

  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  process.stdout.write(`Installed pi-review skill v${pkg.version} to ${targetFile}\n`);
}

function uninstallDirect(): void {
  const targetDir = path.join(os.homedir(), ".claude", "skills", "pi-review");
  if (!fs.existsSync(targetDir)) {
    process.stdout.write("pi-review skill not found\n");
    process.exit(0);
  }
  fs.rmSync(targetDir, { recursive: true });
  process.stdout.write(`Removed pi-review skill from ${targetDir}\n`);
}

export function installSkill(extraArgs: string[] = []): never {
  if (hasSkillsCli()) {
    const ok = installViaSkillsCli(extraArgs);
    process.exit(ok ? 0 : 1);
  }

  process.stdout.write("skills CLI not found, installing to Claude Code directly...\n");
  installDirect();
  process.exit(0);
}

export function uninstallSkill(extraArgs: string[] = []): never {
  if (hasSkillsCli()) {
    const ok = uninstallViaSkillsCli(extraArgs);
    process.exit(ok ? 0 : 1);
  }

  uninstallDirect();
  process.exit(0);
}
