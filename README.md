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
- **Structured output** — machine-readable `PI_REVIEW_META` JSON footer for automation
- **Model-agnostic** — use any model available in your Pi installation
- **Session continuity** — keep sessions alive for follow-up questions with `--keep-session`
- **Customizable presets** — extend or override review modes via JSON configuration
- **Pi package integration** — `/pi-review` slash command and agent skill included

## Installation

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

The CLI appends a machine-readable footer:

```
PI_REVIEW_META: {"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed"}
```

## Session Management

```bash
# Keep a review session for follow-up
pi-review --mode challenge --keep-session -- @docs/design.md

# Continue a previous session
pi-review --mode challenge --continue <sessionHandle> -- "expand finding 2"
```

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

## Configuration

Override defaults via environment variables:

| Variable | Description |
|----------|-------------|
| `PI_BIN` | Pi executable path (default: `pi`) |
| `PI_REVIEW_HOME` | Directory containing `review-presets.json` and `system-prompt.md` |
| `PI_REVIEW_PRESETS` | Path to presets JSON file |
| `PI_REVIEW_SYSTEM_PROMPT` | Path to system prompt file |
| `PI_REVIEW_SESSION_DIR` | Directory for persisted review sessions |

## Pi Package Usage

After installing as a Pi package, use the `/pi-review` slash command:

```
/pi-review @src/foo.ts
/pi-review --mode challenge @docs/design.md
/pi-review models
```

The `/pi-review` command runs the CLI internally and inserts the review output into the current Pi conversation.

## Security

- Each review runs in an isolated child Pi session
- Default runs use `--no-session` — no child context is stored
- `--keep-session` stores only the child review session for explicit follow-up
- The review session is read-only: no file edits, patches, commits, or deployments

## Acknowledgments

The system prompt structure draws inspiration from [Codex-5.5-codex-instruct-5.5](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5) by li lingbo, licensed under the [MIT License](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5/blob/main/LICENSE).

## License

[MIT](LICENSE) © ZephyrDeng
