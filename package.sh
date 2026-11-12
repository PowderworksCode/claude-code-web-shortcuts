#!/usr/bin/env bash
# Builds dist/claude-code-web-shortcuts-<version>.zip, loadable/uploadable in Chrome and Firefox.
set -euo pipefail
cd "$(dirname "$0")"
v=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p dist && rm -f "dist/claude-code-web-shortcuts-$v.zip"
zip -q "dist/claude-code-web-shortcuts-$v.zip" manifest.json background.js defaults.js content.js options.html options.js
echo "dist/claude-code-web-shortcuts-$v.zip"
