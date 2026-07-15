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
pi-review loop --until clean --max-rounds 10 -- @src
pi-review loop --mode challenge --max-rounds 2 -- @docs/design.md
```

Each round is review-only. The process never edits, patches, waits for filesystem changes, or asks the child session to fix findings. It stops immediately on `clean`, `needs_human`, or `blocked`; otherwise it stops when the round budget is exhausted. Every round emits one `PI_REVIEW_META_JSON` line in order, and the final human summary lists each round's status, verdict, duration, and finding counts.

This is a **host-driven gate**: if findings remain, the host or human fixes only accepted in-scope findings and invokes `loop` again. For patch-by-patch agent closeout, `--max-rounds 1` gives the host a fix point after each review. For an explicit clean goal with a hard ceiling, use `--until clean` (default budget 10 when `--max-rounds` is omitted; never unlimited). Clean means no gate-blocking findings (single: no actionable findings; panel: no confirmed actionable clusters; advisories may remain). `loop` accepts normal review target/model/progress options but rejects `--keep-session`, `--continue`, and `--name` in v1.

## Panel Review

Panel review runs multiple **independent** reviewers in isolated child sessions and aggregates their findings into one gate result. Reviewers cannot see one another's findings, so agreement represents independent discovery.

```bash
# Single panel review
pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
# Expert preset (correctness, security, testing lenses)
pi-review --panel code-experts --consensus majority -- @src
# Panel loop review (up to reviewer_count × max-rounds reviewer runs + adjudication)
pi-review loop --reviewers 3 --consensus quorum --max-rounds 2 -- @src
```

### Consensus

A finding becomes a **confirmed finding** (gate-relevant) only when enough independent reviewers mark the issue **actionable**. Otherwise it stays a non-blocking **advisory**. Multi-reviewer panels default to **quorum** with minimum agreement **2** so panel mode never silently becomes any-finding fail-closed; single-review stays threshold one.

| Policy | Threshold |
|--------|----------|
| `any` | one actionable reviewer confirms |
| `quorum` (default) | configured minimum agreement (default 2; `--min-agree`) |
| `majority` | `floor(reviewers / 2) + 1` |
| `unanimous` | every reviewer |

Singleton (uncorroborated) findings remain visible as **advisories** but do not change clean status or fail the gate. Confirmed actionable clusters produce `has_findings`; no confirmed clusters produce `clean`.

### Aggregation

Two-phase matching: deterministic matching on stable anchors (path + normalized summary) first; only ambiguous same-path candidates go to a constrained **semantic adjudicator** (enabled with `--consensus-model`). The adjudicator clusters findings and may not invent findings, drop findings, add evidence, or act as another reviewer — it has no write tools. Low-confidence matches stay separate advisories so uncertain similarity cannot manufacture quorum.

### Cost and failure

Reviewer runs = `--reviewers <n>` × `--max-rounds` (loop); one adjudication call may run per round when `--consensus-model` is set. Use `--concurrency <n>` to bound provider/machine pressure (default: reviewer count, never exceeds it). Reviewer runtime failure → `blocked`; unstructured dirty output or unresolved clarification → `needs_human`; never silently clean. Panel review rejects `--keep-session`, `--continue`, and `--name` (reviewers run `--no-session`); the host agent remains the only editor.

### Machine output

A panel evaluation emits **one** aggregate `PI_REVIEW_META_JSON` record with additive fields: `strategy: "panel"`, `configuredReviewers`, `successfulReviewers`, `consensusPolicy`, `consensusThreshold`, `panelHealth`, `confirmedClusters`, `advisories`, and per-`reviewers` outcomes. Top-level `findings` contain confirmed clusters only; advisories remain separate. Existing single-review keys remain unchanged, so older consumers can ignore the new fields.

### Live Pi progress and event replay

In Pi, slash commands select strategy only:

- `/rv <natural-language target>` → panel review via native `pi_review`
- `/rv-loop <natural-language target>` → loop closeout via shell CLI
- `/rv-models` → model catalog

Targets stay natural language as given. Path mentions like `@src` remain text; the CLI keeps directories as tool path targets and only attaches real files. Remaining strategy matching lives in the skill/CLI. In Pi, the user-facing tool name is **Pi Review Panel** (the API identifier remains `pi_review`); each reviewer renders as an independent live row with explicit `queued/running/completed/failed/cancelled` state, active tool, elapsed time, and token usage. Expand the tool result with `Ctrl+O` for bounded activity, final findings/provenance, duration, token totals, and cost.

Renderer adapters can consume the stable, versioned event stream directly:

```bash
pi-review --panel code-experts --output-format events-jsonl -- @src
```

This mode writes only `ReviewEvent v1` JSONL to stdout. Events have one `runId`, monotonically increasing `seq`, bounded/redacted activity text, and end in exactly one `panel.completed` event containing the same `PanelReviewMeta` as the default CLI path. The reducer is exported as `createPanelViewState()` and `reducePanelEvent()` for deterministic live delivery and replay.

Panel reviewers use the hard allowlist `read,grep,find,ls`. Shell and mutation-capable tools are rejected before a reviewer starts. `Ctrl+C` cancels the reviewer and adjudicator process trees, emits cancellation lifecycle events, and produces one blocked final event.

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
  Model       provider/model
  Thinking    xhigh
  Tokens      in 17.6K · out 512 · cache 2.0K · reason 0 · total 18.2K
  Cost        $0.05
  Duration    42.3s
──────────────────────────────────────────
```

`Thinking` shows the requested thinking level when set; `Tokens` shows the child session's token usage (`in`/`out`/`cache`/`reason` plus total) parsed from the `--mode json` event stream. `Cost` shows the provider-reported total, or `n/a` when the provider does not report one. Both are collected during normal streaming; `--progress-log` is not required.

For scripts, parse **`PI_REVIEW_META_JSON:`** from **stderr**. Existing keys remain, with additive fields:

```json
{"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed","status":"has_findings","findings":[{"id":"F1","severity":"high","path":"src/cli.ts","summary":"Dirty reviews exit zero","actionable":true}],"actionableCount":1,"durationMs":42300,"model":"provider/model","thinking":"xhigh","usage":{"input":18031,"output":512,"cacheRead":2048,"cacheWrite":0,"reasoning":0,"totalTokens":18591,"costTotal":0.05}}
```

`status` is one of `clean`, `has_findings`, `needs_human`, or `blocked`: `approve` with no actionable findings is `clean`; `request_changes` or actionable findings are `has_findings`; `needs_clarification` is `needs_human`; runtime/fatal failures are `blocked`. Each finding always has `summary` and `actionable`; `id`, `severity`, and `path` are present when parsed. `thinking` and `usage` are additive and present when reported by the child; `usage` includes token totals and may include `costTotal`. The line remains a single additive JSON record, so older consumers can ignore unknown keys. Set `PI_REVIEW_META_STDOUT=1` to emit it on stdout instead.

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

## Live Progress and Token Usage

`pi-review` always runs the child in `--mode json` internally. In streaming mode it forwards **readable text deltas** to stdout live and writes **semantic milestone notices** to stderr — `pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`. Token usage (`input`/`output`/`cache`/`reasoning`) is accumulated by default and shown in the ASCII footer and `PI_REVIEW_META_JSON` — **no `--progress-log` required**.

Agent hosts like Claude Code, Cursor, and Codex typically buffer a Bash tool's stdout until the command exits. The stderr milestone notices give you progress signals without tailing a file. The final Markdown review + ASCII footer arrive on stdout when the process exits.

`--progress-log <path>` is now an **optional** convenience for fine-grained debugging: it tees the raw `--mode json` event stream to a file. It no longer gates token visibility. Details: [`skills/pi-review/SKILL.md`](skills/pi-review/SKILL.md) and [`skills/pi-review/references/codex-tools.md`](skills/pi-review/references/codex-tools.md).

```bash
# Optional: capture the full event log for debugging
pi-review --progress-log /tmp/pi-review.jsonl -- @src/foo.ts &
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
| `--max-rounds <n>` | Positive loop hard budget (default: `3`; with `--until clean` default: `10`; `loop` only) |
| `--until clean` | Loop goal: keep going until the clean gate (still hard-capped by `--max-rounds`; never unlimited) |
| `--reviewers <n>` | Panel: number of independent reviewers (2-8; activates panel mode) |
| `--panel <name>` | Panel: named expert-panel preset (cannot combine with `--reviewers`) |
| `--consensus <policy>` | Panel: `any \| quorum \| majority \| unanimous` (default: `quorum`) |
| `--min-agree <n>` | Panel: minimum reviewers for quorum (default: `2`; quorum only) |
| `--consensus-model <model>` | Panel: model for semantic consensus adjudication |
| `--concurrency <n>` | Panel: bounded reviewer concurrency (default: reviewer count) |
| `--output-format events-jsonl` | Panel: normalized `ReviewEvent v1` JSONL for renderer adapters |

Session flags (`--keep-session`, `--continue`, `--name`) are unsupported by `loop` and panel in v1; invalid combinations print usage and exit `2`.

## Configuration

Override defaults via environment variables:

| Variable | Description |
|----------|-------------|
| `PI_BIN` | Pi executable path (default: `pi`) |
| `PI_REVIEW_HOME` | Directory containing `review-presets.json` and `system-prompt.md` |
| `PI_REVIEW_PRESETS` | Path to presets JSON file |
| `PI_REVIEW_PANEL_PRESETS` | Path to panel presets JSON file |
| `PI_REVIEW_SYSTEM_PROMPT` | Path to system prompt file |
| `PI_REVIEW_SESSION_DIR` | Directory for persisted review sessions |
| `PI_REVIEW_META_STDOUT` | Set to `1`/`true` to print `PI_REVIEW_META_JSON` on stdout instead of stderr |

## Pi Package Usage

After installing as a Pi package, use the `/rv` slash command:

```
/rv @src/foo.ts
/rv --mode challenge @docs/design.md
```

Slash commands inject a task message for the parent agent. Strategy is selected by the command (`/rv`, `/rv-loop`, `/rv-models`); the remainder is the natural-language target. Use plain `/rv @src`, `/rv review the auth changes`, or `/rv-loop fix until clean @src` in Pi — no extra streaming flags needed for panel runs. `--continue`, `--keep-session`, loop, and explicit `--no-stream` retain the shell CLI path.

```
/rv models
/rv @src/foo.ts
/rv --mode plan @docs/architecture.md
/rv --mode challenge --keep-session @docs/design.md
```

Argument completions are context-aware. After the host session starts, `/rv` reads the live model registry and offers:

- **Model list** after `--model `: candidates come from the live Pi registry; order follows **`resources/rv-model-priorities.json`** (override with `PI_REVIEW_RV_PRIORITIES`). Presets match registry ids by substring and prefer newer version strings (e.g. kimi `2.7`, `claude-opus-4-8`). Profiles: **code / fast** (claude-sonnet-5, deepseek-v4-flash, glm-5.2, minimax-m3, grok-4.5, gpt-5.6-terra/luna), **frontend / vision** (claude → gpt → kimi-2.7 → minimax-m3), **plan / complex** (gpt-5.6-sol max, claude-opus-4.8 xhigh, claude-fable-5 max cautious, glm-5.2 / deepseek-v4-pro / grok-4.5 max).
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
