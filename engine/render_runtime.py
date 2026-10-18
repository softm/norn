"""V9 cancellable render runner and diagnostics. Local derivatives only.

FFmpeg timeout means NO progress for N seconds; a progressing long source is
not killed just because the original recording is longer than fifteen minutes.
No shell interpolation; stderr and commands are kept in an authenticated local
report. Diagnostics may contain original file names and must not be published.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import subprocess
import threading
import time
from typing import Callable, Any


class RenderCancelled(RuntimeError):
    pass


class RenderCommandError(RuntimeError):
    pass


def check_runtime() -> dict[str, str]:
    paths = {}
    for binary in ('ffmpeg', 'ffprobe'):
        found = shutil.which(binary)
        if not found:
            raise ValueError(f'{binary}를 찾지 못했습니다. Mac 터미널에서 brew install ffmpeg를 실행한 뒤 편집기를 다시 여세요.')
        paths[binary] = found
    # Fail BEFORE saving / starting a job, rather than after a long scan.
    r = subprocess.run([paths['ffmpeg'], '-hide_banner', '-encoders'], capture_output=True,
                       text=True, encoding='utf-8', errors='replace', timeout=20)
    if r.returncode or 'libx264' not in r.stdout:
        raise ValueError('설치된 FFmpeg에 libx264 인코더가 없습니다. H.264 인코딩을 지원하는 FFmpeg로 설치하세요.')
    version = subprocess.run([paths['ffmpeg'], '-version'], capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=20)
    paths['version'] = version.stdout.splitlines()[0] if version.stdout else 'unknown'
    return paths


class RenderRunner:
    def __init__(self, log_path: Path, cancel: threading.Event,
                 heartbeat: Callable[[dict[str, Any]], None] | None = None):
        self.log_path = log_path
        self.cancel = cancel
        self.heartbeat = heartbeat or (lambda state: None)
        self.started = time.monotonic()
        self.serial = 0
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path.write_text('NORN Engine 0.1 — local processing diagnostics\n'
                                 '주의: 이 파일에는 로컬 경로와 파일명이 포함될 수 있습니다. 공개 게시하지 마세요.\n', encoding='utf-8')

    def log(self, text: str) -> None:
        with self.log_path.open('a', encoding='utf-8') as f:
            f.write(text + '\n')

    def run(self, command: list[str], timeout: float = 900, cwd: Path | None = None) -> subprocess.CompletedProcess:
        if self.cancel.is_set():
            raise RenderCancelled('영상 생성을 취소했습니다. 원본과 이전 완성 영상은 그대로입니다.')
        self.serial += 1
        cmd = list(map(str, command))
        is_ffmpeg = Path(cmd[0]).name in ('ffmpeg', 'ffmpeg.exe')
        if is_ffmpeg and '-progress' not in cmd:
            cmd[1:1] = ['-progress', 'pipe:1', '-nostats']
        self.log(f'\n[{self.serial}] {time.strftime("%Y-%m-%d %H:%M:%S")}\n$ {shlex.join(cmd)}')
        started = time.monotonic()
        last_activity = started
        output: list[str] = []
        channel: queue.Queue[str | None] = queue.Queue()
        # A real file for stderr avoids pipe deadlocks and preserves full error logs.
        stderr_path = self.log_path.with_name(f'.ffmpeg-stderr-{os.getpid()}-{threading.get_ident()}.txt')
        status: dict[str, Any] = {'command_index': self.serial, 'command': Path(cmd[0]).name}
        process = None
        try:
            with stderr_path.open('w+', encoding='utf-8') as err:
                process = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=err,
                                           text=True, encoding='utf-8', errors='replace')
                def read_stdout():
                    assert process is not None and process.stdout is not None
                    try:
                        for line in process.stdout:
                            channel.put(line)
                    finally:
                        channel.put(None)
                reader = threading.Thread(target=read_stdout, daemon=True)
                reader.start()
                last_notice = 0.0
                previous_progress = None
                while process.poll() is None or not channel.empty():
                    now = time.monotonic()
                    if self.cancel.is_set():
                        raise RenderCancelled('영상 생성을 취소했습니다. 원본과 이전 완성 영상은 그대로입니다.')
                    try:
                        line = channel.get(timeout=.12)
                    except queue.Empty:
                        line = None
                    if line is not None:
                        output.append(line)
                        key, sep, value = line.strip().partition('=')
                        if is_ffmpeg and sep:
                            status[key] = value
                            # A repeated progress=continue heartbeat with the SAME
                            # frame/time must not prevent stalled-job timeout.
                            if key == 'progress':
                                progress = (status.get('frame'), status.get('out_time_us'), status.get('total_size'))
                                if progress != previous_progress:
                                    last_activity = now
                                    previous_progress = progress
                    if now-last_notice >= .5:
                        self.heartbeat({**status, 'elapsed_seconds': round(now-self.started,1),
                                        'command_elapsed_seconds': round(now-started,1),
                                        'last_activity_seconds': round(now-last_activity,1)})
                        last_notice = now
                    if now-last_activity > timeout:
                        raise RenderCommandError(f'{Path(cmd[0]).name}: {timeout:g}초 동안 진행이 없어 중단했습니다. '
                                                 '원본 해독 오류·디스크 공간·아래 상세 로그를 확인하세요. '
                                                 '계속 진행 중인 긴 영상은 총 소요시간 때문에 중단하지 않습니다.')
                reader.join(timeout=2)
                while not channel.empty():
                    line = channel.get_nowait()
                    if line is not None:
                        output.append(line)
                process.wait()
                err.flush();err.seek(0);stderr = err.read()
                self.log(f'exit={process.returncode}, seconds={time.monotonic()-started:.2f}\n{stderr}')
                stdout = ''.join(output)
                if process.returncode:
                    raise RenderCommandError(f'{Path(cmd[0]).name} 실패({process.returncode})\n{stderr[-3000:]}')
                return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)
        except Exception as exc:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(timeout=3)
            self.log(f'ERROR: {type(exc).__name__}: {exc}')
            if stderr_path.exists():
                self.log(stderr_path.read_text(encoding='utf-8', errors='replace'))
            raise
        finally:
            if process is not None and process.stdout is not None:
                process.stdout.close()
            stderr_path.unlink(missing_ok=True)
