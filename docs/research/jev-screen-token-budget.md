# Jev screen token budget: limits and a degrading batch strategy

Date: 2026-10-12 · Status: implemented for [#12](https://github.com/ZephyrDeng/pi-review/issues/12) · Model: `jev-1.13`

## Question

`pi-review screen` fails with `typesafe api http 400` on large multi-file
inputs (the hidden server reason is `max_tokens_exceeded`). What limits does
the API actually enforce, and how should screen batch and degrade so large
inputs are either fully screened or explicitly reported as incomplete?

## Findings

### API limits (primary sources)

| Fact | Source |
| --- | --- |
| Context length: **64k tokens per request** covering `state` plus all questions combined | [Models](https://docs.typesafe.ai/models.md) |
| A second limit: **32k tokens for `state` plus the single longest question** | [Models](https://docs.typesafe.ai/models.md) |
| Rate limits: 100K tokens/s, 80 requests/s; over either limit returns 429. Limits "can change without notice" | [Models](https://docs.typesafe.ai/models.md) |
| Billing is per input token; output tokens are free | [Models](https://docs.typesafe.ai/models.md) |
| Each response reports `usage.input_tokens` / `output_tokens`; there is no token-count endpoint | [API reference](https://docs.typesafe.ai/api.md), [docs index](https://docs.typesafe.ai/llms.txt) |
| Documented error statuses are 401, 422, 429, and 529; **400 `max_tokens_exceeded` is undocumented** (seen only in the #12 traces) | [API reference — Errors](https://docs.typesafe.ai/api.md) |
| SDK default retry set is 408, 429, and 500–599 (which includes 529) | [Python SDK retries](https://docs.typesafe.ai/sdk/python/api/retries.md) |
| "Accuracy falls as the state grows with content unrelated to the decision… Jev suffers from context rot." Advice: send only what the question needs | [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) |

### Client behavior (this repo, `a98207e`)

- `evaluateChunked` (`src/screen.ts`) splits questions at
  `MAX_QUESTIONS_PER_CALL = 480` and sends the **complete** all-hunks `state`
  with every chunk. That is the root cause of the 400. Because questions
  about hunk *i* never need hunk *j*, it also adds the unrelated context that
  the jaggedness page warns against.
- **The questions alone take up much of the budget.** A mock-fetch replay
  (3 files, 30 hunks, 22 questions per hunk) measured about **277 serialized
  chars per question**: the question text plus the repeated
  `GENERIC_NOUL_CRITERIA`. At the 480 cap, that is about 133k chars, or
  roughly 33–44k tokens, before any code is added. A question-count cap
  cannot bound the 64k total by itself.
- `sliceHunks` merges every hunk past the 40th into the last one. That is
  the main way a single hunk grows past the 32k state limit.
- `callSystemOne` (`src/jev.ts`) discards the error body. 400 is not
  retried (`RETRYABLE_HTTP` = 429, 500, 502, 503, 504), so the client does
  not retry an identical oversized request. 529 is documented as retryable
  but is missing from that set.

### Unknowns

- Server tokenizer: unknown. The only measured signal is `usage.input_tokens`
  after a call succeeds. The estimate must therefore be conservative and
  backed by a reactive fallback.
- Whether the 400 distinguishes which limit (64k total or 32k state) was hit
  is not established.

## Recommended strategy

The work unit is one **hunk together with all its questions**. A hunk's
questions share its code, so they stay in the same request.

1. **Per-batch state.** Each request's `state.hunks` contains only the hunks
   whose questions are in that request. This fixes the 400 and removes the
   cross-hunk distractors.
2. **Pack against an estimated token budget.** Greedily pack hunks in
   source order. A batch closes when adding the next hunk would break any
   of these limits:
   - estimated tokens of the serialized `state` + `questions` ≤ **48k**
     (75% of 64k);
   - estimated tokens of the serialized `state` + the longest question ≤
     **24k** (75% of 32k);
   - questions ≤ `MAX_QUESTIONS_PER_CALL` (480, kept).

   Estimator: `asciiChars / 3 + nonAsciiChars`. It counts JSON-escaped code
   at 3 chars per token, and CJK comments or strings at about 1 token per
   char. Measure the exact JSON that will be sent.
3. **Pre-split oversized hunks.** When one hunk's state alone exceeds the
   24k budget, split it at line boundaries into parts that each fit. Each
   part gets a unique derived id and its own `startLine`/`endLine`. Split a
   single over-long line (minified code) by characters as a last resort.
4. **Reactive halving on `max_tokens_exceeded` only.** If the server still
   rejects a batch with that code, the client never resends the same request:
   - a batch with more than one hunk splits into two halves, and each half
     is retried;
   - a single-hunk batch splits the hunk into two line halves, at most
     **3** split levels deep;
   - a hunk that still fails, or cannot be split further, is recorded as
     **unscreened**.

   Any other error still aborts the whole screen, as it does today (exit 4).
5. **Coverage-aware result.** `ScreenResult` lists `unscreened` hunks (id,
   path, lines, reason). Unscreened hunks with no findings are never
   `clean`; see the decision below. Usage, call counts, question counts,
   finding ids, and locations are aggregated across all batches. The
   `hunkReports` and flagged-hunk memory use the post-split hunk list, so
   `collectFlaggedHunks`' index pairing stays valid.
6. **Safe diagnostics.** `JevError` gains an optional `code`. It is set
   only from `detail.error_type`, and only when the value matches
   `^[a-z][a-z0-9_]{0,63}$`. The message becomes
   `typesafe api http 400 (max_tokens_exceeded)`. No other body content,
   headers, or payload is surfaced. Adjudication and classify get the same
   diagnostics without extra work.

Invariant to keep: when the whole input fits in one batch, the request body
stays byte-identical to today's. Existing small-input behavior and calibration
do not change.

### Decision for the maintainer

When some hunks end up unscreened:

- **(recommended)** If there are findings, report `has_findings` (exit 1)
  and still list `unscreened`. If there are no findings, report the new
  status `incomplete` (exit 4, "screening unavailable; not a pass"). This
  extends the existing exit-4 row in `docs/guide/screening.md`.
- Alternative: any unscreened hunk makes the whole run fail with exit 4 and
  discards partial findings. This is simpler, but large files lose all
  partial signal.

### Out of scope (follow-ups)

- Add 529 to `RETRYABLE_HTTP`. It is documented as retryable and is
  independent of #12.
- Calibrate the chars/token estimate at runtime from `usage.input_tokens`.
  Do this only if the static estimate proves too conservative and causes
  too many calls.
