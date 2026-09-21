# Loop Review

`pi-review loop` runs a bounded sequence of full, isolated review runs against the current working tree:

```bash
pi-review loop --max-rounds 3 -- @src
pi-review loop --until clean --max-rounds 10 -- @src
pi-review loop --mode challenge --max-rounds 2 -- @docs/design.md
```

Each round is review-only. The process never edits, patches, waits for filesystem changes, or asks the child session to fix findings. It stops immediately on `clean`, `needs_human`, or `blocked`; otherwise it stops when the round budget is exhausted. Every round emits one `PI_REVIEW_META_JSON` line in order, and the final human summary lists each round's status, verdict, duration, and finding counts.

Each round's `PI_REVIEW_META_JSON` line is the same enriched schema documented under [Machine finding schema](output-and-integration.md#machine-finding-schema) — `metaVersion`, per-finding `details`/`recommendation`/`location`, and (for panel rounds) `sourceFindings`. A consumer that wants enriched findings for a given round reads that round's stderr line directly, in emission order; no Markdown scraping and no change to `LoopRoundSummary` are needed.

This is a **host-driven gate**: if findings remain, the host or human fixes only accepted in-scope findings and invokes `loop` again. For patch-by-patch agent closeout, `--max-rounds 1` gives the host a fix point after each review. For an explicit clean goal with a hard ceiling, use `--until clean` (default budget 10 when `--max-rounds` is omitted; never unlimited). Clean means no gate-blocking findings (single: no actionable findings; panel: no confirmed actionable clusters; advisories may remain). `loop` accepts normal review target/model/progress options but rejects `--keep-session`, `--continue`, and `--name` in v1.

**Cross-round comparison.** From round 2 onward each round is diffed against the previous round's actionable findings (`vs prev: =persisting · +new · -resolved` in the loop summary). Matching is deterministic first; with the Jev enhancement enabled, wording-drift pairs are adjudicated by Jev just like panel consensus. The comparison is advisory bookkeeping, never gate input, and a matcher failure degrades silently to no comparison. Under `--until clean`, when two consecutive rounds produce an identical actionable set (all persisting, nothing added or resolved), the loop stops early with `Stop: non_converging` — the tree does not change between rounds, so further rounds are dice rolls and the host should fix and re-invoke.

