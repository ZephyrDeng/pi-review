# 模型 Provider

[English](../providers.md)

> **这页解决什么问题：** `pi-review` 不绑定任何模型厂商——Pi 里配了什么它就能用什么，`pi-review models` 列出全部可选项。这页只讲合作伙伴的专项接入。

## OrcaRouter

跑面板审查时，常见做法是**不同评审员用不同厂商的模型**，互补盲区；麻烦在于要维护多个账号、多把 key。[OrcaRouter](https://www.orcarouter.ai) 是一个模型路由服务，一把 key 即可，`pi-review` 自带它的 provider 配置文件，三步接入：

1. **拿 key**——还没账号？**用我们的推荐链接注册** <https://www.orcarouter.ai/ref/ref_07ca74b3e41670e5ff36>（下方徽章同样可用）。已经有 key 就跳过。

   ```bash
   export ORCA_KEY="sk-orca-..."
   ```

2. **注册 provider**——把 [`resources/providers/orcarouter.json`](../../../resources/providers/orcarouter.json) 合并进 `~/.pi/agent/models.json`（OpenAI 兼容格式）。如果这个文件已经存在，**要合并，不要复制**——`cp` 会把你配过的其它 provider 全部覆盖掉：

   ```bash
   # 新机器（还没有 models.json）：
   cp resources/providers/orcarouter.json ~/.pi/agent/models.json
   # 已有 models.json——合并（或手工编辑）：
   jq -s '.[0] * .[1]' ~/.pi/agent/models.json resources/providers/orcarouter.json > /tmp/models.json && mv /tmp/models.json ~/.pi/agent/models.json
   ```

```json
{
  "providers": {
    "orcarouter": {
      "baseUrl": "https://api.orcarouter.ai/v1",
      "api": "openai-completions",
      "apiKey": "$ORCA_KEY",
      "models": [
        {
          "id": "orcarouter/auto",
          "name": "OrcaRouter Auto",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

3. **跑审查时选它**：

```bash
pi-review --model orcarouter/orcarouter/auto -- @src/foo.ts
```

模型 id 出现了两次 `orcarouter/` 不是笔误：前一个是 Pi 里的 provider 名，后一个是 OrcaRouter 侧的模型 id。

[![Powered by OrcaRouter](https://img.shields.io/badge/Powered_by-OrcaRouter-2563eb)](https://www.orcarouter.ai/ref/ref_07ca74b3e41670e5ff36)

## TypeSafe Jev

Jev 不是评审员，而是**裁决器**——它不写审查报告，只回答"这两条 finding 是不是同一个问题？"这类类型化问题并给出概率，约 100 ms 一次。设置 `TYPESAFE_API_KEY` 后自动启用，用于面板共识裁决、跨轮 finding 记忆、`classify` 和 `screen`。细节见 [Panel 审查](panel-review.md#聚合)。
