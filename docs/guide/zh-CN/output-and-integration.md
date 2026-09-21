# 输出格式与集成

[English](../output-and-integration.md)

> **这页解决什么问题：** 审查结果怎么被人读、怎么被脚本读。规则只有一条：**人看 stdout 的 Markdown 和页脚，程序读 stderr 的 `PI_REVIEW_META_JSON` 一行 JSON 和退出码。** 两条通道分开，你的 CI 永远不用去解析 Markdown。

每次审查产出的 Markdown 都有这些固定区块：

```
## Verdict
approve | request_changes | needs_clarification | blocked

## Summary
## Findings
### F1: <summary>
- Severity: critical | high | medium | low
- Path: <path or none>
- Lines: <line or line-range in Path, or none>
- Side: base | working (optional; defaults to working)
- Actionable: yes | no
- Evidence: <concrete evidence>
- Impact: <why it matters>
- Recommendation: <specific next step>

## Risks and Blind Spots
## Open Questions
```

CLI 在 **stdout** 追加一段可读的 ASCII 页脚：

```
── pi-review ────────────────────────────
  Verdict     ! REQUEST CHANGES
  Status      HAS FINDINGS
  Mode        code
  Findings    1 actionable / 1 total
  Model       provider/model
  Thinking    xhigh
  Tokens      in 17.6K · out 512 · cache 2.0K · reason 0 · total 18.2K
  Cost        $0.05
  Duration    42.3s
──────────────────────────────────────────
```

`Thinking` 在设置了思考等级时显示；`Tokens` 显示子会话的 token 用量（`in`/`out`/`cache`/`reason` 与合计），从 `--mode json` 事件流解析得来。`Cost` 显示 provider 报告的总费用，provider 不报告时为 `n/a`。两者都在正常流式过程中收集，不需要 `--progress-log`。

脚本请从 **stderr** 解析 **`PI_REVIEW_META_JSON:`**。原有 key 保留，字段只增不改：

```json
{"metaVersion":1,"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed","status":"has_findings","findings":[{"id":"F1","severity":"high","path":"src/cli.ts","summary":"Dirty reviews exit zero","actionable":true}],"actionableCount":1,"durationMs":42300,"model":"provider/model","thinking":"xhigh","usage":{"input":18031,"output":512,"cacheRead":2048,"cacheWrite":0,"reasoning":0,"totalTokens":18591,"costTotal":0.05}}
```

`verdict` 是评审员说的话，`status` 是门禁的结论，两者的映射固定：`status` 取 `clean`、`has_findings`、`needs_human`、`blocked` 之一——`approve` 且无 actionable finding 为 `clean`；`request_changes` 或存在 actionable finding 为 `has_findings`；`needs_clarification` 为 `needs_human`；运行时 / 致命失败为 `blocked`。每条 finding 一定有 `summary` 和 `actionable`；`id`、`severity`、`path` 在解析到时存在。`thinking` 和 `usage` 是附加字段，子会话报告了才有；`usage` 包含 token 合计，可能包含 `costTotal`。这一行始终是单条只增不改的 JSON 记录，老消费者可忽略未知 key。设 `PI_REVIEW_META_STDOUT=1` 可改为输出到 stdout。

## 机器 finding schema

`PI_REVIEW_META_JSON` 带一个顶层 `metaVersion` 结构判别字段（当前为 `1`）。该字段出现之前的 pi-review 版本输出的 JSON 完全没有 `metaVersion` key——缺失即代表最初的、未富化的契约。以下所有字段在 `metaVersion: 1` 下都是附加的；将来对该结构的破坏性变更会递增此版本号。

每条 finding 在原有 `{ id?, severity?, path?, summary, actionable }` 之外多了三个可选字段：

| 字段 | 类型 | 何时存在 |
|-------|------|--------------|
| `details` | `string` | 评审员的 Evidence / Impact 至少解析到一个。拼成 `"Evidence: <...>"` 和 / 或 `"Impact: <...>"` 两段，用空行（`\n\n`）分隔；只有其一时只带那一段。从不捏造。 |
| `recommendation` | `string` | 评审员的 Recommendation 字段解析结果，逐字保留，与 `details` 分开。 |
| `location` | `{ startLine: number; endLine?: number; side?: "base" \| "working" }` | 评审员的 `Lines` 字段是一个正整数（`42`）或不倒置的正区间（`42-58`）。非数字、零 / 负数或倒置（`endLine < startLine`）的值直接丢弃而不猜测，此时 `location` 缺失。`side` 只可能是 `"base"`（变更前）；其它情况——缺失、无法识别或显式 `"working"`——都省略 `side`，即 `"working"`（变更后）。 |

三者齐全的示例：

```json
{"metaVersion":1,"reviewMode":"code","verdict":"request_changes","verdictSource":"parsed","status":"has_findings","findings":[{"id":"F1","severity":"high","path":"src/cli.ts","summary":"Dirty reviews exit zero","actionable":true,"details":"Evidence: runReview forwards the child exit code.\n\nImpact: A review gate passes with actionable findings.","recommendation":"Map structured status to a stable exit code.","location":{"startLine":42,"endLine":58}}],"actionableCount":1,"durationMs":42300,"model":"provider/model"}
```

这三个 finding 级字段和 `metaVersion` 都是附加的：只读 `{ id?, severity?, path?, summary, actionable }` 的现有消费者不受影响；没有可靠行号的文件级 finding 只是缺少 `location`，Evidence / Impact / Recommendation 解析到了 `details`/`recommendation` 照样填充。这套机器 schema——包括 [Panel 审查 § 机器输出](panel-review.md#机器输出)里的 `sourceFindings` 字段和 [Loop 审查](loop-review.md)里的逐轮输出——是**受支持的集成面**：渲染器直接读 `PI_REVIEW_META_JSON` 即可，永远不需要从审查 Markdown 里抠 Evidence / Impact / Recommendation / 行号。

解析器优先接受上面精确的 `### F1` 形态，也接受旧式 `###` 标题和顶层 finding 列表。缺少 `Actionable` 时，`request_changes` 下的 finding 默认 actionable，其它结论默认非 actionable。缺失 / 无法识别的 verdict 回退为 `needs_clarification` / `needs_human` 并带 `parseError`；运行时失败始终为 `blocked`。

## 退出码

写 CI 或 git hook 时只看这个表就够了：

| 码 | 含义 |
|------|---------|
| `0` | 最终状态为 `clean` |
| `1` | 最终状态为 `has_findings` / loop 预算耗尽 |
| `2` | CLI 用法或参数错误 |
| `3` | `needs_human`——需要澄清或人工决策 |
| `4` | `blocked`——子进程 / 运行时失败，或审查无法进行 |

`3` 和 `4` 故意与 `1` 分开：门禁"没过"和门禁"没跑成"是两回事，别把 `4` 当成"代码有问题"。

## 会话管理

默认每次审查都是一次性子会话，结束即销毁。想追问评审员"第 2 条展开说说"，需要显式保留会话：

```bash
# 保留审查会话以便追问
pi-review --mode challenge --keep-session -- @docs/design.md

# 继续之前的会话（可选参数与首次运行相同）
pi-review --continue <sessionHandle> --mode challenge --model provider/model -- "expand finding 2"
```

## 实时进度与 token 用量

`pi-review` 内部始终以 `--mode json` 运行子进程。流式模式下，它把**可读的文本增量**实时转发到 stdout，并向 stderr 写**语义化里程碑通知**——`pi-review: review started`、`pi-review: tool <name> started/finished`、`pi-review: review finished`。token 用量（`input`/`output`/`cache`/`reasoning`）默认累计，显示在 ASCII 页脚和 `PI_REVIEW_META_JSON` 里——**不需要 `--progress-log`**。

Claude Code、Cursor、Codex、agy 这类 agent 宿主通常把 Bash 工具的 stdout 攒到命令退出才显示。stderr 上的里程碑通知让你不用 tail 文件也能看到进度。最终的 Markdown 审查 + ASCII 页脚在进程退出时到达 stdout。

`--progress-log <path>` 现在是**可选**的精细调试手段：把 `--mode json` 事件流 tee 到文件。默认 tee 是**精简**的——每条 `message_update` 行把累计的消息快照（`assistantMessageEvent.partial` 和重复的顶层 `message`）缩减到只剩 `usage` 字段。逐字 tee 会在每个增量上重复整条"到目前为止的消息"加 provider 元数据，文件随消息长度平方增长（真实审查测到约 1600 倍的字节放大）。增量和消息边界（`message_end`、`turn_end`、`agent_end`）保留完整记录，所以精简日志仍能重建审查并通过 pi-review 自己的事件解析器回放，功能无损。需要逐字流时加 `--progress-log-raw`。`--progress-log` 不再决定 token 是否可见。细节：[`skills/pi-review/SKILL.md`](../../../skills/pi-review/SKILL.md) 和 [`skills/pi-review/references/codex-tools.md`](../../../skills/pi-review/references/codex-tools.md)。

```bash
# 可选：捕获事件日志用于调试（默认精简；加 --progress-log-raw 取逐字流）
pi-review --progress-log /tmp/pi-review.jsonl -- @src/foo.ts &
tail -f -n +1 /tmp/pi-review.jsonl | jq -c --unbuffered '
  select(.type != "message_update" and .type != "tool_execution_update")
'
```

这个 JSON 事件结构是 pi CLI 自己的内部格式，不是 `pi-review` 保证的契约——pi 版本之间可能变化。`pi-review` 防御性地解析它（无法解析的行跳过，缺失事件退化为诊断性的 `parseError`），子进程退出后仍向 stdout 打印同样干净的 Markdown + ASCII 页脚。
