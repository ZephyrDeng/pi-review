# Output format and integration

Every review produces Markdown with these sections:

```
## Verdict
approve | request_changes | needs_clarification | blocked

## Summary
## Findings
### F1: <summary>
- Severity: critical | high | medium | low
- Path: <path or none>
- Lines: <line or line-range in Path, or none>
- Side: base | working (optional; defaults to working)
- Actionable: yes | no
- Evidence: <concrete evidence>
- Impact: <why it matters>
- Recommendation: <specific next step>

## Risks and Blind Spots
## Open Questions
```

The CLI appends a readable ASCII footer on **stdout**:

```
── pi-review ────────────────────────────
  Verdict     ! REQUEST CHANGES
  Status      HAS FINDINGS
  Mode        code
  Findings    1 actionable / 1 total
  Model       provider/model
  Thinking    xhigh
  Tokens      in 17.6K · out 512 · cache 2.0K · reason 0 · total 18.2K
  Cost        $0.05
  Duration    42.3s
──────────────────────────────────────────
```

`Thinking` shows the requested thinking level when set; `Tokens` shows the child session's token usage (`in`/`out`/`cache`/`reason` plus total) parsed from the `--mode json` event stream. `Cost` shows the provider-reported total, or `n/a` when the provider does not report one. Both are collected during normal streaming; `--progress-log` is not required.

For scripts, parse **`PI_REVIEW_META_JSON:`** from **stderr**. Existing keys remain, with additive fields:

```json
{"metaVersion":1,"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed","status":"has_findings","findings":[{"id":"F1","severity":"high","path":"src/cli.ts","summary":"Dirty reviews exit zero","actionable":true}],"actionableCount":1,"durationMs":42300,"model":"provider/model","thinking":"xhigh","usage":{"input":18031,"output":512,"cacheRead":2048,"cacheWrite":0,"reasoning":0,"totalTokens":18591,"costTotal":0.05}}
```

`status` is one of `clean`, `has_findings`, `needs_human`, or `blocked`: `approve` with no actionable findings is `clean`; `request_changes` or actionable findings are `has_findings`; `needs_clarification` is `needs_human`; runtime/fatal failures are `blocked`. Each finding always has `summary` and `actionable`; `id`, `severity`, and `path` are present when parsed. `thinking` and `usage` are additive and present when reported by the child; `usage` includes token totals and may include `costTotal`. The line remains a single additive JSON record, so older consumers can ignore unknown keys. Set `PI_REVIEW_META_STDOUT=1` to emit it on stdout instead.

### Machine finding schema

`PI_REVIEW_META_JSON` carries a top-level `metaVersion` schema discriminator (currently `1`). JSON emitted by pi-review versions before this field existed has no `metaVersion` key at all — treat that absence as the original, pre-enrichment contract. Every field below is additive under `metaVersion: 1`; a future breaking change to this shape would bump it.

Each finding gains three optional fields alongside the existing `{ id?, severity?, path?, summary, actionable }` shape:

| Field | Type | Present when |
|-------|------|--------------|
| `details` | `string` | At least one of the reviewer's Evidence/Impact fields parsed. Joins them as `"Evidence: <...>"` and/or `"Impact: <...>"` paragraphs separated by a blank line (`\n\n`); a finding with only one of the two carries only that labeled paragraph. Never fabricated. |
| `recommendation` | `string` | The reviewer's Recommendation field parsed, verbatim and kept separate from `details`. |
| `location` | `{ startLine: number; endLine?: number; side?: "base" \| "working" }` | The reviewer's `Lines` field held one positive integer (`42`) or a non-inverted positive range (`42-58`). Non-numeric, zero/negative, or inverted (`endLine < startLine`) values are dropped rather than guessed, so `location` is simply absent. `side` is only ever `"base"` (before the change); every other case — absent, unrecognized, or explicitly `"working"` — omits `side`, which means `"working"` (after the change). |

Example with all three populated:

```json
{"metaVersion":1,"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed","status":"has_findings","findings":[{"id":"F1","severity":"high","path":"src/cli.ts","summary":"Dirty reviews exit zero","actionable":true,"details":"Evidence: runReview forwards the child exit code.\n\nImpact: A review gate passes with actionable findings.","recommendation":"Map structured status to a stable exit code.","location":{"startLine":42,"endLine":58}}],"actionableCount":1,"durationMs":42300,"model":"provider/model"}
```

All three finding-level fields and `metaVersion` are additive: existing consumers reading only `{ id?, severity?, path?, summary, actionable }` are unaffected, and a file-level finding with no reliable line data simply omits `location` while `details`/`recommendation` still populate when Evidence/Impact/Recommendation parsed. This machine schema — including the panel `sourceFindings` fields documented under [Panel Review § Machine output](panel-review.md#machine-output) and the per-round stream documented under [Loop Review](loop-review.md) — is a **supported integration surface**: renderers should read `PI_REVIEW_META_JSON` directly and never need to scrape review Markdown for Evidence/Impact/Recommendation/line data.

The parser prefers the exact `### F1` shape above but also accepts legacy `###` headings and top-level finding lists. When `Actionable` is missing, findings under `request_changes` default to actionable and other verdicts default to non-actionable. A missing/unrecognized verdict falls back to `needs_clarification` / `needs_human` and includes `parseError`; runtime failures always remain `blocked`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Final status is `clean` |
| `1` | Final status is `has_findings` / loop budget exhausted |
| `2` | CLI usage or argument error |
| `3` | `needs_human` — clarification or a decision is required |
| `4` | `blocked` — child/runtime failure or review cannot proceed |

## Session Management

```bash
# Keep a review session for follow-up
pi-review --mode challenge --keep-session -- @docs/design.md

# Continue a previous session (same optional flags as an initial run)
pi-review --continue <sessionHandle> --mode challenge --model provider/model -- "expand finding 2"
```

## Live Progress and Token Usage

`pi-review` always runs the child in `--mode json` internally. In streaming mode it forwards **readable text deltas** to stdout live and writes **semantic milestone notices** to stderr — `pi-review: review started`, `pi-review: tool <name> started/finished`, `pi-review: review finished`. Token usage (`input`/`output`/`cache`/`reasoning`) is accumulated by default and shown in the ASCII footer and `PI_REVIEW_META_JSON` — **no `--progress-log` required**.

Agent hosts like Claude Code, Cursor, Codex, and agy typically buffer a Bash tool's stdout until the command exits. The stderr milestone notices give you progress signals without tailing a file. The final Markdown review + ASCII footer arrive on stdout when the process exits.

`--progress-log <path>` is now an **optional** convenience for fine-grained debugging: it tees the `--mode json` event stream to a file. By default the tee is **slimmed** — each `message_update` line reduces its cumulative message snapshots (`assistantMessageEvent.partial` and the duplicate top-level `message`) to their `usage` field. A verbatim tee repeats the entire message-so-far plus provider metadata on every delta, growing the file quadratically with message length (real reviews measured a ~1600x byte amplification). Deltas and message boundaries (`message_end`, `turn_end`, `agent_end`) keep the complete record, so the slimmed log still reconstructs the review and replays through pi-review's own event parser with no feature loss. Add `--progress-log-raw` when you need the verbatim stream. `--progress-log` no longer gates token visibility. Details: [`skills/pi-review/SKILL.md`](../../skills/pi-review/SKILL.md) and [`skills/pi-review/references/codex-tools.md`](../../skills/pi-review/references/codex-tools.md).

```bash
# Optional: capture the event log for debugging (slimmed by default; add --progress-log-raw for verbatim)
pi-review --progress-log /tmp/pi-review.jsonl -- @src/foo.ts &
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```

The JSON event schema is pi CLI's own internal format, not a contract `pi-review` guarantees — it may change between pi versions. `pi-review` parses it defensively (unparseable lines are skipped, missing events degrade to a diagnostic `parseError`) and still prints the same clean Markdown + ASCII footer to stdout once the child exits.

