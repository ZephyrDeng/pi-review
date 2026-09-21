# Loop 审查

[English](../loop-review.md)

> **这页解决什么问题：** 让 agent "改一轮、审一轮" 直到干净，同时保证**审查方永远不动代码、循环永远有上限**。适合 agent 收尾阶段：改完之后想要一个客观的"可以停了"信号。

`pi-review loop` 对当前工作树连续跑若干轮完整、隔离的审查：

```bash
pi-review loop --max-rounds 3 -- @src
pi-review loop --until clean --max-rounds 10 -- @src
pi-review loop --mode challenge --max-rounds 2 -- @docs/design.md
```

每一轮都只审不改。这个进程从不编辑、不打补丁、不等待文件变化，也不会要求子会话去修 finding。遇到 `clean`、`needs_human` 或 `blocked` 立即停止；否则跑完轮次预算后停止。每轮按顺序输出一行 `PI_REVIEW_META_JSON`，最后的人类可读摘要列出每轮的状态、结论、耗时和 finding 数。

每轮的 `PI_REVIEW_META_JSON` 与 [机器 finding schema](output-and-integration.md#机器-finding-schema) 里描述的富化结构完全一致——`metaVersion`、每条 finding 的 `details`/`recommendation`/`location`，面板轮次还有 `sourceFindings`。想拿某一轮的富化 findings，按输出顺序直接读那一轮的 stderr 行即可，不需要解析 Markdown，也不需要改 `LoopRoundSummary`。

## 谁来修：宿主驱动的门禁

把 `loop` 理解成一个只会说"过 / 不过"的门卫，而不是修理工。有 finding 剩下时，由宿主 agent 或人**只修被接受的、在范围内的** finding，然后再次调用 `loop`。

- 想逐个补丁收尾：`--max-rounds 1`，每审一次给宿主一个修复点。
- 想要明确的"直到干净"目标且有硬上限：`--until clean`（省略 `--max-rounds` 时默认预算 10，永不无限）。

"干净"指没有卡门禁的 finding：单评审员是没有 actionable finding；面板是没有 confirmed actionable cluster，advisory 可以残留。`loop` 接受普通审查的 target / model / progress 选项，但 v1 不接受 `--keep-session`、`--continue`、`--name`。

## 跨轮对比

从第 2 轮起，每轮都会和上一轮的 actionable findings 做差分（loop 摘要里的 `vs prev: =persisting · +new · -resolved`）。先做确定性匹配；启用 Jev 增强后，措辞漂移的配对由 Jev 裁决，与面板共识同一套机制。对比只是记账，**从不作为门禁输入**，匹配器失败时静默退化为"无对比"。

在 `--until clean` 下，如果连续两轮 actionable 集合完全相同（全部 persisting，没有新增也没有解决），loop 会提前停止并给出 `Stop: non_converging`——两轮之间代码树没变，再跑下去只是掷骰子，宿主应该先修再重新调用。

## 常见误解

- **"loop 会帮我修代码"** → 不会。它只审，修改永远由宿主完成。
- **"`--until clean` 会一直跑下去"** → 不会，硬上限默认 10 轮，收敛检测还会更早停下。
- **"advisory 也要清零才算 clean"** → 不用，advisory 不卡门禁。
