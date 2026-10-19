import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { File } from 'node:buffer';
import { HASH_CHUNK_SIZE, MAX_LOCAL_ASSETS, hashLocalFile, mediaKind, readDroppedFiles, readLocalFiles, safeFileName } from '../public/local-media.js';

const nodeHash = data => createHash('sha256').update(data).digest('hex');

test('SHA-256 fingerprints match independent known answers, padding boundaries and multi-chunk input', async () => {
  assert.equal(await hashLocalFile(new Blob([])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await hashLocalFile(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const size of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, HASH_CHUNK_SIZE - 1, HASH_CHUNK_SIZE, HASH_CHUNK_SIZE + 65]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) & 255);
    assert.equal(await hashLocalFile(new Blob([bytes])), nodeHash(bytes), `content length ${size}`);
  }
});

test('large file hashes read at most one MiB at a time and never request a full-file buffer', async () => {
  const bytes = Buffer.alloc(HASH_CHUNK_SIZE * 3 + 57, 0xa7), blob = new Blob([bytes]);
  const reads = [], progress = [];
  const boundedFile = {
    size: blob.size,
    arrayBuffer() { assert.fail('must not buffer the complete source'); },
    slice(start, end) { reads.push([start, end]); assert.ok(end - start <= HASH_CHUNK_SIZE); return blob.slice(start, end); },
  };
  assert.equal(await hashLocalFile(boundedFile, { onProgress: update => progress.push(update) }), nodeHash(bytes));
  assert.equal(reads.length, 4);
  assert.equal(reads[0][0], 0);
  assert.equal(reads.at(-1)[1], blob.size);
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.every((update, i) => !i || update.loaded >= progress[i - 1].loaded));
});

test('hash cancellation stops between bounded reads and rejects AbortError', async () => {
  const controller = new AbortController(), blob = new Blob([Buffer.alloc(HASH_CHUNK_SIZE * 3)]);
  let reads = 0;
  await assert.rejects(hashLocalFile({ size: blob.size, slice(start, end) { reads++; return blob.slice(start, end); } }, {
    signal: controller.signal,
    onProgress: ({ loaded }) => { if (loaded) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(reads, 1);
  await assert.rejects(readLocalFiles([], { signal: controller.signal }), { name: 'AbortError' });
});

test('classification handles missing MIME types without treating arbitrary documents as images', () => {
  const rows = [
    [{ name: '여행.JPG', type: '' }, 'image'],
    [{ name: 'film.MOV', type: 'application/octet-stream' }, 'video'],
    [{ name: 'track.m4a', type: '' }, 'audio'],
    [{ name: 'voice', type: 'audio/ogg; codecs=opus' }, 'audio'],
    [{ name: 'film.ogv', type: 'application/ogg' }, 'video'],
    [{ name: 'clip.xyz', type: 'video/mp4' }, 'video'],
    [{ name: 'photo.jpg', type: 'text/html' }, null],
    [{ name: 'document.pdf', type: 'application/pdf' }, null],
    [{ name: 'README', type: '' }, null],
    [null, null],
  ];
  rows.forEach(([file, expected]) => assert.equal(mediaKind(file), expected));
});

test('identical bytes reconnect and deduplicate despite changed file name and directory', async () => {
  const bytes = 'identical image bytes', sha256 = nodeHash(bytes);
  const files = [new File([bytes], 'renamed.jpg', { type: 'image/jpeg' }), new File([bytes], 'second.jpg', { type: 'image/jpeg' })];
  const result = await readLocalFiles(files, { existing: [{ id: 'old-source', sha256, size: bytes.length, kind: 'image' }] });
  assert.deepEqual(result, { assets: [], skipped: [], duplicates: 2 });
  assert.equal(await hashLocalFile(files[0]), await hashLocalFile(files[1]));
});

test('empty files, unrelated documents and asset overflow produce actionable skips', async () => {
  const empty = new File([], 'empty.jpg', { type: 'image/jpeg' });
  const note = new File(['note'], 'note.txt', { type: 'text/plain' });
  const result = await readLocalFiles([empty, note]);
  assert.equal(result.assets.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /비어/);
  assert.match(result.skipped[1].reason, /아닙니다/);
  const full = await readLocalFiles([new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })], {
    existing: Array.from({ length: MAX_LOCAL_ASSETS }, (_, index) => ({ id: String(index), kind: 'image' })),
  });
  assert.match(full.skipped[0].reason, /600/);
});

test('unreadable file bytes do not prevent subsequent duplicates or documents from being processed', async () => {
  const good = new File(['good'], 'good.jpg', { type: 'image/jpeg' });
  const broken = { name: 'missing.jpg', type: 'image/jpeg', size: 10, slice() { throw new Error('원본 파일이 이동되었습니다.'); } };
  const result = await readLocalFiles([broken, good], { existing: [{ id: 'known', sha256: nodeHash('good'), kind: 'image', size: 4 }] });
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /이동/);
});

test('folder drops consume all directory batches, recurse, preserve relative paths and leave File objects unchanged', async () => {
  const one = new File(['1'], 'first.txt'), two = new File(['2'], 'second.txt'), three = new File(['3'], 'nested.txt');
  const fileEntry = file => ({ name: file.name, isFile: true, file(resolve) { resolve(file); } });
  const directory = (name, batches) => ({ name, isDirectory: true, createReader() {
    let i = 0;
    return { readEntries(resolve) { resolve(batches[i++] || []); } };
  } });
  const folder = directory('원본폴더', [[fileEntry(one)], [fileEntry(two), directory('하위', [[fileEntry(three)]])]]);
  const files = await readDroppedFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] });
  assert.deepEqual(files, [one, two, three]);
  assert.equal(one.name, 'first.txt');
  assert.ok(!Object.hasOwn(one, 'relative_path'));
  const result = await readLocalFiles(files);
  assert.deepEqual(result.skipped.map(row => row.name), ['원본폴더/first.txt', '원본폴더/second.txt', '원본폴더/하위/nested.txt']);
});

test('ordinary file drops use FileList fallback or getAsFile when directory APIs are unavailable', async () => {
  const file = new File(['1'], 'photo.jpg');
  assert.deepEqual(await readDroppedFiles({ files: [file] }), [file]);
  assert.deepEqual(await readDroppedFiles({ files: [file], items: [{ kind: 'file', getAsFile: () => file }, { kind: 'string' }] }), [file]);
});

test('download names retain Korean text and useful extensions but remove paths and reserved names', () => {
  assert.equal(safeFileName('../내 이야기.webm'), '내 이야기.webm');
  assert.equal(safeFileName('C:\\folder\\내 영상.mp4'), '내 영상.mp4');
  assert.equal(safeFileName('새:이야기?.mp4'), '새-이야기-.mp4');
  assert.equal(safeFileName('CON.mp4'), 'norn-CON.mp4');
  assert.equal(safeFileName('..'), 'norn');
  const unicode = safeFileName('🌻'.repeat(180) + '.webm');
  assert.equal(unicode.endsWith('.webm'), true);
  assert.ok([...unicode].length <= 160);
  assert.ok(new TextEncoder().encode(unicode).length <= 240);
  assert.equal(unicode, '🌻'.repeat(58) + '.webm');
});
