// Teste de integração do service worker com chrome.* e fetch simulados (sem navegador).
// Exercita: boot, poll, TRACK_CHANGED, scrape (fixture real), ranking, abertura/reuso da aba,
// navegação manual + sync, refresh de token single-flight e 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rickHtml = fs.readFileSync(path.join(dir, 'yt-search-rick-astley.html'), 'utf8');

// ---------------------------------------------------------------- chrome mock
const listeners = {};
const ev = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
const store = { local: {}, session: {} };
const area = (name) => ({
  async get(keys) {
    const s = store[name];
    if (keys == null) return { ...s };
    const arr = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(arr.filter((k) => k in s).map((k) => [k, structuredClone(s[k])]));
  },
  async set(obj) {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) {
      changes[k] = { oldValue: store[name][k], newValue: structuredClone(v) };
      store[name][k] = structuredClone(v);
    }
    for (const fn of listeners['storage.onChanged'] || []) fn(changes, name);
  },
  async remove(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[name][k];
  },
});
const tabs = new Map();
let nextTabId = 100;
const tabCalls = [];
const sentToTabs = [];
globalThis.chrome = {
  runtime: { onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message'), sendMessage: async () => undefined, id: 'test' },
  alarms: { onAlarm: ev('alarm'), create: () => {}, clear: async () => true, get: async () => ({ name: 'x' }) },
  tabs: {
    onRemoved: ev('tabs.onRemoved'),
    async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
    async create(o) { const t = { id: nextTabId++, windowId: 1, url: o.url }; tabs.set(t.id, t); tabCalls.push(['create', t.id, o.url]); return { ...t }; },
    async update(id, o) { const t = tabs.get(id); if (!t) throw new Error('No tab'); Object.assign(t, o); tabCalls.push(['update', id, o.url]); return { ...t }; },
    async sendMessage(id, msg) { sentToTabs.push([id, msg]); if (msg.type === 'SW_GET_STATUS') return { videoId: null }; return { ok: true }; },
  },
  windows: { update: async () => ({}) },
  storage: { local: area('local'), session: area('session'), onChanged: ev('storage.onChanged') },
  commands: { onCommand: ev('commands') },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  identity: { getRedirectURL: () => 'https://ebpjemfgnikafalieohcaanfhijmogfl.chromiumapp.org/' },
  permissions: { contains: async () => false },
};

// ---------------------------------------------------------------- fetch mock
let player = null; // resposta de /me/player
let tokenCalls = 0;
let force401 = 0;
let force429 = 0;
const fetchLog = [];
const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.startsWith('https://accounts.spotify.com/api/token')) {
    tokenCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return json(200, { access_token: 'tok' + tokenCalls, expires_in: 3600, scope: 's' });
  }
  if (u.startsWith('https://api.spotify.com/v1/me/player/queue')) return json(200, { queue: [] });
  if (u.startsWith('https://api.spotify.com/v1/me/player')) {
    if (force401 > 0) { force401--; return json(401, { error: { status: 401, message: 'expired' } }); }
    if (force429 > 0) { force429--; return json(429, { error: { status: 429 } }, { 'Retry-After': '14676' }); }
    return player ? json(200, player) : new Response(null, { status: 204 });
  }
  if (u.startsWith('https://www.youtube.com/results')) return new Response(rickHtml, { status: 200 });
  throw new TypeError('unexpected fetch ' + u);
};

const track = (id, name, artist, progress, playing = true) => ({
  is_playing: playing, progress_ms: progress, repeat_state: 'off', currently_playing_type: 'track',
  device: { id: 'dev', name: 'Celular' },
  item: { type: 'track', id, uri: 'spotify:track:' + id, name, duration_ms: 213_000, artists: [{ name: artist }], album: { name: 'Album', images: [] } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(20); }
  return false;
}

store.local.settings = { clientId: '0123456789abcdef0123456789abcdef', enabled: true, spotifyToYoutube: true, mode: 'sync' };
store.local.auth = { clientId: '0123456789abcdef0123456789abcdef', accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600_000, scope: '' };

const state = await import('../src/background/state.js');
const poller = await import('../src/background/poller.js');
const controller = await import('../src/background/controller.js');
const auth = await import('../src/background/spotify-auth.js');
await import('../src/background/service-worker.js');

function sendRuntime(msg, sender = {}) {
  return new Promise((resolve) => {
    for (const fn of listeners.message) fn(msg, sender, resolve);
  });
}

test('Spotify -> YouTube: abre o clipe oficial numa aba e reutiliza a mesma aba', async () => {
  player = track('rick', 'Never Gonna Give You Up', 'Rick Astley', 30_000);
  await poller.tick();
  assert.ok(await waitFor(() => tabCalls.length >= 1), 'abriu aba');
  const [kind, tabId, url] = tabCalls[0];
  assert.equal(kind, 'create');
  assert.match(url, /^https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&t=3\ds$/);
  const rt = state.getState();
  assert.equal(rt.spotyTabId, tabId);
  assert.equal(rt.currentClip.videoId, 'dQw4w9WgXcQ');
  assert.equal(rt.syncTarget.tabId, tabId);
  assert.ok(store.local['clip:rick'], 'cache gravado');

  // mesma faixa de novo: nada de nova navegação
  await sleep(10);
  player = track('rick', 'Never Gonna Give You Up', 'Rick Astley', 33_000);
  await poller.tick();
  await sleep(50);
  assert.equal(tabCalls.length, 1);

  // CS da aba SpotyTube diz olá -> role spotytube/sync + SW_SYNC
  const hello = await sendRuntime({ type: 'CS_HELLO', payload: { videoId: 'dQw4w9WgXcQ', url } }, { tab: { id: tabId } });
  assert.deepEqual(hello, { ok: true, data: { role: 'spotytube', mode: 'sync', expectedVideoId: 'dQw4w9WgXcQ' } });
  assert.ok(await waitFor(() => sentToTabs.some(([id, m]) => id === tabId && m.type === 'SW_SYNC')), 'SW_SYNC enviado');

  // troca de faixa: reutiliza a aba (update), respeitando MIN_TAB_NAV_INTERVAL_MS
  player = track('other', 'Never Gonna Give You Up', 'Rick Astley', 1_000);
  player.item.id = 'rick2'; // outra versão (outro id), mesmo clipe esperado
  await sleep(10);
  await poller.tick();
  await sleep(200);
  // mesmo videoId e aba aberta => não navega
  assert.equal(tabCalls.length, 1, JSON.stringify(tabCalls));
  assert.equal(state.getState().currentClip.trackKey, 'rick2');
});

test('autoplay sem gesto na aba SpotyTube é ignorado; navegação manual vira normal', async () => {
  const tabId = state.getState().spotyTabId;
  const r1 = await sendRuntime({ type: 'CS_VIDEO_CHANGED', payload: { videoId: 'AAAAAAAAAAA', url: '', title: 'x', channel: 'y', durationSec: 200, userInitiated: false, visible: true } }, { tab: { id: tabId } });
  assert.equal(r1.data.role, 'spotytube');
  assert.ok(state.getState().syncTarget, 'syncTarget mantido');
  const r2 = await sendRuntime({ type: 'CS_VIDEO_CHANGED', payload: { videoId: 'BBBBBBBBBBB', url: '', title: 'x', channel: 'y', durationSec: 200, userInitiated: true, visible: true } }, { tab: { id: tabId } });
  assert.equal(r2.data.role, 'normal');
  assert.equal(state.getState().syncTarget, null);
  assert.equal(state.getState().spotyTabId, tabId, 'aba continua sendo a SpotyTube');
});

test('fechar a aba limpa o estado e a próxima faixa recria', async () => {
  const tabId = state.getState().spotyTabId;
  tabs.delete(tabId);
  for (const fn of listeners['tabs.onRemoved']) fn(tabId);
  await sleep(20);
  assert.equal(state.getState().spotyTabId, null);
  player = track('zzz', 'Never Gonna Give You Up', 'Rick Astley', 1_000);
  player.item.id = 'rick3';
  await sleep(1600); // MIN_TAB_NAV_INTERVAL_MS
  await poller.tick();
  assert.ok(await waitFor(() => tabCalls.length === 2), JSON.stringify(tabCalls));
  assert.equal(tabCalls[1][0], 'create');
});

test('401 => refresh single-flight e repete a chamada', async () => {
  const before = tokenCalls;
  force401 = 1;
  await poller.tick();
  assert.equal(tokenCalls, before + 1);
  assert.equal(store.local.auth.accessToken, 'tok' + tokenCalls);
  assert.equal(store.local.auth.refreshToken, 'r1', 'mantém refresh_token antigo quando não vem novo');
  // concorrência: várias chamadas com token expirado => um só refresh
  store.local.auth.expiresAt = 0;
  const b2 = tokenCalls;
  await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(tokenCalls, b2 + 1);
});

test('GET_STATE devolve UiState sem ytApiKey', async () => {
  const res = await sendRuntime({ type: 'GET_STATE' });
  assert.equal(res.ok, true);
  assert.equal(res.data.loggedIn, true);
  assert.equal('ytApiKey' in res.data.settings, false);
  assert.equal(res.data.clip.videoId, 'dQw4w9WgXcQ');
  assert.match(res.data.clip.thumbnail, /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/);
});

test('desligar o master para o loop', async () => {
  await sendRuntime({ type: 'SET_SETTINGS', payload: { enabled: false } });
  await sleep(50);
  assert.equal(state.getState().status, 'disabled');
  assert.equal(poller._debugInfo().hasTimer, false);
  await controller.onSettingsChanged({ enabled: false }, { enabled: false }); // no-op
});

test('429: bloqueio global persistido barra toda chamada à API até expirar', async () => {
  const spotifyApi = await import('../src/background/spotify-api.js');
  force429 = 1;
  await assert.rejects(spotifyApi.getDevices(), (e) => e.code === 'RATE_LIMIT' && /4 h 5 min/.test(e.message));
  assert.ok(store.local.rateLimitUntil.until > Date.now() + 4 * 3600_000, 'persistido em storage.local');
  assert.equal(store.local.rateLimitUntil.clientId, store.local.settings.clientId);
  const n = fetchLog.length;
  await assert.rejects(spotifyApi.getPlayer(), (e) => e.code === 'RATE_LIMIT');
  await assert.rejects(spotifyApi.getQueue(), (e) => e.code === 'RATE_LIMIT');
  assert.equal(fetchLog.length, n, 'nenhuma requisição durante o bloqueio');
  // a cota é por app: trocar o Client ID libera; voltar ao antigo bloqueia de novo
  const oldId = store.local.settings.clientId;
  store.local.settings = { ...store.local.settings, clientId: 'ffffffffffffffffffffffffffffffff' };
  assert.equal(await spotifyApi.rateLimitRemaining(), 0);
  // o token do app antigo não serve para o novo
  await assert.rejects(spotifyApi.getDevices(), (e) => e.code === 'LOGGED_OUT');
  store.local.auth.clientId = 'ffffffffffffffffffffffffffffffff';
  await spotifyApi.getDevices();
  assert.equal(fetchLog.length, n + 1);
  store.local.settings = { ...store.local.settings, clientId: oldId };
  store.local.auth.clientId = oldId;
  assert.ok(await spotifyApi.rateLimitRemaining() > 0);
  assert.equal(spotifyApi.formatWait(42_000), '42 s');
  assert.equal(spotifyApi.formatWait(3600_000), '1 h');
});

test.after(async () => {
  await poller.stop();
});
