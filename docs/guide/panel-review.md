# Panel Review

Panel review runs multiple **independent** reviewers in isolated child sessions and aggregates their findings into one gate result. Reviewers cannot see one another's findings, so agreement represents independent discovery.

```bash
# Single panel review
pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
# Expert preset (correctness, security, testing lenses)
pi-review --panel code-experts --consensus majority -- @src
# Panel loop review (up to reviewer_count × max-rounds reviewer runs + adjudication)
pi-review loop --reviewers 3 --consensus quorum --max-rounds 2 -- @src
```

### Consensus

A finding becomes a **confirmed finding** (gate-relevant) only when enough independent reviewers mark the issue **actionable**. Otherwise it stays a non-blocking **advisory**. Multi-reviewer panels default to **quorum** with minimum agreement **2** so panel mode never silently becomes any-finding fail-closed; single-review stays threshold one.

| Policy | Threshold |
|--------|----------|
| `any` | one actionable reviewer confirms |
| `quorum` (default) | configured minimum agreement (default 2; `--min-agree`) |
| `majority` | `floor(reviewers / 2) + 1` |
| `unanimous` | every reviewer |

Singleton (uncorroborated) findings remain visible as **advisories** but do not change clean status or fail the gate. Confirmed actionable clusters produce `has_findings`; no confirmed clusters produce `clean`.

### Aggregation

Two-phase matching: deterministic matching on stable anchors (path + normalized summary) first; only ambiguous same-path candidates go to a constrained **semantic adjudicator** (enabled with `--consensus-model`). The adjudicator clusters findings and may not invent findings, drop findings, add evidence, or act as another reviewer — it has no write tools. Low-confidence matches stay separate advisories so uncertain similarity cannot manufacture quorum.

**Adjudication engine (Jev enhancement mode).** When `TYPESAFE_API_KEY` is present (or `{ "jev": true }` is set in the config file), the adjudication decision is routed to [TypeSafe Jev](https://typesafe.ai) — a System One model that returns typed probabilities — instead of spawning a review-only Pi child. Each ambiguous finding pair becomes one Noul question ("same underlying issue?"), fanned out in a single call; the pair probability is used as the merge confidence and flows through the same threshold and provenance validation as LLM merges. This replaces a full child session with one ~100 ms typed call.

- **Complete-Linkage Clustering**: Built-in complete-linkage algorithm ensures 100% clustering precision, eliminating false-merge chains across findings in the same function.
- **Cross-Round Loop Memory**: In multi-round reviews (`loop`), Jev maintains true state continuity across natural reviewer phrasing drift. On the standard fixture, Jev ON achieved **`=7 persisting · +0 new · -0 resolved`** (Gemini 3.8 Flash) and `=8~9 persisting` (mixed Flash fleet), whereas deterministic string matching resulted in complete amnesia (`=0 persisting · +6~11 new · -6~11 resolved`).
- **Quota Efficiency**: Adjudication runs on a dedicated lightweight System One pathway without consuming reviewer LLM token quota or context windows.
- **Cascade**: Pairs whose probability lands in the borderline band (0.3–0.7) are re-judged once by the Pi adjudicator in a single extra call — clear cases never pay for an LLM, uncertain ones get a second opinion, and a Pi failure safely keeps Jev's judgments. Explicit `--consensus-model` keeps the Pi adjudicator for everything; `PI_REVIEW_JEV=0` disables Jev for one run; any Jev failure falls back to the Pi adjudicator. See the [visual comparison report](../research/jev-comparison-report.html) and [adjudication case study](../research/jev-adjudication-case.md).

**Scope classification (`pi-review classify`).** The same Jev backend can classify a previous review's actionable findings against your frozen task baseline — the loop-closeout scope governor as a typed decision instead of a judgment call:

```bash
pi-review classify --baseline "fix the login crash; UI polish is out of scope" --meta /tmp/last-review-meta.txt
# or pipe the review output directly:
pi-review -- @src 2>&1 | pi-review classify --baseline "..."
```

Each actionable finding gets one Choice question (`in_scope_blocker` | `follow_up` | `stop_and_escalate`), all fanned out in a single call. Output is an ASCII summary plus a `PI_REVIEW_CLASSIFY_JSON` machine line on stderr; findings below confidence 0.5 are flagged as low-confidence. Classify is advisory and host-invoked — it never edits, never blocks a gate by itself, and requires `TYPESAFE_API_KEY` (exit 4 without it).

**Gate-grade screening (`pi-review screen`).** Screen pushes Jev furthest left in the pipeline: instead of generating findings with an LLM reviewer (30s+ per round) and adjudicating them afterwards, it asks Jev typed questions about deterministically sliced code hunks and assembles findings from a defect-pattern catalog — no LLM prose on the critical path at all. Measured end-to-end on the [screening fixture](../research/jev-screening-case.md): **~1.2s wall time** for a 106-line service (12 hunks, 108 questions, one call), vs 32–53s for a full review round on the same file.

```bash
pi-review screen src/order-service.ts     # or @file refs; exits 1 on findings, 0 when clean
```

The architecture, end to end:

```
files ─► 1. deterministic slice            (local, ms — declaration-boundary hunks)
            │
            ├─► 2. one Jev call            (~1s — per hunk: 1 catch-all Noul
            │     "any blocking defect?"     + 1 Noul per catalog pattern;
            │     fanned out in parallel, chunked past 480 questions)
            │
            └─► 3. template assembly       (local, ms — pattern hit ⇒ finding
                  + gate                    from catalog severity/title/fix;
                                            catch-all hit without a pattern ⇒
                                            "unmatched signal" finding, still
                                            blocks — never silently dropped)
```

Who produces each `ReviewFinding` field: `id`/`path`/`location` come from the slicer (deterministic), `severity`/`summary`/`recommendation` come from the matched catalog pattern's template, `actionable` is the thresholded probability — the LLM's prose role shrinks to off-catalog novel defects and cross-hunk reasoning, which the unmatched-signal finding hands back to a full `pi-review` run. The catalog (`SCREEN_PATTERNS` in `src/screen.ts`) is the coverage knob: eight patterns ship today (off-by-one loops, fire-and-forget async, SQL injection, slice off-by-one, float money, float equality, cache aliasing, missing validation); add entries as history shows repeated unmatched signals. Output is an ASCII summary plus a `PI_REVIEW_SCREEN_JSON` machine line on stderr (status, findings, per-hunk probabilities, usage); exit codes mirror review (0 clean, 1 has_findings, 4 blocked/no key). Screen is a fast gate and a triage layer, not a replacement for evidence-backed review — see the [interactive visual report](../research/jev-screening-report.html), [scenario & architecture guide](../research/jev-screening-guide.md), and [measurements case study](../research/jev-screening-case.md).

### Cost and failure

Reviewer runs = `--reviewers <n>` × `--max-rounds` (loop); one adjudication call may run per round when `--consensus-model` is set. Use `--concurrency <n>` to bound provider/machine pressure (default: reviewer count, never exceeds it). Reviewer runtime failure → `blocked`; unstructured dirty output or unresolved clarification → `needs_human`; never silently clean. Panel review rejects `--keep-session`, `--continue`, and `--name` (reviewers run `--no-session`); the host agent remains the only editor.

When the panel finishes, the CLI appends a panel ASCII footer on **stdout** with gate status, health, consensus, confirmed/advisory counts, mixed model/thinking when reviewers differ, aggregate tokens/cost, adjudicator use, and a per-reviewer line:

![CLI panel footer: NEEDS HUMAN gate with 2/3 successful reviewers, quorum consensus, confirmed findings, advisories, mixed models, and per-reviewer status](../assets/panel-cli-footer.jpg)

### Machine output

A panel evaluation emits **one** aggregate `PI_REVIEW_META_JSON` record with additive fields: `strategy: "panel"`, `configuredReviewers`, `successfulReviewers`, `consensusPolicy`, `consensusThreshold`, `panelHealth`, `confirmedClusters`, `advisories`, and per-`reviewers` outcomes. Top-level `findings` contain confirmed clusters only; advisories remain separate. Existing single-review keys remain unchanged, so older consumers can ignore the new fields. The panel-level `model` is each reviewer's effective model (configured, else the provider-reported `responseModel`) when they all agree, and the literal sentinel `"mixed"` when reviewers ran on different models — machine consumers parsing `model` must expect that value; per-reviewer entries keep their own `model`/`responseModel`.

Panel machine metadata additionally carries `sourceFindings`: every contributing reviewer's raw findings, each tagged with its globally unique `id` (e.g. `"r1#F1"`) and `reviewerId`. This resolves every id referenced by `confirmedClusters[].sourceFindingIds` and `advisories[].sourceFindingIds` to its full enriched finding — including `details`/`recommendation`/`location` when the reviewer's Markdown supplied them (see [Machine finding schema](output-and-integration.md#machine-finding-schema)). Cluster-level summaries stay as they are today: `summary`/`severity`/`path` only, no enrichment fields.

### Live Pi progress and event replay

In Pi, slash commands select strategy only:

- `/rv <natural-language target>` → panel review via native `pi_review`
- `/rv-loop <natural-language target>` → loop closeout via shell CLI
- `/rv-models` → model catalog

Targets stay natural language as given. Path mentions like `@src` remain text; the CLI keeps directories as tool path targets and only attaches real files. Remaining strategy matching lives in the skill/CLI. In Pi, the user-facing tool name is **Pi Review Panel** (the API identifier remains `pi_review`); each reviewer renders as an independent live row with explicit `queued/running/completed/failed/cancelled` state, active tool, elapsed time, and token usage. Expand the tool result with `Ctrl+O` for bounded activity, final findings/provenance, duration, token totals, and cost.

![Pi Review Panel live progress: code-experts panel with correctness, security, and testing reviewers, each showing status, model, thinking level, tokens, and cost](../assets/panel-live-pi.jpg)

Example: `pi-review --panel code-experts -- @src` (or `/rv` in Pi with the same panel strategy).

Renderer adapters can consume the stable, versioned event stream directly:

```bash
pi-review --panel code-experts --output-format events-jsonl -- @src
```

This mode writes only `ReviewEvent v1` JSONL to stdout. Events have one `runId`, monotonically increasing `seq`, bounded/redacted activity text, and end in exactly one `panel.completed` event containing the same `PanelReviewMeta` as the default CLI path. The reducer is exported as `createPanelViewState()` and `reducePanelEvent()` for deterministic live delivery and replay.

Panel reviewers use the hard allowlist `read,grep,find,ls`. Shell and mutation-capable tools are rejected before a reviewer starts. `Ctrl+C` cancels the reviewer and adjudicator process trees, emits cancellation lifecycle events, and produces one blocked final event.

### Live web dashboard

`--ui web` starts an opt-in, loopback-only dashboard for hosts without a native Pi renderer (Claude Code, Codex, plain terminals):

```bash
pi-review --reviewers 3 --consensus quorum --ui web -- @src
```

![Web dashboard while reviewing: aggregate reviewer/elapsed/token/tool counters and per-reviewer cards with RUNNING status, model, thinking level, and live activity](../assets/panel-web-dashboard.jpg)

The CLI prints `PI_REVIEW_UI_URL: http://127.0.0.1:<port>/run/<token>` to stderr and opens it in the default browser before reviewers start (`--no-ui-open` disables the auto-open). The dashboard shows live per-reviewer status, streaming activity, animated token/tool-call counters, and — once the run completes — the gate result, confirmed findings/advisories, and each reviewer's full report rendered from markdown. `--ui-url-file <path>` additionally writes the URL atomically for hosts that buffer stdout/stderr. The review process still exits with the normal panel exit code as soon as the run completes.

After completion the page shows a 60-second countdown, then closes itself and stops the dashboard server; any interaction (scroll, click, keypress, or the "Keep open" button) cancels the countdown, and closing the tab afterwards also stops the server. As a backstop, the server self-terminates after a bounded idle TTL (default 900s; override with `--ui-ttl <seconds>`) so a browser can reconnect after a refresh.

The dashboard binds only to `127.0.0.1`/`::1`, protects every run with a high-entropy capability URL, sends a restrictive CSP with no remote assets or CORS, and renders all reviewer/finding text through safe DOM writes (markdown is parsed by a built-in renderer; links are restricted to http/https, and nothing goes through innerHTML). It is view-only: cancellation stays with the invoking terminal/agent host (`Ctrl+C`). `--ui web` requires an active panel and cannot combine with `loop`.

