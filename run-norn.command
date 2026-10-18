#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "FFmpeg가 필요합니다. Homebrew가 있다면: brew install ffmpeg"
  read -r -p "엔터로 종료"; exit 1
fi
python3 -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10 이상이 필요합니다."'
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
if ! python3 -c 'import PIL' 2>/dev/null; then python3 -m pip install -r requirements.txt; fi
python3 engine/main.py "$@"
