# Agent host tool notes (Codex / Claude Code)

Skills may use Claude Code tool names. On **Codex** or **Claude Code**, map them to your native tools:

| Skill references | Typical host equivalent |
|-----------------|-------------------------|
| `Bash` (run commands) | Native shell / terminal tool |
| `Read`, `Write`, `Edit` | Native file tools |
| `Skill` | Load and follow the skill instructions directly |

General Codex subagent and worktree mappings live in the **using-superpowers** skill (`references/codex-tools.md`) when that skill is installed; this file is **pi-review–specific** and ships with the pi-review package.

## Long-running `pi-review` (default on Codex / Claude Code)

Native shell tools usually **buffer stdout/stderr until the command exits**. A multi-minute `pi-review` run can look like a silent wait, then one large dump—even though the CLI streams by default. Default `text` mode also emits **no stdout** during tool-use/thinking (only the final answer).

When the **pi-review** skill applies on Codex, Claude Code, or Cursor:

1. **Default:** `pi-review --progress-log <path> ...` (writable file, e.g. `/tmp/pi-review-<id>.jsonl`).
2. Start that command in a **background** or **async** shell invocation—not a single blocking call with no interim updates.
3. **Tail** the log while the child runs; summarize milestones to the user (skip `message_update` / `tool_execution_update` unless they want token-level detail).
4. After exit, show the Markdown review and ASCII `── pi-review` footer (skill step 4).

**Pi interactive (`/rv`)** is different: foreground `pi-review`, default streaming only—do **not** auto-add `--progress-log` unless the user asked.

See the parent skill: sections *Default workflow by host* and *Streaming vs agent hosts (Claude Code / Codex)*.

### Loop closeout

`loop` composes with the same background progress workflow:

```bash
pi-review loop --max-rounds 1 --progress-log /tmp/pi-review-loop.jsonl -- @src
```

A non-zero command exit is an expected gate result when findings remain. Wait for the process, read the final `PI_REVIEW_META_JSON` / loop summary, let the host fix only accepted in-scope findings, rerun focused proof, and invoke a new loop process. The child review session never edits. Reuse or truncate the progress log deliberately because every loop round appends events to the chosen path.

**Model choice:** after `pi-review models`, use **[model-selection.md](./model-selection.md)** (code / frontend / plan presets)—same guidance as Pi `/rv` completions.

Example tail (milestone events only):

```bash
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```