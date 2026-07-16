# Agent host tool notes (Codex / Claude Code)

Skills may use Claude Code tool names. On **Codex** or **Claude Code**, map them to your native tools:

| Skill references | Typical host equivalent |
|-----------------|-------------------------|
| `Bash` (run commands) | Native shell / terminal tool |
| `Read`, `Write`, `Edit` | Native file tools |
| `Skill` | Load and follow the skill instructions directly |

This file is **pi-review–specific** and ships with the pi-review package.

## Long-running `pi-review` (default on Codex / Claude Code)

Native shell tools on these hosts **buffer stdout/stderr until the command exits**. A multi-minute foreground `pi-review` run looks like a silent wait, then one large dump — never promise live foreground streaming. Which side channel to use depends on the run type: panel review gets the browser dashboard; single review and `loop` get the tailed progress log.

### Panel review: browser dashboard (default)

`--reviewers <n>` or `--panel <name>` activates panel review. On Codex, Claude Code, or Cursor, default to the dashboard instead of a tailed log:

1. Run `pi-review --reviewers <n> --ui web --ui-url-file <path> -- <target>` (or `--panel <name>`) in the **background**. The dashboard auto-opens in the user's default browser once the server is ready; pass `--no-ui-open` only when the user asked not to open a browser (CI, remote shells).
2. Read `<path>` shortly after launch — it is written atomically as soon as the dashboard server is ready, well before reviewers finish (poll a few times a second for a couple of seconds if the file is not there yet). Share that URL with the user as a fallback: *"Dashboard opened in your browser (URL: `<url>`). I'll report back when the review completes."*
3. Wait for the background job. On exit, show the Markdown review body and ASCII `── pi-review` footer as usual (skill step 4) — the dashboard is a presentation layer only; findings, gate status, and exit code always come from `PI_REVIEW_META_JSON`.
4. `--ui web` requires an active panel and rejects `loop` — for a single review or a panel `loop`, fall back to the progress-log workflow below.

### Single review / `loop`: progress log + tail

1. **Default:** run `pi-review ... --progress-log <path> -- <target>` in the **background** and **tail the log** for user-visible progress (see the tail example below). Stdout still delivers the review Markdown + ASCII footer on exit.
2. `--progress-log` tees the raw `--mode json` event stream to the chosen file for observation and debugging. It is **not** a prerequisite for metrics: the ASCII footer and `PI_REVIEW_META_JSON` always include `thinking` + token usage (`input`/`output`/`cache`/`reasoning`) when the child session reports them.
3. `pi-review` also writes semantic milestone notices to stderr (`pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`); they surface once the host flushes output.
4. After exit, show the Markdown review body and ASCII `── pi-review` footer (skill step 4).

**Pi interactive (`/rv`)**: foreground `pi-review`, default streaming. Text deltas appear live on the terminal; no `--progress-log`/`--ui web` unless the user asked — Pi already renders panel progress natively.

See the parent skill: sections *Default workflow by host* and *Streaming vs agent hosts (Claude Code / Codex)*.

### Loop closeout

`loop` composes with the same background + `--progress-log` + tail workflow:

```bash
pi-review loop --max-rounds 1 --progress-log /tmp/pi-review-loop.jsonl -- @src
# CLI default when --max-rounds is omitted: 3; --until clean defaults to a hard cap of 10
```

A non-zero command exit is an expected gate result when findings remain. Wait for the process, read the final `PI_REVIEW_META_JSON` / loop summary, let the host fix only accepted in-scope findings, rerun focused proof, and invoke a new loop process. The child review session never edits. Reuse or truncate the progress log deliberately because every loop round appends events to the chosen path.

**Model choice:** after `pi-review models`, use **[model-selection.md](./model-selection.md)** (code / frontend / plan presets)—same guidance as Pi `/rv` completions.

Example tail (milestone events only):

```bash
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```