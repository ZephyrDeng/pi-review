import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import path from "node:path";

const KNOWN_MODES = new Set(["code", "plan", "challenge"]);

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function normalizeReviewArgs(args: string[]): string[] {
  if (args.length === 0) return args;
  const first = args[0];
  if (first === "models" || first === "--" || first.startsWith("--") || KNOWN_MODES.has(first)) {
    return args;
  }
  return ["--", ...args];
}

export default function piReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("pi-review", {
    description: "Run an isolated pi-review session. Usage: /pi-review [--mode challenge] @file-or-text",
    getArgumentCompletions: (prefix) => {
      const items = [
        "@",
        "--mode challenge",
        "--mode plan",
        "--keep-session",
        "models",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (rawArgs, ctx) => {
      const cliPath = path.resolve(__dirname, "../bin/pi-review.js");
      const parsedArgs = normalizeReviewArgs(splitArgs(rawArgs.trim()));

      if (parsedArgs.length === 0) {
        ctx.ui.notify("Usage: /pi-review [--mode challenge] @file-or-text", "warning");
        return;
      }

      ctx.ui.notify("Running isolated pi-review session...", "info");
      const result = spawnSync(process.execPath, [cliPath, ...parsedArgs], {
        cwd: ctx.cwd || process.cwd(),
        env: process.env,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      });

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";
      const content = [stdout, stderr ? `\n\n--- stderr ---\n${stderr}` : ""].join("").trim();
      const status = result.status ?? (result.error ? 1 : 0);

      pi.sendMessage({
        customType: "pi-review",
        content: content || `pi-review exited with status ${status}`,
        display: true,
        details: {
          argv: parsedArgs,
          status,
          error: result.error?.message,
        },
      });

      if (status === 0) {
        ctx.ui.notify("pi-review completed", "info");
      } else {
        ctx.ui.notify(`pi-review failed with status ${status}`, "error");
      }
    },
  });
}
