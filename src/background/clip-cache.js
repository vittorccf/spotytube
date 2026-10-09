// Cache trackKey -> ClipEntry em storage.local (§3.1, §8.7).
import { SK_CLIP_PREFIX, SK_CLIP_INDEX, CACHE_MAX_ENTRIES } from '../shared/constants.js';

const k = (trackKey) => SK_CLIP_PREFIX + trackKey;

// serializa read-modify-write do índice
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function readIndex() {
  const { [SK_CLIP_INDEX]: idx } = await chrome.storage.local.get(SK_CLIP_INDEX);
  return idx && typeof idx === 'object' ? idx : {};
}

/** @returns {Promise<import('../shared/messages.js').ClipEntry|null>} */
export async function get(trackKey) {
  if (!trackKey) return null;
  const { [k(trackKey)]: entry } = await chrome.storage.local.get(k(trackKey));
  return entry || null;
}

export function put(entry) {
  return serial(async () => {
    const idx = await readIndex();
    idx[entry.trackKey] = entry.lastUsedAt || Date.now();
    await chrome.storage.local.set({ [k(entry.trackKey)]: entry, [SK_CLIP_INDEX]: idx });
    if (Object.keys(idx).length > CACHE_MAX_ENTRIES) await pruneUnlocked();
  });
}

async function update(trackKey, fn) {
  return serial(async () => {
    const entry = await get(trackKey);
    if (!entry) return null;
    const next = fn({ ...entry }) || entry;
    const idx = await readIndex();
    idx[trackKey] = next.lastUsedAt || Date.now();
    await chrome.storage.local.set({ [k(trackKey)]: next, [SK_CLIP_INDEX]: idx });
    return next;
  });
}

export function touch(trackKey) {
  return update(trackKey, (e) => { e.lastUsedAt = Date.now(); return e; });
}

export function setChosen(trackKey, index) {
  return update(trackKey, (e) => {
    const c = e.candidates[index];
    if (!c) return e;
    e.chosenIndex = index;
    e.videoId = c.videoId;
    // escolha manual de um candidato num fallback: passa a valer como clipe definitivo
    if (e.source === 'search-fallback') e.source = c.src === 'data-api' ? 'data-api' : 'scrape';
    e.lastUsedAt = Date.now();
    return e;
  });
}

export function markRejected(trackKey, videoId) {
  return update(trackKey, (e) => {
    if (videoId && !e.rejected.includes(videoId)) e.rejected = [...e.rejected, videoId];
    return e;
  });
}

export function setOffset(trackKey, offsetMs) {
  return update(trackKey, (e) => { e.offsetMs = offsetMs; return e; });
}

/** Remove todas as clip:* e o índice. Retorna quantas entradas removeu. */
export function clear() {
  return serial(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(SK_CLIP_PREFIX));
    await chrome.storage.local.remove([...keys, SK_CLIP_INDEX]);
    return keys.length;
  });
}

export async function count() {
  return Object.keys(await readIndex()).length;
}

/** Quando > CACHE_MAX_ENTRIES remove os 10% menos usados (PURO: escolhe as chaves). */
export function keysToPrune(idx, max = CACHE_MAX_ENTRIES) {
  const entries = Object.entries(idx);
  if (entries.length <= max) return [];
  const n = Math.max(entries.length - max, Math.ceil(entries.length * 0.1));
  return entries.sort((a, b) => a[1] - b[1]).slice(0, n).map(([key]) => key);
}

async function pruneUnlocked() {
  const idx = await readIndex();
  const victims = keysToPrune(idx);
  if (!victims.length) return 0;
  for (const v of victims) delete idx[v];
  await chrome.storage.local.remove(victims.map(k));
  await chrome.storage.local.set({ [SK_CLIP_INDEX]: idx });
  return victims.length;
}

export function prune() {
  return serial(pruneUnlocked);
}
