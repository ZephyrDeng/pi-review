#!/usr/bin/env sh
# `claude plugin test` runs every *.test.ts under the plugin root, which here
# is the whole repo (vitest suites included). Stage the mod's files alone.
set -eu
cd "$(dirname "$0")/.."
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/.claude-plugin" "$dir/src"
cp .claude-plugin/plugin.json .claude-plugin/marketplace.json "$dir/.claude-plugin/"
cp -R hooks types "$dir/"
find src -maxdepth 1 -name '*.ts' ! -name '*.test.ts' -exec cp {} "$dir/src/" \;
claude plugin validate "$dir"
claude plugin test "$dir"
