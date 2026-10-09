// Spotify Web API (§5). toSnapshot é PURO.
import { SPOTIFY_API_BASE, FETCH_TIMEOUT_MS, SPOTIFY_SEARCH_LIMIT, SK_RATE_LIMIT } from '../shared/constants.js';
import { normalize } from '../shared/text-normalize.js';
import { getSettings } from '../shared/settings.js';
import { getAccessToken, handleRevoked, AuthError } from './spotify-auth.js';

// ---- erros (code string usado na UI) ----
export class SpotifyApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'SpotifyApiError';
    this.code = code;
    this.status = status;
  }
}
export class NetworkError extends Error {
  constructor(message = 'Falha de rede') {
    super(message);
    this.name = 'NetworkError';
    this.code = 'NETWORK';
  }
}
export class ServerError extends Error {
  constructor(status, message) {
    super(message || `Erro no servidor do Spotify (${status})`);
    this.name = 'ServerError';
    this.code = 'SERVER';
    this.status = status;
  }
}
/** PURO: 14676000 -> "4 h 5 min"; 42000 -> "42 s". */
export function formatWait(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super(`Limite de requisições do Spotify atingido (429) — aguarde ${formatWait(retryAfterMs)} para a extensão voltar a funcionar`);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMIT';
    this.retryAfterMs = retryAfterMs;
  }
}
export class NoDeviceError extends Error {
  constructor(message = 'Nenhum dispositivo Spotify ativo — abra o Spotify em algum dispositivo') {
    super(message);
    this.name = 'NoDeviceError';
    this.code = 'NO_DEVICE';
  }
}
export class PlayerRestrictedError extends Error {
  constructor(reason, message) {
    super(message || (reason === 'PREMIUM_REQUIRED'
      ? 'Controlar o player exige Spotify Premium'
      : `Ação do player não permitida pelo Spotify (${reason || '403'})`));
    this.name = 'PlayerRestrictedError';
    this.code = 'PLAYER_RESTRICTED';
    this.reason = reason || null;
  }
}

function buildUrl(path, query) {
  const url = new URL(SPOTIFY_API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Bloqueio após 429: persiste em storage.local (sobrevive a restart do SW/navegador e a
// login/logout) e barra TODA chamada à API até expirar — insistir durante o bloqueio prolonga a punição.
// A cota é por app do Spotify, então o bloqueio vale só para o Client ID que o recebeu.
let rateLimit = null; // { until, clientId }

async function readRateLimit() {
  if (rateLimit === null) {
    const { [SK_RATE_LIMIT]: stored } = await chrome.storage.local.get(SK_RATE_LIMIT);
    rateLimit = stored && typeof stored === 'object' ? stored : { until: 0, clientId: null };
  }
  return rateLimit;
}

async function setRateLimit(until, clientId) {
  rateLimit = { until, clientId };
  await chrome.storage.local.set({ [SK_RATE_LIMIT]: rateLimit });
}

/** ms restantes de bloqueio por 429 para o Client ID atual (0 = liberado). */
export async function rateLimitRemaining() {
  const [{ until, clientId }, { clientId: current }] = await Promise.all([readRateLimit(), getSettings()]);
  if (clientId !== current) return 0;
  return Math.max(0, until - Date.now());
}

/**
 * Fetch autenticado com tratamento de 401/403/404/429/5xx.
 * @returns {Promise<{status:number, data:any, headers:Headers}>}
 */
export async function spotifyFetch(path, { method = 'GET', query, body, retryOn401 = true } = {}) {
  const blocked = await rateLimitRemaining();
  if (blocked > 0) throw new RateLimitError(blocked);
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new NetworkError(`Falha de rede ao falar com o Spotify: ${e?.name || ''} ${e?.message || e}`.trim());
  }

  let data = null;
  const text = res.status === 204 ? '' : await res.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (res.status === 401) {
    if (retryOn401) {
      await getAccessToken({ forceRefresh: true });
      return spotifyFetch(path, { method, query, body, retryOn401: false });
    }
    await handleRevoked();
    throw new AuthError('REVOKED');
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After'));
    const waitMs = (Number.isFinite(ra) && ra > 0 ? ra : 5) * 1000;
    await setRateLimit(Date.now() + waitMs, (await getSettings()).clientId);
    throw new RateLimitError(waitMs);
  }
  if (res.status >= 500) throw new ServerError(res.status);
  const reason = data?.error?.reason;
  if (res.status === 404 && (reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(data?.error?.message || ''))) {
    throw new NoDeviceError();
  }
  if (res.status === 403) throw new PlayerRestrictedError(reason, data?.error?.message ? `Spotify: ${data.error.message}` : undefined);
  if (res.status >= 400) {
    throw new SpotifyApiError(`HTTP_${res.status}`, `Spotify respondeu ${res.status}${data?.error?.message ? ': ' + data.error.message : ''}`, res.status);
  }
  return { status: res.status, data, headers: res.headers };
}

/** Escolhe a menor imagem com largura >= 64 px. */
function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const ok = images.filter((i) => (i.width ?? 0) >= 64).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (ok[0] || images[0])?.url ?? null;
}

/** item de track do Spotify -> Track (PURO). */
export function toTrack(item) {
  const artists = (item.artists || []).map((a) => a.name).filter(Boolean);
  return {
    key: item.id ?? ('local:' + normalize(artists.join(',') + '|' + item.name)),
    id: item.id ?? null,
    uri: item.uri ?? '',
    name: item.name ?? '',
    artists,
    album: item.album?.name ?? '',
    durationMs: item.duration_ms ?? 0,
    isLocal: item.is_local === true,
    imageUrl: pickImage(item.album?.images),
  };
}

/**
 * Resposta de GET /me/player -> PlaybackSnapshot (PURO).
 * @returns {import('../shared/messages.js').PlaybackSnapshot}
 */
export function toSnapshot(json, sampledAt) {
  const base = {
    status: 'no_device', track: null, progressMs: 0, sampledAt,
    deviceId: json?.device?.id ?? null, deviceName: json?.device?.name ?? null,
    repeatState: json?.repeat_state ?? 'off',
  };
  if (!json) return base;
  const type = json.currently_playing_type;
  if (['ad', 'episode', 'unknown'].includes(type) || json.item == null || json.item.type !== 'track') {
    return { ...base, status: 'unsupported' };
  }
  return {
    ...base,
    status: json.is_playing ? 'playing' : 'paused',
    track: toTrack(json.item),
    progressMs: json.progress_ms ?? 0,
  };
}

export async function getPlayer() {
  const { status, data } = await spotifyFetch('/me/player', { query: { additional_types: 'episode' } });
  const sampledAt = Date.now();
  return toSnapshot(status === 204 ? null : data, sampledAt);
}

export async function play({ uris, positionMs, deviceId } = {}) {
  const body = {};
  if (uris) body.uris = uris;
  if (positionMs != null) body.position_ms = Math.max(0, Math.round(positionMs));
  await spotifyFetch('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body });
}

export async function pause({ deviceId } = {}) {
  await spotifyFetch('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } });
}

/** @returns {Promise<Array<{id:string,is_active:boolean,is_restricted:boolean,name:string,type:string}>>} */
export async function getDevices() {
  const { data } = await spotifyFetch('/me/player/devices');
  return data?.devices ?? [];
}

export async function searchTracks(q, limit = SPOTIFY_SEARCH_LIMIT) {
  const { data } = await spotifyFetch('/search', { query: { type: 'track', q, limit: Math.min(limit, 10) } });
  return data?.tracks?.items ?? [];
}

export async function addToQueue(uri, deviceId) {
  await spotifyFetch('/me/player/queue', { method: 'POST', query: { uri, device_id: deviceId } });
}

/** Fila do usuário (prefetch, fase 4). */
export async function getQueue() {
  const { data } = await spotifyFetch('/me/player/queue');
  return (data?.queue ?? []).filter((i) => i && i.type === 'track').map(toTrack);
}
