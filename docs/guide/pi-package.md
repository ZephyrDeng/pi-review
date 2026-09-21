# Pi package: `/rv` commands

After installing as a Pi package, use the `/rv` slash command:

```
/rv @src/foo.ts
/rv --mode challenge @docs/design.md
```

Slash commands inject a task message for the parent agent. Strategy is selected by the command (`/rv`, `/rv-loop`, `/rv-models`); the remainder is the natural-language target. `/rv-config` is read-only: it shows the effective configuration (config file, env overrides, resolved paths). Use plain `/rv @src`, `/rv review the auth changes`, or `/rv-loop fix until clean @src` in Pi — no extra streaming flags needed for panel runs. `--continue`, `--keep-session`, loop, and explicit `--no-stream` retain the shell CLI path.

```
/rv models
/rv @src/foo.ts
/rv --mode plan @docs/architecture.md
/rv --mode challenge --keep-session @docs/design.md
```

Argument completions are context-aware. After the host session starts, `/rv` reads the live model registry and offers:

- **Model list** after `--model `: candidates come from the live Pi registry; order follows **`resources/rv-model-priorities.json`** (override with `PI_REVIEW_RV_PRIORITIES`). Presets match registry ids by substring and prefer newer version strings (e.g. kimi `2.7`, `claude-opus-4-8`). Profiles: **code / fast** (claude-sonnet-5, deepseek-v4-flash, glm-5.2, minimax-m3, grok-4.5, gpt-5.6-terra/luna), **frontend / vision** (claude → gpt → kimi-2.7 → minimax-m3), **plan / complex** (gpt-5.6-sol max, claude-opus-4.8 xhigh, claude-fable-5 max cautious, glm-5.2 / deepseek-v4-pro / grok-4.5 max).
- **Thinking suffix** after `provider/model:` — only levels the chosen model actually supports.
- **Semantic phrases** (e.g. `code review` / 代码审核, `查看模型列表`) in addition to flags; orchestration prompts follow **session locale** (zh/en) for summaries.
- **Scene templates** at the top level (code / frontend / plan presets).

**Claude Code / Codex / Cursor / agy:** the bundled skill includes **[skills/pi-review/references/model-selection.md](../../skills/pi-review/references/model-selection.md)** — same presets as `/rv` for choosing `--model` after `pi-review models`.

Completions are a hint layer only; execution remains skill-driven. When the model registry is unavailable (e.g. non-TUI mode), `/rv` falls back to the static hint list.

