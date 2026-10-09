// Tipos de mensagem, envelope e typedefs compartilhados (§1.1, §13).

/** @typedef {'sync'|'handoff'|'open'} ClipMode */
/** @typedef {'play-mute-video'|'play-pause-video'|'queue'} YtToSpotifyAction */

/** Faixa normalizada a partir do item do Spotify
 * @typedef {Object} Track
 * @property {string} key
 * @property {string|null} id
 * @property {string} uri
 * @property {string} name
 * @property {string[]} artists
 * @property {string} album
 * @property {number} durationMs
 * @property {boolean} isLocal
 * @property {string|null} imageUrl
 */

/** @typedef {Object} PlaybackSnapshot
 * @property {'playing'|'paused'|'no_device'|'unsupported'} status
 * @property {Track|null} track
 * @property {number} progressMs
 * @property {number} sampledAt
 * @property {string|null} deviceId
 * @property {string|null} deviceName
 * @property {'off'|'track'|'context'} repeatState
 */

/** @typedef {Object} Candidate
 * @property {string} videoId
 * @property {string} title
 * @property {string} channel
 * @property {string|null} channelUrl
 * @property {number|null} durationSec
 * @property {number|null} views
 * @property {'oac'|'verified'|null} badge
 * @property {boolean} isLive
 * @property {number} position
 * @property {number} [score]
 * @property {string[]} [reasons]
 */

/** @typedef {Object} ClipEntry
 * @property {string} trackKey
 * @property {string|null} videoId
 * @property {Candidate[]} candidates
 * @property {number} chosenIndex
 * @property {string[]} rejected
 * @property {string} query
 * @property {'scrape'|'data-api'|'search-fallback'} source
 * @property {number} offsetMs
 * @property {number} cachedAt
 * @property {number} lastUsedAt
 */

export const MSG = Object.freeze({
  // Popup/Options -> SW
  GET_STATE: 'GET_STATE',
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  SET_SETTINGS: 'SET_SETTINGS',
  NEXT_CANDIDATE: 'NEXT_CANDIDATE',
  REOPEN_CLIP: 'REOPEN_CLIP',
  OPEN_YT_SEARCH: 'OPEN_YT_SEARCH',
  FOCUS_SPOTY_TAB: 'FOCUS_SPOTY_TAB',
  PLAY_SUGGESTION: 'PLAY_SUGGESTION',
  SET_CLIP_OFFSET: 'SET_CLIP_OFFSET',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_CACHE_STATS: 'GET_CACHE_STATS',
  TEST_YT_API_KEY: 'TEST_YT_API_KEY',
  GET_DEVICES: 'GET_DEVICES',
  GET_REDIRECT_URI: 'GET_REDIRECT_URI',
  // SW -> Popup/Options
  STATE_UPDATED: 'STATE_UPDATED',
  // CS <-> SW
  CS_HELLO: 'CS_HELLO',
  CS_VIDEO_CHANGED: 'CS_VIDEO_CHANGED',
  CS_PLAYER_EVENT: 'CS_PLAYER_EVENT',
  SW_SET_ROLE: 'SW_SET_ROLE',
  SW_SYNC: 'SW_SYNC',
  SW_STOP_SYNC: 'SW_STOP_SYNC',
  SW_PLAY_VIDEO: 'SW_PLAY_VIDEO',
  SW_PAUSE_VIDEO: 'SW_PAUSE_VIDEO',
  SW_MUTE_VIDEO: 'SW_MUTE_VIDEO',
  SW_GET_STATUS: 'SW_GET_STATUS',
});

/** Resposta de sucesso. */
export function ok(data) {
  return data === undefined ? { ok: true } : { ok: true, data };
}

/** Resposta de erro a partir de Error/qualquer coisa. */
export function err(e) {
  const code = (e && e.code) || (e && e.name) || 'ERROR';
  const message = (e && e.message) || String(e);
  return { ok: false, error: { code, message } };
}

/** Erro lançado no lado do cliente quando a resposta é ok:false. */
export class MessageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessageError';
    this.code = code;
  }
}

/** Envia mensagem ao SW (popup/options). Lança MessageError se ok:false. */
export async function sendMessage(type, payload) {
  const res = await chrome.runtime.sendMessage(payload === undefined ? { type } : { type, payload });
  if (!res) throw new MessageError('NO_RESPONSE', 'Sem resposta do service worker');
  if (!res.ok) throw new MessageError(res.error?.code || 'ERROR', res.error?.message || 'Erro');
  return res.data;
}
