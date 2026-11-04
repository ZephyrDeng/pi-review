// `pi-review verify <propose|show|approve|run>`: the host-side handshake for
// agent-proposed, human-approved verification (docs/design/verify-mode.md).
// Nothing here executes a plan step except `run`, which goes through the same
// approval gate as `--verify-plan`.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveConfig } from "./config.js";
import { spawnBufferedChild } from "./child-process.js";
import { buildReviewerArgs } from "./panel.js";
import { normalizePayloadRefs, splitPayload } from "./prompt.js";
import { childEnv } from "./review.js";
import { extractFinalText } from "./json-events.js";
import type { ParsedArgs } from "./types.js";
import {
  DEFAULT_MAX_FOLLOW_UP_ROUNDS,
  VERIFY_CONFIG_FILE,
  VerifyInputError,
  createApproval,
  isRunnable,
  loadRepoConfig,
  parsePlan,
  planSha256,
  resolveSteps,
  runVerification,
  type VerificationPlan,
  type VerifyRepoConfig,
} from "./verify.js";

/** `verify show` exit code: at least one step needs a human decision before it can run. */
export const APPROVAL_REQUIRED_EXIT = 5;

const VERIFY_USAGE = `Usage:
  pi-review verify propose [--model m] [--provider p] [--thinking t] -- <@files|text...>
      Read-only Pi child drafts a verification plan (JSON on stdout). Runs nothing.
  pi-review verify show <plan.json>
      Validate and list steps. Exit 0 = all pre-approved, 5 = human approval required, 2 = invalid.
  pi-review verify approve <plan.json> (--all | --steps a,b) [--reject c,d] [--by <who/how>]
      Print an approval record (JSON) bound to each step's content hash. Run only after the user decided.
  pi-review verify run [--plan <plan.json>] [--approval <file>]...
      Run approved steps in an isolated copy and print the verification summary JSON (no review).
`;

class VerifyUsageError extends Error {}

function repoConfig(cwd: string): VerifyRepoConfig {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0) return { commands: [], link: [], maxFollowUpRounds: DEFAULT_MAX_FOLLOW_UP_ROUNDS };
  return loadRepoConfig(top.stdout.trim());
}

function readPlan(file: string | undefined, config: VerifyRepoConfig): VerificationPlan {
  if (!file) throw new VerifyUsageError("a plan file is required");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new VerifyInputError(`cannot read ${file}: ${(error as Error).message}`);
  }
  return parsePlan(raw, config.maxFollowUpRounds);
}

function csv(value: string | undefined, flag: string): string[] {
  if (!value || value.startsWith("--")) throw new VerifyUsageError(`${flag} requires a value`);
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/** Human-readable plan listing; returns whether any step still needs approval. */
export function formatPlanListing(plan: VerificationPlan, config: VerifyRepoConfig): { text: string; needsApproval: boolean } {
  const resolved = resolveSteps(plan, config, []);
  const lines = [`Verification plan (proposer: ${plan.proposer ?? "host"}, sha256 ${planSha256(plan)})`];
  if (plan.summary) lines.push(plan.summary);
  for (const { step, approval, sha } of resolved) {
    lines.push("", `[${step.id}] round ${step.round ?? 1} · ${approval === "preapproved" ? `pre-approved (${VERIFY_CONFIG_FILE} at HEAD)` : "NEEDS APPROVAL"}`);
    lines.push(`  command:  ${step.argv.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(" ")}${step.cwd ? `   (cwd ${step.cwd})` : ""}`);
    lines.push(`  purpose:  ${step.purpose}`);
    if (step.expectedDurationSec !== undefined) lines.push(`  expected: ~${step.expectedDurationSec}s (timeout ${step.timeoutSec ?? 300}s)`);
    if (step.sideEffects !== undefined || step.idempotent !== undefined) {
      lines.push(`  self-assessed (not a gate): side effects: ${step.sideEffects ?? "unstated"}; idempotent: ${step.idempotent ?? "unstated"}`);
    }
    for (const file of step.files ?? []) lines.push(`  new file (isolated copy only): ${file.path} (${file.content.length} chars)`);
    lines.push(`  step sha256: ${sha}`);
  }
  const needsApproval = resolved.some((r) => !isRunnable(r.approval));
  lines.push(
    "",
    needsApproval
      ? "Approval required: show these steps to the user, then record the decision with `pi-review verify approve`."
      : "All steps are pre-approved by the committed whitelist.",
  );
  return { text: lines.join("\n"), needsApproval };
}

/** Prompt for the read-only Pi proposer; it returns the same plan format a host would write. */
export function buildProposerPrompt(target: string, config: VerifyRepoConfig): string {
  return [
    "You are drafting a verification plan for pi-review. You can only read the repository (read, grep, find, ls). Do not run, edit, or write anything.",
    "Inspect the target below, the repository's test setup, and any design docs. Propose the smallest set of commands that would confirm or refute the change's claims: targeted unit tests, type checks, lint, e2e/automation tests. If a key claim has no test, you may add one minimal repro test file via `files` (it is written only into a disposable copy).",
    "Commands run without a shell from the repository root (or `cwd`), with a minimal environment and no secrets. A human approves every step before it runs.",
    config.commands.length > 0
      ? `Standing pre-approved commands (reuse the exact argv when relevant): ${config.commands.map((c) => JSON.stringify(c.argv)).join(", ")}`
      : "There are no standing pre-approved commands.",
    'Respond with one JSON object only, no prose, in this shape:\n{"version":1,"proposer":"pi","summary":"...","steps":[{"id":"unit-x","argv":["npx","vitest","run","src/x.test.ts"],"purpose":"Claim or change this verifies","expectedDurationSec":30,"sideEffects":"...","idempotent":true,"isolated":true,"timeoutSec":120,"files":[{"path":"src/__verify__/repro.test.ts","content":"..."}]}]}',
    "`id` matches [A-Za-z0-9_.-]{1,64}; `purpose` is required; omit `files` unless you add a repro.",
    `<target>\n${target}\n</target>`,
  ].join("\n\n");
}

/** Pull the first JSON object out of model text (tolerates a ```json fence). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new VerifyInputError("proposer returned no JSON object");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new VerifyInputError(`proposer JSON did not parse: ${(error as Error).message}`);
  }
}

function runPropose(argv: string[]): number {
  const parsed: ParsedArgs = { command: "review", mode: "code", skills: [], payload: [], keepSession: false, stream: false };
  while (argv.length > 0) {
    const arg = argv.shift()!;
    if (arg === "--") {
      parsed.payload = argv.splice(0);
      break;
    }
    if (arg === "--model") parsed.model = argv.shift();
    else if (arg === "--provider") parsed.provider = argv.shift();
    else if (arg === "--thinking") parsed.thinking = argv.shift();
    else throw new VerifyUsageError(`verify propose: unknown option ${arg}`);
  }
  if (parsed.payload.length === 0) throw new VerifyUsageError("verify propose needs a target after --");
  const config = resolveConfig();
  const repo = repoConfig(process.cwd());
  const payload = normalizePayloadRefs(splitPayload(parsed.payload));
  const target = [payload.userText, ...(payload.pathTargets ?? []).map((p) => `path: ${p}`), ...(payload.attachableFileRefs ?? []).map((f) => `file: ${f}`)]
    .filter(Boolean)
    .join("\n");
  // Same hard read-only tool boundary and --no-session as panel reviewers.
  const args = buildReviewerArgs(config, parsed, {}, buildProposerPrompt(target, repo), payload.attachableFileRefs ?? [], {}, undefined, "");
  const child = spawnBufferedChild(config.piBin, args, { cwd: process.cwd(), env: childEnv(config.piBin) });
  if (child.error || (child.status ?? 0) !== 0) {
    process.stderr.write(`pi-review: verify propose: proposer child failed: ${child.error?.message ?? `exit ${child.status}`}\n${child.stderr ?? ""}`);
    return 4;
  }
  const text = extractFinalText(child.stdout || "").text;
  let plan: VerificationPlan;
  try {
    const raw = extractJsonObject(text) as Record<string, unknown>;
    plan = parsePlan({ ...raw, proposer: "pi" }, repo.maxFollowUpRounds);
  } catch (error) {
    process.stderr.write(`pi-review: verify propose: ${(error as Error).message}\n--- proposer output ---\n${text}\n`);
    return 4;
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return 0;
}

async function dispatch(input: string[]): Promise<number> {
  const argv = [...input];
  const sub = argv.shift();
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(VERIFY_USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "propose":
      return runPropose(argv);
    case "show": {
      const config = repoConfig(process.cwd());
      const listing = formatPlanListing(readPlan(argv[0], config), config);
      process.stdout.write(`${listing.text}\n`);
      return listing.needsApproval ? APPROVAL_REQUIRED_EXIT : 0;
    }
    case "approve": {
      const file = argv.shift();
      const options: Parameters<typeof createApproval>[1] = {};
      while (argv.length > 0) {
        const arg = argv.shift()!;
        if (arg === "--all") options.all = true;
        else if (arg === "--steps") options.approve = csv(argv.shift(), arg);
        else if (arg === "--reject") options.reject = csv(argv.shift(), arg);
        else if (arg === "--by") options.by = argv.shift();
        else throw new VerifyUsageError(`verify approve: unknown option ${arg}`);
      }
      const plan = readPlan(file, repoConfig(process.cwd()));
      process.stdout.write(`${JSON.stringify(createApproval(plan, options), null, 2)}\n`);
      return 0;
    }
    case "run": {
      let planFile: string | undefined;
      const approvalFiles: string[] = [];
      while (argv.length > 0) {
        const arg = argv.shift()!;
        if (arg === "--plan") planFile = argv.shift();
        else if (arg === "--approval") approvalFiles.push(...csv(argv.shift(), arg));
        else throw new VerifyUsageError(`verify run: unknown option ${arg}`);
      }
      const summary = await runVerification({
        cwd: process.cwd(),
        ...(planFile ? { planFile } : {}),
        approvalFiles,
        onLog: (line) => process.stderr.write(`${line}\n`),
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    default:
      throw new VerifyUsageError(`unknown verify command: ${sub}`);
  }
}

export async function runVerifyCommand(input: string[]): Promise<never> {
  try {
    process.exit(await dispatch(input));
  } catch (error) {
    if (error instanceof VerifyUsageError || error instanceof VerifyInputError) {
      process.stderr.write(`pi-review: ${error.message}\n`);
      if (error instanceof VerifyUsageError) process.stderr.write(VERIFY_USAGE);
      process.exit(2);
    }
    throw error;
  }
}
