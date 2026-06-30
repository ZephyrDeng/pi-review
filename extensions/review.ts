import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("rv", {
    description: "Delegate a pi-review to the agent. Usage: /rv @file-or-text",
    getArgumentCompletions: (prefix) => {
      const items = [
        "@",
        "--mode challenge",
        "--mode plan",
        "--model ",
        "--keep-session",
        "models",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (rawArgs, ctx) => {
      const trimmed = rawArgs.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /rv [--mode challenge] @file-or-text", "warning");
        return;
      }
      pi.sendUserMessage(`使用 pi-review 审查: ${trimmed}`);
    },
  });
}
