# Pi Review — Domain Context

## Language

- **Code and runtime copy**: English only (including `/rv` orchestration text, presets, child-session prompts).
- **Docs**: English README is canonical; [README.zh-CN.md](./README.zh-CN.md) is the Chinese companion.

## Glossary

**pi-review**: A CLI and Pi package that runs isolated child Pi sessions for review-only work. It reads code, analyzes, and returns structured findings — never edits, patches, or deploys.

**Review run**: One isolated child Pi execution that returns a review conclusion, whether invoked alone or as a loop round.

**Review conclusion**: The Markdown review body plus an ASCII `── pi-review` footer on stdout; machine metadata as `PI_REVIEW_META_JSON` on stderr.

**Loop round**: One complete, isolated review run within a bounded loop review.

**Clean**: A review conclusion with no actionable findings; the review gate is open.

**Actionable finding**: A finding the host must fix or consciously reject with rationale before clean closeout.

**Scope governor**: The closeout rules that separate in-scope blockers from follow-up work and stop-and-escalate findings.

**Host agent**: The parent Claude, Codex, Pi, other agent, or human that owns edits between review invocations.

**Review mode**: A named preset in `review-presets.json` that shapes review behavior. Built-in modes are `code` (default), `plan`, and `challenge`, selected with `--mode <name>`. Custom modes can be added by extending the presets file.

**Model catalog**: The model list returned by `pi --list-models`, exposed through `pi-review models [search]`.

**Review config**: The persistent machine-level settings file (`~/.pi/pi-review/config.json`) that shapes review children — currently two keys: `childExtensions` and `jev`. It is the durable home for behavior defaults; per-process env overrides it, and `/rv-config` shows the effective value with its source.

**Jev enhancement mode**: When `TYPESAFE_API_KEY` is present (or `jev: true` in the review config), typed decision actions route to TypeSafe Jev (System One) instead of a review-only Pi child. Currently those actions are: panel consensus adjudication (ambiguous same-path finding pairs become Noul questions fanned out in one call, probability = merge confidence), the loop's cross-round finding comparison (same machinery, prev/curr pseudo-reviewers), and the standalone `pi-review classify` command (one Choice per finding against the frozen baseline: in_scope_blocker / follow_up / stop_and_escalate). Explicit `--consensus-model` keeps the Pi adjudicator; a Jev failure falls back to it (recorded as `adjudicationFallbackNote`), and in loop comparison it degrades to deterministic-only matching.

**Pi package**: The installable package shape that lets Pi load the `/rv` extension and the `pi-review` skill via `pi install`.

**Shell CLI**: The npm `bin` entry exposed as `pi-review` for terminal, CI, and editor integration workflows.

## Key Relationships

- A **review run** always executes in a child Pi process — never in the parent session.
- A **loop round** remains review-only; only the **host agent** may act on an **actionable finding**.
- `pi-review models` delegates to the Pi **model catalog** directly. The packaged skill ensures the **review config** enables `childExtensions` so review children see providers registered only via host Pi extensions; bare CLI still isolates with `--no-extensions` until the config says otherwise (env overrides per run).
- The Pi package slash commands select strategy only: `/rv` panel, `/rv-loop` loop closeout, `/rv-models` catalog. Targets after the command stay natural language. Remaining strategy matching (mode, model, panel, path-vs-file handling) lives in the skill and CLI. Continuations, kept sessions, loop, and explicit buffered runs retain the shell-CLI path.
- The package skill guides non-Pi hosts to call the **shell CLI** and show the ASCII footer to users. `/rv` orchestration uses native live rendering for new Pi Panel runs and forbids default `--no-stream` / `--progress-log`. On **Claude Code / Codex / Cursor / agy**-style hosts, the skill defaults to `--progress-log` + background run + tail (`skills/pi-review/references/codex-tools.md`).
