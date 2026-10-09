// OAuth Spotify com PKCE via chrome.identity.launchWebAuthFlow (§4).
import {
  SK_AUTH, SK_PKCE, TOKEN_REFRESH_SKEW_MS, FETCH_TIMEOUT_MS,
  SPOTIFY_AUTH_URL, SPOTIFY_TOKEN_URL, SPOTIFY_SCOPES,
} from '../shared/constants.js';
import { getSettings, setSettings } from '../shared/settings.js';
import { log } from '../shared/log.js';
import { getState, patchState, defaultState } from './state.js';
import { NetworkError, ServerError } from './spotify-api.js';
import * as poller from './poller.js';

const SK_FORCE_DIALOG = 'authForceDialog';

export class AuthError extends Error {
  /** @param {'NEEDS_SETUP'|'LOGGED_OUT'|'REVOKED'|'DENIED'|'STATE_MISMATCH'|'TOKEN_EXCHANGE'} code */
  constructor(code, message) {
    super(message || AUTH_MESSAGES[code] || code);
    this.name = 'AuthError';
    this.code = code;
  }
}

const AUTH_MESSAGES = {
  NEEDS_SETUP: 'Configure o Client ID do Spotify nas opções',
  LOGGED_OUT: 'Conecte sua conta Spotify',
  REVOKED: 'Acesso ao Spotify revogado ou expirado — reconecte o Spotify',
  DENIED: 'Login no Spotify cancelado ou negado',
  STATE_MISMATCH: 'Resposta de login inválida (state). Tente de novo',
  TOKEN_EXCHANGE: 'Falha ao trocar o código de autorização',
};

// ---- helpers PKCE (puros, exceto crypto global) ----
export function base64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBase64url(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return base64url(b);
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

/** Token só vale para o app (Client ID) que o emitiu; trocar o Client ID exige novo login. */
async function readAuth() {
  const [{ [SK_AUTH]: auth }, { clientId }] = await Promise.all([chrome.storage.local.get(SK_AUTH), getSettings()]);
  if (!auth || auth.clientId !== clientId) return null;
  return auth;
}

export async function isLoggedIn() {
  return !!(await readAuth());
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new NetworkError(String(e?.message || e));
  }
  let data = null;
  try { data = await res.json(); } catch { /* corpo vazio */ }
  return { status: res.status, data };
}

function toAuth(data, prev, clientId) {
  return {
    clientId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || prev?.refreshToken || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope ?? prev?.scope ?? '',
  };
}

/** Login interativo (chamado a partir de clique no popup/options). */
export async function login() {
  const settings = await getSettings();
  const clientId = settings.clientId;
  if (!clientId) throw new AuthError('NEEDS_SETUP');

  const verifier = randomBase64url(64);
  const challenge = await pkceChallenge(verifier);
  const state = randomBase64url(16);
  await chrome.storage.session.set({ [SK_PKCE]: { verifier, state, createdAt: Date.now() } });

  const redirectUri = getRedirectUri();
  // Após um logout, show_dialog força a tela do Spotify (senão a sessão em cache
  // no launchWebAuthFlow redireciona direto, sem mostrar nada nem permitir trocar de conta).
  const { [SK_FORCE_DIALOG]: forceDialog } = await chrome.storage.local.get(SK_FORCE_DIALOG);
  const url = `${SPOTIFY_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(clientId)}`
    + `&scope=${SPOTIFY_SCOPES.map(encodeURIComponent).join('%20')}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&code_challenge_method=S256&code_challenge=${challenge}&state=${state}`
    + (forceDialog ? '&show_dialog=true' : '');

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    await chrome.storage.session.remove(SK_PKCE);
    throw new AuthError('DENIED', `Login cancelado ou falhou: ${e?.message || e}. Confira se a Redirect URI no dashboard é exatamente ${redirectUri}`);
  }
  if (!redirect) throw new AuthError('DENIED');
  const params = new URL(redirect).searchParams;
  if (params.get('error')) {
    await chrome.storage.session.remove(SK_PKCE);
    throw new AuthError('DENIED', `Spotify recusou: ${params.get('error')}`);
  }
  const { [SK_PKCE]: pkce } = await chrome.storage.session.get(SK_PKCE);
  if (!pkce || params.get('state') !== pkce.state) throw new AuthError('STATE_MISMATCH');
  const code = params.get('code');
  if (!code) throw new AuthError('TOKEN_EXCHANGE', 'Spotify não retornou código de autorização');

  const { status, data } = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: pkce.verifier,
  });
  if (status !== 200 || !data?.access_token) {
    throw new AuthError('TOKEN_EXCHANGE', `Falha ao obter token (${status}${data?.error ? ': ' + data.error + (data.error_description ? ' — ' + data.error_description : '') : ''})`);
  }
  await chrome.storage.local.set({ [SK_AUTH]: toAuth(data, null, clientId) });
  await chrome.storage.local.remove(SK_FORCE_DIALOG);
  await chrome.storage.session.remove(SK_PKCE);
  patchState({ lastError: null, status: 'polling', consecutiveErrors: 0, backoffUntil: 0, lastPollAt: 0 });
  poller.start();
}

/** Desloga localmente (Spotify não tem endpoint de revogação) e limpa todo o estado da sessão. */
export async function logout() {
  refreshPromise = null;
  await chrome.storage.local.remove(SK_AUTH);
  await chrome.storage.local.set({ [SK_FORCE_DIALOG]: true });
  await chrome.storage.session.remove(SK_PKCE);
  // IDs de dispositivo são da conta/sessão anterior: manter gera "(offline)" no re-login
  await setSettings({ preferredDeviceId: null });
  await poller.stop();
  // zera o estado runtime (playback, erros, backoff…), preservando só a referência à aba aberta
  const { spotyTabId, spotyTabExpectedVideoId, spotyTabMode, lastTabNavAt } = getState();
  patchState({ ...defaultState(), spotyTabId, spotyTabExpectedVideoId, spotyTabMode, lastTabNavAt, status: 'logged_out' });
}

/** Remove auth e para o loop (token revogado). */
export async function handleRevoked() {
  await chrome.storage.local.remove(SK_AUTH);
  await poller.stop();
  patchState({ status: 'logged_out', syncTarget: null, lastError: { code: 'REVOKED', message: AUTH_MESSAGES.REVOKED, at: Date.now() } });
}

let refreshPromise = null;

async function refresh(auth) {
  // single-flight: concorrentes aguardam a mesma promise
  refreshPromise ??= (async () => {
    const settings = await getSettings();
    if (!auth.refreshToken) {
      await handleRevoked();
      throw new AuthError('REVOKED');
    }
    const { status, data } = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: settings.clientId,
    });
    if (status === 200 && data?.access_token) {
      const next = toAuth(data, auth, auth.clientId);
      await chrome.storage.local.set({ [SK_AUTH]: next });
      log.debug('token renovado; expira em', Math.round((next.expiresAt - Date.now()) / 1000), 's');
      return next.accessToken;
    }
    if (status === 400 || status === 401) {
      // invalid_grant (revogado) ou invalid_client (Client ID trocado) => reconectar
      log.warn('refresh falhou', status, data);
      await handleRevoked();
      throw new AuthError('REVOKED');
    }
    if (status === 429) throw new ServerError(429, 'Spotify limitou o refresh (429)');
    throw new ServerError(status, `Refresh do token falhou (${status})`);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/** @returns {Promise<string>} access token válido */
export async function getAccessToken({ forceRefresh = false } = {}) {
  if (refreshPromise) return refreshPromise;
  const auth = await readAuth();
  if (!auth) throw new AuthError('LOGGED_OUT');
  if (forceRefresh || !auth.accessToken || auth.expiresAt - Date.now() < TOKEN_REFRESH_SKEW_MS) {
    return refresh(auth);
  }
  return auth.accessToken;
}

export { readAuth as getAuth };
