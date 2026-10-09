// Settings em chrome.storage.local (§3.1).
import { SK_SETTINGS } from './constants.js';

/** @type {import('./messages.js').Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  clientId: '',
  enabled: true,
  spotifyToYoutube: true,
  youtubeToSpotify: false,
  mode: 'sync',
  ytAction: 'play-mute-video',
  focusTab: false,
  pinTab: false,
  ytApiKey: '',
  preferredDeviceId: null,
  debug: false,
});

const MODES = ['sync', 'handoff', 'open'];
const ACTIONS = ['play-mute-video', 'play-pause-video', 'queue'];

/** Merge com defaults + validação leve (PURO). */
export function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if (!MODES.includes(s.mode)) s.mode = DEFAULT_SETTINGS.mode;
  if (!ACTIONS.includes(s.ytAction)) s.ytAction = DEFAULT_SETTINGS.ytAction;
  s.clientId = String(s.clientId || '').trim();
  s.ytApiKey = String(s.ytApiKey || '').trim();
  return s;
}

export async function getSettings() {
  const { [SK_SETTINGS]: stored } = await chrome.storage.local.get(SK_SETTINGS);
  return mergeSettings(stored);
}

/** Merge parcial e grava. Retorna o Settings resultante. */
export async function setSettings(partial) {
  const cur = await getSettings();
  const next = mergeSettings({ ...cur, ...(partial || {}) });
  await chrome.storage.local.set({ [SK_SETTINGS]: next });
  return next;
}

/** cb(oldSettings, newSettings) quando 'settings' muda em storage.local. */
export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SK_SETTINGS]) return;
    cb(mergeSettings(changes[SK_SETTINGS].oldValue), mergeSettings(changes[SK_SETTINGS].newValue));
  });
}
