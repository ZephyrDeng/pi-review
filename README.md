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
- **Structured output** — explicit `status`, structured findings, and a human-readable ASCII footer; one-line `PI_REVIEW_META_JSON` on stderr for automation
- **Loop review gate** — bounded, isolated review rounds with `pi-review loop --max-rounds <n>`; the host remains the only editor
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

### One-shot (Pi + other agents)

```bash
npx @zephyrdeng/pi-review install
```

Runs `pi install npm:@zephyrdeng/pi-review` when the Pi CLI is on PATH, then installs the agent skill for Claude Code, Codex, and Cursor (via the [skills CLI](https://www.npmjs.com/package/skills), non-interactive `-y`). Forward extra flags to the skill step, e.g. `npx @zephyrdeng/pi-review install --agent claude-code codex -y` or `npx @zephyrdeng/pi-review install --agents-only --all`.

Use `--pi-only` or `--agents-only` to run one side. For Pi-only use, **do not** also run `install-skill` — the npm Pi package already exposes the skill via `pi.skills`.

### Pi package only

```bash
pi install npm:@zephyrdeng/pi-review
```

### Agent skill only (Claude Code, Codex, Cursor, ...)

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

# Bounded review-only gate (default: 3 rounds)
pi-review loop --max-rounds 3 -- @src

# List available models
pi-review models
```

## Review Modes

| Mode | Description |
|------|-------------|
| `code` (default) | Code, diff, MR, file, and repository review. Focuses on correctness, regressions, security, concurrency, API contracts, edge cases, and missing tests. |
| `plan` | Broad plan/architecture review through multiple expert lenses: engineering, product, security, QA, operations, and DX. |
| `challenge` | Adversarial review that pressure-tests assumptions, dependencies, reversibility, failure modes, and migration paths. |

## Loop Review

`pi-review loop` runs a bounded sequence of full, isolated review runs against the current working tree:

```bash
pi-review loop --max-rounds 3 -- @src
pi-review loop --mode challenge --max-rounds 2 -- @docs/design.md
```

Each round is review-only. The process never edits, patches, waits for filesystem changes, or asks the child session to fix findings. It stops immediately on `clean`, `needs_human`, or `blocked`; otherwise it stops when the round budget is exhausted. Every round emits one `PI_REVIEW_META_JSON` line in order, and the final human summary lists each round's status, verdict, duration, and finding counts.

This is a **host-driven gate**: if findings remain, the host or human fixes only accepted in-scope findings and invokes `loop` again. For patch-by-patch agent closeout, `--max-rounds 1` gives the host a fix point after each review; use a larger budget only when repeated review of the unchanged tree is intentional. `loop` accepts normal review target/model/progress options but rejects `--keep-session`, `--continue`, and `--name` in v1.

## Output Format

Every review produces Markdown with these sections:

```
## Verdict
approve | request_changes | needs_clarification | blocked

## Summary
## Findings
### F1: <summary>
- Severity: critical | high | medium | low
- Path: <path or none>
- Actionable: yes | no
- Evidence: <concrete evidence>
- Impact: <why it matters>
- Recommendation: <specific next step>

## Risks and Blind Spots
## Open Questions
```

The CLI appends a readable ASCII footer on **stdout**:

```
── pi-review ────────────────────────────
  Verdict     ! REQUEST CHANGES
  Status      HAS FINDINGS
  Mode        code
  Findings    1 actionable / 1 total
  Duration    42.3s
──────────────────────────────────────────
```

For scripts, parse **`PI_REVIEW_META_JSON:`** from **stderr**. Existing keys remain, with additive fields:

```json
{"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed","status":"has_findings","findings":[{"id":"F1","severity":"high","path":"src/cli.ts","summary":"Dirty reviews exit zero","actionable":true}],"actionableCount":1,"durationMs":42300,"model":"provider/model"}
```

`status` is one of `clean`, `has_findings`, `needs_human`, or `blocked`: `approve` with no actionable findings is `clean`; `request_changes` or actionable findings are `has_findings`; `needs_clarification` is `needs_human`; runtime/fatal failures are `blocked`. Each finding always has `summary` and `actionable`; `id`, `severity`, and `path` are present when parsed. The line remains a single additive JSON record, so older consumers can ignore unknown keys. Set `PI_REVIEW_META_STDOUT=1` to emit it on stdout instead.

The parser prefers the exact `### F1` shape above but also accepts legacy `###` headings and top-level finding lists. When `Actionable` is missing, findings under `request_changes` default to actionable and other verdicts default to non-actionable. A missing/unrecognized verdict falls back to `needs_clarification` / `needs_human` and includes `parseError`; runtime failures always remain `blocked`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Final status is `clean` |
| `1` | Final status is `has_findings` / loop budget exhausted |
| `2` | CLI usage or argument error |
| `3` | `needs_human` — clarification or a decision is required |
| `4` | `blocked` — child/runtime failure or review cannot proceed |

## Session Management

```bash
# Keep a review session for follow-up
pi-review --mode challenge --keep-session -- @docs/design.md

# Continue a previous session (same optional flags as an initial run)
pi-review --continue <sessionHandle> --mode challenge --model provider/model -- "expand finding 2"
```

## Live Progress in AI Hosts

Agent hosts like Claude Code, Cursor, and Codex typically buffer a Bash tool's stdout until the command exits, so a multi-minute review can look like a silent wait followed by one large dump — even though `pi-review` streams by default. `--progress-log <path>` sidesteps this: it runs the child in `--mode json` and writes its event log to a file in real time, independent of what the calling tool does with stdout.

The bundled **pi-review** agent skill tells parent agents to use `--progress-log` by default on those hosts (Pi `/rv` stays on default streaming). Details: [`skills/pi-review/SKILL.md`](skills/pi-review/SKILL.md) and [`skills/pi-review/references/codex-tools.md`](skills/pi-review/references/codex-tools.md).

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
pi-review [review] [options] -- <@files|text...>
pi-review loop [options] -- <@files|text...>
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
| `--max-rounds <n>` | Positive loop review budget (default: `3`; `loop` only) |

Session flags (`--keep-session`, `--continue`, `--name`) are intentionally unsupported by `loop` in v1; invalid combinations print usage and exit `2`.

## Configuration

Override defaults via environment variables:

| Variable | Description |
|----------|-------------|
| `PI_BIN` | Pi executable path (default: `pi`) |
| `PI_REVIEW_HOME` | Directory containing `review-presets.json` and `system-prompt.md` |
| `PI_REVIEW_PRESETS` | Path to presets JSON file |
| `PI_REVIEW_SYSTEM_PROMPT` | Path to system prompt file |
| `PI_REVIEW_SESSION_DIR` | Directory for persisted review sessions |
| `PI_REVIEW_META_STDOUT` | Set to `1`/`true` to print `PI_REVIEW_META_JSON` on stdout instead of stderr |

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

Argument completions are context-aware. After the host session starts, `/rv` reads the live model registry and offers:

- **Model list** after `--model `: candidates come from the live Pi registry; order follows **`resources/rv-model-priorities.json`** (override with `PI_REVIEW_RV_PRIORITIES`). Presets match registry ids by substring and prefer newer version strings (e.g. kimi `2.7`, `claude-opus-4-8`). Profiles: **code** (e.g. gpt-5.5 `:xhigh`, glm-5.2 `:high`), **frontend** (vue/css/… → kimi, claude-sonnet, minimax-m3), **plan/challenge** (claude-opus-4-8, deepseek-v4-pro, …).
- **Thinking suffix** after `provider/model:` — only levels the chosen model actually supports.
- **Semantic phrases** (e.g. `code review` / 代码审核, `查看模型列表`) in addition to flags; orchestration prompts follow **session locale** (zh/en) for summaries.
- **Scene templates** at the top level (code / frontend / plan presets).

**Claude Code / Codex:** the bundled skill includes **[skills/pi-review/references/model-selection.md](skills/pi-review/references/model-selection.md)** — same presets as `/rv` for choosing `--model` after `pi-review models`.

Completions are a hint layer only; execution remains skill-driven. When the model registry is unavailable (e.g. non-TUI mode), `/rv` falls back to the static hint list.

## Security

- Each review and every loop round runs in an isolated child Pi session
- Default runs use `--no-session` — no child context is stored
- `--keep-session` stores only the child review session for explicit follow-up
- The review session is read-only: no file edits, patches, commits, or deployments

## Acknowledgments

The system prompt structure draws inspiration from [Codex-5.5-codex-instruct-5.5](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5) by li lingbo, licensed under the [MIT License](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5/blob/main/LICENSE).

## License

[MIT](LICENSE) © ZephyrDeng
