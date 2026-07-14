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

**Pi package**: The installable package shape that lets Pi load the `/rv` extension and the `pi-review` skill via `pi install`.

**Shell CLI**: The npm `bin` entry exposed as `pi-review` for terminal, CI, and editor integration workflows.

## Key Relationships

- A **review run** always executes in a child Pi process — never in the parent session.
- A **loop round** remains review-only; only the **host agent** may act on an **actionable finding**.
- `pi-review models` delegates to the Pi **model catalog** directly.
- The Pi package `/rv` command sends mode-specific orchestration text to the parent agent, which uses the **pi-review skill** to invoke the **shell CLI**.
- The package skill guides parent agents to call the **shell CLI** and show the ASCII footer to users; `/rv` orchestration forbids default `--no-stream` / `--progress-log` in Pi. On **Claude Code / Codex**-style hosts, the skill defaults to `--progress-log` + background run + tail (`skills/pi-review/references/codex-tools.md`).
