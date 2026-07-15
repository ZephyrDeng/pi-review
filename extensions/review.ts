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
/** Keep a registry handle so completions can refresh models lazily if session_start saw none yet. */
let capturedModelRegistry: { getAvailable?: () => unknown[] } | undefined;

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

function refreshCapturedModels(
  registry?: { getAvailable?: () => unknown[] },
  primaryProvider?: string,
): ModelInfo[] {
  if (registry) capturedModelRegistry = registry;
  if (primaryProvider) capturedPrimaryProvider = primaryProvider;
  try {
    const available = (capturedModelRegistry?.getAvailable?.() ?? []) as Array<Parameters<typeof toModelInfo>[0]>;
    if (available.length > 0) {
      capturedModels = available.map((m) => toModelInfo(m));
    }
  } catch {
    // keep previous capture
  }
  return capturedModels ?? [];
}

export default function piReviewExtension(pi: ExtensionAPI) {
  registerPanelReviewTool(pi);
  pi.on("session_start", (_event, ctx) => {
    try {
      capturedModelRegistry = ctx.modelRegistry;
      capturedPrimaryProvider = ctx.model?.provider;
      capturedLocale = detectRvLocale(sampleSessionText(ctx.sessionManager));
      refreshCapturedModels(ctx.modelRegistry, ctx.model?.provider);
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

  function argumentCompletions(
    prefix: string,
    strategy: RvStrategy = "panel",
  ): ReturnType<typeof buildRvCompletions> {
    // Always try a lazy refresh. session_start can race before providers finish loading.
    const models = refreshCapturedModels();
    const dynamic = buildRvCompletions(prefix, {
      models,
      primaryProvider: capturedPrimaryProvider,
      locale: capturedLocale,
      strategy,
    });
    if (dynamic && dynamic.length) return dynamic;

    // Strategy-aware static fallback when the live registry is unavailable.
    const q = prefix.trim().toLowerCase();
    const staticItems: { value: string; label: string; description?: string }[] = [];
    if (strategy === "models") {
      staticItems.push({ value: "", label: "list models", description: "No args needed · runs pi-review models" });
      return staticItems;
    }
    if (strategy === "loop") {
      staticItems.push(
        { value: "--model ", label: "--model", description: "Pick reviewer model (short ids ok)" },
        { value: "--thinking ", label: "--thinking", description: "off|minimal|low|medium|high|xhigh" },
        { value: "--max-rounds 1 ", label: "--max-rounds 1", description: "One gate, then host fix point" },
        { value: "--max-rounds 2 ", label: "--max-rounds 2", description: "Two review gates" },
        { value: "--mode code ", label: "--mode code", description: "Code closeout" },
        { value: "@src", label: "@src", description: "Natural-language / path target" },
      );
    } else {
      staticItems.push(
        { value: "--model ", label: "--model", description: "Pick panel model (short ids ok)" },
        { value: "--thinking ", label: "--thinking", description: "off|minimal|low|medium|high|xhigh" },
        { value: "--mode code ", label: "--mode code", description: "Code / diff review" },
        { value: "--mode plan ", label: "--mode plan", description: "Architecture / plan review" },
        { value: "--mode challenge ", label: "--mode challenge", description: "Adversarial plan review" },
        { value: "--keep-session ", label: "--keep-session", description: "Persist for /rv --continue" },
        { value: "@src", label: "@src", description: "Natural-language / path target" },
        { value: "models", label: "models", description: "Or use /rv-models" },
      );
    }
    // Bare model-ish text: still offer to wrap as --model <typed>
    if (q && !q.startsWith("-") && !q.startsWith("@") && !q.includes(" ")) {
      staticItems.unshift({
        value: `--model ${prefix.trim()}`,
        label: `--model ${prefix.trim()}`,
        description: "Use typed model token (resolved against catalog at run time)",
      });
      if (prefix.includes("/") && !prefix.includes(":")) {
        for (const level of ["high", "xhigh", "medium"]) {
          staticItems.unshift({
            value: `--model ${prefix.trim()}:${level}`,
            label: `${prefix.trim()}:${level}`,
            description: `thinking ${level}`,
          });
        }
      }
    }
    const filtered = staticItems.filter((item) => {
      if (!q) return true;
      return (
        item.value.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.value.startsWith(prefix) ||
        q.startsWith(item.value.trim().toLowerCase())
      );
    });
    return filtered.length ? filtered : staticItems.slice(0, 6);
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
    getArgumentCompletions: (prefix) => argumentCompletions(prefix, "panel"),
    handler: async (rawArgs, ctx) => handleRvCommand("panel", rawArgs, ctx),
  });

  pi.registerCommand("rv-loop", {
    description:
      "Loop closeout review. Usage: /rv-loop [--mode plan|challenge] [--model id] [--max-rounds n] <natural-language target>",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix, "loop"),
    handler: async (rawArgs, ctx) => handleRvCommand("loop", rawArgs, ctx),
  });

  pi.registerCommand("rv-models", {
    description: "List pi-review models. Usage: /rv-models",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix, "models"),
    handler: async (_rawArgs, ctx) => handleRvCommand("models", "", ctx),
  });
}
