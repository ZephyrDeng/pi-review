# 安装

[English](../installation.md)

> **这页解决什么问题：** 把 `pi-review` 装到你实际干活的地方。它有三种形态——命令行工具、Pi 包、其它 agent（Claude Code / Codex / Cursor / Antigravity）的 skill。装哪种取决于你平时在哪里让 AI 审代码；三种可以并存，只有一处需要注意别重复装（见下文）。

## 前置条件

- 已安装 [Pi CLI](https://pi.dev)，并配置好至少一个模型 provider。

`pi-review` 自己不接任何模型厂商，它把审查任务交给一个新的 Pi 子会话去跑，所以 Pi 里配置好的模型它都能用（只通过 Pi 扩展注册的 provider 默认不可见，需要 `childExtensions` 开关，见[配置](configuration.md)）。还没配 provider 的话先看 [Provider 接入](providers.md)。

开发依赖走[公共 npm registry](https://registry.npmjs.org/)（见 [`.npmrc`](../../../.npmrc)）；在仓库根目录跑 `npm install` 会顺带装好 Husky hook。

### CLI（推荐）

```bash
npm install -g @zephyrdeng/pi-review
```

装完就有 `pi-review` 命令，适合终端、CI、git hook。

### 一键安装（Pi + 其它 agent）

```bash
npx @zephyrdeng/pi-review install
```

PATH 上有 Pi CLI 时先执行 `pi install npm:@zephyrdeng/pi-review`，再通过 [skills CLI](https://www.npmjs.com/package/skills)（非交互 `-y`）把 agent skill 装进 Claude Code、Codex、Cursor 和 agy / Antigravity。多余的参数会透传给 skill 这一步，例如 `npx @zephyrdeng/pi-review install --agent claude-code codex agy -y` 或 `npx @zephyrdeng/pi-review install --agents-only --all`。

用 `--pi-only` 或 `--agents-only` 可以只装一侧。**只用 Pi 的话，不要再跑 `install-skill`**——npm 的 Pi 包已经通过 `pi.skills` 暴露了这个 skill，重复装等于两份同名 skill。

### 只装 Pi 包

```bash
pi install npm:@zephyrdeng/pi-review
```

装完在 Pi 里就有 `/rv`、`/rv-loop`、`/rv-models`、`/rv-config` 命令，见 [Pi `/rv` 命令](pi-package.md)。

### 只装 agent skill（Claude Code、Codex、Cursor、agy……）

```bash
npx @zephyrdeng/pi-review install-skill
```

有 [skills CLI](https://www.npmjs.com/package/skills) 时会用它，并让你选装到哪些 agent。找不到 `skills` 时退回直接拷贝到 Claude Code（`~/.claude/skills`）和 agy / Antigravity（`~/.gemini/config/skills`，AGY / AGY CLI / AGY IDE 都能发现）。

也可以直接指定 agent。`agy` 是 skills CLI 里 `antigravity` + `antigravity-cli` 两个 id 的简写：

```bash
pi-review install-skill --agent claude-code codex cursor agy
# 只装 Antigravity：
pi-review install-skill --agent agy
```

卸载：

```bash
pi-review uninstall-skill
```

### 更新包 + skill

```bash
pi-review update
```

有新版本时更新全局 npm 包，然后刷新已安装的 agent skill 内容（走 `skills update pi-review`，失败时退回重装 / Claude + agy 直接拷贝）。

### 从源码安装

```bash
git clone https://github.com/ZephyrDeng/pi-review.git
cd pi-review
npm install && npm run build
npm link
```

## 装好了先跑什么

```bash
pi-review models          # 确认 Pi 里的模型能被看到
pi-review -- @src/foo.ts  # 第一次审查
```

看到页脚里的 `Verdict` 一行就说明链路通了。下一步：[CLI 参考](cli-reference.md)。

## 参与贡献：语言约定

- **源码**（CLI、扩展、预设、提示词、代码里输出的 TUI 字符串）：**仅英文**。
- **文档**可双语。中文说明见 [README.zh-CN.md](../../../README.zh-CN.md)。
- **Git 提交**：[Husky](https://typicode.github.io/husky/) 在 `prepare-commit-msg` / `commit-msg` / `pre-commit` 阶段运行 `ai-commit`（见 [`.husky/`](../../../.husky/)）。配置在 [`.ai-commit.yaml`](../../../.ai-commit.yaml)（英文、`ai_footer: off`，PATH 上需有 **ai-commit v0.1.45+**）。也可以 `git add` 后直接跑 `ai-commit commit` / `ai-commit generate`。
