# NORN · Firebase 운영 연결

2026-10-19 연결 작업. 이전 STATUS.md의 Firebase 미연결 설명은 아래 Console 설정 결과로 갱신됩니다. GitHub Pages의 사이트 루트와 로컬 원본 처리 방식은 변경하지 않습니다.

## Firebase Console에 적용한 설정

- 노른 전용 프로젝트: `norn-2cb91` (표시명 NORN).
- NORN Web 앱: `1:924703480384:web:a689af74160c6903d19da5`.
- Spark 플랜 유지. 결제 계정 연결/유료 업그레이드/Analytics/Hosting 추가 없음.
- Google 로그인 제공자 활성화, 서비스 표시명 NORN.
- Authentication Authorized domains에 `norn.designboard.net` 추가. 기존 `localhost`, `norn-2cb91.firebaseapp.com`, `norn-2cb91.web.app` 유지.
- Firestore: Standard edition, `(default)`, `asia-northeast3` (Seoul).
- 저장소 `firebase/firestore.rules`의 사용자별 규칙 전문 게시. 인증된 본인의 UID 하위 프로젝트/설정/진단만 허용하고 나머지 접근은 기본 거부.
- 공개 웹 SDK 설정을 `public/firebase-config.json`에 반영. 기본 authDomain은 실제 Firebase 인증 호스트를 유지하며 GitHub Pages 도메인으로 임의 교체하지 않음.

원본/캡처 이미지, 영상, 관리자 자격증명은 Firebase나 저장소에 올리지 않습니다. 웹 SDK 설정은 공개용 설정이며 관리자 키/로그인 토큰을 포함하지 않습니다.

## 검증을 구분합니다

Console의 제공자/도메인/DB/규칙 적용과 실제 서비스 OAuth·저장 검증은 별개입니다. 이 커밋 이후 Pages 배포와 실제 서비스 진단을 확인해야 합니다.

`tests/ui-live.py`는 미연결 상태를 시험하는 부분에만 명시적인 테스트용 disabled 설정 응답을 사용합니다. CI가 실제 운영 계정에 로그인하거나 운영 Firestore를 쓰지 않도록 하기 위함입니다. 나머지 로컬 서버/FFmpeg 동작은 실제 실행합니다. 이 테스트를 운영 OAuth 성공의 근거로 사용하지 않습니다. Firestore Rules/SDK 검사는 별도 demo-norn 에뮬레이터에서 실행합니다.

배포 후 확인 주소: https://norn.designboard.net/setup.html

운영 Firebase Console: https://console.firebase.google.com/project/norn-2cb91/overview
