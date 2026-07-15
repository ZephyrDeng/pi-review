# Agent host tool notes (Codex / Claude Code)

Skills may use Claude Code tool names. On **Codex** or **Claude Code**, map them to your native tools:

| Skill references | Typical host equivalent |
|-----------------|-------------------------|
| `Bash` (run commands) | Native shell / terminal tool |
| `Read`, `Write`, `Edit` | Native file tools |
| `Skill` | Load and follow the skill instructions directly |

General Codex subagent and worktree mappings live in the **using-superpowers** skill (`references/codex-tools.md`) when that skill is installed; this file is **pi-review–specific** and ships with the pi-review package.

## Long-running `pi-review` (default on Codex / Claude Code)

Native shell tools on these hosts **buffer stdout/stderr until the command exits**. A multi-minute foreground `pi-review` run looks like a silent wait, then one large dump — never promise live foreground streaming.

When the **pi-review** skill applies on Codex, Claude Code, or Cursor:

1. **Default:** run `pi-review ... --progress-log <path> -- <target>` in the **background** and **tail the log** for user-visible progress (see the tail example below). Stdout still delivers the review Markdown + ASCII footer on exit.
2. `--progress-log` tees the raw `--mode json` event stream to the chosen file for observation and debugging. It is **not** a prerequisite for metrics: the ASCII footer and `PI_REVIEW_META_JSON` always include `thinking` + token usage (`input`/`output`/`cache`/`reasoning`) when the child session reports them.
3. `pi-review` also writes semantic milestone notices to stderr (`pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`); they surface once the host flushes output.
4. After exit, show the Markdown review body and ASCII `── pi-review` footer (skill step 4).

**Pi interactive (`/rv`)**: foreground `pi-review`, default streaming. Text deltas appear live on the terminal; no `--progress-log` unless the user asked.

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