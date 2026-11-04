# 验证模式（Verify mode）

[English](../verify-mode.md) · 设计文档：[docs/design/verify-mode.md](../../design/verify-mode.md)

`--verify` 在 reviewer 启动前，于工作树的一次性隔离副本里把验证命令（单测、类型检查、lint、最小复现用例）**只跑一次**。所有 reviewer 拿到同一份结果，来源类型标为 `test-output`，结论建立在跑过的证据上。默认关闭；不带 verify 相关参数时行为与原来完全一致。

reviewer 仍然只有只读工具（`read,grep,find,ls`）。命令由 pi-review 自身代码执行，模型不拿 shell。

## 谁决定跑什么

| 来源 | 是否免问直接跑 |
|---|---|
| 常设白名单：**`HEAD` 已提交**的 `.pi-review.json` 里的 `verify.commands` | 是（预批准）。该文件未提交的改动不生效。 |
| 验证计划：宿主 agent 编写（默认），或由 `pi-review verify propose` 起草 | 只跑经 `pi-review verify approve` 记录、由人批准的步骤。 |

其余步骤记为 `skipped_unapproved`，绝不执行。CI 里没有人批准，只跑白名单命令。

## 常设白名单

```json
{
  "verify": {
    "commands": [{ "id": "check", "argv": ["npm", "run", "check"], "timeoutSec": 600 }],
    "link": ["node_modules"],
    "maxFollowUpRounds": 1
  }
}
```

- `argv` 不经 shell 执行；确实需要时显式写 `["sh", "-c", "..."]`。
- `link` 把原树里被忽略的依赖目录软链进副本，免去重装依赖。经软链写入会落到原树对应（被忽略的）目录。
- `maxFollowUpRounds` 限制计划的追加轮数（默认 1，即 `round` 最大为 2）。

```bash
pi-review --verify -- @src            # 跑白名单，再审查
pi-review loop --verify -- @src       # loop 每轮重新验证
```

## agent 提案 + 人批准

```bash
# 1. 宿主 agent 写计划，或让只读 Pi 子进程起草
pi-review verify propose -- @src "待审查的改动" > plan.json

# 2. 展示计划；退出码 5 表示需要人决定
pi-review verify show plan.json

# 3. 用户决定后（宿主用自己的提问工具问）记录批准
pi-review verify approve plan.json --steps unit,repro --reject e2e --by "user via AskUserQuestion" > approval.json

# 4. 带批准的计划做审查
pi-review --verify-plan plan.json --verify-approval approval.json -- @src
```

计划步骤（完整 schema 见[设计文档](../../design/verify-mode.md#plan-schema-version-1)）：

```json
{
  "version": 1,
  "proposer": "host",
  "steps": [
    {
      "id": "unit-gate",
      "argv": ["npx", "vitest", "run", "src/cli-exit.test.ts"],
      "purpose": "论断：has_findings 映射为退出码 1",
      "expectedDurationSec": 20,
      "sideEffects": "副本之外无副作用",
      "idempotent": true,
      "timeoutSec": 120
    }
  ]
}
```

- `purpose` 必填。`expectedDurationSec`、`sideEffects`、`idempotent` 是提案者自评，仅供人参考，从不作为放行依据。
- `files: [{ "path", "content" }]` 新写的测试/复现文件**只写进隔离副本**（同一次运行里后续步骤也能看到）。
- 未知字段一律拒绝。复用白名单 `argv` 的步骤只有在不带 `files`/`cwd`、且 `timeoutSec` 不超过白名单值时才算预批准。
- 批准绑定每个步骤的内容哈希。批准后改动步骤的任何字段，该批准即失效（`stale`，跳过）。
- 追加验证：`pi-review verify run --plan plan.json --approval approval.json` 看到结果后，追加 `"round": 2` 的步骤，再走一遍 show → 询问 → approve。`--verify-approval` 可重复，第 1、2 轮的批准合并生效。

## reviewer 与脚本看到什么

reviewer prompt：多一节 `## Verification evidence (source type: test-output)`，逐步列出命令、目的、批准来源、退出码、耗时、输出末尾 4000 字符（已脱敏，并声明为不可信数据）。reviewer 以 `Evidence: test-output <step id>` 引用。

页脚：`Verify  passed · 2 run / 0 skipped`。

`PI_REVIEW_META_JSON` 新增可选 `verification` 对象（单 reviewer 与 panel 都有；`metaVersion` 仍为 `1`），字段见[英文版示例](../verify-mode.md#what-reviewers-and-scripts-see)。

| `status` | 含义 |
|---|---|
| `passed` | 所有步骤都跑了且通过 |
| `partial` | 跑了的步骤都通过，有步骤被跳过 |
| `failed` | 有步骤失败、超时或出错 |
| `unverified` | 一条都没跑（见 `reason`），或验证期间原工作树发生变化 |

命令失败本身是证据，pi-review 照常完成；审查退出码仍由 reviewer 决定。`pi-review verify show` 用退出码 `5` 表示"需要批准"。

## 安全默认

- 隔离：用一次性 index 生成 `HEAD` + 未提交改动 + 未跟踪（非忽略）文件的快照，`git worktree add --detach` 检出（禁用 hooks），结束后删除。前后比对原树 `git status`。
- 每步超时（默认 300s，上限 1800s）会杀掉整个进程组；输出有上限。
- 环境变量白名单（`PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TERM TMPDIR TZ`，另加 `CI=1`）；名字像密钥的（`*KEY*`、`*TOKEN*`、`*SECRET*` 等）一律剔除。

**信任边界：** 验证会以你的权限在本机执行仓库代码。隔离副本保护的是工作树，保护不了本机。只在你本来就会跑 `npm test` 的仓库上用 `--verify`，批准前先读 `pi-review verify show` 的输出。
