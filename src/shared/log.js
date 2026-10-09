// Logger com prefixo e flag settings.debug (§1).
// Sem chamadas chrome.* no topo do módulo (importável em node --test).

const PREFIX = '[SpotyTube]';
let debugEnabled = false;

export function setDebug(v) {
  debugEnabled = !!v;
}

export const log = {
  debug: (...a) => { if (debugEnabled) console.debug(PREFIX, ...a); },
  info: (...a) => { if (debugEnabled) console.info(PREFIX, ...a); },
  warn: (...a) => console.warn(PREFIX, ...a),
  error: (...a) => console.error(PREFIX, ...a),
};
