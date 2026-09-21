// Pi extension loaded into pi-review child sessions via an explicit
// `--extension <path>` (runtime import of @earendil-works/pi-coding-agent is
// type-only; the loadable file itself imports nothing but this module).
//
// It makes the review child consume `.claude/rules/` with Claude Code
// semantics: unconditional rules append to the system prompt (deduped against
// Pi's built-in context files by realpath), and `paths`-scoped rules inject
// into the matching `read` tool result once per file per process. No UI, no
// commands, no tools, and no writes — discovery and injection only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverRules,
  renderMatchedReminder,
  renderUnconditionalBlock,
  ruleMatchesFile,
  type Rule,
} from "./rules.js";

export default function claudeRules(pi: ExtensionAPI): void {
  let rules: Rule[] = [];
  let discoveredCwd: string | undefined;
  // Already injected path-scoped rules (cleared after compact so they can re-inject).
  let injected = new Set<string>();

  const ensureRules = (cwd: string) => {
    if (discoveredCwd === cwd) return;
    rules = discoverRules(cwd, os.homedir());
    discoveredCwd = cwd;
    injected = new Set();
  };

  pi.on("session_start", async (_event, ctx) => {
    ensureRules(ctx.cwd);
  });

  pi.on("session_compact", async () => {
    injected = new Set(); // compact may drop injected content; re-arm
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ensureRules(ctx.cwd);
    // Dedupe unconditional rules against Pi's built-in context files
    // (AGENTS.md / CLAUDE.md) by realpath so the same file is never injected twice.
    const builtin = new Set<string>();
    for (const f of event.systemPromptOptions?.contextFiles ?? []) {
      try {
        builtin.add(fs.realpathSync(f.path));
      } catch {
        // context file missing on disk — ignore
      }
    }
    const unconditional = rules.filter((r) => r.patterns === null && !builtin.has(r.realPath));
    if (unconditional.length === 0) return;
    return { systemPrompt: event.systemPrompt + renderUnconditionalBlock(unconditional) };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return;
    const rawPath = (event.input?.file_path ?? event.input?.path) as string | undefined;
    if (!rawPath) return;
    ensureRules(ctx.cwd);
    const absFile = path.resolve(ctx.cwd, rawPath);
    const matched = rules.filter(
      (r) => r.patterns !== null && !injected.has(r.realPath) && ruleMatchesFile(r, absFile),
    );
    if (matched.length === 0) return;
    for (const r of matched) injected.add(r.realPath);
    return {
      content: [...event.content, { type: "text" as const, text: renderMatchedReminder(matched) }],
    };
  });
}
