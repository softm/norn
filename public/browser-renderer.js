/**
 * Local, real-time video export. No server, filesystem path, upload or encoder download.
 * The browser's native decoders play the selected originals; a canvas and Web Audio
 * produce the stream recorded by MediaRecorder. This deliberately does not claim
 * frame-exact/offline rendering or silently approximate unsupported editor effects.
 */
import { styles as allStyles, audioDefaults } from './domain.js';

export const BROWSER_RENDER_LIMITS = Object.freeze({
  maxEdge: 1920, maxPixels: 1920 * 1080, minFps: 10, maxFps: 60,
  maxDuration: 600, maxScenes: 120, minSpeed: .25, maxSpeed: 4,
  maxOutputBytes: 512 * 1024 * 1024, previewEdge: 960,
});
export const BROWSER_TRANSITIONS = Object.freeze({
  cut: '바로 연결', fade: '부드러운 겹침', fadeblack: '검정 전환',
  fadewhite: '흰색 전환', wipeleft: '왼쪽 와이프', wiperight: '오른쪽 와이프',
  wipeup: '위쪽 와이프', wipedown: '아래쪽 와이프',
});
export const BROWSER_STYLES = Object.freeze({ ...allStyles });
const FONT_FAMILIES = Object.freeze({
  default: 'system-ui, -apple-system, "Noto Sans KR", "Malgun Gothic", sans-serif',
  bold: '"Arial Black", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif',
  serif: '"Noto Serif KR", "AppleMyungjo", "Batang", Georgia, serif',
  rounded: 'ui-rounded, "Arial Rounded MT Bold", "Noto Sans KR", system-ui, sans-serif',
});
// A bare video/mp4 probe can select VP9/Opus in MP4 on Chromium. Request AVC/AAC
// explicitly so an MP4 choice does not hide an unexpected codec combination.
const RECORDING_TYPES = Object.freeze([
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm',
]);
const BACKGROUND_MESSAGE = '영상 생성 중 다른 탭이나 앱으로 이동해 작업을 멈췄습니다. 노른 화면을 유지한 채 다시 생성하세요.';
const PERFORMANCE_MESSAGE = '기기의 영상 처리 속도가 부족해 생성을 중단했습니다. 출력 해상도·FPS를 낮추거나 장면을 짧게 나누어 다시 생성하세요.';
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export class BrowserRenderError extends Error {
  constructor(message, code = 'BROWSER_RENDER') { super(message); this.name = 'BrowserRenderError'; this.code = code; }
}
function fail(message, code) { throw new BrowserRenderError(message, code); }
function number(value, fallback, low, high, label) {
  const n = value == null ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < low || n > high) {
    fail(`${label}: ${low}~${high} 범위의 숫자를 입력하세요.`, 'INVALID_SETTING');
  }
  return n;
}
function oneOf(value, fallback, values, label) {
  const key = value ?? fallback;
  if (!values.includes(key)) fail(`${label} “${key}”은 브라우저에서 지원하지 않습니다. 지원되는 설정을 선택하세요.`, 'UNSUPPORTED_SETTING');
  return key;
}
export function browserFormat(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (base === 'video/mp4') return { mimeType, extension: 'mp4', label: 'MP4' };
  if (base === 'video/webm') return { mimeType, extension: 'webm', label: 'WebM' };
  fail('브라우저가 지원되는 MP4/WebM 형식을 반환하지 않았습니다.', 'UNSUPPORTED_FORMAT');
}

/** The optional environment makes support decisions testable without creating a DOM. */
export function getBrowserRenderSupport(env = globalThis) {
  const missing = [];
  if (typeof env.MediaRecorder !== 'function' || typeof env.MediaRecorder.isTypeSupported !== 'function') missing.push('영상 저장');
  if (typeof env.HTMLCanvasElement?.prototype?.captureStream !== 'function') missing.push('화면 합성');
  if (typeof env.MediaStream !== 'function') missing.push('영상 스트림');
  if (typeof env.requestAnimationFrame !== 'function') missing.push('영상 프레임');
  const audioSupported = typeof (env.AudioContext || env.webkitAudioContext) === 'function';
  const unavailable = reason => ({ supported: false, mimeType: '', extension: '', label: '', reason, audioSupported });
  if (missing.length) return unavailable(`이 브라우저는 ${missing.join('·')} 기능을 제공하지 않습니다. 최신 Chrome, Edge 또는 Safari에서 열어주세요.`);
  for (const mimeType of RECORDING_TYPES) {
    try {
      if (env.MediaRecorder.isTypeSupported(mimeType)) return { supported: true, ...browserFormat(mimeType), reason: '', audioSupported };
    } catch { /* A codec probe must not break the editor. Try the next candidate. */ }
  }
  return unavailable('이 브라우저에서 저장 가능한 MP4/WebM 코덱을 찾지 못했습니다. 다른 최신 브라우저에서 열어주세요.');
}

function hasSource(source) {
  return typeof source?.url === 'string' && !!source.url
    || typeof Blob !== 'undefined' && (source?.file instanceof Blob || source?.blob instanceof Blob);
}

/** Pure preflight; it never modifies the variant, media, paths or originals. */
export function validateBrowserRender(variant, media, { support = getBrowserRenderSupport(), preview = false } = {}) {
  if (!support?.supported) fail(support?.reason || '이 브라우저에서 영상을 저장할 수 없습니다.', 'UNSUPPORTED_BROWSER');
  const format = browserFormat(support.mimeType);
  if (!variant || !Array.isArray(variant.scenes) || !variant.scenes.length) fail('타임라인에 사진이나 영상 장면을 먼저 추가하세요.', 'EMPTY_TIMELINE');
  if (variant.scenes.length > BROWSER_RENDER_LIMITS.maxScenes) fail('브라우저 영상 한 편은 최대 120개 장면까지 생성할 수 있습니다.', 'TOO_MANY_SCENES');
  if (!Array.isArray(media)) fail('원본 자료를 다시 선택하세요.', 'MISSING_SOURCE');
  const originalWidth = number(variant.settings?.width, 1080, 144, 3840, '출력 가로');
  const originalHeight = number(variant.settings?.height, 1920, 144, 3840, '출력 세로');
  if (!Number.isInteger(originalWidth) || !Number.isInteger(originalHeight) || originalWidth % 2 || originalHeight % 2) fail('출력 가로·세로는 짝수 픽셀로 설정하세요.', 'INVALID_SIZE');
  const fps = number(variant.settings?.fps, 30, BROWSER_RENDER_LIMITS.minFps, BROWSER_RENDER_LIMITS.maxFps, 'FPS');
  if (!Number.isInteger(fps)) fail('FPS는 정수로 입력하세요.', 'INVALID_FPS');
  const scale = preview ? Math.min(1, BROWSER_RENDER_LIMITS.previewEdge / Math.max(originalWidth, originalHeight)) : 1;
  const width = Math.max(2, Math.round(originalWidth * scale / 2) * 2);
  const height = Math.max(2, Math.round(originalHeight * scale / 2) * 2);
  if (Math.max(width, height) > BROWSER_RENDER_LIMITS.maxEdge || width * height > BROWSER_RENDER_LIMITS.maxPixels) {
    fail('브라우저 출력은 장변 1920px·약 207만 픽셀까지입니다. 1920×1080, 1080×1920 또는 더 작은 해상도를 선택하세요.', 'SIZE_LIMIT');
  }
  const warnings = [];
  if (format.extension === 'webm') warnings.push('이 브라우저는 WebM으로 저장합니다. MP4 파일로 이름만 바꾸어도 형식은 바뀌지 않습니다.');
  if (preview && scale < 1) warnings.push(`미리보기용 ${width}×${height} 해상도로 생성합니다.`);
  const sources = new Map();
  for (const item of media) {
    if (sources.has(item.id)) fail('같은 식별자를 가진 원본이 두 개 있습니다. 원본을 다시 연결하세요.', 'DUPLICATE_SOURCE');
    sources.set(item.id, item);
  }
  const rawAudio = { ...audioDefaults(), ...variant.audio };
  const audio = {
    mute_original: Boolean(rawAudio.mute_original),
    original_volume: number(rawAudio.original_volume, 1, 0, 2, '원음 음량'),
    music_id: String(rawAudio.music_id || ''), music_volume: number(rawAudio.music_volume, .22, 0, 1, '음악 음량'),
    music_start: number(rawAudio.music_start, 0, 0, 864000, '음악 시작점'), loop: Boolean(rawAudio.loop),
    fade_in: number(rawAudio.fade_in, .6, 0, 60, '음악 페이드인'), fade_out: number(rawAudio.fade_out, 1, 0, 60, '음악 페이드아웃'),
  };
  const sceneIds = new Set();
  const scenes = variant.scenes.map((input, index) => {
    const prefix = `${index + 1}번 장면`;
    if (!input || typeof input !== 'object') fail(`${prefix} 설정을 확인하세요.`, 'INVALID_SCENE');
    if (sceneIds.has(input.id)) fail('타임라인 장면 식별자가 중복되었습니다.', 'DUPLICATE_SCENE');
    sceneIds.add(input.id);
    const source = sources.get(input.source_id);
    if (!source || !hasSource(source)) fail(`${prefix} 원본을 다시 선택하세요.`, 'MISSING_SOURCE');
    if (!['image', 'video'].includes(source.kind)) fail(`${prefix}에는 사진이나 동영상만 사용할 수 있습니다.`, 'INVALID_SOURCE');
    if (source.error || source.analysis?.error) fail(`${prefix} 원본을 브라우저에서 읽을 수 없습니다. 다른 파일을 선택하세요.`, 'UNREADABLE_SOURCE');
    const style = oneOf(input.style, 'clean', Object.keys(BROWSER_STYLES), `${prefix} 글씨 스타일`);
    const transition = oneOf(input.transition, 'cut', Object.keys(BROWSER_TRANSITIONS), `${prefix} 전환`);
    const motion = oneOf(input.motion, 'zoom', ['zoom', 'none'], `${prefix} 사진 움직임`);
    const font_family = oneOf(input.font_family, 'default', Object.keys(FONT_FAMILIES), `${prefix} 글꼴`);
    const text_position = oneOf(input.text_position, 'bottom', ['top', 'middle', 'bottom'], `${prefix} 글씨 위치`);
    const speed_audio = oneOf(input.speed_audio, 'auto', ['auto', 'mute', 'stretch'], `${prefix} 배속 원음`);
    const title = String(input.title ?? ''); const caption = String(input.caption ?? '');
    if (title.length > 100 || caption.length > 240) fail(`${prefix} 타이틀은 100자, 문구는 240자까지 입력하세요.`, 'TEXT_LIMIT');
    const duration = number(input.duration, undefined, 1 / fps - .00001, BROWSER_RENDER_LIMITS.maxDuration, `${prefix} 재생 시간`);
    const title_size = number(input.title_size, 52, 12, 200, `${prefix} 타이틀 크기`);
    const font_size = number(input.font_size, 42, 12, 200, `${prefix} 문구 크기`);
    const transition_duration = number(input.transition_duration, .3, 0, 3, `${prefix} 전환 길이`);
    let speed = 1; let sourceStart = 0; let sourceSpan = duration;
    if (source.kind === 'video') {
      speed = number(input.playback_speed, 1, .1, 3600, `${prefix} 배속`);
      if (speed < BROWSER_RENDER_LIMITS.minSpeed || speed > BROWSER_RENDER_LIMITS.maxSpeed) {
        fail(`${prefix}: 브라우저 영상 생성은 0.25~4배속을 지원합니다. ${speed}배속을 지원 범위로 변경하세요. 고배속 프레임 추출은 현재 브라우저 내보내기에서 지원하지 않습니다.`, 'SPEED_LIMIT');
      }
      const sourceLength = number(source.analysis?.duration, undefined, .000001, 864000, `${prefix} 원본 길이`);
      sourceStart = number(input.start, 0, 0, sourceLength, `${prefix} 원본 시작점`);
      sourceSpan = number(input.source_duration, duration * speed, .000001, sourceLength, `${prefix} 원본 구간`);
      if (sourceStart + sourceSpan > sourceLength + .001) fail(`${prefix} 끝점이 원본 길이를 넘습니다.`, 'SOURCE_BOUNDS');
      const expectedFrames = Math.floor(sourceSpan / speed * fps + .0001);
      if (expectedFrames < 1 || Math.abs(duration - expectedFrames / fps) > .001) {
        fail(`${prefix} 원본 구간·배속·완성 길이가 맞지 않습니다. 시작점 또는 끝점을 다시 적용하세요.`, 'TIMING_MISMATCH');
      }
    }
    const keepAudio = source.kind === 'video' && Boolean(input.keep_audio) && !audio.mute_original
      && speed_audio !== 'mute' && audio.original_volume > 0 && source.analysis?.has_audio !== false;
    if (source.kind === 'video' && input.keep_audio && !audio.mute_original && source.analysis?.has_audio === false) warnings.push(`${prefix}에는 원음 트랙이 없습니다.`);
    const scene = { ...input, title, caption, duration, style, transition, transition_duration, motion, font_family, text_position, speed_audio, title_size, font_size };
    return { index, id: input.id, sourceId: input.source_id, source, scene, duration, speed, sourceStart, sourceSpan, keepAudio, start: 0, end: 0, overlap: 0 };
  });
  let t = 0;
  for (const entry of scenes) {
    const next = scenes[entry.index + 1];
    if (next && entry.scene.transition !== 'cut') {
      const limit = Math.min(entry.duration, next.duration) / 2;
      if (entry.scene.transition_duration < 1 / fps - .00001 || entry.scene.transition_duration > limit + .00001) {
        fail(`${entry.index + 1}번 전환 길이는 ${Math.ceil(1000 / fps) / 1000}~${Math.floor(limit * 1000) / 1000}초로 설정하세요. 장면 길이의 절반을 넘길 수 없습니다.`, 'TRANSITION_BOUNDS');
      }
      entry.overlap = entry.scene.transition_duration;
    }
    entry.start = t; entry.end = t + entry.duration; t = entry.end - entry.overlap;
  }
  const duration = scenes.at(-1).end;
  if (duration > BROWSER_RENDER_LIMITS.maxDuration + .001) fail('브라우저 영상 한 편은 최대 10분입니다. 출력 버전을 나누거나 구간을 줄여주세요.', 'DURATION_LIMIT');
  let music = null;
  if (audio.music_id) {
    music = sources.get(audio.music_id);
    if (!music || music.kind !== 'audio' || !hasSource(music)) fail('선택한 음악 파일을 다시 가져오거나 음악 없음을 선택하세요.', 'MISSING_MUSIC');
    const musicDuration = number(music.analysis?.duration, undefined, .000001, 864000, '음악 길이');
    if (audio.music_start >= musicDuration) fail('음악 시작점은 음악 길이보다 짧아야 합니다.', 'MUSIC_BOUNDS');
    if (!audio.loop && musicDuration - audio.music_start < duration) warnings.push('음악 반복을 끈 상태여서 음악이 끝난 뒤에는 배경음악 없이 이어집니다.');
  }
  const needsAudio = scenes.some(s => s.keepAudio) || !!music && audio.music_volume > 0;
  if (needsAudio && support.audioSupported === false) fail('이 브라우저에서 오디오 합성을 사용할 수 없습니다. 원음·음악을 끄거나 다른 최신 브라우저에서 열어주세요.', 'UNSUPPORTED_AUDIO');
  const videoBitsPerSecond = Math.round(clamp(width * height * fps * .16, 1_000_000, 16_000_000));
  if ((videoBitsPerSecond + (needsAudio ? 160000 : 0)) * duration / 8 > BROWSER_RENDER_LIMITS.maxOutputBytes * .9) {
    fail('예상 결과 파일이 브라우저 메모리 한도를 넘습니다. 해상도·FPS를 낮추거나 영상을 짧게 나누세요.', 'OUTPUT_SIZE_LIMIT');
  }
  const referenceWidth=number(variant.settings?.text_reference_width,originalWidth,144,3840,'글씨 기준 가로');
  return { ...format, width, height, textScale:width/referenceWidth, fps, duration, scenes, audio, music, needsAudio, warnings, preview: Boolean(preview), videoBitsPerSecond, realtime: true };
}

/** Output seconds -> original-file seconds. Outgoing transitions overlap adjacent clips. */
export function sampleBrowserTimeline(plan, time) {
  if (!Number.isFinite(time)) fail('재생 위치가 올바르지 않습니다.', 'INVALID_TIME');
  const t = clamp(time, 0, Math.max(0, plan.duration - .0000001));
  const layers = plan.scenes.filter(s => t >= s.start && t < s.end).map(entry => {
    const localTime = clamp(t - entry.start, 0, entry.duration);
    const sourceTime = entry.source.kind === 'video'
      ? Math.min(entry.sourceStart + Math.max(0, entry.sourceSpan - .000001), entry.sourceStart + localTime * entry.speed) : 0;
    return { index: entry.index, localTime, sourceTime, audioGain: 1 };
  });
  let transition = null;
  if (layers.length === 2) {
    const outgoing = plan.scenes[layers[0].index];
    const progress = clamp((t - (outgoing.end - outgoing.overlap)) / outgoing.overlap, 0, 1);
    transition = { type: outgoing.scene.transition, progress };
    layers[0].audioGain = 1 - progress; layers[1].audioGain = progress;
  }
  return { time: t, layers, transition };
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('영상 생성을 취소했습니다.', 'AbortError');
}
function check(signal) { if (signal.aborted) throw abortReason(signal); }
function eventReady(target, events, { signal, ready = () => false, timeout = 15000, label = '자료', trigger } = {}) {
  return new Promise((resolve, reject) => {
    let timer; let finished = false;
    const cleanup = () => { clearTimeout(timer); events.forEach(event => target.removeEventListener(event, done)); target.removeEventListener('error', error); signal?.removeEventListener('abort', cancel); };
    const settle = (callback, value) => { if (finished) return; finished = true; cleanup(); callback(value); };
    const done = () => { if (ready()) settle(resolve); };
    const error = () => settle(reject, new BrowserRenderError(`${label}을 브라우저에서 재생할 수 없습니다. 파일 형식·코덱을 확인하세요.`, 'DECODE_ERROR'));
    const cancel = () => settle(reject, abortReason(signal));
    if (signal?.aborted) { cancel(); return; }
    events.forEach(event => target.addEventListener(event, done)); target.addEventListener('error', error);
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => settle(reject, new BrowserRenderError(`${label}을 준비하는 시간이 초과되었습니다. 다른 파일을 선택하거나 다시 시도하세요.`, 'MEDIA_TIMEOUT')), timeout);
    try { trigger?.(); done(); } catch (e) { settle(reject, e); }
  });
}
function bounded(promise, signal, label, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let timer; let finished = false;
    const settle = (callback, value) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); callback(value); };
    const cancel = () => settle(reject, abortReason(signal));
    if (signal.aborted) { promise.catch?.(() => {}); cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => settle(reject, new BrowserRenderError(`${label} 시간이 초과되었습니다. 다시 시도하세요.`, 'RENDER_TIMEOUT')), timeout);
    Promise.resolve(promise).then(value => settle(resolve, value), error => settle(reject, error));
  });
}
function nextFrame(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    let id;
    const cancel = () => { cancelAnimationFrame(id); signal.removeEventListener('abort', cancel); reject(abortReason(signal)); };
    signal.addEventListener('abort', cancel, { once: true });
    id = requestAnimationFrame(time => { signal.removeEventListener('abort', cancel); resolve(time); });
  });
}
async function seek(media, time, signal, label) {
  const target = clamp(time, 0, Math.max(0, media.duration - .001));
  if (Math.abs(media.currentTime - target) < .0001 && media.readyState >= 2 && !media.seeking) return;
  await eventReady(media, ['seeked', 'loadeddata', 'canplay'], { signal, label, ready: () => !media.seeking && media.readyState >= 2 && Math.abs(media.currentTime - target) < .05,
    trigger: () => { media.currentTime = target; } });
}
function mediaURL(source, ownedURLs) {
  const blob = source.file instanceof Blob ? source.file : source.blob instanceof Blob ? source.blob : null;
  if (blob) { const url = URL.createObjectURL(blob); ownedURLs.add(url); return url; }
  if (typeof source.url !== 'string' || !source.url) fail('원본 자료를 다시 선택하세요.', 'MISSING_SOURCE');
  const parsed = new URL(source.url, document.baseURI);
  if (!['blob:', 'data:', 'https:', 'http:'].includes(parsed.protocol)) fail('원본 파일을 다시 선택하세요. 로컬 경로 문자열은 불러올 수 없습니다.', 'INVALID_SOURCE_URL');
  return parsed.href;
}
function canvas(width, height) {
  const element = document.createElement('canvas'); element.width = width; element.height = height;
  const context = element.getContext('2d', { alpha: false });
  if (!context) fail('영상 합성 화면을 만들 수 없습니다. 브라우저를 다시 열어주세요.', 'CANVAS_UNAVAILABLE');
  return { element, context };
}
function roundedRect(ctx, x, y, width, height, radius) {
  radius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius); ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height); ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius); ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y); ctx.closePath();
}
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    let line = '';
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = char; } else line += char;
    }
    lines.push(line);
  }
  return text ? lines : [];
}

/** Pre-render each text card once; the animation only draws its bitmap. */
function textCard(scene, width, height, warnings, textScale = 1) {
  if (!scene.title && !scene.caption) return null;
  const ratio = textScale; const cw = Math.round(width * .88); const pad = Math.max(5, Math.round(width * .027));
  const element = document.createElement('canvas'); const ctx = element.getContext('2d');
  if (!ctx) fail('영상 글씨를 그릴 수 없습니다.', 'CANVAS_UNAVAILABLE');
  const family = FONT_FAMILIES[scene.font_family]; const weight = scene.font_family === 'bold' ? 900 : 700;
  let fs = Math.max(7, Math.round(scene.font_size * ratio)); let ts = Math.max(6, Math.round(scene.title_size * ratio));
  const originalFs = fs; const originalTs = ts;
  let lines; let titles; let lineHeight; let titleHeight; let gap; let ch;
  for (let attempt = 0; attempt < 240; attempt++) {
    ctx.font = `${weight} ${ts}px ${family}`; titles = wrapText(ctx, scene.title, cw - 2 * pad);
    ctx.font = `${scene.font_family === 'bold' ? 800 : 500} ${fs}px ${family}`; lines = wrapText(ctx, scene.caption, cw - 2 * pad);
    lineHeight = Math.ceil(fs * 1.45); titleHeight = Math.ceil(ts * 1.5); gap = titles.length && lines.length ? Math.round(width * .013) : 0;
    ch = pad * 2 + titles.length * titleHeight + lines.length * lineHeight + gap;
    if (ch <= height * .48 && lines.length <= 4 && titles.length <= 3 || fs === 6 && ts === 5) break;
    fs = Math.max(6, fs - 1); ts = Math.max(5, ts - 1);
  }
  if (ch > height * .82) fail('글씨가 화면에 모두 들어가지 않습니다. 문구나 글씨 크기를 줄여주세요.', 'TEXT_OVERFLOW');
  if (fs < originalFs || ts < originalTs) warnings.add(`${scene.name || '장면'}: 문구가 잘리지 않도록 글씨 크기를 자동 맞췄습니다.`);
  element.width = cw; element.height = Math.ceil(ch);
  const edge = Math.max(1, Math.round(width * .003)); const radius = Math.max(6, Math.round(width * .02));
  let ink = '#ffffff'; let accent = '#cdf363'; const style = scene.style;
  const fill = (color, rounded = true) => { ctx.fillStyle = color; if (rounded) { roundedRect(ctx, 0, 0, cw, ch, radius); ctx.fill(); } else ctx.fillRect(0, 0, cw, ch); };
  const line = (x1, y1, x2, y2, color) => { ctx.strokeStyle = color; ctx.lineWidth = edge; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  if (style === 'clean') fill('rgba(10,16,26,.69)');
  else if (style === 'bold_shortform') { fill('rgba(13,18,28,.89)'); ctx.fillStyle = accent; ctx.fillRect(pad, 0, cw / 4, edge * 2); }
  else if (style === 'info_card') { accent = '#49e7d0'; fill('rgba(6,31,39,.89)'); ctx.strokeStyle = accent; ctx.lineWidth = edge; roundedRect(ctx, edge / 2, edge / 2, cw - edge, ch - edge, radius); ctx.stroke(); ctx.fillStyle = accent; ctx.fillRect(2, 8, edge * 2, ch - 16); }
  else if (style === 'emotional') { ink = '#fff4de'; accent = '#f7cd9d'; fill('rgba(22,24,31,.37)'); line(cw * .42, ch - 3, cw * .58, ch - 3, accent); }
  else if (style === 'sticker') { ink = '#141923'; accent = '#203041'; fill('rgba(231,252,157,.97)'); }
  else if (style === 'cinema') { accent = '#eecf89'; line(cw * .35, 2, cw * .65, 2, accent); }
  else if (style === 'lower_third') { accent = '#80c6ff'; fill('rgba(14,41,72,.875)', false); ctx.fillStyle = accent; ctx.fillRect(0, 0, edge * 3, ch); }
  else if (style === 'editorial') { ink = '#16171a'; accent = '#bf402c'; fill('rgba(250,245,231,.95)', false); line(pad, ch - pad / 2, cw - pad, ch - pad / 2, accent); }
  const centered = ['clean', 'emotional', 'outline', 'neon', 'cinema'].includes(style);
  ctx.textAlign = centered ? 'center' : 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  let y = pad;
  for (const [values, size, lineH, color, bold] of [[titles, ts, titleHeight, accent, weight], [lines, fs, lineHeight, ink, scene.font_family === 'bold' ? 800 : 500]]) {
    ctx.font = `${bold} ${size}px ${family}`; ctx.fillStyle = color;
    for (const text of values) {
      const x = centered ? cw / 2 : pad;
      if (['outline', 'cinema', 'neon'].includes(style)) { ctx.strokeStyle = 'rgba(5,8,15,.96)'; ctx.lineWidth = Math.max(1, size * .13); ctx.strokeText(text, x, y); }
      ctx.shadowColor = style === 'neon' ? '#4ae6fa' : 'transparent'; ctx.shadowBlur = style === 'neon' ? Math.max(2, width * .008) : 0;
      ctx.fillText(text, x, y); ctx.shadowBlur = 0; y += lineH;
    }
    if (values === titles && values.length) y += gap;
  }
  return { element, x: (width - cw) / 2, y: Math.max(0, Math.min(Math.round(height * { top: .12, middle: .42, bottom: .66 }[scene.text_position]), height - ch - height * .09)), width: cw, height: ch };
}
function drawScene(resource, entry, localTime, width, height) {
  const ctx = resource.canvas.context; ctx.globalAlpha = 1; ctx.fillStyle = '#0c1422'; ctx.fillRect(0, 0, width, height);
  const el = resource.element; const iw = el.videoWidth || el.naturalWidth; const ih = el.videoHeight || el.naturalHeight;
  if (!iw || !ih) fail(`${entry.index + 1}번 장면을 그릴 수 없습니다.`, 'DECODE_ERROR');
  const scale = Math.min(width / iw, height / ih) * (entry.source.kind === 'image' && entry.scene.motion === 'zoom' ? 1 + .14 * clamp(localTime / entry.duration, 0, 1) : 1);
  ctx.drawImage(el, (width - iw * scale) / 2, (height - ih * scale) / 2, iw * scale, ih * scale);
  if (resource.card) {
    const card = resource.card; const duration = entry.duration;
    const fadeIn = Math.min(.18, duration * .3); const fadeOut = Math.min(.12, duration * .25);
    ctx.globalAlpha = Math.min(1, localTime / fadeIn, Math.max(0, duration - localTime) / fadeOut);
    let x = card.x; let y = card.y; const enter = 1 - clamp(localTime / Math.min(.22, duration * .3), 0, 1);
    if (['bold_shortform', 'sticker'].includes(entry.scene.style)) x += width * .12 * enter;
    else if (['info_card', 'lower_third'].includes(entry.scene.style)) y += height * .04 * enter;
    ctx.drawImage(card.element, x, y); ctx.globalAlpha = 1;
  }
}
function composite(ctx, layers, transition, resources, width, height) {
  if (!layers.length) fail('해당 위치에 재생할 장면이 없습니다.', 'TIMELINE_GAP');
  ctx.save(); ctx.globalAlpha = 1;
  const a = resources.get(layers[0].index).canvas.element;
  ctx.drawImage(a, 0, 0);
  if (transition && layers.length === 2) {
    const b = resources.get(layers[1].index).canvas.element; const p = transition.progress;
    if (transition.type === 'fade') { ctx.globalAlpha = p; ctx.drawImage(b, 0, 0); }
    else if (['fadeblack', 'fadewhite'].includes(transition.type)) {
      if (p >= .5) ctx.drawImage(b, 0, 0);
      ctx.globalAlpha = p < .5 ? p * 2 : (1 - p) * 2; ctx.fillStyle = transition.type === 'fadeblack' ? '#000' : '#fff'; ctx.fillRect(0, 0, width, height);
    } else {
      ctx.beginPath();
      if (transition.type === 'wipeleft') ctx.rect(width * (1 - p), 0, width * p, height);
      else if (transition.type === 'wiperight') ctx.rect(0, 0, width * p, height);
      else if (transition.type === 'wipeup') ctx.rect(0, height * (1 - p), width, height * p);
      else if (transition.type === 'wipedown') ctx.rect(0, 0, width, height * p);
      else fail('지원하지 않는 영상 전환입니다.', 'UNSUPPORTED_SETTING');
      ctx.clip(); ctx.drawImage(b, 0, 0);
    }
  }
  ctx.restore();
}

/**
 * onProgress receives {stage, percent, detail, elapsed, duration}. AbortSignal
 * cancels initialization, playback, encoding and finalization. A hidden page is
 * aborted: missing background frames are never reported as a completed export.
 */
export async function renderInBrowser({ variant, media, signal: externalSignal, onProgress = () => {}, preview = false }) {
  const plan = validateBrowserRender(variant, media, { preview });
  const control = new AbortController(); const signal = control.signal;
  const cancelExternal = () => control.abort(externalSignal?.reason instanceof Error ? externalSignal.reason : new DOMException('영상 생성을 취소했습니다.', 'AbortError'));
  externalSignal?.addEventListener('abort', cancelExternal, { once: true });
  if (externalSignal?.aborted) cancelExternal();
  const stopForBackground = () => { if (document.visibilityState === 'hidden') control.abort(new BrowserRenderError(BACKGROUND_MESSAGE, 'BACKGROUND_INTERRUPTED')); };
  const pageHidden = () => control.abort(new BrowserRenderError(BACKGROUND_MESSAGE, 'BACKGROUND_INTERRUPTED'));
  document.addEventListener('visibilitychange', stopForBackground); window.addEventListener('pagehide', pageHidden);
  const ownedURLs = new Set(); const resources = new Map(); const warningSet = new Set(plan.warnings);
  let audioContext; let audioDestination; let compressor; let musicResource; let output; let stream; let recorder; let host;
  let stopResolve; let stopReject; let recordingStarted = 0; let totalBytes = 0; let chunks = []; let timeout;
  let lastReported = -Infinity; let cleaned = false;
  const progress = (stage, percent, detail, elapsed = 0) => {
    // Reporting is a UI concern. A listener exception must not leave media running.
    try { onProgress({ stage, percent: clamp(percent, 0, 100), detail, elapsed, duration: plan.duration }); } catch { /* ignored */ }
  };
  const dispose = resource => {
    if (!resource || resource.disposed) return;
    resource.disposed = true; resource.node?.disconnect(); resource.gain?.disconnect();
    if (resource.element) {
      resource.element.removeEventListener('error', resource.errorHandler);
      resource.element.pause?.(); resource.element.removeAttribute('src'); resource.element.load?.(); resource.element.remove();
    }
    if (resource.canvas) resource.canvas.element.width = resource.canvas.element.height = 0;
    if (resource.card) resource.card.element.width = resource.card.element.height = 0;
    if (resource.ownedURL) { URL.revokeObjectURL(resource.ownedURL); ownedURLs.delete(resource.ownedURL); }
  };
  const attachAudio = resource => {
    resource.node = audioContext.createMediaElementSource(resource.element); resource.gain = audioContext.createGain();
    resource.gain.gain.value = 0; resource.node.connect(resource.gain); resource.gain.connect(compressor);
  };
  const sourceElement = (source, kind, label) => {
    const element = document.createElement(kind); const url = mediaURL(source, ownedURLs);
    const errorHandler = () => control.abort(new BrowserRenderError(`${label}을 재생하지 못했습니다. 다른 파일을 선택하세요.`, 'DECODE_ERROR'));
    const resource = { element, ownedURL: ownedURLs.has(url) ? url : null, errorHandler, ready: false, started: false };
    if (/^https?:/.test(url)) element.crossOrigin = 'anonymous';
    element.addEventListener('error', errorHandler);
    if (kind !== 'img') { element.preload = 'auto'; element.playsInline = true; element.setAttribute('playsinline', ''); }
    host.append(element); resource.url = url;
    return resource;
  };
  const prepare = index => {
    if (index >= plan.scenes.length) return Promise.resolve();
    if (resources.has(index)) return resources.get(index).promise;
    const entry = plan.scenes[index]; const label = `${index + 1}번 원본`;
    const resource = sourceElement(entry.source, entry.source.kind === 'video' ? 'video' : 'img', label);
    resources.set(index, resource);
    resource.promise = (async () => {
      check(signal);
      if (entry.source.kind === 'video') {
        resource.element.muted = !entry.keepAudio;
        await eventReady(resource.element, ['loadedmetadata', 'loadeddata', 'canplay'], { signal, label, ready: () => resource.element.readyState >= 2,
          trigger: () => { resource.element.src = resource.url; resource.element.load(); } });
        if (!Number.isFinite(resource.element.duration) || entry.sourceStart + entry.sourceSpan > resource.element.duration + .03) fail(`${label} 구간이 실제 재생 가능한 길이를 넘습니다. 원본을 다시 가져오세요.`, 'SOURCE_BOUNDS');
        try { resource.element.playbackRate = entry.speed; } catch { fail(`${label}: 이 브라우저가 ${entry.speed}배속 재생을 허용하지 않습니다. 배속을 변경하세요.`, 'SPEED_UNAVAILABLE'); }
        if (Math.abs(resource.element.playbackRate - entry.speed) > .0001) fail(`${label}: 요청한 배속을 적용할 수 없습니다.`, 'SPEED_UNAVAILABLE');
        if ('preservesPitch' in resource.element) resource.element.preservesPitch = true;
        else if ('webkitPreservesPitch' in resource.element) resource.element.webkitPreservesPitch = true;
        else if (entry.keepAudio && entry.speed !== 1) fail(`${label}: 이 브라우저는 배속 원음의 음높이를 유지할 수 없습니다. 원음을 끄거나 1배속을 선택하세요.`, 'PITCH_UNAVAILABLE');
        await seek(resource.element, entry.sourceStart, signal, label);
        if (entry.keepAudio) attachAudio(resource);
      } else {
        await eventReady(resource.element, ['load'], { signal, label, ready: () => resource.element.complete && resource.element.naturalWidth > 0,
          trigger: () => { resource.element.src = resource.url; } });
      }
      check(signal);
      resource.canvas = canvas(plan.width, plan.height); resource.card = textCard(entry.scene, plan.width, plan.height, warningSet, plan.textScale);
      drawScene(resource, entry, 0, plan.width, plan.height);
      // Fail before recording if a remote sample lacks the required CORS permission.
      try { resource.canvas.context.getImageData(0, 0, 1, 1); } catch { fail(`${label}의 보안 설정 때문에 영상을 만들 수 없습니다. 해당 원본을 파일 선택으로 다시 가져오세요.`, 'TAINTED_CANVAS'); }
      resource.ready = true;
      return resource;
    })();
    // Preload failures propagate to the active operation even before the clip is due.
    resource.promise.catch(error => { if (!signal.aborted) control.abort(error); });
    return resource.promise;
  };
  const play = (resource, label) => {
    if (resource.started) return;
    resource.started = true;
    try {
      const promise = resource.element.play();
      resource.playPromise = bounded(Promise.resolve(promise), signal, `${label} 재생`, 10000).catch(error => {
        if (!signal.aborted) control.abort(error?.name === 'NotAllowedError' ? new BrowserRenderError('브라우저가 미디어 재생을 막았습니다. 노른 화면에서 생성 버튼을 직접 눌러 다시 시도하세요.', 'PLAYBACK_BLOCKED') : error);
        throw error;
      });
      resource.playPromise.catch(() => {});
    } catch (error) { control.abort(error); }
  };
  try {
    check(signal); stopForBackground(); check(signal);
    timeout = setTimeout(() => control.abort(new BrowserRenderError('영상 생성 제한 시간을 초과했습니다. 해상도·FPS를 낮춰 다시 생성하세요.', 'RENDER_TIMEOUT')), (plan.duration + 90) * 1500);
    progress('preparing', 0, '선택한 원본과 글씨를 준비합니다.');
    host = document.createElement('div'); host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: '2px', height: '2px', overflow: 'hidden', pointerEvents: 'none' }); document.body.append(host);
    output = canvas(plan.width, plan.height); host.append(output.element);
    if (plan.needsAudio) {
      // Do this before the first await so the export click unlocks Web Audio.
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      audioContext = new Context();
      const resume = audioContext.resume();
      audioDestination = audioContext.createMediaStreamDestination(); compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = -1; compressor.knee.value = 0; compressor.ratio.value = 20; compressor.attack.value = .003; compressor.release.value = .15;
      compressor.connect(audioDestination);
      await bounded(resume, signal, '오디오 시작', 10000);
      if (audioContext.state !== 'running') fail('오디오가 일시정지 상태입니다. 생성 버튼을 다시 눌러주세요.', 'AUDIO_SUSPENDED');
    }
    if (document.fonts?.ready) await bounded(document.fonts.ready, signal, '글꼴 준비', 10000);
    // At most the current clip and two upcoming clips are resident. Large folders
    // do not decode every original into memory at the beginning of an export.
    await Promise.all([prepare(0), prepare(1), prepare(2)]);
    if (plan.music && plan.audio.music_volume > 0) {
      musicResource = sourceElement(plan.music, 'audio', '배경음악');
      await eventReady(musicResource.element, ['loadedmetadata', 'loadeddata', 'canplay'], { signal, label: '배경음악', ready: () => musicResource.element.readyState >= 2,
        trigger: () => { musicResource.element.src = musicResource.url; musicResource.element.load(); } });
      if (!Number.isFinite(musicResource.element.duration) || plan.audio.music_start >= musicResource.element.duration) fail('음악 시작점이 실제 음악 길이를 넘습니다.', 'MUSIC_BOUNDS');
      musicResource.element.loop = plan.audio.loop;
      await seek(musicResource.element, plan.audio.music_start, signal, '배경음악'); attachAudio(musicResource); musicResource.ready = true;
    }
    check(signal);
    composite(output.context, [{ index: 0 }], null, resources, plan.width, plan.height);
    stream = output.element.captureStream(plan.fps);
    if (audioDestination) audioDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const options = { mimeType: plan.mimeType, videoBitsPerSecond: plan.videoBitsPerSecond };
    if (audioDestination) options.audioBitsPerSecond = 160000;
    try { recorder = new MediaRecorder(stream, options); } catch (error) { fail(`이 기기에서 ${plan.label} 인코더를 시작할 수 없습니다. 해상도·FPS를 낮춰 다시 생성하세요.`, 'ENCODER_UNAVAILABLE'); }
    const actualFormat = browserFormat(recorder.mimeType || plan.mimeType);
    const stopped = new Promise((resolve, reject) => { stopResolve = resolve; stopReject = reject; }); stopped.catch(() => {});
    recorder.ondataavailable = event => {
      if (!event.data?.size || signal.aborted) return;
      totalBytes += event.data.size;
      if (totalBytes > BROWSER_RENDER_LIMITS.maxOutputBytes) { control.abort(new BrowserRenderError('영상 파일이 512MB를 넘어 생성을 중단했습니다. 해상도·FPS를 낮추거나 짧게 나누세요.', 'OUTPUT_SIZE_LIMIT')); return; }
      chunks.push(event.data);
    };
    recorder.onerror = event => { const error = new BrowserRenderError(event.error?.message || '브라우저 영상 인코더 오류로 중단했습니다.', 'ENCODER_ERROR'); stopReject(error); control.abort(error); };
    recorder.onstop = () => stopResolve();
    await eventReady(recorder, ['start'], { signal, label: '영상 인코더', ready: () => recorder.state === 'recording', trigger: () => recorder.start(1000) });
    recordingStarted = performance.now(); const audioStarted = audioContext?.currentTime;
    let previousFrame = recordingStarted; let elapsed = 0;
    progress('encoding', 5, '이 화면을 유지하세요. 영상 길이만큼 시간이 걸립니다.');
    while (elapsed < plan.duration) {
      check(signal);
      const now = performance.now(); elapsed = (now - recordingStarted) / 1000;
      if (now - previousFrame > 500) fail(PERFORMANCE_MESSAGE, 'FRAME_STALL');
      previousFrame = now;
      if (audioContext && (audioContext.state !== 'running' || Math.abs(audioContext.currentTime - audioStarted - elapsed) > .3)) fail('오디오 재생이 중단되어 영상 생성을 멈췄습니다. 화면 잠금을 풀고 다시 생성하세요.', 'AUDIO_INTERRUPTED');
      if (elapsed >= plan.duration) break;
      const frame = sampleBrowserTimeline(plan, elapsed); const active = new Set(frame.layers.map(layer => layer.index));
      const last = frame.layers.at(-1)?.index ?? 0;
      // Preparing ahead is asynchronous. If a source misses its actual boundary,
      // abort rather than insert a black/frozen frame or alter the planned timing.
      prepare(last + 1); prepare(last + 2);
      for (const [index, resource] of resources) {
        if (index < frame.layers[0].index) { dispose(resource); resources.delete(index); }
        else if (!active.has(index) && resource.gain) resource.gain.gain.setValueAtTime(0, audioContext.currentTime);
      }
      for (const layer of frame.layers) {
        const entry = plan.scenes[layer.index]; const resource = resources.get(layer.index);
        if (!resource?.ready) fail(`${layer.index + 1}번 장면을 제시간에 준비하지 못해 중단했습니다. 해상도·FPS를 낮추거나 원본을 짧게 나누어주세요.`, 'SOURCE_NOT_READY');
        if (entry.source.kind === 'video') {
          play(resource, `${layer.index + 1}번 원본`);
          if (layer.localTime > .35 && Math.abs(resource.element.currentTime - layer.sourceTime) / entry.speed > .35) fail(PERFORMANCE_MESSAGE, 'VIDEO_DESYNC');
          if (resource.element.ended && layer.localTime < entry.duration - .1) fail(`${layer.index + 1}번 영상 재생이 예상보다 일찍 끝났습니다. 원본 구간을 다시 확인하세요.`, 'SOURCE_ENDED');
        }
        if (resource.gain) resource.gain.gain.setValueAtTime(layer.audioGain * plan.audio.original_volume, audioContext.currentTime);
        drawScene(resource, entry, layer.localTime, plan.width, plan.height);
      }
      if (musicResource) {
        play(musicResource, '배경음악');
        const fadeIn = Math.min(plan.audio.fade_in, plan.duration / 2); const fadeOut = Math.min(plan.audio.fade_out, plan.duration / 2);
        const volume = plan.audio.music_volume * Math.min(1, fadeIn ? elapsed / fadeIn : 1, fadeOut ? Math.max(0, plan.duration - elapsed) / fadeOut : 1);
        musicResource.gain.gain.setValueAtTime(volume, audioContext.currentTime);
      }
      composite(output.context, frame.layers, frame.transition, resources, plan.width, plan.height);
      if (now - lastReported > 200) { progress('encoding', 5 + elapsed / plan.duration * 89, `${Math.min(plan.scenes.length, last + 1)} / ${plan.scenes.length} 장면 · ${elapsed.toFixed(1)} / ${plan.duration.toFixed(1)}초`, elapsed); lastReported = now; }
      await nextFrame(signal);
    }
    check(signal);
    for (const resource of resources.values()) resource.element.pause?.(); musicResource?.element.pause();
    const recordedDuration = (performance.now() - recordingStarted) / 1000;
    progress('finalizing', 96, '완성된 영상을 파일로 묶습니다.', plan.duration);
    if (recorder.state !== 'inactive') recorder.stop();
    await bounded(stopped, signal, '영상 파일 마무리', 20000);
    check(signal);
    if (!chunks.length || !totalBytes) fail('영상 파일이 생성되지 않았습니다. 해상도를 낮춰 다시 시도하세요.', 'EMPTY_OUTPUT');
    // Read the instance's final MIME type; never rename a WebM recording as MP4.
    const finalFormat = browserFormat(recorder.mimeType || actualFormat.mimeType);
    const blob = new Blob(chunks, { type: finalFormat.mimeType }); chunks = [];
    progress('done', 100, `${finalFormat.label} 영상이 준비되었습니다.`, plan.duration);
    return { blob, ...finalFormat, duration: plan.duration, recordedDuration, width: plan.width, height: plan.height, fps: plan.fps, warnings: [...warningSet], renderer: 'browser', realtime: true, preview: plan.preview };
  } catch (error) {
    if (!signal.aborted) control.abort(error);
    throw signal.aborted ? abortReason(signal) : error;
  } finally {
    if (!cleaned) {
      cleaned = true; clearTimeout(timeout);
      if (!signal.aborted) control.abort(new DOMException('영상 작업이 끝났습니다.', 'AbortError'));
      externalSignal?.removeEventListener('abort', cancelExternal);
      document.removeEventListener('visibilitychange', stopForBackground); window.removeEventListener('pagehide', pageHidden);
      if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null; if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* already stopped */ } } }
      stream?.getTracks().forEach(track => track.stop()); audioDestination?.stream.getTracks().forEach(track => track.stop());
      for (const resource of resources.values()) dispose(resource); resources.clear(); dispose(musicResource);
      compressor?.disconnect();
      if (audioContext && audioContext.state !== 'closed') { try { await audioContext.close(); } catch { /* context already interrupted */ } }
      ownedURLs.forEach(url => URL.revokeObjectURL(url)); ownedURLs.clear();
      if (output) output.element.width = output.element.height = 0; host?.remove(); chunks = [];
    }
  }
}
