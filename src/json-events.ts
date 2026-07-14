// Parses pi's `--mode json` event stream. That format is owned by the pi
// binary, not a contract pi-review guarantees, so parsing degrades
// gracefully (never throws) when lines are malformed or events are missing.

interface AssistantLikeMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

import type { TokenUsage } from "./types.js";

export interface ExtractedFinalText {
  text: string;
  error?: string;
  fatal?: boolean;
}

export interface ExtractedUsage {
  usage?: TokenUsage;
  /** The model id pi reported for the final assistant message, if any. */
  responseModel?: string;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function accumulateUsage(into: TokenUsage, usage: UsageLike | undefined): void {
  if (!usage) return;
  // input/cacheRead are prompt-scoped maxima (reported per message, not summed);
  // output is additive across assistant turns.
  into.input = Math.max(into.input, num(usage.input));
  into.cacheRead = Math.max(into.cacheRead, num(usage.cacheRead));
  into.cacheWrite = Math.max(into.cacheWrite, num(usage.cacheWrite));
  into.output += num(usage.output);
  into.reasoning = Math.max(into.reasoning, num(usage.reasoning));
  into.totalTokens = Math.max(into.totalTokens, num(usage.totalTokens));
  if (typeof usage.cost?.total === "number") {
    into.costTotal = (into.costTotal ?? 0) + usage.cost.total;
  }
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

/**
 * Extract token usage and the response model from a pi `--mode json` event
 * stream. Usage is accumulated from assistant message/turn/agent_end events.
 * Degrades gracefully (returns undefined) when usage fields are absent.
 */
export function extractUsage(jsonLinesText: string): ExtractedUsage {
  const usage: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
  };
  let sawAnyUsage = false;
  let responseModel: string | undefined;

  for (const line of jsonLinesText.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; message?: { role?: string; usage?: UsageLike; model?: string; responseModel?: string }; messages?: Array<{ role?: string; usage?: UsageLike; model?: string; responseModel?: string }> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const candidates: Array<{ usage?: UsageLike; model?: string; responseModel?: string }> = [];
    if (event?.message?.usage) candidates.push(event.message);
    else if (event?.message?.responseModel || event?.message?.model) candidates.push(event.message);
    if (event?.type === "agent_end" && Array.isArray(event.messages)) {
      for (const m of event.messages) {
        if (m?.usage || m?.responseModel || m?.model) candidates.push(m);
      }
    }

    for (const c of candidates) {
      if (c.usage) {
        accumulateUsage(usage, c.usage);
        sawAnyUsage = true;
      }
      if (c.responseModel) responseModel = c.responseModel;
      else if (c.model && !responseModel) responseModel = c.model;
    }
  }

  if (!sawAnyUsage) return {};
  const result: ExtractedUsage = { usage };
  if (responseModel) result.responseModel = responseModel;
  return result;
}
