# Design: `--verify` mode

Status: implemented (opt-in). Owner revision Rev1 applied: verification content is
**agent-proposed and human-approved**; a committed whitelist acts as standing
pre-approval.

## Goal

Before reviewers start, run verification commands (unit tests, type checks,
lint, a minimal repro test) once, in a disposable isolated copy of the working
tree, and inject the results into every reviewer prompt as shared evidence of
source type `test-output`. Reviewers then argue from executed evidence instead
of inference.

## Non-goals

- Giving any LLM a shell. Reviewers keep `read,grep,find,ls`; the optional Pi
  proposer gets the same read-only set. Only CLI code executes commands.
- Guessing commands from `package.json`, Makefiles, CI config (follow-up).
- Sandboxing the commands themselves (no container / seccomp). Isolation here
  protects the working tree, not the machine; see the threat model.
- Changing `screen`, `classify`, or anything when `--verify` is absent.

## Concepts

| Term | Meaning |
|---|---|
| Verification plan | JSON list of steps an agent wants run (schema below). |
| Proposer | Who wrote the plan: `host` (the calling agent, default) or `pi` (`pi-review verify propose`, read-only child). |
| Standing whitelist | `verify.commands` in `.pi-review.json` **as committed at `HEAD`**. A plan step whose `argv` exactly equals a whitelisted `argv` (and has no `files`/`cwd`) is pre-approved. |
| Approval record | JSON written by `pi-review verify approve` after the host asked the human. Binds decisions to per-step content hashes. |
| Verification summary | The result object injected into prompts and written to meta as `verification`. |

## Command surface

Review and loop flags (all imply verification is on; nothing runs without one of them):

| Flag | Effect |
|---|---|
| `--verify` | Turn verification on. Without a plan: run the standing whitelist. |
| `--verify-plan <file>` | Run this plan. Pre-approved steps run; others need an approval. Implies `--verify`. |
| `--verify-approval <file>` | Approval record (repeatable; decisions are unioned by step hash, `rejected` wins). Implies `--verify`. |

`verify` subcommands (no review is run):

| Command | Effect | Exit |
|---|---|---|
| `pi-review verify propose [--model m] [--provider p] [--thinking t] -- <target>` | Read-only Pi child drafts a plan; prints plan JSON to stdout. | 0 ok, 4 child/parse failure |
| `pi-review verify show <plan>` | Validates the plan, prints each step, its hash, and whether it is pre-approved. | 0 all pre-approved, **5 approval required**, 2 invalid |
| `pi-review verify approve <plan> (--all \| --steps a,b) [--reject c] [--by text]` | Prints an approval record for the current plan content. | 0, 2 invalid |
| `pi-review verify run [--plan p] [--approval a]...` | Runs verification only and prints the summary JSON (iteration helper). | 0 when a summary is produced |

### Handshake (who asks, and how)

Pi review children run `-p` non-interactively, so the question is asked on the
host side:

1. Host agent writes `plan.json` (source a, default) or runs
   `pi-review verify propose -- <target> > plan.json` (source b, fallback).
2. `pi-review verify show plan.json`. Exit 5 means at least one step needs a
   human decision.
3. Host shows the steps to the user with its own question tool (Claude Code
   `AskUserQuestion`, Codex approval prompt, …) and collects approve / reject per
   step or for the whole plan.
4. `pi-review verify approve plan.json --steps <approved> --reject <rejected> --by "<who, how>" > approval.json`.
5. `pi-review --verify-plan plan.json --verify-approval approval.json -- <target>`.

No approval means no execution: unapproved steps are recorded as
`skipped_unapproved`. That is also the CI / non-interactive behaviour: only
pre-approved (whitelisted) steps run.

Host (a) is the default proposer because it holds session context the CLI
cannot see (issue text, design docs, what it just changed, which claim it wants
checked). The Pi proposer (b) exists for hosts without that context; it reads
the repo with read-only tools and returns the same plan format, which still
goes through the same approval gate.

The CLI cannot prove a human pressed the button; the approval record is an
honest-host protocol, documented in `skills/pi-review/SKILL.md`. What the CLI
does enforce: nothing outside the whitelist runs without a matching approval,
and any change to an approved step voids its approval.

## Plan schema (version 1)

```json
{
  "version": 1,
  "proposer": "host",
  "summary": "Check the gate exit-code change",
  "steps": [
    {
      "id": "unit-gate",
      "argv": ["npx", "vitest", "run", "src/cli-exit.test.ts"],
      "purpose": "Claim: has_findings now maps to exit 1",
      "expectedDurationSec": 20,
      "sideEffects": "none outside the copy",
      "idempotent": true,
      "isolated": true,
      "timeoutSec": 120,
      "round": 1
    },
    {
      "id": "repro-empty-diff",
      "argv": ["npx", "vitest", "run", "src/__verify__/repro.test.ts"],
      "purpose": "Minimal repro: empty diff must not report clean",
      "files": [{ "path": "src/__verify__/repro.test.ts", "content": "..." }]
    }
  ]
}
```

- Unknown fields (plan, step, file, whitelist command) are rejected, so a typo
  such as `file` for `files` cannot be approved and then silently ignored.
- `id` `[A-Za-z0-9_.-]{1,64}`, unique. `argv` is a non-empty string array,
  executed **without a shell** (no pipes, globbing, `&&`); use `sh -c` explicitly
  if needed, which the human then sees and approves.
- `purpose` is required: which claim or change the step verifies.
- `expectedDurationSec`, `sideEffects`, `idempotent` are the proposer's
  self-assessment, shown to the human, **never** used as a gate.
- `isolated` may be omitted or `true`; `false` is rejected because every step
  runs in the isolated copy.
- `cwd` is relative to the repo root and must stay inside it.
- `files` are new test/repro files written **only into the isolated copy**
  right before the step runs; paths must be relative and inside the copy (also
  after resolving symlinks, so they cannot land in a `link`ed directory). A
  path that is itself a symlink, or that passes through a dangling one, is
  rejected (checked with `lstat`, so committed dangling links cannot redirect a write). They
  never touch the original tree. They stay in the copy for later steps of the
  same run, so order steps accordingly.
- `timeoutSec` defaults to 300, clamped to 1800.
- `round` defaults to 1. Follow-up rounds (after seeing results) use 2, 3, …;
  the maximum is `1 + verify.maxFollowUpRounds` (default 1 → max round 2).

Each step's approval binds to `stepSha256` = SHA-256 of the step's canonical
JSON (sorted keys, includes `files[].content`). Editing any field, including the
purpose or a file's content, changes the hash, and the old approval no longer
matches (`stale` → `skipped_unapproved`). Approval is per step so appending a
follow-up round does not void round-1 approvals, while the new steps need their
own decision. A human rejection is fail-closed: if the rejected step is later
edited, it becomes `stale` and is skipped, even when its argv is whitelisted.
The record also stores the `planSha256` it was made for, for audit.

## Standing whitelist: `.pi-review.json`

```json
{
  "verify": {
    "commands": [{ "id": "check", "argv": ["npm", "run", "check"], "timeoutSec": 600 }],
    "link": ["node_modules"],
    "maxFollowUpRounds": 1
  }
}
```

- Read with `git show HEAD:.pi-review.json`: uncommitted edits to the file never
  grant pre-approval. A diff under review cannot whitelist its own commands.
- Pre-approval covers the whitelisted `argv` **and** its timeout budget: a plan
  step with the same argv is pre-approved only when it has no `files`/`cwd` and
  its `timeoutSec` is absent (it then inherits the whitelist value) or not larger.
- `link`: ignored paths (typically dependency dirs) symlinked from the original
  tree into the copy so commands work without a reinstall. Writes through a
  link land in the original (ignored) directory; keep it to dependency caches.
- `--verify` without a plan runs exactly these commands, all pre-approved,
  except ids a human explicitly rejected in a passed approval record.
- The file is validated strictly: `verify` must be an object with only
  `commands`, `link`, `maxFollowUpRounds`; a typo such as `links` is an error
  (reported as `unverified` with the reason), never silently ignored.

## Isolation

| Option | Includes uncommitted + untracked | Has `.git` (tools that call git work) | Cost | Leaves state |
|---|---|---|---|---|
| **Snapshot commit + `git worktree add --detach`** (chosen) | yes | yes | object writes + checkout | worktree registry entry, removed + pruned in `finally` |
| `git worktree add HEAD` + `git diff \| git apply` + copy untracked | yes, fragile for binary/renames | yes | similar | same |
| `git archive \| tar -x` / `cp -r` | archive: no; cp: yes incl. junk | no / yes (shared index risk) | cp is slow on big trees | none |

Snapshot: `GIT_INDEX_FILE=<tmp> git read-tree HEAD && git add -A && git write-tree`,
then `git commit-tree -p HEAD`. This uses a throwaway index, so the real index,
working tree, and stash stack are untouched; it honours `.gitignore`. The
worktree is added with `core.hooksPath=/dev/null` so repo `post-checkout` hooks
do not run. After all steps: `git worktree remove --force`, `git worktree prune`,
delete temp dirs.

Guard: `git status --porcelain=v1 -z --untracked-files=all` of the original
tree is captured before and after. A difference marks the whole summary
`unverified` with reason `original working tree changed during verification`
and `treeUnchanged: false`. Coverage limits: the copy is a linked worktree that
shares refs and objects, so a step running `git tag` / `git update-ref` in the
copy, writes through `link`ed (ignored) directories, and any other ignored path
are outside the guard. `treeUnchanged: true` means "tracked and untracked
files of the original tree are as before", nothing stronger. A concurrent
editor writing to the tree during a long step also trips the guard (fail-closed).

## Execution and safety defaults

- Sequential, once per review run, before any reviewer starts; one summary is
  shared by every reviewer (single and panel). No per-reviewer execution.
- `spawn(argv[0], argv.slice(1), { shell: false, detached: true, stdin: ignore })`;
  on timeout SIGTERM the process group, SIGKILL after 2s; the group is also
  killed after normal exit so stray daemons do not outlive the step. If a
  descendant escaped the group (`setsid`) and keeps the output pipes open,
  pi-review stops reading 2s after the step's own exit (or 4s after the
  timeout) and records the step's real exit status plus a `note` that output
  may be incomplete; the note never turns a passing step into an error.
  Without process groups (Windows) the child itself is signalled.
- Output: stdout+stderr interleaved, only the last 4000 characters kept
  (`truncated` flag), passed through the same secret redaction as review events.
- Environment: allowlist only — `PATH HOME USER LOGNAME SHELL LANG LC_ALL
  LC_CTYPE TERM TMPDIR TZ` — plus `CI=1` and `PI_REVIEW_VERIFY=1`. Any name
  matching `KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH` is dropped even if
  allowlisted. Provider keys therefore never reach verification commands.
- A failing command is evidence, not a pi-review failure. The review exit code
  is still decided by the reviewers.
- Setup failures (not a git repo, no `HEAD`, worktree add failed, invalid plan
  file) degrade to `status: "unverified"` with `reason`, printed to stderr and
  injected into the prompt. `runVerification` never throws: an internal error
  becomes `unverified`, a failing step becomes `status: "error"`, and cleanup is
  best effort. Never silently clean.

## Summary, statuses, prompt, meta

Step status: `passed | failed | timed_out | error | skipped_unapproved | skipped_rejected`.
Step approval: `preapproved | approved | rejected | unapproved | stale`.

Overall status:

| Status | When |
|---|---|
| `unverified` | no command executed (no plan and no whitelist, all skipped, setup error) or the tree guard tripped |
| `failed` | any executed step failed, timed out, or errored |
| `partial` | every executed step passed, some steps did not run |
| `passed` | every step ran and passed |

"Executed" means the command was spawned (the step has `durationMs`). A step
whose setup failed before spawning (isolation failure, a repro file that would
escape the copy) has `status: "error"` without `durationMs`, is rendered as
`Result: not run`, and never counts as a run.

Prompt: one extra section appended after the target sections, identical for
every reviewer. It states the source type `test-output`, that commands ran once
in an isolated copy, which steps were human-approved vs whitelist pre-approved,
per-step exit/duration/timeout, and the redacted output tail inside
`<test-output step="id">` tags marked as untrusted data. Plan-controlled
metadata is rendered on one line (argv as a JSON array; newlines in purpose,
cwd, paths, and errors flattened; purpose capped at 1000 characters) so a plan
cannot open a fake heading or instruction block in the reviewer prompt. Reviewers are told to
cite `test-output <step id>` in `Evidence:` and never to claim verification
beyond the listed steps. For `unverified`, the section says so with the reason.

Meta: optional `verification` field on `ReviewMeta` (single and panel). Additive
within `REVIEW_META_VERSION = 1`: no bump, matching the rule in `src/types.ts`
that optional additions do not change the version; consumers that ignore unknown
keys are unaffected, and absence means verification was off. The ASCII footer
gains a `Verify` line only when the field is present.

## Integration points

- `runReviewOnce` (single) and `runPanelReviewOnce` (panel): when verification
  is on, run it after argument/config validation and before spawning
  reviewers; append the section to each prompt; attach `verification` to meta.
- `loop`: each round calls those functions, so each round re-reads the plan and
  approvals and re-runs verification against the current tree. No cache.
- Iteration: the host may run `pi-review verify run` to see results, append a
  `round: 2` step (for example a minimal repro under `files`), and repeat the
  show → ask → approve handshake. Plans beyond the round cap are rejected.
- `screen`, `classify`, `models`, install commands: unchanged.

## Threat model

Trust boundary: `--verify` executes code from the repository on this machine
with the user's privileges. The isolated copy protects the working tree from
accidental edits; it does **not** contain a malicious command (it can read
`~/.ssh`, reach the network, write outside the copy).

| Threat | Mitigation |
|---|---|
| Diff under review adds a whitelist entry to self-approve | Whitelist read from `HEAD`, not the working tree. |
| Malicious committed whitelist on an untrusted branch | Opt-in only; docs: do not use `--verify` on checkouts you would not run `npm test` on. `verify show` prints every command before anything runs. |
| LLM proposer smuggles a dangerous command | Proposer output is a plan; every non-whitelisted step needs a human approval bound to its exact content. |
| Plan edited after approval | Per-step hashes; changed steps are `stale` and skipped. |
| Secrets leaked to commands or into prompts | Env allowlist + secret-name deny; output tails redacted before prompt/meta. |
| Prompt injection via test output | Output wrapped in tagged blocks declared as untrusted data. |
| Command mutates the original tree | Runs in the copy; `git status` guard downgrades to `unverified` if the tree changed. |
| Runaway / hanging command | Per-step timeout with process-group kill; bounded output. |
| Repo git hooks run during worktree checkout | `core.hooksPath=/dev/null` on `worktree add`. |

## Follow-ups

- Remove a step's `files` after it runs (today they persist for later steps in the same run).
- Skip the post-exit process-group kill once the group is known to be empty (pid-reuse window).
- Widen the tree guard to refs (`git for-each-ref`) and report ignored-path writes through `link`.
- Suggest whitelist candidates from `package.json` scripts / CI config (still require approval).
- `/rv` Pi panel: native confirm dialog for the handshake and a verification row in the dashboard.
- `verify.passEnv` for non-secret toolchain variables (e.g. `JAVA_HOME`).
- Review-event types (`verification.started/completed`) for the web dashboard and pane.
- Optional OS sandbox (sandbox-exec / bubblewrap) for the commands themselves.
