// Fallback opcional: YouTube Data API v3 com API key do usuário (§8.5).
import { FETCH_TIMEOUT_MS } from '../shared/constants.js';

const BASE = 'https://www.googleapis.com/youtube/v3';

export class DataApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DataApiError';
    this.code = code;
  }
}

/** "PT1H2M3S" -> 3723 (PURO). */
export function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso || ''));
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => (x ? Number(x) : 0));
  return Math.round(d * 86400 + h * 3600 + mi * 60 + s);
}

/** Decodifica entidades HTML comuns (snippet.title vem escapado). PURO. */
export function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function apiGet(path, params) {
  const url = new URL(BASE + path);
  for (const [key, v] of Object.entries(params)) url.searchParams.set(key, String(v));
  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new DataApiError('NETWORK', `Falha de rede na YouTube Data API: ${e?.message || e}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || `HTTP_${res.status}`;
    const msg = reason === 'quotaExceeded'
      ? 'Cota diária da YouTube Data API esgotada'
      : /keyInvalid|API_KEY_INVALID|badRequest/i.test(reason) || res.status === 400
        ? 'API key do YouTube inválida'
        : `YouTube Data API: ${data?.error?.message || reason}`;
    throw new DataApiError(reason, msg);
  }
  return data;
}

/** @returns {Promise<import('../shared/messages.js').Candidate[]>} */
export async function searchViaDataApi(query, key) {
  const search = await apiGet('/search', {
    part: 'snippet', type: 'video', videoCategoryId: 10, maxResults: 10, q: query, key,
  });
  const items = (search.items || []).filter((i) => i.id?.videoId);
  if (!items.length) return [];
  const ids = items.map((i) => i.id.videoId);
  const details = await apiGet('/videos', { part: 'contentDetails', id: ids.join(','), key });
  const durById = new Map((details.items || []).map((v) => [v.id, parseIsoDuration(v.contentDetails?.duration)]));
  return items.map((i, position) => ({
    videoId: i.id.videoId,
    title: decodeHtmlEntities(i.snippet?.title),
    channel: decodeHtmlEntities(i.snippet?.channelTitle),
    channelUrl: i.snippet?.channelId ? `/channel/${i.snippet.channelId}` : null,
    durationSec: durById.get(i.id.videoId) ?? null,
    views: null,
    badge: null,
    isLive: i.snippet?.liveBroadcastContent === 'live',
    position,
    src: 'data-api',
  })).filter((c) => !c.isLive);
}

/** Teste barato da key (videos.list = 1 unidade). */
export async function testApiKey(key) {
  try {
    await apiGet('/videos', { part: 'id', id: 'dQw4w9WgXcQ', key });
    return { valid: true, message: 'API key válida' };
  } catch (e) {
    return { valid: false, message: e.message };
  }
}
