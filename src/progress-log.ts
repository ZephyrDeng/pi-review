// Progress-log tee for pi's --mode json event stream. A verbatim tee grows
// O(n^2) with assistant message length: every message_update event repeats the
// full cumulative message snapshot (content so far, tool-call args, plus
// api/provider/model/usage/timestamp metadata — twice, as
// assistantMessageEvent.partial and as a top-level message) alongside a tiny
// delta, which measured ~1600x byte amplification on real reviews. The default
// writer reduces those per-delta snapshots to their `usage` field — the only
// snapshot field pi-review's own JsonEventStream consumes from message_update,
// so a slimmed log replays through the parser with no feature loss. Message
// boundaries (message_end, turn_end, agent_end) keep the complete record, so
// the slimmed log still reconstructs the review. `raw` restores the verbatim
// tee for debugging.

import fs from "node:fs";
import path from "node:path";

interface SlimResult {
  slimmed: unknown;
  changed: boolean;
}

/** Reduce a per-delta message snapshot to `{ usage }`, or nothing without usage. */
function reduceSnapshotToUsage(snapshot: unknown): SlimResult {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { slimmed: snapshot, changed: false };
  }
  const record = snapshot as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.usage !== undefined) {
    if (keys.length === 1) return { slimmed: snapshot, changed: false }; // already reduced
    return { slimmed: { usage: record.usage }, changed: true };
  }
  if (keys.length === 0) return { slimmed: snapshot, changed: false };
  // JSON.stringify omits undefined properties, so this deletes the key.
  return { slimmed: undefined, changed: true };
}

/**
 * Slim one complete event line: reduce the cumulative message snapshots on
 * message_update events (`assistantMessageEvent.partial` and the duplicate
 * top-level `message`) to their `usage` field. Every other line — including
 * malformed or truncated ones — passes through byte-for-byte, and re-slimming
 * an already slimmed line is a no-op.
 */
export function slimProgressLine(line: string): string {
  if (!line.includes("message_update")) return line;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return line;
  const record = event as Record<string, unknown>;
  if (record.type !== "message_update") return line;

  let changed = false;
  const assistantMessageEvent = record.assistantMessageEvent;
  if (assistantMessageEvent && typeof assistantMessageEvent === "object" && !Array.isArray(assistantMessageEvent)) {
    const eventRecord = assistantMessageEvent as Record<string, unknown>;
    if ("partial" in eventRecord) {
      const partial = reduceSnapshotToUsage(eventRecord.partial);
      if (partial.changed) {
        eventRecord.partial = partial.slimmed;
        changed = true;
      }
    }
  }
  if ("message" in record) {
    const message = reduceSnapshotToUsage(record.message);
    if (message.changed) {
      record.message = message.slimmed;
      changed = true;
    }
  }

  return changed ? JSON.stringify(record) : line;
}

/**
 * Append-mode progress-log sink. Accepts arbitrary chunk boundaries, slims per
 * complete line by default, and passes chunks through verbatim in raw mode.
 * The constructor may throw when the parent directory cannot be created;
 * later write errors are captured and reported by end().
 */
export class ProgressLogWriter {
  private readonly stream: fs.WriteStream;
  private readonly raw: boolean;
  private buffer = "";
  private writeError: Error | undefined;

  constructor(filePath: string, options: { raw?: boolean } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
    this.stream.on("error", (error) => {
      this.writeError = error;
    });
    this.raw = Boolean(options.raw);
  }

  write(chunk: string): void {
    if (this.raw) {
      this.stream.write(chunk);
      return;
    }
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.stream.write(`${slimProgressLine(line)}\n`);
    }
  }

  /** Flush any trailing partial line, close the file, and report the first write error. */
  async end(): Promise<Error | undefined> {
    if (!this.raw && this.buffer) {
      this.stream.write(slimProgressLine(this.buffer));
      this.buffer = "";
    }
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
    return this.writeError;
  }
}
