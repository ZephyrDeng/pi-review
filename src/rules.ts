// Adapted from @masonchow/pi-claude-rules (MIT, commit 38d341ebde12010722e69046c941b79cef2b4241).
//
// Pure Claude Code `.claude/rules` semantics shared by the review child
// extension. Nothing here touches the filesystem beyond reading rule files:
//
// - Discovery: user `~/.claude/rules/` + project `<dir>/.claude/rules/`, walking
//   up from cwd (skipping home itself). Recursive `.md`, symlinked dirs/files
//   followed, realpath cycle detection, realpath dedupe. User scope first;
//   project scopes outermost-first, innermost last (innermost wins). Same level
//   sorted lexicographically.
// - Rules without a `paths` frontmatter key are unconditional: they append to
//   the system prompt on every agent start, deduped by realpath against Pi's
//   built-in context files (AGENTS.md / CLAUDE.md).
// - Rules with `paths` inject into the `read` tool result only, once per
//   realpath per process and re-armed after `session_compact`. `write`/`edit`
//   never trigger.
// - Glob supports `**` `*` `?` `{a,b}` `[...]`; an invalid bracket expression
//   matches nothing (v2.1.207). Symlink and realpath paths both match
//   (v2.1.198).

import fs from "node:fs";
import path from "node:path";

export type RuleScope = "user" | "project";

/** A parsed rule file: `paths === null` means unconditional. */
export interface ParsedRule {
  content: string;
  /** null = no frontmatter or no `paths` key → unconditional rule. */
  paths: string[] | null;
}

export interface Rule {
  /** Path as discovered (symlinks kept for display). */
  file: string;
  /** realpath, used for dedupe. */
  realPath: string;
  scope: RuleScope;
  /** Base directory the `paths` globs are matched against (project root / cwd). */
  baseDir: string;
  content: string;
  rawPaths: string[] | null;
  /** null = unconditional; [] = `paths` present but every glob invalid → matches nothing. */
  patterns: RegExp[] | null;
}

/** Split on top-level commas, ignoring commas inside `{}` / `[]` (brace globs). */
export function splitTopLevelCommas(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\" && i + 1 < input.length) {
      cur += ch + input[i + 1];
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Expand `a.{ts,tsx}` → `["a.ts", "a.tsx"]`, nesting supported. */
export function expandBraces(pattern: string): string[] {
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") {
      start = i;
      break;
    }
  }
  if (start === -1) return [pattern];
  let depth = 0;
  let end = -1;
  for (let i = start; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [pattern]; // unclosed → treat literally
  const prefix = pattern.slice(0, start);
  const inner = pattern.slice(start + 1, end);
  const suffix = pattern.slice(end + 1);
  const alts = splitTopLevelCommas(inner);
  if (alts.length === 0) return [pattern];
  return alts.flatMap((alt) => expandBraces(prefix + alt + suffix));
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** One (brace-expanded) glob → regex source; an invalid bracket expression returns null. */
function compileSingle(pattern: string): string | null {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      out += escapeRegExp(pattern[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const prevOk = i === 0 || pattern[i - 1] === "/";
        const next = pattern[i + 2];
        if (prevOk && next === "/") {
          out += "(?:[^/]+/)*"; // '**/' matches zero or more directory levels
          i += 3;
          continue;
        }
        if (prevOk && next === undefined) {
          out += ".*"; // trailing '**' matches any depth
          i += 2;
          continue;
        }
        out += "[^/]*"; // '**' not on a segment boundary degrades to '*'
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      // Bracket expression: find the closing ] (leading ! negates, a leading ]
      // right after is a literal).
      let j = i + 1;
      let negate = false;
      if (pattern[j] === "!" || pattern[j] === "^") {
        negate = true;
        j++;
      }
      let body = "";
      if (pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\" && j + 1 < pattern.length) {
          body += "\\" + pattern[j + 1];
          j += 2;
          continue;
        }
        body += pattern[j] === "^" ? "\\^" : pattern[j];
        j++;
      }
      if (j >= pattern.length || body.length === 0) {
        return null; // unparseable bracket expression → whole pattern matches nothing
      }
      out += `[${negate ? "^" : ""}${body}]`;
      i = j + 1;
      continue;
    }
    out += escapeRegExp(ch);
    i++;
  }
  return out;
}

/** glob → RegExp; an invalid pattern returns null (callers treat it as "matches nothing"). */
export function compileGlob(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (p.startsWith("./")) p = p.slice(2);
  if (p.length === 0) return null;
  const sources: string[] = [];
  for (const expanded of expandBraces(p)) {
    const src = compileSingle(expanded);
    if (src === null) return null;
    sources.push(src);
  }
  try {
    return new RegExp(`^(?:${sources.join("|")})$`);
  } catch {
    return null;
  }
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse the YAML frontmatter `paths` key; the frontmatter is stripped from content. */
export function parseRuleFile(src: string): ParsedRule {
  if (!/^---[ \t]*\r?\n/.test(src)) return { content: src, paths: null };
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(src.slice(3));
  if (!closing) return { content: src, paths: null }; // unclosed → treat as no frontmatter
  const fmEnd = 3 + closing.index;
  const frontmatter = src.slice(3, fmEnd);
  const body = src.slice(fmEnd + closing[0].length).replace(/^\r?\n/, "");
  const lines = frontmatter.split(/\r?\n/);
  let paths: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^paths:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const value = m[1]!.trim();
    if (value.length > 0) {
      // Inline form: paths: "a, b" / paths: [a, b] / paths: a, b
      let v = stripQuotes(value);
      if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
      paths = splitTopLevelCommas(v).map(stripQuotes).filter((s) => s.length > 0);
    } else {
      // Block list form: paths: then "- item" lines
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+-\s+(.+)$/.exec(lines[j]!);
        if (!item) break;
        items.push(stripQuotes(item[1]!));
      }
      paths = items;
    }
    break;
  }
  return { content: body, paths };
}

/** Recursively find every `.md` under `dir` (symlinks followed, realpath cycle detection), lexicographic. */
export function findMarkdownFiles(dir: string, visitedDirs?: Set<string>): string[] {
  const visited = visitedDirs ?? new Set<string>();
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(realDir)) return [];
  visited.add(realDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full); // statSync follows symlinks
    } catch {
      continue; // dangling symlink etc.
    }
    if (stat.isDirectory()) {
      results.push(...findMarkdownFiles(full, visited));
    } else if (stat.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function collectDir(
  rulesDir: string,
  scope: RuleScope,
  baseDir: string,
  seenReal: Set<string>,
): Rule[] {
  const rules: Rule[] = [];
  for (const file of findMarkdownFiles(rulesDir)) {
    let realPath: string;
    try {
      realPath = fs.realpathSync(file);
    } catch {
      continue;
    }
    if (seenReal.has(realPath)) continue;
    seenReal.add(realPath);
    let src: string;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseRuleFile(src);
    rules.push({
      file,
      realPath,
      scope,
      baseDir,
      content: parsed.content,
      rawPaths: parsed.paths,
      patterns:
        parsed.paths === null
          ? null
          : parsed.paths.map(compileGlob).filter((r): r is RegExp => r !== null),
    });
  }
  return rules;
}

/** Discover all rules: user `~/.claude/rules/` first, project scopes (cwd upward, outermost first) after. */
export function discoverRules(cwd: string, home: string): Rule[] {
  const seenReal = new Set<string>();
  const rules: Rule[] = [];
  rules.push(...collectDir(path.join(home, ".claude", "rules"), "user", cwd, seenReal));
  const ancestors: string[] = [];
  let dir = path.resolve(cwd);
  while (true) {
    if (dir !== home) ancestors.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  ancestors.reverse(); // outermost project first, innermost (more specific) last, so it wins
  for (const d of ancestors) {
    rules.push(...collectDir(path.join(d, ".claude", "rules"), "project", d, seenReal));
  }
  return rules;
}

/** Whether a file path hits a rule's `paths` (original and realpath both matched, v2.1.198). */
export function ruleMatchesFile(rule: Rule, absFile: string): boolean {
  if (rule.patterns === null || rule.patterns.length === 0) return false;
  const candidates = new Set<string>();
  const rel = path.relative(rule.baseDir, absFile);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) candidates.add(rel.split(path.sep).join("/"));
  try {
    const realFile = fs.realpathSync(absFile);
    const realBase = fs.realpathSync(rule.baseDir);
    const relReal = path.relative(realBase, realFile);
    if (!relReal.startsWith("..") && !path.isAbsolute(relReal)) {
      candidates.add(relReal.split(path.sep).join("/"));
    }
  } catch {
    // No realpath for file or base → match on the original path only.
  }
  for (const candidate of candidates) {
    for (const re of rule.patterns) {
      if (re.test(candidate)) return true;
    }
  }
  return false;
}

const SCOPE_LABEL: Record<RuleScope, string> = {
  user: "(user's private global instructions for all projects)",
  project: "(project instructions, checked into the codebase)",
};

/** Unconditional rules appended to the system prompt, using the reference scope labels. */
export function renderUnconditionalBlock(rules: Rule[]): string {
  const sections = rules.map(
    (r) => `Contents of ${r.file} ${SCOPE_LABEL[r.scope]}:\n\n${r.content.trim()}`,
  );
  return `\n\n# Rules\n\nThe following rules from .claude/rules directories apply to this session. Adhere to them.\n\n${sections.join("\n\n")}`;
}

/** The `<system-reminder>` block appended to a matching `read` tool result. */
export function renderMatchedReminder(rules: Rule[]): string {
  const reminder = rules
    .map(
      (r) =>
        `Contents of ${r.file} ${SCOPE_LABEL[r.scope]} — applies to the file you just read:\n\n${r.content.trim()}`,
    )
    .join("\n\n");
  return `\n<system-reminder>\n${reminder}\n</system-reminder>`;
}
