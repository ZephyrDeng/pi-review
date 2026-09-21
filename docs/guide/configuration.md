# Configuration

[中文版](zh-CN/configuration.md)

Persistent settings live in the review config file `~/.pi/pi-review/config.json` (override its location with `PI_REVIEW_CONFIG`). The config is advisory and forward-compatible: unknown keys are ignored, `null` counts as unset, and any other problem (wrong-typed value, invalid JSON) only prints a warning and falls back — the config never blocks core functionality, so a config written by a newer pi-review cannot brick an older one. In Pi, `/rv-config` shows the effective configuration (values, sources, warnings, resolved paths). There is deliberately no `/rv-config set` command — the preferred editor is your agent via the pi-review agent skill, which knows the config schema, keeps unknown keys, never overwrites invalid JSON, and never writes secrets (API keys stay environment variables, e.g. `TYPESAFE_API_KEY`; the config file holds flags only).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `childExtensions` | boolean | `false` | Let review children load host Pi extensions so providers registered only through extensions are usable. Equivalent to per-run `PI_REVIEW_CHILD_EXTENSIONS=1`; `false` keeps children isolated with `--no-extensions` (issue #8). |
| `jev` | boolean | auto | Route panel consensus adjudication to TypeSafe Jev instead of a Pi adjudicator child. Default: enabled when `TYPESAFE_API_KEY` is set, disabled otherwise. Per-run override: `PI_REVIEW_JEV=1` / `=0`. An explicit `--consensus-model` always keeps the Pi adjudicator. |

Per-process overrides via environment variables (env wins over the config file):

| Variable | Description |
|----------|-------------|
| `PI_BIN` | Pi executable path (default: `pi`) |
| `PI_REVIEW_HOME` | Directory containing `review-presets.json` and `system-prompt.md` |
| `PI_REVIEW_PRESETS` | Path to presets JSON file |
| `PI_REVIEW_PANEL_PRESETS` | Path to panel presets JSON file |
| `PI_REVIEW_SYSTEM_PROMPT` | Path to system prompt file |
| `PI_REVIEW_SESSION_DIR` | Directory for persisted review sessions |
| `PI_REVIEW_META_STDOUT` | Set to `1`/`true` to print `PI_REVIEW_META_JSON` on stdout instead of stderr |
| `PI_REVIEW_JEV` | Per-run override for `jev`: `1`/`true`/`on` routes panel consensus adjudication to TypeSafe Jev, any other set value (e.g. `0`) keeps the Pi adjudicator. Connection: `TYPESAFE_API_KEY` (required), optional `TYPESAFE_BASE_URL` and `PI_REVIEW_JEV_MODEL` (default `jev-latest`) |
| `PI_REVIEW_CHILD_EXTENSIONS` | Per-run override for `childExtensions`: `1`/`true`/`keep` enables host extensions for this process, any other set value (e.g. `0`) forces isolation; an empty value counts as unset. Persistent equivalent: `{ "childExtensions": true }` in the config file. With an explicit `--provider`, pi-review first probes the model catalog and blocks with a hint if the provider only exists via extensions |
| `PI_REVIEW_CONFIG` | Path to the review config file (default: `~/.pi/pi-review/config.json`) |
| `PI_REVIEW_SCREEN_PATTERNS` | Path to an extra screen pattern catalog JSON, loaded after `screen-patterns.json` and winning id conflicts — point it at a repo-committed file to share team patterns |
| `PI_REVIEW_SCREEN_MEMORY` | `0`/`false`/`off` disables recording flagged hunks to `screen-memory.jsonl` (default: on) |
| `PI_REVIEW_SCREEN_MEMORY_FILE` | Path override for the screen memory log (default: `screen-memory.jsonl` next to the config file) |


## Security model

- Each review and every loop round runs in an isolated child Pi session
- Default runs use `--no-session` — no child context is stored
- Children run isolated with `--no-extensions` by default so host usage HUDs / reload bridges cannot crash a reviewer via stale extension context after dispose (see issue #8). Enable host extension loading persistently with `{ "childExtensions": true }` in `~/.pi/pi-review/config.json`, or per run with `PI_REVIEW_CHILD_EXTENSIONS=1` — only when a custom provider truly must register inside the child.
- Before spawning, pi-review probes the Pi model catalog when an explicit provider is in effect (via `--provider` or the `provider/` prefix of `--model`): if the provider only exists with host extensions loaded, the run is blocked with an actionable hint (`verdictSource: "config_error"`, meta `extensionHint`; panel runs aggregate every affected provider into `extensionHints`) instead of failing with a confusing unknown-provider error — set `childExtensions: true` in the config file or re-run with `PI_REVIEW_CHILD_EXTENSIONS=1`. Catalog probes are cached only on success; a transient probe failure never blocks a review.
- On reviewer runtime failure, the panel footer and `reviewers[].runtimeError` keep a child stderr/stack tail for diagnosis
- `--keep-session` stores only the child review session for explicit follow-up
- The review session is read-only: no file edits, patches, commits, or deployments

