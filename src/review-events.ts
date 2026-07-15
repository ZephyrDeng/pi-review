// Stable, pi-review-owned event contract for live renderers and replay.
// Raw Pi JSONL remains an implementation detail of the child process.

import type { PanelReviewMeta, ReviewerSubmission, TokenUsage } from "./types.js";

export const REVIEW_EVENT_VERSION = 1 as const;
export const REVIEW_EVENT_TEXT_LIMIT = 512;

export interface ReviewerIdentity {
  reviewerId: string;
  role: string;
  model: string | null;
  thinking?: string;
}

type ReviewEventBase<T extends string> = {
  v: typeof REVIEW_EVENT_VERSION;
  runId: string;
  seq: number;
  at: number;
  type: T;
};

export type ReviewEvent =
  | (ReviewEventBase<"panel.started"> & { target: string; mode: string; panelPreset?: string; reviewers: ReviewerIdentity[] })
  | (ReviewEventBase<"reviewer.queued"> & { reviewerId: string })
  | (ReviewEventBase<"reviewer.started"> & { reviewerId: string })
  | (ReviewEventBase<"reviewer.turn.started"> & { reviewerId: string; turn: number })
  | (ReviewEventBase<"reviewer.tool.started"> & { reviewerId: string; tool: string; summary?: string })
  | (ReviewEventBase<"reviewer.tool.finished"> & { reviewerId: string; tool: string; summary?: string })
  | (ReviewEventBase<"reviewer.text.delta"> & { reviewerId: string; text: string })
  | (ReviewEventBase<"reviewer.usage"> & { reviewerId: string; usage: TokenUsage })
  | (ReviewEventBase<"reviewer.completed"> & { reviewerId: string; submission: ReviewerSubmission })
  | (ReviewEventBase<"reviewer.failed"> & { reviewerId: string; message: string })
  | (ReviewEventBase<"reviewer.cancelled"> & { reviewerId: string; message?: string })
  | ReviewEventBase<"aggregation.started">
  | (ReviewEventBase<"panel.completed"> & { meta: PanelReviewMeta });

type ReviewEventPayload<T extends ReviewEvent["type"]> = Omit<
  Extract<ReviewEvent, { type: T }>,
  "v" | "runId" | "seq" | "at" | "type"
>;

export type ReviewEventListener = (event: ReviewEvent) => void;

/** Replace common secret-shaped values and cap any renderer-visible free text. */
export function redactReviewEventText(value: string, limit = REVIEW_EVENT_TEXT_LIMIT): string {
  const redacted = value
    .replace(/\b(?:sk|rk|pk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return redacted.length <= limit ? redacted : `${redacted.slice(0, Math.max(0, limit - 1))}…`;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactReviewEventText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactValue(nested)]));
  }
  return value;
}

function redactEvent<T extends ReviewEvent>(event: T): T {
  const { v, runId, seq, at, type, ...payload } = event;
  return { v, runId, seq, at, type, ...(redactValue(payload) as object) } as T;
}

/** Build one ordered event stream for exactly one panel run. */
export function createReviewEventEmitter(runId: string, listener?: ReviewEventListener, now: () => number = Date.now) {
  let seq = 0;
  return <T extends ReviewEvent["type"]>(type: T, payload: ReviewEventPayload<T>): Extract<ReviewEvent, { type: T }> => {
    const event = redactEvent({
      v: REVIEW_EVENT_VERSION,
      runId,
      seq: ++seq,
      at: now(),
      type,
      ...payload,
    } as Extract<ReviewEvent, { type: T }>);
    listener?.(event);
    return event;
  };
}
