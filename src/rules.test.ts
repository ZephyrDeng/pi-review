import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeRules from "./rules-extension.js";
import {
  compileGlob,
  discoverRules,
  expandBraces,
  findMarkdownFiles,
  parseRuleFile,
  ruleMatchesFile,
  splitTopLevelCommas,
} from "./rules.js";

function matches(pattern: string, file: string): boolean {
  const re = compileGlob(pattern);
  return re !== null && re.test(file);
}

test("glob: documented examples", () => {
  assert.ok(matches("**/*.ts", "src/api/handler.ts"));
  assert.ok(matches("**/*.ts", "lib/util.ts"));
  assert.ok(matches("**/*.ts", "a.ts"));
  assert.ok(!matches("**/*.ts", "a.tsx"));
  assert.ok(matches("src/**/*", "src/api/handler.ts"));
  assert.ok(matches("src/**/*", "src/a.ts"));
  assert.ok(!matches("src/**/*", "lib/a.ts"));
  assert.ok(matches("*.md", "README.md"));
  assert.ok(!matches("*.md", "docs/README.md"));
  assert.ok(matches("src/components/*.tsx", "src/components/Button.tsx"));
  assert.ok(!matches("src/components/*.tsx", "src/components/nested/Button.tsx"));
  assert.ok(matches("src/**/*.{ts,tsx}", "src/a/b.tsx"));
  assert.ok(matches("src/**/*.{ts,tsx}", "src/b.ts"));
  assert.ok(!matches("src/**/*.{ts,tsx}", "src/b.js"));
});

test("glob: ** boundaries, ? and bracket expressions", () => {
  assert.ok(matches("src/**", "src/deep/nested/file.ts"));
  assert.ok(matches("a?c.md", "abc.md"));
  assert.ok(!matches("a?c.md", "abbc.md"));
  assert.ok(matches("file[0-9].md", "file1.md"));
  assert.ok(!matches("file[0-9].md", "fileA.md"));
  assert.ok(matches("file[!0-9].md", "fileA.md"));
});

test("glob: invalid bracket expression matches nothing (v2.1.207)", () => {
  assert.equal(compileGlob("photos [2024/**"), null);
  assert.equal(compileGlob("foo[.md"), null);
});

test("glob: escaped [ matches literally", () => {
  assert.ok(matches("photos \\[2024/**", "photos [2024/img.png"));
});

test("splitTopLevelCommas: commas inside braces are not splits", () => {
  assert.deepEqual(splitTopLevelCommas("src/**/*.{ts,tsx}, docs/**"), [
    "src/**/*.{ts,tsx}",
    "docs/**",
  ]);
});

test("expandBraces: nested expansion", () => {
  assert.deepEqual(expandBraces("a.{ts,tsx}"), ["a.ts", "a.tsx"]);
  assert.deepEqual(expandBraces("{a,b{1,2}}.md"), ["a.md", "b1.md", "b2.md"]);
  assert.deepEqual(expandBraces("plain.md"), ["plain.md"]);
});

test("frontmatter: no frontmatter → unconditional", () => {
  const r = parseRuleFile("# title\n\nbody");
  assert.equal(r.paths, null);
  assert.equal(r.content, "# title\n\nbody");
});

test("frontmatter: comma-separated string", () => {
  const r = parseRuleFile('---\npaths: "src/**/*.{ts,tsx}, docs/**"\n---\n\nbody');
  assert.deepEqual(r.paths, ["src/**/*.{ts,tsx}", "docs/**"]);
  assert.equal(r.content, "body");
});

test("frontmatter: inline array", () => {
  const r = parseRuleFile('---\npaths: ["src/**", \'lib/**\']\n---\nbody');
  assert.deepEqual(r.paths, ["src/**", "lib/**"]);
});

test("frontmatter: YAML block list", () => {
  const r = parseRuleFile("---\npaths:\n  - src/**\n  - \"lib/**\"\nother: x\n---\nbody");
  assert.deepEqual(r.paths, ["src/**", "lib/**"]);
  assert.equal(r.content, "body");
});

test("frontmatter: present but no paths → unconditional, frontmatter stripped", () => {
  const r = parseRuleFile("---\ntitle: x\n---\nbody");
  assert.equal(r.paths, null);
  assert.equal(r.content, "body");
});

test("frontmatter: unclosed → whole content", () => {
  const r = parseRuleFile("---\npaths: src/**\nno closing");
  assert.equal(r.paths, null);
  assert.ok(r.content.startsWith("---"));
});

test("paths present but all globs invalid → patterns is an empty array", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-rules-"));
  const project = path.join(root, "p");
  fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "rules", "bad.md"), "---\npaths: foo[.md\n---\nrule");
  const rules = discoverRules(project, path.join(root, "no-home"));
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.patterns, []);
  assert.equal(ruleMatchesFile(rules[0]!, path.join(project, "foo.md")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-rules-"));
}

test("discovery: recursive .md, non-md ignored, symlinked dirs and cycle detection", () => {
  const root = makeFixture();
  const rulesDir = path.join(root, ".claude", "rules");
  fs.mkdirSync(path.join(rulesDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "a.md"), "A");
  fs.writeFileSync(path.join(rulesDir, "sub", "b.md"), "B");
  fs.writeFileSync(path.join(rulesDir, "ignore.txt"), "x");
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "c.md"), "C");
  fs.symlinkSync(shared, path.join(rulesDir, "linked"));
  fs.symlinkSync(rulesDir, path.join(shared, "loop"));
  const files = findMarkdownFiles(rulesDir).map((f) => path.basename(f)).sort();
  assert.deepEqual(files, ["a.md", "b.md", "c.md"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("discovery: user before project, realpath dedupe, paths compiled", () => {
  const root = makeFixture();
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".claude", "rules"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "rules", "global.md"), "G");
  fs.writeFileSync(
    path.join(project, ".claude", "rules", "ts.md"),
    "---\npaths: \"**/*.ts\"\n---\nTS rule",
  );
  fs.symlinkSync(
    path.join(home, ".claude", "rules", "global.md"),
    path.join(project, ".claude", "rules", "dup.md"),
  );
  const rules = discoverRules(project, home);
  assert.deepEqual(
    rules.map((r) => [path.basename(r.file), r.scope]),
    [
      ["global.md", "user"],
      ["ts.md", "project"],
    ],
  );
  const tsRule = rules[1]!;
  assert.equal(tsRule.patterns?.length, 1);
  assert.ok(ruleMatchesFile(tsRule, path.join(project, "src", "a.ts")));
  assert.ok(!ruleMatchesFile(tsRule, path.join(project, "src", "a.js")));
  assert.ok(!ruleMatchesFile(tsRule, path.join(root, "elsewhere", "a.ts")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("discovery: cwd in a subdirectory still finds the outer project rules", () => {
  const root = makeFixture();
  const project = path.join(root, "proj");
  const sub = path.join(project, "packages", "app");
  fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "rules", "r.md"), "R");
  const rules = discoverRules(sub, path.join(root, "home-not-exist"));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.scope, "project");
  assert.equal(rules[0]!.baseDir, project);
  fs.rmSync(root, { recursive: true, force: true });
});

test("discovery: nested project scopes are outermost-first, innermost last", () => {
  const root = makeFixture();
  const outer = path.join(root, "outer");
  const inner = path.join(outer, "inner");
  for (const dir of [outer, inner]) {
    fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "rules", "r.md"), dir);
  }
  const rules = discoverRules(inner, path.join(root, "no-home"));
  assert.deepEqual(rules.map((r) => r.baseDir), [outer, inner]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("matching: reading through a symlink path still hits (v2.1.198)", () => {
  const root = makeFixture();
  const project = path.join(root, "p");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "real.ts"), "");
  fs.writeFileSync(
    path.join(project, ".claude", "rules", "ts.md"),
    "---\npaths: src/**/*.ts\n---\nrule",
  );
  fs.symlinkSync(path.join(project, "src", "real.ts"), path.join(project, "alias.ts"));
  const rules = discoverRules(project, path.join(root, "no-home"));
  assert.ok(ruleMatchesFile(rules[0]!, path.join(project, "alias.ts")));
  fs.rmSync(root, { recursive: true, force: true });
});

/** Minimal ExtensionAPI stub capturing the handlers this extension registers. */
function loadExtension() {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  claudeRules(pi);
  return handlers;
}

const ctx = (cwd: string) => ({ cwd });

/** Point os.homedir() at a temp dir so the developer's real ~/.claude/rules never leaks in. */
async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-home-"));
  const original = os.homedir;
  (os as { homedir: () => string }).homedir = () => home;
  try {
    await fn();
  } finally {
    (os as { homedir: () => string }).homedir = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fixture(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-ext-"));
  fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "rules", "always.md"), "ALWAYS");
  fs.writeFileSync(
    path.join(project, ".claude", "rules", "ts.md"),
    "---\npaths: src/**/*.ts\n---\nTS SCOPED",
  );
  return project;
}

test("extension appends unconditional rules to the system prompt", async () => {
  await withTempHome(async () => {
    const project = fixture();
    const handlers = loadExtension();
    await handlers.session_start!({}, ctx(project));
    const result = await handlers.before_agent_start!(
      { systemPrompt: "BASE", systemPromptOptions: { contextFiles: [] } },
      ctx(project),
    );
    assert.ok(result.systemPrompt.startsWith("BASE"));
    assert.match(result.systemPrompt, /# Rules/);
    assert.match(result.systemPrompt, /ALWAYS/);
    assert.ok(!result.systemPrompt.includes("TS SCOPED"), "path-scoped rule must not enter the prompt");
    fs.rmSync(project, { recursive: true, force: true });
  });
});

test("extension dedupes an unconditional rule already loaded as a built-in context file", async () => {
  await withTempHome(async () => {
    const project = fixture();
    const handlers = loadExtension();
    await handlers.session_start!({}, ctx(project));
    const ruleFile = path.join(project, ".claude", "rules", "always.md");
    const result = await handlers.before_agent_start!(
      { systemPrompt: "BASE", systemPromptOptions: { contextFiles: [{ path: ruleFile, content: "ALWAYS" }] } },
      ctx(project),
    );
    assert.equal(result, undefined, "same realpath must not be injected twice");
    fs.rmSync(project, { recursive: true, force: true });
  });
});

test("extension injects a path-scoped rule into the matching read result exactly once", async () => {
  await withTempHome(async () => {
    const project = fixture();
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "a.ts"), "");
    const handlers = loadExtension();
    await handlers.session_start!({}, ctx(project));
    const event = {
      toolName: "read",
      input: { path: "src/a.ts" },
      content: [{ type: "text", text: "file body" }],
      isError: false,
    };
    const first = await handlers.tool_result!(event, ctx(project));
    assert.match(first.content.at(-1).text, /TS SCOPED/);
    const second = await handlers.tool_result!(event, ctx(project));
    assert.equal(second, undefined, "same rule must inject only once per process");
    // write/edit and read errors never trigger
    assert.equal(await handlers.tool_result!({ ...event, toolName: "write" }, ctx(project)), undefined);
    assert.equal(await handlers.tool_result!({ ...event, isError: true }, ctx(project)), undefined);
    // compact re-arms injection
    await handlers.session_compact!({}, ctx(project));
    assert.match((await handlers.tool_result!(event, ctx(project))).content.at(-1).text, /TS SCOPED/);
    fs.rmSync(project, { recursive: true, force: true });
  });
});

test("extension does not match a path outside the project", async () => {
  await withTempHome(async () => {
    const project = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-outside-"));
    fs.writeFileSync(path.join(outside, "a.ts"), "");
    const handlers = loadExtension();
    await handlers.session_start!({}, ctx(project));
    const result = await handlers.tool_result!(
      { toolName: "read", input: { path: path.join(outside, "a.ts") }, content: [], isError: false },
      ctx(project),
    );
    assert.equal(result, undefined);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
