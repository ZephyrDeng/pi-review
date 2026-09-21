# Fast screening with `pi-review screen`

`screen` is the fast, gate-grade first pass for changed code. It is designed for pre-commit, pre-push, and the first CI job—not as a replacement for a full review.

```bash
pi-review screen src/order-service.ts
# exit 0: clean
# exit 1: blocking finding
# exit 4: screening could not run (for example, no TYPESAFE_API_KEY)
```

## Workflow

```text
changed files
    │
    ▼
1. deterministic slicing
    │  declaration-sized hunks with stable file and line locations
    ▼
2. typed Jev judgments
    │  one catch-all defect question plus one question per catalog pattern
    ▼
3. local template assembly
    │  probabilities become findings; no generated review prose
    ▼
4. gate result
       clean (0) or findings (1)
```

### 1. Read and slice locally

The command accepts files or `@file` references. Each file is split at recognizable declaration boundaries. The slicer preserves the path and inclusive line range for every hunk; empty files are rejected and large files are capped without dropping their tail.

### 2. Judge each hunk

Jev evaluates every hunk independently in one or more API calls. Each hunk receives:

- a catch-all question for a real correctness, security, or data-loss defect;
- one typed question for each built-in catalog pattern.

The command does not start a Pi child session and does not generate Markdown. Questions are chunked when the request exceeds the API limit.

### 3. Assemble findings deterministically

A probability at or above the screening threshold (`0.6`) produces a finding. Catalog hits use fixed severity, summary, evidence, and recommendation templates. A catch-all hit with no catalog match becomes an **unmatched defect signal**, which still blocks and recommends a full `pi-review` run. This prevents unknown risks from being silently treated as clean.

The shipped catalog covers injection classes (SQL, OS command, XSS, path traversal, hardcoded secrets, weak RNG, ReDoS), correctness classics (off-by-one, `||` defaults, lexicographic sort, mutable default args, ignored errors, bare catches, float money/equality, cache aliasing, missing validation), data-loss (unawaited async, unclosed resources), and serial `await` in loops. Patterns are distilled from community rule sets (Semgrep registry, ESLint/typescript-eslint, SonarSource, CWE Top 25) — all hunk-local yes/no judgments; cross-hunk taint stays with full review.

### 4. Consume the gate

Human output is printed as an ASCII summary. Machine consumers can read `PI_REVIEW_SCREEN_JSON` from stderr; it contains the status, findings, hunk reports, question/call counts, duration, model, and usage.

Use the result to choose the next step:

| Result | Action |
|---|---|
| `clean` / exit `0` | Continue to tests, build, or a deeper review. |
| `has_findings` / exit `1` | Fix the finding, then run screening again. Use full review for an unmatched signal. |
| blocked / exit `4` | Treat screening as unavailable; do not convert it into a pass. Retry with Jev configured or use a full review. |

## Screen memory — the catalog grows from use

Two files under the pi-review state dir (siblings of `config.json`, default `~/.pi/pi-review/`):

- **`screen-patterns.json`** — your own catalog layer. Entries merge over the builtin set; an id matching a builtin overrides it, and a `disabled` list retires entries that misfire on your codebase:

  ```json
  {
    "patterns": {
      "pii_console_log": {
        "title": "console.log prints a sensitive or PII-bearing payload",
        "severity": "major",
        "category": "security",
        "recommendation": "Drop the log or redact fields before printing."
      }
    },
    "disabled": ["missing_validation"]
  }
  ```

  `PI_REVIEW_SCREEN_PATTERNS=<path>` loads one extra file after the machine file and wins id conflicts — point it at a catalog committed to your repo to share patterns with the team. Edits take effect on the next run; invalid entries warn on stderr and are skipped.
- **`screen-memory.jsonl`** — every flagged hunk appends one entry (code hash, verdict, matched patterns). Re-flagged identical code refreshes the stored verdict and bumps a `seen` counter instead of duplicating; the log is capped at 500 entries and written `0600` via tmp+rename. `PI_REVIEW_SCREEN_MEMORY=0` disables recording; `PI_REVIEW_SCREEN_MEMORY_FILE` relocates the log.

`pi-review screen-memory` aggregates the log: per-pattern hit frequencies (which entries earn their keep) and recurring **unmatched signals** grouped by hunk — the promotion candidates for new patterns. Promotion is always your edit to `screen-patterns.json`; screen never rewrites its own catalog.

## Recommended pipeline placement

Run screening only on changed source files, then reserve slower review for work that needs evidence or independent opinions:

```text
pre-commit / CI
      │
      ▼
pi-review screen  ── findings ──► fix and retry
      │ clean
      ▼
unit tests / build
      ▼
pi-review review or panel  (when deeper review is needed)
```

Example shell gate:

```bash
files=$(git diff --name-only --diff-filter=d origin/main...HEAD \
  | grep -E '\.(ts|tsx|js|jsx)$' || true)
[ -z "$files" ] || pi-review screen $files
```

Keep the boundary clear: `screen` is a fast triage gate with deterministic output and typed judgments. It does not inspect repository-wide architecture, explain arbitrary findings, or edit code. Use `review`, `panel`, or `loop` when those capabilities are required.

See [Panel review](panel-review.md) for the deeper review modes and [the screening case study](../research/jev-screening-case.md) for measurements.
