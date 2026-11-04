// CLI-level verify tests: the show/approve/run handshake and end-to-end
// injection into single, panel, and loop reviews. Pi is a fake script; no
// network, no real model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { buildProposerPrompt, extractJsonObject } from "./verify-cli.js";

const NODE = process.execPath;
const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const tsxLoader = pathToFileURL(path.join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function makeRepo(whitelist?: object): string {
  const dir = tmp("pi-review-verify-cli-repo-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  if (whitelist) fs.writeFileSync(path.join(dir, ".pi-review.json"), JSON.stringify(whitelist));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello, uncommitted\n");
  return dir;
}

function writeFakePi(dir: string, reply: string): { bin: string; argvDir: string } {
  const argvDir = path.join(dir, "argv");
  fs.mkdirSync(argvDir);
  const bin = path.join(dir, "fake-pi");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(${JSON.stringify(argvDir)}, process.pid + "-" + Date.now() + ".json"), JSON.stringify(process.argv.slice(2)));
const text = ${JSON.stringify(reply)};
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
line({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
`);
  fs.chmodSync(bin, 0o755);
  return { bin, argvDir };
}

const APPROVE = "## Verdict\napprove\n\n## Summary\n- ok\n\n## Findings\nNo material findings.\n";
const FINDINGS = "## Verdict\nrequest_changes\n\n## Summary\n- x\n\n## Findings\n### F1: Gate\n- Severity: high\n- Path: a.txt\n- Actionable: yes\n- Evidence: test-output count\n- Impact: x\n- Recommendation: y\n";

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const fullEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete fullEnv.TYPESAFE_API_KEY;
  delete fullEnv.PI_REVIEW_META_STDOUT;
  return spawnSync(NODE, ["--import", tsxLoader, path.join(repoRoot, "src/cli.ts"), ...args], { cwd, env: fullEnv, encoding: "utf8", timeout: 60_000, input: "" });
}

function meta(stderr: string) {
  const line = stderr.split("\n").find((l) => l.startsWith("PI_REVIEW_META_JSON: "));
  assert.ok(line, stderr);
  return JSON.parse(line.slice("PI_REVIEW_META_JSON: ".length));
}

function prompts(argvDir: string): string[] {
  return fs.readdirSync(argvDir).map((name) => (JSON.parse(fs.readFileSync(path.join(argvDir, name), "utf8")) as string[]).at(-1)!);
}

/** A step that appends one line per execution to a counter file outside the repo. */
function counterStep(counter: string) {
  return { id: "count", argv: [NODE, "-e", `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');console.log('VERIFY_OK '+fs.readFileSync('a.txt','utf8').trim())`], purpose: "Claim: a.txt carries the uncommitted edit" };
}

test("verify show exits 5 when approval is needed and 0 when everything is pre-approved", () => {
  const repo = makeRepo({ verify: { commands: [{ id: "check", argv: ["npm", "run", "check"] }] } });
  const io = tmp("pi-review-verify-cli-io-");
  const plan = path.join(io, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [{ id: "check", argv: ["npm", "run", "check"], purpose: "types" }, { id: "unit", argv: ["npm", "test"], purpose: "tests", sideEffects: "none", idempotent: true }] }));
  const needs = cli(repo, ["verify", "show", plan]);
  assert.equal(needs.status, 5, needs.stderr);
  assert.match(needs.stdout, /\[check\] round 1 · pre-approved/);
  assert.match(needs.stdout, /\[unit\] round 1 · NEEDS APPROVAL/);
  assert.match(needs.stdout, /self-assessed \(not a gate\)/);
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [{ id: "check", argv: ["npm", "run", "check"], purpose: "types" }] }));
  assert.equal(cli(repo, ["verify", "show", plan]).status, 0);
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [{ id: "x", argv: ["a"], purpose: "p", isolated: false }] }));
  const invalid = cli(repo, ["verify", "show", plan]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /isolated=false/);
});

test("plan -> approve -> single review: reviewer prompt carries approved results, meta records approval hashes", () => {
  const repo = makeRepo();
  const io = tmp("pi-review-verify-cli-io-");
  const counter = path.join(io, "count");
  const plan = path.join(io, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [counterStep(counter)] }));
  const approve = cli(repo, ["verify", "approve", plan, "--all", "--by", "user via test"]);
  assert.equal(approve.status, 0, approve.stderr);
  const approval = path.join(io, "approval.json");
  fs.writeFileSync(approval, approve.stdout);

  const fake = writeFakePi(io, APPROVE);
  const status = git(repo, "status", "--porcelain");
  const run = cli(repo, ["--no-stream", "--verify-plan", plan, "--verify-approval", approval, "--", "@a.txt"], { PI_BIN: fake.bin });
  assert.equal(run.status, 0, run.stderr);
  const [prompt] = prompts(fake.argvDir);
  assert.match(prompt!, /## Verification evidence \(source type: test-output\)/);
  assert.match(prompt!, /approved by a human before it ran/);
  assert.match(prompt!, /VERIFY_OK hello, uncommitted/);
  const m = meta(run.stderr);
  assert.equal(m.verification.status, "passed");
  assert.equal(m.verification.source, "test-output");
  assert.equal(m.verification.approvals[0].approvedBy, "user via test");
  assert.equal(m.verification.steps[0].approval, "approved");
  assert.equal(m.verification.steps[0].stepSha256, JSON.parse(approve.stdout).decisions[0].stepSha256);
  assert.match(run.stdout, /Verify\s+passed · 1 run \/ 0 not run/);
  assert.equal(git(repo, "status", "--porcelain"), status);
});

test("--verify-plan without approval runs nothing and says so in prompt and meta", () => {
  const repo = makeRepo();
  const io = tmp("pi-review-verify-cli-io-");
  const counter = path.join(io, "count");
  const plan = path.join(io, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [counterStep(counter)] }));
  const fake = writeFakePi(io, APPROVE);
  const run = cli(repo, ["--no-stream", "--verify-plan", plan, "--", "@a.txt"], { PI_BIN: fake.bin });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(counter), false);
  assert.match(prompts(fake.argvDir)[0]!, /Treat build, type-check, lint, and test status as UNVERIFIED/);
  const m = meta(run.stderr);
  assert.equal(m.verification.status, "unverified");
  assert.equal(m.verification.steps[0].status, "skipped_unapproved");
});

test("panel: verification runs once and every reviewer receives the identical section", () => {
  const repo = makeRepo();
  const io = tmp("pi-review-verify-cli-io-");
  const counter = path.join(io, "count");
  const plan = path.join(io, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [counterStep(counter)] }));
  const approval = path.join(io, "approval.json");
  fs.writeFileSync(approval, cli(repo, ["verify", "approve", plan, "--all"]).stdout);
  const fake = writeFakePi(io, APPROVE);
  const run = cli(repo, ["--reviewers", "3", "--verify-plan", plan, "--verify-approval", approval, "--", "@a.txt"], { PI_BIN: fake.bin });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(counter, "utf8"), "x", "verification must run exactly once per panel");
  const sections = prompts(fake.argvDir).map((p) => p.slice(p.indexOf("## Verification evidence")));
  assert.equal(sections.length, 3);
  assert.equal(new Set(sections).size, 1);
  assert.match(sections[0]!, /VERIFY_OK/);
  const m = meta(run.stderr);
  assert.equal(m.strategy, "panel");
  assert.equal(m.verification.status, "passed");
  for (const argv of fs.readdirSync(fake.argvDir).map((n) => JSON.parse(fs.readFileSync(path.join(fake.argvDir, n), "utf8")) as string[])) {
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls", "reviewer tools must stay read-only");
  }
});

test("loop re-verifies every round (no cached results)", () => {
  const repo = makeRepo();
  const io = tmp("pi-review-verify-cli-io-");
  const counter = path.join(io, "count");
  const plan = path.join(io, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ version: 1, steps: [counterStep(counter)] }));
  const approval = path.join(io, "approval.json");
  fs.writeFileSync(approval, cli(repo, ["verify", "approve", plan, "--all"]).stdout);
  const fake = writeFakePi(io, FINDINGS);
  const run = cli(repo, ["loop", "--no-stream", "--max-rounds", "2", "--verify-plan", plan, "--verify-approval", approval, "--", "@a.txt"], { PI_BIN: fake.bin });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx", "one verification per loop round");
});

test("verify run prints a summary without starting any reviewer", () => {
  const repo = makeRepo({ verify: { commands: [{ id: "ok", argv: [NODE, "-e", "console.log('fine')"] }] } });
  const run = cli(repo, ["verify", "run"], { PI_BIN: "/nonexistent/pi" });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.status, "passed");
  assert.equal(summary.proposer, "whitelist");
});

test("verify propose: read-only Pi child drafts a plan in the shared format", () => {
  const repo = makeRepo();
  const io = tmp("pi-review-verify-cli-io-");
  const proposed = { version: 1, steps: [{ id: "unit", argv: ["npm", "test"], purpose: "claim" }] };
  const fake = writeFakePi(io, "```json\n" + JSON.stringify(proposed) + "\n```");
  const run = cli(repo, ["verify", "propose", "--", "@a.txt", "check the edit"], { PI_BIN: fake.bin });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.proposer, "pi");
  assert.equal(plan.steps[0].id, "unit");
  const argv = JSON.parse(fs.readFileSync(path.join(fake.argvDir, fs.readdirSync(fake.argvDir)[0]!), "utf8")) as string[];
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.ok(argv.includes("--no-session"));

  const garbage = writeFakePi(tmp("pi-review-verify-cli-io-"), "I think you should run the tests.");
  const bad = cli(repo, ["verify", "propose", "--", "@a.txt"], { PI_BIN: garbage.bin });
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /no JSON object/);
});

test("proposer prompt lists the standing whitelist; JSON extraction tolerates fences", () => {
  const prompt = buildProposerPrompt("file: @a.ts", { commands: [{ id: "c", argv: ["npm", "run", "check"] }], link: [], maxFollowUpRounds: 1 });
  assert.match(prompt, /\["npm","run","check"\]/);
  assert.match(prompt, /Do not run, edit, or write anything/);
  assert.deepEqual(extractJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
});
