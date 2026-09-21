# CLI 参考

[English](../cli-reference.md)

> **这页解决什么问题：** 五个子命令、二十几个参数，先看"什么场景用哪个"，再查表。

## 先选场景

| 你想要 | 用这个 |
|---|---|
| 提交前 1 秒扫一下已知缺陷模式 | `pi-review screen <paths>` |
| 日常自审、一个模型的意见就够 | `pi-review -- <target>` |
| PR 合并门禁、安全敏感改动、跨模型互证 | `pi-review --reviewers <n>` 或 `--panel <name>` |
| agent 改完让它自己"审到干净" | `pi-review loop --until clean` |
| 上一轮 findings 哪些在任务范围内 | `pi-review classify --baseline ...` |

```
pi-review [review] [options] -- <@files|text...>
pi-review loop [options] -- <@files|text...>
pi-review screen <@files|paths...>
pi-review screen-memory
pi-review classify --baseline <text|@file> [--meta <path>]
pi-review models [search]
```

## 参数

| 选项 | 说明 |
|--------|-------------|
| `--mode <name>` | 审查模式（默认 `code`） |
| `--model <provider/model[:thinking]>` | 审查使用的模型 |
| `--provider <name>` | 模型 provider |
| `--thinking <level>` | 思考等级：`off\|minimal\|low\|medium\|high\|xhigh` |
| `--skill <path>` | 额外加载一个 Pi skill（可重复） |
| `--tools <csv>` | 覆盖允许的工具 |
| `--no-rules` | 不向评审子进程加载 `.claude/rules`（环境变量 `PI_REVIEW_RULES=0`；也接受 `false` / `off` / `no`） |
| `--keep-session` | 保留会话以便追问 |
| `--continue <handle>` | 继续已有会话 |
| `--name <name>` | 会话名（配合 `--keep-session`） |
| `--no-stream` | 缓冲子进程输出到退出（默认实时流式） |
| `--progress-log <path>` | 把精简的子进程 `--mode json` 事件流写入此文件（不能与 `--no-stream` 组合） |
| `--progress-log-raw` | 配合 `--progress-log`：tee 逐字事件流（完整消息快照，文件大得多） |
| `--max-rounds <n>` | loop 的正整数硬预算（默认 `3`；配合 `--until clean` 默认 `10`；仅 `loop`） |
| `--until clean` | loop 目标：一直到门禁 clean（仍受 `--max-rounds` 硬上限；永不无限） |
| `--reviewers <n>` | 面板：独立评审员数量（2–8；启用面板模式） |
| `--panel <name>` | 面板：命名的专家面板预设（不能与 `--reviewers` 组合） |
| `--consensus <policy>` | 面板：`any \| quorum \| majority \| unanimous`（默认 `quorum`） |
| `--min-agree <n>` | 面板：quorum 的最低同意评审员数（默认 `2`；仅 quorum） |
| `--reviewer-model <id=model[:thinking]>` | 面板：逐评审员覆盖模型（可重复，如 `r1=openai/gpt-5.6:high`） |
| `--consensus-model <model>` | 面板：语义共识裁决所用模型 |
| `--concurrency <n>` | 面板：限制评审员并发（默认等于评审员数） |
| `--output-format events-jsonl` | 面板：给渲染器适配器的归一化 `ReviewEvent v1` JSONL |

## 各命令与参数的使用时机

- **`pi-review screen <paths>`**——亚秒级（约 1.0–1.2 s）门禁筛查，不跑 LLM 生成循环。用在 CI/CD 快速路径、pre-commit / pre-push hook，或即时 sanity check，立刻抓已知缺陷模式。
- **`pi-review screen-memory`**——聚合累积的筛查信号日志（`screen-memory.jsonl`）：每个模式的命中频次，以及可以晋升进 `screen-patterns.json` 的重复未匹配信号。见[筛查流程](screening.md)。
- **`pi-review review [options] -- <target>`**——单评审员代码审查。用于日常本地开发和自审，一个模型的文字建议就足够的场景。
- **`pi-review --reviewers <n>`（2–8）**——多评审员面板审查。用于 PR 合并门禁、安全敏感改动，或需要独立一致性的跨模型验证。
- **`pi-review loop [--until clean]`**——多轮审查循环。用于自动化的 agent 修复—验证循环，反复打补丁再审直到干净。
- **`--reviewer-model <id=model[:thinking]>`**——面板模式下给单个评审员指定模型或思考强度（如 `r1=openai/gpt-5:high`、`r2=zenmux/deepseek/deepseek-v4.1-flash:low`）。跨厂商异构面板必备。
- **`--concurrency <n>`**——限制评审员并行数。不传就全速（默认全部并发）。只有 provider 账号有严格并发限制时才传 `<n>`。
- **`--consensus-model <model>`**——显式强制用一个 LLM 子会话当裁决器，而不是 Jev System One。想要对 finding 簇做全文 LLM 推理时用。
- **`--consensus <policy>` / `--min-agree <n>`**——微调面板法定人数。默认 `quorum`、`min-agree: 2`。零容忍的安全发布用 `unanimous`，广撒网找 bug 用 `any`。
- **`--progress-log <path>`**——把精简 JSON 事件流写到文件；在 Claude Code、Codex、Cursor 这类缓冲输出的宿主里后台运行时很有用。
- **`--ui web`**——为面板运行启动本地回环浏览器看板；在 agent 宿主里做可视化检查时推荐。

会话参数（`--keep-session`、`--continue`、`--name`）在 v1 中不被 `loop` 和面板支持；非法组合会打印用法并以 `2` 退出。

## 审查模式

| 模式 | 说明 |
|------|-------------|
| `code`（默认） | 代码、diff、MR、文件和仓库审查。关注正确性、回归、安全、并发、API 契约、边界情况和缺失的测试。 |
| `plan` | 从多个专家视角做宽泛的方案 / 架构审查：工程、产品、安全、QA、运维和 DX。 |
| `challenge` | 对抗式审查，压测假设、依赖、可逆性、失败模式和迁移路径。 |

`plan` 和 `challenge` 的区别：`plan` 问"这个方案完整吗、各方面都考虑到了吗"；`challenge` 问"这个方案哪里会崩、哪个假设不成立"。设计文档定稿前可以两个都跑一遍。

## 快速开始

```bash
# 审查一个文件
pi-review -- @src/foo.ts

# 指定模型
pi-review --model openai/gpt-5.5 -- @src/foo.ts

# 多视角方案审查
pi-review --mode plan -- @docs/architecture.md

# 对抗式 challenge 审查
pi-review --mode challenge -- @docs/design.md

# 有上限的只读门禁（默认 3 轮）
pi-review loop --max-rounds 3 -- @src

# 列出可用模型
pi-review models
```

在 agent 宿主（Claude Code、Codex、Cursor 或 **agy / Antigravity**）里，装一次 skill，然后让宿主跑审查——例如 `/pi-review -- @src/foo.ts` 或能触发 skill 的自然语言：

```bash
npx @zephyrdeng/pi-review install-skill --agent agy
```
