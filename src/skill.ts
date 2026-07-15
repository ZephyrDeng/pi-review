import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BUNDLED_SKILL_DIR = path.join(PACKAGE_ROOT, "skills", "pi-review");
const BUNDLED_SKILL = path.join(BUNDLED_SKILL_DIR, "SKILL.md");
const REPO = "ZephyrDeng/pi-review";
const SKILL_NAME = "pi-review";

/** Non-interactive defaults used by install / update when agents are not specified. */
export const DEFAULT_AGENT_SKILL_ARGS = ["-y", "--agent", "claude-code", "codex", "cursor"];

export type SkillMethod = "skills-cli" | "direct";

export interface SkillOpResult {
  ok: boolean;
  method: SkillMethod;
  /** Human-readable summary for CLI boxes / logs. */
  message: string;
}

function hasSkillsCli(): boolean {
  const result = spawnSync("npx", ["skills", "--version"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "pipe",
  });
  return result.status === 0;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

function installViaSkillsCli(args: string[]): boolean {
  const global = hasFlag(args, "-g", "--global") ? [] : ["-g"];
  const result = spawnSync(
    "npx",
    ["skills", "add", REPO, ...global, "--skill", SKILL_NAME, ...args],
    {
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function updateViaSkillsCli(args: string[] = []): boolean {
  const global = hasFlag(args, "-g", "--global") ? [] : ["-g"];
  const yes = hasFlag(args, "-y", "--yes") ? [] : ["-y"];
  const result = spawnSync(
    "npx",
    ["skills", "update", SKILL_NAME, ...global, ...yes, ...args],
    {
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function uninstallViaSkillsCli(args: string[]): boolean {
  const global = hasFlag(args, "-g", "--global") ? [] : ["-g"];
  const result = spawnSync(
    "npx",
    ["skills", "remove", SKILL_NAME, ...global, ...args],
    {
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function copySkillTree(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copySkillTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function installDirect(): SkillOpResult {
  if (!fs.existsSync(BUNDLED_SKILL)) {
    return {
      ok: false,
      method: "direct",
      message: `bundled SKILL.md not found at ${BUNDLED_SKILL}`,
    };
  }

  const targetDir = path.join(os.homedir(), ".claude", "skills", "pi-review");
  // Replace tree so references/ and other assets stay in sync with the package.
  fs.rmSync(targetDir, { recursive: true, force: true });
  copySkillTree(BUNDLED_SKILL_DIR, targetDir);

  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const targetFile = path.join(targetDir, "SKILL.md");
  const message = `Installed pi-review skill v${pkg.version} to ${targetFile}`;
  process.stdout.write(`${message}\n`);
  return { ok: true, method: "direct", message };
}

function uninstallDirect(): SkillOpResult {
  const targetDir = path.join(os.homedir(), ".claude", "skills", "pi-review");
  if (!fs.existsSync(targetDir)) {
    const message = "pi-review skill not found";
    process.stdout.write(`${message}\n`);
    return { ok: true, method: "direct", message };
  }
  fs.rmSync(targetDir, { recursive: true });
  const message = `Removed pi-review skill from ${targetDir}`;
  process.stdout.write(`${message}\n`);
  return { ok: true, method: "direct", message };
}

/**
 * Install agent skill content. Does not exit — callers decide process lifecycle.
 */
export function runInstallSkill(extraArgs: string[] = []): SkillOpResult {
  if (hasSkillsCli()) {
    const ok = installViaSkillsCli(extraArgs);
    return {
      ok,
      method: "skills-cli",
      message: ok ? "Installed pi-review skill via skills CLI" : "skills CLI install failed",
    };
  }

  process.stdout.write("skills CLI not found, installing to Claude Code directly...\n");
  return installDirect();
}

/**
 * Refresh already-installed skill content to the latest version.
 * Uses `skills update` when available; falls back to reinstall / direct copy.
 */
export function runUpdateSkill(extraArgs: string[] = []): SkillOpResult {
  if (hasSkillsCli()) {
    process.stdout.write("Updating pi-review skill via skills CLI...\n");
    if (updateViaSkillsCli(extraArgs)) {
      return {
        ok: true,
        method: "skills-cli",
        message: "Updated pi-review skill via skills CLI",
      };
    }

    // Not installed yet (or update path failed) — install non-interactively.
    process.stdout.write("Skill update missed; reinstalling pi-review skill...\n");
    const args = extraArgs.length > 0 ? extraArgs : DEFAULT_AGENT_SKILL_ARGS;
    const ok = installViaSkillsCli(args);
    return {
      ok,
      method: "skills-cli",
      message: ok
        ? "Reinstalled pi-review skill via skills CLI"
        : "skills CLI skill update/install failed",
    };
  }

  process.stdout.write("skills CLI not found, refreshing Claude Code skill from package...\n");
  return installDirect();
}

/**
 * Uninstall agent skill content. Does not exit — callers decide process lifecycle.
 */
export function runUninstallSkill(extraArgs: string[] = []): SkillOpResult {
  if (hasSkillsCli()) {
    const ok = uninstallViaSkillsCli(extraArgs);
    return {
      ok,
      method: "skills-cli",
      message: ok ? "Removed pi-review skill via skills CLI" : "skills CLI remove failed",
    };
  }

  return uninstallDirect();
}

export function installSkill(extraArgs: string[] = []): never {
  const result = runInstallSkill(extraArgs);
  process.exit(result.ok ? 0 : 1);
}

export function uninstallSkill(extraArgs: string[] = []): never {
  const result = runUninstallSkill(extraArgs);
  process.exit(result.ok ? 0 : 1);
}
