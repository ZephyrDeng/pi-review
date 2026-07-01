# pi-review

[English README](./README.md)

**在命令行中运行隔离的 AI 代码与方案审查。**

`pi-review` 把审查工作交给一次全新的、隔离的 [Pi](https://github.com/anthropics/pi) 子会话，并返回结构化结论。子会话只读、只评，不改文件、不打补丁、不提交。

可作为独立 CLI、Pi 包（扩展 + skill），或接入 CI / 编辑器工作流。

## 语言约定

| 范围 | 语言 |
|------|------|
| 源码（CLI、扩展、`review-presets.json`、提示词、代码里的用户可见文案） | **仅英文** |
| 文档（本页与英文 README） | **中英均可** |

实现与对外协议（如 `PI_REVIEW_META_JSON`、Verdict 枚举）保持英文，便于自动化与跨工具一致。

## 前置条件

- 已安装并配置好 [Pi CLI](https://pi.dev)，且至少有一个可用模型

## 安装

```bash
npm install -g @zephyrdeng/pi-review
# 或 Pi 包
pi install npm:@zephyrdeng/pi-review
# 或安装 skill 到各 Agent
npx @zephyrdeng/pi-review install-skill
```

## 快速开始

```bash
pi-review -- @src/foo.ts
pi-review --model openai/gpt-5.5 -- @src/foo.ts
pi-review --mode plan -- @docs/architecture.md
pi-review --mode challenge -- @docs/design.md
pi-review models
```

## 审查模式

| 模式 | 说明 |
|------|------|
| `code`（默认） | 代码、diff、MR、文件与仓库审查 |
| `plan` | 多视角方案 / 架构审查 |
| `challenge` | 对抗式审查，压测假设与证据缺口 |

## Pi 包：`/rv` 命令

安装 Pi 包后可在 Pi 里使用 `/rv`：

```
/rv models
/rv @src/foo.ts
/rv --mode challenge @docs/design.md
/rv --continue <handle> --mode challenge --model provider/model "expand finding 2"
```

跟进审查时，`--continue` 与首次 `/rv` 一样可**选填** `--mode`、`--model`（以及后续 CLI 支持的其它选项由 skill 直接调用 CLI 时传入）。

`/rv` 会向主会话注入**英文任务说明**（Pi 宿主策略：默认流式、**不要**自动加 `--no-stream` / `--progress-log`），由主 Agent 调用 `pi-review` CLI。普通 `/rv @path` 无需额外参数。需要整段缓冲时显式 `/rv --no-stream`；Claude Code 等宿主见英文 README 的 `--progress-log`。

## 输出格式

审查结果包含 `## Verdict`、`## Summary`、`## Findings` 等章节，并以 **ASCII 页脚**（`── pi-review` 框线 + Verdict/Mode/Duration/Session）结尾；机器可读 JSON 在 **stderr** 一行 `PI_REVIEW_META_JSON:`（需写 stdout 时设 `PI_REVIEW_META_STDOUT=1`）。

## 配置

提交代码：`npm install` 后会启用 **Husky** 钩子（`.husky/` → `ai-commit` 的 prepare-commit-msg / commit-msg / pre-commit）。也可 `git add` 后直接 `ai-commit commit`。配置见 `.ai-commit.yaml`（英文、`ai_footer: off`，需本机安装 ai-commit ≥ v0.1.45）。

可通过 `PI_REVIEW_HOME`、`PI_REVIEW_PRESETS`、`PI_REVIEW_SYSTEM_PROMPT` 等环境变量覆盖预设与系统提示词路径。预设与审查指令文件内容均为英文。

## 安全

- 每次审查在隔离子进程中运行
- 默认不保留子会话；`--keep-session` 仅用于显式跟进
- 审查会话只读，不编辑、不部署

## 许可

[MIT](LICENSE) © ZephyrDeng