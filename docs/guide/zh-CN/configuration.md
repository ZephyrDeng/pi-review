# 配置

[English](../configuration.md)

> **这页解决什么问题：** 绝大多数用户一行配置都不用写——默认就是隔离、只读、安全的。最常见需要来这里的两种情况：你的模型 provider 是通过 Pi 扩展注册的（需要 `childExtensions`），或者你想控制 Jev 是否启用。

持久设置放在审查配置文件 `~/.pi/pi-review/config.json`（用 `PI_REVIEW_CONFIG` 改位置）。配置是建议性的、向前兼容的：未知 key 忽略，`null` 视为未设置，其它任何问题（类型错误、非法 JSON）只打印警告并回退——配置永远不会阻塞核心功能，所以新版 pi-review 写的配置不会把旧版弄坏。在 Pi 里 `/rv-config` 显示生效的配置（值、来源、警告、解析后的路径）。故意没有 `/rv-config set` 命令——推荐的编辑方式是通过 pi-review agent skill 让你的 agent 改：它知道配置结构，会保留未知 key，不会覆盖非法 JSON，也从不写入密钥（API key 一律留在环境变量里，如 `TYPESAFE_API_KEY`；配置文件只放开关）。

| Key | 类型 | 默认 | 说明 |
|-----|------|---------|-------------|
| `childExtensions` | boolean | `false` | 允许审查子进程加载宿主 Pi 扩展，使只通过扩展注册的 provider 可用。等价于单次 `PI_REVIEW_CHILD_EXTENSIONS=1`；`false` 让子进程以 `--no-extensions` 保持隔离（issue #8）。 |
| `jev` | boolean | 自动 | 把面板共识裁决交给 TypeSafe Jev 而不是 Pi 裁决子进程。默认：设置了 `TYPESAFE_API_KEY` 则启用，否则禁用。单次覆盖：`PI_REVIEW_JEV=1` / `=0`。显式 `--consensus-model` 始终保留 Pi 裁决器。 |

按进程覆盖用环境变量（环境变量优先于配置文件）：

| 变量 | 说明 |
|----------|-------------|
| `PI_BIN` | Pi 可执行文件路径（默认 `pi`） |
| `PI_REVIEW_HOME` | 包含 `review-presets.json` 和 `system-prompt.md` 的目录 |
| `PI_REVIEW_PRESETS` | 预设 JSON 文件路径 |
| `PI_REVIEW_PANEL_PRESETS` | 面板预设 JSON 文件路径 |
| `PI_REVIEW_SYSTEM_PROMPT` | 系统提示词文件路径 |
| `PI_REVIEW_SESSION_DIR` | 持久化审查会话的目录 |
| `PI_REVIEW_META_STDOUT` | 设为 `1`/`true` 时把 `PI_REVIEW_META_JSON` 打到 stdout 而不是 stderr |
| `PI_REVIEW_JEV` | `jev` 的单次覆盖：`1`/`true`/`on` 把面板共识裁决交给 TypeSafe Jev，其它任何已设置的值（如 `0`）保留 Pi 裁决器。连接：`TYPESAFE_API_KEY`（必需），可选 `TYPESAFE_BASE_URL` 和 `PI_REVIEW_JEV_MODEL`（默认 `jev-latest`） |
| `PI_REVIEW_CHILD_EXTENSIONS` | `childExtensions` 的单次覆盖：`1`/`true`/`keep` 为本进程启用宿主扩展，其它任何已设置的值（如 `0`）强制隔离；空值视为未设置。持久等价写法：配置文件里 `{ "childExtensions": true }`。带显式 `--provider` 时，pi-review 先探测模型目录，若该 provider 只存在于扩展中则带提示阻塞 |
| `PI_REVIEW_CONFIG` | 审查配置文件路径（默认 `~/.pi/pi-review/config.json`） |
| `PI_REVIEW_SCREEN_PATTERNS` | 额外的 screen 模式目录 JSON 路径，在 `screen-patterns.json` 之后加载并在 id 冲突时胜出——指向仓库内提交的文件即可共享团队模式 |
| `PI_REVIEW_SCREEN_MEMORY` | `0`/`false`/`off` 关闭被标记 hunk 到 `screen-memory.jsonl` 的记录（默认开启） |
| `PI_REVIEW_SCREEN_MEMORY_FILE` | screen memory 日志路径覆盖（默认在配置文件同级的 `screen-memory.jsonl`） |

## 安全模型

把每个评审员想成一个只有阅览权限的访客：能读代码、能搜索，进不了 shell，碰不了文件，走的时候什么也带不走。

- 每次审查和每一轮 loop 都在隔离的 Pi 子会话中运行
- 默认运行使用 `--no-session`——不存储任何子会话上下文
- 子进程默认以 `--no-extensions` 隔离运行，宿主的用量 HUD / 热重载桥接不会在 dispose 后通过过期的扩展上下文搞崩评审员（见 issue #8）。要持久启用宿主扩展加载，在 `~/.pi/pi-review/config.json` 里设 `{ "childExtensions": true }`，或单次用 `PI_REVIEW_CHILD_EXTENSIONS=1`——仅当自定义 provider 确实必须在子进程内注册时才这么做。
- 生效了显式 provider（通过 `--provider` 或 `--model` 的 `provider/` 前缀）时，pi-review 在 spawn 前先探测 Pi 模型目录：如果该 provider 只在加载宿主扩展后才存在，运行会带可操作提示阻塞（`verdictSource: "config_error"`，meta 里 `extensionHint`；面板运行把所有受影响的 provider 汇总进 `extensionHints`），而不是抛一个让人困惑的 unknown-provider 错误——在配置文件里设 `childExtensions: true` 或用 `PI_REVIEW_CHILD_EXTENSIONS=1` 重跑。目录探测只在成功时缓存；瞬时探测失败永远不会阻塞审查。
- 评审员运行失败时，面板页脚和 `reviewers[].runtimeError` 保留子进程 stderr / 堆栈尾部用于诊断
- `--keep-session` 只存储子审查会话，供显式追问
- 审查会话是只读的：不改文件、不打补丁、不提交、不部署
