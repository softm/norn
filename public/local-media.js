/** Local files stay in the browser. No upload, local server, or absolute path is needed. */
const extensions = {
  image: new Set('jpg jpeg png webp gif avif bmp svg ico heic heif tif tiff'.split(' ')),
  video: new Set('mp4 webm mov m4v mpg mpeg avi mkv 3gp 3g2 ogv mts m2ts ts'.split(' ')),
  audio: new Set('mp3 wav ogg oga m4a aac flac opus aif aiff wma amr'.split(' ')),
};
export const MEDIA_ACCEPT = 'image/*,video/*,audio/*,' +
  Object.values(extensions).flatMap(group => [...group].map(extension => '.' + extension)).join(',');
export const MAX_LOCAL_ASSETS = 600;
export const HASH_CHUNK_SIZE = 1024 * 1024;
const droppedPaths = new WeakMap();

/** An extension is only a fallback for absent/generic MIME types, never proof of decodability. */
export function mediaKind(file) {
  const type = String(file?.type || '').toLowerCase().split(';', 1)[0].trim();
  for (const kind of Object.keys(extensions)) if (type.startsWith(kind + '/')) return kind;
  if (type && !['application/octet-stream', 'binary/octet-stream', 'application/ogg'].includes(type)) return null;
  const extension = String(file?.name || '').split('.').pop().toLowerCase();
  for (const [kind, values] of Object.entries(extensions)) if (values.has(extension)) return kind;
  return null;
}

/** A portable download basename; source names and files are never modified. */
export function safeFileName(name) {
  let value = String(name ?? '').split(/[\\/]/).pop()
    .replace(/[<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '-')
    .replace(/^\.+/, '').replace(/[.\s]+$/, '').trim();
  if (!value) return 'norn';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = 'norn-' + value;
  const characters = [...value], encoder = new TextEncoder();
  if (characters.length > 160 || encoder.encode(value).length > 240) {
    const extension = value.match(/\.[a-z0-9]{1,10}$/i)?.[0] || '';
    let stem = '', bytes = extension.length;
    for (const character of value.slice(0, value.length - extension.length)) {
      const length = encoder.encode(character).length;
      if (bytes + length > 240 || [...stem].length + extension.length >= 160) break;
      stem += character;
      bytes += length;
    }
    value = stem + extension;
  }
  return value;
}

function relativePath(file) {
  const raw = droppedPaths.get(file) || file?.webkitRelativePath || file?.name || '이름 없는 파일';
  return String(raw).replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '')
    .split('/').filter(part => part && part !== '.' && part !== '..').join('/') || '이름 없는 파일';
}

function abortError() { return new DOMException('파일 불러오기를 취소했습니다.', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

// Incremental SHA-256 uses a 64-byte pending block and a reusable 64-word schedule.
// SubtleCrypto.digest requires the entire file in memory; large videos must not use that path.
const shaConstants = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
class IncrementalSha256 {
  constructor() {
    this.state = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.pending = new Uint8Array(64);
    this.words = new Int32Array(64);
    this.buffered = 0;
    this.bytes = 0;
  }
  block(bytes, offset) {
    const w = this.words, state = this.state;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = bytes[j] << 24 | bytes[j + 1] << 16 | bytes[j + 2] << 8 | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = (a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ (a >>> 3);
      const s1 = (b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ (b >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
    }
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
      const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const t1 = h + s1 + ((e & f) ^ (~e & g)) + shaConstants[i] + w[i] | 0;
      const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const t2 = s0 + ((a & b) ^ (a & c) ^ (b & c)) | 0;
      h = g; g = f; f = e; e = d + t1 | 0;
      d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    state[0] = state[0] + a | 0; state[1] = state[1] + b | 0;
    state[2] = state[2] + c | 0; state[3] = state[3] + d | 0;
    state[4] = state[4] + e | 0; state[5] = state[5] + f | 0;
    state[6] = state[6] + g | 0; state[7] = state[7] + h | 0;
  }
  update(bytes) {
    this.bytes += bytes.length;
    let offset = 0;
    if (this.buffered) {
      const count = Math.min(64 - this.buffered, bytes.length);
      this.pending.set(bytes.subarray(0, count), this.buffered);
      this.buffered += count;
      offset += count;
      if (this.buffered === 64) { this.block(this.pending, 0); this.buffered = 0; }
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.block(bytes, offset);
    if (offset < bytes.length) {
      this.pending.set(bytes.subarray(offset), 0);
      this.buffered = bytes.length - offset;
    }
  }
  hex() {
    const tail = new Uint8Array(this.buffered < 56 ? 64 : 128);
    tail.set(this.pending.subarray(0, this.buffered));
    tail[this.buffered] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(this.bytes / 0x20000000));
    view.setUint32(tail.length - 4, (this.bytes % 0x20000000) * 8);
    for (let offset = 0; offset < tail.length; offset += 64) this.block(tail, offset);
    return [...this.state].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

/** Full content identity with bounded reads. onProgress receives {loaded,total,percent}. */
export async function hashLocalFile(file, { signal, onProgress } = {}) {
  checkAbort(signal);
  if (!Number.isSafeInteger(file?.size) || file.size < 0 || typeof file.slice !== 'function') {
    throw new Error('선택한 파일을 읽을 수 없습니다.');
  }
  const hash = new IncrementalSha256();
  onProgress?.({ loaded: 0, total: file.size, percent: file.size ? 0 : 100 });
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_SIZE) {
    checkAbort(signal);
    const end = Math.min(offset + HASH_CHUNK_SIZE, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    checkAbort(signal);
    if (bytes.length !== end - offset) throw new Error('파일을 끝까지 읽지 못했습니다. 원본을 다시 선택해주세요.');
    hash.update(bytes);
    onProgress?.({ loaded: end, total: file.size, percent: end / file.size * 100 });
    await yieldToBrowser();
  }
  checkAbort(signal);
  return hash.hex();
}

function waitForMedia(element, events, { signal, ready, start, timeout = 20000 } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach(event => element.removeEventListener(event, loaded));
      element.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const loaded = () => { if (!ready || ready()) finish(); };
    const failed = () => finish(new Error('브라우저에서 열 수 없는 형식이거나 손상된 파일입니다.'));
    const aborted = () => finish(abortError());
    events.forEach(event => element.addEventListener(event, loaded));
    element.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('미디어 정보를 읽는 시간이 초과됐습니다.')), timeout);
    try { start?.(); if (ready?.()) loaded(); } catch (error) { finish(error); }
  });
}

async function thumbnail(source, width, height, signal) {
  checkAbort(signal);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 384 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이 브라우저에서 썸네일을 만들 수 없습니다.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      const aborted = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('썸네일을 만들지 못했습니다.')); }, 20000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
      signal?.addEventListener('abort', aborted, { once: true });
      try {
        canvas.toBlob(blob => {
          cleanup();
          if (signal?.aborted) reject(abortError());
          else if (blob) resolve(blob);
          else reject(new Error('썸네일을 만들지 못했습니다.'));
        }, 'image/webp', 0.82);
      } catch (error) { cleanup(); reject(error); }
    });
  } finally {
    canvas.width = canvas.height = 1;
  }
}

async function readMetadata(kind, sourceUrl, signal) {
  const element = document.createElement(kind === 'image' ? 'img' : kind);
  try {
    if (kind === 'image') {
      element.decoding = 'async';
      await waitForMedia(element, ['load'], {
        signal, ready: () => element.complete && element.naturalWidth > 0,
        start: () => { element.src = sourceUrl; },
      });
      const width = element.naturalWidth, height = element.naturalHeight;
      if (![width, height].every(value => Number.isFinite(value) && value > 0)) {
        throw new Error('이미지 크기를 확인할 수 없습니다.');
      }
      return { analysis: { width, height, duration: 0 }, poster: await thumbnail(element, width, height, signal) };
    }
    element.preload = kind === 'video' ? 'auto' : 'metadata';
    element.muted = true;
    element.playsInline = true;
    await waitForMedia(element, ['loadedmetadata'], {
      signal, ready: () => element.readyState >= 1,
      start: () => { element.src = sourceUrl; element.load(); },
    });
    const duration = element.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('영상·음악의 재생 길이를 확인할 수 없습니다.');
    if (kind === 'audio') return { analysis: { width: 0, height: 0, duration }, poster: null };
    const width = element.videoWidth, height = element.videoHeight;
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('영상 화면을 읽을 수 없습니다. 이 브라우저의 코덱 지원을 확인해주세요.');
    }
    await waitForMedia(element, ['loadeddata', 'canplay'], { signal, ready: () => element.readyState >= 2 });
    // A decoded first frame is a real poster, without silently starting video playback.
    return { analysis: { width, height, duration }, poster: await thumbnail(element, width, height, signal) };
  } finally {
    if (kind !== 'image') element.pause();
    element.removeAttribute('src');
    if (kind !== 'image') element.load();
  }
}

/** Revoke only owned Blob URLs; HTTP URLs, data URLs and original files are untouched. */
export function revokeMedia(assets = []) {
  const urls = new Set(Array.from(assets || []).flatMap(asset => [asset?.url, asset?.thumb_url])
    .filter(value => typeof value === 'string' && value.startsWith('blob:')));
  for (const value of urls) URL.revokeObjectURL(value);
}

/**
 * Resolve File/FileList input into new assets. Existing and within-batch duplicate bytes are skipped.
 * onProgress: {current (1-based),total,name,phase,filePercent}. Each batch is sequential and cancellable.
 * On cancellation, reject AbortError and revoke every URL created by this batch, including earlier files.
 * The caller owns returned URLs and should revokeMedia them when replacing/removing a library.
 */
export async function readLocalFiles(files, { existing = [], signal, onProgress } = {}) {
  checkAbort(signal);
  const input = Array.from(files || []), previous = Array.from(existing || []);
  const assets = [], skipped = [];
  const fingerprints = new Set(previous.map(asset => String(asset.sha256 || '').toLowerCase())
    .filter(hash => /^[a-f0-9]{64}$/.test(hash)));
  const existingCount = previous.filter(asset => ['image', 'video', 'audio'].includes(asset.kind)).length;
  let duplicates = 0;
  try {
    for (let index = 0; index < input.length; index++) {
      checkAbort(signal);
      const file = input[index], name = relativePath(file), kind = mediaKind(file);
      const report = (phase, filePercent = 0) => onProgress?.({ current: index + 1, total: input.length, name, phase, filePercent });
      let owned = { url: '', thumb_url: '' };
      try {
        if (!kind) { skipped.push({ name, reason: '이미지·영상·음악 파일이 아닙니다.' }); continue; }
        if (!Number.isSafeInteger(file?.size) || file.size <= 0) {
          skipped.push({ name, reason: '비어 있거나 읽을 수 없는 파일입니다.' }); continue;
        }
        if (existingCount + assets.length >= MAX_LOCAL_ASSETS) {
          skipped.push({ name, reason: '자료는 한 프로젝트에 최대 600개까지 연결할 수 있습니다.' }); continue;
        }
        const sha256 = await hashLocalFile(file, { signal, onProgress: ({ percent }) => report('hash', percent) });
        if (fingerprints.has(sha256)) { duplicates++; continue; }
        report('metadata', 100);
        owned.url = URL.createObjectURL(file);
        const { analysis, poster } = await readMetadata(kind, owned.url, signal);
        checkAbort(signal);
        if (poster) owned.thumb_url = URL.createObjectURL(poster);
        assets.push({
          id: 'local-' + sha256, sha256, size: file.size, relative_path: name,
          kind, url: owned.url, thumb_url: owned.thumb_url, analysis, file, local: true,
        });
        fingerprints.add(sha256);
        owned = null;
      } catch (error) {
        if (owned) revokeMedia([owned]);
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        skipped.push({ name, reason: error?.message || '파일을 읽지 못했습니다.' });
      } finally {
        if (!signal?.aborted) report('complete', 100);
      }
    }
    checkAbort(signal);
    return { assets, skipped, duplicates };
  } catch (error) {
    revokeMedia(assets);
    throw error;
  }
}

/** Read every directory batch (Chromium returns batches, commonly 100 entries), with file-drop fallback. */
export async function readDroppedFiles(dataTransfer) {
  // Capture entries and Files synchronously: the browser protects DataTransfer after the drop handler returns.
  const fallback = Array.from(dataTransfer?.files || []);
  const roots = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file').map(item => {
    let entry = null, file = null;
    try { entry = item.webkitGetAsEntry?.() || item.getAsEntry?.() || null; } catch { /* File fallback below. */ }
    if (!entry) { try { file = item.getAsFile?.() || null; } catch { /* Inaccessible item. */ } }
    return { entry, file };
  });
  if (!roots.length) return fallback;
  const files = [], seen = new Set();
  const add = (file, path) => {
    if (!file || seen.has(file)) return;
    if (path) droppedPaths.set(file, path);
    seen.add(file);
    files.push(file);
  };
  for (const root of roots) {
    if (!root.entry) { add(root.file); continue; }
    const pending = [{ entry: root.entry, parent: '' }];
    while (pending.length) {
      const { entry, parent } = pending.pop();
      const path = parent ? parent + '/' + entry.name : entry.name;
      if (entry.isFile) {
        try { add(await new Promise((resolve, reject) => entry.file(resolve, reject)), path); } catch { /* Continue with siblings. */ }
      } else if (entry.isDirectory) {
        const children = [];
        try {
          const reader = entry.createReader();
          for (;;) {
            const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            if (!batch.length) break;
            children.push(...batch);
          }
        } catch { /* A blocked directory must not discard the other dropped files. */ }
        // Keep already-read batches after a later failure. Reversing preserves enumeration order.
        for (let index = children.length - 1; index >= 0; index--) pending.push({ entry: children[index], parent: path });
      }
    }
  }
  if (!files.length && !roots.some(root => root.entry?.isDirectory)) fallback.forEach(file => add(file));
  return files;
}
