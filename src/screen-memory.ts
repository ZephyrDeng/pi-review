// pi-review screen memory: the screening catalog learns from use.
//
// Two mechanisms share the pi-review state dir (siblings of config.json):
//
// - screen-patterns.json — a user-declared pattern catalog merged over the
//   builtin SCREEN_PATTERNS, plus a `disabled` list to retire entries that
//   misfire on this codebase. PI_REVIEW_SCREEN_PATTERNS names one extra file
//   (e.g. a project catalog committed to the repo) which loads last and wins
//   id conflicts — that is how a team shares its own defect patterns.
//
// - screen-memory.jsonl — every flagged hunk appends one JSONL entry with a
//   code hash and its verdict. `pi-review screen-memory` aggregates the log:
//   recurring unmatched signals are the evidence for new patterns, and hit
//   frequencies show which entries earn their place. Promotion is always a
//   human/agent edit of screen-patterns.json — screen never rewrites its own
//   catalog. PI_REVIEW_SCREEN_MEMORY=0 disables recording; the file path moves
//   with PI_REVIEW_SCREEN_MEMORY_FILE.
//
// Both files are advisory: malformed lines and invalid JSON warn on stderr and
// degrade to "nothing loaded" — memory must never break the gate.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { configFilePath } from "./pi-config.js";
import { expandMaybeHome } from "./utils.js";
import type { ScreenPattern } from "./screen.js";

/** A hunk flagged by screening (pattern hit or catch-all at/over threshold). */
export interface FlaggedScreenHunk {
  path: string;
  hunk: string;
  startLine: number;
  endLine: number;
  catchAll?: number;
  patterns: string[];
  code: string;
}

/** One JSONL row in screen-memory.jsonl. */
export interface ScreenMemoryEntry {
  ts: string;
  path: string;
  hunk: string;
  lines: [number, number];
  catchAll?: number;
  /** Pattern ids that fired; empty means the catch-all alone flagged it. */
  patterns: string[];
  /** Catch-all fired with no catalog hit — a promotion candidate. */
  unmatched: boolean;
  /** sha256 of the hunk code — dedupe key across runs. */
  hash: string;
  /** Truncated hunk source for later inspection; absent past SNIPPET_LIMIT. */
  code?: string;
  /** How many runs flagged this same (path, hunk, hash). Absent = 1. */
  seen?: number;
}

/** Hard cap keeps the log self-bounding; on overflow the newest entries stay. */
export const MEMORY_ENTRY_LIMIT = 500;
export const MEMORY_ENTRY_KEEP = 400;
/** Stored code snippets never exceed this many characters. */
export const SNIPPET_LIMIT = 1600;

const VALID_SEVERITIES = new Set(["critical", "major", "minor"]);
const VALID_CATEGORIES = new Set(["correctness", "security", "data-loss", "performance"]);
const PATTERN_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** pi-review state dir: the directory containing the effective config file. */
function stateDir(env: NodeJS.ProcessEnv): string {
  return path.dirname(configFilePath(env));
}

/** Machine-level user catalog, sibling of config.json. */
export function screenPatternsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), "screen-patterns.json");
}

export function screenMemoryFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_REVIEW_SCREEN_MEMORY_FILE?.trim();
  if (override) return expandMaybeHome(override)!;
  return path.join(stateDir(env), "screen-memory.jsonl");
}

export function screenMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PI_REVIEW_SCREEN_MEMORY?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export interface ScreenPatternsFileLoad {
  patterns: Record<string, ScreenPattern>;
  disabled: string[];
  warnings: string[];
}

/**
 * Parse one patterns file, lenient like pi-config: bad entries warn and are
 * skipped, unknown keys are ignored, invalid JSON yields an empty file.
 * Shape: { "patterns": {id: {title, severity, category, recommendation}},
 *          "disabled": [id, ...] }
 */
export function parseScreenPatternsFile(text: string, source: string): ScreenPatternsFileLoad {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      patterns: {},
      disabled: [],
      warnings: [`${source} is not valid JSON (${(error as Error).message}); treating it as empty`],
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { patterns: {}, disabled: [], warnings: [`${source} must contain a JSON object; treating it as empty`] };
  }
  const record = raw as Record<string, unknown>;
  const patterns: Record<string, ScreenPattern> = {};
  if (record.patterns !== undefined && record.patterns !== null) {
    if (typeof record.patterns !== "object" || Array.isArray(record.patterns)) {
      warnings.push(`${source}: "patterns" must be an object; ignoring it`);
    } else {
      for (const [id, value] of Object.entries(record.patterns as Record<string, unknown>)) {
        if (!PATTERN_ID_RE.test(id)) {
          warnings.push(`${source}: pattern id "${id}" must match ${PATTERN_ID_RE}; skipping it`);
          continue;
        }
        const entry = value as Record<string, unknown>;
        const problems: string[] = [];
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) problems.push("entry must be an object");
        else {
          if (typeof entry.title !== "string" || !entry.title.trim()) problems.push("title must be a non-empty string");
          if (typeof entry.severity !== "string" || !VALID_SEVERITIES.has(entry.severity))
            problems.push(`severity must be one of ${[...VALID_SEVERITIES].join("/")}`);
          if (typeof entry.category !== "string" || !VALID_CATEGORIES.has(entry.category))
            problems.push(`category must be one of ${[...VALID_CATEGORIES].join("/")}`);
          if (typeof entry.recommendation !== "string" || !entry.recommendation.trim())
            problems.push("recommendation must be a non-empty string");
        }
        if (problems.length > 0) {
          warnings.push(`${source}: pattern "${id}" invalid (${problems.join("; ")}); skipping it`);
          continue;
        }
        patterns[id] = {
          title: (entry.title as string).trim(),
          severity: entry.severity as string,
          category: entry.category as ScreenPattern["category"],
          recommendation: (entry.recommendation as string).trim(),
        };
      }
    }
  }
  const disabled: string[] = [];
  if (record.disabled !== undefined && record.disabled !== null) {
    if (!Array.isArray(record.disabled)) {
      warnings.push(`${source}: "disabled" must be an array of pattern ids; ignoring it`);
    } else {
      for (const value of record.disabled) {
        if (typeof value === "string" && value.trim()) disabled.push(value.trim());
        else warnings.push(`${source}: "disabled" entries must be pattern id strings; skipping one`);
      }
    }
  }
  return { patterns, disabled, warnings };
}

export interface UserPatternsLoad extends ScreenPatternsFileLoad {
  /** Files that were read, in merge order (later files win id conflicts). */
  files: string[];
}

/**
 * Load user-declared patterns: the machine file first, then the extra file
 * named by PI_REVIEW_SCREEN_PATTERNS (typically a project catalog checked
 * into the repo). Later files override earlier ones on id conflicts, so a
 * project can re-tune or replace a builtin entry. Missing files are skipped
 * silently; unreadable ones warn.
 */
export function loadUserPatterns(env: NodeJS.ProcessEnv = process.env): UserPatternsLoad {
  const files = [screenPatternsFilePath(env)];
  const extra = env.PI_REVIEW_SCREEN_PATTERNS?.trim();
  if (extra) files.push(expandMaybeHome(extra)!);

  const merged: UserPatternsLoad = { patterns: {}, disabled: [], warnings: [], files: [] };
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let load: ScreenPatternsFileLoad;
    try {
      load = parseScreenPatternsFile(fs.readFileSync(file, "utf8"), file);
    } catch (error) {
      merged.warnings.push(`cannot read ${file}: ${(error as Error).message}`);
      continue;
    }
    merged.files.push(file);
    Object.assign(merged.patterns, load.patterns);
    merged.disabled.push(...load.disabled);
    merged.warnings.push(...load.warnings);
  }
  merged.disabled = [...new Set(merged.disabled)];
  return merged;
}

/** Lenient JSONL read: malformed lines are skipped, a missing file is empty. */
export function readScreenMemory(file: string): ScreenMemoryEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: ScreenMemoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ScreenMemoryEntry;
      if (entry && typeof entry === "object" && typeof entry.path === "string" && typeof entry.hunk === "string") {
        entries.push(entry);
      }
    } catch {
      // malformed line: drop it — the log is advisory telemetry
    }
  }
  return entries;
}

/**
 * Record flagged hunks in the memory log. No-ops when recording is disabled
 * or nothing was flagged. A repeated (path, hunk, code hash) refreshes the
 * stored verdict in place and bumps `seen` — so promoting a pattern visibly
 * flips its entry from unmatched to a hit — while new hashes append. The file
 * is rewritten capped at MEMORY_ENTRY_LIMIT entries (newest MEMORY_ENTRY_KEEP
 * survive) via tmp+rename with 0600 permissions: hunk code can embed the very
 * secrets the catalog flags. Best-effort: any failure warns on stderr and
 * never fails the gate.
 */
export function recordScreenMemory(flagged: FlaggedScreenHunk[], env: NodeJS.ProcessEnv = process.env): void {
  if (flagged.length === 0 || !screenMemoryEnabled(env)) return;
  try {
    const file = screenMemoryFilePath(env);
    const existing = readScreenMemory(file);
    const byKey = new Map(existing.map((e) => [`${e.path}\u0000${e.hunk}\u0000${e.hash}`, e]));
    const ts = new Date().toISOString();
    let touched = 0;
    for (const item of flagged) {
      const hash = crypto.createHash("sha256").update(item.code).digest("hex");
      const key = `${item.path}\u0000${item.hunk}\u0000${hash}`;
      const snippet = item.code.length <= SNIPPET_LIMIT ? item.code : `${item.code.slice(0, SNIPPET_LIMIT)}…`;
      const prev = byKey.get(key);
      if (prev) {
        prev.ts = ts;
        prev.lines = [item.startLine, item.endLine];
        prev.patterns = item.patterns;
        prev.unmatched = item.patterns.length === 0;
        if (item.catchAll !== undefined) prev.catchAll = item.catchAll;
        prev.seen = (prev.seen ?? 1) + 1;
        touched += 1;
        continue;
      }
      byKey.set(key, {
        ts,
        path: item.path,
        hunk: item.hunk,
        lines: [item.startLine, item.endLine],
        ...(item.catchAll !== undefined ? { catchAll: item.catchAll } : {}),
        patterns: item.patterns,
        unmatched: item.patterns.length === 0,
        hash,
        code: snippet,
        seen: 1,
      });
      touched += 1;
    }
    if (touched === 0) return;
    const all = [...byKey.values()];
    const kept = all.length > MEMORY_ENTRY_LIMIT ? all.slice(all.length - MEMORY_ENTRY_KEEP) : all;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600); // a file created before this hardening keeps its old mode otherwise
    } catch {
      // best-effort tightening; the tmp+rename above is the real guard
    }
  } catch (error) {
    process.stderr.write(`pi-review: screen memory write failed (${(error as Error).message}); continuing\n`);
  }
}


export interface UnmatchedSignalGroup {
  path: string;
  hunk: string;
  count: number;
  lastCatchAll?: number;
  lastLines: [number, number];
  /** First non-empty line of the newest hunk code, truncated. */
  sample: string;
}

export interface ScreenMemoryStats {
  entries: number;
  files: number;
  unmatchedEntries: number;
  /** Pattern id → times it fired, sorted desc. */
  patternHits: Array<{ id: string; count: number }>;
  /** Unmatched signals grouped by path+hunk, sorted by count desc. */
  unmatched: UnmatchedSignalGroup[];
}

export function aggregateScreenMemory(entries: ScreenMemoryEntry[]): ScreenMemoryStats {
  const files = new Set<string>();
  const hits = new Map<string, number>();
  const groups = new Map<string, UnmatchedSignalGroup>();
  let unmatchedEntries = 0;
  for (const entry of entries) {
    files.add(entry.path);
    for (const id of entry.patterns ?? []) {
      hits.set(id, (hits.get(id) ?? 0) + 1);
    }
    if (!entry.unmatched) continue;
    unmatchedEntries += entry.seen ?? 1;
    const key = `${entry.path}\u0000${entry.hunk}`;
    const group = groups.get(key) ?? {
      path: entry.path,
      hunk: entry.hunk,
      count: 0,
      lastLines: [0, 0],
      sample: "",
    };
    group.count += entry.seen ?? 1;
    group.lastLines = entry.lines ?? [0, 0];
    group.lastCatchAll = entry.catchAll;
    group.sample = (entry.code ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 100) ?? "";
    groups.set(key, group);
  }
  return {
    entries: entries.length,
    files: files.size,
    unmatchedEntries,
    patternHits: [...hits.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    unmatched: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}

export interface ScreenMemoryMeta {
  file: string;
  /** Where new patterns go (the machine-level patterns file). */
  patternsFile: string;
  catalog: { builtin: number; custom: number; overrides: number; disabled: number; recording: boolean };
}

export function formatScreenMemoryAscii(stats: ScreenMemoryStats, meta: ScreenMemoryMeta): string {
  const lines = ["── pi-review screen memory " + "─".repeat(14)];
  lines.push(
    `  Log        ${meta.file} · ${stats.entries} entr${stats.entries === 1 ? "y" : "ies"} across ${stats.files} file${stats.files === 1 ? "" : "s"}` +
      (meta.catalog.recording ? "" : " (recording off: PI_REVIEW_SCREEN_MEMORY=0)"),
  );
  lines.push(
    `  Catalog    ${meta.catalog.builtin} builtin · ${meta.catalog.custom} custom` +
      (meta.catalog.overrides > 0 ? ` (${meta.catalog.overrides} override${meta.catalog.overrides === 1 ? "s" : ""} builtin)` : "") +
      ` · ${meta.catalog.disabled} disabled`,
  );
  if (stats.patternHits.length > 0) {
    lines.push(`  Hits       ${stats.patternHits.map((h) => `${h.id} ×${h.count}`).join("  ")}`);
  }
  if (stats.unmatched.length > 0) {
    lines.push(`  Unmatched  ${stats.unmatchedEntries} signal${stats.unmatchedEntries === 1 ? "" : "s"} in ${stats.unmatched.length} hunk${stats.unmatched.length === 1 ? "" : "s"} — promotion candidates:`);
    for (const group of stats.unmatched.slice(0, 10)) {
      const p = group.lastCatchAll !== undefined ? `  p=${group.lastCatchAll.toFixed(2)}` : "";
      lines.push(`    ${group.path}  ${group.hunk}  lines ${group.lastLines[0]}-${group.lastLines[1]}${p}  ×${group.count}`);
      if (group.sample) lines.push(`      ${group.sample}`);
    }
    if (stats.unmatched.length > 10) lines.push(`    … ${stats.unmatched.length - 10} more`);
  } else if (stats.entries === 0) {
    lines.push("  Unmatched  none yet — run `pi-review screen` to accumulate signals");
  } else {
    lines.push("  Unmatched  none — every flagged hunk matched the catalog");
  }
  lines.push(`  Promote    ${meta.patternsFile} (or PI_REVIEW_SCREEN_PATTERNS)`);
  lines.push("─".repeat(39));
  return lines.join("\n");
}
