# Pi 包：`/rv` 命令

[English](../pi-package.md)

> **这页解决什么问题：** 在 Pi 里，你不需要记 CLI 参数——三个斜杠命令选策略，后面跟自然语言就行。这页讲这几个命令各自做什么，以及补全为什么"懂"你的模型列表。

装成 Pi 包后，用 `/rv` 斜杠命令：

```
/rv @src/foo.ts
/rv --mode challenge @docs/design.md
```

斜杠命令给父 agent 注入一条任务消息。策略由命令决定（`/rv`、`/rv-loop`、`/rv-models`）；剩下的部分是自然语言目标。`/rv-config` 是只读的：显示生效配置（配置文件、环境变量覆盖、解析后的路径）。在 Pi 里直接用 `/rv @src`、`/rv review the auth changes` 或 `/rv-loop fix until clean @src`——面板运行不需要额外的流式参数。`--continue`、`--keep-session`、loop 和显式 `--no-stream` 保留 shell CLI 路径。

```
/rv models
/rv @src/foo.ts
/rv --mode plan @docs/architecture.md
/rv --mode challenge --keep-session @docs/design.md
```

| 命令 | 做什么 | 走哪条路 |
|---|---|---|
| `/rv <目标>` | 面板审查，评审员在 Pi 里以独立实时行显示 | 原生 `pi_review` 工具 |
| `/rv-loop <目标>` | 多轮 loop 收尾 | shell CLI |
| `/rv-models` | 模型目录 | shell CLI |
| `/rv-config` | 只读显示生效配置 | 本地 |

## 参数补全

参数补全是上下文感知的。宿主会话启动后，`/rv` 读取实时模型注册表并提供：

- **模型列表**（输入 `--model ` 之后）：候选来自实时 Pi 注册表；顺序遵循 **`resources/rv-model-priorities.json`**（用 `PI_REVIEW_RV_PRIORITIES` 覆盖）。预设按子串匹配注册表 id，并偏好更新的版本号（如 kimi `2.7`、`claude-opus-4-8`）。档位：**code / fast**（claude-sonnet-5、deepseek-v4-flash、glm-5.2、minimax-m3、grok-4.5、gpt-5.6-terra/luna）、**frontend / vision**（claude → gpt → kimi-2.7 → minimax-m3）、**plan / complex**（gpt-5.6-sol max、claude-opus-4.8 xhigh、claude-fable-5 max cautious、glm-5.2 / deepseek-v4-pro / grok-4.5 max）。
- **思考等级后缀**（`provider/model:` 之后）——只列所选模型真正支持的等级。
- **语义短语**（如 `code review` / 代码审核、`查看模型列表`），与参数并列；编排提示词的摘要跟随**会话语言**（zh/en）。
- 顶层的**场景模板**（code / frontend / plan 预设）。

**Claude Code / Codex / Cursor / agy：** 随附的 skill 包含 **[skills/pi-review/references/model-selection.md](../../../skills/pi-review/references/model-selection.md)**——与 `/rv` 相同的预设，用于 `pi-review models` 之后选择 `--model`。

补全只是提示层；执行仍由 skill 驱动。模型注册表不可用时（如非 TUI 模式），`/rv` 回退到静态提示列表。
