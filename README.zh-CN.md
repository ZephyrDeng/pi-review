<div align="center">

# pi-review

**隔离、多评审员的 AI 代码审查 —— 既是 CLI，也是 CI 门禁，也是 agent skill。**

[![npm version](https://img.shields.io/npm/v/@zephyrdeng/pi-review.svg)](https://www.npmjs.com/package/@zephyrdeng/pi-review)
[![npm downloads](https://img.shields.io/npm/dm/@zephyrdeng/pi-review.svg)](https://www.npmjs.com/package/@zephyrdeng/pi-review)
[![GitHub stars](https://img.shields.io/github/stars/ZephyrDeng/pi-review?style=flat&logo=github)](https://github.com/ZephyrDeng/pi-review/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[快速开始](#快速开始) · [特性](#为什么选-pi-review) · [筛查流程](docs/guide/zh-CN/screening.md) · [Panel 审查](docs/guide/zh-CN/panel-review.md) · [CLI 参考](docs/guide/zh-CN/cli-reference.md) · [English](README.md)

</div>

---

`pi-review` 把审查交给一个全新的、**只读**的 [Pi](https://pi.dev) 子会话，返回结构化结论：带严重度、证据、位置的 findings，以及稳定的退出码。可以跑单个评审员，也可以跑一个**互相隔离的评审员面板**，多人达成共识的 finding 才会卡门禁。你的 agent（Claude Code、Codex、Cursor、Pi）始终是唯一的编辑者。

```bash
npm install -g @zephyrdeng/pi-review
pi-review -- @src/foo.ts                                      # 单评审员
pi-review --panel code-experts --consensus majority -- @src   # 三个视角，一个门禁
```

<p align="center">
  <img src="docs/assets/panel-live-pi.jpg" alt="Pi Review Panel：正确性、安全、测试三位评审员实时运行，显示模型、token 与费用" width="820">
</p>

## 为什么选 pi-review

| | |
|---|---|
| **隔离、只读的评审员** | 每次审查都是独立子进程，工具硬白名单 `read,grep,find,ls`。不会改文件、不会提交、不会带走主会话上下文。 |
| **面板共识，而非一家之言** | 2–8 个互不可见的独立评审员。只有足够多人同意（`any` / `quorum` / `majority` / `unanimous`）的 finding 才卡门禁；孤证保留为 advisory。 |
| **每个评审员可用不同模型** | `--reviewer-model r1=openai/gpt-5.6:high --reviewer-model r2=anthropic/claude-opus-4.8:xhigh`，跨厂商面板互补盲区。 |
| **机器可读、宿主无关** | 一行带版本号的 `PI_REVIEW_META_JSON`、退出码 `0/1/3/4`、`events-jsonl` 事件流。直接接 CI、hook 或自研渲染器。 |
| **给 agent 收尾用的 loop 门禁** | `pi-review loop --until clean` 每轮修复后重审、跨轮对比 findings、收敛即停，永不无限循环。 |
| **约 1 秒的筛查** | `pi-review screen` 完全不跑 LLM 生成：确定性切片 + [Jev](https://typesafe.ai) 类型化判断对照缺陷目录。实测 **1.2s**，完整审查一轮需 30–50s。 |
| **处处可见进度** | Pi 内原生实时行；Claude Code / Codex 用本地**网页看板**；纯终端用 stderr 里程碑。 |
| **三种审查模式** | `code`（正确性、安全、测试）、`plan`（六个专家视角）、`challenge`（对抗式压测）。JSON 预设可扩展。 |

## 效果一览

<table>
<tr>
<td width="50%"><img src="docs/assets/panel-cli-footer.jpg" alt="CLI 面板页脚：门禁状态、共识、确认 findings、advisories 与每位评审员状态"></td>
<td width="50%"><img src="docs/assets/panel-web-dashboard.jpg" alt="网页看板：每位评审员实时卡片、token 与工具调用计数"></td>
</tr>
<tr>
<td align="center"><sub>任意终端里的面板页脚：门禁、共识、费用、逐评审员状态</sub></td>
<td align="center"><sub><code>--ui web</code>：给会缓冲 stdout 的宿主看的网页看板</sub></td>
</tr>
</table>

每次审查以结构化报告和一眼可读的页脚收尾：

```
── pi-review ────────────────────────────
  Verdict     ! REQUEST CHANGES
  Status      HAS FINDINGS
  Mode        code
  Findings    1 actionable / 1 total
  Model       provider/model
  Tokens      in 17.6K · out 512 · cache 2.0K · total 18.2K
  Cost        $0.05
  Duration    42.3s
──────────────────────────────────────────
```

脚本从 stderr 读 `PI_REVIEW_META_JSON:`，每条 finding 带 `severity`、`path`、`location`、`details`、`recommendation`，无需解析 Markdown。→ [输出与集成](docs/guide/zh-CN/output-and-integration.md)

## 快速开始

**前置条件：** 已安装 [Pi CLI](https://pi.dev) 并配置至少一个模型 provider。

```bash
# CLI
npm install -g @zephyrdeng/pi-review

# 或一键：Pi 包 + Claude Code / Codex / Cursor / Antigravity 的 skill
npx @zephyrdeng/pi-review install
```

```bash
pi-review -- @src/foo.ts                                   # 单次审查
pi-review --mode plan -- @docs/architecture.md             # 多视角方案审查
pi-review --reviewers 3 --consensus quorum -- @src         # 面板
pi-review loop --until clean --max-rounds 5 -- @src        # 有上限的修复/重审门禁
pi-review screen src/order-service.ts                      # 约 1s 目录筛查
pi-review models                                           # 我能用哪些模型？
```

在 Pi 里：`/rv @src`、`/rv-loop fix until clean @src`、`/rv-models`。在其它 agent 宿主里装一次 skill，之后用自然语言要求审查即可。

→ [安装方式](docs/guide/zh-CN/installation.md) · [Pi `/rv` 命令](docs/guide/zh-CN/pi-package.md)

## 面板如何裁决

```
评审员（隔离、只读）──► findings ──► 确定性匹配（路径 + 摘要）
                                          │
                              歧义配对 ────┴─► Jev 类型化裁决（约 100 ms）
                                                  │  0.3–0.7 边界区 → Pi 复判一次
                                                  ▼
                                    共识阈值 ──► confirmed（卡门禁）/ advisory
```

评审员运行失败 → `blocked`；输出无法解析 → `needs_human`；绝不静默放行。裁决器只能聚类，不能新增、删除或改写 finding。→ [Panel 审查详解](docs/guide/zh-CN/panel-review.md) · [Loop 审查](docs/guide/zh-CN/loop-review.md)

## 合作伙伴

<table>
<tr>
<td width="50%" valign="top">

### [OrcaRouter](https://www.orcarouter.ai/ref/ref_07ca74b3e41670e5ff36)

一把 key 用遍前沿模型。`pi-review` 自带 provider 配置文件，放进 Pi 就能跑跨厂商面板，不用维护一堆账号。

[![Powered by OrcaRouter](https://img.shields.io/badge/Powered_by-OrcaRouter-2563eb)](https://www.orcarouter.ai/ref/ref_07ca74b3e41670e5ff36)

→ [接入指南](docs/guide/zh-CN/providers.md)

</td>
<td width="50%" valign="top">

### [TypeSafe Jev](https://typesafe.ai)

约 100 ms 返回概率的 System One 模型。驱动共识裁决、跨轮 finding 记忆、范围 `classify`，以及 1 秒级 `screen` 门禁。

设置 `TYPESAFE_API_KEY` 即自动启用。

→ [对比报告](docs/research/jev-comparison-report.html) · [筛查研究](docs/research/jev-screening-case.md)

</td>
</tr>
</table>

## 文档

| 指南 | 内容 |
|---|---|
| [安装](docs/guide/zh-CN/installation.md) | CLI、Pi 包、agent skill（Claude Code / Codex / Cursor / agy）、更新、源码安装 |
| [CLI 参考](docs/guide/zh-CN/cli-reference.md) | 全部参数、审查模式、各命令使用时机 |
| [筛查流程](docs/guide/zh-CN/screening.md) | `screen` 的中文流程图、门禁结果、退出码与流水线位置 |
| [Panel 审查](docs/guide/zh-CN/panel-review.md) | 共识策略、聚合、Jev、`classify`、`screen`、实时 UI、网页看板 |
| [Loop 审查](docs/guide/zh-CN/loop-review.md) | 有限轮次、`--until clean`、跨轮对比、收敛停止 |
| [输出与集成](docs/guide/zh-CN/output-and-integration.md) | Markdown 结构、`PI_REVIEW_META_JSON` schema、退出码、会话、进度日志 |
| [配置](docs/guide/zh-CN/configuration.md) | 配置文件、环境变量、安全模型 |
| [Provider](docs/guide/zh-CN/providers.md) | OrcaRouter 等 provider 接入 |
| [研究](docs/research/) | Jev 架构、筛查测量、裁决案例 |

## 参与贡献

欢迎 issue 与 PR。源码仅用英文；文档可双语。提交经 Husky 走 `ai-commit`（`npm install` 会装好 hook）。见 [安装 → 语言约定](docs/guide/zh-CN/installation.md#参与贡献语言约定)。

## Star

如果 `pi-review` 抢在人工评审前抓到过 bug，点个 ⭐ 能让更多人发现它。

[![Star History Chart](https://api.star-history.com/svg?repos=ZephyrDeng/pi-review&type=Date)](https://star-history.com/#ZephyrDeng/pi-review&Date)

## 致谢

系统提示词结构参考 [Codex-5.5-codex-instruct-5.5](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5)（MIT）。

## 许可

[MIT](LICENSE) © ZephyrDeng
