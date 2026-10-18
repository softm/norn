# NORN · Firebase 연결과 설치

## 플러그인 설치와 서비스 연결은 별개

ChatGPT Firebase 플러그인은 개발 작업용입니다. 설치 카드를 띄우거나 코드에 SDK를 추가한 것만으로 플러그인 설치/Google 권한 승인이 끝난 것은 아닙니다. 설치 상태와 실제 프로젝트 연결 결과를 각각 확인합니다.

현재 배포용 기본 설정은 `public/firebase-config.json`의 `enabled: false`입니다. 원본은 로컬에 유지하며, 로그인 실패를 체험 로그인 성공으로 바꾸지 않습니다. 체험 버튼을 명시적으로 누르면 원격 Firebase 없이 샘플 편집을 사용할 수 있습니다.

## 권장: 로컬 연결 도우미

Node.js 22 이상과 인터넷이 있는 사용자 컴퓨터에서 저장소 또는 전체 ZIP을 연 뒤 실행합니다.

```bash
bash scripts/connect-firebase.command
```

단계는 다음과 같습니다.

1. Firebase CLI가 본인의 Google 로그인 승인을 요청합니다. 비밀번호·인증코드는 채팅에 보내지 않습니다.
2. CLI에서 실제 조회한 프로젝트 중 번호로 선택합니다. 노른 전용 새 프로젝트 생성도 명시적으로 확인한 경우만 실행합니다. 결제 계정은 연결하지 않습니다.
3. 실제 조회한 웹 앱을 선택합니다. 웹 앱이 없다면 확인 후 NORN 웹 앱을 등록합니다.
4. `apps:sdkconfig`로 가져온 **공개 웹 설정**의 프로젝트 ID·웹 앱 ID를 대조하고, 관리자 자격증명 필드를 거부합니다. 저장 승인 후 파일에 입력하며 기존 설정은 Git에서 제외된 `.norn/`에 백업합니다.
5. 화면에 나온 Firebase Console에서 Google 제공자·허용 도메인·Firestore 기본 데이터베이스를 확인합니다. 필요한 데이터베이스는 프로덕션/잠금 모드로 생성하세요. **이 단계는 자동 확인했다고 표시하지 않습니다.**
6. 실제 Hosting 사이트 목록에서 배포 대상을 선택합니다. **선택 프로젝트의 기본 Firestore Rules 전체와 해당 사이트 콘텐츠를 교체한다는 경고를 확인**하고 승인해야 배포합니다. 다른 서비스와 공유하는 프로젝트는 피하세요.
7. 성공한 CLI 배포 결과에서 사이트 주소를 확인합니다. `/setup.html`에서 실제 Google 로그인과 본인 기본 설정 읽기 권한을 따로 점검합니다. 원본 파일이나 프로젝트를 자동 업로드하지 않습니다.

설정 파일 자동 생성은 로그인 검증 완료가 아니고, CLI 배포 성공은 모든 사용자 시나리오 검증 완료가 아닙니다. 실제 서로 다른 계정 2개로 저장·불러오기·격리를 검사해야 합니다.

읽기 전용 계획 확인:

```bash
bash scripts/connect-firebase.command --dry-run
```

## 허용 도메인

실제로 사용하는 Firebase Hosting 도메인, 커스텀 도메인, Pages 이용 시 `softm.github.io`, 로컬 계정 검사 시 `localhost`를 Authentication의 Authorized domains에 추가하세요. 새 프로젝트는 localhost가 자동 등록된다고 가정하지 않습니다.

`norn.designboard.net`은 DNS/Hosting 연결을 별도로 완료하기 전에는 운영 중이라고 표시하지 않습니다. Google 로그인과 내 PC의 FFmpeg 엔진 연결은 서로 다른 권한입니다.

## 진단 화면

`public/setup.html`은 다음을 별도로 보여줍니다.

- 공개 웹 설정 형식 확인: 형식이 맞다는 뜻이며 실제 인증 성공이 아닙니다.
- Google 로그인: 사용자가 버튼을 누른 경우에만 팝업을 엽니다.
- Firestore 읽기: 현재 로그인한 본인의 `users/{uid}/settings/defaults`만 읽습니다. 쓰기 검사나 다른 사용자 격리 검사를 대신하지 않습니다.

API 키/토큰을 입력받는 브라우저 폼은 없습니다. `auth/unauthorized-domain`, 제공자 미활성화, 팝업 차단, 데이터 접근 거부 등을 구분해 안내합니다.

## 데이터와 배포 경계

- `users/{uid}/projects/{id}`: 제목·설명·버전 목록·저장 버전 번호.
- `users/{uid}/projects/{id}/variants/{variantId}`: 화면 크기·장면 순서·자막·구간·배속·전환·음악 식별자.
- `users/{uid}/settings/defaults`: 기본 분석 장수.
- 원본, 미디어 URL, 로컬 절대 경로, 연결 토큰은 클라우드 허용 필드에서 제외합니다.
- 설정은 다른 기기로 동기화해도 원본 폴더는 다시 연결해야 합니다.
- 원본·표본·영상 인코딩은 로컬 엔진. Firebase Hosting은 웹 UI만 제공합니다.
- App Check 키/강제 적용은 실제 프로젝트 검증 후 별도로 설정합니다. 설정만으로 완전한 보안을 보장하지 않습니다.

## GitHub Pages

2026-10-18 기존 실행에서 Pages 자동 활성화는 `Resource not accessible by integration`으로 실패했습니다. 사용자 또는 관리자가 저장소 Settings → Pages → Source를 **GitHub Actions**로 한 번 선택해야 합니다.

새 workflow는 Pages 설정 상태를 먼저 확인합니다. 미설정이면 테스트/빌드만 완료하고 **배포 안 함**을 별도로 보고합니다. 녹색 검사 상태만 보고 공개 사이트 배포 성공으로 해석하지 않습니다. 활성화 후 Actions에서 workflow를 다시 실행하세요.

정식 상용 SaaS 운영은 Pages 약관을 별도 확인하고 Firebase Hosting 등 적절한 호스팅을 사용하세요.

## 로컬 MCP 대안 (선택)

Firebase 공식 MCP는 Firebase CLI와 같은 사용자 인증을 사용합니다. 로컬 MCP 클라이언트를 사용한다면 공식 설정은 다음 형태입니다. **이 파일을 제공한 것만으로 ChatGPT 플러그인이 설치되는 것은 아닙니다.** 노른 앱 실행에 MCP/Codex는 필수가 아닙니다.

```json
{"mcpServers":{"firebase":{"command":"npx","args":["-y","firebase-tools@15.34.0","mcp","--only","auth,firestore"]}}}
```

## 공식 문서

- https://firebase.google.com/docs/cli
- https://firebase.google.com/docs/auth/web/google-signin
- https://firebase.google.com/docs/firestore/security/rules-conditions
- https://firebase.google.com/docs/hosting/full-config
- https://firebase.google.com/docs/ai-assistance/mcp-server
