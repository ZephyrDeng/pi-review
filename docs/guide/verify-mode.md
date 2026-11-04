# Verify mode

[中文版](zh-CN/verify-mode.md) · Design: [docs/design/verify-mode.md](../design/verify-mode.md)

`--verify` runs verification commands (tests, type checks, lint, a minimal repro) **once**, in a disposable isolated copy of your working tree, before reviewers start. Every reviewer gets the same results as `test-output` evidence, so findings rest on executed evidence instead of inference. Off by default; without a verify flag nothing changes.

Reviewers stay read-only (`read,grep,find,ls`). Commands are executed by pi-review's own code, never by a model.

## Who decides what runs

| Source | Runs without asking? |
|---|---|
| Standing whitelist: `verify.commands` in `.pi-review.json` **committed at `HEAD`** | Yes (pre-approved). Uncommitted edits to the file are ignored. |
| Verification plan written by the host agent (default) or drafted by `pi-review verify propose` | Only steps a human approved via `pi-review verify approve`. |

Anything else is recorded as `skipped_unapproved` and never runs. In CI there is no human, so only whitelisted commands run.

## Standing whitelist

```json
{
  "verify": {
    "commands": [{ "id": "check", "argv": ["npm", "run", "check"], "timeoutSec": 600 }],
    "link": ["node_modules"],
    "maxFollowUpRounds": 1
  }
}
```

- `argv` runs without a shell. Use `["sh", "-c", "..."]` explicitly when you need one.
- `link` symlinks ignored dependency dirs from your tree into the copy so commands work without reinstalling. Writes through the link land in your real (ignored) directory.
- `maxFollowUpRounds` caps follow-up rounds in plans (default 1 → highest `round` is 2).

```bash
pi-review --verify -- @src            # run the whitelist, then review
pi-review loop --verify -- @src       # re-verify every loop round
```

## Agent-proposed plan with approval

```bash
# 1. Write a plan (host agent), or let a read-only Pi child draft one
pi-review verify propose -- @src "the change under review" > plan.json

# 2. Show it; exit 5 = a human must decide
pi-review verify show plan.json

# 3. After the user decided (host asks with its own question tool)
pi-review verify approve plan.json --steps unit,repro --reject e2e --by "user via AskUserQuestion" > approval.json

# 4. Review with the approved plan
pi-review --verify-plan plan.json --verify-approval approval.json -- @src
```

Plan steps (full schema in the [design doc](../design/verify-mode.md#plan-schema-version-1)):

```json
{
  "version": 1,
  "proposer": "host",
  "steps": [
    {
      "id": "unit-gate",
      "argv": ["npx", "vitest", "run", "src/cli-exit.test.ts"],
      "purpose": "Claim: has_findings maps to exit 1",
      "expectedDurationSec": 20,
      "sideEffects": "none outside the copy",
      "idempotent": true,
      "timeoutSec": 120
    }
  ]
}
```

- `purpose` is required. `expectedDurationSec`, `sideEffects`, `idempotent` are the proposer's self-assessment for the human; they never gate anything.
- `files: [{ "path", "content" }]` adds a new test/repro file **only inside the isolated copy**.
- Approvals bind to each step's content hash. Editing any field of an approved step voids its approval (`stale`, skipped).
- Follow-ups: after `pi-review verify run --plan plan.json --approval approval.json` shows the results, append steps with `"round": 2` and repeat show → ask → approve. `--verify-approval` is repeatable, so round-1 and round-2 approvals combine.

## What reviewers and scripts see

Reviewer prompt: a `## Verification evidence (source type: test-output)` section with each step's command, purpose, approval provenance, exit code, duration, and the last 4000 characters of output (secret-redacted, wrapped as untrusted data). Reviewers cite it as `Evidence: test-output <step id>`.

Footer: `Verify  passed · 2 run / 0 skipped`.

`PI_REVIEW_META_JSON` gains an optional `verification` object (single and panel; `metaVersion` stays `1`):

```json
{"verification":{"source":"test-output","status":"passed","proposer":"host","planSha256":"…","approvals":[{"planSha256":"…","approvedBy":"user via AskUserQuestion","approvedAt":"2026-11-04T08:00:00.000Z"}],"isolation":"git-worktree","treeUnchanged":true,"durationMs":5120,"steps":[{"id":"unit-gate","argv":["npx","vitest","run","src/cli-exit.test.ts"],"purpose":"…","round":1,"origin":"plan","approval":"approved","stepSha256":"…","status":"passed","exitCode":0,"durationMs":4980,"outputTail":"…","truncated":false}]}}
```

| `status` | Meaning |
|---|---|
| `passed` | every step ran and passed |
| `partial` | every executed step passed, some were skipped |
| `failed` | an executed step failed, timed out, or errored |
| `unverified` | nothing ran (see `reason`), or the original tree changed while verifying |

A failing command is evidence, not a pi-review failure; the review exit code still comes from the reviewers. `pi-review verify show` uses exit `5` for "approval required".

## Safety defaults

- Isolation: snapshot of `HEAD` + uncommitted + untracked (non-ignored) files via a throwaway index, checked out with `git worktree add --detach` (hooks disabled), removed afterwards. The original tree's `git status` is compared before/after.
- Per-step timeout (default 300s, max 1800s) kills the whole process group; output is capped.
- Environment allowlist (`PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TERM TMPDIR TZ`, plus `CI=1`); secret-shaped names (`*KEY*`, `*TOKEN*`, `*SECRET*`, …) are dropped.

**Trust boundary:** verification executes repository code on your machine with your privileges. The copy protects your working tree, not your machine. Use `--verify` only on checkouts you would run `npm test` on, and read `pi-review verify show` before approving.
