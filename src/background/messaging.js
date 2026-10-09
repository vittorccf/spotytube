// Router de chrome.runtime.onMessage + broadcastState (§13).
import { MSG, ok, err } from '../shared/messages.js';
import { getSettings, setSettings } from '../shared/settings.js';
import { BROADCAST_THROTTLE_MS, POPUP_POKE_STALE_MS, SK_PARSER_HEALTH, PARSER_WARN_FAILS } from '../shared/constants.js';
import { log } from '../shared/log.js';
import { getState, patchState, subscribe } from './state.js';
import * as auth from './spotify-auth.js';
import * as spotifyApi from './spotify-api.js';
import * as poller from './poller.js';
import * as controller from './controller.js';
import * as clipCache from './clip-cache.js';
import * as tabManager from './tab-manager.js';
import * as ytToSpotify from './yt-to-spotify.js';
import { testApiKey } from './youtube-data-api.js';
import { setBadge, badgeFor } from './badge.js';

let wake = async () => {};

/** Recebe a função de boot do service-worker (evita import circular). */
export function init({ boot }) {
  wake = boot;
  subscribe(() => {
    scheduleBroadcast();
  });
}

/** Listener único de chrome.runtime.onMessage. */
export function onMessage(msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === MSG.STATE_UPDATED) return false; // broadcast nosso
  route(msg, sender).then(
    (data) => sendResponse(ok(data)),
    (e) => {
      log.debug('route erro', msg.type, e);
      sendResponse(err(e));
    },
  );
  return true;
}

/** UiState (§13.4). */
export async function buildUiState() {
  const settings = await getSettings();
  const a = await auth.getAuth();
  const rt = getState();
  const { [SK_PARSER_HEALTH]: ph } = await chrome.storage.local.get(SK_PARSER_HEALTH);
  const { ytApiKey, ...pub } = settings;
  let status = rt.status;
  if (!settings.clientId) status = 'needs_setup';
  else if (!a) status = 'logged_out';
  else if (!settings.enabled) status = 'disabled';
  const pb = rt.playback;
  const cc = rt.currentClip;
  return {
    status,
    loggedIn: !!a,
    needsSetup: !settings.clientId,
    settings: { ...pub, hasYtApiKey: !!ytApiKey },
    playback: pb ? {
      status: pb.status,
      trackName: pb.track?.name ?? null,
      artists: pb.track?.artists?.join(', ') ?? '',
      albumImage: pb.track?.imageUrl ?? null,
      progressMs: pb.progressMs,
      sampledAt: pb.sampledAt,
      durationMs: pb.track?.durationMs ?? 0,
      deviceName: pb.deviceName,
    } : null,
    clip: cc ? {
      videoId: cc.videoId,
      title: cc.title,
      channel: cc.channel,
      thumbnail: cc.videoId ? `https://i.ytimg.com/vi/${cc.videoId}/mqdefault.jpg` : null,
      source: cc.source,
      candidateIndex: cc.candidateIndex,
      candidateCount: cc.candidateCount,
      score: cc.score,
      offsetMs: cc.offsetMs || 0,
    } : null,
    suggestion: rt.suggestion,
    lastError: rt.lastError,
    parserWarning: (ph?.consecutiveFails ?? 0) >= PARSER_WARN_FAILS,
    spotyTabOpen: rt.spotyTabId != null,
    syncing: !!rt.syncTarget,
  };
}

let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastState().catch(() => {});
  }, BROADCAST_THROTTLE_MS);
}

/** Envia STATE_UPDATED (sem receptor = erro esperado) e atualiza o badge. */
export async function broadcastState() {
  const ui = await buildUiState();
  const settings = await getSettings();
  setBadge(badgeFor(getState(), settings, ui.loggedIn));
  chrome.runtime.sendMessage({ type: MSG.STATE_UPDATED, payload: ui }).catch(() => {});
}

async function route(msg, sender) {
  await wake(msg.type);
  const p = msg.payload || {};
  // mensagens do content script
  if (sender?.tab && msg.type.startsWith('CS_')) {
    return controller.onContentMessage(msg, sender);
  }
  switch (msg.type) {
    case MSG.GET_STATE: {
      const rt = getState();
      if (Date.now() - (rt.lastPollAt || 0) > POPUP_POKE_STALE_MS) {
        const s = await getSettings();
        if (poller.shouldRun(s, await auth.getAuth(), rt)) poller.pokeNow('popup');
      }
      return buildUiState();
    }
    case MSG.LOGIN:
      await auth.login();
      return buildUiState();
    case MSG.LOGOUT:
      await auth.logout();
      return undefined;
    case MSG.SET_SETTINGS: {
      const allowed = ['clientId', 'enabled', 'spotifyToYoutube', 'youtubeToSpotify', 'mode', 'ytAction', 'focusTab', 'pinTab', 'ytApiKey', 'preferredDeviceId', 'debug'];
      const partial = Object.fromEntries(Object.entries(p).filter(([k]) => allowed.includes(k)));
      if ('clientId' in partial && partial.clientId && !/^[0-9a-f]{32}$/i.test(String(partial.clientId).trim())) {
        throw Object.assign(new Error('Client ID inválido (32 caracteres hexadecimais)'), { code: 'BAD_CLIENT_ID' });
      }
      const next = await setSettings(partial);
      const { ytApiKey, ...pub } = next;
      return { ...pub, hasYtApiKey: !!ytApiKey };
    }
    case MSG.NEXT_CANDIDATE:
      await controller.nextCandidate();
      return buildUiState();
    case MSG.REOPEN_CLIP:
      await controller.reopenClip();
      return undefined;
    case MSG.OPEN_YT_SEARCH:
      await controller.openYtSearch();
      return undefined;
    case MSG.FOCUS_SPOTY_TAB:
      if (!(await tabManager.focusSpotyTab())) await controller.reopenClip();
      if (getState().lastError?.code === 'AUTOPLAY_BLOCKED') patchState({ lastError: null });
      return undefined;
    case MSG.PLAY_SUGGESTION:
      await ytToSpotify.playSuggestion(p.trackUri);
      return undefined;
    case MSG.SET_CLIP_OFFSET:
      return controller.setClipOffset(p.deltaMs);
    case MSG.CLEAR_CACHE:
      return { removed: await clipCache.clear() };
    case MSG.GET_CACHE_STATS:
      return { count: await clipCache.count() };
    case MSG.TEST_YT_API_KEY: {
      const key = String(p.key || '').trim();
      if (!key) return { valid: false, message: 'Informe uma API key' };
      const granted = await chrome.permissions.contains({ origins: ['https://www.googleapis.com/*'] });
      if (!granted) return { valid: false, message: 'Permissão para googleapis.com não concedida' };
      return testApiKey(key);
    }
    case MSG.GET_DEVICES:
      return spotifyApi.getDevices();
    case MSG.GET_REDIRECT_URI:
      return { uri: auth.getRedirectUri() };
    default:
      throw Object.assign(new Error(`Mensagem desconhecida: ${msg.type}`), { code: 'UNKNOWN_MESSAGE' });
  }
}
