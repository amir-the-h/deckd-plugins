#!/usr/bin/env bash
# Packs each plugin folder into dist/<uuid>.streamDeckPlugin (a zip with the folder at its top level)
# and writes dist/index.json, the index deckd reads when this repo is added as a plugin source.
# Usage: scripts/pack.sh [plugin.sdPlugin ...]   (default: all of them)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
plugins=("$@")
[ ${#plugins[@]} -eq 0 ] && plugins=(*.sdPlugin)
for p in "${plugins[@]}"; do
  p=${p%/}
  out="dist/${p%.sdPlugin}.streamDeckPlugin"
  rm -f "$out"
  zip -qrX "$out" "$p" -x '*/node_modules/.cache/*'
  echo "$out"
done
node scripts/build-index.mjs dist deckd-plugins https://github.com/amir-the-h/deckd-plugins "${plugins[@]}"
