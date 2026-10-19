# NORN · 루트 주소 서비스

`https://norn.designboard.net/`에서 홈을 직접 실행하고 `/#studio`에서 편집기를 사용합니다. `/public/`로 리다이렉트하거나 iframe 안에 앱을 띄우는 방식이 아닙니다.

## 현재 branch-root 배포

- 루트 `index.html`은 `public/app.js`와 스타일을 불러오는 직접 실행 페이지입니다.
- 루트 `setup.html`은 같은 계정 연결 검사 코드를 사용합니다.
- `public/firebase-v2.js`는 `import.meta.url` 기준으로 같은 폴더의 Firebase 설정을 읽습니다. HTML이 루트에 있어도 설정 파일 위치를 잘못 요청하지 않습니다.
- DNS·CNAME·Firebase 프로젝트 값·계정 권한·원본 처리 방식은 변경하지 않습니다.
- 기존 `/public/` 주소도 계속 동작합니다. 같은 출처의 기존 체험 데이터는 삭제하지 않습니다.

## 유지보수

홈·진단 HTML의 원본은 `public/`에 유지합니다. 해당 HTML을 변경한 후 `npm run sync:root`를 실행하고 루트 진입 파일도 함께 커밋합니다. `npm test`가 두 진입 파일의 일치와 로컬 자산 경로를 검사합니다. JS/CSS 코드는 루트로 복사하지 않습니다.

나중에 Pages Source를 GitHub Actions로 전환해도 `scripts/build.mjs`가 `public/` 내용을 `dist/` 루트로 복사하는 기존 방식은 그대로 사용할 수 있습니다. 해당 경우 모듈과 설정 파일은 함께 루트로 배포됩니다.

루트 주소에 접속할 수 있는 것과 브라우저에서 파일·폴더를 선택해 실제 영상을 생성·저장하는 것은 별도 검증 항목입니다. 기본 편집은 로컬 엔진 실행 없이 진행하며, Firebase 로그인·편집정보 저장과 선택 기능인 Python 엔진은 각각 따로 확인합니다. 0.3.0의 배포·실행 판정은 [구현·검증 상태](STATUS.md)를 참고합니다.
