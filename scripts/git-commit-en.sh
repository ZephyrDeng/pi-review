#!/usr/bin/env bash
# English Conventional commit via project .ai-commit.yaml (ai_footer: off).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONTEXT="${1:-}"

if git diff --cached --quiet && ! git diff --quiet; then
  echo "Nothing staged. Run: git add ..." >&2
  exit 1
fi

ARGS=(generate --lang en)
[[ -n "$CONTEXT" ]] && ARGS+=(--context "$CONTEXT")

exec ai-commit "${ARGS[@]}"