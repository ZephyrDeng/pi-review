// Regression guard for --verify being strictly opt-in: with the flag absent,
// the reviewer argv (which carries the full prompt) and PI_REVIEW_META_JSON
// must stay byte-identical to the pre-verify base (16855bc). The inline
// snapshots below were recorded on that base before any verify code existed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
let tempDir = "";
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function writeFixtures(dir: string) {
  const presets = path.join(dir, "presets.json");
  fs.writeFileSync(presets, JSON.stringify({ code: { description: "fixture", tools: "read,grep,find,ls", instructions: "Fixture instructions." } }));
  const systemPrompt = path.join(dir, "system.md");
  fs.writeFileSync(systemPrompt, "Fixture system prompt.");
  const argvDir = path.join(dir, "argv");
  fs.mkdirSync(argvDir);
  const fakePi = path.join(dir, "fake-pi");
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.env.FAKE_PI_ARGV_DIR, process.pid + ".json"), JSON.stringify(process.argv.slice(2)));
const text = "## Verdict\\napprove\\n\\n## Summary\\n- Fixture.\\n\\n## Findings\\nNo material findings.\\n";
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "fake/model", stopReason: "stop" } });
line({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
`);
  fs.chmodSync(fakePi, 0o755);
  return { presets, systemPrompt, argvDir, fakePi };
}

function runCli(args: string[]) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-verify-regression-"));
  const fx = writeFixtures(tempDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_BIN: fx.fakePi,
    PI_REVIEW_PRESETS: fx.presets,
    PI_REVIEW_SYSTEM_PROMPT: fx.systemPrompt,
    FAKE_PI_ARGV_DIR: fx.argvDir,
  };
  delete env.TYPESAFE_API_KEY;
  delete env.PI_REVIEW_META_STDOUT;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, "src/cli.ts"), ...args, "--", "@src/types.ts", "check the gate"],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000, input: "" },
  );
  // Generic panel roles are shuffled per run; pin them so the snapshot is stable.
  const normalize = (value: string) =>
    value.split(repoRoot).join("<ROOT>").split(tempDir).join("<TMP>").replace(/- Role: [^\\\n]+/g, "- Role: <ROLE>");
  const argvs = fs.readdirSync(fx.argvDir).map((name) => normalize(fs.readFileSync(path.join(fx.argvDir, name), "utf8"))).sort();
  const metaLine = result.stderr.split("\n").find((line) => line.startsWith("PI_REVIEW_META_JSON: "));
  const meta = JSON.parse(metaLine!.slice("PI_REVIEW_META_JSON: ".length));
  meta.durationMs = 0;
  for (const reviewer of meta.reviewers ?? []) Object.assign(reviewer, { durationMs: 0, role: "<ROLE>" });
  return { status: result.status, argvs: argvs.map((a) => JSON.parse(a) as string[]), meta };
}

test("single review without --verify: argv, prompt, and meta match the base", () => {
  const run = runCli(["--no-stream"]);
  expect(run.status).toBe(0);
  expect(run.argvs).toMatchInlineSnapshot(`
    [
      [
        "-p",
        "--mode",
        "json",
        "--append-system-prompt",
        "Fixture system prompt.",
        "--tools",
        "read,grep,find,ls",
        "--no-session",
        "--no-extensions",
        "--extension",
        "<ROOT>/src/rules-extension.ts",
        "@src/types.ts",
        "You are running pi-review mode \`code\`.

    Your job is to produce a review conclusion only. Do not edit files, do not write files, do not produce patches, and do not claim implementation work was done.

    Fixture instructions.

    Output Markdown with exactly these top-level sections:

    ## Verdict
    One of: approve | request_changes | needs_clarification | blocked

    ## Summary
    Short conclusion in 2-5 bullets.

    ## Findings
    Prioritized findings. For every material finding, use this exact shape (increment IDs as F1, F2, ...):

    ### F1: <summary>
    - Severity: critical | high | medium | low
    - Path: <path or none>
    - Lines: <line or line-range in Path, or none>
    - Side: base | working (optional; defaults to working)
    - Actionable: yes | no
    - Evidence: <concrete evidence>
    - Impact: <why it matters>
    - Recommendation: <specific next step>

    Set Actionable to yes when the host must fix or consciously reject the finding before clean closeout. Use no for informational or explicitly out-of-scope follow-up findings. Include Lines only when you have reliable line numbers for Path: a single line (\`42\`) or an inclusive range (\`42-58\`). Omit Lines or write "none" for file-level or non-line-specific findings — never guess a line number. Side marks which half of a diff Lines refers to (\`base\` = before the change, \`working\` = after); omit it to default to \`working\`. If there are no material findings, write "No material findings."

    ## Risks and Blind Spots
    What could still be wrong, missing, or unverified.

    ## Open Questions
    Questions the parent agent or user should answer before acting. If none, write "None."

    <user-request>
    check the gate
    </user-request>

    Review the attached file reference(s): @src/types.ts",
      ],
    ]
  `);
  expect(run.meta).toMatchInlineSnapshot(`
    {
      "actionableCount": 0,
      "durationMs": 0,
      "findings": [],
      "metaVersion": 1,
      "model": null,
      "reviewMode": "code",
      "status": "clean",
      "verdict": "approve",
      "verdictSource": "parsed",
    }
  `);
});

test("panel review without --verify: reviewer argv, prompts, and meta match the base", () => {
  const run = runCli(["--reviewers", "2"]);
  expect(run.status).toBe(0);
  expect(run.argvs).toMatchInlineSnapshot(`
    [
      [
        "-p",
        "--mode",
        "json",
        "--append-system-prompt",
        "Fixture system prompt.",
        "--tools",
        "read,grep,find,ls",
        "--no-extensions",
        "--extension",
        "<ROOT>/src/rules-extension.ts",
        "--no-session",
        "@src/types.ts",
        "You are an independent panel reviewer.
    - Reviewer ID: r1
    - Role: <ROLE>
    You cannot see other reviewers' findings. Submit your own independent conclusion only.

    You are running pi-review mode \`code\`.

    Your job is to produce a review conclusion only. Do not edit files, do not write files, do not produce patches, and do not claim implementation work was done.

    Fixture instructions.

    Output Markdown with exactly these top-level sections:

    ## Verdict
    One of: approve | request_changes | needs_clarification | blocked

    ## Summary
    Short conclusion in 2-5 bullets.

    ## Findings
    Prioritized findings. For every material finding, use this exact shape (increment IDs as F1, F2, ...):

    ### F1: <summary>
    - Severity: critical | high | medium | low
    - Path: <path or none>
    - Lines: <line or line-range in Path, or none>
    - Side: base | working (optional; defaults to working)
    - Actionable: yes | no
    - Evidence: <concrete evidence>
    - Impact: <why it matters>
    - Recommendation: <specific next step>

    Set Actionable to yes when the host must fix or consciously reject the finding before clean closeout. Use no for informational or explicitly out-of-scope follow-up findings. Include Lines only when you have reliable line numbers for Path: a single line (\`42\`) or an inclusive range (\`42-58\`). Omit Lines or write "none" for file-level or non-line-specific findings — never guess a line number. Side marks which half of a diff Lines refers to (\`base\` = before the change, \`working\` = after); omit it to default to \`working\`. If there are no material findings, write "No material findings."

    ## Risks and Blind Spots
    What could still be wrong, missing, or unverified.

    ## Open Questions
    Questions the parent agent or user should answer before acting. If none, write "None."

    <user-request>
    check the gate
    </user-request>

    Review the attached file reference(s): @src/types.ts",
      ],
      [
        "-p",
        "--mode",
        "json",
        "--append-system-prompt",
        "Fixture system prompt.",
        "--tools",
        "read,grep,find,ls",
        "--no-extensions",
        "--extension",
        "<ROOT>/src/rules-extension.ts",
        "--no-session",
        "@src/types.ts",
        "You are an independent panel reviewer.
    - Reviewer ID: r2
    - Role: <ROLE>
    You cannot see other reviewers' findings. Submit your own independent conclusion only.

    You are running pi-review mode \`code\`.

    Your job is to produce a review conclusion only. Do not edit files, do not write files, do not produce patches, and do not claim implementation work was done.

    Fixture instructions.

    Output Markdown with exactly these top-level sections:

    ## Verdict
    One of: approve | request_changes | needs_clarification | blocked

    ## Summary
    Short conclusion in 2-5 bullets.

    ## Findings
    Prioritized findings. For every material finding, use this exact shape (increment IDs as F1, F2, ...):

    ### F1: <summary>
    - Severity: critical | high | medium | low
    - Path: <path or none>
    - Lines: <line or line-range in Path, or none>
    - Side: base | working (optional; defaults to working)
    - Actionable: yes | no
    - Evidence: <concrete evidence>
    - Impact: <why it matters>
    - Recommendation: <specific next step>

    Set Actionable to yes when the host must fix or consciously reject the finding before clean closeout. Use no for informational or explicitly out-of-scope follow-up findings. Include Lines only when you have reliable line numbers for Path: a single line (\`42\`) or an inclusive range (\`42-58\`). Omit Lines or write "none" for file-level or non-line-specific findings — never guess a line number. Side marks which half of a diff Lines refers to (\`base\` = before the change, \`working\` = after); omit it to default to \`working\`. If there are no material findings, write "No material findings."

    ## Risks and Blind Spots
    What could still be wrong, missing, or unverified.

    ## Open Questions
    Questions the parent agent or user should answer before acting. If none, write "None."

    <user-request>
    check the gate
    </user-request>

    Review the attached file reference(s): @src/types.ts",
      ],
    ]
  `);
  expect(run.meta).toMatchInlineSnapshot(`
    {
      "actionableCount": 0,
      "adjudicationUsed": false,
      "advisories": [],
      "configuredReviewers": 2,
      "confirmedClusters": [],
      "consensusPolicy": "quorum",
      "consensusThreshold": 2,
      "durationMs": 0,
      "findings": [],
      "metaVersion": 1,
      "model": null,
      "panelHealth": "healthy",
      "reviewMode": "code",
      "reviewers": [
        {
          "contributed": true,
          "durationMs": 0,
          "model": null,
          "reviewerId": "r1",
          "role": "<ROLE>",
          "status": "clean",
          "verdict": "approve",
          "verdictSource": "parsed",
        },
        {
          "contributed": true,
          "durationMs": 0,
          "model": null,
          "reviewerId": "r2",
          "role": "<ROLE>",
          "status": "clean",
          "verdict": "approve",
          "verdictSource": "parsed",
        },
      ],
      "sourceFindings": [],
      "status": "clean",
      "strategy": "panel",
      "successfulReviewers": 2,
      "verdict": "approve",
      "verdictSource": "parsed",
    }
  `);
});
