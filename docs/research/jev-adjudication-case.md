# Jev adjudication comparison case

Date: 2026-09-20

> **Update (same day, later):** the measured false-merge chains are fixed in
> shipped code — `src/matcher.ts` now uses complete-linkage clustering
> (variant V2 below: clusters merge only when every cross-cluster pair
> reaches the threshold), covering both Jev pairwise merges and Pi multi-id
> merges. Offline replay of the frozen cases through the fixed matcher:
> precision 1.00 / 0 false merges on both (recall 0.64 / 0.79). The V0
> union-find numbers below describe the pre-fix behavior that motivated the
> change; the live matrix was captured before the fix.

## Question

The Jev enhancement changes two decisions in `pi-review`:

- **Panel consensus adjudication** — which same-path findings from different
  reviewers describe the same underlying issue (`createJevAdjudicator`, with
  the 0.3–0.7 borderline cascade to the Pi adjudicator).
- **Loop cross-round comparison** — whether a finding reported in round N also
  appears in round N+1 despite wording drift (`loopMatcher`).

This case measures both, across single-round / multi-round loops and
single-reviewer / 3-reviewer panels, on one frozen fixture and one model
(`opencode-go/deepseek-v4.1-flash`, the `code` preset's `high` thinking level).

## TL;DR

- **Single review, single round: Jev is a no-op.** No panel adjudication and
  no cross-round comparison run, so both arms behave identically; the measured
  deltas are model sampling noise.
- **Multi-round: the cross-round comparison is the clearest Jev effect.**
  Deterministic matching counted 1 of ~10 actionable findings as persisting
  across rounds; Jev counted 5–6. Reviewers reword the same issue every round,
  so without semantic matching almost every finding reads as "added" +
  "resolved" — the signal the `--until clean` non-convergence stop depends on.
- **3-reviewer panel: adjudication is what makes the gate meaningful.**
  Replayed through deterministic matching only, the same frozen findings
  produced **0 confirmed clusters / status clean** — three reviewers reporting
  the same real defects did not corroborate each other. Both engines keep the
  gate at `has_findings`; the difference is shape and cost.
- **On identical frozen input** (33–35 findings, 528–561 candidate pairs, 3 Pi
  runs per case): Jev answered in **1.9–2.2 s** per call, the Pi adjudicator in
  **15–61 s**. Scored pair-by-pair against hand-assigned ground truth, Jev's
  merges had precision **0.72–0.75** / recall **0.72–0.79**; Pi's had precision
  **0.93–1.00** / recall **0.69–0.82**. Jev merged 9–11 pairs of *different*
  fixture defects that Pi left separate; both engines missed some true pairs.
- **The shipped cascade** (Jev + borderline escalation) removed all 9 Jev
  false merges in frozen case B and none of the 11 in case A: the wrong chain
  edge scored 0.66 in B, inside the 0.3–0.7 band, and Pi's second opinion
  rejected it; in A it scored 0.75, above the band, and was never re-judged.
  The extra call cost 12–95 s in these runs.
- **Caveats**: Jev's pairwise union-find chains distinct findings that Pi's
  one-shot clustering keeps apart; `usage` in `PI_REVIEW_META_JSON` excludes
  adjudication on both arms (reviewers only), so in-table cost deltas are not
  engine cost.
- **Accuracy is improvable without a bigger model.** Raising the merge
  threshold, replacing union-find with complete-linkage, or re-asking the pair
  question as a 3-way Choice each removes the false-merge chains in the frozen
  cases; per-finding bucket assignment (also a Choice) removes them by
  construction at a quarter of the tokens. See
  [Improving adjudication accuracy](#improving-adjudication-accuracy).

## Case fixture

[`order-service.ts`](#appendix-fixture) is a 106-line, self-contained service
with five planted defects that reviewers reliably find:

| # | Defect | Location |
|---|--------|----------|
| F1 | Off-by-one loop bound (`i <= items.length`) makes `placeOrder` always throw | `placeOrder` |
| F2 | `db.query("INSERT …")` is not awaited — fire-and-forget persistence | `placeOrder` |
| F3 | SQL injection via string interpolation | `listForCustomer` |
| F4 | `slice(start, end - 1)` drops the last item of every page | `listPage` |
| F5 | Float money accumulation plus `total === 100.0` early return | `lifetimeValue` |

Incidental findings the fixture also exposes (cache aliasing, no input
validation, line items never persisted, no `created_at` write) are counted as
reviewer output too, but the comparison does not depend on them.

The fixture and results are not committed elsewhere; the appendix is the
exact source used for every number below. All runs used a scratch cwd
containing only this file.

## Method

### End-to-end matrix

Eight runs: `{single review, 3-reviewer panel} × {1 round, 2-round loop} ×
{PI_REVIEW_JEV=1, PI_REVIEW_JEV=0}`, one documented run per cell, on
`opencode-go/deepseek-v4.1-flash`:

```bash
export TYPESAFE_API_KEY=...            # Jev model defaults to jev-latest
PI_REVIEW_JEV=1 pi-review --model opencode-go/deepseek-v4.1-flash -- @order-service.ts
PI_REVIEW_JEV=0 pi-review --model opencode-go/deepseek-v4.1-flash -- @order-service.ts
PI_REVIEW_JEV=1 pi-review loop --max-rounds 2 --model opencode-go/deepseek-v4.1-flash -- @order-service.ts
PI_REVIEW_JEV=1 pi-review --reviewers 3 --model opencode-go/deepseek-v4.1-flash -- @order-service.ts
PI_REVIEW_JEV=1 pi-review loop --reviewers 3 --max-rounds 2 --model opencode-go/deepseek-v4.1-flash -- @order-service.ts
```

The 3-reviewer runs use anonymous `--reviewers 3` (default consensus: quorum,
`min-agree 2`), so each run draws different reviewer personas — intentional
for realism, but it means live `off`/`on` deltas mix engine behavior with
reviewer sampling. `PI_REVIEW_META_JSON` on stderr yields per-round machine
results; the loop ASCII summary yields the cross-round `vs prev` line.

### Controlled replay

To separate engine behavior from reviewer sampling, one panel run's reviewer
submissions are frozen and re-clustered through every engine with the repo's
pure aggregation seam:

```js
aggregatePanel({
  reviewers: frozenSubmissions,        // same findings, same order
  policy: "quorum", minAgree: 2, configuredReviewers: 3,
  matcher,                             // one of the four engines below
});
```

The four matchers are `DeterministicMatcher`, `SemanticMatcher(jev)`,
`SemanticMatcher(piAdjudicator)`, and
`SemanticMatcher(withUncertaintyEscalation(jev, pi))`. The Pi adjudicator
replicates `createAdjudicator` exactly (one `pi -p --no-session --no-tools`
child with the JSON-only system prompt and the same `--model`), and the
harness asserts that Jev and Pi received byte-identical candidate requests.
Pi is sampled 3 times per case because it is nondeterministic. The pure-Jev
arm and the cascade share one memoized Jev response, so both are scored
against the same probabilities and the cascade differs only by its Pi
escalation call. The
deterministic-only row is a baseline lens, not a shipped panel configuration —
with Jev off the shipped panel runs the Pi adjudicator.

## Results

### End-to-end matrix

`R1`/`R2` are loop rounds. `engine` is `adjudicationEngine` from the panel
meta. Duration/tokens/cost are the whole round (adjudication included in the
duration; tokens and cost are reviewer-only).

| Config | Jev | R1 | R2 | Cross-round (`vs prev`) |
|--------|-----|----|----|-------------------------|
| single review, 1 round | off | has_findings, 11 actionable, 53 s, 81.7 K tok, $0.0063 | — | — |
| single review, 1 round | on | has_findings, 9 actionable, 38 s, 59.6 K tok, $0.0057 | — | — |
| single review, 2 rounds | off | 11 actionable, 35 s | 11 actionable, 33 s | =1 persisting · +10 new · -10 resolved |
| single review, 2 rounds | on | 10 actionable, 35 s | 9 actionable, 37 s | **=6 persisting · +3 new · -4 resolved** |
| panel 3, 1 round | off | 10 confirmed / 6 advisory, engine `pi`, 133 s, 191.8 K tok, $0.0240 | — | — |
| panel 3, 1 round | on | 10 confirmed / 4 advisory, engine `jev`, 96 s, 138.4 K tok, $0.0172, escalated 9 pairs | — | — |
| panel 3, 2 rounds | off | 8 / 4, `pi`, 82 s | 11 / 2, `pi`, 72 s | =1 persisting · +10 new · -7 resolved |
| panel 3, 2 rounds | on | 9 / 4, `jev`, 86 s, escalated 13 pairs | 8 / 4, `jev`, 69 s, escalated 6 pairs | **=5 persisting · +3 new · -3 resolved** |

Every cell gates `has_findings`; no arm produced a different gate outcome. The
live panel confirmed counts (8–11) and cluster sizes vary in both directions
because each arm drew different reviewers, which is what the replay below
removes.

### Controlled replay

Frozen from the two `panel 3, 1 round` runs above (35 and 33 source findings,
all three reviewers contributing). `Cluster sizes` lists confirmed clusters
largest-first; `adjudication` is wall time for one engine call on identical
candidates.

**Case A — 35 findings, 561 candidate pairs** (frozen from the `jev off` run):

| Engine | Status | Confirmed | Advisories | Cluster sizes | Adjudication |
|--------|--------|-----------|------------|---------------|--------------|
| deterministic only | clean | 0 | 35 | — | — |
| Jev (pure) | has_findings | 9 | 5 | 6,4,3,3,3,3,3,2,2 | **2.2 s** |
| Pi run 1 | has_findings | 10 | 6 | 3,3,3,3,3,3,3,3,2,2 | 17.8 s |
| Pi run 2 | has_findings | 9 | 7 | 4,3,3,3,3,3,3,3,2 | 61.4 s |
| Pi run 3 | has_findings | 10 | 6 | 3,3,3,3,3,3,3,3,2,2 | 16.8 s |
| Jev + escalation | has_findings | 9 | 4 | 6,4,3,3,3,3,3,3,2 | 2.2 s + 94.8 s (9 pairs) |

**Case B — 33 findings, 528 candidate pairs** (frozen from the `jev on` run):

| Engine | Status | Confirmed | Advisories | Cluster sizes | Adjudication |
|--------|--------|-----------|------------|---------------|--------------|
| deterministic only | clean | 0 | 33 | — | — |
| Jev (pure) | has_findings | 9 | 4 | 6,3,3,3,3,3,3,2,2 | **1.9 s** |
| Pi run 1 | has_findings | 10 | 4 | 3,3,3,3,3,3,3,3,2,2 | 15.1 s |
| Pi run 2 | has_findings | 11 | 2 | 3,3,3,3,3,3,3,3,2,2,2 | 17.5 s |
| Pi run 3 | has_findings | 11 | 2 | 3,3,3,3,3,3,3,3,2,2,2 | 30.1 s |
| Jev + escalation | has_findings | 11 | 2 | 3,3,3,3,3,3,3,3,2,2,2 | 1.9 s + 11.9 s (8 pairs) |

### Quality comparison

Every source finding in the two frozen cases was hand-labeled with the fixture
issue(s) it reports: `loop`, `sqli`, `await`, `page`, `early`, `float`,
`persist`, `cache`, `alias`, `validate`, `txn`, `idem`, `tests`, `mailaddr`,
`async`. Two findings describe the same issue iff their label sets intersect;
a pair is *merged* iff both findings land in the same final cluster (confirmed
or advisory). Case A has 595 pairs (39 same-issue), case B 528 (34 same-issue).

| Case | Engine | Merged pairs | Correct | False | Missed | Precision | Recall | F1 |
|------|--------|--------------|---------|-------|--------|-----------|--------|----|
| A (35 findings) | Jev | 39 | 28 | 11 | 11 | 0.72 | 0.72 | 0.72 |
| A | Pi (3 runs) | 27–29 | 27 | 0–2 | 12 | 0.93–1.00 | 0.69 | 0.79–0.82 |
| A | Jev + escalation | 41 | 29 | 12 | 10 | 0.71 | 0.74 | 0.73 |
| B (33 findings) | Jev | 36 | 27 | 9 | 7 | 0.75 | 0.79 | 0.77 |
| B | Pi (3 runs) | 27–28 | 27–28 | 0 | 6–7 | 1.00 | 0.79–0.82 | 0.89–0.90 |
| B | Jev + escalation | 28 | 28 | 0 | 6 | 1.00 | 0.82 | 0.90 |

All 9–11 of Jev's false merges are union-find chains between **different
defects in the same method**: loop-bound ↔ missing-await in `placeOrder`
(case A; 9 of 11, the other 2 were money ↔ validation) and loop-bound ↔
pagination in `listPage` (case B; all 9). The connector matters more than the
individual pairs. In case A one loop ↔ await pair scored **0.75** — above the
0.6 merge floor *and* above the 0.3–0.7 escalation band — so it was never
re-judged and the cascade kept the 11-pair chain (plus one transitive
`txn ↔ idem` pair, 12 false merges total). In case B the connector scored
0.66, inside the band; Pi's second opinion rejected it and the chain broke,
leaving zero false merges. Restricting the metric to cross-reviewer pairs, the
ones that can manufacture consensus, Jev's precision rises to 0.80 (A) / 0.82
(B) and Pi stays at 0.96–1.00; the confirmed-cluster effect is unchanged.
Pi's merges were 0–2 wrong across six runs (both in one run: money ↔
validation), so pure Pi's lower recall (more advisories) is the conservative
direction; pure Jev trades that for 9–11 wrong merges that can confirm a
cluster under the wrong issue identity.

### Latency comparison

Adjudication stage on **identical input** (all calls succeeded on the first
attempt in this run set; wall time includes Pi child startup):

| Case | Pairs in request | Jev | Pi (3 runs) | Escalation call |
|------|------------------|-----|-------------|-----------------|
| A | 561 | 2.2 s | 16.8 / 17.8 / 61.4 s | 94.8 s (9 pairs) |
| B | 528 | 1.9 s | 15.1 / 17.5 / 30.1 s | 11.9 s (8 pairs) |

Provider latency dominates: an earlier, otherwise identical sample measured Pi
at 14–72 s and escalation at 16–87 s for the same requests.

Live panel rounds, where reviewer generation and adjudication overlap in one
wall clock: `total = slowest reviewer + adjudication + aggregation/process
overhead`, so the last column is the derived adjudication cost a user pays.
Reviewer durations differ between arms (different samples), which is why the
total column is not a controlled engine delta.

| Round | Engine | Round total | Slowest reviewer | Derived adjudication + overhead |
|-------|--------|-------------|------------------|---------------------------------|
| panel 3, 1 round, off | pi | 133 s | 78 s | 55 s |
| panel 3, 1 round, on | jev (+ escalation) | 96 s | 69 s | 27 s |
| panel 3, round 1, off | pi | 82 s | 55 s | 27 s |
| panel 3, round 2, off | pi | 72 s | 49 s | 23 s |
| panel 3, round 1, on | jev (+ escalation) | 86 s | 64 s | 22 s |
| panel 3, round 2, on | jev (+ escalation) | 69 s | 50 s | 18 s |

Single-review rounds have no adjudication stage at all and ran 32–53 s each on
this fixture. The controlled adjudication delta is the big one: Jev cuts the
adjudication stage by roughly 6–25x, and the cascade's second call only fires
when borderline pairs exist.

## Observations

1. **Adjudication, not the engine choice, is what turns repetition into
   corroboration.** On both frozen cases the deterministic baseline confirmed
   nothing (status `clean`) even though all three reviewers found the same
   defects. Any semantic adjudicator fixes that; Jev's value is doing it in
   seconds and off the reviewer provider.
2. **Engines disagree on cluster shape and merge precision.** Confirmed counts
   were 9–10 (Pi) vs 9 (Jev) on case A and 10–11 (Pi) vs 9 (Jev) on case B
   (escalation moved case B to 11). Jev merges more aggressively per cluster
   (largest 6 vs Pi's 3) and leaves fewer advisories, but 9–11 of its merges
   join *different* fixture defects; Pi's merges were 0–2 wrong in six runs.
   Pair-level precision/recall is in
   [Quality comparison](#quality-comparison).
3. **Cross-round comparison is where the arms differ most.** With
   deterministic-only matching, wording drift makes a stable result set look
   like `1 persisting / 10 added / 10 resolved`; with Jev it reads
   `6 persisting / 3 added / 4 resolved`. The `--until clean`
   `non_converging` stop keys on an identical actionable set across two
   rounds, so it is far more reachable with Jev than without.
4. **Cost and latency.** Jev's typed call is 1.9–2.2 s and does not consume
   reviewer-provider quota; the Pi adjudicator is another full LLM child on
   the same provider, measured at 15–61 s per call here (14–72 s across two
   samples). In exploratory runs on a different provider
   (`commandcode/deepseek-v4.1-flash`) several Pi adjudicator calls failed
   outright with `429 rate_limit_error` while Jev calls succeeded, and the
   shipped cascade kept Jev's merges when the escalation call failed. No
   adjudicator failures occurred in the documented `opencode-go` matrix.
5. **Cascade economics depend on the borderline-pair count.** Escalation fired
   on 6–13 pairs in the live rounds, 8–9 pairs in the replay cases, and cost
   12–95 s. Pairs Jev is confident about never pay it. The cascade fixed every
   Jev false merge in case B but none in case A: the wrong chain edge scored
   0.66 in B (re-judged and rejected) and 0.75 in A (outside the band, never
   re-judged), so the same pipeline behaves differently on the same fixture
   depending on Jev sampling.
6. **Risks.** Jev votes per pair and the matcher unions them, so a chain of
   confident pairwise merges can fold distinct findings into one confirmed
   cluster. On identical frozen input Jev's largest cluster was 6 (Pi: 3),
   and every one of its 9–12 false merges came from such a chain; in a single
   exploratory run on the other provider, Jev produced a 22-source cluster
   that swallowed several distinct issues. Treat cluster size as a
   merge-aggressiveness indicator, not a correctness metric.
7. **Pair count scales quadratically.** All fixture findings sat on one path,
   so a 35-finding panel produced 561 Noul questions in one call. Jev cost and
   latency grow with the square of same-path finding count per panel. The
   Choice endpoint also rejects very large fan-outs: 561 Choice questions in
   one call returned HTTP 400 in this environment (256 worked; the harness
   batches at 128), while 561 Noul questions were accepted.

## Improving adjudication accuracy

### Question-type fit

TypeSafe's question types answer different decision shapes; the shipped
matcher uses Noul for everything it asks Jev:

| Type | What it answers | Fit in pi-review |
|------|-----------------|-------------------|
| Noul | Is this true? (probability of yes) | Independent yes/no gates. Shipping use: pairwise "same issue?" — but the matcher then unions pairs transitively, which is not an independent judgment, and that combination is what produces the false-merge chains. |
| Choice | Which of these options? | Cluster assignment ("which issue does this finding belong to?") and cross-round matching ("which previous-round finding is this?"). `pi-review classify` already uses it this way. |
| Score | Which level? (ordered levels) | Graded judgments — severity levels, or a calibrated confidence ladder in place of the fixed 0.6 merge threshold / 0.3–0.7 escalation band. Not exercised in this case. |

### Variants measured on the same frozen findings

Same reviewer findings, same recorded pair probabilities for the offline
variants; V3/V4 are live Jev calls. P/R/F1 is pair-level against the
hand-assigned ground truth (see [Quality comparison](#quality-comparison)).

| Variant | Case A P / R / F1 | Case B P / R / F1 | False merges A / B | Notes |
|---------|-------------------|-------------------|--------------------|-------|
| V0 shipped: Noul + union-find, τ=0.6 | 0.72 / 0.72 / 0.72 | 0.75 / 0.79 / 0.77 | 11 / 9 | chain edges scored 0.75 (A), 0.66 (B) |
| V1 Noul + union-find, τ=0.7 | 0.72 / 0.72 / 0.72 | 1.00 / 0.79 / 0.89 | 11 / 0 | fixes B only |
| V1 τ=0.8 | 1.00 / 0.56 / 0.72 | 1.00 / 0.77 / 0.87 | 0 / 0 | recall cost |
| V2 Noul + complete-linkage, τ=0.6 | 1.00 / 0.64 / 0.78 | 1.00 / 0.79 / 0.89 | 0 / 0 | merge clusters only when every cross pair ≥ τ — no chaining |
| V3 pairwise 3-way Choice + union-find | 0.93 / 0.72 / 0.81 | 1.00 / 0.79 / 0.89 | 2 / 0 | options: `same_issue` / `same_method_different_defect` / `unrelated`; the middle option absorbs exactly the observed failure class; union-find can still chain |
| V4 Choice bucket assignment | 1.00 / 0.54 / 0.70 | 1.00 / 0.77 / 0.87 | 0 / 0 | draft buckets from Noul τ=0.8, then one Choice per finding ("which issue group?", plus `none`); 34–35 questions instead of 528–561 pairs, 0.3–0.5 s, ~¼ of the tokens; no chaining by construction |

Gate outcomes were unchanged across variants (`has_findings`, 8–11 confirmed
clusters); higher precision mostly moves singletons into advisories. V4's
weakness is structural the other way: it cannot merge two draft buckets that
both describe the same issue, and a draft bucket that conflates two issues
would pass through unchallenged.

### Cross-round comparison is also an assignment problem

The loop's `round-compare` matcher uses the same pairwise Noul formulation.
Replayed on the frozen single-review loop's two rounds (10 previous and 9
current actionable findings, labels known):

| Matcher | persisting | added | resolved | matched-pair precision / recall | Calls |
|---------|-----------|-------|----------|----------------------------------|-------|
| Noul pairwise + union-find (shipped algorithm, fresh sample) | 7 | 2 | 3 | 1.00 / 0.78 | 90 Noul questions, 1.1 s |
| Choice: "which previous-round finding is this?" per current finding | 9 | 0 | 1 | 1.00 / 1.00 | 9 Choice questions, 0.7 s |
| Label-derived ideal | 9 | 0 | 0 | — | — |

The actual shipped loop run of this pair reported `=6 persisting / +3 new /
-4 resolved` (sampling variance against the fresh 7/2/3 sample), and the
Jev-off deterministic arm reported `=1 / +10 / -10`. The Choice formulation
matches the semantics of the question ("did this finding persist?" is a
one-to-one assignment), needs one tenth of the questions, and cannot chain.

## Reproduction

1. Copy the [appendix fixture](#appendix-fixture) to a scratch directory as
   `order-service.ts`.
2. Run any row of the matrix with `TYPESAFE_API_KEY` set and
   `PI_REVIEW_JEV=1` / `PI_REVIEW_JEV=0`.
3. For the controlled replay, rebuild reviewer submissions from a panel meta's
   `reviewers` + `sourceFindings` and call `aggregatePanel` with each matcher
   as shown in [Controlled replay](#controlled-replay); assert candidate
   request hashes match before comparing engines.
4. For the quality numbers, hand-label every frozen source finding with the
   fixture issue(s) it reports, then score every pair: same-issue when label
   sets intersect, merged when both findings land in one cluster (confirmed or
   advisory). Round-level latency is `durationMs` minus the slowest
   reviewer's `durationMs` in the round meta.

## Limitations

- One fixture, one model, one run per matrix cell. Reviewer personas are drawn
  randomly per run, so live off/on deltas include reviewer sampling; the
  replay removes that only for the two frozen cases.
- `PI_REVIEW_META_JSON` `usage` sums reviewer sessions only. Pi-adjudicator
  tokens are not reported and Jev API usage is not carried into the meta, so
  the table's cost column is not a full engine-cost comparison.
- The replay's Pi adjudicator replicates `createAdjudicator`'s invocation and
  JSON extraction, but not its `AbortSignal` wiring; a hung Pi child is killed
  after 120 s and retried up to 4 times (20 s backoff).
- Quality is scored against hand-assigned per-finding labels on one fixture.
  Labels allow multiple values, so a finding covering both float money and
  validation counts as same-issue with either. Pair metrics include
  same-reviewer pairs; cross-reviewer numbers are reported in
  [Quality comparison](#quality-comparison). Both engines missed true pairs
  (Pi 6–12, Jev 7–11), so this is a precision/recall trade-off, not a clean
  winner.
- Repeat samples vary: two replay run sets measured Pi adjudication at
  14–72 s and 15–61 s, and the escalation call at 12–95 s, on identical
  requests. Provider latency, not the engine algorithm, dominates those
  numbers; the Jev-vs-Pi ratio (roughly 6–30x) held in both samples.
- The improvement variants were evaluated on the same two frozen cases and
  one frozen loop pair; V2 (complete-linkage) has since shipped in
  `src/matcher.ts` (see the header note), while V1/V3/V4 remain unshipped
  evidence of headroom, not a cross-fixture guarantee.

## Appendix: fixture

`order-service.ts` (106 lines; only `node:crypto` imported):

```ts
// order-service.ts — small order service used as a review fixture.
// Self-contained: only node stdlib imports, so every defect a reviewer can
// report lives in this file.

import { randomUUID } from "node:crypto";

export interface Order {
  id: string;
  customerId: string;
  items: Array<{ sku: string; quantity: number; unitPrice: number }>;
  total: number;
  status: "pending" | "paid" | "shipped";
}

export interface QueryResult<T> {
  rows: T[];
}

/** Minimal SQL surface; structurally compatible with common drivers. */
export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

export class OrderService {
  private readonly cache = new Map<string, Order>();

  constructor(private readonly db: Database, private readonly mailer: Mailer) {}

  /** Load an order, reusing the in-process cached copy when present. */
  async getOrder(id: string): Promise<Order | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const result = await this.db.query<Order>("SELECT * FROM orders WHERE id = ?", [id]);
    const order = result.rows[0];
    if (order) {
      this.cache.set(id, order);
    }
    return order;
  }

  /** Persist a new order and notify the customer. */
  async placeOrder(customerId: string, items: Order["items"]): Promise<Order> {
    let total = 0;
    for (let i = 0; i <= items.length; i++) {
      total += items[i].quantity * items[i].unitPrice;
    }
    const order: Order = {
      id: randomUUID(),
      customerId,
      items,
      total,
      status: "pending",
    };
    this.db.query("INSERT INTO orders (id, customer_id, total, status) VALUES (?, ?, ?, ?)", [
      order.id,
      order.customerId,
      order.total,
      order.status,
    ]);
    await this.mailer.send(customerId, "Order received", `Order ${order.id}`);
    this.cache.set(order.id, order);
    return order;
  }

  /** All orders for a customer, newest first. */
  async listForCustomer(customerId: string): Promise<Order[]> {
    const result = await this.db.query<Order>(
      `SELECT * FROM orders WHERE customer_id = '${customerId}' ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  /** One page of orders from an already-loaded list. */
  async listPage(items: Order[], page: number, size: number): Promise<Order[]> {
    const start = page * size;
    const end = Math.min(start + size, items.length);
    return items.slice(start, end - 1);
  }

  /** Mark an order shipped and notify the customer. */
  async markShipped(id: string): Promise<void> {
    const order = await this.getOrder(id);
    if (!order) return;
    order.status = "shipped";
    await this.db.query("UPDATE orders SET status = ? WHERE id = ?", ["shipped", id]);
    this.cache.set(id, order);
    await this.mailer.send(order.customerId, "Shipped", `Order ${id} shipped`);
  }

  /** Total amount a customer has ever ordered. */
  async lifetimeValue(customerId: string): Promise<number> {
    const orders = await this.listForCustomer(customerId);
    let total = 0.0;
    for (const order of orders) {
      total += order.total;
      if (total === 100.0) {
        return total;
      }
    }
    return total;
  }
}
```
