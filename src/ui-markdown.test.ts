import assert from "node:assert/strict";
import { test } from "vitest";
import { isSafeLinkHref, parseInline, parseMarkdown } from "./ui-markdown.js";

test("parseMarkdown splits headings, paragraphs, and rules", () => {
  const blocks = parseMarkdown("# Title\n\nBody line one\nline two\n\n---\n\n## Sub");
  assert.deepEqual(blocks[0], { kind: "heading", level: 1, children: [{ kind: "text", text: "Title" }] });
  assert.deepEqual(blocks[1], { kind: "paragraph", children: [{ kind: "text", text: "Body line one line two" }] });
  assert.deepEqual(blocks[2], { kind: "hr" });
  assert.deepEqual(blocks[3], { kind: "heading", level: 2, children: [{ kind: "text", text: "Sub" }] });
});

test("parseMarkdown keeps fenced code verbatim, including markdown-looking lines", () => {
  const blocks = parseMarkdown('```ts\nconst a = "**not bold**";\n# not a heading\n```');
  assert.deepEqual(blocks, [{ kind: "code", lang: "ts", text: 'const a = "**not bold**";\n# not a heading' }]);
});

test("parseMarkdown handles an unterminated fence without hanging", () => {
  const blocks = parseMarkdown("```\nabc");
  assert.deepEqual(blocks, [{ kind: "code", lang: "", text: "abc" }]);
});

test("parseMarkdown groups list items and detects ordered lists", () => {
  const blocks = parseMarkdown("- one\n- two\n\n1. first\n2. second");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    kind: "list",
    ordered: false,
    items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
  });
  assert.equal(blocks[1]!.kind, "list");
  assert.equal((blocks[1] as { ordered: boolean }).ordered, true);
});

test("parseMarkdown merges consecutive blockquote lines", () => {
  const blocks = parseMarkdown("> quoted one\n> quoted two");
  assert.deepEqual(blocks, [{ kind: "blockquote", children: [{ kind: "text", text: "quoted one quoted two" }] }]);
});

test("parseInline nests strong, em, code, and links", () => {
  assert.deepEqual(parseInline("a **b `c`** d"), [
    { kind: "text", text: "a " },
    { kind: "strong", children: [{ kind: "text", text: "b " }, { kind: "code", text: "c" }] },
    { kind: "text", text: " d" },
  ]);
  assert.deepEqual(parseInline("[docs](https://example.com)"), [
    { kind: "link", href: "https://example.com", children: [{ kind: "text", text: "docs" }] },
  ]);
});

test("parseInline drops unsafe link destinations but keeps the label text", () => {
  // The nested paren splits the href early; the stray ")" stays as harmless text.
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ kind: "text", text: "click)" }]);
  assert.deepEqual(parseInline("[f](file:///etc/passwd)"), [{ kind: "text", text: "f" }]);
});

test("isSafeLinkHref only allows http and https", () => {
  assert.equal(isSafeLinkHref("https://a.b"), true);
  assert.equal(isSafeLinkHref("http://a.b"), true);
  assert.equal(isSafeLinkHref("javascript:alert(1)"), false);
  assert.equal(isSafeLinkHref("data:text/html,x"), false);
  assert.equal(isSafeLinkHref("vbscript:x"), false);
});

test("unmatched markers stay literal text", () => {
  assert.deepEqual(parseInline("a * b ` c"), [{ kind: "text", text: "a * b ` c" }]);
});
