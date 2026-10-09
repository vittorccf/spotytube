// Badge da action (§15).

// Cores do design system (theme.css): brand, essential-subdued, negative e warning escurecido
// para o texto branco do badge ter contraste.
const STYLES = {
  ok: { text: '', color: '#3ad36f' },
  off: { text: 'OFF', color: '#535353' },
  error: { text: '!', color: '#e22134' },
  fallback: { text: '?', color: '#b86e00' },
};

let last = null;

/** @param {'ok'|'off'|'error'|'fallback'} status */
export async function setBadge(status) {
  const s = STYLES[status] || STYLES.ok;
  if (last === status) return;
  last = status;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: s.color });
    await chrome.action.setBadgeText({ text: s.text });
  } catch { /* ignore */ }
}

/** Deriva o badge do estado (PURO). */
export function badgeFor(rt, settings, loggedIn) {
  if (!settings?.enabled) return 'off';
  if (!settings?.clientId || !loggedIn) return 'error';
  if (rt?.status === 'error' || rt?.status === 'logged_out') return 'error';
  if (rt?.lastError && ['NO_DEVICE', 'REVOKED', 'AUTOPLAY_BLOCKED'].includes(rt.lastError.code)) return 'error';
  if (rt?.currentClip && rt.currentClip.source === 'search-fallback') return 'fallback';
  return 'ok';
}
