import fs from "node:fs";
import path from "node:path";

export function makeRunSessionDir(sessionsRoot: string, mode: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeMode = mode.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const dir = path.join(sessionsRoot, `${stamp}_${process.pid}_${safeMode}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listJsonlFiles(dir: string): string[] {
  const result: string[] = [];
  if (!dir || !fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listJsonlFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(full);
  }
  return result;
}

export function newestJsonl(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const files = listJsonlFiles(dir);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}
