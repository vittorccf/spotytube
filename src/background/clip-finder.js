// findClip: cache -> scrape -> Data API -> fallback de busca (§8.1).
import { CACHE_TTL_MS, CLIP_ACCEPT_SCORE, CANDIDATES_KEEP } from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { log } from '../shared/log.js';
import { patchState } from './state.js';
import * as clipCache from './clip-cache.js';
import { buildQuery, rankCandidates, mergeDedup } from './clip-ranker.js';
import { searchYouTube } from './youtube-search.js';
import { searchViaDataApi } from './youtube-data-api.js';

/** @typedef {{ videoId:string|null, searchUrl:string, entry:import('../shared/messages.js').ClipEntry, fromCache:boolean, candidate:any }} ClipResult */

export const searchUrlFor = (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);

function resultFrom(entry, fromCache) {
  const candidate = entry.videoId ? (entry.candidates[entry.chosenIndex] ?? entry.candidates.find((c) => c.videoId === entry.videoId) ?? null) : null;
  return { videoId: entry.videoId, searchUrl: searchUrlFor(entry.query), entry, fromCache, candidate };
}

async function scrapeOrApi(q, settings) {
  try {
    const c = await searchYouTube(q);
    return c.map((x) => ({ ...x, src: 'scrape' }));
  } catch (e) {
    log.warn('scrape falhou', e.code || e.name, e.message);
    if (e.code === 'YT_CONSENT') patchState({ lastError: { code: e.code, message: e.message, at: Date.now() } });
    if (settings.ytApiKey) {
      try {
        return await searchViaDataApi(q, settings.ytApiKey);
      } catch (e2) {
        log.warn('Data API falhou', e2.code, e2.message);
        patchState({ lastError: { code: 'YT_DATA_API', message: e2.message, at: Date.now() } });
      }
    }
    return [];
  }
}

/**
 * @param {import('../shared/messages.js').Track} track
 * @returns {Promise<ClipResult>}
 */
export async function findClip(track, { force = false, excludeVideoIds = [] } = {}) {
  const now = Date.now();
  const prev = await clipCache.get(track.key);
  if (prev && !force && now - prev.cachedAt < CACHE_TTL_MS && prev.source !== 'search-fallback' && prev.videoId) {
    clipCache.touch(track.key).catch(() => {});
    return resultFrom(prev, true);
  }

  const settings = await getSettings();
  const excluded = new Set([...(prev?.rejected ?? []), ...excludeVideoIds]);
  const q1 = buildQuery(track, { withOfficial: true });
  let ranked = rankCandidates(await scrapeOrApi(q1, settings), track).filter((c) => !excluded.has(c.videoId));
  if (!ranked[0] || ranked[0].score < CLIP_ACCEPT_SCORE) {
    const q2 = buildQuery(track, { withOfficial: false });
    const more = rankCandidates(await scrapeOrApi(q2, settings), track).filter((c) => !excluded.has(c.videoId));
    ranked = mergeDedup(ranked, more);
  }

  let source; let videoId;
  if (ranked[0] && ranked[0].score >= CLIP_ACCEPT_SCORE) {
    source = ranked[0].src === 'data-api' ? 'data-api' : 'scrape';
    videoId = ranked[0].videoId;
  } else {
    source = 'search-fallback';
    videoId = null;
  }
  const entry = {
    trackKey: track.key,
    videoId,
    candidates: ranked.slice(0, CANDIDATES_KEEP),
    chosenIndex: 0,
    rejected: prev?.rejected ?? [],
    query: q1,
    source,
    offsetMs: prev?.offsetMs ?? 0,
    cachedAt: now,
    lastUsedAt: now,
  };
  await clipCache.put(entry);
  log.debug('findClip', track.name, '->', videoId, ranked[0]?.score, ranked[0]?.reasons);
  return resultFrom(entry, false);
}
