---
name: pi-review
description: Use pi-review to delegate isolated code, diff, repository, architecture, or plan reviews to fresh Pi sessions and return review conclusions. Also use for loop review, review-fix-re-review closeout, panel review gates, and review status/progress questions.
---

# Pi Review

Use `pi-review` to run a fresh Pi review session and return only the review conclusion. Every review run is read-only: the child session never edits, patches, or commits — the host agent owns all fixes.

## CLI resolution

Prefer the shell command when it exists:

```bash
pi-review --help
```

If `pi-review` is not on PATH but this skill came from the Pi package, use the package-local CLI relative to the actual directory that contains this `SKILL.md`:

```bash
node ../../bin/pi-review.js --help
```

## Default workflow by host

| Host | How to run `pi-review` |
|------|-------------------------|
| **Pi** (`/rv`) | New panel reviews call the native `pi_review` API tool, shown to users as **Pi Review Panel**, which launches the packaged CLI in event mode and renders live reviewer state. Continuations, kept sessions, `/rv-loop`, and explicit `--no-stream` use the shell CLI. |
| **Pi terminal** | Foreground `pi-review`; text deltas stream live by default. |
| **Claude Code / Codex / Cursor** and similar agent hosts | These hosts buffer a shell tool's output until the command exits, so a foreground run looks like a silent wait. **Default: `--progress-log <path>` + background run + tail the log** — see [references/codex-tools.md](./references/codex-tools.md). Map skill mentions of `Bash` to your host shell tool. |
| Scripts / CI | Foreground is fine; add `--no-stream` only when the caller must buffer until exit (cannot combine with `--progress-log`). |

`--progress-log <path>` tees the raw `--mode json` event stream to a file for outside observation and debugging; it is never a prerequisite for metrics. Token usage accumulates by default, and `pi-review` writes milestone notices (`pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`) to stderr.

## Run metrics

Quote metrics from the run output; never estimate or invent them.

- **ASCII footer** (the `── pi-review` / `── pi-review panel` block): Duration, Tokens as `in · out · cache · reason` plus total, and Cost — the provider-reported value, or `n/a` when the provider reports none. On Pi `/rv` the panel tool result uses this same classic ASCII chrome (not a free-form markdown table).
- **Pi Review Panel**: each reviewer row shows **role persona · lifecycle · model · thinking · elapsed · tokens**. Lifecycle is `queued` / `running` / `completed` / `failed` / `cancelled`. Expanded view adds bounded activity, findings with provenance, and per-reviewer metrics.
- Machine output: parse `PI_REVIEW_META_JSON:` from **stderr** (or set `PI_REVIEW_META_STDOUT=1` to emit it on stdout). Show users the Markdown body and ASCII footer, not raw JSON, unless they ask for machine output.

## Pi host (`/rv*`)

Slash commands select **strategy only**. Everything after the command is a **natural-language target**.

| Command | Strategy |
|---------|----------|
| `/rv <natural-language target>` | Panel review via native **Pi Review Panel** (`pi_review` API tool); preset `code-experts` unless `--reviewers`/`--panel` say otherwise |
| `/rv-loop <natural-language target>` | Loop closeout via shell `pi-review loop`; host fix point `--max-rounds 1` by default |
| `/rv-models` | Model catalog only |
| `/rv --continue <handle> [text]` | Continue a kept single-review session |

- Pass the user target **as given**. Path mentions like `@src` or `@src/foo.ts` are fine as text. Do **not** expand directories into multi-file lists in the parent agent.
- Remaining strategy matching lives here and in the CLI: mode defaults (`code` / `plan` / `challenge`), model choice from `pi-review models` + [references/model-selection.md](./references/model-selection.md), panel width, and path-vs-file handling (directories stay tool path targets; only real files are attached).
- `/rv` needs no streaming flags; the tool owns normalized events, live rendering, and the packaged CLI process. `/rv --reviewers 1` is an explicit non-panel single review and stays on the shell CLI path — never substitute the default panel.

## Review status (no slash command)

There is **no** `/status` slash in this skill. When the user asks for **review status**, **progress**, or **is pi-review still running**, run read-only checks and summarize — do **not** start a new review.

1. **In-flight review (heuristic)** — list likely `pi-review` / child `pi -p` processes:
   ```bash
   pgrep -fl 'pi-review' 2>/dev/null || true
   pgrep -fl 'pi.*-p' 2>/dev/null | head -20 || true
   ```
   If matches exist, say a review **may still be running** (heuristic; other `pi -p` jobs can match). If none, say **no obvious in-flight pi-review** from the process list — not that the last review failed.

2. **Persisted sessions** (only after `--keep-session` / `--continue`) — default dir `~/.pi/pi-review/sessions`, overridable with `PI_REVIEW_SESSION_DIR`:
   ```bash
   ls -lt "${PI_REVIEW_SESSION_DIR:-$HOME/.pi/pi-review/sessions}" 2>/dev/null | head -15 || true
   ```
   Mention newest folders and that **Session** from the ASCII footer (or `sessionHandle` in `PI_REVIEW_META_JSON`) is used with `--continue`.

3. **Last conclusion** — if this conversation already has the ASCII `── pi-review` footer, quote verdict, duration, and session path instead of re-running the review.

4. **Live output** — for live progress, re-run with the host's default workflow (background + `--progress-log` + tail on agent hosts), or a terminal running `pi-review` as a fallback.

Do not implement findings from a status check; status is informational only.

## Loop closeout protocol

Use this protocol when the host is closing out implementation work and may edit between reviews. `pi-review` and every child session remain review-only; the host agent owns all fixes.

1. **Freeze the scope baseline before the first review.** Record the originating task, accepted files/modules, required behavior, and proof commands. Do not silently expand this baseline because a reviewer noticed adjacent cleanup.
2. **Confirm until-clean stop conditions with the user.** An until-clean run starts only after the user confirms two things: what **clean** must mean for this run, and the hard `--max-rounds` cap. Offer a suggested default they can accept or adjust — e.g. "clean = zero confirmed actionable findings (advisories allowed), hard cap 10 rounds". A user request that already pins both counts as confirmation; restate it in one line and proceed. Fixed-round gates (`--max-rounds N` without `--until`) need no confirmation.
3. **Run a bounded structured gate.** Prefer the productized command:
   ```bash
   pi-review loop --max-rounds 1 [shared review options] -- <@files|text...>
   # Or host-driven until-clean (still hard-capped; never unlimited):
   pi-review loop --until clean --max-rounds 10 [shared review options] -- <@files|text...>
   ```
   Round budgets: CLI `loop` defaults to `--max-rounds 3` when the flag is omitted; `--until clean` without an explicit flag defaults to a hard cap of 10; `/rv-loop` defaults to `--max-rounds 1` as a host fix point. A one-round invocation gives the host a fix point between reviews. `--until clean` declares the success **goal** and never removes the hard ceiling. The CLI never waits for edits and never loops forever on an unchanged tree. Re-invocation after a host fix is a new process (or the next host cycle under until-clean). Run `loop` with the host's default workflow from the table above. `loop` rejects `--keep-session`, `--continue`, and `--name`.

   **Clean goal definition:**
   - Single review: `status=clean` means no actionable findings (notes/non-actionable may remain).
   - Panel review: `status=clean` means zero **confirmed** actionable clusters. Advisories do **not** fail clean.
   - `needs_human` / `blocked` never count as clean.
   - Successful closeout requires exit code `0`.
4. **Read the gate signals.** Parse `status`, `findings`, and `actionableCount` from each `PI_REVIEW_META_JSON` line and use the final loop summary. Expected statuses are `clean`, `has_findings`, `needs_human`, and `blocked`.
5. **Apply the scope governor to every finding:**
   - **in-scope blocker** — accepted, actionable, and required by the frozen task; the host may fix it now.
   - **follow-up** — valid but outside the baseline or not required for safe closeout; record it without drive-by edits.
   - **stop-and-escalate** — ambiguous intent, architectural expansion, unsafe migration, blocked tooling, or anything requiring a human decision; stop rather than guess.
   - A rejected finding must be intentional and recorded with its rationale in the final report. Never silently ignore it.
   - Check sibling instances of the same bug class only inside the frozen task/PR scope. Do not turn the check into a repository-wide refactor.
6. **Fix only in-scope blockers in the host.** Never ask the child review session to implement fixes. After each host patch, rerun the narrowest relevant proof (focused test, typecheck, lint, or reproduction) before re-reviewing.
7. **Re-review until a stop condition:**
   - `clean` → clean goal met; proceed to final proof and closeout.
   - `has_findings` → classify, fix accepted in-scope blockers, and re-invoke within the agreed host-cycle budget.
   - `needs_human` or `blocked` → stop early and escalate with the review history.
   - budget exhausted → report remaining findings and ask for a decision; do not loop indefinitely.
   - With `--until clean`, the host owns the fix→re-review cycle until clean or hard budget. Advisories alone do not block clean; confirmed actionable findings do.
8. **Detect non-convergence.** After two non-converging patch cycles (the same finding persists, findings oscillate, or scope grows), pause and reclassify all remaining findings before any further edit.
9. **Gate completion claims.** Never claim done, ship, commit-ready, or clean without a fresh `clean` result, unless the user gives explicit human acceptance of named remaining findings. Report accepted fixes, rejected findings with rationale, follow-ups, stop reason, and proof evidence.

The shell exit policy is: `0` clean, `1` status is `has_findings`, `2` usage error, `3` needs human, `4` blocked/runtime failure. A non-zero loop result is a gate signal, not permission for the child reviewer to edit.

## Panel review

Panel review runs multiple **independent** reviewers in isolated child sessions and aggregates their findings into one gate result. Reviewers cannot see one another's findings, so agreement represents independent discovery.

### When to use panel vs single review

- **Single review (default):** keep for small, low-cost changes. Reviewer count defaults to one; the existing execution, output, status mapping, and exit policy stay unchanged.
- **Panel review:** use when a change deserves independent scrutiny. Activate it with `--reviewers <n>` (2-8) or `--panel <name>`; the two flags cannot combine. `--reviewers 1` stays a shell single review, and the `pi_review` API tool accepts only 2-8 reviewers.
- **Generic `--reviewers N` roles** are distinct persona labels (rappers / AI KOLs / sports stars), **not** the literal string `Independent reviewer`. Named presets (`code-experts`) keep their fixed roles (correctness/security/testing). Do not invent or hardcode role names when calling `pi_review` — the CLI assigns them.
- **Per-reviewer thinking**: pass `id=provider/model:thinking` via `--reviewer-model` / `reviewerModels` (e.g. `r1=zenmux/deepseek/deepseek-v4-flash:low`). The `:thinking` suffix is stripped into the thinking field and **must not** be overridden by a shared `--thinking` or preset default. Display should look like `model · low`, never `model:low · high`.

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
# Single panel review (roles auto-assigned as distinct personas)
pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
# Per-reviewer model + thinking (suffix wins over shared --thinking)
pi-review --reviewers 3 --reviewer-model r1=zenmux/deepseek/deepseek-v4-flash:low --reviewer-model r2=zenmux/minimax/minimax-m3:off -- @src
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
   - Run this before building the review command. **Never invent a `provider/model` id** — only ids from the catalog output.
   - Follow **[references/model-selection.md](./references/model-selection.md)** for everything else: profile inference (code / frontend / plan), priority lists, user-named-model resolution, and thinking aliases (`max`/`最高` → `xhigh`, with fallback to the nearest supported level).
   - Ambiguous match across model families: show the top candidates and ask; do not guess.
   - No priority match: omit `--model` (Pi default) or pick a listed reasoning model with a large context window — say which and why.
   - On **Claude Code / Codex / Cursor**, state the chosen model in one line (match the user's language) before running the review command.
   Completion criterion: exact listed `provider/model[:thinking]` or an explicit default; never invented ids.

2. Choose one mode:
   - default `code` — code, diff, MR, file, or repository review.
   - `--mode plan` — broad plan, architecture, product, or strategy review through multiple expert lenses.
   - `--mode challenge` — adversarial review of assumptions, boundaries, dependencies, and missing evidence.
   **Challenge mode: grill first.** Before running an adversarial review, grill the user with 2-3 pointed questions — for example: what outcome must this work achieve, which assumption hurts most if wrong, what evidence supports it? Weave the answers into the natural-language target so the reviewer attacks the real weak points.
   Completion criterion: use default `code` unless the target is clearly a plan/design review; if two modes fit equally, ask the user to choose. For `challenge`, the grill answers are folded into the target before the command runs.

3. Run an isolated review:
   ```bash
   pi-review [--mode <name>] [--model <provider/model[:thinking]>] [--keep-session|--continue <handle>] [--progress-log <path>] -- <natural-language target...>
   ```
   Rules:
   - Use the model decision from step 1 and the execution path from **Default workflow by host**.
   - Omit `--mode` for normal code review; the command defaults to `code`.
   - Use `--keep-session` only when the user wants follow-up questions on this review; use `--continue <handle>` only with a **Session** path from a prior ASCII footer or `sessionHandle` in `PI_REVIEW_META_JSON`.
   - Pass the review request as natural language after `--`. Path mentions (`@src`, `@src/foo.ts`) are allowed as text. Do **not** expand directories into multi-file attachment lists — the CLI keeps directory `@refs` as tool path targets and only attaches real files.
   - On Pi `/rv`, call `pi_review` with that same natural-language target. On Pi `/rv-loop`, run shell `pi-review loop` with it and follow **Loop closeout protocol**.
   - Do not ask `pi-review` to edit, patch, commit, or implement.
   Completion criterion: the command includes the resolved model/default choice and a concrete natural-language review target.

4. Return the result:
   - Show the Markdown review body and the ASCII footer, with metrics quoted per **Run metrics**.
   - For an ordinary review-only request, do not apply findings automatically; implementation is a separate user decision. When the user already requested implementation closeout, follow **Loop closeout protocol** and let only the host fix accepted in-scope blockers.
   Completion criterion: the user sees the review conclusion and readable footer.

## Examples

```bash
pi-review -- @src
pi-review -- @src/foo.ts
pi-review --model openai/gpt-5.5 -- "review the auth changes under @src"
pi-review --mode challenge --keep-session -- @docs/design.md    # after the 2-3 grill questions
pi-review --mode challenge --continue <sessionHandle> -- "expand finding 2"
pi-review loop --max-rounds 1 -- @src                           # host fix point
pi-review loop -- @src                                          # CLI default: --max-rounds 3
pi-review loop --until clean --max-rounds 10 -- @src            # after the user confirms the stop conditions
pi-review loop --max-rounds 1 --progress-log /tmp/pi-review-loop.jsonl -- @src
```

## Status examples (user phrasing)

- "review status" / "is the review still running?" → run **Review status** checks above.
- "show streaming in Claude Code" / "the wait is bad, is there a better way" → explain that the host buffers tool output; re-run with the default background + `--progress-log` + tail workflow (or Pi `/rv`), offering a local terminal only as a fallback.
