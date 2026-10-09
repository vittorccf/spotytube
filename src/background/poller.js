// Loop de polling adaptativo + keep-alive + watchdog alarm (§6).
import {
  POLL_PLAYING_MS, POLL_NEAR_END_GRACE_MS, POLL_MIN_MS, POLL_PAUSED_MS, POLL_NO_DEVICE_MS,
  POLL_MAX_LOOP_MS, IDLE_AFTER_MS, WATCHDOG_ALARM, WATCHDOG_PERIOD_MIN, BACKOFF_BASE_MS,
  BACKOFF_MAX_MS, ERROR_STATUS_AFTER,
} from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { log } from '../shared/log.js';
import { getState, patchState, loadState, persistNow } from './state.js';
import { diffPlayback } from './playback-tracker.js';
import { getAuth, AuthError } from './spotify-auth.js';
import * as spotifyApi from './spotify-api.js';
import * as controller from './controller.js';

/** Sentinela de computeNextDelay: entrar em modo idle (só o alarm acorda). */
export const IDLE = -1;

let timer = null;
let inFlight = false;
/** @type {'fast'|'idle'} */
let loopMode = 'fast';

/** PURO */
export function shouldRun(settings, auth, rt) {
  return !!(settings?.enabled && settings?.clientId && auth && (settings.spotifyToYoutube || rt?.syncTarget || rt?.handoff));
}

/** PURO (§6.3) — ms até o próximo tick, ou IDLE. */
export function computeNextDelay(snap, rt, now) {
  const idleish = now - (rt?.lastPlayingAt || 0) > IDLE_AFTER_MS;
  switch (snap?.status) {
    case 'playing': {
      const remaining = (snap.track?.durationMs || 0) - snap.progressMs;
      if (snap.track && remaining <= POLL_PLAYING_MS) return Math.max(remaining + POLL_NEAR_END_GRACE_MS, POLL_MIN_MS);
      return POLL_PLAYING_MS;
    }
    case 'paused':
      return idleish ? IDLE : POLL_PAUSED_MS;
    default:
      return idleish ? IDLE : POLL_NO_DEVICE_MS;
  }
}

/** PURO: atraso de backoff para a n-ésima falha seguida (n >= 1). */
export function backoffDelay(n) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), BACKOFF_MAX_MS);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function schedule(ms) {
  clearTimeout(timer);
  timer = null;
  if (loopMode === 'idle') return;
  timer = setTimeout(() => { timer = null; tick(); }, clamp(ms, POLL_MIN_MS, POLL_MAX_LOOP_MS));
}

async function idleStatus() {
  const settings = await getSettings();
  const auth = await getAuth();
  if (!settings.clientId) return 'needs_setup';
  if (!auth) return 'logged_out';
  if (!settings.enabled) return 'disabled';
  return 'idle';
}

/** Idempotente; cria alarm; agenda tick imediato. */
export function start() {
  loopMode = 'fast';
  try { chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN }); } catch (e) { log.warn('alarm', e); }
  if (!inFlight) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tick(); }, 0);
  }
}

/** Limpa timer e alarm; status disabled/logged_out/needs_setup/idle. */
export async function stop() {
  clearTimeout(timer);
  timer = null;
  loopMode = 'fast';
  try { await chrome.alarms.clear(WATCHDOG_ALARM); } catch { /* ignore */ }
  patchState({ status: await idleStatus() });
}

/** Se deveria rodar e não há timer em memória -> tick (respeitando POLL_MIN_MS). */
export async function ensureRunning() {
  await loadState();
  const settings = await getSettings();
  const auth = await getAuth();
  const rt = getState();
  if (!shouldRun(settings, auth, rt)) {
    if (timer || rt.status === 'polling' || rt.status === 'error') await stop();
    else {
      const st = await idleStatus();
      if (rt.status !== st) patchState({ status: st });
    }
    return;
  }
  // garante o watchdog (o SW pode ter sido reiniciado com o alarm limpo)
  try {
    const a = await chrome.alarms.get(WATCHDOG_ALARM);
    if (!a) chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  } catch { /* ignore */ }
  if (timer || inFlight) return;
  const since = Date.now() - (rt.lastPollAt || 0);
  if (since < POLL_MIN_MS) {
    loopMode = 'fast';
    schedule(POLL_MIN_MS - since);
  } else {
    tick();
  }
}

/** Roda um tick já (popup, mensagem de CS, comando). */
export function pokeNow(reason) {
  log.debug('pokeNow', reason);
  const rt = getState();
  const now = Date.now();
  loopMode = 'fast';
  if (inFlight) return;
  if (now < rt.backoffUntil) { schedule(rt.backoffUntil - now); return; }
  const since = now - (rt.lastPollAt || 0);
  if (since < POLL_MIN_MS) { schedule(POLL_MIN_MS - since); return; }
  clearTimeout(timer);
  timer = null;
  tick();
}

export async function tick() {
  if (inFlight) return;
  inFlight = true;
  clearTimeout(timer);
  timer = null;
  const now = Date.now();
  try {
    await loadState();
    const settings = await getSettings();
    const auth = await getAuth();
    let rt = getState();
    if (!shouldRun(settings, auth, rt)) { await stop(); return; }
    if (now < rt.backoffUntil) { loopMode = 'fast'; schedule(rt.backoffUntil - now); return; }

    const snap = await spotifyApi.getPlayer();
    const events = diffPlayback(rt.playback, snap, now, rt.currentClip?.trackKey ?? null);
    patchState({
      playback: snap,
      lastPollAt: now,
      consecutiveErrors: 0,
      backoffUntil: 0,
      lastError: rt.lastError && ['NETWORK', 'SERVER', 'RATE_LIMIT'].includes(rt.lastError.code) ? null : rt.lastError,
      lastPlayingAt: snap.status === 'playing' ? now : rt.lastPlayingAt,
    });
    rt = getState();
    if (events.length) log.debug('events', events.map((e) => e.type).join(','), snap.track?.name);
    await controller.handleEvents(events, snap);

    const delay = computeNextDelay(snap, getState(), now);
    if (delay === IDLE) {
      loopMode = 'idle';
      clearTimeout(timer);
      timer = null;
      if (getState().status !== 'idle') patchState({ status: 'idle' });
    } else {
      loopMode = 'fast';
      if (getState().status !== 'polling') patchState({ status: 'polling' });
      schedule(delay);
    }
  } catch (e) {
    await handleTickError(e, now);
  } finally {
    inFlight = false;
    try { await persistNow(); } catch { /* keep-alive best-effort */ }
  }
}

async function handleTickError(e, now) {
  const rt = getState();
  if (e instanceof spotifyApi.RateLimitError) {
    const until = now + e.retryAfterMs + Math.floor(Math.random() * 500);
    patchState({ backoffUntil: until, lastError: { code: e.code, message: e.message, at: now } });
    loopMode = 'fast';
    schedule(until - now);
    return;
  }
  if (e instanceof AuthError || e?.name === 'AuthError') {
    log.warn('auth', e.code, e.message);
    await stop();
    patchState({
      status: e.code === 'NEEDS_SETUP' ? 'needs_setup' : 'logged_out',
      lastError: e.code === 'REVOKED' ? { code: 'REVOKED', message: e.message, at: now } : rt.lastError,
    });
    return;
  }
  // rede, 5xx e qualquer outro erro inesperado: backoff exponencial
  const n = (rt.consecutiveErrors || 0) + 1;
  const delay = backoffDelay(n);
  if (!(e instanceof spotifyApi.NetworkError) && !(e instanceof spotifyApi.ServerError)) log.error('tick', e);
  else log.warn('tick', e.message);
  patchState({
    consecutiveErrors: n,
    backoffUntil: now + delay,
    status: n >= ERROR_STATUS_AFTER ? 'error' : rt.status,
    lastError: { code: e?.code || 'ERROR', message: e?.message || String(e), at: now },
  });
  loopMode = 'fast';
  schedule(delay);
}

/** Apenas debug. */
export function _debugInfo() {
  return { hasTimer: !!timer, inFlight, loopMode };
}
