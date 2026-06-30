#!/usr/bin/env bash
# English commit via ai-commit; amend strips AI-USE / AI-COMMIT-META (not configurable in v0.1.44 generate).
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

ai-commit "${ARGS[@]}"

strip_footer() {
  python3 - <<'PY'
import subprocess, sys
msg = subprocess.check_output(["git", "log", "-1", "--format=%B"], text=True)
lines = msg.splitlines()
out = []
for line in lines:
    s = line.strip()
    if s.startswith("AI-COMMIT-META:"):
        continue
    if s in ("AI-USE", "AI-NONE"):
        continue
    out.append(line)
while out and not out[-1].strip():
    out.pop()
sys.stdout.write("\n".join(out))
if out:
    sys.stdout.write("\n")
PY
}

strip_footer | git commit --amend -F - --no-edit

echo "Done (commit message in English, AI footers removed when present)."