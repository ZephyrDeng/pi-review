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

Example tail (milestone events only):

```bash
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```