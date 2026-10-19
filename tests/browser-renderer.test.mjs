import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_RENDER_LIMITS, BROWSER_TRANSITIONS, BROWSER_STYLES, BrowserRenderError,
  browserFormat, getBrowserRenderSupport, validateBrowserRender, sampleBrowserTimeline,
} from '../public/browser-renderer.js';

const support = { supported: true, mimeType: 'video/mp4', audioSupported: true };
const options = { support };
const source = (id, kind = 'image', duration = 60) => ({ id, kind, relative_path: `${id}.${kind === 'video' ? 'mp4' : kind === 'audio' ? 'wav' : 'jpg'}`, url: `blob:test-${id}`, analysis: { duration, width: 1920, height: 1080 } });
const scene = (id, extra = {}) => ({ id: `scene-${id}`, source_id: id, duration: 3, source_duration: 3, start: 0, playback_speed: 1, transition: 'cut', transition_duration: .3, style: 'clean', title: '', caption: '', ...extra });
const variant = (scenes = [scene('a')], extra = {}) => ({ id: 'main', settings: { width: 1280, height: 720, fps: 30 }, audio: { mute_original: true }, scenes, ...extra });
const checkError = code => error => error instanceof BrowserRenderError && error.code === code;
const environment = canRecord => ({
  MediaRecorder: class { static isTypeSupported = canRecord; },
  HTMLCanvasElement: class { captureStream() {} }, MediaStream: class {},
  requestAnimationFrame() {}, AudioContext: class {},
});

test('browser support never confuses Node or a partial environment with working export', () => {
  assert.equal(getBrowserRenderSupport({}).supported, false);
  const env = environment(() => true); delete env.HTMLCanvasElement;
  assert.equal(getBrowserRenderSupport(env).supported, false);
  assert.match(getBrowserRenderSupport(env).reason, /화면 합성/);
});

test('native MP4 is preferred, while supported WebM stays labelled and named WebM', () => {
  const mp4 = getBrowserRenderSupport(environment(type => type === 'video/mp4;codecs=avc1,mp4a.40.2' || type === 'video/webm'));
  assert.equal(mp4.mimeType, 'video/mp4;codecs=avc1,mp4a.40.2'); assert.equal(mp4.extension, 'mp4');
  const webm = getBrowserRenderSupport(environment(type => type === 'video/webm;codecs=vp8,opus'));
  assert.equal(webm.extension, 'webm'); assert.equal(webm.label, 'WebM');
  const plan = validateBrowserRender(variant(), [source('a')], { support: webm });
  assert.equal(plan.extension, 'webm'); assert.ok(plan.warnings.some(warning => warning.includes('WebM')));
});

test('generic MP4 support cannot silently select VP9/Opus in an MP4 container', () => {
  const result = getBrowserRenderSupport(environment(type => type === 'video/mp4' || type === 'video/webm;codecs=vp8,opus'));
  assert.equal(result.extension, 'webm');
  assert.equal(getBrowserRenderSupport(environment(type => type === 'video/mp4')).supported, false);
});

test('throwing MIME probes are isolated and no supported codec is a clear failure', () => {
  const result = getBrowserRenderSupport(environment(type => { if (type.startsWith('video/mp4')) throw Error('probe'); return type === 'video/webm'; }));
  assert.equal(result.extension, 'webm');
  assert.equal(getBrowserRenderSupport(environment(() => false)).supported, false);
  assert.throws(() => browserFormat('video/x-matroska'), checkError('UNSUPPORTED_FORMAT'));
  assert.equal(browserFormat('video/webm;codecs=vp8,opus').extension, 'webm');
});

test('overlap timing maps output seconds to original trimmed source seconds', () => {
  const v = variant([
    scene('a', { transition: 'fade', transition_duration: .5 }),
    scene('b', { start: 5, duration: 4, source_duration: 8, playback_speed: 2, transition: 'wipeleft', transition_duration: .75, keep_audio: true }),
    scene('c', { duration: 2.5 }),
  ], { audio: { mute_original: false } });
  const media = [source('a'), source('b', 'video'), source('c')];
  const before = JSON.stringify([v, media]); const plan = validateBrowserRender(v, media, options);
  assert.equal(plan.duration, 8.25);
  assert.deepEqual(plan.scenes.map(s => [s.start, s.end, s.overlap]), [[0, 3, .5], [2.5, 6.5, .75], [5.75, 8.25, 0]]);
  const frame = sampleBrowserTimeline(plan, 2.75);
  assert.deepEqual(frame.layers.map(layer => layer.index), [0, 1]);
  assert.equal(frame.layers[1].sourceTime, 5.5); assert.equal(frame.layers[1].localTime, .25);
  assert.equal(frame.transition.progress, .5); assert.deepEqual(frame.layers.map(layer => layer.audioGain), [.5, .5]);
  assert.equal(plan.scenes[1].keepAudio, true); assert.equal(JSON.stringify([v, media]), before);
});

test('cut boundaries select exactly the next clip without a fictitious transition', () => {
  const plan = validateBrowserRender(variant([scene('a'), scene('b', { start: 5 })]), [source('a'), source('b', 'video')], options);
  assert.deepEqual(sampleBrowserTimeline(plan, 3).layers.map(layer => layer.index), [1]);
  assert.equal(sampleBrowserTimeline(plan, 3).layers[0].sourceTime, 5);
  assert.equal(sampleBrowserTimeline(plan, 3).transition, null);
  assert.deepEqual(sampleBrowserTimeline(plan, 3 - 1e-9).layers.map(layer => layer.index), [0]);
});

test('half-length adjacent transitions never create a triple overlap', () => {
  const scenes = ['a', 'b', 'c'].map(id => scene(id, { duration: 2, transition: 'fade', transition_duration: 1 }));
  const plan = validateBrowserRender(variant(scenes), ['a', 'b', 'c'].map(id => source(id)), options);
  for (const t of [0, 1, 1.5, 1.999, 2, 2.5, 3, 4]) assert.ok(sampleBrowserTimeline(plan, t).layers.length <= 2);
  assert.deepEqual(sampleBrowserTimeline(plan, 2).layers.map(layer => layer.index), [1, 2]);
  assert.equal(plan.duration, 4);
});

test('out-of-range output times are bounded and source timestamps never reach EOF', () => {
  const plan = validateBrowserRender(variant([scene('a', { start: 7 })]), [source('a', 'video', 10)], options);
  assert.equal(sampleBrowserTimeline(plan, -10).layers[0].sourceTime, 7);
  const end = sampleBrowserTimeline(plan, 100).layers[0];
  assert.equal(end.index, 0); assert.ok(end.sourceTime < 10); assert.ok(end.sourceTime > 9.99);
  assert.throws(() => sampleBrowserTimeline(plan, Infinity), checkError('INVALID_TIME'));
});

test('unknown originals and duplicate source or scene identifiers fail before encoding', () => {
  assert.throws(() => validateBrowserRender(variant(), [], options), checkError('MISSING_SOURCE'));
  assert.throws(() => validateBrowserRender(variant(), [source('a'), source('a')], options), checkError('DUPLICATE_SOURCE'));
  assert.throws(() => validateBrowserRender(variant([scene('a'), scene('a')]), [source('a')], options), checkError('DUPLICATE_SCENE'));
  assert.throws(() => validateBrowserRender(variant(), [{ ...source('a'), url: '' }], options), checkError('MISSING_SOURCE'));
});

test('a File or Blob is a source without a copied payload or absolute path', () => {
  const a = { ...source('a'), url: '', file: new Blob(['selected-original'], { type: 'image/jpeg' }) };
  const plan = validateBrowserRender(variant(), [a], options);
  assert.equal(plan.scenes[0].source.file, a.file);
  assert.equal(plan.scenes[0].source.url, '');
});

test('unsafe timing and dishonest high-speed approximation are rejected explicitly', () => {
  for (const speed of [.1, 8, 60, 120, 3600]) {
    assert.throws(() => validateBrowserRender(variant([scene('a', { playback_speed: speed })]), [source('a', 'video')], options), checkError('SPEED_LIMIT'));
  }
  const slow = validateBrowserRender(variant([scene('a', { playback_speed: .25, duration: 12 })]), [source('a', 'video')], options);
  assert.equal(sampleBrowserTimeline(slow, 4).layers[0].sourceTime, 1);
  const fast = validateBrowserRender(variant([scene('a', { playback_speed: 4, duration: 3, source_duration: 12 })]), [source('a', 'video')], options);
  assert.equal(sampleBrowserTimeline(fast, 1).layers[0].sourceTime, 4);
});

test('source trims and frame-quantized duration must agree', () => {
  assert.throws(() => validateBrowserRender(variant([scene('a', { start: 59 })]), [source('a', 'video')], options), checkError('SOURCE_BOUNDS'));
  assert.throws(() => validateBrowserRender(variant([scene('a', { duration: 4 })]), [source('a', 'video')], options), checkError('TIMING_MISMATCH'));
  const v = variant([scene('a', { source_duration: 5, playback_speed: 1.5, duration: 100 / 30 })]);
  assert.equal(validateBrowserRender(v, [source('a', 'video')], options).duration, 100 / 30);
});

test('all advertised styles and transitions pass, unknown effects are not silently changed', () => {
  for (const style of Object.keys(BROWSER_STYLES)) {
    const plan = validateBrowserRender(variant([scene('a', { style })]), [source('a')], options); assert.equal(plan.scenes[0].scene.style, style);
  }
  for (const transition of Object.keys(BROWSER_TRANSITIONS)) {
    const plan = validateBrowserRender(variant([scene('a', { transition }), scene('b')]), [source('a'), source('b')], options);
    assert.equal(plan.scenes[0].scene.transition, transition);
  }
  for (const patch of [{ transition: 'dissolve' }, { style: 'unknown' }, { motion: 'shake' }, { font_family: 'missing' }]) {
    assert.throws(() => validateBrowserRender(variant([scene('a', patch)]), [source('a')], options), checkError('UNSUPPORTED_SETTING'));
  }
});

test('transition durations cannot silently consume more than half an adjacent scene', () => {
  for (const transition_duration of [0, .01, 1.6]) assert.throws(() => validateBrowserRender(variant([
    scene('a', { transition: 'fade', transition_duration }), scene('b'),
  ]), [source('a'), source('b')], options), checkError('TRANSITION_BOUNDS'));
});

test('original audio obeys global mute, per-clip choice and explicit absence', () => {
  const make = (audio, patch = {}, has_audio) => validateBrowserRender(variant([scene('a', { keep_audio: true, ...patch })], { audio }), [{ ...source('a', 'video'), analysis: { duration: 60, has_audio } }], options);
  assert.equal(make({ mute_original: false }).needsAudio, true); // Unknown audio is not fabricated as absent.
  assert.equal(make({ mute_original: true }).needsAudio, false);
  assert.equal(make({ mute_original: false }, { keep_audio: false }).needsAudio, false);
  assert.equal(make({ mute_original: false }, { speed_audio: 'mute' }).needsAudio, false);
  assert.equal(make({ mute_original: false }, {}, false).needsAudio, false);
});

test('local music requires a connected audio file and an in-bounds start point', () => {
  const v = variant([scene('a')], { audio: { music_id: 'music', music_start: 1, loop: false } });
  assert.throws(() => validateBrowserRender(v, [source('a')], options), checkError('MISSING_MUSIC'));
  assert.throws(() => validateBrowserRender(v, [source('a'), source('music', 'image')], options), checkError('MISSING_MUSIC'));
  const music = source('music', 'audio', 2); const plan = validateBrowserRender(v, [source('a'), music], options);
  assert.equal(plan.needsAudio, true); assert.equal(plan.music.id, 'music'); assert.equal(plan.audio.music_start, 1);
  assert.ok(plan.warnings.some(warning => warning.includes('음악이 끝난')));
  assert.throws(() => validateBrowserRender({ ...v, audio: { ...v.audio, music_start: 2 } }, [source('a'), music], options), checkError('MUSIC_BOUNDS'));
});

test('audio capability errors only block exports that actually need audio', () => {
  const noAudio = { support: { ...support, audioSupported: false } };
  assert.equal(validateBrowserRender(variant(), [source('a')], noAudio).needsAudio, false);
  const v = variant([scene('a', { keep_audio: true })], { audio: { mute_original: false } });
  assert.throws(() => validateBrowserRender(v, [source('a', 'video')], noAudio), checkError('UNSUPPORTED_AUDIO'));
});

test('preview scaling is explicit, final output dimensions never silently change', () => {
  const v = variant([scene('a')], { settings: { width: 3840, height: 2160, fps: 30 } });
  assert.throws(() => validateBrowserRender(v, [source('a')], options), checkError('SIZE_LIMIT'));
  const preview = validateBrowserRender(v, [source('a')], { ...options, preview: true });
  assert.equal(preview.width, 960); assert.equal(preview.height, 540); assert.equal(v.settings.width, 3840);
  assert.ok(preview.warnings.some(warning => warning.includes('미리보기')));
  const square = variant([scene('a')], { settings: { width: 1920, height: 1920, fps: 30 } });
  assert.throws(() => validateBrowserRender(square, [source('a')], options), checkError('SIZE_LIMIT'));
});

test('memory and timeline limits fail early rather than attempting a doomed recording', () => {
  const tooLong = variant([scene('a', { duration: 600 }), scene('b')]);
  assert.throws(() => validateBrowserRender(tooLong, [source('a'), source('b')], options), checkError('DURATION_LIMIT'));
  const huge = variant([scene('a', { duration: 300 })], { settings: { width: 1920, height: 1080, fps: 60 } });
  assert.throws(() => validateBrowserRender(huge, [source('a')], options), checkError('OUTPUT_SIZE_LIMIT'));
  const full = variant([scene('a', { duration: 600 })]);
  assert.equal(validateBrowserRender(full, [source('a')], options).duration, 600);
  assert.equal(BROWSER_RENDER_LIMITS.maxOutputBytes, 512 * 1024 * 1024);
});

test('malformed numeric settings cannot become NaN progress or a stalled encoder', () => {
  for (const patch of [{ duration: NaN }, { duration: Infinity }, { font_size: '42' }, { transition_duration: -1 }]) {
    assert.throws(() => validateBrowserRender(variant([scene('a', patch)]), [source('a')], options), checkError('INVALID_SETTING'));
  }
  assert.throws(() => validateBrowserRender(variant([scene('a')], { settings: { width: 1279, height: 720, fps: 30 } }), [source('a')], options), checkError('INVALID_SIZE'));
  assert.throws(() => validateBrowserRender(variant([scene('a')], { settings: { width: 1280, height: 720, fps: 29.97 } }), [source('a')], options), checkError('INVALID_FPS'));
});
