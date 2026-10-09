// Scraper da busca do YouTube (§8.4). parseSearchData é PURO.
import { FETCH_TIMEOUT_MS, SK_PARSER_HEALTH } from '../shared/constants.js';
import { parseDuration, parseViews } from '../shared/text-normalize.js';
import { extractJsonAssignment } from './youtube-html.js';
import { buildSearchScrapeUrl } from './clip-ranker.js';

export class ConsentError extends Error {
  constructor(message = 'Página de consentimento do YouTube: abra youtube.com e aceite os cookies') {
    super(message);
    this.name = 'ConsentError';
    this.code = 'YT_CONSENT';
  }
}
export class ParserError extends Error {
  constructor(code = 'PARSER', message = 'Não foi possível ler os resultados do YouTube') {
    super(message);
    this.name = 'ParserError';
    this.code = code;
  }
}
export class YtNetworkError extends Error {
  constructor(message = 'Falha de rede ao acessar o YouTube') {
    super(message);
    this.name = 'NetworkError';
    this.code = 'YT_NETWORK';
  }
}

/**
 * DFS iterativa: coleta node[key] sem descer dentro do que foi coletado.
 * Ignora chaves em `skipKeys` (ex.: reelItemRenderer = shorts).
 */
export function deepCollect(obj, key, { maxDepth = 40, max = 40, skipKeys = ['reelItemRenderer', 'reelShelfRenderer', 'shortsLockupViewModel'] } = {}) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  const stack = [[obj, 0]];
  while (stack.length && out.length < max) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], depth + 1]);
      continue;
    }
    const keys = Object.keys(node);
    // empilha em ordem reversa para preservar a ordem do documento na DFS
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i];
      if (skipKeys.includes(k)) continue;
      if (k === key) continue;
      const v = node[k];
      if (v && typeof v === 'object') stack.push([v, depth + 1]);
    }
    if (Object.prototype.hasOwnProperty.call(node, key) && node[key] && typeof node[key] === 'object') {
      out.push(node[key]);
    }
  }
  return out;
}


function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText != null) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join('');
  if (t.content != null) return t.content;
  return '';
}

/** @returns {import('../shared/messages.js').Candidate|null} */
function fromVideoRenderer(v) {
  if (!v || !v.videoId) return null;
  const owner = v.ownerText ?? v.longBylineText ?? v.shortBylineText;
  const styles = (v.ownerBadges ?? []).map((b) => b.metadataBadgeRenderer?.style);
  const lengthLabel = v.lengthText?.simpleText ?? v.lengthText?.accessibility?.accessibilityData?.label;
  return {
    videoId: v.videoId,
    title: v.title?.runs?.map((r) => r.text).join('') ?? v.title?.simpleText ?? '',
    channel: owner?.runs?.[0]?.text ?? '',
    channelUrl: owner?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ?? null,
    durationSec: parseDuration(lengthLabel),
    views: parseViews(v.viewCountText?.simpleText ?? v.viewCountText?.runs?.map((r) => r.text).join('')),
    badge: styles.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST') ? 'oac' : styles.includes('BADGE_STYLE_TYPE_VERIFIED') ? 'verified' : null,
    isLive: (v.badges ?? []).some((b) => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW') || !v.lengthText,
    position: 0,
  };
}

/** best-effort para o formato novo (lockupViewModel). */
function fromLockup(l) {
  if (!l || !l.contentId) return null;
  if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  const badgeTexts = deepCollect(l.contentImage, 'thumbnailBadgeViewModel', { max: 5 }).map((b) => textOf(b.text));
  const durText = badgeTexts.find((t) => /^\d+(:\d{1,2}){1,2}$/.test(String(t).trim()));
  const durationSec = parseDuration(durText ?? null);
  const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
  let views = null;
  for (const r of rows) for (const p of r.metadataParts ?? []) {
    const t = textOf(p.text);
    if (/views?$/i.test(t)) views = parseViews(t);
  }
  return {
    videoId: l.contentId,
    title: textOf(meta?.title),
    channel: textOf(rows?.[0]?.metadataParts?.[0]?.text),
    channelUrl: null,
    durationSec,
    views,
    badge: null,
    isLive: durationSec == null,
    position: 0,
  };
}

/**
 * ytInitialData da página de resultados -> Candidate[] (sem lives/shorts, dedupe por videoId).
 * @returns {import('../shared/messages.js').Candidate[]}
 */
export function parseSearchData(data) {
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  let renderers = [];
  for (const s of sections) {
    for (const it of s.itemSectionRenderer?.contents ?? []) {
      if (it.videoRenderer) renderers.push(fromVideoRenderer(it.videoRenderer));
    }
  }
  if (renderers.length === 0) {
    renderers = deepCollect(data, 'videoRenderer', { maxDepth: 40, max: 40 }).map(fromVideoRenderer);
    renderers.push(...deepCollect(data, 'lockupViewModel', { maxDepth: 40, max: 40 }).map(fromLockup));
  }
  const seen = new Set();
  const out = [];
  for (const c of renderers) {
    if (!c || !c.videoId || seen.has(c.videoId)) continue;
    seen.add(c.videoId);
    if (c.isLive) continue;
    out.push(c);
  }
  return out.map((c, i) => ({ ...c, position: i }));
}

async function recordParserHealth(okResult, error) {
  try {
    const { [SK_PARSER_HEALTH]: h0 } = await chrome.storage.local.get(SK_PARSER_HEALTH);
    const h = { lastOkAt: 0, lastFailAt: 0, consecutiveFails: 0, lastError: null, ...(h0 || {}) };
    if (okResult) { h.lastOkAt = Date.now(); h.consecutiveFails = 0; h.lastError = null; }
    else { h.lastFailAt = Date.now(); h.consecutiveFails++; h.lastError = error || 'PARSER'; }
    await chrome.storage.local.set({ [SK_PARSER_HEALTH]: h });
  } catch { /* ignore */ }
}

/**
 * Busca no YouTube via scraping.
 * @returns {Promise<import('../shared/messages.js').Candidate[]>}
 * @throws ConsentError | ParserError | YtNetworkError
 */
export async function searchYouTube(query) {
  const url = buildSearchScrapeUrl(query);
  let res; let html;
  try {
    res = await fetch(url, {
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    html = await res.text();
  } catch (e) {
    throw new YtNetworkError(String(e?.message || e));
  }
  if (!res.ok) throw new YtNetworkError(`HTTP ${res.status}`);
  const hasData = html.includes('ytInitialData');
  if ((res.url || '').includes('consent.youtube.com') || (!hasData && /consent/i.test(html))) {
    throw new ConsentError();
  }
  const data = extractJsonAssignment(html, 'ytInitialData');
  if (!data) {
    await recordParserHealth(false, 'NO_INITIAL_DATA');
    throw new ParserError('NO_INITIAL_DATA');
  }
  const cands = parseSearchData(data);
  if (!cands.length) {
    await recordParserHealth(false, 'NO_RESULTS_PARSED');
    throw new ParserError('NO_RESULTS_PARSED');
  }
  await recordParserHealth(true);
  return cands;
}
