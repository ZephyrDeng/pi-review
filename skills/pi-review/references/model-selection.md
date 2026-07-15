# Model selection for pi-review (all hosts)

Use this after `pi-review models` (or `pi-review models <search>`). **Never invent** `provider/model` IDs—only IDs that appear in that output.

## Workflow (Claude Code, Codex, Cursor, Pi parent agent)

1. Run `pi-review models` (narrow with search if the user named a vendor or model family).
2. Infer **review profile** from the target (see table below).
3. Walk the **priority list** for that profile; pick the **first** row whose `idContains` matches some listed model id (case-insensitive substring). If several ids match one row, prefer the **newest** id (higher version suffix, e.g. `2.7` over `2.5`, `4-8` over `4-6`).
4. Set `--model <exact-listed-provider/model>` from the catalog. Add `:thinking` only if that model supports it in Pi and the preset suggests it (see thinking column).
   - User “max / 最高档” maps to Pi thinking `xhigh` when supported; otherwise fall back to the highest available level.
5. If **no** priority row matches anything in the catalog, either omit `--model` (Pi default) or pick the best **reasoning** model with a large context window from the list—state the choice in one line to the user.

## Profiles

| Profile | When to use |
|---------|-------------|
| **code** | **Fast review**: diffs, MRs, routine backend/general code (`@src/...`, `.ts`, `.go`, …). |
| **frontend** | **Vision / UI / multimodal**: `.vue`, `.svelte`, `.css`, `.scss`, `.html`, screenshots, or user says frontend / UI / vision / 多模态. |
| **plan** | **Complex / 方案评审**: `--mode plan` or `--mode challenge`, architecture docs, hard design trade-offs (not line-by-line code only). |

## Priority lists (same as Pi `/rv` package preset)

Configurable on disk for Pi: `resources/rv-model-priorities.json` or `PI_REVIEW_RV_PRIORITIES`. Agents should follow this table unless the user overrides.

Thinking notes: Pi levels are `off|minimal|low|medium|high|xhigh`. Treat user **max / 最高档** as **`xhigh`**.

### Code — fast review

| Order | Match model id containing | Suggested thinking | Notes |
|-------|---------------------------|--------------------|--------|
| 1 | `claude-sonnet` (prefer `5`) | `xhigh` (or `high`) | Fast strong default |
| 2 | `deepseek-v4-flash` | `xhigh` | |
| 3 | `glm-5.2` | `xhigh` (or `high`) | |
| 4 | `minimax-m3` | `xhigh` | |
| 5 | `grok-4.5` | `xhigh` (or `high`) | |
| 6 | `gpt-5.6-terra` | any / omit | Any supported tier |
| 7 | `gpt-5.6-luna` | `xhigh` | max/`xhigh` preferred |

### Frontend — vision / multimodal

| Order | Match model id containing | Notes |
|-------|---------------------------|--------|
| 1 | `claude` | Claude family first for vision |
| 2 | `gpt` | GPT family |
| 3 | `kimi` (prefer `2.7`, e.g. kimi-2.7-code) | Vision-friendly Kimi |
| 4 | `minimax-m3` | Multimodal-friendly |

Use **code** mode unless the user asked for plan/challenge.

### Plan / challenge — complex & 方案评审

| Order | Match model id containing | Suggested thinking | Notes |
|-------|---------------------------|--------------------|--------|
| 1 | `gpt-5.6-sol` | `xhigh` (max) | Preferred for hard cases |
| 2 | `claude-opus-4-8` / `claude-opus-4` (prefer `8`) | `xhigh` | |
| 3 | `claude-fable-5` | `xhigh` (max) | **Use cautiously** |
| 4 | `glm-5.2` | `xhigh` (最高档) | |
| 5 | `deepseek-v4-pro` | `xhigh` (最高档) | |
| 6 | `grok-4.5` | `xhigh` (最高档) | |

Use `--mode plan` or `--mode challenge` as appropriate.

## Examples (illustrative—always substitute exact catalog strings)

```bash
# Fast code review
pi-review --model px:anthropic/claude-sonnet-4-5:xhigh -- @src/auth.ts

# Complex / plan
pi-review --mode plan --model openai-codex/gpt-5.6-sol:xhigh -- @docs/architecture.md

# Vision / frontend
pi-review --model wafer.ai/Kimi-K2.7-code -- @src/App.vue
```

## User-named model

If the user specifies a model, resolve against the catalog instead of inventing an id:

1. Exact `provider/model` match wins.
2. Bare id / family fragment (`gpt-5.6-sol`, `kimi`, `opus`) may uniquely match one listed id. Prefer the host session's primary provider when the same id exists on multiple providers.
3. If several unrelated families match, show the top candidates and ask. Do not silently jump from `gpt` to `claude`.
4. Thinking aliases are allowed: `max`/`最高`/`最高档` → `xhigh`, `高` → `high`, `中` → `medium`, `快`/`off` → `off`. If unsupported by the chosen model, fall back to the nearest supported level.
5. Inline form `provider/model:thinking` is valid.

On Pi `/rv*`, short model/thinking tokens are resolved against the live registry before the review starts. On other hosts, run `pi-review models <fragment>` and apply the same rules.

## Language

Explain your model choice briefly in the **same language** as the user's request (Chinese ↔ English). The review body language is independent; this rule is only for the one-line rationale before/after invoking `pi-review`.
