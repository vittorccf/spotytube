// Orquestrador Spotify -> YouTube, modos, mensagens do content script (§7, §11).
import {
  SYNC_URL_LEAD_MS, YT_TO_SP_DEBOUNCE_MS, PREFETCH_REMAINING_MS, CLIP_OFFSET_STEP_MS,
} from '../shared/constants.js';
import { MSG } from '../shared/messages.js';
import { getSettings } from '../shared/settings.js';
import { log, setDebug } from '../shared/log.js';
import { getState, patchState } from './state.js';
import { projectedProgress } from './playback-tracker.js';
import * as spotifyApi from './spotify-api.js';
import * as clipFinder from './clip-finder.js';
import * as clipCache from './clip-cache.js';
import * as tabManager from './tab-manager.js';
import * as loopGuard from './loop-guard.js';
import * as poller from './poller.js';
import * as ytToSpotify from './yt-to-spotify.js';
import * as auth from './spotify-auth.js';

let generation = 0;
let lastTrack = null;          // Track do último TRACK_CHANGED (para nextCandidate/reopen)
let prefetchedFor = null;      // trackKey para o qual já houve prefetch (1 por faixa)

// YT->SP: por aba, o vídeo elegível (veio de navegação do usuário) e a geração (debounce)
const ytEligible = new Map();  // tabId -> {videoId, title, channel, durationSec}
const ytGen = new Map();       // tabId -> number

// ---------------------------------------------------------------- envio ao CS
export function sendToTab(tabId, type, payload) {
  if (tabId == null) return Promise.resolve(undefined);
  return chrome.tabs.sendMessage(tabId, payload === undefined ? { type } : { type, payload }).catch(() => undefined);
}

/** SW_SYNC para o syncTarget a partir do snapshot (heartbeat). */
export async function sendSync(snap) {
  const st = getState().syncTarget;
  if (!st) return;
  try {
    await chrome.tabs.get(st.tabId);
  } catch {
    patchState({ syncTarget: null });
    return;
  }
  if (!snap) return;
  const sameTrack = snap.track && snap.track.key === st.trackKey;
  // faixa diferente da do clipe (a busca do novo clipe ainda está rodando): não mexe no vídeo,
  // a menos que o Spotify tenha parado — aí pausa.
  if (!sameTrack && (snap.status === 'playing' || snap.status === 'paused')) return;
  await sendToTab(st.tabId, MSG.SW_SYNC, {
    videoId: st.videoId,
    isPlaying: sameTrack && snap.status === 'playing',
    progressMs: sameTrack ? snap.progressMs : 0,
    sampledAt: snap.sampledAt,
    offsetMs: st.offsetMs || 0,
  });
}

// ---------------------------------------------------------------- eventos do poller
export async function handleEvents(events, snap) {
  const settings = await getSettings();
  let rt = getState();
  let syncSent = false;
  for (const ev of events) {
    switch (ev.type) {
      case 'TRACK_CHANGED':
        lastTrack = ev.track;
        prefetchedFor = null;
        // não bloqueia o tick: a busca do clipe roda em paralelo
        onTrackChanged(ev.track, snap).catch((e) => log.error('onTrackChanged', e));
        break;
      case 'PLAY_STATE_CHANGED':
        rt = getState();
        if (settings.mode === 'handoff' && rt.handoff && snap.status === 'playing' && snap.track?.key === rt.handoff.trackKey) {
          // usuário retomou o Spotify: pausa o vídeo (evita áudio duplo), não re-pausa o Spotify
          sendToTab(rt.spotyTabId, MSG.SW_PAUSE_VIDEO);
          patchState({ handoff: null });
        }
        break;
      case 'STOPPED':
      case 'UNSUPPORTED':
        if (getState().syncTarget) {
          const st = getState().syncTarget;
          await sendToTab(st.tabId, MSG.SW_SYNC, { videoId: st.videoId, isPlaying: false, progressMs: 0, sampledAt: snap.sampledAt, offsetMs: st.offsetMs || 0 });
          syncSent = true;
        }
        break;
      default:
        break; // SEEKED / TRACK_RESTARTED: cobertos pelo sendSync abaixo (CS seeka por drift)
    }
  }
  if (lastTrack === null && snap.track) lastTrack = snap.track;
  rt = getState();
  if (!syncSent && rt.syncTarget && (snap.status === 'playing' || snap.status === 'paused')) {
    await sendSync(snap);
  }
  maybePrefetch(snap).catch(() => {});
}

// ---------------------------------------------------------------- Spotify -> YouTube
export async function onTrackChanged(track, snap) {
  const gen = ++generation;
  const settings = await getSettings();
  if (!settings.enabled || !settings.spotifyToYoutube) return;
  if (await loopGuard.isExtPlayedTrack(track.key)) {
    log.debug('faixa tocada pela extensão (YT->SP); não abre clipe');
    return;
  }
  const rt = getState();
  if (rt.syncTarget && rt.syncTarget.trackKey !== track.key && rt.syncTarget.tabId !== rt.spotyTabId) {
    sendToTab(rt.syncTarget.tabId, MSG.SW_STOP_SYNC);
    patchState({ syncTarget: null });
  }
  const clip = await clipFinder.findClip(track);
  if (gen !== generation) return; // pulos rápidos: resultado obsoleto
  await openClip(track, clip, getState().playback, gen);
}

/**
 * Abre o clipe conforme o modo. `snap` deve ser o mais recente.
 * @param {import('./clip-finder.js').ClipResult} clip
 */
export async function openClip(track, clip, snap, gen = generation) {
  const settings = await getSettings();
  const mode = settings.mode;
  const rt = getState();
  const entry = clip.entry;
  const videoId = clip.videoId;
  const offsetMs = entry?.offsetMs ?? 0;
  const sameTrackSnap = snap && snap.track && snap.track.key === track.key ? snap : null;
  const posMs = projectedProgress(sameTrackSnap);
  const isPlaying = sameTrackSnap?.status === 'playing';
  const candidate = clip.candidate || entry?.candidates?.find((c) => c.videoId === videoId) || null;
  const currentClip = {
    trackKey: track.key,
    videoId,
    title: candidate?.title ?? (videoId ? '' : 'Busca no YouTube'),
    channel: candidate?.channel ?? '',
    source: entry?.source ?? 'search-fallback',
    candidateIndex: entry?.chosenIndex ?? 0,
    candidateCount: entry?.candidates?.length ?? 0,
    score: candidate?.score ?? null,
    offsetMs,
    searchUrl: clip.searchUrl,
  };

  // mesmo clipe já aberto na aba (ex.: outra versão da mesma música): não recarrega
  if (videoId && videoId === rt.spotyTabExpectedVideoId && (await tabManager.getSpotyTab())) {
    const tabId = getState().spotyTabId;
    patchState({
      currentClip,
      syncTarget: mode === 'sync' ? { tabId, videoId, trackKey: track.key, offsetMs } : getState().syncTarget?.tabId === tabId ? null : getState().syncTarget,
    });
    if (mode === 'sync') await sendSync(getState().playback);
    return;
  }

  let url;
  let handoff = null;
  if (!videoId) {
    url = clip.searchUrl;
  } else if (mode === 'sync') {
    url = tabManager.buildWatchUrl(videoId, (posMs + offsetMs + (isPlaying ? SYNC_URL_LEAD_MS : 0)) / 1000);
  } else if (mode === 'handoff') {
    if (isPlaying) {
      try {
        await spotifyApi.pause();
      } catch (e) {
        log.warn('handoff: pause falhou', e.message);
        patchState({ lastError: { code: e.code || 'ERROR', message: e.message, at: Date.now() } });
      }
    }
    url = tabManager.buildWatchUrl(videoId, posMs / 1000);
    handoff = { trackKey: track.key, at: Date.now() };
  } else {
    url = tabManager.buildWatchUrl(videoId, 0);
  }

  if (videoId) await loopGuard.addExtVideo(videoId);
  // se a aba atual era syncTarget, ela vai recarregar; o novo syncTarget é definido abaixo
  const tab = await tabManager.navigate(url, { expectedVideoId: videoId, role: videoId ? mode : null });
  if (!tab) return; // navegação substituída por uma mais nova (latest wins)
  if (gen !== generation) return;
  const prevSync = getState().syncTarget;
  patchState({
    currentClip,
    syncTarget: mode === 'sync' && videoId
      ? { tabId: tab.id, videoId, trackKey: track.key, offsetMs }
      : (prevSync && prevSync.tabId === tab.id ? null : prevSync),
    handoff,
  });
}

/** Próximo candidato (popup / comando) (§8.8). */
export async function nextCandidate() {
  const rt = getState();
  const cc = rt.currentClip;
  if (!cc) throw Object.assign(new Error('Nenhum clipe aberto'), { code: 'NO_CLIP' });
  const track = trackForKey(cc.trackKey);
  if (!track) throw Object.assign(new Error('Faixa atual desconhecida'), { code: 'NO_TRACK' });
  const gen = generation;
  let entry = await clipCache.get(cc.trackKey);
  if (cc.videoId) entry = (await clipCache.markRejected(cc.trackKey, cc.videoId)) || entry;
  let clip = null;
  if (entry) {
    const start = cc.videoId ? entry.chosenIndex + 1 : 0;
    for (let i = start; i < entry.candidates.length; i++) {
      const c = entry.candidates[i];
      if (!entry.rejected.includes(c.videoId)) {
        const updated = await clipCache.setChosen(cc.trackKey, i);
        clip = { videoId: c.videoId, searchUrl: clipFinder.searchUrlFor(entry.query), entry: updated, fromCache: true, candidate: c };
        break;
      }
    }
  }
  if (!clip) {
    // esgotou: nova busca excluindo rejeitados
    const res = await clipFinder.findClip(track, { force: true, excludeVideoIds: entry?.rejected ?? [] });
    clip = res;
    if (!res.videoId && res.entry.candidates.length) {
      const updated = await clipCache.setChosen(track.key, 0);
      clip = { ...res, videoId: updated.videoId, entry: updated, candidate: updated.candidates[0] };
    }
  }
  if (gen !== generation) return;
  await openClip(track, clip, getState().playback, gen);
}

/** Reabre o clipe da faixa atual (ou abre se a aba foi fechada). */
export async function reopenClip() {
  const rt = getState();
  const track = (rt.playback?.track) || trackForKey(rt.currentClip?.trackKey);
  if (!track) throw Object.assign(new Error('Nada tocando no Spotify'), { code: 'NO_TRACK' });
  const gen = ++generation;
  lastTrack = track;
  const clip = await clipFinder.findClip(track);
  if (gen !== generation) return;
  // força navegação mesmo se for o mesmo vídeo
  patchState({ spotyTabExpectedVideoId: null });
  await openClip(track, clip, getState().playback, gen);
}

/** Abre a página de busca do YouTube da faixa atual na aba SpotyTube. */
export async function openYtSearch() {
  const rt = getState();
  const track = rt.playback?.track || trackForKey(rt.currentClip?.trackKey);
  if (!track) throw Object.assign(new Error('Nada tocando no Spotify'), { code: 'NO_TRACK' });
  const entry = await clipCache.get(track.key);
  const url = entry ? clipFinder.searchUrlFor(entry.query) : clipFinder.searchUrlFor(`${track.artists[0] ?? ''} ${track.name}`);
  const prevSync = getState().syncTarget;
  const tab = await tabManager.navigate(url, { expectedVideoId: null, role: null });
  if (tab && prevSync?.tabId === tab.id) patchState({ syncTarget: null });
}

function trackForKey(key) {
  if (!key) return null;
  const rt = getState();
  if (rt.playback?.track?.key === key) return rt.playback.track;
  if (lastTrack?.key === key) return lastTrack;
  return null;
}

/** Ajuste fino de sync ±1 s persistido no ClipEntry (fase 4). */
export async function setClipOffset(deltaMs) {
  const rt = getState();
  const cc = rt.currentClip;
  if (!cc) throw Object.assign(new Error('Nenhum clipe aberto'), { code: 'NO_CLIP' });
  const delta = Math.max(-CLIP_OFFSET_STEP_MS, Math.min(CLIP_OFFSET_STEP_MS, Number(deltaMs) || 0));
  const offsetMs = (cc.offsetMs || 0) + delta;
  await clipCache.setOffset(cc.trackKey, offsetMs);
  const patch = { currentClip: { ...cc, offsetMs } };
  if (rt.syncTarget && rt.syncTarget.trackKey === cc.trackKey) patch.syncTarget = { ...rt.syncTarget, offsetMs };
  patchState(patch);
  await sendSync(getState().playback);
  return { offsetMs };
}

// ---------------------------------------------------------------- prefetch (fase 4)
async function maybePrefetch(snap) {
  if (snap.status !== 'playing' || !snap.track) return;
  const remaining = snap.track.durationMs - snap.progressMs;
  if (remaining > PREFETCH_REMAINING_MS || prefetchedFor === snap.track.key) return;
  prefetchedFor = snap.track.key;
  const settings = await getSettings();
  if (!settings.spotifyToYoutube) return;
  const queue = await spotifyApi.getQueue();
  const next = queue[0];
  if (!next) return;
  log.debug('prefetch', next.name);
  await clipFinder.findClip(next); // só popula o cache
}

// ---------------------------------------------------------------- settings
export async function onSettingsChanged(prev, next) {
  setDebug(next.debug);
  if (prev.enabled !== next.enabled) {
    if (!next.enabled) {
      const rt = getState();
      if (rt.syncTarget) sendToTab(rt.syncTarget.tabId, MSG.SW_STOP_SYNC);
      patchState({ syncTarget: null, handoff: null });
      await poller.stop();
    } else {
      poller.start();
    }
    return;
  }
  if (prev.clientId !== next.clientId) {
    // o token pertence ao app antigo (e à cota dele): descarta e exige novo login
    await auth.logout();
    return;
  }
  if (prev.spotifyToYoutube !== next.spotifyToYoutube) {
    await poller.ensureRunning();
    if (next.spotifyToYoutube && !prev.spotifyToYoutube) poller.pokeNow('settings');
  }
  if (prev.mode !== next.mode && prev.mode === 'handoff') patchState({ handoff: null });
}

// ---------------------------------------------------------------- content script (§10, §11)
function roleFor(tabId, videoId) {
  const rt = getState();
  if (rt.syncTarget && rt.syncTarget.tabId === tabId && rt.syncTarget.videoId === videoId) {
    return { role: tabId === rt.spotyTabId ? 'spotytube' : 'linked', mode: 'sync', expectedVideoId: videoId };
  }
  if (tabId === rt.spotyTabId && videoId && videoId === rt.spotyTabExpectedVideoId) {
    return { role: 'spotytube', mode: rt.spotyTabMode || 'open', expectedVideoId: videoId };
  }
  return { role: 'normal', mode: null, expectedVideoId: null };
}

function scheduleSyncPush(tabId) {
  setTimeout(() => {
    const st = getState().syncTarget;
    if (st && st.tabId === tabId) sendSync(getState().playback).catch(() => {});
  }, 50);
}

export async function onContentMessage(msg, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return undefined;
  const p = msg.payload || {};
  switch (msg.type) {
    case MSG.CS_HELLO: {
      const rt = getState();
      if (tabId === rt.spotyTabId && p.videoId && p.videoId !== rt.spotyTabExpectedVideoId && (await loopGuard.isExtVideo(p.videoId))) {
        // vídeo aberto por nós, mas a aba recarregou: trata como nosso
        patchState({ spotyTabExpectedVideoId: p.videoId });
      }
      const role = roleFor(tabId, p.videoId);
      if (role.role !== 'normal' && role.mode === 'sync') scheduleSyncPush(tabId);
      return role;
    }
    case MSG.CS_VIDEO_CHANGED:
      return onVideoChanged(tabId, p);
    case MSG.CS_PLAYER_EVENT:
      return onPlayerEvent(tabId, p);
    default:
      return undefined;
  }
}

async function onVideoChanged(tabId, p) {
  ytGen.set(tabId, (ytGen.get(tabId) || 0) + 1); // cancela YT->SP pendente desta aba
  ytEligible.delete(tabId);
  const rt = getState();
  const videoId = p.videoId || null;

  if (tabId === rt.spotyTabId) {
    if (!videoId) {
      if (rt.syncTarget?.tabId === tabId) patchState({ syncTarget: null });
      return { role: 'normal', mode: null, expectedVideoId: null };
    }
    if (videoId === rt.spotyTabExpectedVideoId || (await loopGuard.isExtVideo(videoId))) {
      if (videoId !== rt.spotyTabExpectedVideoId) patchState({ spotyTabExpectedVideoId: videoId });
      const role = roleFor(tabId, videoId);
      const out = role.role === 'normal' ? { role: 'spotytube', mode: rt.spotyTabMode || 'open', expectedVideoId: videoId } : role;
      if (out.mode === 'sync') scheduleSyncPush(tabId);
      return out;
    }
    if (!p.userInitiated) {
      // autoplay / fim de vídeo / navegação sem gesto: ignora; mantém syncTarget no vídeo antigo
      return { role: 'spotytube', mode: rt.spotyTabMode || 'open', expectedVideoId: rt.spotyTabExpectedVideoId };
    }
    // navegação manual dentro da aba SpotyTube: deixa de seguir; segue para YT->SP
    const patch = { spotyTabExpectedVideoId: null };
    if (rt.syncTarget?.tabId === tabId) patch.syncTarget = null;
    if (rt.handoff) patch.handoff = null;
    patchState(patch);
    ytEligible.set(tabId, { videoId, title: p.title, channel: p.channel, durationSec: p.durationSec, spotyTab: true });
    return { role: 'normal', mode: null, expectedVideoId: null };
  }

  // outras abas
  if (rt.syncTarget?.tabId === tabId) {
    if (videoId && videoId === rt.syncTarget.videoId) return roleFor(tabId, videoId);
    patchState({ syncTarget: null }); // usuário saiu do vídeo vinculado
  }
  if (videoId) ytEligible.set(tabId, { videoId, title: p.title, channel: p.channel, durationSec: p.durationSec, spotyTab: false });
  return { role: 'normal', mode: null, expectedVideoId: null };
}

async function onPlayerEvent(tabId, p) {
  const rt = getState();
  switch (p.event) {
    case 'autoplay-blocked':
      if (tabId === rt.spotyTabId) {
        patchState({ lastError: { code: 'AUTOPLAY_BLOCKED', message: 'Clique na aba do YouTube para tocar', at: Date.now() } });
      }
      return undefined;
    case 'playing':
      if (rt.lastError?.code === 'AUTOPLAY_BLOCKED' && tabId === rt.spotyTabId) patchState({ lastError: null });
      if (p.visible) await maybeStartYtToSpotify(tabId, p);
      return undefined;
    default:
      log.debug('CS event', tabId, p.event, p.videoId);
      return undefined;
  }
}

async function maybeStartYtToSpotify(tabId, p) {
  const el = ytEligible.get(tabId);
  if (!el || el.videoId !== p.videoId) return;
  const settings = await getSettings();
  if (!settings.enabled || !settings.youtubeToSpotify) return;
  const rt = getState();
  if (tabId === rt.spotyTabId && settings.mode === 'handoff') return; // §11 regra 6
  if (await loopGuard.isExtVideo(p.videoId)) return;
  if (await loopGuard.inYtCooldown(p.videoId)) return;
  ytEligible.delete(tabId);
  const gen = ytGen.get(tabId) || 0;
  setTimeout(() => {
    if ((ytGen.get(tabId) || 0) !== gen) return; // outro vídeo nesta aba durante o debounce
    ytToSpotify.handleManualVideo({
      tabId,
      videoId: p.videoId,
      domTitle: el.title,
      domChannel: el.channel,
      currentTimeSec: p.currentTime,
      durationSec: el.durationSec,
      receivedAt: Date.now() - YT_TO_SP_DEBOUNCE_MS,
    }).catch((e) => log.error('YT->SP', e));
  }, YT_TO_SP_DEBOUNCE_MS);
}
