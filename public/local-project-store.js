/** Durable browser projects. Original files are cached here, never sent to Firebase. */
import { cloudData, validId } from './workspace.js?v=0.6.0';

const DB_NAME = 'norn-local-projects-v1';
const JOURNAL_PREFIX = 'norn.local.project.v1:';
const LAST_PREFIX = 'norn.local.last.v1:';
const clone = value => structuredClone(value);
const contentKey = asset => `${asset.kind}:${asset.size}:${asset.sha256}`;
const projectKey = (owner, id) => `${encodeURIComponent(owner)}:${id}`;
const mediaKey = (owner, asset) => `${encodeURIComponent(owner)}:${contentKey(asset)}`;
const validAsset = asset => asset && validId(asset.id) && /^[a-f0-9]{64}$/.test(asset.sha256 || '') &&
  ['image', 'video', 'audio'].includes(asset.kind) && Number.isSafeInteger(asset.size) && asset.size > 0;
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
function storageError(error) {
  if (error?.nornStorageError || error?.name === 'LocalProjectConflictError') return error;
  const quota = error?.name === 'QuotaExceededError';
  const result = new Error(quota ? '이 브라우저의 저장 공간이 부족합니다. 공간을 확보한 뒤 다시 저장하세요.' :
    '이 브라우저에 프로젝트를 저장하지 못했습니다. 브라우저의 사이트 저장 권한을 확인하고 다시 시도하세요.', { cause: error });
  result.name = quota ? 'QuotaExceededError' : 'LocalProjectStorageError';
  result.nornStorageError = true;
  return result;
}
function descriptors(project, supplied = [], previous = []) {
  const byId = new Map(), byContent = new Map();
  for (const row of [...previous, ...supplied]) {
    if (row.metadataAvailable || !byId.get(row.id)?.metadataAvailable) byId.set(row.id, row);
    if (validAsset(row) && (row.metadataAvailable || !byContent.get(contentKey(row))?.metadataAvailable)) byContent.set(contentKey(row), row);
  }
  return (project.assets || []).filter(validAsset).map(asset => {
    const source = byId.get(asset.id) || byContent.get(contentKey(asset)) || {};
    return {
      id: asset.id, sha256: asset.sha256, size: asset.size, kind: asset.kind, metadataAvailable: Boolean(source.metadataAvailable),
      relative_path: String(source.relative_path || source.fileName || asset.id).slice(0, 4096),
      fileName: String(source.fileName || asset.id).slice(0, 512),
      fileType: String(source.fileType || '').slice(0, 160),
      lastModified: Number(source.lastModified) || 0,
      analysis: Object.fromEntries(['width', 'height', 'duration'].map(key => [key, Number(source.analysis?.[key]) || 0])),
    };
  });
}
function metadataFromMedia(media) {
  return media.filter(validAsset).map(asset => ({
    ...asset, metadataAvailable: true, fileName: asset.file?.name || asset.relative_path?.split('/').pop() || asset.id,
    fileType: asset.file?.type || '', lastModified: asset.file?.lastModified || 0,
  }));
}
function acknowledged(record, { editVersion, cloudRevision }, writerId) {
  // Edit counters are local to a tab. An acknowledgement cannot rebase another writer's draft.
  if (record.writerId !== writerId) return record;
  return { ...record, cloudRevision: Math.max(record.cloudRevision || 0, Number(cloudRevision) || 0),
    cloudDirty: record.editVersion === editVersion && (Number(cloudRevision) || 0) >= (record.cloudRevision || 0) ? false : record.cloudDirty };
}

function indexedDbBackend(indexedDB, databaseName) {
  let connection;
  async function database() {
    if (!indexedDB?.open) throw storageError();
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['projects', 'media']) {
          const store = db.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('owner', 'owner');
        }
      };
      request.onerror = () => { connection = null; reject(request.error); };
      request.onblocked = () => { connection = null; reject(new Error('다른 탭의 저장소 연결을 닫아주세요.')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
    });
    return connection;
  }
  async function transaction(stores, callback) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      let value, failure;
      const fail = error => { failure ||= error; try { tx.abort(); } catch { reject(failure); } };
      const guard = fn => (...args) => { try { return fn(...args); } catch (error) { fail(error); } };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure || tx.error || new Error('저장을 완료하지 못했습니다.'));
      tx.onerror = event => { failure ||= event.target?.error || tx.error; };
      try { callback(tx, result => { value = result; }, guard); }
      catch (error) { fail(error); }
    });
  }
  return {
    async get(owner, id) {
      const db = await database();
      return requestResult(db.transaction('projects').objectStore('projects').get(projectKey(owner, id)));
    },
    async list(owner) {
      const db = await database();
      return requestResult(db.transaction('projects').objectStore('projects').index('owner').getAll(owner));
    },
    async readAssets(owner, assets) {
      if (!assets.length) return new Map();
      const db = await database(), store = db.transaction('media').objectStore('media');
      const rows = await Promise.all(assets.map(asset => requestResult(store.get(mediaKey(owner, asset)))));
      return new Map(rows.filter(Boolean).map(row => [row.key, row]));
    },
    write(record, assets) {
      return transaction(['projects', 'media'], (tx, done, guard) => {
        const projects = tx.objectStore('projects'), media = tx.objectStore('media');
        const previous = projects.get(record.key);
        previous.onsuccess = guard(() => {
          if (previous.result && previous.result.writerId !== record.writerId && previous.result.updatedAt > record.updatedAt) {
            const error = new Error('다른 탭에서 더 최근에 저장한 프로젝트가 있습니다. 현재 작업을 백업한 뒤 다시 열어주세요.');
            error.name = 'LocalProjectConflictError';
            throw error;
          }
          const next = { ...record, mediaDescriptors: descriptors(record.project, record.mediaDescriptors, previous.result?.mediaDescriptors) };
          const incoming = new Map(assets.map(asset => [asset.key, asset]));
          const missing = []; let remaining = next.mediaDescriptors.length;
          const finish = () => {
            next.missingAssetIds = missing; next.storedAssetCount = next.mediaDescriptors.length - missing.length;
            projects.put(next); done(next);
          };
          if (!remaining) return finish();
          for (const descriptor of next.mediaDescriptors) {
            const key = mediaKey(record.owner, descriptor), check = media.getKey(key);
            check.onsuccess = guard(() => {
              if (check.result === undefined) {
                const asset = incoming.get(key);
                if (asset) media.put(asset);
                else missing.push(descriptor.id);
              }
              if (--remaining === 0) finish();
            });
          }
        });
      });
    },
    update(owner, id, updater) {
      return transaction(['projects'], (tx, done, guard) => {
        const projects = tx.objectStore('projects'), request = projects.get(projectKey(owner, id));
        request.onsuccess = guard(() => {
          if (!request.result) return done(null);
          const next = updater(request.result); projects.put(next); done(next);
        });
      });
    },
    remove(owner, id, recoveryAssets = []) {
      return transaction(['projects', 'media'], (tx, done, guard) => {
        const projects = tx.objectStore('projects'), media = tx.objectStore('media');
        const request = projects.index('owner').getAll(owner);
        request.onsuccess = guard(() => {
          const keep = new Set(request.result.filter(row => row.id !== id)
            .flatMap(row => (row.project.assets || []).filter(validAsset).map(asset => mediaKey(owner, asset))));
          for (const asset of recoveryAssets.filter(validAsset)) keep.add(mediaKey(owner, asset));
          projects.delete(projectKey(owner, id));
          const keys = media.index('owner').getAllKeys(owner);
          keys.onsuccess = guard(() => { for (const key of keys.result) if (!keep.has(key)) media.delete(key); done(true); });
        });
      });
    },
  };
}

/** Pass backend/storage/URL/File/now in tests; normal callers need no arguments. */
export function createLocalProjectStore(options = {}) {
  let storage;
  try { storage = 'storage' in options ? options.storage : globalThis.localStorage; } catch { storage = null; }
  const backend = options.backend || indexedDbBackend(options.indexedDB ?? globalThis.indexedDB, options.databaseName || DB_NAME);
  const urls = options.URL || globalThis.URL, FileClass = options.File || globalThis.File;
  const now = options.now || Date.now, memoryJournal = new Map(), last = new Map(), acknowledgedRevisions = new Map();
  let queue = Promise.resolve(), timestamp = 0, sequence = 0;
  const enqueue = run => { const result = queue.then(run, run); queue = result.catch(() => {}); return result; };
  const stamp = () => { timestamp = Math.max(now(), timestamp + 1); return timestamp; };
  const token = () => `${now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
  const writerId = globalThis.crypto?.randomUUID?.() || token();
  const validate = (owner, id) => {
    if (typeof owner !== 'string' || !owner || owner.length > 256 || !validId(id)) throw new Error('프로젝트 저장 대상이 올바르지 않습니다.');
  };
  function journalKey(owner, id) { return JOURNAL_PREFIX + projectKey(owner, id); }
  function storedJournal(owner, id) {
    try {
      const row = JSON.parse(storage?.getItem(journalKey(owner, id)) || 'null');
      if (row?.owner === owner && row.id === id && row.project?.id === id) return row;
    } catch {}
    return null;
  }
  function readJournal(owner, id) {
    const memory = memoryJournal.get(journalKey(owner, id)), stored = storedJournal(owner, id);
    return memory && (!stored || memory.updatedAt >= stored.updatedAt) ? memory : stored;
  }
  function writeJournal(record) {
    const key = journalKey(record.owner, record.id); memoryJournal.set(key, record);
    try { storage?.setItem(key, JSON.stringify(record)); } catch { /* The durable write still runs; success is reported only after commit. */ }
  }
  function clearJournal(owner, id, expectedToken) {
    const key = journalKey(owner, id), memory = memoryJournal.get(key);
    if (!expectedToken || memory?.token === expectedToken) memoryJournal.delete(key);
    // Another tab may have replaced the shared journal while this transaction was pending.
    const stored = storedJournal(owner, id);
    if (!expectedToken || stored?.token === expectedToken) {
      try { storage?.removeItem(key); } catch {}
    }
  }
  function setLast(owner, id) {
    last.set(owner, id);
    try { if (id) storage?.setItem(LAST_PREFIX + encodeURIComponent(owner), id); else storage?.removeItem(LAST_PREFIX + encodeURIComponent(owner)); } catch {}
  }
  function journalRows(owner) {
    const rows = new Map();
    for (const row of memoryJournal.values()) if (row.owner === owner) rows.set(row.id, row);
    try {
      const prefix = JOURNAL_PREFIX + encodeURIComponent(owner) + ':';
      for (let index = 0; index < storage?.length; index++) {
        const key = storage.key(index); if (!key?.startsWith(prefix)) continue;
        const row = JSON.parse(storage.getItem(key));
        if (row?.owner === owner && validId(row.id) && row.project?.id === row.id) rows.set(row.id, chooseRecord(rows.get(row.id), row));
      }
    } catch {}
    return [...rows.values()];
  }
  function chooseRecord(durable, journal) {
    return journal && (!durable || journal.updatedAt >= durable.updatedAt) ?
      { ...journal, mediaDescriptors: descriptors(journal.project, journal.mediaDescriptors, durable?.mediaDescriptors) } : durable;
  }
  const rowSummary = record => ({ ...clone(record), title: record.project.title, assets: record.project.assets,
    variantIds: record.project.variants.map(variant => variant.id), localOnly: !record.cloudRevision,
    storedAssetCount: record.storedAssetCount ?? 0 });

  return {
    save(owner, project, media = [], options = {}) {
      let record;
      try {
        validate(owner, project.id);
        const snapshot = clone(cloudData(project)), previous = readJournal(owner, project.id);
        record = { key: projectKey(owner, project.id), owner, id: project.id, project: snapshot, writerId,
          cloudRevision: Math.max(Number(options.cloudRevision) || 0, acknowledgedRevisions.get(projectKey(owner, project.id)) || 0),
          cloudDirty: Boolean(options.cloudDirty), editVersion: Number(options.editVersion) || 0,
          selected: String(options.selected || ''), updatedAt: stamp(), token: token(),
          mediaDescriptors: descriptors(snapshot, metadataFromMedia(media), previous?.mediaDescriptors) };
        // Intentionally before the first promise/await: a tab close cannot bypass the metadata journal.
        writeJournal(record); setLast(owner, project.id);
      } catch (error) { return Promise.reject(error); }
      const files = media.filter(asset => validAsset(asset) && asset.file && asset.file.size === asset.size)
        .map(asset => ({ key: mediaKey(owner, asset), owner, blob: asset.file, thumb: asset.thumbBlob || null }));
      return enqueue(async () => {
        try {
          const latest = readJournal(owner, record.id);
          if (latest?.writerId === writerId && latest.editVersion === record.editVersion && latest.updatedAt === record.updatedAt) record = latest;
          const saved = await backend.write(record, files);
          clearJournal(owner, record.id, record.token);
          return rowSummary(saved);
        } catch (error) { throw storageError(error); }
      });
    },
    async load(owner, id) {
      validate(owner, id); await queue;
      let durable, readError;
      try { durable = await backend.get(owner, id); } catch (error) { readError = error; }
      const journal = readJournal(owner, id), record = chooseRecord(durable, journal);
      if (!record) { if (readError) throw storageError(readError); return null; }
      let assets = new Map();
      try { assets = await backend.readAssets(owner, record.mediaDescriptors || []); } catch (error) { readError = error; }
      const restored = [], missingAssets = [];
      try {
        for (const descriptor of record.mediaDescriptors || []) {
          const cached = assets.get(mediaKey(owner, descriptor));
          if (!cached?.blob || cached.blob.size !== descriptor.size) { missingAssets.push(descriptor.id); continue; }
          const file = new FileClass([cached.blob], descriptor.fileName || descriptor.relative_path.split('/').pop(),
            { type: descriptor.fileType || cached.blob.type, lastModified: descriptor.lastModified });
          const url = urls.createObjectURL(file);
          let thumb_url = '';
          try { thumb_url = cached.thumb ? urls.createObjectURL(cached.thumb) : descriptor.kind === 'image' ? url : ''; }
          catch (error) { urls.revokeObjectURL(url); throw error; }
          restored.push({ ...descriptor, file, url, thumb_url, thumbBlob: cached.thumb || null, local: true });
        }
      } catch (error) {
        for (const asset of restored) for (const url of new Set([asset.url, asset.thumb_url].filter(Boolean))) urls.revokeObjectURL(url);
        throw storageError(error);
      }
      setLast(owner, id);
      return { ...rowSummary(record), media: restored, missingAssets, storageError: readError ? storageError(readError).message : null };
    },
    async list(owner) {
      await queue;
      const journals = journalRows(owner); let rows;
      try { rows = await backend.list(owner); }
      catch (error) { if (!journals.length) throw storageError(error); rows = []; }
      const merged = new Map(rows.map(row => [row.id, row]));
      for (const row of journals) merged.set(row.id, chooseRecord(merged.get(row.id), row));
      return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(rowSummary);
    },
    markSynced(owner, id, acknowledgement) {
      validate(owner, id);
      const key = projectKey(owner, id);
      acknowledgedRevisions.set(key, Math.max(acknowledgedRevisions.get(key) || 0, Number(acknowledgement.cloudRevision) || 0));
      const journal = storedJournal(owner, id) || readJournal(owner, id);
      const changed = journal?.writerId === writerId ? { ...acknowledged(journal, acknowledgement, writerId), token: token() } : null;
      if (changed) writeJournal(changed);
      return enqueue(async () => {
        try {
          const updated = await backend.update(owner, id, row => acknowledged(row, acknowledgement, writerId));
          if (updated && changed && updated.writerId === writerId && updated.editVersion === changed.editVersion && updated.updatedAt === changed.updatedAt) clearJournal(owner, id, changed.token);
          return updated ? rowSummary(updated) : null;
        } catch (error) { throw storageError(error); }
      });
    },
    remove(owner, id) {
      validate(owner, id);
      return enqueue(async () => {
        try {
          const recoveryAssets = journalRows(owner).filter(row => row.id !== id).flatMap(row => row.project.assets || []);
          await backend.remove(owner, id, recoveryAssets); clearJournal(owner, id);
          if (this.getLast(owner) === id) setLast(owner, null);
          acknowledgedRevisions.delete(projectKey(owner, id));
        } catch (error) { throw storageError(error); }
      });
    },
    getLast(owner) {
      try { const id = storage?.getItem(LAST_PREFIX + encodeURIComponent(owner)); if (validId(id)) return id; } catch {}
      return last.get(owner) || null;
    },
  };
}

export const localProjectStore = createLocalProjectStore();
