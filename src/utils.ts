import os from "node:os";
import path from "node:path";

export function fail(message: string, exitCode = 2): never {
  process.stderr.write(`pi-review: ${message}\n`);
  process.exit(exitCode);
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || (process.platform === "win32" && /[\\:]/.test(value));
}

export function expandMaybeHome(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function normalizeTools(tools: string[] | string | undefined): string | undefined {
  if (!tools) return undefined;
  if (Array.isArray(tools)) return tools.join(",");
  return String(tools);
}
