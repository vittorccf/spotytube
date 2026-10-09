// Estado runtime (§3.2): memória + espelho em chrome.storage.session.
import { SK_RT } from '../shared/constants.js';

/** @returns {import('../shared/messages.js').RuntimeState} */
export function defaultState() {
  return {
    status: 'logged_out',
    playback: null,
    currentClip: null,
    spotyTabId: null,
    spotyTabExpectedVideoId: null,
    spotyTabMode: null,          // extra: modo com que a aba SpotyTube foi aberta (para SW_SET_ROLE)
    syncTarget: null,
    suggestion: null,
    handoff: null,
    lastPollAt: 0,
    lastPlayingAt: 0,
    backoffUntil: 0,
    consecutiveErrors: 0,
    lastError: null,
    lastTabNavAt: 0,
  };
}

let rt = defaultState();
let loadPromise = null;
let persistQueued = false;
// patches feitos antes do load terminar não podem ser sobrescritos pelo valor antigo
let pendingPatch = {};
const subscribers = new Set();

/** Lê storage.session uma vez por instância do SW (o SW pode ter morrido). */
export function loadState() {
  loadPromise ??= (async () => {
    try {
      const { [SK_RT]: stored } = await chrome.storage.session.get(SK_RT);
      if (stored && typeof stored === 'object') rt = { ...defaultState(), ...stored, ...pendingPatch };
    } catch { /* ignore */ }
    pendingPatch = null;
  })();
  return loadPromise;
}

export function getState() {
  return rt;
}

/** Merge raso; agenda persistência (microtask coalescida) e notifica (broadcastState). */
export function patchState(partial) {
  if (!partial) return rt;
  rt = { ...rt, ...partial };
  if (pendingPatch) pendingPatch = { ...pendingPatch, ...partial };
  if (!persistQueued) {
    persistQueued = true;
    queueMicrotask(() => {
      persistQueued = false;
      persistNow().catch(() => {});
    });
  }
  for (const fn of subscribers) {
    try { fn(rt); } catch { /* ignore */ }
  }
  return rt;
}

/** Grava rt + heartbeat (é também o keep-alive do SW). */
export async function persistNow() {
  if (pendingPatch !== null) await loadState(); // nunca sobrescrever o espelho antes de lê-lo
  await chrome.storage.session.set({ [SK_RT]: rt, heartbeat: Date.now() });
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Apenas para testes. */
export function _resetForTests(state) {
  rt = { ...defaultState(), ...(state || {}) };
}
