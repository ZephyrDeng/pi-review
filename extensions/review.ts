import type { ExtensionAPI, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  buildRvCompletions,
  type ModelInfo,
} from "./rv-completions.js";
import { detectRvLocale } from "./rv-locale.js";
import {
  buildRvOrchestrationPrompt,
  parseRvArgs,
  validateRvParsed,
  type RvStrategy,
} from "./rv-prompts.js";
import { resolveRvParsed } from "./rv-resolve.js";
import {
  runRvInteractiveWizard,
  shouldRunInteractiveWizard,
  stripInteractiveToken,
} from "./rv-interactive.js";
import { RvModelPickerComponent, type ModelPickerResult } from "./rv-model-picker.js";
import { registerPanelReviewTool } from "./panel-tool.js";

/**
 * Captured at `session_start` so the synchronous-ish `getArgumentCompletions`
 * callback (which receives only the argument prefix) can read the live model
 * registry without ctx. Stays undefined in non-TUI/print mode; the pure
 * completion builder then provides prefix-safe static suggestions.
 */
let capturedModels: ModelInfo[] | undefined;
let capturedPrimaryProvider: string | undefined;
let capturedLocale: ReturnType<typeof detectRvLocale> = detectRvLocale([]);
/** Keep a registry handle so completions can refresh models lazily if session_start saw none yet. */
let capturedModelRegistry: { getAvailable?: () => unknown[] } | undefined;
/** Keep session manager so locale can re-detect on each completion as Chinese messages arrive. */
let capturedSessionManager: { getEntries?: () => Array<{ type?: string; content?: unknown }> } | undefined;

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
      // Model availability is session-scoped. Clear the previous snapshot before
      // the new registry is sampled so an empty/cold catalog cannot leak stale IDs.
      capturedModels = undefined;
      capturedModelRegistry = ctx.modelRegistry;
      capturedPrimaryProvider = ctx.model?.provider;
      capturedSessionManager = ctx.sessionManager;
      capturedLocale = detectRvLocale(sampleSessionText(ctx.sessionManager));
      refreshCapturedModels(ctx.modelRegistry, ctx.model?.provider);
    } catch {
      capturedModels = undefined;
      capturedPrimaryProvider = undefined;
      capturedLocale = detectRvLocale([]);
    }
  });

  function localeForHandler(ctx?: { sessionManager?: Parameters<typeof sampleSessionText>[0] }): typeof capturedLocale {
    try {
      const manager = ctx?.sessionManager ?? capturedSessionManager ?? { getEntries: () => [] };
      capturedLocale = detectRvLocale(sampleSessionText(manager));
      return capturedLocale;
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
    // Re-detect locale every completion so Chinese sessions don't stay stuck on English labels.
    const locale = localeForHandler();
    return buildRvCompletions(prefix, {
      models,
      primaryProvider: capturedPrimaryProvider,
      locale,
      strategy,
    });
  }

  async function handleRvCommand(
    strategy: RvStrategy,
    rawArgs: string,
    ctx: {
      ui: {
        notify: (message: string, level?: "warning" | "info" | "error") => void;
        select?: (title: string, options: string[]) => Promise<string | undefined>;
        input?: (title: string, placeholder?: string) => Promise<string | undefined>;
        confirm?: (title: string, message: string) => Promise<boolean>;
        custom?: <T>(
          factory: (
            tui: TUI,
            theme: Theme,
            keybindings: KeybindingsManager,
            done: (result: T) => void,
          ) => Component & { dispose?(): void },
          options?: { overlay?: boolean },
        ) => Promise<T>;
      };
      sessionManager?: Parameters<typeof sampleSessionText>[0];
    },
  ): Promise<void> {
    if (strategy === "models") {
      const parsed = parseRvArgs("", "models");
      pi.sendUserMessage(buildRvOrchestrationPrompt(parsed, localeForHandler(ctx)));
      return;
    }

    const interactiveRequested = shouldRunInteractiveWizard(rawArgs, parseRvArgs(stripInteractiveToken(rawArgs), strategy));
    const trimmed = stripInteractiveToken(rawArgs).trim();
    let parsed = parseRvArgs(trimmed, strategy);

    // Interactive wizard: empty command or explicit `interactive` / `--interactive` / `-i`.
    // Uses Pi select/input/confirm dialogs — no tab completion required for model assignment.
    if (interactiveRequested && ctx.ui.select && ctx.ui.input && ctx.ui.confirm) {
      const models = refreshCapturedModels();
      const locale = localeForHandler(ctx);
      const wizardResult = await runRvInteractiveWizard(
        {
          select: (title, options) => ctx.ui.select!(title, options),
          input: (title, placeholder) => ctx.ui.input!(title, placeholder),
          confirm: (title, message) => ctx.ui.confirm!(title, message),
          notify: (message, type) => ctx.ui.notify(message, type),
          // Inline searchable picker, available only in TUI mode (ctx.ui.custom).
          // The factory builds the component; the host grants focus and forwards
          // keystrokes. print/RPC modes have no `custom` → wizard falls back to
          // the select-based flow.
          customModelPicker: ctx.ui.custom
            ? (pickerInput) =>
                ctx.ui.custom!<ModelPickerResult>((tui, theme, keybindings, done) =>
                  RvModelPickerComponent.create(
                    tui,
                    theme as unknown as Theme,
                    keybindings,
                    done,
                    pickerInput,
                  ),
                )
            : undefined,
        },
        {
          strategy: strategy === "loop" ? "loop" : "panel",
          seed: parsed,
          models,
          locale,
          primaryProvider: capturedPrimaryProvider,
        },
      );
      if (!wizardResult) return;
      parsed = wizardResult;
    } else if (!trimmed) {
      // No dialog API (print/RPC) and empty args → tell user how to run interactive.
      ctx.ui.notify(
        strategy === "loop"
          ? "/rv-loop interactive  · or /rv-loop --reviewers 3 --reviewer-model r1=... @src"
          : "/rv interactive  · or /rv --panel code-experts @src",
        "warning",
      );
      return;
    }

    const validation = validateRvParsed(parsed);
    if (!validation.ok) {
      ctx.ui.notify(validation.message, "warning");
      return;
    }

    if (!parsed.modelsOnly && !parsed.target && !parsed.continueHandle) {
      ctx.ui.notify("/rv needs a natural-language target, --continue <handle>, interactive, or /rv-models.", "warning");
      return;
    }

    const resolved = resolveRvParsed(parsed, refreshCapturedModels(), capturedPrimaryProvider);
    if (resolved.ambiguousModels?.length) {
      // Prefer interactive disambiguation when dialogs exist.
      if (ctx.ui.select) {
        const pick = await ctx.ui.select(
          `Ambiguous model "${parsed.model}"`,
          resolved.ambiguousModels,
        );
        if (!pick) return;
        resolved.parsed = { ...resolved.parsed, model: pick };
        resolved.notes.push(`model ${parsed.model} → ${pick} (interactive pick)`);
      } else {
        ctx.ui.notify(
          `Model "${parsed.model}" is ambiguous. Candidates: ${resolved.ambiguousModels.join(", ")}. Re-run with an exact provider/model.`,
          "warning",
        );
        return;
      }
    }

    pi.sendUserMessage(buildRvOrchestrationPrompt(resolved.parsed, localeForHandler(ctx), resolved.notes));
  }

  pi.registerCommand("rv", {
    description:
      "Panel review. /rv interactive for dialog wizard; or /rv [flags] <natural-language target>",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix, "panel"),
    handler: async (rawArgs, ctx) => handleRvCommand("panel", rawArgs, ctx),
  });

  pi.registerCommand("rv-loop", {
    description:
      "Loop closeout. /rv-loop interactive for dialog wizard (pick reviewers & models with arrows); or pass flags",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix, "loop"),
    handler: async (rawArgs, ctx) => handleRvCommand("loop", rawArgs, ctx),
  });

  pi.registerCommand("rv-models", {
    description: "List pi-review models. Usage: /rv-models",
    getArgumentCompletions: (prefix) => argumentCompletions(prefix, "models"),
    handler: async (_rawArgs, ctx) => handleRvCommand("models", "", ctx),
  });
}
