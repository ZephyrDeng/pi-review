import assert from "node:assert/strict";
import { test } from "vitest";
import { buildRvConfigLines } from "./rv-config.js";

const resolved = {
  piBin: "pi",
  reviewHome: "/pkg/resources",
  presetsFile: "/pkg/resources/review-presets.json",
  panelPresetsFile: "/pkg/resources/panel-presets.json",
  systemPromptFile: "/pkg/resources/system-prompt.md",
  sessionsRoot: "/home/u/.pi/pi-review/sessions",
};

test("rv-config shows the default decision when no config and no env", () => {
  const lines = buildRvConfigLines({
    locale: "en",
    env: {},
    configPath: "/home/u/.pi/pi-review/config.json",
    readConfig: () => null,
    resolved,
  });
  const text = lines.join("\n");
  assert.match(text, /childExtensions: false \(default\)/);
  assert.match(text, /config file: \/home\/u\/\.pi\/pi-review\/config\.json/);
  assert.match(text, /\(missing — using defaults\)/);
  assert.match(text, /piBin: pi/);
  assert.match(text, /sessionsRoot: \/home\/u\/\.pi\/pi-review\/sessions/);
});

test("rv-config shows the config file as the source when childExtensions is set", () => {
  const lines = buildRvConfigLines({
    locale: "en",
    env: {},
    configPath: "/home/u/.pi/pi-review/config.json",
    readConfig: () => '{"childExtensions": true}',
    resolved,
  });
  assert.match(lines.join("\n"), /childExtensions: true \(config file\)/);
});

test("rv-config shows env as the source and wins over the config file", () => {
  const lines = buildRvConfigLines({
    locale: "en",
    env: { PI_REVIEW_CHILD_EXTENSIONS: "0" },
    configPath: "/home/u/.pi/pi-review/config.json",
    readConfig: () => '{"childExtensions": true}',
    resolved,
  });
  assert.match(lines.join("\n"), /childExtensions: false \(env override\)/);
});

test("rv-config warns about a leniently ignored value and falls back", () => {
  const lines = buildRvConfigLines({
    locale: "en",
    env: {},
    configPath: "/home/u/.pi/pi-review/config.json",
    readConfig: () => '{"childExtensions": "yes"}',
    resolved,
  });
  const text = lines.join("\n");
  assert.match(text, /config warning: .*childExtensions/);
  assert.match(text, /childExtensions: false \(default\)/);
});

test("rv-config warns about invalid JSON without failing", () => {
  const lines = buildRvConfigLines({
    locale: "en",
    env: {},
    configPath: "/home/u/.pi/pi-review/config.json",
    readConfig: () => "not json",
    resolved,
  });
  const text = lines.join("\n");
  assert.match(text, /config warning: .*not valid JSON/);
  assert.match(text, /childExtensions: false \(default\)/);
});

test("rv-config renders Chinese labels for zh locale", () => {
  const lines = buildRvConfigLines({
    locale: "zh",
    env: {},
    configPath: "/home/u/.pi/pi-review/config.json",
    readConfig: () => '{"childExtensions": true}',
    resolved,
  });
  const text = lines.join("\n");
  assert.match(text, /Pi Review 配置/);
  assert.match(text, /childExtensions: true \(配置文件\)/);
  assert.match(text, /生效环境/);
});
