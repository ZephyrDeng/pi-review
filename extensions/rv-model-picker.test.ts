import assert from "node:assert/strict";
import { test } from "vitest";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./rv-completions.js";
import {
  MODEL_PICKER_SKIP,
  RvModelPickerComponent,
  pickerProviders,
  pickerRows,
  type ModelPickerResult,
} from "./rv-model-picker.js";

// A fixture that mirrors the user's example: a `zenmux` provider with glm-5.2,
// plus a couple of other providers so scope cycling and multi-token search are
// meaningful. Ranking is driven by the caller (we pass already-ranked input).
const ranked: ModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5", name: "sonnet", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "zenmux", id: "glm-5.2", label: "zenmux/glm-5.2", name: "glm", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "zenmux", id: "glm-5.2-flash", label: "zenmux/glm-5.2-flash", name: "glm-flash", reasoning: true, contextWindow: 200000, thinkingLevels: ["high"] },
  { provider: "openai", id: "gpt-5.6-luna", label: "openai/gpt-5.6-luna", name: "luna", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
  { provider: "google", id: "gemini-3-pro", label: "google/gemini-3-pro", name: "pro", reasoning: true, contextWindow: 200000, thinkingLevels: ["high", "xhigh"] },
];

// Minimal fake TUI: the component only calls tui.requestRender().
const fakeTui = { requestRender: () => {} } as unknown as Parameters<typeof RvModelPickerComponent.create>[0];
const kb = getKeybindings() as KeybindingsManager;

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as unknown as Parameters<typeof RvModelPickerComponent.create>[1];

function makePicker(allowSkip: boolean, done: (r: ModelPickerResult) => void) {
  return RvModelPickerComponent.create(fakeTui, theme, kb, done, {
    locale: "en",
    ranked,
    allowSkip,
    title: "Model",
  });
}

function renderText(picker: RvModelPickerComponent, width = 80): string {
  return picker.render(width).join("\n");
}

// Raw terminal bytes the real keybindings layer understands.
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  bs: "\x7f",
};

test("pickerRows prepends the skip row and preserves rank order", () => {
  const withSkip = pickerRows(ranked, true);
  assert.equal(withSkip[0].kind, "skip");
  assert.deepEqual(
    withSkip.slice(1).map((r) => (r.kind === "model" ? r.label : "")),
    ranked.map((m) => m.label),
  );

  const noSkip = pickerRows(ranked, false);
  assert.equal(noSkip[0].kind, "model");
  assert.equal(noSkip.find((r) => r.kind === "skip"), undefined);
});

test("pickerProviders returns distinct providers in rank order", () => {
  assert.deepEqual(pickerProviders(ranked), ["anthropic", "zenmux", "openai", "google"]);
  assert.deepEqual(pickerProviders([ranked[1], ranked[3]]), ["zenmux", "openai"]);
});

test("typing filters the list live (single token)", () => {
  const picker = makePicker(false, () => {});
  picker.handleInput("g");
  picker.handleInput("l");
  picker.handleInput("m");
  const out = renderText(picker);
  // glm-5.2 and glm-5.2-flash both match; claude/gpt/gemini do not.
  assert.ok(out.includes("glm-5.2"), out);
  assert.ok(out.includes("glm-5.2-flash"), out);
  assert.ok(!out.includes("claude-sonnet"), out);
  assert.ok(!out.includes("gpt-5.6-luna"), out);
});

test("multi-token fuzzy search matches provider + model (zenmux glm)", () => {
  const picker = makePicker(false, () => {});
  for (const ch of "zenmux glm") picker.handleInput(ch);
  const out = renderText(picker);
  assert.ok(out.includes("glm-5.2"), out);
  assert.ok(out.includes("glm-5.2-flash"), out);
  // openai/gemini/anthropic excluded — different provider
  assert.ok(!out.includes("gpt-5.6-luna"), out);
  assert.ok(!out.includes("gemini-3-pro"), out);
  assert.ok(!out.includes("claude-sonnet"), out);
});

test("no matches renders a no-match line", () => {
  const picker = makePicker(false, () => {});
  for (const ch of "zzzzz") picker.handleInput(ch);
  const out = renderText(picker);
  assert.ok(/No matching models/.test(out), out);
});

test("backspace edits the query and re-filters", () => {
  const picker = makePicker(false, () => {});
  for (const ch of "glm-5.2-") picker.handleInput(ch);
  // typed "glm-5.2-" which matches only glm-5.2-flash (prefix); backspace -> "glm-5.2"
  let out = renderText(picker);
  assert.ok(out.includes("glm-5.2-flash"), out);
  picker.handleInput(KEY.bs);
  out = renderText(picker);
  assert.ok(out.includes("glm-5.2"), out);
});

test("down + enter confirms the highlighted model label", () => {
  let result: ModelPickerResult = "__pending__";
  const picker = makePicker(false, (r) => {
    result = r;
  });
  // filter to glm-5.2 / glm-5.2-flash, then move down to glm-5.2-flash and confirm
  for (const ch of "glm") picker.handleInput(ch);
  picker.handleInput(KEY.down);
  picker.handleInput(KEY.enter);
  assert.equal(result, "zenmux/glm-5.2-flash");
});

test("escape cancels and resolves to undefined", () => {
  let result: ModelPickerResult = "__pending__";
  const picker = makePicker(false, (r) => {
    result = r;
  });
  picker.handleInput(KEY.escape);
  assert.equal(result, undefined);
});

test("skip row is confirmable when allowSkip, resolving to the skip sentinel", () => {
  let result: ModelPickerResult = "__pending__";
  const picker = makePicker(true, (r) => {
    result = r;
  });
  // initial selection is the skip row (index 0); confirm immediately
  picker.handleInput(KEY.enter);
  assert.equal(result, MODEL_PICKER_SKIP);
});

test("Tab cycles provider scope: all -> anthropic -> zenmux -> openai -> google -> all", () => {
  const picker = makePicker(false, () => {});
  const scopeLine = () => renderText(picker).split("\n").find((l) => l.startsWith("Scope:"))!;

  // all: every provider is active/muted; "all" itself is the accent (here plain) entry
  let scope = scopeLine();
  assert.match(scope, /all/, scope);

  picker.handleInput(KEY.tab); // -> anthropic
  scope = scopeLine();
  assert.match(scope, /anthropic/, scope);
  assert.ok(!renderText(picker).includes("gpt-5.6-luna"), "openai model hidden in anthropic scope");

  picker.handleInput(KEY.tab); // -> zenmux
  assert.match(scopeLine(), /zenmux/, scopeLine());
  assert.ok(renderText(picker).includes("glm-5.2"), "zenmux models shown in zenmux scope");
  assert.ok(!renderText(picker).includes("claude-sonnet"), "anthropic hidden in zenmux scope");

  picker.handleInput(KEY.tab); // -> openai
  picker.handleInput(KEY.tab); // -> google
  picker.handleInput(KEY.tab); // -> all (wraps)
  assert.match(scopeLine(), /all/, scopeLine());
  assert.ok(renderText(picker).includes("claude-sonnet"), "all scope shows every provider");
});
