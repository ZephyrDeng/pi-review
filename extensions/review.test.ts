import assert from "node:assert/strict";
import { test } from "node:test";
import piReviewExtension from "./review.js";

type CommandConfig = {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
};

type SessionStart = (_event: unknown, ctx: {
  modelRegistry: { getAvailable: () => unknown[] };
  model?: { provider?: string };
  sessionManager: { getEntries: () => unknown[] };
}) => void;

function registeredExtension(): { commands: Map<string, CommandConfig>; sessionStart: SessionStart } {
  const commands = new Map<string, CommandConfig>();
  let sessionStart: SessionStart | undefined;
  const pi = {
    registerTool() {},
    on(event: string, handler: SessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name: string, config: CommandConfig) {
      commands.set(name, config);
    },
    sendUserMessage() {},
  };
  piReviewExtension(pi as never);
  assert.ok(sessionStart);
  return { commands, sessionStart };
}

const emptySession = () => ({
  modelRegistry: { getAvailable: () => [] },
  sessionManager: { getEntries: () => [] },
});

test("extension completion fallback never replaces an entered target when the catalog is empty", () => {
  const { commands, sessionStart } = registeredExtension();
  sessionStart({}, emptySession());
  const complete = commands.get("rv")?.getArgumentCompletions;
  assert.ok(complete);

  const modelItems = complete!("@src --model ");
  assert.ok(modelItems);
  assert.ok(modelItems!.every((item) => item.value.startsWith("@src --model ")));

  // Natural-language targets have no static candidate; returning null is safer than
  // replacing the whole argument with a bare --model/--mode suggestion.
  assert.equal(complete!("review auth behavior"), null);
});

test("a new session with an empty catalog does not reuse models captured by a previous session", () => {
  const { commands, sessionStart } = registeredExtension();
  const complete = commands.get("rv")?.getArgumentCompletions;
  assert.ok(complete);

  sessionStart({}, {
    modelRegistry: {
      getAvailable: () => [{
        provider: "old-provider",
        id: "old-model",
        name: "old-model",
        reasoning: true,
        contextWindow: 100_000,
        thinkingLevelMap: { high: "high" },
      }],
    },
    model: { provider: "old-provider" },
    sessionManager: { getEntries: () => [] },
  });
  assert.ok(complete!("--model ")?.some((item) => item.label === "old-provider/old-model"));

  sessionStart({}, emptySession());
  const next = complete!("--model ");
  assert.ok(next);
  assert.ok(!next!.some((item) => item.label === "old-provider/old-model"));
  assert.ok(next!.some((item) => item.label === "<provider/model>"));
});
