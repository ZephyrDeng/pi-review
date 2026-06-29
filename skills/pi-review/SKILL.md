---
name: pi-review
description: Use pi-review to delegate isolated code, diff, repository, architecture, or plan reviews to a fresh Pi session and return only the review conclusion. Use when the user asks for Pi review, isolated review, code review, plan review, challenge review, or wants to avoid context pollution.
---

# Pi Review

Use `pi-review` to run a fresh Pi review session and return only the review conclusion.

## CLI Resolution

Prefer the shell command when it exists:

```bash
pi-review --help
```

If `pi-review` is not on PATH but this skill came from the Pi package, use the package-local CLI relative to this skill directory:

```bash
node ../../bin/pi-review.js --help
```

When resolving this fallback, use the actual directory that contains this `SKILL.md`.

## Steps

1. Prime the model catalog:
   ```bash
   pi-review models [search]
   ```
   Rules:
   - Run this before building the review command.
   - If the user named a model, use that provider/model text as `[search]` and verify the exact ID from the output.
   - If the user did not name a model, run `pi-review models` and either choose an exact suitable ID from the output or deliberately omit `--model` to use Pi's default.
   Completion criterion: the model choice is either an exact listed `provider/model[:thinking]` or an explicit decision to use Pi's default.

2. Choose one mode:
   - default `code` — code, diff, MR, file, or repository review.
   - `--mode plan` — broad plan, architecture, product, or strategy review through multiple expert lenses.
   - `--mode challenge` — adversarial review of assumptions, boundaries, dependencies, and missing evidence.
   Completion criterion: use default `code` unless the target is clearly a plan/design review; if two modes fit equally, ask the user to choose.

3. Run an isolated review:
   ```bash
   pi-review [--mode <name>] [--model <provider/model[:thinking]>] [--keep-session|--continue <handle>] -- <@files|text...>
   ```
   Rules:
   - Use the model decision from step 1; do not invent model IDs.
   - Omit `--mode` for normal code review; the command defaults to `code`.
   - Use `--keep-session` only when the user wants follow-up questions on this review.
   - Use `--continue <handle>` only with a previous `PI_REVIEW_META.sessionHandle`.
   - Put file references as `@path` after `--`.
   - Do not ask `pi-review` to edit, patch, commit, or implement.
   Completion criterion: the command includes the resolved model/default choice and a concrete review target.

4. Return the result:
   - Preserve the final `PI_REVIEW_META: {...}` line.
   - Do not apply findings automatically; implementation is a separate user decision.
   Completion criterion: the user sees the Markdown review conclusion and meta footer.

## Examples

```bash
pi-review -- @src/foo.ts
pi-review --model openai/gpt-5.5 -- @src/foo.ts
pi-review --mode challenge --keep-session -- @docs/design.md
pi-review --mode challenge --continue <sessionHandle> -- "expand finding 2"
```
