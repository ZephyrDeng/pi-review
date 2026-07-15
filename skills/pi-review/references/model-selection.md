# Model selection for pi-review (all hosts)

Use this after `pi-review models` (or `pi-review models <search>`). **Never invent** `provider/model` IDs—only IDs that appear in that output.

## Workflow (Claude Code, Codex, Cursor, Pi parent agent)

1. Run `pi-review models` (narrow with search if the user named a vendor or model family).
2. Infer **review profile** from the target (see table below).
3. Walk the **priority list** for that profile; pick the **first** row whose `idContains` matches some listed model id (case-insensitive substring). If several ids match one row, prefer the **newest** id (higher version suffix, e.g. `2.7` over `2.5`, `4-8` over `4-6`).
4. Set `--model <exact-listed-provider/model>` from the catalog. Add `:thinking` only if that model supports it in Pi and the preset suggests it (see thinking column).
5. If **no** priority row matches anything in the catalog, either omit `--model` (Pi default) or pick the best **reasoning** model with a large context window from the list—state the choice in one line to the user.

## Profiles

| Profile | When to use |
|---------|-------------|
| **code** | Default: diffs, MRs, backend/ general code paths (`@src/...`, `.ts`, `.go`, …). |
| **frontend** | UI-heavy targets: `.vue`, `.svelte`, `.css`, `.scss`, `.html`, or user says frontend / UI / multimodal. |
| **plan** | `--mode plan` or `--mode challenge`, or reviewing `.md` / design / architecture docs (not line-by-line code only). |

## Priority lists (same as Pi `/rv` package preset)

Configurable on disk for Pi: `resources/rv-model-priorities.json` or `PI_REVIEW_RV_PRIORITIES`. Agents should follow this table unless the user overrides.

### Code review

| Order | Match model id containing | Suggested thinking |
|-------|---------------------------|------------------|
| 1 | `gpt-5.5` | `xhigh` |
| 2 | `glm-5.2` | `high` |

### Frontend / multimodal review

| Order | Match model id containing | Notes |
|-------|---------------------------|--------|
| 1 | `kimi` | Prefer id that also contains `2.7` when multiple Kimi ids exist |
| 2 | `claude-sonnet` | Prefer id containing `5` when multiple |
| 3 | `minimax-m3` | Multimodal-friendly |

Use **code** mode (`pi-review` default) unless the user asked for plan/challenge.

### Plan / challenge review

| Order | Match model id containing |
|-------|---------------------------|
| 1 | `claude-opus-4-8` |
| 2 | `claude-opus-4` (+ prefer `8` in id if several) |
| 3 | `deepseek-v4-pro` |
| 4 | `deepseek-v4` |

Use `--mode plan` or `--mode challenge` as appropriate.

## Examples (illustrative—always substitute exact catalog strings)

```bash
# Code
pi-review --model openai-codex/gpt-5.5:xhigh -- @src/auth.ts

# Frontend
pi-review --model wafer.ai/Kimi-K2.6 -- @src/App.vue

# Plan
pi-review --mode plan --model px:anthropic/claude-opus-4-8 -- @docs/architecture.md
```

## User-named model

If the user specifies a model, resolve against the catalog instead of inventing an id:

1. Exact `provider/model` match wins.
2. Bare id / family fragment (`gpt-5.5`, `kimi`, `opus`) may uniquely match one listed id. Prefer the host session's primary provider when the same id exists on multiple providers.
3. If several unrelated families match, show the top candidates and ask. Do not silently jump from `gpt` to `claude`.
4. Thinking aliases are allowed: `max`/`最高` → `xhigh`, `高` → `high`, `中` → `medium`, `快`/`off` → `off`. If unsupported by the chosen model, fall back to the nearest supported level.
5. Inline form `provider/model:thinking` is valid.

On Pi `/rv*`, short model/thinking tokens are resolved against the live registry before the review starts. On other hosts, run `pi-review models <fragment>` and apply the same rules.

## Language

Explain your model choice briefly in the **same language** as the user's request (Chinese ↔ English). The review body language is independent; this rule is only for the one-line rationale before/after invoking `pi-review`.