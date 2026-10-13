#!/usr/bin/env sh
# Validate and test the Claude Code plugin after refreshing its copies.
set -eu
cd "$(dirname "$0")/.."
node scripts/sync-claude-plugin.mjs
claude plugin validate .
claude plugin validate claude-plugin
claude plugin test claude-plugin
