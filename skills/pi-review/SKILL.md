---
name: pi-review
description: Use pi-review to delegate isolated code, diff, repository, architecture, or plan reviews to fresh Pi sessions and return review conclusions. Also use for loop review, review-fix-re-review closeout, structured review gates, and review status/progress. Model selection presets for code, frontend, and plan review are in references/model-selection.md. On Claude Code or Codex, default to --progress-log with a background shell run and tail the log (chat tools buffer stdout).
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

## Codex / Claude Code

- Map skill mentions of `Bash` to your host shell tool.
- Read **[references/codex-tools.md](./references/codex-tools.md)** for `--progress-log` + background run + tail.
- Read **[references/model-selection.md](./references/model-selection.md)** when choosing `--model` after `pi-review models` (code / frontend / plan presets).
- Do not use a blocking foreground shell alone for live progress; follow **Default workflow by host** below.

## Default workflow by host

| Host | How to run `pi-review` |
|------|-------------------------|
| **Pi** (`/rv`) | New reviews call the native `pi_review` tool, which launches the packaged CLI in event mode and renders live Panel state. Continuations, kept sessions, and explicit `--no-stream` retain the foreground CLI path. |
| **Claude Code, Codex, Cursor**, and similar AI agents | **Default: `--progress-log <path>` + background run + tail** (see below). Do **not** rely on foreground Bash stdout for “streaming” — the tool buffers until exit. |
| Scripts / CI | Foreground is fine; use `--no-stream` only when you must buffer until exit. |

## Pi host (`/rv*`)

Slash commands select **strategy only**. Everything after the command is a **natural-language target**.

| Command | Strategy |
|---------|----------|
| `/rv <natural-language target>` | Panel review via native `pi_review` |
| `/rv-loop <natural-language target>` | Loop closeout via shell `pi-review loop` |
| `/rv-models` | Model catalog only |
| `/rv --continue <handle> [text]` | Continue a kept single-review session |

- Pass the user target **as given**. Path mentions like `@src` or `@src/foo.ts` are fine as text. Do **not** expand directories into multi-file lists in the parent agent.
- Remaining strategy matching lives here and in the CLI:
  - mode defaults (`code` / `plan` / `challenge`)
  - model choice from `pi-review models` + `references/model-selection.md`
  - panel preset (`code-experts` by default for `/rv`)
  - path-vs-file handling: directories stay tool path targets; only real files are attached
- `/rv` needs no streaming flags. The tool owns normalized events, live rendering, and the packaged CLI process.
- `/rv-loop`, `--continue`, `--keep-session`, and explicit `--no-stream` use the shell CLI path.

## Streaming vs agent hosts (Claude Code / Codex)

- `pi-review` always runs the child in `--mode json` internally. In streaming mode it forwards **readable text deltas** to stdout live and writes **semantic milestone notices** (`pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`) to **stderr**. Token usage (`input`/`output`/`cache`/`reasoning`) is accumulated by default — no `--progress-log` required to see it in the ASCII footer or `PI_REVIEW_META_JSON`.
- `--progress-log <path>` is now an **optional** convenience: it tees the raw `--mode json` event stream to a file for external observation (tail, debugging). It no longer gates token visibility.
- **Claude Code, Cursor, Codex** and similar hosts still buffer a Bash tool's stdout until the command exits. The semantic milestone notices on stderr + the final Markdown + ASCII footer on stdout give you progress and the result without needing to tail a file. If you still want the full event log for fine-grained debugging, add `--progress-log <path>` and tail it.
- **Pi interactive** sessions stream text deltas live to the terminal by default — no `--no-stream` or `--progress-log` needed.

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

## Loop closeout protocol

Use this protocol when the host is closing out implementation work and may edit between reviews. `pi-review` and every child session remain review-only; the host agent owns all fixes.

1. **Freeze the scope baseline before the first review.** Record the originating task, accepted files/modules, required behavior, and proof commands. Do not silently expand this baseline because a reviewer noticed adjacent cleanup.
2. **Run a bounded structured gate.** Prefer the productized command:
   ```bash
   pi-review loop --max-rounds 1 [shared review options] -- <@files|text...>
   # Or host-driven until-clean (still hard-capped; never unlimited):
   pi-review loop --until clean --max-rounds 10 [shared review options] -- <@files|text...>
   ```
   A one-round invocation gives the host a fix point between reviews. `--until clean` declares the success **goal** and still requires a hard `--max-rounds` ceiling (default 10 when omitted). The CLI never waits for edits and never loops forever on an unchanged tree. Re-invocation after a host fix is a new process (or the next host cycle under until-clean). On Claude Code / Codex, compose `loop` with the normal `--progress-log <path>` background + tail workflow. On Pi, retain default foreground streaming. `loop` rejects `--keep-session`, `--continue`, and `--name`.

   **Clean goal definition:**
   - Single review: `status=clean` means no actionable findings (notes/non-actionable may remain).
   - Panel review: `status=clean` means zero **confirmed** actionable clusters. Advisories do **not** fail clean.
   - `needs_human` / `blocked` never count as clean.
   - Successful closeout requires exit code `0`.
3. **Read the gate signals.** Parse `status`, `findings`, and `actionableCount` from each `PI_REVIEW_META_JSON` line and use the final loop summary. Expected statuses are `clean`, `has_findings`, `needs_human`, and `blocked`.
4. **Apply the scope governor to every finding:**
   - **in-scope blocker** — accepted, actionable, and required by the frozen task; the host may fix it now.
   - **follow-up** — valid but outside the baseline or not required for safe closeout; record it without drive-by edits.
   - **stop-and-escalate** — ambiguous intent, architectural expansion, unsafe migration, blocked tooling, or anything requiring a human decision; stop rather than guess.
   - A rejected finding must be intentional and recorded with its rationale in the final report. Never silently ignore it.
   - Check sibling instances of the same bug class only inside the frozen task/PR scope. Do not turn the check into a repository-wide refactor.
5. **Fix only in-scope blockers in the host.** Never ask the child review session to implement fixes. After each host patch, rerun the narrowest relevant proof (focused test, typecheck, lint, or reproduction) before re-reviewing.
6. **Re-review until a stop condition:**
   - `clean` → clean goal met; proceed to final proof and closeout.
   - `has_findings` → classify, fix accepted in-scope blockers, and re-invoke within the agreed host-cycle budget.
   - `needs_human` or `blocked` → stop early and escalate with the review history.
   - budget exhausted → report remaining findings and ask for a decision; do not loop indefinitely.
   - With `--until clean`, the host owns the fix→re-review cycle until clean or hard budget; never claim clean while advisories-only is fine, but confirmed/actionable findings are not.
7. **Detect non-convergence.** After two non-converging patch cycles (the same finding persists, findings oscillate, or scope grows), pause and reclassify all remaining findings before any further edit.
8. **Gate completion claims.** Never claim done, ship, commit-ready, or clean without a fresh `clean` result, unless the user gives explicit human acceptance of named remaining findings. Report accepted fixes, rejected findings with rationale, follow-ups, stop reason, and proof evidence.

The shell exit policy is: `0` clean, `1` status is `has_findings`, `2` usage error, `3` needs human, `4` blocked/runtime failure. A non-zero loop result is a gate signal, not permission for the child reviewer to edit.

## Panel review

Panel review runs multiple **independent** reviewers in isolated child sessions and aggregates their findings into one gate result. Reviewers cannot see one another's findings, so agreement represents independent discovery.

### When to use panel vs single review

- **Single review (default):** keep for small, low-cost changes. Reviewer count defaults to one; the existing execution, output, status mapping, and exit policy stay unchanged.
- **Panel review:** use when a change deserves independent scrutiny. Activate it with `--reviewers <n>` (2-8) or `--panel <name>`.

### Consensus

A finding becomes a **confirmed finding** (gate-relevant) only when enough independent reviewers mark the issue **actionable**. Otherwise it stays a non-blocking **advisory**.

Consensus policies (default `quorum` for multi-reviewer panels):

| Policy | Threshold |
|--------|----------|
| `any` | one actionable reviewer confirms |
| `quorum` | configured minimum agreement (default 2; set with `--min-agree`) |
| `majority` | `floor(reviewers / 2) + 1` |
| `unanimous` | every reviewer |

Multi-reviewer panels default to **quorum with minimum agreement 2** so panel mode never silently becomes any-finding fail-closed. Single-review stays threshold one.

### Advisories

Singleton (uncorroborated) findings remain visible as **advisories** but do **not** change clean status or fail the gate. They are recorded as non-blocking follow-ups; the host promotes them only with explicit human acceptance. Confirmed actionable clusters produce `has_findings`; no confirmed clusters produce `clean`.

### Aggregation

Two-phase matching: deterministic matching on stable anchors (path + normalized summary) first; only ambiguous same-path candidates go to a constrained **semantic adjudicator** (enabled with `--consensus-model`). The adjudicator clusters findings and may **not** invent findings, drop findings, add evidence, or act as another reviewer — it has no write tools. Low-confidence matches stay separate advisories so uncertain similarity cannot manufacture quorum.

### Cost multipliers

Cost is visible before execution. Reviewer runs = `--reviewers <n>` × `--max-rounds` (loop). One consensus-adjudication call may run per round when `--consensus-model` is set, tracked separately. Use `--concurrency <n>` to bound provider/machine pressure (default: reviewer count, never exceeds it).

### Host-only fixes

Panel review composes with Loop Review: one loop round evaluates one **complete panel** with fresh reviewer sessions. The CLI never edits, patches, or waits for filesystem changes — the host agent remains the only actor allowed to fix between process invocations. Apply the scope governor to **confirmed** findings exactly as for single-review findings. Rejected confirmed findings must be recorded with rationale. `--max-rounds 1` keeps the patch-by-patch closeout workflow.

Panel review rejects `--keep-session`, `--continue`, and `--name` in v1 (reviewers run `--no-session`). Reviewer runtime failure → `blocked`; unstructured dirty output or unresolved clarification → `needs_human`; never silently clean.

### Examples

```bash
# Single panel review
pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
# Expert preset
pi-review --panel code-experts --consensus majority -- @src
# Panel loop review (up to 6 reviewer runs + adjudication)
pi-review loop --reviewers 3 --consensus quorum --max-rounds 2 -- @src
```

## Steps

1. Prime the model catalog and pick a model:
   ```bash
   pi-review models [search]
   ```
   Rules:
   - Run this before building the review command.
   - If the user named a model, use that text as `[search]` and resolve it against the catalog:
     - exact `provider/model` wins
     - short ids like `gpt-5.5` / `kimi` may uniquely match a listed id
     - ambiguous matches: show top candidates and ask, do not guess across model families
     - never invent a provider/model that is not listed
   - Thinking shortcuts are allowed (`最高`/`max` → `xhigh`, `高` → `high`). If the model does not support the requested level, fall back to the nearest supported level and say so.
   - On Pi `/rv*`, the extension already resolves short model/thinking tokens against the live registry when possible; still verify unresolved names via `pi-review models`.
   - If the user did not name a model, follow **[references/model-selection.md](./references/model-selection.md)**: infer profile (code / frontend / plan), match the priority list against catalog ids, then set `--model` with optional `:thinking` when supported.
   - On **Claude Code / Codex / Cursor**, state the chosen model in one line (match the user's language) before running the review command.
   - If nothing in the priority list matches, omit `--model` (Pi default) or pick a listed reasoning model with large context—say which and why.
   Completion criterion: exact listed `provider/model[:thinking]` or an explicit default; never invented ids.

2. Choose one mode:
   - default `code` — code, diff, MR, file, or repository review.
   - `--mode plan` — broad plan, architecture, product, or strategy review through multiple expert lenses.
   - `--mode challenge` — adversarial review of assumptions, boundaries, dependencies, and missing evidence.
   Completion criterion: use default `code` unless the target is clearly a plan/design review; if two modes fit equally, ask the user to choose.

3. Run an isolated review:
   ```bash
   pi-review [--mode <name>] [--model <provider/model[:thinking]>] [--keep-session|--continue <handle>] [--progress-log <path>] -- <natural-language target...>
   ```
   Rules:
   - Use the model decision from step 1; do not invent model IDs.
   - Omit `--mode` for normal code review; the command defaults to `code`.
   - Use `--keep-session` only when the user wants follow-up questions on this review.
   - Use `--continue <handle>` only with a **Session** path from a prior ASCII footer or `sessionHandle` in `PI_REVIEW_META_JSON`.
   - Pass the review request as natural language after `--`. Path mentions (`@src`, `@src/foo.ts`) are allowed as text.
   - Do **not** expand directories into long multi-file attachment lists. The CLI keeps directory `@refs` as tool path targets and only attaches real files.
   - On Pi `/rv`, call `pi_review` with that same natural-language target.
   - On Pi `/rv-loop`, run the shell `pi-review loop` path with that same natural-language target and follow **Loop closeout protocol**.
   - Do not ask `pi-review` to edit, patch, commit, or implement.
   - **Pi `/rv`:** default streaming; no `--progress-log` unless the user asked.
   - **Claude Code / Codex / Cursor:** **include `--progress-log <path>` by default**; background the CLI and tail the log for user-visible progress. Foreground Bash alone does not stream in chat.
   - Add `--no-stream` only when the caller must buffer until exit (cannot combine with `--progress-log`).
   Completion criterion: the command includes the resolved model/default choice and a concrete natural-language review target.

4. Return the result:
   - Show the Markdown review body and the **ASCII footer** (`── pi-review` block on stdout). Do not paste raw `PI_REVIEW_META_JSON` to the user unless they ask for machine output.
   - Scripts: parse `PI_REVIEW_META_JSON:` from **stderr** (or set `PI_REVIEW_META_STDOUT=1` to emit JSON on stdout instead).
   - For an ordinary review-only request, do not apply findings automatically; implementation is a separate user decision. When the user already requested implementation closeout, follow **Loop closeout protocol** and let only the host fix accepted in-scope blockers.
   Completion criterion: the user sees the review conclusion and readable footer.

## Examples

```bash
pi-review -- @src
pi-review -- @src/foo.ts
pi-review --model openai/gpt-5.5 -- "review the auth changes under @src"
pi-review --mode challenge --keep-session -- @docs/design.md
pi-review --mode challenge --continue <sessionHandle> -- "expand finding 2"
pi-review loop --max-rounds 1 -- @src
pi-review loop --until clean --max-rounds 10 -- @src
pi-review loop --max-rounds 1 --progress-log /tmp/pi-review-loop.jsonl -- @src
```

## Status examples (user phrasing)

- "review status" / "is the review still running?" → run **Review status** checks above.
- "show streaming in Claude Code" / "the wait is bad, is there a better way" → explain tool buffering; re-run with `--progress-log <path>` + a background/tail workflow (or Pi `/rv`) for live progress, offering a local terminal only as a fallback.
