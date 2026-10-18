"""Non-destructive source-time / output-time conversion for the V8 editor.

`start` and `source_duration` are ORIGINAL-file seconds. `duration` is the
frame-quantised OUTPUT length. Never use output duration as an input trim.
"""
from __future__ import annotations
import math
from typing import Any

MIN_SPEED = 0.1
MAX_SPEED = 3600.0
MAX_SOURCE_SECONDS = 864000.0
MAX_OUTPUT_SECONDS = 3600.0


def finite_number(value: Any, low: float, high: float, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f'{label}: 유효한 숫자를 입력하세요.')
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'{label}: 유효한 숫자를 입력하세요.') from None
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label}: {low:g}~{high:g} 범위만 사용할 수 있습니다.')
    return value


def speed_of(row: dict[str, Any]) -> float:
    return finite_number(row.get('playback_speed', 1), MIN_SPEED, MAX_SPEED, '재생속도')


def source_span(row: dict[str, Any]) -> float:
    return float(row.get('source_duration', float(row['duration']) * speed_of(row)))


def output_frames(span: float, speed: float, fps: int) -> int:
    # Floors to a whole output frame, stable with persisted 6-decimal seconds.
    return math.floor(span / speed * fps + 1e-4)


def video_timing(row: dict[str, Any], length: float, fps: int) -> dict[str, float]:
    speed = speed_of(row)
    start = finite_number(row.get('start', 0), 0, MAX_SOURCE_SECONDS, '원본 시작점')
    span = finite_number(row.get('source_duration', float(row.get('duration', 0)) * speed),
                         0.000001, MAX_SOURCE_SECONDS, '선택한 원본 구간')
    if start + span > length + 1e-5:
        raise ValueError(f'끝점이 원본 길이({length:.3f}초)를 초과합니다. 시작점·끝점을 확인하세요.')
    n = output_frames(span, speed, fps)
    if n < 1:
        raise ValueError(f'이 배속의 완성 길이가 1프레임보다 짧습니다. 구간을 늘리거나 배속을 낮추세요. (최소 {1/fps:.3f}초)')
    if span / speed > MAX_OUTPUT_SECONDS + 1e-4:
        raise ValueError('장면의 완성 길이는 3600초까지입니다. 배속을 높이거나 선택 구간을 줄이세요.')
    return {'start': round(start, 6), 'source_duration': round(span, 6),
            'playback_speed': speed, 'duration': round(n / fps, 6)}


def atempo_filter(speed: float) -> str:
    """Keep each atempo stage within [0.5,2] (also supports 120x and 0.1x)."""
    remaining = finite_number(speed, MIN_SPEED, MAX_SPEED, '오디오 배속')
    factors: list[float] = []
    while remaining > 2.0 + 1e-9:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5 - 1e-9:
        factors.append(0.5)
        remaining /= 0.5
    if not math.isclose(remaining, 1, abs_tol=1e-9) or not factors:
        factors.append(remaining)
    return ','.join(f'atempo={x:.12g}' for x in factors)


def original_audio_enabled(row: dict[str, Any], has_audio: bool, globally_muted: bool) -> bool:
    mode = row.get('speed_audio', 'auto')
    return bool(has_audio and row.get('keep_audio') and not globally_muted and mode != 'mute'
                and (mode == 'stretch' or 0.25 <= speed_of(row) <= 4.0))
