# Installation

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

### Agent skill only (Claude Code, Codex, Cursor, agy, ...)

```bash
npx @zephyrdeng/pi-review install-skill
```

This uses the [skills CLI](https://www.npmjs.com/package/skills) when available — it will prompt you to choose which agents to install to. Falls back to a direct copy into Claude Code (`~/.claude/skills`) and agy / Antigravity (`~/.gemini/config/skills`, discovered by AGY / AGY CLI / AGY IDE) if `skills` is not found.

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

### Update package + skill

```bash
pi-review update
```

Updates the global npm package when a newer version is available, then refreshes the installed agent skill content (via `skills update pi-review`, with a reinstall / Claude + agy direct-copy fallback).

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

