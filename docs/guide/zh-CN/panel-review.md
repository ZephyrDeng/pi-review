# Panel 审查

[English](../panel-review.md)

> **这页解决什么问题：** 一个模型审代码，你得到的是"一种看法"。面板审查让 2–8 个**互相看不见**的评审员各自独立审，默认只有多人同时指出的问题才卡门禁（阈值可调，见下文共识策略）——这和论文同行评审、飞机上多套独立冗余系统是同一个思路：一致性来自独立发现，而不是互相附和。

面板审查在隔离的子会话里运行多个**独立**评审员，把他们的 findings 聚合成一个门禁结果。评审员看不到彼此的 findings，所以"多人同意"代表独立发现。

```bash
# 单次面板审查
pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
# 专家预设（正确性、安全、测试三个视角）
pi-review --panel code-experts --consensus majority -- @src
# 面板 + loop（最多 评审员数 × max-rounds 次评审员运行 + 裁决）
pi-review loop --reviewers 3 --consensus quorum --max-rounds 2 -- @src
```

## 共识

一条 finding 只有在足够多的独立评审员都把它标为 **actionable** 时，才成为 **confirmed finding**（影响门禁）；否则它是不卡门禁的 **advisory**。多评审员面板默认 **quorum**、最低同意数 **2**，这样面板模式不会悄悄退化成"任何一人说有问题就失败"；单评审员保持阈值 1。

| 策略 | 阈值 |
|--------|----------|
| `any` | 一个评审员标 actionable 即确认 |
| `quorum`（默认） | 配置的最低同意数（默认 2；`--min-agree`） |
| `majority` | `floor(评审员数 / 2) + 1` |
| `unanimous` | 全体评审员 |

孤证（无人佐证）的 finding 仍以 **advisory** 形式可见，但不改变 clean 状态、不让门禁失败。有 confirmed actionable cluster 则结果为 `has_findings`；没有则为 `clean`。

**怎么选策略：** 安全发布、零容忍场景用 `unanimous`；广撒网找 bug 用 `any`；日常 PR 门禁用默认的 `quorum`。

## 聚合

三个评审员各自写"`cli.ts` 第 42 行退出码不对"，措辞不同但是同一个问题，得合并成一条才能数票。聚合分两阶段：先按稳定锚点（路径 + 归一化摘要）做确定性匹配；只有同路径下仍然歧义的候选才交给受限的**语义裁决器**（用 `--consensus-model` 启用）。裁决器只负责把 findings 聚成簇，不能新造 finding、不能删 finding、不能补证据，也不能充当另一个评审员——它没有任何写工具。低置信度的匹配会保持为独立 advisory，避免"看起来有点像"被拿来凑票。

### 裁决引擎（Jev 增强模式）

当 `TYPESAFE_API_KEY` 存在（或配置文件里设了 `{ "jev": true }`）时，裁决决策改由 [TypeSafe Jev](https://typesafe.ai) 处理——它是一个返回类型化概率的 System One 模型——而不是再起一个只读的 Pi 子会话。每对歧义 finding 变成一个 Noul 问题（"是同一个底层问题吗？"），一次调用内全部并发发出；配对概率作为合并置信度，走和 LLM 合并完全相同的阈值和来源校验。一次完整子会话被一个约 100 ms 的类型化调用取代。

- **完全连接聚类（Complete-Linkage）**：内置完全连接算法保证聚类精度 100%，杜绝同一函数内多条 findings 被链式误合并。
- **跨轮 loop 记忆**：多轮审查（`loop`）中，评审员每轮措辞自然漂移，Jev 仍能保持真实的状态连续性。在标准 fixture 上，开启 Jev 得到 **`=7 persisting · +0 new · -0 resolved`**（Gemini 3.8 Flash）和 `=8~9 persisting`（混合 Flash 组合）；而确定性字符串匹配完全失忆（`=0 persisting · +6~11 new · -6~11 resolved`）。
- **配额效率**：裁决走独立的轻量 System One 通道，不消耗评审员 LLM 的 token 配额和上下文窗口。
- **级联**：概率落在边界带（0.3–0.7）的配对会由 Pi 裁决器在一次额外调用中复判一次——清楚的情况从不花 LLM 的钱，拿不准的情况得到第二意见，Pi 失败时安全地保留 Jev 的判断。显式 `--consensus-model` 让 Pi 裁决器处理全部；`PI_REVIEW_JEV=0` 单次禁用 Jev；任何 Jev 失败都回退到 Pi 裁决器。见[可视化对比报告](../../research/jev-comparison-report.html)和[裁决案例研究](../../research/jev-adjudication-case.md)。

### 范围分类（`pi-review classify`）

agent 收尾时常见的争论是"这条 finding 算不算本次任务范围内"。同一个 Jev 后端可以把上一次审查的 actionable findings 对照你冻结的任务基线做分类——把范围判断从主观拿捏变成类型化决策：

```bash
pi-review classify --baseline "fix the login crash; UI polish is out of scope" --meta /tmp/last-review-meta.txt
# 或直接用管道接审查输出：
pi-review -- @src 2>&1 | pi-review classify --baseline "..."
```

每条 actionable finding 对应一个 Choice 问题（`in_scope_blocker` | `follow_up` | `stop_and_escalate`），一次调用内全部并发。输出为 ASCII 摘要加 stderr 上的 `PI_REVIEW_CLASSIFY_JSON` 机器行；置信度低于 0.5 的 finding 会标为低置信度。classify 是建议性的、由宿主调用——它从不编辑、自身从不阻塞门禁，且需要 `TYPESAFE_API_KEY`（没有则退出码 4）。

### 门禁级筛查（`pi-review screen`）

screen 把 Jev 推到流水线最左边：不再让 LLM 评审员生成 findings（每轮 30 秒以上）再事后裁决，而是对确定性切出的代码块直接向 Jev 提类型化问题，再从缺陷模式目录里组装 findings——关键路径上完全没有 LLM 散文。在[筛查 fixture](../../research/jev-screening-case.md)上端到端实测：一个 106 行的 service（12 个代码块、108 个问题、一次调用）**约 1.2 秒**，同一文件完整审查一轮需要 32–53 秒。

```bash
pi-review screen src/order-service.ts     # 或 @file 引用；有 finding 退出 1，干净退出 0
```

端到端架构：

```
files ─► 1. deterministic slice            (local, ms — declaration-boundary hunks)
            │
            ├─► 2. one Jev call            (~1s — per hunk: 1 catch-all Noul
            │     "any blocking defect?"     + 1 Noul per catalog pattern;
            │     fanned out in parallel, chunked past 480 questions)
            │
            └─► 3. template assembly       (local, ms — pattern hit ⇒ finding
                  + gate                    from catalog severity/title/fix;
                                            catch-all hit without a pattern ⇒
                                            "unmatched signal" finding, still
                                            blocks — never silently dropped)
```

`ReviewFinding` 各字段由谁产生：`id`/`path`/`location` 来自切片器（确定性），`severity`/`summary`/`recommendation` 来自命中的目录模式模板，`actionable` 是阈值化后的概率——LLM 的散文角色缩小到目录之外的新型缺陷和跨块推理，这部分由"unmatched signal" finding 交还给完整的 `pi-review` 运行。目录（`src/screen.ts` 里的 `SCREEN_PATTERNS`）是覆盖率旋钮：目前内置八种模式（循环差一、放任不管的 async、SQL 注入、slice 差一、浮点算钱、浮点相等、缓存别名、缺少校验）；历史上反复出现 unmatched signal 时就往里加条目。输出为 ASCII 摘要加 stderr 上的 `PI_REVIEW_SCREEN_JSON` 机器行（状态、findings、每块概率、用量）；退出码与 review 一致（0 clean、1 has_findings、4 blocked / 无 key）。screen 是快速门禁和分诊层，不替代有证据支撑的完整审查——见[交互式可视化报告](../../research/jev-screening-report.html)、[场景与架构指南](../../research/jev-screening-guide.md)和[测量案例研究](../../research/jev-screening-case.md)。

## 成本与失败

评审员运行次数 = `--reviewers <n>` × `--max-rounds`（loop）；设了 `--consensus-model` 时每轮可能多一次裁决调用。用 `--concurrency <n>` 限制对 provider / 机器的压力（默认等于评审员数，不会超过）。评审员运行失败 → `blocked`；输出无结构的脏内容或有未解决的澄清 → `needs_human`；绝不静默 clean。面板审查拒绝 `--keep-session`、`--continue`、`--name`（评审员以 `--no-session` 运行）；宿主 agent 始终是唯一的编辑者。

面板结束后，CLI 在 **stdout** 追加一段面板 ASCII 页脚：门禁状态、健康度、共识、confirmed / advisory 数量、评审员不一致时的 mixed 模型 / 思考等级、合计 token / 费用、是否用了裁决器，以及每位评审员一行：

![CLI 面板页脚：NEEDS HUMAN 门禁，2/3 评审员成功，quorum 共识，confirmed findings、advisories、混合模型与每位评审员状态](../../assets/panel-cli-footer.jpg)

## 机器输出

一次面板评估输出**一条**聚合的 `PI_REVIEW_META_JSON` 记录，附加字段有：`strategy: "panel"`、`configuredReviewers`、`successfulReviewers`、`consensusPolicy`、`consensusThreshold`、`panelHealth`、`confirmedClusters`、`advisories`，以及逐 `reviewers` 的结果。顶层 `findings` 只包含 confirmed clusters；advisories 单独存放。原有单评审员的 key 保持不变，老消费者可以忽略新字段。面板级 `model` 在所有评审员一致时是各自的有效模型（配置的，否则是 provider 报告的 `responseModel`），评审员跑在不同模型上时是字面哨兵值 `"mixed"`——解析 `model` 的程序必须预期这个值；每位评审员条目保留各自的 `model`/`responseModel`。

面板机器元数据另外携带 `sourceFindings`：每位参与评审员的原始 findings，各自打上全局唯一 `id`（如 `"r1#F1"`）和 `reviewerId`。这样 `confirmedClusters[].sourceFindingIds` 与 `advisories[].sourceFindingIds` 引用的每个 id 都能解析到完整的富化 finding——评审员 Markdown 提供了的话，包含 `details`/`recommendation`/`location`（见[机器 finding schema](output-and-integration.md#机器-finding-schema)）。cluster 级摘要保持现状：只有 `summary`/`severity`/`path`，没有富化字段。

## Pi 实时进度与事件回放

在 Pi 里，斜杠命令只负责选策略：

- `/rv <自然语言目标>` → 通过原生 `pi_review` 跑面板审查
- `/rv-loop <自然语言目标>` → 通过 shell CLI 跑 loop 收尾
- `/rv-models` → 模型目录

目标保持你写的自然语言。像 `@src` 这样的路径提及仍是文本；CLI 把目录保留为工具路径目标，只附加真实存在的文件。其余策略匹配在 skill / CLI 里。在 Pi 里，面向用户的工具名是 **Pi Review Panel**（API 标识符仍为 `pi_review`）；每位评审员渲染为独立的实时行，带明确的 `queued/running/completed/failed/cancelled` 状态、当前工具、已用时间和 token 用量。`Ctrl+O` 展开工具结果可看到有界的活动记录、最终 findings / 来源、耗时、token 合计和费用。

![Pi Review Panel 实时进度：code-experts 面板的正确性、安全、测试评审员，各自显示状态、模型、思考等级、token 与费用](../../assets/panel-live-pi.jpg)

示例：`pi-review --panel code-experts -- @src`（或在 Pi 里用同一面板策略的 `/rv`）。

想自己做渲染器？可以直接消费稳定、带版本的事件流：

```bash
pi-review --panel code-experts --output-format events-jsonl -- @src
```

此模式只向 stdout 写 `ReviewEvent v1` JSONL。事件共用一个 `runId`，`seq` 单调递增，活动文本有界且已脱敏，最后恰好以一条 `panel.completed` 事件结束，其中包含与默认 CLI 路径相同的 `PanelReviewMeta`。reducer 以 `createPanelViewState()` 和 `reducePanelEvent()` 导出，用于确定性的实时投递和回放。

面板评审员使用硬白名单 `read,grep,find,ls`。shell 和有修改能力的工具在评审员启动前就被拒绝。`Ctrl+C` 取消评审员和裁决器的进程树，发出取消生命周期事件，并产生一条 blocked 的最终事件。

## 本地网页看板

Claude Code、Codex 这类宿主会把 Bash 工具的输出攒到命令结束才显示，你看不到评审员在干什么。`--ui web` 为这类没有原生 Pi 渲染器的宿主（也包括纯终端）启动一个可选的、只监听本机回环地址的看板：

```bash
pi-review --reviewers 3 --consensus quorum --ui web -- @src
```

![审查中的网页看板：评审员 / 耗时 / token / 工具调用汇总计数，以及每位评审员的 RUNNING 状态卡片、模型、思考等级和实时活动](../../assets/panel-web-dashboard.jpg)

CLI 向 stderr 打印 `PI_REVIEW_UI_URL: http://127.0.0.1:<port>/run/<token>`，并在评审员开始前用默认浏览器打开（`--no-ui-open` 关闭自动打开）。看板实时显示每位评审员的状态、流式活动、动画 token / 工具调用计数；运行结束后显示门禁结果、confirmed findings / advisories，以及每位评审员由 markdown 渲染的完整报告。`--ui-url-file <path>` 另外把 URL 原子地写入文件，方便缓冲 stdout / stderr 的宿主读取。审查进程仍在运行结束时立即以正常的面板退出码退出。

结束后页面显示 60 秒倒计时，随后自行关闭并停止看板服务；任何交互（滚动、点击、按键或"Keep open"按钮）都会取消倒计时，之后关闭标签页也会停止服务。作为兜底，服务在有界的空闲 TTL 后自行终止（默认 900 秒；`--ui-ttl <seconds>` 覆盖），所以刷新后浏览器还能重连。

看板只绑定 `127.0.0.1`/`::1`，每次运行用高熵的 capability URL 保护，发送严格的 CSP、无远程资源、无 CORS，所有评审员 / finding 文本都通过安全的 DOM 写入渲染（markdown 由内置渲染器解析；链接仅限 http/https，不经过 innerHTML）。它是只读视图：取消操作仍归发起的终端 / agent 宿主（`Ctrl+C`）。`--ui web` 需要一个活跃的面板，不能与 `loop` 组合。
