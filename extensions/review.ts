import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildRvCompletions,
  type ModelInfo,
} from "./rv-completions.js";
import { detectRvLocale } from "./rv-locale.js";
import {
  buildRvOrchestrationPrompt,
  parseRvArgs,
  RV_COMPLETIONS,
  validateRvParsed,
  type RvStrategy,
} from "./rv-prompts.js";
import { resolveRvParsed } from "./rv-resolve.js";
import { registerPanelReviewTool } from "./panel-tool.js";

/**
 * Captured at `session_start` so the synchronous-ish `getArgumentCompletions`
 * callback (which receives only the argument prefix) can read the live model
 * registry without ctx. Stays undefined in non-TUI/print mode; completions then
 * gracefully degrade to the static `RV_COMPLETIONS` fallback.
 */
let capturedModels: ModelInfo[] | undefined;
let capturedPrimaryProvider: string | undefined;
let capturedLocale: ReturnType<typeof detectRvLocale> = "en";

function sampleSessionText(
  sessionManager: { getEntries?: () => Array<{ type?: string; content?: unknown }> },
): string[] {
  const out: string[] = [];
  try {
    const entries = sessionManager.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0 && out.length < 12; i--) {
      const e = entries[i];
      if (e.type !== "message") continue;
      const c = e.content;
      if (typeof c === "string") out.push(c);
      else if (c && typeof c === "object" && "text" in c && typeof (c as { text: string }).text === "string") {
        out.push((c as { text: string }).text);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

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
  registerPanelReviewTool(pi);
  pi.on("session_start", (_event, ctx) => {
    try {
      const available = ctx.modelRegistry?.getAvailable?.() ?? [];
      capturedModels = available.map((m) => toModelInfo(m as unknown as Parameters<typeof toModelInfo>[0]));
      capturedPrimaryProvider = ctx.model?.provider;
      capturedLocale = detectRvLocale(sampleSessionText(ctx.sessionManager));
    } catch {
      capturedModels = undefined;
      capturedPrimaryProvider = undefined;
      capturedLocale = "en";
    }
  });

  function localeForHandler(ctx: { sessionManager?: Parameters<typeof sampleSessionText>[0] }): typeof capturedLocale {
    try {
      return detectRvLocale(sampleSessionText(ctx.sessionManager ?? { getEntries: () => [] }));
    } catch {
      return capturedLocale;
    }
  }

  function argumentCompletions(prefix: string): ReturnType<typeof buildRvCompletions> {
    if (capturedModels && capturedModels.length > 0) {
      const dynamic = buildRvCompletions(prefix, {
        models: capturedModels,
        primaryProvider: capturedPrimaryProvider,
        locale: capturedLocale,
      });
      if (dynamic && dynamic.length) return dynamic;
    }
    const filtered = RV_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
    return filtered.length
      ? filtered.map(({ value, hint }) => ({ value, label: value, description: hint }))
      : null;
  }

  function handleRvCommand(strategy: RvStrategy, rawArgs: string, ctx: { ui: { notify: (message: string, level?: "warning" | "info" | "error") => void }; sessionManager?: Parameters<typeof sampleSessionText>[0] }): void {
    const trimmed = rawArgs.trim();
    if (strategy !== "models" && !trimmed) {
      ctx.ui.notify(
        strategy === "loop"
          ? "/rv-loop needs a natural-language target. Try: /rv-loop @src"
          : "/rv needs a natural-language target or `models`. Try: /rv @src | /rv-models",
        "warning",
      );
      return;
    }

    const parsed = parseRvArgs(trimmed, strategy);
    const validation = validateRvParsed(parsed);
    if (!validation.ok) {
      ctx.ui.notify(validation.message, "warning");
      return;
    }

    if (!parsed.modelsOnly && !parsed.target && !parsed.continueHandle) {
      ctx.ui.notify("/rv needs a natural-language target, --continue <handle>, or /rv-models.", "warning");
      return;
    }

    const resolved = resolveRvParsed(parsed, capturedModels ?? [], capturedPrimaryProvider);
    if (resolved.ambiguousModels?.length) {
      ctx.ui.notify(
        `Model "${parsed.model}" is ambiguous. Candidates: ${resolved.ambiguousModels.join(", ")}. Re-run with an exact provider/model.`,
        "warning",
      );
      return;
    }

    pi.sendUserMessage(buildRvOrchestrationPrompt(resolved.parsed, localeForHandler(ctx), resolved.notes));
  }

  pi.registerCommand("rv", {
    description:
      "Panel review. Usage: /rv [--mode plan|challenge] [--model id] [--thinking level] [--keep-session] <natural-language target> | /rv --continue <handle> [opts] [text] | /rv models",
    getArgumentCompletions: argumentCompletions,
    handler: async (rawArgs, ctx) => handleRvCommand("panel", rawArgs, ctx),
  });

  pi.registerCommand("rv-loop", {
    description:
      "Loop closeout review. Usage: /rv-loop [--mode plan|challenge] [--model id] [--max-rounds n] <natural-language target>",
    getArgumentCompletions: argumentCompletions,
    handler: async (rawArgs, ctx) => handleRvCommand("loop", rawArgs, ctx),
  });

  pi.registerCommand("rv-models", {
    description: "List pi-review models. Usage: /rv-models",
    handler: async (_rawArgs, ctx) => handleRvCommand("models", "", ctx),
  });
}
