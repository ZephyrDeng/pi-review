import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runUpdateSkill } from "./skill.js";

const PKG_NAME = "@zephyrdeng/pi-review";

function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

function getLatestVersion(): string | null {
  const result = spawnSync("npm", ["view", PKG_NAME, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function box(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const pad = (s: string) => s + " ".repeat(width - s.length);
  const top = `╭${"─".repeat(width + 2)}╮`;
  const bot = `╰${"─".repeat(width + 2)}╯`;
  const empty = `│${" ".repeat(width + 2)}│`;
  const body = lines.map((l) => `│ ${pad(l)} │`).join("\n");
  return `${top}\n${empty}\n${body}\n${empty}\n${bot}\n`;
}

function refreshSkill(): boolean {
  const skill = runUpdateSkill();
  if (!skill.ok) {
    process.stderr.write(
      box([
        "Skill refresh failed.",
        "",
        "Retry with:",
        "  pi-review install-skill",
      ]),
    );
    return false;
  }
  return true;
}

export function runUpdate(): void {
  const current = getCurrentVersion();

  const latest = getLatestVersion();
  if (!latest) {
    process.stderr.write(box(["Failed to fetch latest version from npm registry"]));
    process.exit(1);
  }

  let packageLine: string;
  if (current === latest) {
    packageLine = `Package already up to date (v${current})`;
    process.stdout.write(
      box([
        `pi-review v${current}`,
        "",
        "Package already up to date ✓",
        "Refreshing agent skill...",
      ]),
    );
  } else {
    process.stdout.write(
      box([
        `Update available: ${current} → ${latest}`,
        "",
        "Updating package...",
      ]),
    );

    const install = spawnSync("npm", ["install", "-g", `${PKG_NAME}@latest`], {
      encoding: "utf8",
      stdio: "inherit",
      timeout: 60_000,
    });

    if (install.status !== 0) {
      process.stderr.write(
        box([
          "Update failed. Run manually:",
          "",
          `npm install -g ${PKG_NAME}@latest`,
        ]),
      );
      process.exit(1);
    }

    packageLine = `Package updated: ${current} → ${latest}`;
    process.stdout.write(
      box([
        packageLine,
        "",
        "Refreshing agent skill...",
      ]),
    );
  }

  // skills CLI pulls latest skill content from the source repo; the direct
  // fallback copies from this package tree (refreshed on disk after npm -g).
  const skillOk = refreshSkill();

  process.stdout.write(
    box([
      packageLine,
      skillOk ? "Skill refreshed ✓" : "Skill refresh failed",
      "",
      skillOk ? "Done ✓" : "Package ok; skill needs manual install-skill",
    ]),
  );
  process.exit(skillOk ? 0 : 1);
}
