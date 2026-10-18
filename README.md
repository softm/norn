# 노른 · NORN

## 노른노른하게, 영상을 굽다.

사진에 담긴 순간, 영상에 흩어진 이야기를 하나의 흐름으로 엮는 로컬 우선 영상 스튜디오입니다.

**원본 사진·영상·음원은 내 컴퓨터에 그대로 둡니다.** 계정에 저장하는 것은 콘셉트, 제목·문구, 편집 설정입니다. 원본을 업로드하지 않습니다. 생성한 MP4와 분석용 축소 이미지만 원본 옆 `<폴더명>업로드준비` 폴더에 새로 만듭니다.

## 사용

### 웹 화면·체험

```bash
python3 -m http.server 5173 --directory public
```

브라우저에서 http://localhost:5173 에 접속합니다. 로그인 없이 샘플로 장면 이름·타이틀·문구, 순서·복제·삭제, 출력 비율·버전을 편집하고 JSON으로 저장할 수 있습니다. 체험은 실제 MP4를 생성한 척하지 않습니다.

### 실제 원본과 FFmpeg

Python 3.10+, FFmpeg/ffprobe, Pillow가 필요합니다.

```bash
# Homebrew가 있는 Mac에서 FFmpeg 최초 설치
brew install ffmpeg
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
# HEIC 사진을 쓰면: python3 -m pip install -r requirements-heic.txt
python3 engine/server.py "/원본사진영상폴더"
```

또는 `bash run-norn.command`로 폴더 선택창을 엽니다. 원본을 선택하면 엔진 주소·연결 코드가 출력되고 브라우저가 열립니다. 터미널을 유지하고 끝낼 때 Ctrl+C로 종료합니다. 폰트 파일은 배포하지 않고 컴퓨터에 설치된 한글 글꼴을 사용합니다.

배포 웹사이트에서 연결할 때는 **정확한 사이트 출처**를 추가합니다.

```bash
python3 engine/server.py "/원본폴더" --web-origin https://softm.github.io
# 커스텀 도메인 연결 후 사용 시:
# python3 engine/server.py "/원본폴더" --web-origin https://norn.designboard.net
```

웹사이트의 ‘연결’ 버튼에 엔진 주소와 연결 코드를 입력합니다. 브라우저가 로컬 네트워크 권한을 요구할 수 있습니다. 이 환경에서는 실제 브라우저 → localhost 직접 접속이 정책상 차단되어 사용자 Mac에서의 최종 연결 확인은 남아 있습니다.

## 구현 범위

- 노른 브랜드 랜딩과 반응형 웹 편집기, 별도 로컬 체험.
- 상단 고정 생성 진행·현재 단계·취소·완료/오류 로그.
- 원본 크게 보기, 장면 추가·삭제·이동·복제·분할, 구간과 배속 조절.
- 장면명과 실제 타이틀 분리, 10가지 글씨 스타일, 글씨 크기·위치.
- 25개 전환 선택지(설치된 FFmpeg 지원 목록에 한정), 원음 제어와 로컬 음악.
- 숏폼·롱폼·타임랩스용 독립 출력 버전. 목표 시간만큼 장면을 임의로 늘리거나 줄이지 않습니다.
- 한 시간 → 30초는 120배속. 고배속 미리보기는 실제 저해상도 MP4를 만들어 확인합니다.
- 영상당 1~20장(기본 5장) 표본 분석. Ollama 로컬 모델, 명시적 실행, 캐시와 수동 문구 보호.
- Firebase Google 인증·저장/불러오기 코드, UID별 보안 규칙, 운영 설정 미연결 표시.
- SNS 본문 초안·첨부 경로. 실제 SNS 자동 게시 기능은 없습니다.

## v10 자료

같은 원본 폴더에 v10 `edit-project.json`과 `manifest.json`이 있으면 최초 실행 때 새 NORN 형식으로 가져옵니다. **기존 파일은 덮어쓰지 않습니다.** 원본 ID를 연결하고 수동 문구를 보호합니다. 기존 내장 음악은 다시 연결해야 할 수 있으며 이때 경고를 표시합니다. v10의 모든 화면·설정을 동일하게 이전했다고 보장하지 않으므로 중요한 기존 편집은 백업과 결과 비교가 필요합니다.

## Firebase

운영 프로젝트와 설치 권한이 확인되지 않아 기본값은 **비활성**입니다. Google 버튼을 연결 완료로 가장하지 않습니다. [연결 절차](docs/FIREBASE_SETUP.md)를 확인하세요. 사용자 본인의 Google 인증은 설치 카드 또는 로컬 CLI에서 완료해야 합니다. 기존 설계한눈의 운영 데이터·계정 정보를 복사하지 않습니다.

## 개발·검증

```bash
node --test tests/domain.test.mjs
python3 -m unittest discover -s tests -p test_engine.py -v
node scripts/build.mjs
# 인터넷과 Node 22 / Java 21 환경에서 Firebase 에뮬레이터 시험
npm install --ignore-scripts
npm run test:rules
```

GitHub Actions가 검사·정적 사이트 패키지를 만듭니다. Pages 활성화 권한이 부족하면 저장소 Settings → Pages → Source를 GitHub Actions로 선택해야 합니다. 정식 상용 운영은 GitHub Pages 이용 조건을 검토하고 Firebase Hosting 등을 사용하세요. 원본과 로그인 토큰을 공개 저장소에 올리지 마세요.

[현재 상태와 검증 범위](docs/STATUS.md)
