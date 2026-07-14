# Agent host tool notes (Codex / Claude Code)

Skills may use Claude Code tool names. On **Codex** or **Claude Code**, map them to your native tools:

| Skill references | Typical host equivalent |
|-----------------|-------------------------|
| `Bash` (run commands) | Native shell / terminal tool |
| `Read`, `Write`, `Edit` | Native file tools |
| `Skill` | Load and follow the skill instructions directly |

General Codex subagent and worktree mappings live in the **using-superpowers** skill (`references/codex-tools.md`) when that skill is installed; this file is **pi-review–specific** and ships with the pi-review package.

## Long-running `pi-review` (default on Codex / Claude Code)

Native shell tools usually **buffer stdout/stderr until the command exits**. A multi-minute `pi-review` run can look like a silent wait, then one large dump. `pi-review` mitigates this in two ways that need **no** `--progress-log`:

1. **Semantic milestone notices on stderr** (`pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`). Capture stderr separately or interleave it to show progress.
2. **Token usage by default**: the ASCII footer and `PI_REVIEW_META_JSON` always include `thinking` + token usage (`input`/`output`/`cache`/`reasoning`) when the child session reports them — no `--progress-log` required.

When the **pi-review** skill applies on Codex, Claude Code, or Cursor:

1. **Default:** run `pi-review ... -- <target>` (foreground or background). Stderr carries milestone notices; stdout carries the review Markdown + ASCII footer on exit.
2. If you want the **full** `--mode json` event log for fine-grained debugging, add `--progress-log <path>` and tail it — but this is optional, not required for tokens or progress.
3. After exit, show the Markdown review body and ASCII `── pi-review` footer (skill step 4).

**Pi interactive (`/rv`)**: foreground `pi-review`, default streaming. Text deltas appear live on the terminal; no `--progress-log` unless the user asked.

See the parent skill: sections *Default workflow by host* and *Streaming vs agent hosts (Claude Code / Codex)*.

### Loop closeout

`loop` composes with the same default streaming + stderr-milestone workflow:

```bash
pi-review loop --max-rounds 1 -- @src
# optional: --progress-log /tmp/pi-review-loop.jsonl for the full event log
```

A non-zero command exit is an expected gate result when findings remain. Wait for the process, read the final `PI_REVIEW_META_JSON` / loop summary, let the host fix only accepted in-scope findings, rerun focused proof, and invoke a new loop process. The child review session never edits. Reuse or truncate the progress log deliberately because every loop round appends events to the chosen path.

**Model choice:** after `pi-review models`, use **[model-selection.md](./model-selection.md)** (code / frontend / plan presets)—same guidance as Pi `/rv` completions.

Example tail (milestone events only):

```bash
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```