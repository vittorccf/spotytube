// Aba SpotyTube única e reutilizada (§9).
import { MIN_TAB_NAV_INTERVAL_MS } from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { log } from '../shared/log.js';
import { getState, patchState, loadState } from './state.js';

/** PURO */
export function buildWatchUrl(videoId, startSec) {
  return `https://www.youtube.com/watch?v=${videoId}` + (startSec >= 1 ? `&t=${Math.floor(startSec)}s` : '');
}

const isYouTubeUrl = (u) => /^https:\/\/www\.youtube\.com\//.test(u || '');

/** tab|null. Se a aba saiu do youtube.com (usuário foi para outro site), deixa de ser nossa. */
export async function getSpotyTab() {
  const id = getState().spotyTabId;
  if (id == null) return null;
  try {
    const tab = await chrome.tabs.get(id);
    if (!isYouTubeUrl(tab.url) && !isYouTubeUrl(tab.pendingUrl)) {
      log.debug('aba SpotyTube saiu do YouTube; liberando');
      patchState({ spotyTabId: null, spotyTabExpectedVideoId: null, spotyTabMode: null });
      return null;
    }
    return tab;
  } catch {
    patchState({ spotyTabId: null, spotyTabExpectedVideoId: null, spotyTabMode: null });
    return null;
  }
}

let pending = null; // { timer, resolve }

async function doNavigate(url, { expectedVideoId = null, role = null } = {}) {
  const settings = await getSettings();
  const now = Date.now();
  // marca antes de navegar: o CS_HELLO da nova página precisa achar o expectedVideoId
  patchState({ spotyTabExpectedVideoId: expectedVideoId, spotyTabMode: role, lastTabNavAt: now });
  let tab = await getSpotyTab();
  if (tab) {
    try {
      tab = await chrome.tabs.update(tab.id, {
        url,
        ...(settings.focusTab ? { active: true } : {}),
        ...(settings.pinTab ? { pinned: true } : {}),
      });
      if (settings.focusTab) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } catch (e) {
      log.warn('tabs.update falhou; criando nova aba', e?.message);
      tab = null;
    }
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: !!settings.focusTab, pinned: !!settings.pinTab });
  }
  patchState({ spotyTabId: tab.id, spotyTabExpectedVideoId: expectedVideoId, spotyTabMode: role, lastTabNavAt: now });
  return tab;
}

/**
 * Cria ou reutiliza a aba. Respeita MIN_TAB_NAV_INTERVAL_MS com "latest wins":
 * uma navegação adiada substituída resolve com null.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export function navigate(url, opts = {}) {
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(null);
    pending = null;
  }
  const wait = MIN_TAB_NAV_INTERVAL_MS - (Date.now() - (getState().lastTabNavAt || 0));
  if (wait > 0) {
    return new Promise((resolve) => {
      const p = {
        resolve,
        timer: setTimeout(() => {
          if (pending === p) pending = null;
          doNavigate(url, opts).then(resolve, (e) => { log.error('navigate', e); resolve(null); });
        }, wait),
      };
      pending = p;
    });
  }
  return doNavigate(url, opts);
}

/** Listener de chrome.tabs.onRemoved. */
export async function onTabRemoved(tabId) {
  await loadState();
  const rt = getState();
  const patch = {};
  if (tabId === rt.spotyTabId) Object.assign(patch, { spotyTabId: null, spotyTabExpectedVideoId: null, spotyTabMode: null });
  if (rt.syncTarget && tabId === rt.syncTarget.tabId) patch.syncTarget = null;
  if (rt.suggestion && rt.suggestion.tabId === tabId) patch.suggestion = null;
  if (Object.keys(patch).length) patchState(patch);
}

/** "Ir para a aba". Retorna false se não houver aba. */
export async function focusSpotyTab() {
  const tab = await getSpotyTab();
  if (!tab) return false;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return true;
}
