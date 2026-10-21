import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createLocalProjectStore } from '../public/local-project-store.js';
import { demoProject, scene } from '../public/domain.js';

function localStorage() {
  const rows = new Map();
  return { get length() { return rows.size; }, key: index => [...rows.keys()][index],
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, String(value)),
    removeItem: key => rows.delete(key), rows };
}
const contentKey = (owner, asset) => `${encodeURIComponent(owner)}:${asset.kind}:${asset.size}:${asset.sha256}`;
// A storage boundary double: store behavior is verified here; browser regressions exercise real IndexedDB transactions.
function memoryBackend() {
  const projects = new Map(), media = new Map();
  const key = (owner, id) => `${encodeURIComponent(owner)}:${id}`;
  const backend = {
    projects, media, writes: 0, fail: null, beforeWrite: null,
    async get(owner, id) { return structuredClone(projects.get(key(owner, id))); },
    async list(owner) { return structuredClone([...projects.values()].filter(row => row.owner === owner)); },
    async readAssets(owner, assets) {
      return new Map(assets.map(asset => [contentKey(owner, asset), structuredClone(media.get(contentKey(owner, asset)))]).filter(([, row]) => row));
    },
    async write(record, assets) {
      await backend.beforeWrite?.();
      if (backend.fail) throw backend.fail;
      const previous = projects.get(record.key);
      if (previous && previous.writerId !== record.writerId && previous.updatedAt > record.updatedAt) {
        const error = new Error('다른 탭에서 더 최근에 저장한 프로젝트가 있습니다.');
        error.name = 'LocalProjectConflictError';
        throw error;
      }
      const row = structuredClone(record);
      for (const asset of assets) if (!media.has(asset.key)) { media.set(asset.key, structuredClone(asset)); backend.writes++; }
      row.missingAssetIds = row.mediaDescriptors.filter(asset => !media.has(contentKey(row.owner, asset))).map(asset => asset.id);
      row.storedAssetCount = row.mediaDescriptors.length - row.missingAssetIds.length;
      projects.set(row.key, row);
      return structuredClone(row);
    },
    async update(owner, id, updater) {
      const current = projects.get(key(owner, id)); if (!current) return null;
      const next = updater(structuredClone(current)); projects.set(key(owner, id), next); return structuredClone(next);
    },
    async remove(owner, id, recoveryAssets = []) {
      projects.delete(key(owner, id));
      const used = new Set([...projects.values()].filter(row => row.owner === owner).flatMap(row => row.project.assets.map(asset => contentKey(owner, asset))));
      for (const asset of recoveryAssets) used.add(contentKey(owner, asset));
      for (const [key, asset] of media) if (asset.owner === owner && !used.has(key)) media.delete(key);
    },
  };
  return backend;
}
function fixture() {
  const file = new File(['original image bytes'], '들깨 사진.png', { type: 'image/png', lastModified: 1700000000000 });
  const sha256 = createHash('sha256').update('original image bytes').digest('hex');
  const asset = { id: 'local-' + sha256, kind: 'image', file, size: file.size, sha256, local: true,
    relative_path: '농장/들깨 사진.png', analysis: { width: 640, height: 480, duration: 0 },
    url: 'blob:expired-original', thumb_url: 'blob:expired-thumb', thumbBlob: new Blob(['thumbnail'], { type: 'image/webp' }) };
  const project = demoProject(); project.id = 'persisted-project'; project.title = '내가 만든 영상';
  project.variants[0].scenes = [scene(asset)]; project.assets = [{ id: asset.id, kind: asset.kind, size: asset.size, sha256 }];
  return { project, asset };
}
function environment() {
  const backend = memoryBackend(), storage = localStorage(), revoked = []; let sequence = 0;
  const options = { backend, storage, File, URL: { createObjectURL: () => `blob:restored-${++sequence}`, revokeObjectURL: url => revoked.push(url) } };
  return { backend, storage, revoked, options, store: createLocalProjectStore(options) };
}

test('file bytes, thumbnail, scene edits and original names survive a fresh store instance', async () => {
  const env = environment(), { project, asset } = fixture();
  project.variants[0].scenes[0].caption = '비 오는 날의 들깨밭';
  const saved = await env.store.save('owner', project, [asset], { cloudDirty: true, cloudRevision: 4, editVersion: 7, selected: project.variants[0].scenes[0].id });
  assert.equal(saved.storedAssetCount, 1);
  const restored = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(restored.media.length, 1); assert.deepEqual(restored.missingAssets, []);
  assert.equal(await restored.media[0].file.text(), await asset.file.text());
  assert.equal(await restored.media[0].thumbBlob.text(), 'thumbnail');
  assert.equal(restored.media[0].file.name, asset.file.name);
  assert.equal(restored.media[0].file.lastModified, asset.file.lastModified);
  assert.equal(restored.media[0].relative_path, asset.relative_path);
  assert.equal(restored.project.variants[0].scenes[0].caption, '비 오는 날의 들깨밭');
  assert.equal(restored.cloudRevision, 4); assert.equal(restored.cloudDirty, true); assert.equal(restored.editVersion, 7);
  assert.notEqual(restored.media[0].url, asset.url); assert.notEqual(restored.media[0].thumb_url, asset.thumb_url);
  assert.equal(createLocalProjectStore(env.options).getLast('owner'), project.id);
  assert.ok(!JSON.stringify([...env.storage.rows.values()]).includes('blob:expired'));
});

test('metadata journal is synchronous and recovers edits when the tab closes before its first durable write', async () => {
  const env = environment(), { project, asset } = fixture(); let release;
  env.backend.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const pending = env.store.save('owner', project, [asset], { cloudDirty: true, cloudRevision: 3, editVersion: 8 });
  const journal = [...env.storage.rows.values()].find(value => value.includes('schema_version'));
  assert.ok(journal, 'metadata must exist before any await/microtask');
  const replacement = createLocalProjectStore(env.options);
  const recovered = await replacement.load('owner', project.id);
  assert.equal(recovered.project.title, project.title); assert.equal(recovered.cloudDirty, true);
  assert.equal(recovered.cloudRevision, 3); assert.equal(recovered.editVersion, 8);
  assert.deepEqual(recovered.missingAssets, [asset.id]);
  release(); await pending;
});

test('a save snapshots mutable fields immediately and does not rewrite cached media on later text edits', async () => {
  const env = environment(), { project, asset } = fixture();
  const pending = env.store.save('guest', project, [asset], { editVersion: 1 });
  project.title = 'later unsaved title'; project.variants[0].scenes[0].field_locks.push('caption');
  await pending;
  const saved = await env.store.load('guest', project.id);
  assert.equal(saved.project.title, '내가 만든 영상');
  assert.deepEqual(saved.project.variants[0].scenes[0].field_locks, []);
  await env.store.save('guest', project, [asset], { editVersion: 2 });
  assert.equal(env.backend.writes, 1);
  assert.equal(asset.url, 'blob:expired-original'); assert.equal(asset.file.name, '들깨 사진.png');
});

test('the same project ID stays isolated across two accounts and guest storage', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('first-owner', project, [asset]);
  const second = structuredClone(project); second.title = '다른 계정';
  await env.store.save('second-owner', second, [asset]);
  assert.equal(await env.store.load('guest', project.id), null);
  assert.equal((await env.store.list('first-owner'))[0].title, '내가 만든 영상');
  assert.equal((await env.store.list('second-owner'))[0].title, '다른 계정');
  assert.equal((await env.store.list('guest')).length, 0);
  assert.equal(env.backend.writes, 2, 'private content keys are namespaced by account');
});

test('an older cloud acknowledgement advances the base revision without clearing newer local edits', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('owner', project, [asset], { cloudDirty: true, cloudRevision: 4, editVersion: 2 });
  await env.store.markSynced('owner', project.id, { editVersion: 1, cloudRevision: 5 });
  let restored = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(restored.cloudRevision, 5); assert.equal(restored.cloudDirty, true);
  await env.store.markSynced('owner', project.id, { editVersion: 2, cloudRevision: 4 });
  restored = await env.store.load('owner', project.id);
  assert.equal(restored.cloudRevision, 5); assert.equal(restored.cloudDirty, true, 'stale acknowledgement cannot claim sync');
  await env.store.markSynced('owner', project.id, { editVersion: 2, cloudRevision: 6 });
  restored = await env.store.load('owner', project.id);
  assert.equal(restored.cloudRevision, 6); assert.equal(restored.cloudDirty, false);
});

test('cloud acknowledgement racing a queued save preserves the newest title and dirty flag', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('owner', project, [asset], { cloudDirty: true, cloudRevision: 1, editVersion: 1 });
  project.title = 'second edit';
  const second = env.store.save('owner', project, [asset], { cloudDirty: true, cloudRevision: 1, editVersion: 2 });
  const acknowledged = env.store.markSynced('owner', project.id, { cloudRevision: 2, editVersion: 1 });
  await Promise.all([second, acknowledged]);
  const restored = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(restored.project.title, 'second edit'); assert.equal(restored.cloudRevision, 2); assert.equal(restored.cloudDirty, true);
});

test('quota failure retains the previous durable file and latest metadata journal for recovery', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('owner', project, [asset], { cloudDirty: true, editVersion: 1 });
  env.backend.fail = new DOMException('disk full', 'QuotaExceededError');
  project.title = '공간 부족 직전 수정한 제목';
  await assert.rejects(env.store.save('owner', project, [asset], { cloudDirty: true, editVersion: 2 }), error =>
    error.name === 'QuotaExceededError' && /저장 공간/.test(error.message));
  // A successful older cloud save must not erase the failed newer edit's only recovery journal.
  await env.store.markSynced('owner', project.id, { editVersion: 1, cloudRevision: 1 });
  const restored = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(restored.project.title, project.title); assert.equal(restored.cloudDirty, true); assert.equal(restored.cloudRevision, 1);
  assert.equal(restored.media.length, 1); assert.deepEqual(restored.missingAssets, []);
});

test('unavailable media is reported explicitly instead of returning stale blob URLs', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('owner', project, [], { cloudDirty: true, editVersion: 1 });
  const restored = await env.store.load('owner', project.id);
  assert.equal(restored.media.length, 0); assert.deepEqual(restored.missingAssets, [asset.id]);
  assert.equal(restored.project.assets.length, 1); assert.equal(restored.project.variants[0].scenes.length, 1);
});

test('deleting one project keeps shared bytes needed by another project or another owner', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('owner', project, [asset]);
  const next = structuredClone(project); next.id = 'second-project';
  await env.store.save('owner', next, [asset]); await env.store.save('other-owner', project, [asset]);
  await env.store.remove('owner', project.id);
  assert.equal(await env.store.load('owner', project.id), null);
  assert.equal((await env.store.load('owner', next.id)).media.length, 1);
  await env.store.remove('owner', next.id);
  assert.equal(env.store.getLast('owner'), null);
  assert.equal((await env.store.load('other-owner', project.id)).media.length, 1);
  assert.equal(env.backend.media.size, 1);
});

test('blocked browser storage rejects saving with a useful message and never reports success', async () => {
  const { project, asset } = fixture();
  const store = createLocalProjectStore({ indexedDB: null, storage: null, File });
  await assert.rejects(store.save('guest', project, [asset]), /사이트 저장 권한/);
});


test('deleting a durable project retains bytes referenced by another recoverable journal', async () => {
  const env = environment(), { project, asset } = fixture();
  await env.store.save('owner', project, [asset]);
  const pending = structuredClone(project); pending.id = 'recoverable-project';
  env.backend.fail = new DOMException('disk full', 'QuotaExceededError');
  await assert.rejects(env.store.save('owner', pending, [asset], { cloudDirty: true }));
  env.backend.fail = null;
  await env.store.remove('owner', project.id);
  const recovered = await env.store.load('owner', pending.id);
  assert.equal(recovered.media.length, 1);
  assert.deepEqual(recovered.missingAssets, []);
});


test('another tab with the same edit counter keeps its dirty snapshot and original cloud base', async () => {
  const env = environment(), { project, asset } = fixture();
  const tabA = env.store, tabB = createLocalProjectStore(env.options);
  await tabA.save('owner', project, [asset], { editVersion: 6, cloudRevision: 10, cloudDirty: true });
  const different = structuredClone(project); different.title = 'Tab B edit, same counter';
  const writtenB = await tabB.save('owner', different, [asset], { editVersion: 6, cloudRevision: 10, cloudDirty: true });
  await tabA.markSynced('owner', project.id, { editVersion: 6, cloudRevision: 11 });
  const recovered = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(recovered.project.title, different.title);
  assert.equal(recovered.writerId, writtenB.writerId);
  assert.equal(recovered.cloudDirty, true);
  assert.equal(recovered.cloudRevision, 10, 'another tab must retain its stale base so conflict detection still works');
  assert.equal(recovered.media.length, 1);
  assert.equal(await createLocalProjectStore(env.options).load('other-owner', project.id), null);
});

test('another tab cannot acknowledge or erase a divergent journal-only recovery snapshot', async () => {
  const env = environment(), { project, asset } = fixture();
  const tabA = env.store, tabB = createLocalProjectStore(env.options);
  await tabA.save('owner', project, [asset], { editVersion: 6, cloudRevision: 10, cloudDirty: true });
  const different = structuredClone(project); different.title = 'Tab B quota recovery';
  env.backend.fail = new DOMException('disk full', 'QuotaExceededError');
  await assert.rejects(tabB.save('owner', different, [asset], { editVersion: 6, cloudRevision: 10, cloudDirty: true }));
  env.backend.fail = null;
  await tabA.markSynced('owner', project.id, { editVersion: 6, cloudRevision: 11 });
  const recovered = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(recovered.project.title, different.title);
  assert.equal(recovered.cloudDirty, true);
  assert.equal(recovered.cloudRevision, 10);
  assert.equal(recovered.media.length, 1);
});


test('a delayed older writer cannot overwrite a newer durable snapshot from another tab', async () => {
  const env = environment(), { project, asset } = fixture();
  const tabA = createLocalProjectStore({ ...env.options, now: () => 1000 });
  const tabB = createLocalProjectStore({ ...env.options, now: () => 2000 });
  let release;
  env.backend.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const earlier = tabA.save('owner', project, [asset], { editVersion: 6, cloudRevision: 10, cloudDirty: true });
  await new Promise(resolve => setImmediate(resolve));
  env.backend.beforeWrite = null;
  const newer = structuredClone(project); newer.title = 'newer tab edit';
  await tabB.save('owner', newer, [asset], { editVersion: 6, cloudRevision: 10, cloudDirty: true });
  const failure = assert.rejects(earlier, { name: 'LocalProjectConflictError' });
  release(); await failure;
  const recovered = await createLocalProjectStore(env.options).load('owner', project.id);
  assert.equal(recovered.project.title, newer.title);
  assert.equal(recovered.cloudDirty, true);
  assert.equal(recovered.cloudRevision, 10);
});
