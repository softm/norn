# Firebase 연결 · 운영 전 필수

## 이번 패키지에서 구현한 것

Google 로그인/로그아웃, 인증 상태 구독, 별도의 로컬 체험, 사용자별 편집 정보 저장/불러오기, 기본 분석 장수 저장, 충돌 감지, 보안 규칙과 에뮬레이터 테스트 코드가 있습니다.

**운영 프로젝트를 만들거나 연결했다고 표시하지 않습니다.** 기본 `public/firebase-config.json`은 `enabled: false`입니다. 설정이 없으면 Google 로그인 버튼은 명확한 오류를 표시하며 체험 계정으로 넘어가지 않습니다.

## ChatGPT 플러그인과 Firebase 앱의 차이

ChatGPT의 플러그인 설치 카드는 개발 작업용 연결입니다. 설치 카드를 표시한 것만으로 설치나 Google 권한 승인이 완료된 것이 아닙니다. 사용자의 설치/권한 승인이 필요합니다. 플러그인이 계속 실패해도 앱 코드는 Firebase 웹 SDK와 CLI로 연결할 수 있습니다.

Google 공식 MCP는 실행 환경의 Firebase CLI 인증을 사용합니다. 이 패키지에 CLI 자격증명, 토큰, 서비스 계정은 없습니다.

## 운영 연결 순서

1. 사용자의 Firebase Console에서 노른용 프로젝트를 선택합니다. 다른 서비스의 프로젝트 설정을 임의로 재사용하지 않습니다.
2. 웹 앱을 등록하고 공개 웹 SDK 설정(apiKey, authDomain, projectId, appId 등)을 복사합니다.
3. Authentication의 Google 제공자를 활성화합니다. 실제 호스팅 도메인을 Authorized domains에 추가합니다.
4. Firestore를 잠금 상태로 만들고, 이 저장소의 `firebase/firestore.rules`를 배포합니다. 테스트 모드로 공개하지 않습니다.
5. `public/firebase-config.json`의 firebase에 웹 SDK 구성 객체를 넣고 enabled를 true로 바꿉니다. **private_key나 service account JSON을 넣지 않습니다.**
6. 로컬 터미널에서 `bash scripts/connect-firebase.command`로 사용자 본인이 로그인하고 프로젝트 ID를 확인한 후 배포할 수 있습니다.
7. 실제 계정 2개로 사용자 간 데이터 격리를 확인합니다. 체험 → 로그인 시 명시적으로 저장한 자료만 계정에 올라가는지도 확인합니다.

예시(식별값은 실제 프로젝트에서 가져와야 하며 임의 값으로 성공 처리하지 않습니다):

```json
{"enabled":true,"firebase":{"apiKey":"공개 웹 키","authDomain":"프로젝트.firebaseapp.com","projectId":"실제 프로젝트 ID","appId":"실제 웹 앱 ID"},"appCheckSiteKey":""}
```

Firebase Hosting에는 정적 사이트만 올라갑니다. 동영상 생성은 `engine/server.py`와 네이티브 FFmpeg가 내 컴퓨터에서 수행합니다. App Check 키를 설정하면 ReCAPTCHA Enterprise 연동 코드가 실행됩니다. enforcement 활성화는 정상 트래픽 검증 후 별도 진행해야 합니다.

## 데이터

- `users/{uid}/projects/{id}`: 제목, 설명, 버전 목록, 저장 버전 번호.
- `users/{uid}/projects/{id}/variants/{variantId}`: 영상 크기, 장면 순서, 자막, 구간, 배속, 전환, 음악 식별자. 현재 버전은 장면 120개/버전 12개 제한.
- `users/{uid}/settings/defaults`: 기본 분석 장수.
- 원본 파일, 파일 본문, 로컬 절대 경로, 연결 토큰, 미디어 URL은 클라우드 저장 허용 목록에 없습니다.
- 다른 기기에서는 원본 폴더를 다시 연결해야 합니다. 설정 동기화는 원본 동기화가 아닙니다.

## 공식 문서

- https://firebase.google.com/docs/auth/web/google-signin
- https://firebase.google.com/docs/firestore/security/rules-conditions
- https://firebase.google.com/docs/hosting/full-config
- https://firebase.google.com/docs/ai-assistance/mcp-server
