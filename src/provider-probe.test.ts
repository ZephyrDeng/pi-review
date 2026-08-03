import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { splitModelProvider } from "./panel-config.js";
import { collectPanelExtensionHints } from "./panel.js";
import type { ReviewerSubmission } from "./types.js";
import {
  configBlockForProvider,
  extensionOnlyHintText,
  parseModelCatalog,
  probeProviderAvailability,
  unknownProviderHintText,
} from "./review.js";

const CATALOG_WITHOUT_EXT = `provider      model                   context  max-out  thinking  images
Ai98Pro       grok-4.5                500K     128K     yes       yes   
DeepSeek      deepseek-v4-flash       1M       384K     yes       no    
openai-codex  gpt-5.6-luna            272K     128K     yes       yes   
`;

const CATALOG_WITH_EXT = `provider             model                                              context  max-out  thinking  images
Ai98Pro              grok-4.5                                           500K     128K     yes       yes   
px:anthropic         claude-sonnet-5                                    1M       128K     yes       yes   
px:openai            gpt-5.6-luna                                       272K     128K     yes       yes   
`;

function catalogResult(stdout: string) {
  return { status: 0, stdout, stderr: "", error: undefined, pid: 0, output: [null, stdout, ""], signal: null };
}

const mockedSpawnSync = vi.mocked(spawnSync);

/** Original env value captured at module load; restored after each test. */
const ORIGINAL_CHILD_EXTENSIONS = process.env.PI_REVIEW_CHILD_EXTENSIONS;

beforeEach(() => {
  mockedSpawnSync.mockReset();
  mockedSpawnSync.mockImplementation((_cmd, args) => {
    const isolated = Array.isArray(args) && args.includes("--no-extensions");
    return catalogResult(isolated ? CATALOG_WITHOUT_EXT : CATALOG_WITH_EXT) as ReturnType<typeof spawnSync>;
  });
  // Establish the suite's default state deterministically.
  delete process.env.PI_REVIEW_CHILD_EXTENSIONS;
});

afterEach(() => {
  if (ORIGINAL_CHILD_EXTENSIONS === undefined) {
    delete process.env.PI_REVIEW_CHILD_EXTENSIONS;
  } else {
    process.env.PI_REVIEW_CHILD_EXTENSIONS = ORIGINAL_CHILD_EXTENSIONS;
  }
});

test("parseModelCatalog extracts distinct provider names via header offsets", () => {
  assert.deepEqual(parseModelCatalog(CATALOG_WITHOUT_EXT), ["Ai98Pro", "DeepSeek", "openai-codex"]);
});

test("parseModelCatalog keeps provider names with symbols inside a column", () => {
  const catalog = `provider      model
Pika(Grok)    grok-4.5
px:anthropic  claude-sonnet-5
`;
  assert.deepEqual(parseModelCatalog(catalog), ["Pika(Grok)", "px:anthropic"]);
});

test("parseModelCatalog returns [] for non-table output", () => {
  assert.deepEqual(parseModelCatalog("pi - AI coding assistant\n\nUsage: ..."), []);
});

test("probeProviderAvailability resolves available from the isolated catalog", () => {
  assert.deepEqual(probeProviderAvailability("pi-avail", "DeepSeek"), { kind: "available" });
  expect(mockedSpawnSync).toHaveBeenCalledTimes(1); // only the isolated catalog is consulted
});

test("probeProviderAvailability resolves extension_only from the with-extensions catalog", () => {
  assert.deepEqual(probeProviderAvailability("pi-ext", "px:anthropic"), {
    kind: "extension_only",
    provider: "px:anthropic",
  });
  expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
});

test("probeProviderAvailability resolves unknown when missing everywhere", () => {
  assert.deepEqual(probeProviderAvailability("pi-unknown", "nonexistent"), {
    kind: "unknown",
    provider: "nonexistent",
  });
  expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
});

test("probeProviderAvailability reports indeterminate and does not cache failed catalog queries", () => {
  mockedSpawnSync.mockImplementation(() => ({
    status: 1,
    stdout: "",
    stderr: "boom",
    error: undefined,
    pid: 0,
    output: [null, "", "boom"],
    signal: null,
  }));
  const first = probeProviderAvailability("pi-broken", "px:anthropic");
  assert.deepEqual(first, { kind: "indeterminate", provider: "px:anthropic" });
  // Failure is not cached: a later successful query re-runs the probe.
  mockedSpawnSync.mockImplementation((_cmd, args) => {
    const isolated = Array.isArray(args) && args.includes("--no-extensions");
    return catalogResult(isolated ? CATALOG_WITHOUT_EXT : CATALOG_WITH_EXT) as ReturnType<typeof spawnSync>;
  });
  const second = probeProviderAvailability("pi-broken", "px:anthropic");
  assert.deepEqual(second, { kind: "extension_only", provider: "px:anthropic" });
});

test("splitModelProvider extracts the provider prefix from provider/model tokens", () => {
  assert.equal(splitModelProvider("px:openai/agnes-2.0-flash"), "px:openai");
  assert.equal(splitModelProvider("openai-codex/gpt-5.6-sol"), "openai-codex");
  assert.equal(splitModelProvider("anthropic/*"), "anthropic");
  assert.equal(splitModelProvider("gpt-5.6-sol"), undefined);
  assert.equal(splitModelProvider("/leading-slash"), undefined);
  assert.equal(splitModelProvider("trailing/"), undefined);
});

test("configBlockForProvider skips probing without an explicit provider", () => {
  assert.equal(configBlockForProvider("pi-skip", undefined), undefined);
  expect(mockedSpawnSync).not.toHaveBeenCalled();
});

test("configBlockForProvider skips probing when extensions are enabled (PI_REVIEW_CHILD_EXTENSIONS=1)", () => {
  process.env.PI_REVIEW_CHILD_EXTENSIONS = "1";
  assert.equal(configBlockForProvider("pi-skip", "px:anthropic"), undefined);
  expect(mockedSpawnSync).not.toHaveBeenCalled();
});

test("configBlockForProvider returns undefined when the provider is isolated-available", () => {
  assert.equal(configBlockForProvider("pi-avail2", "DeepSeek"), undefined);
});

test("configBlockForProvider resolves the provider from a provider/model token (F1 regression)", () => {
  // No --provider; the provider must come from the model string.
  const block = configBlockForProvider("pi-model-ext", undefined, "px:anthropic/claude-sonnet-5");
  assert.ok(block, "expected a config block");
  assert.equal(block!.extensionOnly, true);
  assert.match(block!.structured.parseError ?? "", /PI_REVIEW_CHILD_EXTENSIONS=1/);
});

test("configBlockForProvider does not block on a failed catalog probe (F2 regression)", () => {
  mockedSpawnSync.mockImplementation(() => ({
    status: 1,
    stdout: "",
    stderr: "boom",
    error: undefined,
    pid: 0,
    output: [null, "", "boom"],
    signal: null,
  }));
  assert.equal(configBlockForProvider("pi-broken-f2", "px:anthropic"), undefined);
});

test("configBlockForProvider blocks with the extension hint for extension-only providers", () => {
  const block = configBlockForProvider("pi-block-ext", "px:anthropic");
  assert.ok(block, "expected a config block");
  assert.equal(block!.extensionOnly, true);
  assert.equal(block!.structured.status, "blocked");
  assert.equal(block!.structured.verdict, "blocked");
  assert.equal(block!.structured.verdictSource, "config_error");
  assert.equal(block!.structured.findings.length, 0);
  assert.equal(block!.structured.actionableCount, 0);
  assert.match(block!.structured.parseError ?? "", /PI_REVIEW_CHILD_EXTENSIONS=1/);
});

test("configBlockForProvider blocks with the unknown-provider message", () => {
  const block = configBlockForProvider("pi-block-unk", "nonexistent");
  assert.ok(block, "expected a config block");
  assert.equal(block!.extensionOnly, false);
  assert.match(block!.structured.parseError ?? "", /was not found/);
});

test("collectPanelExtensionHints returns undefined when no reviewer was blocked", () => {
  const submissions: ReviewerSubmission[] = [
    { reviewerId: "r1", model: "gpt-5.6-sol", durationMs: 1, result: { status: "clean", verdict: "approve", verdictSource: "parsed", findings: [], actionableCount: 0 } },
  ];
  assert.equal(collectPanelExtensionHints(submissions), undefined);
});

test("collectPanelExtensionHints keeps every provider, deduplicated (F3 regression)", () => {
  const blocked = (id: string, provider: string): ReviewerSubmission => ({
    reviewerId: id,
    model: `${provider}/m`,
    durationMs: 0,
    result: {
      status: "blocked",
      verdict: "blocked",
      verdictSource: "config_error",
      parseError: extensionOnlyHintText(provider),
      findings: [],
      actionableCount: 0,
    },
    extensionHint: { provider, availableViaExtension: true },
  });
  const hints = collectPanelExtensionHints([
    blocked("r1", "px:anthropic"),
    blocked("r2", "px:openai"),
    blocked("r3", "px:anthropic"), // duplicate provider: collapsed
  ]);
  assert.deepEqual(hints, [
    { provider: "px:anthropic", availableViaExtension: true },
    { provider: "px:openai", availableViaExtension: true },
  ]);
});

test("extensionOnlyHintText mentions the provider and the env var", () => {
  const text = extensionOnlyHintText("px:anthropic");
  assert.match(text, /px:anthropic/);
  assert.match(text, /PI_REVIEW_CHILD_EXTENSIONS=1/);
  assert.match(text, /no-extensions/);
});

test("unknownProviderHintText mentions the provider and check guidance", () => {
  const text = unknownProviderHintText("foo");
  assert.match(text, /foo/);
  assert.match(text, /spelling/);
});
