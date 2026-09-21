# Model providers

`pi-review` runs on any provider configured in Pi (`pi-review models` lists them). This page covers partner-specific setup.

## OrcaRouter

`pi-review` is model-agnostic — it runs on any model provider configured in your
[Pi](https://pi.dev) installation. To use [OrcaRouter](https://www.orcarouter.ai) as
the provider behind your reviews:

1. **Get a key** — no account yet? **Sign up with our referral link** <https://www.orcarouter.ai/ref/ref_07ca74b3e41670e5ff36> (also available from the badge below). Already have a key? Skip ahead.

   ```bash
   export ORCA_KEY="sk-orca-..."
   ```

2. **Register the provider** — merge [`resources/providers/orcarouter.json`](../../resources/providers/orcarouter.json) into `~/.pi/agent/models.json` (OpenAI-compatible). If that file already exists, **merge, don't copy** — `cp` would overwrite every other provider you configured:

   ```bash
   # fresh machine (no models.json yet):
   cp resources/providers/orcarouter.json ~/.pi/agent/models.json
   # existing models.json — merge instead (or edit by hand):
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

3. **Pick the model** when you run a review:

```bash
pi-review --model orcarouter/orcarouter/auto -- @src/foo.ts
```

[![Powered by OrcaRouter](https://img.shields.io/badge/Powered_by-OrcaRouter-2563eb)](https://www.orcarouter.ai/ref/ref_07ca74b3e41670e5ff36)

