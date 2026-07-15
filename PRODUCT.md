# Product

## Register

product

## Users

开发者在 Claude Code / Codex / Cursor 或终端里发起 pi-review 面板评审后，打开本地 loopback dashboard，在编辑器旁边的浏览器窗口里监控评审进度。典型会话 2–10 分钟：多数时间是余光扫视（哪个评委在跑、跑到哪了），评审完成时转为专注阅读（confirmed findings 与 advisories）。环境光偏暗，编辑器多为深色主题。

## Product Purpose

pi-review 把代码/方案评审委托给隔离的 Pi 子会话，支持多评委面板 + 共识门禁。Web dashboard 是面板评审的实时监控面：展示每位评委的生命周期、活动流、token 消耗，以及最终的共识结论。成功标准：用户不需要盯着 CLI 缓冲输出，抬眼即可判断评审状态；完成后报告可读性优于终端 ASCII 输出。

## Brand Personality

精密、克制、工艺感。Raycast 官网级别的完成度：深色基底上的单一强调色、克制而精确的动效、数字与状态变化有物理质感。工具服务于内容，炫技为零。

## Anti-references

- 当前版本的 dashboard：系统字体 + GrayText 边框 + 朴素卡片，工程师置的临时 UI。
- 通用 SaaS 仪表盘：hero-metric 大数字模板、渐变文字、玻璃拟态、彩色左边框卡片。
- 过度动画：弹跳、elastic、无意义的入场表演。

## Design Principles

- 状态即层级：running 的评委在视觉上必须比 queued/completed 更"活"，扫一眼就知道系统在干什么。
- 数字有质感：token、耗时、工具调用数的变化通过数字滚动等微动效传达"系统在呼吸"，而非静态替换。
- 内容分级渲染：评审正文是 markdown 就渲染成排版良好的正文；活动流是日志就保持等宽克制。
- 生命周期完整：URL 自动打开，完成后倒计时自动关闭页面并停止服务，交互即取消倒计时。
- 单主题做深：深色单主题，把对比层次、微光、focus 状态做到位，优于两个平庸主题。

## Accessibility & Inclusion

- WCAG AA 对比度（深色基底上正文 ≥ 4.5:1）。
- `prefers-reduced-motion: reduce` 时关闭数字滚动与脉冲动效，改为直接状态替换。
- 状态不只靠颜色：status 徽章同时有文字标签。
