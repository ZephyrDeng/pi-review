import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildRvOrchestrationPrompt,
  parseRvArgs,
  RV_COMPLETIONS,
  validateRvParsed,
} from "./rv-prompts.js";

export default function piReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("rv", {
    description:
      "Delegate pi-review to the agent. Usage: /rv [--mode plan|challenge] [--model id] [--keep-session] [--no-stream] @target | /rv --continue <handle> [opts] [text] | models",
    getArgumentCompletions: (prefix) => {
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