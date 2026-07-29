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

/** skills CLI agent ids used by default install / update. */
export const DEFAULT_SKILL_AGENTS = [
  "claude-code",
  "codex",
  "cursor",
  // Google Antigravity (agy): product + CLI flavors in the skills CLI registry.
  "antigravity",
  "antigravity-cli",
] as const;

/** Non-interactive defaults used by install / update when agents are not specified. */
export const DEFAULT_AGENT_SKILL_ARGS = ["-y", "--agent", ...DEFAULT_SKILL_AGENTS];

/** User-facing `agy` alias expands to the skills CLI agent ids. */
const AGY_ALIAS = "agy";
const AGY_SKILLS_AGENTS = ["antigravity", "antigravity-cli"] as const;
const AGY_SKILLS_AGENT_SET = new Set<string>(AGY_SKILLS_AGENTS);

export type SkillMethod = "skills-cli" | "direct";

export interface SkillOpResult {
  ok: boolean;
  method: SkillMethod;
  /** Human-readable summary for CLI boxes / logs. */
  message: string;
}

export interface DirectSkillInstallTarget {
  /** Stable id for tests / logs (`claude-code`, `agy`). */
  id: string;
  /** Human label written to stdout. */
  label: string;
  /** Absolute skill directory (contains SKILL.md). */
  dir: string;
}

/**
 * Direct-copy destinations when the skills CLI is unavailable.
 * Claude Code keeps `~/.claude/skills`; agy uses the universal path that
 * AGY / AGY CLI / AGY IDE all discover (`~/.gemini/config/skills`).
 */
export function listDirectSkillInstallTargets(home = os.homedir()): DirectSkillInstallTarget[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      dir: path.join(home, ".claude", "skills", SKILL_NAME),
    },
    {
      id: "agy",
      label: "agy (Antigravity)",
      dir: path.join(home, ".gemini", "config", "skills", SKILL_NAME),
    },
  ];
}

/**
 * Expand user-facing agent aliases before forwarding to the skills CLI.
 * `agy` → `antigravity` + `antigravity-cli` (deduped, order-preserving).
 */
export function expandSkillAgentArgs(args: string[]): string[] {
  const expanded = args.flatMap((arg) =>
    arg === AGY_ALIAS ? [...AGY_SKILLS_AGENTS] : [arg],
  );
  const seenAgents = new Set<string>();
  const out: string[] = [];
  for (const arg of expanded) {
    if (AGY_SKILLS_AGENT_SET.has(arg)) {
      if (seenAgents.has(arg)) continue;
      seenAgents.add(arg);
    }
    out.push(arg);
  }
  return out;
}

/**
 * Parse `--agent` / `-a` values (and honor `--all`) after alias expansion.
 * Returns `"all"` when no agent filter is present.
 */
export function selectedSkillAgents(args: string[]): string[] | "all" {
  const normalized = expandSkillAgentArgs(args);
  if (hasFlag(normalized, "--all")) return "all";

  const agents: string[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const token = normalized[i]!;
    if (token !== "--agent" && token !== "-a") continue;
    i += 1;
    while (i < normalized.length && !normalized[i]!.startsWith("-")) {
      agents.push(normalized[i]!);
      i += 1;
    }
    i -= 1;
  }
  return agents.length === 0 ? "all" : agents;
}

/** Map skills-CLI / user agent ids onto direct-copy targets. */
export function resolveDirectSkillInstallTargets(
  args: string[] = [],
  home = os.homedir(),
): DirectSkillInstallTarget[] {
  const all = listDirectSkillInstallTargets(home);
  const selected = selectedSkillAgents(args);
  if (selected === "all") return all;

  const want = new Set<string>();
  for (const agent of selected) {
    if (agent === "claude-code") want.add("claude-code");
    if (agent === AGY_ALIAS || AGY_SKILLS_AGENT_SET.has(agent)) want.add("agy");
  }
  return all.filter((target) => want.has(target.id));
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
  const normalized = expandSkillAgentArgs(args);
  const global = hasFlag(normalized, "-g", "--global") ? [] : ["-g"];
  const result = spawnSync(
    "npx",
    ["skills", "add", REPO, ...global, "--skill", SKILL_NAME, ...normalized],
    {
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function updateViaSkillsCli(args: string[] = []): boolean {
  const normalized = expandSkillAgentArgs(args);
  const global = hasFlag(normalized, "-g", "--global") ? [] : ["-g"];
  const yes = hasFlag(normalized, "-y", "--yes") ? [] : ["-y"];
  const result = spawnSync(
    "npx",
    ["skills", "update", SKILL_NAME, ...global, ...yes, ...normalized],
    {
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function uninstallViaSkillsCli(args: string[]): boolean {
  const normalized = expandSkillAgentArgs(args);
  const global = hasFlag(normalized, "-g", "--global") ? [] : ["-g"];
  const result = spawnSync(
    "npx",
    ["skills", "remove", SKILL_NAME, ...global, ...normalized],
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

function readPackageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function installDirect(extraArgs: string[] = []): SkillOpResult {
  if (!fs.existsSync(BUNDLED_SKILL)) {
    return {
      ok: false,
      method: "direct",
      message: `bundled SKILL.md not found at ${BUNDLED_SKILL}`,
    };
  }

  const targets = resolveDirectSkillInstallTargets(extraArgs);
  if (targets.length === 0) {
    const message =
      "direct install only supports claude-code and agy (antigravity / antigravity-cli); no matching targets";
    process.stderr.write(`${message}\n`);
    return { ok: false, method: "direct", message };
  }

  const version = readPackageVersion();
  const installed: string[] = [];
  for (const target of targets) {
    // Replace tree so references/ and other assets stay in sync with the package.
    fs.rmSync(target.dir, { recursive: true, force: true });
    copySkillTree(BUNDLED_SKILL_DIR, target.dir);
    const targetFile = path.join(target.dir, "SKILL.md");
    const line = `Installed pi-review skill v${version} to ${target.label}: ${targetFile}`;
    process.stdout.write(`${line}\n`);
    installed.push(line);
  }

  return {
    ok: true,
    method: "direct",
    message: installed.join("; "),
  };
}

function uninstallDirect(extraArgs: string[] = []): SkillOpResult {
  const targets = resolveDirectSkillInstallTargets(extraArgs);
  if (targets.length === 0) {
    const message =
      "direct uninstall only supports claude-code and agy (antigravity / antigravity-cli); no matching targets";
    process.stderr.write(`${message}\n`);
    return { ok: false, method: "direct", message };
  }

  const removed: string[] = [];
  const missing: string[] = [];
  for (const target of targets) {
    if (!fs.existsSync(target.dir)) {
      missing.push(target.label);
      continue;
    }
    fs.rmSync(target.dir, { recursive: true });
    const line = `Removed pi-review skill from ${target.label}: ${target.dir}`;
    process.stdout.write(`${line}\n`);
    removed.push(line);
  }

  if (removed.length === 0) {
    const message = "pi-review skill not found";
    process.stdout.write(`${message}\n`);
    return { ok: true, method: "direct", message };
  }

  if (missing.length > 0) {
    process.stdout.write(`Not installed for: ${missing.join(", ")}\n`);
  }

  return { ok: true, method: "direct", message: removed.join("; ") };
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

  process.stdout.write(
    "skills CLI not found, installing directly to Claude Code and/or agy (Antigravity)...\n",
  );
  return installDirect(extraArgs);
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

  process.stdout.write(
    "skills CLI not found, refreshing Claude Code and/or agy skills from package...\n",
  );
  return installDirect(extraArgs);
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

  return uninstallDirect(extraArgs);
}

export function installSkill(extraArgs: string[] = []): never {
  const result = runInstallSkill(extraArgs);
  process.exit(result.ok ? 0 : 1);
}

export function uninstallSkill(extraArgs: string[] = []): never {
  const result = runUninstallSkill(extraArgs);
  process.exit(result.ok ? 0 : 1);
}
