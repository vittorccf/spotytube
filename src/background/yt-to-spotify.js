// Pipeline YouTube -> Spotify (§12). Funções marcadas PURO são testáveis em node.
import {
  YT_MATCH_AUTOPLAY, YT_MATCH_SUGGEST, YT_MUSIC_MIN_SEC, YT_MUSIC_MAX_SEC,
} from '../shared/constants.js';
import { MSG } from '../shared/messages.js';
import { getSettings } from '../shared/settings.js';
import { log } from '../shared/log.js';
import { normalize, tokens, dice, containsPhrase, cleanSpotifyTitle, detectFlags } from '../shared/text-normalize.js';
import { getState, patchState } from './state.js';
import * as spotifyApi from './spotify-api.js';
import * as loopGuard from './loop-guard.js';
import * as poller from './poller.js';
import { getVideoMeta } from './youtube-watch-meta.js';

// ------------------------------------------------------------------ PURO
/** PURO */
export function isLikelyMusic(meta) {
  if (!meta) return false;
  const len = Number(meta.lengthSec) || 0;
  if (meta.isLive && len === 0) return false;
  if (len < YT_MUSIC_MIN_SEC || len > YT_MUSIC_MAX_SEC) return false;
  if (meta.category === 'Music') return true;
  const author = String(meta.author || '');
  if (/VEVO$/i.test(author) || / - Topic$/.test(author)) return true;
  const t = normalize(meta.title);
  return ['official video', 'official music video', 'official audio', 'clipe oficial', 'videoclipe', 'lyric video', 'mv']
    .some((p) => containsPhrase(t, p));
}

/** PURO: "TaylorSwiftVEVO" -> "Taylor Swift", "Artist - Topic" -> "Artist". */
export function cleanChannelName(channel) {
  let s = String(channel || '').trim();
  s = s.replace(/ - Topic$/i, '');
  if (/VEVO$/i.test(s)) {
    s = s.replace(/VEVO$/i, '');
    s = s.replace(/([a-z\d])([A-Z])/g, '$1 $2');
  }
  s = s.replace(/(?<![\p{L}\p{N}])(official|oficial|music|tv|channel|canal)(?![\p{L}\p{N}])/giu, '');
  return s.replace(/\s+/g, ' ').trim();
}

const DECOR_WORDS = /(?<![\p{L}\p{N}])(official|oficial|video|vídeo|clipe|clip|audio|áudio|lyric|lyrics|letra|visualizer|hd|hq|4k|mv|m\/v|remaster|remastered|explicit|legendado|tradução)(?![\p{L}\p{N}])/iu;
const FEAT_RE = /\s*[\(\[]?\s*(?<![\p{L}\p{N}])(?:feat\.?|ft\.?|featuring|part\.?|participação)\s+([^\)\]\-|–—]+)[\)\]]?/iu;
const SEPARATORS = [' - ', ' – ', ' — ', ' ~ '];

const cleanPiece = (s) => String(s || '').replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').replace(/\s+/g, ' ').trim();

/**
 * PURO: separa artista / música de um título de vídeo.
 * @returns {{artist:string|null, track:string, featured:string[], flags:object, original:string}}
 */
export function parseVideoTitle(title, channel) {
  const original = String(title || '');
  let t = original;
  // 1. grupos decorativos
  t = t.replace(/\s*[\(\[【]([^\)\]】]*)[\)\]】]/g, (whole, inner) => (DECOR_WORDS.test(inner) ? ' ' : whole));
  // 2. sufixos soltos
  t = t.replace(/\s*[|｜]\s*(official|oficial).*$/i, '');
  t = t.replace(/\s+(official\s+(music\s+)?video|clipe oficial|videoclipe)\s*$/i, '');
  // 3. featured
  let featured = [];
  const fm = FEAT_RE.exec(t);
  if (fm) {
    featured = fm[1].split(/,|&| e | and | x /i).map(cleanPiece).filter(Boolean);
    t = t.slice(0, fm.index) + ' ' + t.slice(fm.index + fm[0].length);
  }
  t = t.replace(/\s+/g, ' ').trim();

  const chan = cleanChannelName(channel);
  let artist = null;
  let track = t;
  let viaSeparator = false;
  // 4. separação
  const sep = SEPARATORS.map((s) => [s, t.indexOf(s)]).filter(([, i]) => i > 0).sort((a, b) => a[1] - b[1])[0];
  if (sep) {
    artist = t.slice(0, sep[1]);
    track = t.slice(sep[1] + sep[0].length);
    viaSeparator = true;
  } else {
    const q = /^(.+?)\s+["“'‘](.+?)["”'’](.*)$/.exec(t);
    if (q) {
      artist = q[1];
      track = q[2];
    } else if (/\s*[|｜]\s*/.test(t)) {
      const [left, ...rest] = t.split(/\s*[|｜]\s*/);
      const right = rest.join(' ');
      const nr = normalize(right);
      const nc = normalize(chan);
      if (nc && (containsPhrase(nr, nc) || containsPhrase(nc, nr) || dice(tokens(right), tokens(chan)) >= 0.5)) {
        track = left;
        artist = right;
      } else {
        artist = chan || null;
        track = left;
      }
    } else {
      artist = chan || null;
      track = t;
    }
  }
  // 5. "Música - Artista": inverte se a direita casa melhor com o canal
  if (viaSeparator && chan) {
    const dl = dice(tokens(artist), tokens(chan));
    const dr = dice(tokens(track), tokens(chan));
    if (dr > dl) [artist, track] = [track, artist];
  }
  artist = artist ? cleanPiece(artist) : null;
  track = cleanPiece(track) || cleanPiece(t);
  // 6. flags no título original, ignorando palavras do nome da música
  const flags = detectFlags(original, track);
  return { artist: artist || null, track, featured, flags, original };
}

/** PURO */
export function buildSpotifyQueries(parsed) {
  const strip = (s) => String(s || '').replace(/["]/g, '').trim();
  const out = [];
  if (parsed.artist) {
    out.push(`track:"${strip(parsed.track)}" artist:"${strip(parsed.artist)}"`);
    out.push(`${strip(parsed.artist)} ${strip(parsed.track)}`);
  } else {
    out.push(strip(parsed.track));
  }
  return out;
}

const FLAG_KEYS = ['remix', 'live', 'acoustic', 'instrumental'];
const BAD_SP = ['karaoke', 'tribute', 'originally performed by'];

/**
 * PURO: similaridade entre track do Spotify (objeto da API) e o título parseado.
 * @returns {number} ~0..1.1
 */
export function scoreTrackMatch(sp, parsed, videoDurationSec) {
  const spClean = cleanSpotifyTitle(sp.name);
  const titleSim = dice(tokens(spClean.clean), tokens(parsed.track));
  const spArtists = (sp.artists || []).map((a) => a.name || '').filter(Boolean);
  let artistSim;
  if (parsed.artist) {
    const pa = normalize(parsed.artist);
    artistSim = Math.max(0, ...spArtists.map((a) => (containsPhrase(pa, normalize(a)) ? 1 : dice(tokens(a), tokens(parsed.artist)))));
  } else {
    const orig = normalize(parsed.original || parsed.track);
    artistSim = spArtists.some((a) => containsPhrase(orig, normalize(a))) ? 1 : 0.5;
  }
  let score = 0.55 * titleSim + 0.35 * artistSim;

  if (videoDurationSec && sp.duration_ms) {
    const d = Math.abs(sp.duration_ms / 1000 - videoDurationSec);
    if (d <= 10) score += 0.10;
    else if (d <= 30) score += 0.05;
    else if (d > 90) score -= 0.10;
  }
  const pf = parsed.flags || {};
  for (const f of FLAG_KEYS) {
    if (spClean.flags[f] && !pf[f]) score -= 0.20;
    else if (pf[f] && !spClean.flags[f]) score -= 0.10;
  }
  const spText = normalize(`${sp.name} ${spArtists.join(' ')}`);
  if (BAD_SP.some((b) => containsPhrase(spText, b))) score -= 0.50;

  let featBonus = 0;
  for (const f of parsed.featured || []) {
    const nf = normalize(f);
    if (nf && spArtists.some((a) => normalize(a) === nf || containsPhrase(normalize(a), nf))) featBonus += 0.03;
  }
  score += Math.min(0.09, featBonus);
  return Math.round(score * 1000) / 1000;
}

// ------------------------------------------------------------------ pipeline
async function currentVideoTime(tabId, videoId, fallbackSec, receivedAt) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.SW_GET_STATUS });
    const st = res?.data ?? res;
    if (st && st.videoId === videoId && Number.isFinite(st.currentTime)) return st.currentTime;
  } catch { /* aba sem CS */ }
  return (fallbackSec || 0) + (receivedAt ? (Date.now() - receivedAt) / 1000 : 0);
}

async function playWithDeviceFallback(opts) {
  try {
    await spotifyApi.play(opts);
    return true;
  } catch (e) {
    if (e instanceof spotifyApi.NoDeviceError) {
      const settings = await getSettings();
      const devices = (await spotifyApi.getDevices()).filter((d) => !d.is_restricted);
      const target = devices.find((d) => d.id === settings.preferredDeviceId)
        ?? devices.find((d) => d.is_active)
        ?? devices.find((d) => d.type === 'Computer')
        ?? devices[0];
      if (!target) {
        patchState({ lastError: { code: 'NO_DEVICE', message: 'Abra o Spotify em algum dispositivo', at: Date.now() } });
        return false;
      }
      await spotifyApi.play({ ...opts, deviceId: target.id });
      return true;
    }
    if (e instanceof spotifyApi.PlayerRestrictedError) {
      patchState({ lastError: { code: e.code, message: e.message, at: Date.now() } });
      return false;
    }
    throw e;
  }
}

/**
 * Executa a ação configurada para a faixa casada.
 * @param {{uri:string, id:string, name:string}} sp
 */
export async function act(sp, { tabId, videoId, currentTimeSec }) {
  const settings = await getSettings();
  const rt = getState();
  const trackKey = sp.id;
  const linkSync = async () => {
    await loopGuard.addExtPlayedTrack(trackKey);
    chrome.tabs.sendMessage(tabId, { type: MSG.SW_MUTE_VIDEO, payload: { muted: true } }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: MSG.SW_SET_ROLE, payload: { role: tabId === rt.spotyTabId ? 'spotytube' : 'linked', mode: 'sync', expectedVideoId: videoId } }).catch(() => {});
    patchState({ syncTarget: { tabId, videoId, trackKey, offsetMs: 0 }, suggestion: null, lastError: null });
    poller.start();
  };

  // §11 regra 5: Spotify já está tocando essa faixa
  if (rt.playback?.track?.uri === sp.uri && rt.playback.status === 'playing') {
    if (settings.ytAction === 'play-mute-video') await linkSync();
    return;
  }

  switch (settings.ytAction) {
    case 'queue': {
      try {
        await spotifyApi.addToQueue(sp.uri, rt.playback?.deviceId ?? undefined);
        patchState({ suggestion: null, lastError: null });
      } catch (e) {
        patchState({ lastError: { code: e.code || 'ERROR', message: e.message, at: Date.now() } });
      }
      return;
    }
    case 'play-pause-video': {
      await loopGuard.addExtPlayedTrack(trackKey);
      const positionMs = Math.round((currentTimeSec || 0) * 1000);
      if (await playWithDeviceFallback({ uris: [sp.uri], positionMs })) {
        chrome.tabs.sendMessage(tabId, { type: MSG.SW_PAUSE_VIDEO }).catch(() => {});
        patchState({ suggestion: null, lastError: null });
        poller.pokeNow('yt-to-sp');
      }
      return;
    }
    default: { // 'play-mute-video'
      await loopGuard.addExtPlayedTrack(trackKey);
      const positionMs = Math.round((currentTimeSec || 0) * 1000);
      if (await playWithDeviceFallback({ uris: [sp.uri], positionMs })) {
        await linkSync();
        poller.pokeNow('yt-to-sp');
      }
    }
  }
}

/** Pipeline disparado pelo controller após debounce (§11, §12). */
export async function handleManualVideo({ tabId, videoId, domTitle, domChannel, currentTimeSec, durationSec, receivedAt }) {
  try {
    let meta = null;
    try {
      meta = await getVideoMeta(videoId);
    } catch (e) {
      log.debug('watch meta falhou; usando DOM', e.message);
      meta = { videoId, title: domTitle || '', author: domChannel || '', channelId: null, lengthSec: Math.round(durationSec || 0), isLive: false, category: null };
    }
    if (!isLikelyMusic(meta)) {
      log.debug('não parece música', meta.title);
      return;
    }
    const parsed = parseVideoTitle(meta.title, meta.author);
    let best = null;
    for (const q of buildSpotifyQueries(parsed)) {
      const items = await spotifyApi.searchTracks(q);
      for (const it of items) {
        if (!it || it.is_local) continue;
        const s = scoreTrackMatch(it, parsed, meta.lengthSec);
        if (!best || s > best.score) best = { score: s, track: it };
      }
      if (best && best.score >= YT_MATCH_AUTOPLAY) break;
    }
    log.debug('YT->SP', parsed, best && { score: best.score, name: best.track.name });
    if (!best || best.score < YT_MATCH_SUGGEST) {
      patchState({ suggestion: null });
      return;
    }
    const sp = best.track;
    if (best.score < YT_MATCH_AUTOPLAY) {
      patchState({
        suggestion: {
          trackUri: sp.uri, trackId: sp.id, name: sp.name,
          artists: (sp.artists || []).map((a) => a.name).join(', '),
          score: best.score, sourceVideoId: videoId, tabId,
        },
      });
      return;
    }
    const t = await currentVideoTime(tabId, videoId, currentTimeSec, receivedAt);
    await act(sp, { tabId, videoId, currentTimeSec: t });
  } catch (e) {
    log.warn('YT->SP falhou', e);
    patchState({ lastError: { code: e.code || 'ERROR', message: e.message, at: Date.now() } });
  } finally {
    await loopGuard.setYtCooldown(videoId);
  }
}

/** Popup: "Tocar no Spotify?" */
export async function playSuggestion(trackUri) {
  const s = getState().suggestion;
  if (!s || s.trackUri !== trackUri) throw Object.assign(new Error('Sugestão expirou'), { code: 'NO_SUGGESTION' });
  let tabStillOnVideo = false;
  let t = 0;
  try {
    const res = await chrome.tabs.sendMessage(s.tabId, { type: MSG.SW_GET_STATUS });
    const st = res?.data ?? res;
    if (st && st.videoId === s.sourceVideoId) { tabStillOnVideo = true; t = st.currentTime || 0; }
  } catch { /* ignore */ }
  const sp = { uri: s.trackUri, id: s.trackId || s.trackUri.split(':').pop(), name: s.name };
  if (tabStillOnVideo) {
    await act(sp, { tabId: s.tabId, videoId: s.sourceVideoId, currentTimeSec: t });
  } else {
    await loopGuard.addExtPlayedTrack(sp.id);
    await playWithDeviceFallback({ uris: [sp.uri], positionMs: 0 });
    poller.pokeNow('suggestion');
  }
  patchState({ suggestion: null });
}
