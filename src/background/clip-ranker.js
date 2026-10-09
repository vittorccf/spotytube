// Query e ranking de candidatos de clipe (§8.3, §8.6). PURO.
import { CLIP_MIN_TITLE_COVERAGE } from '../shared/constants.js';
import { normalize, tokens, coverage, containsPhrase, cleanSpotifyTitle } from '../shared/text-normalize.js';

/** @param {import('../shared/messages.js').Track} track */
export function buildQuery(track, { withOfficial = true } = {}) {
  const artist = track.artists?.[0] ?? '';
  const { clean, flags } = cleanSpotifyTitle(track.name);
  let q = `${artist} ${clean}`.trim();
  if (withOfficial) q += ' official video';
  if (flags.remix) q += ' remix';
  if (flags.live) q += ' live';
  return q;
}

/** URL de scraping da busca (filtro "Vídeos", hl=en). */
export function buildSearchScrapeUrl(q) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`;
}

export const compact = (s) => String(s || '').replace(/\s+/g, '');

const CHANNEL_SUFFIX_RE = /\s*(vevo|official|oficial|topic|tv|music|records)$/;

/** Canal normalizado sem sufixos "vevo|official|topic|..." (inclusive "vevo" grudado). */
export function channelCore(normCh) {
  let s = normCh;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(CHANNEL_SUFFIX_RE, '').replace(/vevo$/, '').trim();
    if (s === before) break;
  }
  return s;
}

/** O canal pertence ao artista? */
export function channelMatchesArtist(normCh, normArtist) {
  if (!normCh || !normArtist) return false;
  const core = channelCore(normCh);
  const ca = compact(normArtist);
  return compact(core) === ca || containsPhrase(normCh, normArtist) || compact(normCh).startsWith(ca);
}

const OFFICIAL_TIERS = [
  { pts: 30, label: 'official music video', phrases: ['official music video'] },
  { pts: 25, label: 'official video', phrases: ['official video', 'video oficial', 'clipe oficial', 'videoclipe', 'videoclip oficial'] },
  { pts: 15, label: 'mv', phrases: ['mv', 'm v'] },
  { pts: 5, label: 'official', phrases: ['official', 'oficial'] },
];

// Negativos: [rótulo, pontos, frases, condição(ctx)]
const NEGATIVES = [
  ['lyrics', -40, ['lyric', 'lyrics', 'lyric video', 'letra', 'legendado', 'traducao']],
  ['audio', -30, ['audio', 'official audio']],
  ['visualizer', -35, ['visualizer', 'visualiser']],
  ['live', -30, ['live', 'ao vivo', 'en vivo', 'concert', 'show'], (c) => !c.flags.live],
  ['cover', -50, ['cover'], (c) => !c.channelIsArtist],
  ['karaoke', -60, ['karaoke']],
  ['instrumental', -60, ['instrumental'], (c) => !c.flags.instrumental],
  ['reaction', -60, ['reaction', 'react', 'reagindo']],
  ['edited', -60, ['8d', 'slowed', 'sped up', 'speed up', 'reverb', 'nightcore', 'bass boosted']],
  ['remix', -35, ['remix'], (c) => !c.flags.remix],
  ['album/tutorial', -60, ['full album', 'album completo', 'tutorial', 'how to play', 'guitar lesson', 'drum cover']],
  ['teaser', -25, ['teaser', 'trailer', 'preview']],
  ['behind', -40, ['behind the scenes', 'making of', 'bastidores']],
];

/**
 * Pontua um candidato contra a faixa.
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreCandidate(c, track) {
  const reasons = [];
  let score = 0;
  const add = (pts, label) => {
    const p = Math.round(pts * 10) / 10;
    score += p;
    reasons.push(`${p >= 0 ? '+' : '-'}${label} ${Math.abs(p)}`);
  };

  const { clean, flags } = cleanSpotifyTitle(track.name);
  const T = normalize(clean);
  const A = (track.artists || []).map(normalize).filter(Boolean);
  const A0 = A[0] || '';
  const V = normalize(c.title);
  const Ch = normalize(c.channel);
  const trackTerms = normalize(`${track.name} ${track.album || ''}`);
  const isTopic = /topic$/.test(Ch);
  // canal auto-gerado ' - Topic' é só áudio: não ganha o bônus de canal do artista (ver README, Desvios)
  const channelIsArtist = !isTopic && channelMatchesArtist(Ch, A0);
  const ctx = { flags, channelIsArtist };

  // título
  const cov = coverage(tokens(T), tokens(V));
  if (cov < CLIP_MIN_TITLE_COVERAGE) add(-100, 'low title coverage');
  add(40 * cov, 'title');

  // artista no título
  if (A.some((a) => containsPhrase(V, a))) add(20, 'artist in title');

  // canal
  if (channelIsArtist) add(25, 'channel=artist');
  if (/vevo$/.test(compact(Ch))) add(channelIsArtist ? 25 : 20, 'vevo');
  if (c.badge === 'oac') add(20, 'oac');
  else if (c.badge === 'verified') add(8, 'verified');

  // official (mutuamente exclusivos: o maior)
  for (const tier of OFFICIAL_TIERS) {
    if (tier.phrases.some((p) => containsPhrase(V, p))) { add(tier.pts, tier.label); break; }
  }

  // negativos (acumulam; não penaliza se o termo faz parte do nome/álbum da faixa)
  for (const [label, pts, phrases, cond] of NEGATIVES) {
    if (cond && !cond(ctx)) continue;
    const hit = phrases.some((p) => containsPhrase(V, p) && !containsPhrase(trackTerms, p));
    if (hit) add(pts, label);
  }
  if (isTopic) add(-25, 'topic channel');

  // duração
  if (c.durationSec != null && Number.isFinite(c.durationSec)) {
    const d = Math.abs(c.durationSec - (track.durationMs || 0) / 1000);
    if (d <= 10) add(15, 'duration');
    else if (d <= 30) add(10, 'duration');
    else if (d <= 90) add(3, 'duration');
    else if (d > 600) add(-40, 'duration');
    else if (d > 120) add(-15, 'duration');
    if (c.durationSec < 60) add(-40, 'too short');
  }

  // relevância do YouTube
  const rel = Math.max(0, 10 - (c.position ?? 10));
  if (rel) add(rel, 'position');

  // views
  if (c.views) add(Math.min(12, 2 * Math.log10(c.views)), 'views');

  return { score: Math.round(score * 10) / 10, reasons };
}

/** Pontua e ordena (score desc). */
export function rankCandidates(cands, track) {
  return (cands || [])
    .map((c) => ({ ...c, ...scoreCandidate(c, track) }))
    .sort((a, b) => b.score - a.score);
}

/** Junta listas ranqueadas sem duplicar videoId (mantém o de maior score) e ordena. */
export function mergeDedup(a, b) {
  const map = new Map();
  for (const c of [...(a || []), ...(b || [])]) {
    const prev = map.get(c.videoId);
    if (!prev || (c.score ?? -Infinity) > (prev.score ?? -Infinity)) map.set(c.videoId, c);
  }
  return [...map.values()].sort((x, y) => y.score - x.score);
}
