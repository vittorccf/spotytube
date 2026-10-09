// Prevenção de loop entre direções (§11). Mapas com TTL em storage.session.guard.
import { SK_GUARD, EXT_VIDEO_TTL_MS, EXT_TRACK_TTL_MS, YT_VIDEO_COOLDOWN_MS } from '../shared/constants.js';

const EMPTY = () => ({ extOpenedVideos: {}, extPlayedTracks: {}, ytCooldown: {} });
let chain = Promise.resolve();

async function read() {
  try {
    const { [SK_GUARD]: g } = await chrome.storage.session.get(SK_GUARD);
    return { ...EMPTY(), ...(g || {}) };
  } catch {
    return EMPTY();
  }
}

/** Remove expirados (PURO). */
export function pruneGuard(g, now = Date.now()) {
  const out = EMPTY();
  for (const k of Object.keys(out)) {
    for (const [id, exp] of Object.entries(g[k] || {})) if (exp > now) out[k][id] = exp;
  }
  return out;
}

function add(map, id, ttl) {
  if (!id) return Promise.resolve();
  chain = chain.then(async () => {
    const g = pruneGuard(await read());
    g[map][id] = Date.now() + ttl;
    await chrome.storage.session.set({ [SK_GUARD]: g });
  }).catch(() => {});
  return chain;
}

async function has(map, id) {
  if (!id) return false;
  await chain;
  const g = await read();
  return (g[map][id] || 0) > Date.now();
}

export const addExtVideo = (videoId) => add('extOpenedVideos', videoId, EXT_VIDEO_TTL_MS);
export const isExtVideo = (videoId) => has('extOpenedVideos', videoId);
export const addExtPlayedTrack = (trackKey) => add('extPlayedTracks', trackKey, EXT_TRACK_TTL_MS);
export const isExtPlayedTrack = (trackKey) => has('extPlayedTracks', trackKey);
export const setYtCooldown = (videoId) => add('ytCooldown', videoId, YT_VIDEO_COOLDOWN_MS);
export const inYtCooldown = (videoId) => has('ytCooldown', videoId);
