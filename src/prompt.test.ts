import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPrompt, buildReviewerPrompt, buildAdjudicatorPrompt, normalizePayloadRefs, splitPayload } from "./prompt.js";
import type { PanelReviewerSpec, SourceFinding } from "./types.js";

test("review prompt requests the parseable finding contract", () => {
  const prompt = buildPrompt(
    "code",
    { description: "code", instructions: "Review the code." },
    { fileRefs: ["@src/cli.ts"], userText: "" },
    "",
  );

  assert.match(prompt, /### F1: <summary>/);
  assert.match(prompt, /Severity: critical \| high \| medium \| low/);
  assert.match(prompt, /Path: <path or none>/);
  assert.match(prompt, /Actionable: yes \| no/);
  assert.match(prompt, /No material findings\./);
});

test("reviewer prompt injects stable reviewer identity and the shared contract", () => {
  const reviewer: PanelReviewerSpec = { id: "security", role: "Security reviewer" };
  const prompt = buildReviewerPrompt(
    "code",
    { description: "code", instructions: "Review the code." },
    { fileRefs: ["@src/cli.ts"], userText: "" },
    "",
    reviewer,
  );

  assert.match(prompt, /Reviewer ID: security/);
  assert.match(prompt, /Role: Security reviewer/);
  assert.match(prompt, /cannot see other reviewers' findings/);
  assert.match(prompt, /### F1: <summary>/);
  assert.match(prompt, /## Verdict/);
});

test("directory @refs stay as tool targets and are not attached as Pi file arguments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-refs-"));
  const filePath = path.join(tempDir, "note.ts");
  fs.writeFileSync(filePath, "export {}\n");
  const dirRef = `@${tempDir}`;
  const fileRef = `@${filePath}`;
  const normalized = normalizePayloadRefs(splitPayload([dirRef, fileRef, "focus on races"]));
  assert.deepEqual(normalized.attachableFileRefs, [fileRef]);
  assert.deepEqual(normalized.pathTargets, [tempDir]);
  assert.equal(normalized.userText, "focus on races");
  const prompt = buildPrompt("code", { description: "code", instructions: "Review the code." }, normalized, "");
  assert.match(prompt, /Review these path targets with read-only tools/);
  assert.match(prompt, new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /attached file reference/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("adjudicator prompt enforces aggregation-only constraints and the strict clustering contract", () => {
  const findings: SourceFinding[] = [
    { id: "r1#F1", reviewerId: "r1", finding: { summary: "loop bound is wrong", actionable: true, path: "src/cli.ts" } },
    { id: "r2#F1", reviewerId: "r2", finding: { summary: "off-by-one iteration", actionable: true, path: "src/cli.ts" } },
  ];
  const prompt = buildAdjudicatorPrompt([{ anchorPath: "src/cli.ts", findings }]);

  assert.match(prompt, /consensus adjudicator/i);
  assert.match(prompt, /aggregation-only/);
  assert.match(prompt, /may not invent new findings/);
  assert.match(prompt, /no write tools/);
  assert.match(prompt, /"sourceFindingIds":\["r1#F1","r2#F1"\],"confidence"/);
  assert.match(prompt, /must come from the candidates below/);
  // Adjudicator receives structured findings, not free repo access.
  assert.match(prompt, /r1#F1/);
  assert.match(prompt, /loop bound is wrong/);
});
