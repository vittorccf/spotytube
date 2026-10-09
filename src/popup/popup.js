// Popup (§14.1).
import { MSG, sendMessage } from '../shared/messages.js';

const $ = (id) => document.getElementById(id);
let ui = null;
let busy = false;

const SOURCE_LABEL = { scrape: 'scrape', 'data-api': 'api', 'search-fallback': 'busca' };
// RATE_LIMIT fica de fora: o bloqueio do Spotify pode durar horas e o usuário precisa saber
const TRANSIENT = ['NETWORK', 'SERVER', 'ERROR'];

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showError(msg, actionLabel, action) {
  $('errorBox').hidden = !msg;
  $('errorText').textContent = msg || '';
  const btn = $('errorAction');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = action || null;
}

function render() {
  if (!ui) return;
  const s = ui.settings;
  $('enabled').checked = !!s.enabled;
  $('enabledLabel').textContent = s.enabled ? 'Ativo' : 'Pausado';
  $('loginSetup').hidden = !ui.needsSetup;
  $('loginOut').hidden = ui.needsSetup || ui.loggedIn;
  $('loginIn').hidden = ui.needsSetup || !ui.loggedIn;
  $('spotifyToYoutube').checked = !!s.spotifyToYoutube;
  $('youtubeToSpotify').checked = !!s.youtubeToSpotify;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;

  // faixa atual
  const pb = ui.playback;
  const hasTrack = pb && pb.trackName && (pb.status === 'playing' || pb.status === 'paused');
  $('track').hidden = !hasTrack;
  $('trackEmpty').hidden = hasTrack || !ui.loggedIn;
  if (hasTrack) {
    $('cover').src = pb.albumImage || '../../icons/icon48.png';
    $('trackName').textContent = pb.trackName;
    $('trackArtists').textContent = pb.artists;
    const where = pb.deviceName ? `em ${pb.deviceName}` : '';
    $('trackDevice').textContent = pb.status === 'paused' ? `Pausado${where ? ' ' + where : ''}` : where;
    renderProgress();
  } else {
    $('trackEmpty').textContent = !pb ? 'Nada tocando'
      : pb.status === 'unsupported' ? 'Podcast/anúncio — ignorado'
        : pb.status === 'no_device' ? 'Sem dispositivo ativo'
          : 'Nada tocando';
  }

  // clipe
  const c = ui.clip;
  $('clip').hidden = !c;
  if (c) {
    $('thumb').hidden = !c.thumbnail;
    if (c.thumbnail) $('thumb').src = c.thumbnail;
    $('clipTitle').textContent = c.title || (c.videoId ? c.videoId : 'Página de busca do YouTube');
    $('clipChannel').textContent = c.channel || '';
    $('clipIndex').textContent = c.candidateCount ? `${c.candidateIndex + 1} / ${c.candidateCount}` : '';
    $('clipSource').textContent = SOURCE_LABEL[c.source] || c.source || '';
    $('btnFocus').disabled = !ui.spotyTabOpen;
    $('offsetRow').hidden = !(s.mode === 'sync' && c.videoId);
    const off = (c.offsetMs || 0) / 1000;
    $('offsetVal').textContent = `${off > 0 ? '+' : off < 0 ? '−' : ''}${Math.abs(off)}s`;
  }

  // sugestão YT->SP
  const sg = ui.suggestion;
  $('suggestion').hidden = !sg;
  if (sg) $('suggestionText').textContent = `Tocar ‘${sg.name} — ${sg.artists}’ no Spotify? (${Math.round(sg.score * 100)}%)`;

  // erro
  const e = ui.lastError;
  if (ui.loggedIn === false && e?.code === 'REVOKED') showError('Reconecte o Spotify', 'Conectar', onLogin);
  else if (e && e.code === 'AUTOPLAY_BLOCKED') showError(e.message, 'Ir para a aba', () => act(MSG.FOCUS_SPOTY_TAB));
  else if (e && e.code === 'NO_DEVICE') showError(e.message, 'Opções', () => chrome.runtime.openOptionsPage());
  else if (e && e.code === 'YT_CONSENT') showError(e.message, 'Abrir YouTube', () => chrome.tabs.create({ url: 'https://www.youtube.com/' }));
  else if (e && (!TRANSIENT.includes(e.code) || ui.status === 'error')) showError(e.message);
  else if (ui.parserWarning) showError('A leitura da busca do YouTube falhou 3+ vezes seguidas — usando página de busca/Data API. Talvez o YouTube tenha mudado o HTML.');
  else showError(null);

  const ST = { needs_setup: 'configuração pendente', logged_out: 'desconectado', disabled: 'pausado', idle: 'ocioso', polling: 'monitorando', error: 'erro de conexão' };
  const STATUS_CLASS = { polling: 'st-status-on', error: 'st-status-err' };
  $('statusText').textContent = ST[ui.status] || ui.status || '';
  $('statusText').className = `st-status ${STATUS_CLASS[ui.status] || ''}`.trim();
}

function renderProgress() {
  const pb = ui?.playback;
  if (!pb || !pb.durationMs) return;
  const pos = pb.progressMs + (pb.status === 'playing' ? Date.now() - (pb.sampledAt || Date.now()) : 0);
  const clamped = Math.min(pos, pb.durationMs);
  $('progressBar').style.width = `${(100 * clamped) / pb.durationMs}%`;
  $('progressPos').textContent = fmtTime(clamped);
  $('progressDur').textContent = fmtTime(pb.durationMs);
}

async function act(type, payload) {
  if (busy) return;
  busy = true;
  try {
    const data = await sendMessage(type, payload);
    if (data && data.settings && data.status) { ui = data; render(); }
    return data;
  } catch (e) {
    showError(e.message);
    return null;
  } finally {
    busy = false;
  }
}

async function setSetting(partial) {
  try {
    await sendMessage(MSG.SET_SETTINGS, partial);
  } catch (e) {
    showError(e.message);
  }
}

function onLogin() {
  act(MSG.LOGIN);
}

function bind() {
  $('enabled').addEventListener('change', (e) => setSetting({ enabled: e.target.checked }));
  $('spotifyToYoutube').addEventListener('change', (e) => setSetting({ spotifyToYoutube: e.target.checked }));
  $('youtubeToSpotify').addEventListener('change', (e) => setSetting({ youtubeToSpotify: e.target.checked }));
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.addEventListener('change', (e) => { if (e.target.checked) setSetting({ mode: e.target.value }); });
  }
  $('btnSetup').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('btnLogin').addEventListener('click', onLogin);
  $('btnLogout').addEventListener('click', (e) => { e.preventDefault(); act(MSG.LOGOUT); });
  $('btnNext').addEventListener('click', () => act(MSG.NEXT_CANDIDATE));
  $('btnReopen').addEventListener('click', () => act(MSG.REOPEN_CLIP));
  $('btnFocus').addEventListener('click', () => act(MSG.FOCUS_SPOTY_TAB));
  $('btnSearch').addEventListener('click', () => act(MSG.OPEN_YT_SEARCH));
  $('btnOffMinus').addEventListener('click', () => act(MSG.SET_CLIP_OFFSET, { deltaMs: -1000 }));
  $('btnOffPlus').addEventListener('click', () => act(MSG.SET_CLIP_OFFSET, { deltaMs: 1000 }));
  $('btnSuggestion').addEventListener('click', () => {
    if (ui?.suggestion) act(MSG.PLAY_SUGGESTION, { trackUri: ui.suggestion.trackUri });
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.STATE_UPDATED && msg.payload) {
    ui = msg.payload;
    render();
  }
});

bind();
setInterval(renderProgress, 1000);
act(MSG.GET_STATE);
