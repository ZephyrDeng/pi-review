import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "./prompt.js";

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
