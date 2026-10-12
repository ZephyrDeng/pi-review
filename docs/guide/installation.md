# Installation

[中文版](zh-CN/installation.md)

## Prerequisites

- [Pi CLI](https://pi.dev) installed and configured with at least one model provider

Dev dependencies use the [public npm registry](https://registry.npmjs.org/) (see [`.npmrc`](../../.npmrc)); run `npm install` in the repo root for Husky hooks.

### CLI (recommended)

```bash
npm install -g @zephyrdeng/pi-review
```

### One-shot (Pi + other agents)

```bash
npx @zephyrdeng/pi-review install
```

Runs `pi install npm:@zephyrdeng/pi-review` when the Pi CLI is on PATH, then installs the agent skill for Claude Code, Codex, Cursor, and agy / Antigravity (via the [skills CLI](https://www.npmjs.com/package/skills), non-interactive `-y`). Forward extra flags to the skill step, e.g. `npx @zephyrdeng/pi-review install --agent claude-code codex agy -y` or `npx @zephyrdeng/pi-review install --agents-only --all`.

Use `--pi-only` or `--agents-only` to run one side. For Pi-only use, **do not** also run `install-skill` — the npm Pi package already exposes the skill via `pi.skills`.

### Pi package only

```bash
pi install npm:@zephyrdeng/pi-review
```

This registers the `/rv*` extension and the agent skill — it does **not** put `pi-review` on PATH. Inside Pi that is fine: `/rv` and the `pi_review` tool spawn the package-local bin directly, and the skill falls back to `node <package>/bin/pi-review.js` for shell commands. If the same machine also drives the skill from Claude Code / Codex / Cursor / agy, install the CLI globally too (`npm i -g @zephyrdeng/pi-review`); otherwise agents resolve it through `npx -y @zephyrdeng/pi-review` on every call.

### Agent skill only (Claude Code, Codex, Cursor, agy, ...)

```bash
npx @zephyrdeng/pi-review install-skill
```

This uses the [skills CLI](https://www.npmjs.com/package/skills) when available — it will prompt you to choose which agents to install to. Falls back to a direct copy into Claude Code (`~/.claude/skills`) and agy / Antigravity (`~/.gemini/config/skills`, discovered by AGY / AGY CLI / AGY IDE) if `skills` is not found.

Skill-only installs copy just the `skills/pi-review/` tree — no CLI lands on PATH, and the installer prints a note when that is the case. Agents resolve the CLI in order: `pi-review` on PATH → package-local `bin/pi-review.js` → `npx -y @zephyrdeng/pi-review`. Global install is recommended for repeated use.

You can also specify agents directly. `agy` is accepted as a shorthand for the skills CLI ids `antigravity` + `antigravity-cli`:

```bash
pi-review install-skill --agent claude-code codex cursor agy
# or only Antigravity:
pi-review install-skill --agent agy
```

To remove:

```bash
pi-review uninstall-skill
```

### Claude Code plugin (live panel pane)

`pi-review install` and `pi-review update` install or update it for you when the `claude` CLI is on PATH (user scope). To install it by hand, type at a Claude Code terminal prompt:

```
/plugin install pi-review --marketplace ZephyrDeng/pi-review
```

Answer `y` to add the marketplace, then pick a scope (user scope first). The plugin ships the `pi-review` skill plus a mod that draws panel reviews in a Claude Code pane: reviewer status, active tool, turns, tokens and cost while it runs, then verdict, gate status, confirmed findings and advisories. The plugin sets `PI_REVIEW_UI=pane` for its session, so panel runs (and panel `loop` rounds) write their events for the pane and start no web dashboard or browser; the pane opens on its own when a run starts, or with `/pi-review-panel`. The CLI still has to be on PATH (`npm i -g @zephyrdeng/pi-review`).

Once the plugin is installed it is Claude Code's copy of the skill: `install` / `update` remove the standalone `~/.claude/skills/pi-review` and keep refreshing the skill for the other agents only, so Claude Code never lists it twice. Remove the plugin with `claude plugin uninstall pi-review@pi-review` (then `pi-review install-skill --agent claude-code` brings the standalone skill back).

Requires Claude Code 2.1.275 or later. An auto-opened pane needs a terminal at least 110 columns wide; `/pi-review-panel` opens it at any width.

#### Upgrading from an earlier pi-review

```bash
pi-review update        # npm package → latest, Claude Code plugin installed, skill de-duplicated
```

Then restart Claude Code (or run `/reload-plugins`). On a CLI older than the plugin (before `pi-review update` ran), the skill still passes `--ui web --no-ui-open`, so the old CLI starts its dashboard server without a browser and the pane follows the same events.

### Update package + skill

```bash
pi-review update
```

Updates the global npm package when a newer version is available, then installs or updates the Claude Code plugin when `claude` is on PATH, then refreshes the installed agent skill content (via `skills update pi-review`, with a reinstall / Claude + agy direct-copy fallback; Claude Code is left to the plugin once it is installed).

### From source

```bash
git clone https://github.com/ZephyrDeng/pi-review.git
cd pi-review
npm install && npm run build
npm link
```


## Contributing: language policy

- **Source code** (CLI, extensions, presets, prompts, TUI strings emitted from code): **English only**.
- **Documentation** may be bilingual. See [README.zh-CN.md](../../README.zh-CN.md) for 中文说明.
- **Git commits**: [Husky](https://typicode.github.io/husky/) runs `ai-commit` on `prepare-commit-msg` / `commit-msg` / `pre-commit` (see [`.husky/`](../../.husky/)). Config: [`.ai-commit.yaml`](../../.ai-commit.yaml) (English, `ai_footer: off`, **ai-commit v0.1.45+** on PATH). Or run `ai-commit commit` / `ai-commit generate` directly after `git add`.

