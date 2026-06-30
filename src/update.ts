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

export function runUpdate(): void {
  const current = getCurrentVersion();
  process.stdout.write(`当前版本: ${current}\n`);

  const latest = getLatestVersion();
  if (!latest) {
    process.stderr.write("无法从 npm registry 获取最新版本\n");
    process.exit(1);
  }

  if (current === latest) {
    process.stdout.write(`已是最新版本\n`);
    return;
  }

  process.stdout.write(`发现新版本: ${latest}\n`);
  process.stdout.write(`正在更新...\n`);

  const install = spawnSync("npm", ["install", "-g", `${PKG_NAME}@latest`], {
    encoding: "utf8",
    stdio: "inherit",
    timeout: 60_000,
  });

  if (install.status !== 0) {
    process.stderr.write("更新失败，请手动执行: npm install -g " + PKG_NAME + "@latest\n");
    process.exit(1);
  }

  process.stdout.write(`更新完成: ${current} → ${latest}\n`);
}
