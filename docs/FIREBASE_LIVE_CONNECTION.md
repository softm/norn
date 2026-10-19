# NORN · Firebase 운영 연결

2026-10-19 연결 작업. 이전 STATUS.md의 Firebase 미연결 설명은 아래 실제 Console 설정과 배포 결과로 갱신됩니다. GitHub Pages의 사이트 루트와 로컬 원본 처리 방식은 변경하지 않습니다.

## Firebase Console에 적용한 설정

- 노른 전용 프로젝트: `norn-2cb91` (표시명 NORN).
- NORN Web 앱: `1:924703480384:web:a689af74160c6903d19da5`.
- Spark 플랜 유지. 결제 계정 연결/유료 업그레이드/Analytics/Hosting 추가 없음.
- Google 로그인 제공자 활성화, 서비스 표시명 NORN.
- Authentication Authorized domains에 `norn.designboard.net` 추가. 기존 `localhost`, `norn-2cb91.firebaseapp.com`, `norn-2cb91.web.app` 유지.
- Firestore: Standard edition, `(default)`, `asia-northeast3` (Seoul).
- 저장소 `firebase/firestore.rules`의 사용자별 규칙 전문 게시. 인증된 본인의 UID 하위 프로젝트/설정/진단만 허용하고 나머지 접근은 기본 거부.
- 공개 웹 SDK 설정을 `public/firebase-config.json`에 반영하고 `enabled: true`로 변경. 기본 authDomain은 실제 Firebase 인증 호스트를 유지하며 GitHub Pages 도메인으로 임의 교체하지 않음.

원본/캡처 이미지, 영상, 관리자 자격증명은 Firebase나 저장소에 올리지 않습니다. 웹 SDK 설정은 공개용 설정이며 관리자 키/로그인 토큰을 포함하지 않습니다.

## 배포 및 검증 결과

- 운영 설정 커밋: `cfee1b3e8e5ea8794f6498e9301fe86a3bb8bf17`.
- 루트 경로 테스트 보완: `4731b1295ad9963d1959a91e1dcd267fd38b8c76`.
- 실제 GitHub Pages 브랜치 배포 성공: https://github.com/softm/norn/actions/runs/39199353543
- Node/Python, 루트 경로 및 로컬 편집기 Chromium 검사, Firestore 에뮬레이터 검사 성공: https://github.com/softm/norn/actions/runs/39199353754
- 위 검사 workflow 내부의 별도 deploy-pages 단계는 브랜치 배포 방식을 사용하므로 건너뜀. 실제 운영 배포 성공 근거는 별도 pages build and deployment 실행이다.
- 운영 `https://norn.designboard.net/setup.html`에서 “웹 설정 형식 확인 완료. 실제 로그인·데이터 권한은 별도 점검하세요.” 표시 확인.
- Google 버튼 클릭 → 실제 계정 선택 → Google의 2단계 본인 확인 요구까지 진입 확인.
- **사용자 기기 확인이 필요하여 OAuth 인증 완료 전에 중단. 운영 계정으로 설정 읽기 및 임시 문서 저장·읽기·삭제는 실행하지 못했다.** Google 제공자 설정 완료와 실제 로그인 성공은 구분한다.
- 실제 사용자 프로젝트/설정/원본 파일을 테스트용으로 수정하거나 업로드하지 않음.

## 테스트 격리

`tests/ui-live.py`와 `tests/ui-root.py`는 미연결 상태의 화면 동작을 시험할 때만 명시적인 테스트용 disabled 설정 응답을 사용합니다. CI가 실제 운영 계정에 로그인하거나 운영 Firestore를 쓰지 않도록 하기 위함입니다. 루트 경로 검사는 실제 설정 파일 응답이 200인지 먼저 검사하므로 없는 파일을 성공으로 가리지 않습니다. 나머지 로컬 서버/FFmpeg 동작은 실제 실행합니다. 이 테스트를 운영 OAuth 성공의 근거로 사용하지 않습니다. Firestore Rules/SDK 검사는 별도 demo-norn 에뮬레이터에서 실행합니다.

## 사용자가 이어서 확인할 부분

노른 사이트를 새로 열어 Google로 로그인하고 필요한 경우 본인의 2단계 인증을 완료하세요. 자동화 중단 이후의 오래된 인증 알림 대신 본인이 새로 시작한 로그인 요청만 승인하세요. 비밀번호·인증코드는 채팅이나 저장소에 보내지 않습니다.

로그인 후 진단 화면의 본인 설정 읽기, 임시 문서 저장·읽기·삭제를 확인합니다. 사용자 기기에서의 실제 Google 로그인과 운영 저장 검증은 이 문서 작성 시점에 미완료입니다.

서비스: https://norn.designboard.net/

연결 진단: https://norn.designboard.net/setup.html

운영 Firebase Console: https://console.firebase.google.com/project/norn-2cb91/overview
