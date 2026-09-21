# Jev screening case: a gate-grade review in ~1 second

Date: 2026-09-20 · Status: shipped as `pi-review screen`

## Question

Two questions, asked after the
[adjudication case](jev-adjudication-case.md) showed Jev already compresses
panel adjudication to ~2 s:

1. Can a **complete review** be compressed below 10 s end to end?
2. Can the **structured fields of findings** be produced by Jev (typed
   judgments + templates), leaving only free-text reasoning to an LLM?

## Answer

**A review-grade report (evidence-backed findings with prose recommendations)
cannot fit in 10 s** — reviewer generation is the floor: 32–53 s per round on
the 106-line fixture, because an agentic child session reads, reasons, and
writes. No adjudication change touches that.

**A gate-grade review (defect? where? which kind? block or pass?) fits with
3x headroom** — measured **1.2 s wall time** end to end on the fixture, by
removing generation from the critical path entirely. This is what shipped as
`pi-review screen`.

The field-level answer to question 2: every `ReviewFinding` field has a
non-LLM producer when a catalog pattern matches:

| Field | Producer |
|-------|----------|
| `id`, `path`, `location` | Deterministic hunk slicer |
| `severity`, `summary`, `recommendation` | Matched catalog pattern template |
| `actionable` | Thresholded Jev probability |
| `details` (Evidence) | Template + spliced hunk code |
| Free-text reasoning for novel defects | LLM — only via the unmatched-signal escape hatch, off the gate path |

## Mechanism (shipped)

```
files ─► 1. deterministic slice        (local, ms — declaration-boundary hunks)
            │
            ├─► 2. one Jev call        (~1s — per hunk: 1 catch-all Noul
            │     "any blocking defect?" + 1 Noul per catalog pattern;
            │     chunked past 480 questions)
            │
            └─► 3. template assembly   (local, ms — pattern hit ⇒ finding from
                  + gate                catalog severity/title/fix; catch-all
                                        hit without pattern ⇒ "unmatched
                                        signal" finding, still blocks)
```

Two design points came directly from measurement:

- **Per-hunk × per-pattern Noul fan-out, not a per-hunk Choice.** A hunk can
  hold several defects; one Choice picks only the best match and swallows the
  rest (in the experiment, `placeOrder`'s off-by-one won over the unawaited
  INSERT at confidence 0.62). The Noul fan-out caught both (p=0.98 / p=0.96).
- **The catch-all and the patterns are complementary, not redundant.** In the
  shipped-command run, `getOrder` and `markShipped` scored 0.12 / 0.32 on the
  catch-all (below the 0.6 threshold) yet their cache-aliasing pattern scored
  0.71 / 0.79 — the fan-out flags real incidental defects the broad question
  misses. Conversely the catch-all covers off-catalog defects.

## Measurements

Fixture: the same 106-line `order-service.ts` as the adjudication case
(appendix there), with five planted defects: F1 off-by-one loop
(`placeOrder`), F2 unawaited INSERT (`placeOrder`), F3 SQL injection
(`listForCustomer`), F4 slice off-by-one (`listPage`), F5 float money + exact
equality early return (`lifetimeValue`).

### Experiment (two-stage prototype, `/tmp` harness)

Stage 1 — 7 hand-sliced hunks × (Noul defect + Choice category + Score
severity) = 21 questions, one call, **0.91 s** (3.2 K input tokens):

| Hunk | p(defect) | Category | Severity | Truth |
|------|-----------|----------|----------|-------|
| placeOrder | 0.96 | correctness | 1.9 | F1+F2 🚩 |
| listForCustomer | 0.97 | security | 2.0 | F3 🚩 |
| listPage | 0.88 | correctness | 1.55 | F4 🚩 |
| lifetimeValue | 0.76 | correctness | 1.6 | F5 🚩 |
| header / getOrder / markShipped | 0.07 / 0.16 / 0.45 | none/none/correctness | ≤0.86 | clean ✅ |

**Recall 4/4 defective hunks, 0 false positives**; all four category Choices
correct.

Stage 2 — pattern Choice per flagged hunk: 4 questions, **1.13 s**, all four
matched the right catalog pattern (`float_equality` chosen for F5, the more
specific of its two aspects).

Stage 2b — per-pattern Noul fan-out on the multi-defect hunk: 8 questions,
**0.32 s**, both F1 (0.98) and F2 (0.96) recovered, plus true incidentals
`float_money` (0.79) and `missing_validation` (0.80).

### Shipped command (merged single-call design)

`pi-review screen order-service.ts`: 12 hunks (finer slicing than the
prototype — interfaces become their own hunks), 108 questions, **1 call,
1.2 s wall time**, exit 1. All five planted defects hit (p: 0.97, 0.96,
0.98, 0.95, 0.94 + 0.71), plus three true incidentals (cache aliasing ×2,
missing validation) — matching the `cache`/`validate`/`alias` labels human
reviewers produced in the adjudication case. Header/interface hunks scored
0.03–0.06: clean separation.

Budget against the 10 s line: **~1.2 s used, ~8.8 s spare**; slicing,
assembly, and the gate decision are local milliseconds.

## What this is not

- **Not review-grade.** No cross-hunk reasoning, no codebase-convention-aware
  fixes, no prose evidence. The unmatched-signal finding routes those to a
  full `pi-review` run instead of guessing.
- **Coverage is the catalog.** Eight patterns shipped at launch (since grown —
  see the screening guide); off-catalog defects
  rely on the catch-all, whose recall beyond this fixture is unmeasured. Add
  patterns when history shows repeated unmatched signals — `screen-memory.jsonl`
  now records them automatically.
- **One fixture, one model (`jev-1.13.0`), one run per row.** Thresholds
  (0.6) and hunk slicing heuristics need per-task calibration before trusting
  the gate on a new codebase shape — the same advice the Jev skills give for
  Noul thresholds.
- **Question volume scales O(hunks × (1 + patterns)).** 561 Nouls per call
  are known-good; screen chunks past 480. A whole-repo scan is not the
  intended target — changed files in CI are.

## Reproduction

1. Copy the fixture from the
   [adjudication case appendix](jev-adjudication-case.md#appendix-fixture) as
   `order-service.ts` in a scratch directory.
2. With `TYPESAFE_API_KEY` set: `pi-review screen order-service.ts` — expect
   exit 1, ~10 findings, ~1–2 s.
3. Machine output: the `PI_REVIEW_SCREEN_JSON` stderr line carries
   `hunkReports` with per-hunk catch-all probabilities and matched patterns.
