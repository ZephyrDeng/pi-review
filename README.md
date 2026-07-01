# pi-review

[![npm version](https://img.shields.io/npm/v/@zephyrdeng/pi-review.svg)](https://www.npmjs.com/package/@zephyrdeng/pi-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)

**Isolated AI-powered code and plan reviews from the command line.**

`pi-review` delegates review work to a fresh, isolated [Pi](https://github.com/anthropics/pi) session and returns a structured review conclusion. The child session is review-only — it reads code, analyzes it, and reports findings without making any changes.

Works as a standalone CLI, a Pi package (extension + skill), or integrated into CI pipelines and editor workflows.

## Prerequisites

- [Pi CLI](https://pi.dev) installed and configured with at least one model provider

## Features

- **Isolated review sessions** — each review runs in a clean child process with no shared state
- **Multiple review modes** — code review, multi-lens plan review, adversarial challenge review
- **Structured output** — human-readable ASCII footer on stdout; `PI_REVIEW_META_JSON` on stderr for automation
- **Model-agnostic** — use any model available in your Pi installation
- **Live streaming** — child review output is forwarded as it arrives (use `--no-stream` to buffer)
- **Progress logging for AI hosts** — `--progress-log <path>` writes a live JSON event log so agent hosts that buffer tool stdout (Claude Code, Codex, ...) can still show real-time progress
- **Session continuity** — keep sessions alive for follow-up questions with `--keep-session`
- **Customizable presets** — extend or override review modes via JSON configuration
- **Pi package integration** — `/rv` slash command and agent skill included

## Language policy

- **Source code** (CLI, extensions, presets, prompts, TUI strings emitted from code): **English only**.
- **Documentation** may be bilingual. See [README.zh-CN.md](./README.zh-CN.md) for 中文说明.
- **Git commits**: [Husky](https://typicode.github.io/husky/) runs `ai-commit` on `prepare-commit-msg` / `commit-msg` / `pre-commit` (see [`.husky/`](./.husky/)). Config: [`.ai-commit.yaml`](./.ai-commit.yaml) (English, `ai_footer: off`, **ai-commit v0.1.45+** on PATH). Or run `ai-commit commit` / `ai-commit generate` directly after `git add`.

## Installation

Dev dependencies use the [public npm registry](https://registry.npmjs.org/) (see [`.npmrc`](./.npmrc)); run `npm install` in the repo root for Husky hooks.

### CLI (recommended)

```bash
npm install -g @zephyrdeng/pi-review
```

### Pi package

```bash
pi install npm:@zephyrdeng/pi-review
```

### Agent skill (Claude Code, Codex, Cursor, Cline, Windsurf, ...)

Install the pi-review skill to your AI agents:

```bash
npx @zephyrdeng/pi-review install-skill
```

This uses the [skills CLI](https://www.npmjs.com/package/skills) when available — it will prompt you to choose which agents to install to. Falls back to Claude Code direct install if `skills` is not found.

You can also specify agents directly:

```bash
pi-review install-skill --agent claude-code codex cursor
```

To remove:

```bash
pi-review uninstall-skill
```

### From source

```bash
git clone https://github.com/ZephyrDeng/pi-review.git
cd pi-review
npm install && npm run build
npm link
```

## Quick Start

```bash
# Review a file
pi-review -- @src/foo.ts

# Review with a specific model
pi-review --model openai/gpt-5.5 -- @src/foo.ts

# Multi-lens plan review
pi-review --mode plan -- @docs/architecture.md

# Adversarial challenge review
pi-review --mode challenge -- @docs/design.md

# List available models
pi-review models
```

## Review Modes

| Mode | Description |
|------|-------------|
| `code` (default) | Code, diff, MR, file, and repository review. Focuses on correctness, regressions, security, concurrency, API contracts, edge cases, and missing tests. |
| `plan` | Broad plan/architecture review through multiple expert lenses: engineering, product, security, QA, operations, and DX. |
| `challenge` | Adversarial review that pressure-tests assumptions, dependencies, reversibility, failure modes, and migration paths. |

## Output Format

Every review produces Markdown with these sections:

```
## Verdict
approve | request_changes | needs_clarification | blocked

## Summary
## Findings
## Risks and Blind Spots
## Open Questions
```

The CLI appends a readable ASCII footer on **stdout**:

```
── pi-review ────────────────────────────
  Verdict     ! REQUEST CHANGES
  Mode        code
  Duration    42.3s
──────────────────────────────────────────
```

For scripts, parse **`PI_REVIEW_META_JSON:`** from **stderr** (same fields as before). Set `PI_REVIEW_META_STDOUT=1` to also emit that JSON line on stdout.

## Session Management

```bash
# Keep a review session for follow-up
pi-review --mode challenge --keep-session -- @docs/design.md

# Continue a previous session (same optional flags as an initial run)
pi-review --continue <sessionHandle> --mode challenge --model provider/model -- "expand finding 2"
```

## Live Progress in AI Hosts

Agent hosts like Claude Code, Cursor, and Codex typically buffer a Bash tool's stdout until the command exits, so a multi-minute review can look like a silent wait followed by one large dump — even though `pi-review` streams by default. `--progress-log <path>` sidesteps this: it runs the child in `--mode json` and writes its event log to a file in real time, independent of what the calling tool does with stdout.

```bash
# Start the review in the background, writing structured progress events to a file
pi-review --progress-log /tmp/pi-review.jsonl -- @src/foo.ts &

# Tail it from another process/tool (e.g. Claude Code's Monitor tool) for live updates.
# `message_update` and `tool_execution_update` carry high-frequency token-level deltas —
# excluding them keeps the feed to milestone events (tool start/end, turn end, agent end).
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```

The JSON event schema is pi CLI's own internal format, not a contract `pi-review` guarantees — it may change between pi versions. `pi-review` parses it defensively (unparseable lines are skipped, missing events degrade to a diagnostic `parseError`) and still prints the same clean Markdown + ASCII footer to stdout once the child exits.

## CLI Reference

```
pi-review [options] -- <@files|text...>
pi-review models [search]
```

| Option | Description |
|--------|-------------|
| `--mode <name>` | Review mode (default: `code`) |
| `--model <provider/model[:thinking]>` | Model to use for the review |
| `--provider <name>` | Model provider |
| `--thinking <level>` | Thinking level: `off\|minimal\|low\|medium\|high\|xhigh` |
| `--skill <path>` | Load an extra Pi skill (repeatable) |
| `--tools <csv>` | Override allowed tools |
| `--keep-session` | Persist session for follow-up |
| `--continue <handle>` | Continue an existing session |
| `--name <name>` | Session name (with `--keep-session`) |
| `--no-stream` | Buffer child output until exit (default: stream live) |
| `--progress-log <path>` | Stream child `--mode json` events to this file (cannot combine with `--no-stream`) |

## Configuration

Override defaults via environment variables:

| Variable | Description |
|----------|-------------|
| `PI_BIN` | Pi executable path (default: `pi`) |
| `PI_REVIEW_HOME` | Directory containing `review-presets.json` and `system-prompt.md` |
| `PI_REVIEW_PRESETS` | Path to presets JSON file |
| `PI_REVIEW_SYSTEM_PROMPT` | Path to system prompt file |
| `PI_REVIEW_SESSION_DIR` | Directory for persisted review sessions |
| `PI_REVIEW_META_STDOUT` | Set to `1`/`true` to also print `PI_REVIEW_META_JSON` on stdout (default: stderr only) |

## Pi Package Usage

After installing as a Pi package, use the `/rv` slash command:

```
/rv @src/foo.ts
/rv --mode challenge @docs/design.md
```

The `/rv` command injects a task message for the parent agent (Pi host rules: default streaming, no automatic `--no-stream` or `--progress-log` + the `pi-review` CLI to run). The agent follows the **pi-review** skill and runs an isolated child session. Use plain `/rv @path` in Pi — no extra streaming flags needed.

```
/rv models
/rv @src/foo.ts
/rv --mode plan @docs/architecture.md
/rv --mode challenge --keep-session @docs/design.md
```

Argument completions (`--mode`, `@`, `models`, etc.) are hints only; execution is skill-driven.

## Security

- Each review runs in an isolated child Pi session
- Default runs use `--no-session` — no child context is stored
- `--keep-session` stores only the child review session for explicit follow-up
- The review session is read-only: no file edits, patches, commits, or deployments

## Acknowledgments

The system prompt structure draws inspiration from [Codex-5.5-codex-instruct-5.5](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5) by li lingbo, licensed under the [MIT License](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5/blob/main/LICENSE).

## License

[MIT](LICENSE) © ZephyrDeng
