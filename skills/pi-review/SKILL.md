---
name: pi-review
description: Use pi-review to delegate isolated code, diff, repository, architecture, or plan reviews to a fresh Pi session and return only the review conclusion. Use when the user asks for Pi review, isolated review, code review, plan review, challenge review, review status/progress, or wants to avoid context pollution.
---

# Pi Review

Use `pi-review` to run a fresh Pi review session and return only the review conclusion.

## CLI Resolution

Prefer the shell command when it exists:

```bash
pi-review --help
```

If `pi-review` is not on PATH but this skill came from the Pi package, use the package-local CLI relative to this skill directory:

```bash
node ../../bin/pi-review.js --help
```

When resolving this fallback, use the actual directory that contains this `SKILL.md`.

## Pi host (`/rv`)

- In **Pi interactive** sessions, run `pi-review` with **default streaming only** — do **not** add `--no-stream` or `--progress-log` unless the user explicitly asks.
- The `/rv` extension injects these rules into the parent agent; ordinary `/rv @path` needs no extra flags.

## Streaming vs agent hosts

- `pi-review` **streams** child `pi` stdout/stderr to the process terminal by default (`--no-stream` buffers until exit).
- **Pi** with `/rv` or a foreground bash that inherits stdio: users often see output arrive live.
- **Claude Code, Cursor, Codex**, and similar hosts usually **buffer tool stdout** until the bash command exits, so the chat may show the review **all at once** even though the CLI is streaming. That is expected—not a misconfiguration. Also note: pi-review's default `text` mode produces **no output at all** during the tool-use/thinking phase (only the final answer), so even a local terminal looks silent for most of a multi-minute review.
- For **live** progress in those hosts, prefer `--progress-log <path>`: it runs the child in `--mode json` and writes a structured, incremental event log to that file, independent of host stdout buffering. Run `pi-review --progress-log <path> ...` with a background/async tool call, then tail the file (e.g. with a Monitor-style tool) filtering out `message_update`/`tool_execution_update` (high-frequency token deltas) to surface milestone events. Fall back to a **local terminal** running the same command only if the host has no way to run a background command or tail a file.

## Review status (no slash command)

There is **no** `/status` slash in this skill. When the user asks for **review status**, **progress**, **is pi-review still running**, or **/status** in the sense of review progress, run read-only checks and summarize—do **not** start a new review.

1. **In-flight review (heuristic)** — list likely `pi-review` / child `pi -p` processes:
   ```bash
   pgrep -fl 'pi-review' 2>/dev/null || true
   pgrep -fl 'pi.*-p' 2>/dev/null | head -20 || true
   ```
   If matches exist, say a review **may still be running** (heuristic; other `pi -p` jobs can match). If none, say **no obvious in-flight pi-review** from process list—not that the last review failed.

2. **Persisted sessions** (only after `--keep-session` / `--continue`) — default dir `~/.pi/pi-review/sessions`, overridable with `PI_REVIEW_SESSION_DIR`:
   ```bash
   ls -lt "${PI_REVIEW_SESSION_DIR:-$HOME/.pi/pi-review/sessions}" 2>/dev/null | head -15 || true
   ```
   Mention newest folders and that **Session** from the ASCII footer (or `sessionHandle` in `PI_REVIEW_META_JSON` on stderr) is used with `--continue`.

3. **Last conclusion** — if this conversation already has the ASCII `── pi-review` footer, quote verdict, duration, and session path instead of re-running review.

4. **Live output** — remind that chat tools may not stream; prefer re-running with `--progress-log <path>` + a background/tail workflow for live progress, or use a **terminal** running `pi-review` (default streaming) as a fallback.

Do not implement findings from a status check; status is informational only.

## Steps

1. Prime the model catalog:
   ```bash
   pi-review models [search]
   ```
   Rules:
   - Run this before building the review command.
   - If the user named a model, use that provider/model text as `[search]` and verify the exact ID from the output.
   - If the user did not name a model, run `pi-review models` and either choose an exact suitable ID from the output or deliberately omit `--model` to use Pi's default.
   Completion criterion: the model choice is either an exact listed `provider/model[:thinking]` or an explicit decision to use Pi's default.

2. Choose one mode:
   - default `code` — code, diff, MR, file, or repository review.
   - `--mode plan` — broad plan, architecture, product, or strategy review through multiple expert lenses.
   - `--mode challenge` — adversarial review of assumptions, boundaries, dependencies, and missing evidence.
   Completion criterion: use default `code` unless the target is clearly a plan/design review; if two modes fit equally, ask the user to choose.

3. Run an isolated review:
   ```bash
   pi-review [--mode <name>] [--model <provider/model[:thinking]>] [--keep-session|--continue <handle>] [--progress-log <path>] -- <@files|text...>
   ```
   Rules:
   - Use the model decision from step 1; do not invent model IDs.
   - Omit `--mode` for normal code review; the command defaults to `code`.
   - Use `--keep-session` only when the user wants follow-up questions on this review.
   - Use `--continue <handle>` only with a **Session** path from a prior ASCII footer or `sessionHandle` in `PI_REVIEW_META_JSON`.
   - Put file references as `@path` after `--`.
   - Do not ask `pi-review` to edit, patch, commit, or implement.
   - Default streams child output live; add `--no-stream` only when the caller must buffer until exit (cannot combine with `--progress-log`).
   - In a host that buffers tool stdout (Claude Code, Codex, ...), prefer running with `--progress-log <path>` in the background and tailing the file for live progress instead of waiting on the blocking call.
   Completion criterion: the command includes the resolved model/default choice and a concrete review target.

4. Return the result:
   - Show the Markdown review body and the **ASCII footer** (`── pi-review` block on stdout). Do not paste raw `PI_REVIEW_META_JSON` to the user unless they ask for machine output.
   - Scripts: parse `PI_REVIEW_META_JSON:` from **stderr** (or set `PI_REVIEW_META_STDOUT=1` to also emit JSON on stdout).
   - Do not apply findings automatically; implementation is a separate user decision.
   Completion criterion: the user sees the review conclusion and readable footer.

## Examples

```bash
pi-review -- @src/foo.ts
pi-review --model openai/gpt-5.5 -- @src/foo.ts
pi-review --mode challenge --keep-session -- @docs/design.md
pi-review --mode challenge --continue <sessionHandle> -- "expand finding 2"
```

## Status examples (user phrasing)

- "review status" / "is the review still running?" → run **Review status** checks above.
- "show streaming in Claude Code" / "the wait is bad, is there a better way" → explain tool buffering; re-run with `--progress-log <path>` + a background/tail workflow (or Pi `/rv`) for live progress, offering a local terminal only as a fallback.
