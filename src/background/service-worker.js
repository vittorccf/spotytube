// Entrypoint do service worker (§16). Todos os listeners registrados sincronamente no topo.
import { WATCHDOG_ALARM, SK_SETTINGS, SK_AUTH } from '../shared/constants.js';
import { getSettings, setSettings, mergeSettings } from '../shared/settings.js';
import { log, setDebug } from '../shared/log.js';
import { loadState } from './state.js';
import * as poller from './poller.js';
import * as controller from './controller.js';
import * as messaging from './messaging.js';
import * as tabManager from './tab-manager.js';
import * as clipCache from './clip-cache.js';

// `booted` declarado antes do primeiro boot() (evita TDZ — ver README, Desvios).
let booted = null;

/** Idempotente por instância do SW. */
function boot() {
  booted ??= (async () => {
    await loadState();
    try { setDebug((await getSettings()).debug); } catch { /* ignore */ }
    try { await clipCache.prune(); } catch (e) { log.warn('prune', e); }
    messaging.broadcastState().catch(() => {}); // badge inicial
  })();
  return booted;
}

/** boot + ensureRunning (o boot é memoizado; ensureRunning roda a cada despertar). */
function wake(reason) {
  return boot()
    .then(() => poller.ensureRunning())
    .catch((e) => log.error('wake', reason, e));
}

// 1) listeners síncronos no topo
messaging.init({ boot: wake });
chrome.runtime.onInstalled.addListener(() => wake('installed'));
chrome.runtime.onStartup.addListener(() => wake('startup'));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === WATCHDOG_ALARM) wake('alarm'); });
chrome.runtime.onMessage.addListener(messaging.onMessage);
chrome.tabs.onRemoved.addListener((tabId) => { tabManager.onTabRemoved(tabId).catch(() => {}); });
chrome.storage.onChanged.addListener(onStorageChanged);
chrome.commands.onCommand.addListener(onCommand);

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes[SK_SETTINGS]) {
    const prev = mergeSettings(changes[SK_SETTINGS].oldValue);
    const next = mergeSettings(changes[SK_SETTINGS].newValue);
    boot()
      .then(() => controller.onSettingsChanged(prev, next))
      .then(() => messaging.broadcastState())
      .catch((e) => log.error('settings', e));
  }
  if (changes[SK_AUTH]) {
    boot().then(() => messaging.broadcastState()).catch(() => {});
  }
}

async function onCommand(command) {
  await wake('command');
  try {
    if (command === 'next-candidate') await controller.nextCandidate();
    else if (command === 'toggle-enabled') {
      const s = await getSettings();
      await setSettings({ enabled: !s.enabled });
    }
  } catch (e) {
    log.warn('command', command, e.message);
  }
}

// 2) boot também ao avaliar o script (SW acordou por qualquer motivo)
wake('eval');
