# CLI Reference

```
pi-review [review] [options] -- <@files|text...>
pi-review loop [options] -- <@files|text...>
pi-review screen <@files|paths...>
pi-review classify --baseline <text|@file> [--meta <path>]
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
| `--progress-log <path>` | Stream compact child `--mode json` events to this file (cannot combine with `--no-stream`) |
| `--progress-log-raw` | With `--progress-log`: tee the verbatim event stream (full message snapshots; much larger files) |
| `--max-rounds <n>` | Positive loop hard budget (default: `3`; with `--until clean` default: `10`; `loop` only) |
| `--until clean` | Loop goal: keep going until the clean gate (still hard-capped by `--max-rounds`; never unlimited) |
| `--reviewers <n>` | Panel: number of independent reviewers (2-8; activates panel mode) |
| `--panel <name>` | Panel: named expert-panel preset (cannot combine with `--reviewers`) |
| `--consensus <policy>` | Panel: `any \| quorum \| majority \| unanimous` (default: `quorum`) |
| `--min-agree <n>` | Panel: minimum reviewers for quorum (default: `2`; quorum only) |
| `--reviewer-model <id=model[:thinking]>` | Panel: per-reviewer model override (repeatable, e.g. `r1=openai/gpt-5.6:high`) |
| `--consensus-model <model>` | Panel: model for semantic consensus adjudication |
| `--concurrency <n>` | Panel: bounded reviewer concurrency (default: reviewer count) |
| `--output-format events-jsonl` | Panel: normalized `ReviewEvent v1` JSONL for renderer adapters |

### When to use each command & argument

- **`pi-review screen <paths>`** — Sub-second (~1.0–1.2s) gate screening without running an LLM generation loop. Use in CI/CD fast paths, pre-commit/pre-push hooks, or instant sanity checks to catch known defect patterns immediately.
- **`pi-review review [options] -- <target>`** — Single-reviewer code review. Use for routine local development and self-review where one model's prose recommendations are sufficient.
- **`pi-review --reviewers <n>` (2–8)** — Multi-reviewer panel review. Use for PR merge gates, security-sensitive changes, or cross-model verification where independent agreement matters.
- **`pi-review loop [--until clean]`** — Multi-round review loop. Use during automated agentic fix-verify loops to iteratively patch code and re-review until clean.
- **`--reviewer-model <id=model[:thinking]>`** — In panel mode, assigns specific models or thinking efforts to individual reviewers (e.g. `r1=openai/gpt-5:high`, `r2=zenmux/deepseek/deepseek-v4.1-flash:low`). Essential for cross-family heterogeneous panels.
- **`--concurrency <n>`** — Bounds parallel reviewer execution. Omit for full speed (all reviewers run concurrently by default). Only pass `<n>` if the provider account has strict concurrent request limits.
- **`--consensus-model <model>`** — Explicitly forces an LLM child session to act as the adjudicator instead of Jev System One. Use when you explicitly want full-text LLM reasoning on finding clusters.
- **`--consensus <policy>` / `--min-agree <n>`** — Fine-tunes panel quorum. Defaults to `quorum` with `min-agree: 2`. Use `unanimous` for zero-tolerance security releases, or `any` for broad bug hunts.
- **`--progress-log <path>`** — Streams compact JSON events to a file; essential for background runs in buffered-output hosts like Claude Code, Codex, or Cursor.
- **`--ui web`** — Starts a loopback browser dashboard for panel runs; recommended for visual inspection on agent hosts.

Session flags (`--keep-session`, `--continue`, `--name`) are unsupported by `loop` and panel in v1; invalid combinations print usage and exit `2`.


## Review Modes

| Mode | Description |
|------|-------------|
| `code` (default) | Code, diff, MR, file, and repository review. Focuses on correctness, regressions, security, concurrency, API contracts, edge cases, and missing tests. |
| `plan` | Broad plan/architecture review through multiple expert lenses: engineering, product, security, QA, operations, and DX. |
| `challenge` | Adversarial review that pressure-tests assumptions, dependencies, reversibility, failure modes, and migration paths. |


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

From an agent host (Claude Code, Codex, Cursor, or **agy / Antigravity**), install the skill once, then ask the host to run a review — e.g. `/pi-review -- @src/foo.ts` or natural language that triggers the skill:

```bash
npx @zephyrdeng/pi-review install-skill --agent agy
```

