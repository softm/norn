#!/bin/bash
# Runs on the user's computer; never requests credentials in chat.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo 'Node.js 22 이상을 먼저 설치하세요.'; exit 1; }
command -v npx >/dev/null || { echo 'Node.js/npm을 먼저 설치하세요.'; exit 1; }
node scripts/setup-firebase.mjs "$@"
