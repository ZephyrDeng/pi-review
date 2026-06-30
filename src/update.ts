import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const PKG_NAME = "@zephyrdeng/pi-review";

function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json");
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

export function runUpdate(): void {
  const current = getCurrentVersion();

  const latest = getLatestVersion();
  if (!latest) {
    process.stderr.write(box(["Failed to fetch latest version from npm registry"]));
    process.exit(1);
  }

  if (current === latest) {
    process.stdout.write(box([
      `pi-review v${current}`,
      "",
      "Already up to date ✓",
    ]));
    return;
  }

  process.stdout.write(box([
    `Update available: ${current} → ${latest}`,
    "",
    "Updating...",
  ]));

  const install = spawnSync("npm", ["install", "-g", `${PKG_NAME}@latest`], {
    encoding: "utf8",
    stdio: "inherit",
    timeout: 60_000,
  });

  if (install.status !== 0) {
    process.stderr.write(box([
      "Update failed. Run manually:",
      "",
      `npm install -g ${PKG_NAME}@latest`,
    ]));
    process.exit(1);
  }

  process.stdout.write(box([
    `Updated: ${current} → ${latest}`,
    "",
    "Done ✓",
  ]));
}
