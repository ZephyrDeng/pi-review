import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildRvCompletions,
  type ModelInfo,
} from "./rv-completions.js";
import {
  buildRvOrchestrationPrompt,
  parseRvArgs,
  RV_COMPLETIONS,
  validateRvParsed,
} from "./rv-prompts.js";

/**
 * Captured at `session_start` so the synchronous-ish `getArgumentCompletions`
 * callback (which receives only the argument prefix) can read the live model
 * registry without ctx. Stays undefined in non-TUI/print mode; completions then
 * gracefully degrade to the static `RV_COMPLETIONS` fallback.
 */
let capturedModels: ModelInfo[] | undefined;
let capturedPrimaryProvider: string | undefined;

function toModelInfo(m: {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}): ModelInfo {
  const levels: string[] = [];
  const map = m.thinkingLevelMap ?? {};
  for (const k of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    // A level is supported unless explicitly disabled (null) and is present in the map.
    if (k in map && map[k] !== null && map[k] !== undefined) levels.push(k);
  }
  return {
    provider: m.provider,
    id: m.id,
    label: `${m.provider}/${m.id}`,
    name: m.name ?? m.id,
    reasoning: Boolean(m.reasoning),
    contextWindow: m.contextWindow ?? 0,
    thinkingLevels: levels,
  };
}

export default function piReviewExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    try {
      const available = ctx.modelRegistry?.getAvailable?.() ?? [];
      capturedModels = available.map((m) => toModelInfo(m as unknown as Parameters<typeof toModelInfo>[0]));
      capturedPrimaryProvider = ctx.model?.provider;
    } catch {
      capturedModels = undefined;
      capturedPrimaryProvider = undefined;
    }
  });

  pi.registerCommand("rv", {
    description:
      "Delegate pi-review to the agent. Usage: /rv [--mode plan|challenge] [--model id] [--thinking level] [--keep-session] [--no-stream] @target | /rv --continue <handle> [opts] [text] | models",
    getArgumentCompletions: (prefix): ReturnType<typeof buildRvCompletions> => {
      // Try dynamic completion first (models + thinking + scene templates).
      if (capturedModels && capturedModels.length > 0) {
        const dynamic = buildRvCompletions(prefix, {
          models: capturedModels,
          primaryProvider: capturedPrimaryProvider,
        });
        if (dynamic && dynamic.length) return dynamic;
      }
      // Graceful fallback to static hint list when registry is unavailable.
      const filtered = RV_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
      return filtered.length
        ? filtered.map(({ value, hint }) => ({ value, label: value, description: hint }))
        : null;
    },
    handler: async (rawArgs, ctx) => {
      const trimmed = rawArgs.trim();
      if (!trimmed) {
        ctx.ui.notify("/rv needs a target or `models`. Try: /rv @path or /rv models", "warning");
        return;
      }

      const parsed = parseRvArgs(trimmed);
      const validation = validateRvParsed(parsed);
      if (!validation.ok) {
        ctx.ui.notify(validation.message, "warning");
        return;
      }

      if (!parsed.modelsOnly && !parsed.target && !parsed.continueHandle) {
        ctx.ui.notify("/rv needs a target, --continue <handle>, or `models`.", "warning");
        return;
      }

      pi.sendUserMessage(buildRvOrchestrationPrompt(parsed));
    },
  });
}