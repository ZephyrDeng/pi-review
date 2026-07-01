// Parses pi's `--mode json` event stream. That format is owned by the pi
// binary, not a contract pi-review guarantees, so parsing degrades
// gracefully (never throws) when lines are malformed or events are missing.

interface AssistantLikeMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

export interface ExtractedFinalText {
  text: string;
  error?: string;
  fatal?: boolean;
}

function textFromMessage(message: AssistantLikeMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function isFatalStop(message: AssistantLikeMessage): boolean {
  return message.stopReason === "error" || message.stopReason === "aborted";
}

export function extractFinalText(jsonLinesText: string): ExtractedFinalText {
  let lastAssistantMessage: AssistantLikeMessage | undefined;
  let sawAgentEnd = false;

  for (const line of jsonLinesText.split("\n")) {
    if (!line.trim()) continue;

    let event: { type?: string; message?: AssistantLikeMessage; messages?: AssistantLikeMessage[] };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.message?.role === "assistant") {
      lastAssistantMessage = event.message;
    }

    if (event?.type === "agent_end" && Array.isArray(event.messages)) {
      sawAgentEnd = true;
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const message = event.messages[i];
        if (message?.role === "assistant") {
          lastAssistantMessage = message;
          break;
        }
      }
    }
  }

  if (!lastAssistantMessage) {
    return { text: "", error: "no assistant message found in --mode json output" };
  }

  if (isFatalStop(lastAssistantMessage)) {
    return {
      text: textFromMessage(lastAssistantMessage),
      error:
        lastAssistantMessage.errorMessage ||
        `assistant turn ended with stopReason=${lastAssistantMessage.stopReason}`,
      fatal: true,
    };
  }

  const text = textFromMessage(lastAssistantMessage);
  if (!text) {
    return { text: "", error: "final assistant message had no text content" };
  }

  if (!sawAgentEnd) {
    return { text, error: "no agent_end event found; used last streamed assistant message as a fallback" };
  }

  return { text };
}
