// Options page (§14.2).
import { MSG, sendMessage } from '../shared/messages.js';
import { getSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const GOOGLE_ORIGINS = { origins: ['https://www.googleapis.com/*'] };

function msg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'st-msg' + (kind ? ' st-msg-' + kind : '');
}

async function save(partial) {
  return sendMessage(MSG.SET_SETTINGS, partial);
}

function renderAuth(ui) {
  const st = ui.needsSetup ? 'Client ID não configurado'
    : ui.loggedIn ? 'Conectado ao Spotify'
      : ui.lastError?.code === 'REVOKED' ? 'Acesso revogado — reconecte' : 'Desconectado';
  $('authStatus').textContent = st;
  $('authStatus').className = 'st-status' + (ui.loggedIn ? ' st-status-on' : ui.lastError?.code === 'REVOKED' ? ' st-status-err' : '');
  $('btnLogin').disabled = ui.needsSetup;
  $('btnLogin').hidden = ui.loggedIn;
  $('btnLogout').hidden = !ui.loggedIn;
  $('device').disabled = !ui.loggedIn;
  $('refreshDevices').disabled = !ui.loggedIn;
}

function resetDevices() {
  $('device').innerHTML = '<option value="">— nenhum —</option>';
  msg($('deviceMsg'), '');
}

async function loadDevices(selected) {
  const sel = $('device');
  resetDevices();
  msg($('deviceMsg'), 'Carregando dispositivos…');
  let devices;
  try {
    devices = await sendMessage(MSG.GET_DEVICES);
  } catch (e) {
    msg($('deviceMsg'), `Não foi possível listar os dispositivos: ${e.message}`, 'err');
    return;
  }
  const ids = new Set();
  for (const d of devices || []) {
    ids.add(d.id);
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = `${d.name} (${d.type})${d.is_active ? ' — ativo' : ''}${d.is_restricted ? ' — restrito' : ''}`;
    sel.appendChild(o);
  }
  if (selected && !ids.has(selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = 'Dispositivo salvo (indisponível agora)';
    sel.appendChild(o);
  }
  sel.value = selected || '';
  msg($('deviceMsg'), devices?.length
    ? ''
    : 'Nenhum dispositivo encontrado — abra o Spotify (app ou open.spotify.com) e clique em “Atualizar lista”.');
}

async function refreshCache() {
  try {
    const { count } = await sendMessage(MSG.GET_CACHE_STATS);
    $('cacheCount').textContent = `${count} clipe${count === 1 ? '' : 's'} em cache`;
  } catch (e) {
    $('cacheCount').textContent = e.message;
  }
}

async function init() {
  const settings = await getSettings();
  $('clientId').value = settings.clientId;
  $('ytApiKey').value = settings.ytApiKey;
  $('pinTab').checked = settings.pinTab;
  $('debug').checked = settings.debug;
  for (const r of document.querySelectorAll('input[name=focusTab]')) r.checked = r.value === String(settings.focusTab);
  for (const r of document.querySelectorAll('input[name=ytAction]')) r.checked = r.value === settings.ytAction;

  try {
    const { uri } = await sendMessage(MSG.GET_REDIRECT_URI);
    $('redirectUri').value = uri;
  } catch {
    $('redirectUri').value = chrome.identity.getRedirectURL();
  }

  const ui = await sendMessage(MSG.GET_STATE);
  wasLoggedIn = ui.loggedIn;
  renderAuth(ui);
  if (ui.loggedIn) loadDevices(settings.preferredDeviceId);
  refreshCache();
}

function bind() {
  $('saveClientId').addEventListener('click', async () => {
    const v = $('clientId').value.trim();
    if (v && !/^[0-9a-f]{32}$/i.test(v)) return msg($('clientIdMsg'), 'Client ID inválido: precisa ter 32 caracteres hexadecimais.', 'err');
    try {
      await save({ clientId: v });
      msg($('clientIdMsg'), v ? 'Salvo. Agora clique em “Conectar Spotify”.' : 'Client ID removido.', 'ok');
      renderAuth(await sendMessage(MSG.GET_STATE));
    } catch (e) {
      msg($('clientIdMsg'), e.message, 'err');
    }
  });
  $('copyRedirect').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('redirectUri').value);
    $('copyRedirect').textContent = 'Copiado!';
    setTimeout(() => { $('copyRedirect').textContent = 'Copiar'; }, 1500);
  });
  $('btnLogin').addEventListener('click', async () => {
    $('authStatus').textContent = 'Abrindo login do Spotify…';
    $('btnLogin').disabled = true;
    try {
      const ui = await sendMessage(MSG.LOGIN);
      wasLoggedIn = ui.loggedIn;
      renderAuth(ui);
      loadDevices((await getSettings()).preferredDeviceId);
    } catch (e) {
      renderAuth(await sendMessage(MSG.GET_STATE).catch(() => ({ loggedIn: false, needsSetup: false })));
      $('authStatus').textContent = e.message;
      $('authStatus').className = 'st-status st-status-err';
    }
  });
  $('btnLogout').addEventListener('click', async () => {
    await sendMessage(MSG.LOGOUT).catch(() => {});
    resetDevices();
    renderAuth(await sendMessage(MSG.GET_STATE));
  });
  $('device').addEventListener('change', (e) => save({ preferredDeviceId: e.target.value || null }));
  $('refreshDevices').addEventListener('click', async () => loadDevices((await getSettings()).preferredDeviceId));
  for (const r of document.querySelectorAll('input[name=focusTab]')) {
    r.addEventListener('change', (e) => { if (e.target.checked) save({ focusTab: e.target.value === 'true' }); });
  }
  for (const r of document.querySelectorAll('input[name=ytAction]')) {
    r.addEventListener('change', (e) => { if (e.target.checked) save({ ytAction: e.target.value }); });
  }
  $('pinTab').addEventListener('change', (e) => save({ pinTab: e.target.checked }));
  $('debug').addEventListener('change', (e) => save({ debug: e.target.checked }));

  // permissions.request precisa ser chamado direto no handler do gesto (antes de qualquer await)
  $('testKey').addEventListener('click', () => {
    const key = $('ytApiKey').value.trim();
    if (!key) return msg($('keyMsg'), 'Informe uma API key.', 'err');
    chrome.permissions.request(GOOGLE_ORIGINS).then(async (granted) => {
      if (!granted) return msg($('keyMsg'), 'Permissão para googleapis.com negada.', 'err');
      msg($('keyMsg'), 'Testando…');
      try {
        const r = await sendMessage(MSG.TEST_YT_API_KEY, { key });
        msg($('keyMsg'), r.message, r.valid ? 'ok' : 'err');
      } catch (e) {
        msg($('keyMsg'), e.message, 'err');
      }
    });
  });
  $('saveKey').addEventListener('click', () => {
    const key = $('ytApiKey').value.trim();
    const afterPerm = async (granted) => {
      if (key && !granted) return msg($('keyMsg'), 'Permissão para googleapis.com negada; key não salva.', 'err');
      await save({ ytApiKey: key });
      msg($('keyMsg'), key ? 'API key salva.' : 'API key removida.', 'ok');
    };
    if (key) chrome.permissions.request(GOOGLE_ORIGINS).then(afterPerm, (e) => msg($('keyMsg'), e.message, 'err'));
    else afterPerm(true);
  });
  $('clearCache').addEventListener('click', async () => {
    if (!confirm('Limpar todos os clipes em cache (inclusive escolhas de “próximo candidato”)?')) return;
    const { removed } = await sendMessage(MSG.CLEAR_CACHE);
    $('cacheCount').textContent = `${removed} removido(s)`;
    setTimeout(refreshCache, 1200);
  });
}

let wasLoggedIn = null;
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type !== MSG.STATE_UPDATED || !m.payload) return;
  renderAuth(m.payload);
  // login/logout feito em outro lugar (popup): sincroniza a lista de dispositivos
  if (wasLoggedIn !== null && m.payload.loggedIn !== wasLoggedIn) {
    if (m.payload.loggedIn) getSettings().then((s) => loadDevices(s.preferredDeviceId));
    else resetDevices();
  }
  wasLoggedIn = m.payload.loggedIn;
});

bind();
init().catch((e) => { $('authStatus').textContent = e.message; });
