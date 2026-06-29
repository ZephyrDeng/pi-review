import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BUNDLED_SKILL = path.join(PACKAGE_ROOT, "skills", "pi-review", "SKILL.md");

export function installSkill(): never {
  const targetDir = path.join(os.homedir(), ".claude", "skills", "pi-review");
  const targetFile = path.join(targetDir, "SKILL.md");

  if (!fs.existsSync(BUNDLED_SKILL)) {
    process.stderr.write(`pi-review: bundled SKILL.md not found at ${BUNDLED_SKILL}\n`);
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(BUNDLED_SKILL, targetFile);

  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  process.stdout.write(`Installed pi-review skill v${pkg.version} to ${targetFile}\n`);
  process.exit(0);
}

export function uninstallSkill(): never {
  const targetDir = path.join(os.homedir(), ".claude", "skills", "pi-review");
  const targetFile = path.join(targetDir, "SKILL.md");

  if (!fs.existsSync(targetFile)) {
    process.stdout.write(`pi-review skill not found at ${targetFile}\n`);
    process.exit(0);
  }

  fs.rmSync(targetDir, { recursive: true });
  process.stdout.write(`Removed pi-review skill from ${targetDir}\n`);
  process.exit(0);
}
