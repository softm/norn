#!/bin/bash
# Requires the user's own Google authorization. Never paste tokens into chat.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo 'Node.js 22 LTS를 먼저 설치하세요.'; exit 1; }
npx --yes firebase-tools@14 login
npx --yes firebase-tools@14 projects:list
printf '\n사용할 NORN Firebase 프로젝트 ID (기존 다른 서비스와 분리 권장): '
read -r project_id
[[ "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo '프로젝트 ID 형식을 확인하세요.'; exit 1; }
printf '\n프로젝트: %s\n' "$project_id"
echo 'Authentication에서 Google을 활성화하고 웹 앱의 공개 SDK 설정을 public/firebase-config.json에 넣으세요.'
echo '서비스 계정 JSON, private_key, 로그인 토큰은 입력하지 않습니다.'
printf '설정 완료 후 이 프로젝트의 NORN Rules와 Hosting을 배포할까요? [yes/N] '
read -r answer
if [ "$answer" = yes ]; then
  node -e 'const c=JSON.parse(require("fs").readFileSync("public/firebase-config.json")); if(!c.enabled||!c.firebase?.projectId||c.firebase.projectId!==process.argv[1])process.exit(1)' "$project_id" || { echo '프로젝트 ID와 웹 설정이 일치하지 않습니다.'; exit 1; }
  npx --yes firebase-tools@14 deploy --project "$project_id" --only firestore:rules,firestore:indexes,hosting
fi
