# Pi Review — Domain Context

## Glossary

**pi-review**: A CLI and Pi package that runs isolated child Pi sessions for review-only work. It reads code, analyzes, and returns structured findings — never edits, patches, or deploys.

**Review run**: A single `pi-review` invocation that spawns a fresh child Pi session and returns a review conclusion.

**Review conclusion**: The Markdown review body plus a `PI_REVIEW_META` JSON footer emitted by the CLI.

**Review mode**: A named preset that shapes the review behavior. The default mode is `code`; plan modes are selected with `--mode plan-bigbang` or `--mode plan-grill`.

**Model catalog**: The model list returned by `pi --list-models`, exposed through `pi-review models [search]`.

**Pi package**: The installable package shape that lets Pi load the `/rv` extension and the `pi-review` skill via `pi install`.

**Shell CLI**: The npm `bin` entry exposed as `pi-review` for terminal, CI, and editor integration workflows.

## Key Relationships

- A **review run** always executes in a child Pi process — never in the parent session.
- `pi-review models` delegates to the Pi **model catalog** directly.
- The Pi package `/rv` command sends a review request to the agent, which uses the **pi-review skill** to invoke the **shell CLI**.
- The package skill guides parent agents to call the **shell CLI** and preserve the `PI_REVIEW_META` footer.
