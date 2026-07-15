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

// ---------------------------------------------------------------------------
// Streaming event parser (A + B): forwards readable text deltas to the
// terminal, emits semantic milestone notices, and accumulates token usage —
// all from pi's --mode json event stream, without requiring --progress-log.
// ---------------------------------------------------------------------------

export interface StreamEventEmitter {
  /** Called for every text chunk that should be shown to the human. */
  onText(chunk: string): void;
  /** Called for every semantic milestone (already formatted, ends with \n). */
  onMilestone(line: string): void;
  /** Structured activity for renderers that need more than human milestone text. */
  onActivity?: (event: JsonStreamActivity) => void;
}

export type JsonStreamActivity =
  | { type: "turn.started"; turn: number }
  | { type: "tool.started"; tool: string }
  | { type: "tool.finished"; tool: string }
  | { type: "text.delta"; text: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "agent.finished" };

export interface StreamedUsage {
  usage?: TokenUsage;
  responseModel?: string;
}

interface StreamLikeEvent {
  type?: string;
  toolName?: string;
  message?: { role?: string; usage?: UsageLike; model?: string; responseModel?: string };
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    partial?: { role?: string; usage?: UsageLike; model?: string; responseModel?: string };
  };
}

/**
 * Feed one chunk of stdout from pi --mode json. Splits on newlines, buffers
 * partial lines, and emits text deltas + milestone notices + usage updates.
 * Returns nothing; the caller reads final usage via `streamedUsage()`.
 */
export class JsonEventStream {
  private buffer = "";
  private readonly emit: StreamEventEmitter;
  private readonly accumulate: TokenUsage;
  private sawAnyUsage = false;
  private responseModel: string | undefined;
  private turn = 0;
  private inAssistantTurn = false;

  constructor(emit: StreamEventEmitter) {
    this.emit = emit;
    this.accumulate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  }

  /** Feed a raw stdout chunk (may contain partial JSON lines). */
  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.processLine(line);
    }
  }

  /** Flush any trailing partial line (call at end of stream). */
  flush(): void {
    if (this.buffer.trim()) this.processLine(this.buffer);
    this.buffer = "";
  }

  /** Final accumulated token usage (undefined if no usage seen). */
  usage(): StreamedUsage {
    if (!this.sawAnyUsage) return {};
    const result: StreamedUsage = { usage: this.accumulate };
    if (this.responseModel) result.responseModel = this.responseModel;
    return result;
  }

  private processLine(raw: string): void {
    if (!raw.trim()) return;
    let event: StreamLikeEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return; // unparseable lines are skipped gracefully
    }
    this.handle(event);
  }

  private handle(event: StreamLikeEvent): void {
    const t = event.type;
    // Accumulate usage from any message/turn/agent_end carrying it.
    const usageSources: Array<{ usage?: UsageLike; model?: string; responseModel?: string }> = [];
    if (event.message?.usage) usageSources.push(event.message);
    if (event.assistantMessageEvent?.partial?.usage) usageSources.push(event.assistantMessageEvent.partial);
    if (t === "agent_end" && Array.isArray((event as { messages?: unknown }).messages)) {
      for (const m of (event as { messages: Array<{ usage?: UsageLike; responseModel?: string; model?: string }> }).messages) {
        if (m?.usage) usageSources.push(m);
      }
    }
    for (const s of usageSources) {
      if (s.usage) {
        accumulateUsage(this.accumulate, s.usage);
        this.sawAnyUsage = true;
      }
      if (s.responseModel) this.responseModel = s.responseModel;
      else if (s.model && !this.responseModel) this.responseModel = s.model;
      if (s.usage) this.emit.onActivity?.({ type: "usage", usage: { ...this.accumulate } });
    }

    // Text deltas -> forward to the human-readable terminal.
    if (t === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (typeof delta === "string" && delta) {
        this.emit.onText(delta);
        this.emit.onActivity?.({ type: "text.delta", text: delta });
      }
    }

    // Semantic milestones (B).
    switch (t) {
      case "agent_start":
        this.emit.onMilestone("pi-review: review started\n");
        break;
      case "turn_start":
        this.turn += 1;
        this.inAssistantTurn = false;
        if (this.turn > 1) this.emit.onMilestone(`pi-review: turn ${this.turn}\n`);
        this.emit.onActivity?.({ type: "turn.started", turn: this.turn });
        break;
      case "message_start":
        if (event.message?.role === "assistant") this.inAssistantTurn = true;
        break;
      case "tool_execution_start":
        this.emit.onMilestone(`pi-review: tool ${event.toolName ?? "unknown"} started\n`);
        this.emit.onActivity?.({ type: "tool.started", tool: event.toolName ?? "unknown" });
        break;
      case "tool_execution_end":
        this.emit.onMilestone(`pi-review: tool ${event.toolName ?? "unknown"} finished\n`);
        this.emit.onActivity?.({ type: "tool.finished", tool: event.toolName ?? "unknown" });
        break;
      case "agent_end":
        this.emit.onMilestone("pi-review: review finished\n");
        this.emit.onActivity?.({ type: "agent.finished" });
        break;
    }
  }
}
