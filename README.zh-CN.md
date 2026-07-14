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
# 一键：Pi 包 + Claude Code / Codex / Cursor 等 skill（推荐首次安装）
npx @zephyrdeng/pi-review install
# 仅 Pi 包
pi install npm:@zephyrdeng/pi-review
# 仅各 Agent skill
npx @zephyrdeng/pi-review install-skill
```

`install` 会在有 Pi CLI 时执行 `pi install npm:@zephyrdeng/pi-review`，再通过 [skills CLI](https://www.npmjs.com/package/skills) 非交互安装 agent skill。只用 Pi 时**不要**再跑 `install-skill`，避免与 `pi.skills` 重复冲突。可用 `--pi-only` / `--agents-only` 拆分。

## 快速开始

```bash
pi-review -- @src/foo.ts
pi-review --model openai/gpt-5.5 -- @src/foo.ts
pi-review --mode plan -- @docs/architecture.md
pi-review --mode challenge -- @docs/design.md
pi-review loop --max-rounds 3 -- @src
pi-review models
```

## 审查模式

| 模式 | 说明 |
|------|------|
| `code`（默认） | 代码、diff、MR、文件与仓库审查 |
| `plan` | 多视角方案 / 架构审查 |
| `challenge` | 对抗式审查，压测假设与证据缺口 |

## Loop Review

`pi-review loop` 会对当前工作树执行有上限的、彼此隔离的只读审查轮次：

```bash
pi-review loop --max-rounds 3 -- @src
```

每轮都是完整 review run；命令不会编辑、打补丁、等待文件变化，也不会让子会话修复问题。遇到 `clean`、`needs_human`、`blocked` 会提前停止；仍有 actionable finding 时，在预算耗尽后以非零状态退出并输出逐轮摘要。宿主 Agent 或人工负责筛选并修复任务范围内的问题，再重新调用命令。需要在每次修复之间留出宿主处理点时，使用 `--max-rounds 1`。

`loop` 复用普通审查的 mode/model/progress/target 参数；v1 明确不支持 `--keep-session`、`--continue`、`--name`。

## Panel Review（面板审查）

面板审查让多个**独立**审查者在隔离子会话中并行评审，再聚合为同一个门禁结论。审查者看不到彼此的发现，因此一致代表独立发现。

```bash
# 单次面板审查
pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
# 专家预设（正确性 / 安全 / 测试三视角）
pi-review --panel code-experts --consensus majority -- @src
# 面板 loop（最多 reviewer 数 × max-rounds 次审查 + 仲裁）
pi-review loop --reviewers 3 --consensus quorum --max-rounds 2 -- @src
```

### 共识（Consensus）

只有当足够多的独立审查者把同一问题标为 **actionable** 时，该 finding 才成为 **confirmed finding**（参与门禁）；否则保留为非阻塞的 **advisory**（建议）。多审查者面板默认 **quorum**，最低同意数 **2**，避免面板模式悄悄退化为"任一发现即 fail-closed"；单审查仍为阈值 1。

| 策略 | 阈值 |
|------|------|
| `any` | 1 个 actionable 审查者即确认 |
| `quorum`（默认） | 配置的最低同意数（默认 2，用 `--min-agree`） |
| `majority` | `floor(审查者数 / 2) + 1` |
| `unanimous` | 全体审查者 |

单条（未被交叉印证的）发现作为 **advisory** 可见，但不改变 clean 状态、不会让门禁失败。确认的可操作簇产生 `has_findings`；无确认簇则产生 `clean`。

### 聚合

两阶段匹配：先用稳定锚点（路径 + 归一化摘要）做确定性匹配；只有路径相同、措辞不同的模糊候选才交给受限的**语义仲裁器**（用 `--consensus-model` 启用）。仲裁器只能聚类，不得发明 finding、丢弃 finding、补充证据或充当额外审查者，且没有写工具。低置信匹配保持为独立 advisory，避免靠"相似"制造虚假共识。

### 成本与失败

审查者运行数 = `--reviewers <n>` × `--max-rounds`（loop）；启用 `--consensus-model` 时每轮最多再跑一次仲裁。用 `--concurrency <n>` 限制并发（默认等于审查者数，不超过）。审查者运行时失败 → `blocked`；无法解析的脏输出或未决澄清 → `needs_human`；绝不悄悄 clean。面板审查 v1 不支持 `--keep-session`、`--continue`、`--name`（审查者用 `--no-session`）；宿主 Agent 仍是唯一可编辑者。

### 机器输出

一次面板评估只输出**一条**聚合 `PI_REVIEW_META_JSON`，新增字段：`strategy: "panel"`、`configuredReviewers`、`successfulReviewers`、`consensusPolicy`、`consensusThreshold`、`panelHealth`、`confirmedClusters`、`advisories` 以及每个 `reviewers` 的结果。顶层 `findings` 只含确认簇；advisory 单独存放。旧字段保留，老消费者可安全忽略新字段。

## Pi 包：`/rv` 命令

安装 Pi 包后可在 Pi 里使用 `/rv`：

```
/rv models
/rv @src/foo.ts
/rv --mode challenge @docs/design.md
/rv --continue <handle> --mode challenge --model provider/model "expand finding 2"
```

跟进审查时，`--continue` 与首次 `/rv` 一样可**选填** `--mode`、`--model`（以及后续 CLI 支持的其它选项由 skill 直接调用 CLI 时传入）。

`/rv` 会向主会话注入**英文任务说明**（**仅 Pi 宿主**：默认流式，无需 `--no-stream` / `--progress-log`），由主 Agent 调用 `pi-review` CLI。普通 `/rv @path` 无需额外参数。需要整段缓冲时显式 `/rv --no-stream`。

**Claude Code / Codex 等 Agent 宿主**：`pi-review` 默认把可读文本增量流到 stdout，把**语义化里程碑**写到 stderr（`pi-review: review started` / `pi-review: tool <name> started/finished` / `pi-review: review finished`）；token 用量默认就能拿到，无需 `--progress-log`。`--progress-log` 退化为可选的调试用全量事件日志。详见 `skills/pi-review/SKILL.md`、`skills/pi-review/references/codex-tools.md` 与英文 README。

## 输出格式

审查结果包含 `## Verdict`、`## Summary`、`## Findings` 等章节。每条 finding 使用 `F1 + Severity + Path + Actionable + Evidence + Impact + Recommendation` 结构。ASCII 页脚会显示 Verdict、`Status`、finding 数量、Mode、Duration/Session。

机器可读 JSON 仍在 **stderr** 的单行 `PI_REVIEW_META_JSON:` 中，并以新增字段提供：

- `status`: `clean | has_findings | needs_human | blocked`
- `findings`: `{ id?, severity?, path?, summary, actionable }[]`
- `actionableCount`: 可操作问题数量

旧字段不删除；需改为写入 stdout 时设 `PI_REVIEW_META_STDOUT=1`。解析器优先识别上述 `### F1` 格式，也兼容旧的三级标题和顶层列表；缺少 `Actionable` 时，`request_changes` 下默认可操作，其它 verdict 默认不可操作。无法识别 verdict 时会回退到 `needs_human` 并附带 `parseError`，运行时失败始终保持 `blocked`。

退出码：`0` clean、`1` 最终状态为 `has_findings` / loop 预算耗尽、`2` 参数错误、`3` needs human、`4` blocked / 运行时失败。

## 配置

提交代码：`npm install` 后会启用 **Husky** 钩子（`.husky/` → `ai-commit` 的 prepare-commit-msg / commit-msg / pre-commit）。也可 `git add` 后直接 `ai-commit commit`。配置见 `.ai-commit.yaml`（英文、`ai_footer: off`，需本机安装 ai-commit ≥ v0.1.45）。

可通过 `PI_REVIEW_HOME`、`PI_REVIEW_PRESETS`、`PI_REVIEW_SYSTEM_PROMPT` 等环境变量覆盖预设与系统提示词路径。预设与审查指令文件内容均为英文。

## 安全

- 每次审查在隔离子进程中运行
- 默认不保留子会话；`--keep-session` 仅用于显式跟进
- 审查会话只读，不编辑、不部署

## 许可

[MIT](LICENSE) © ZephyrDeng