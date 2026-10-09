# SpotyTube — Arquitetura (v1)

> Documento normativo. O engenheiro implementa **exatamente** o que está aqui. Onde houver ambiguidade, a seção "Regras" de cada tópico vence a prosa. Constantes estão centralizadas em `src/shared/constants.js` (seção 2.1) — use os nomes, não números mágicos.

## 0. Resumo

Extensão Chrome MV3 (Chromium ≥ 116), JS puro com ES modules, sem build step, sem dependências npm em runtime.

- **Spotify → YouTube (prioridade):** o service worker (SW) faz polling de `GET /v1/me/player`; ao detectar troca de faixa, busca o clipe oficial fazendo scraping de `youtube.com/results` (`ytInitialData`), ranqueia candidatos e navega a **aba SpotyTube** (única, reutilizada).
- **Modos:** `sync` (default; vídeo mudo seguindo posição/play/pause do Spotify), `handoff` (pausa Spotify, vídeo com áudio a partir da posição atual), `open` (só abre o vídeo).
- **YouTube → Spotify:** content script detecta vídeo aberto manualmente pelo usuário; SW confirma que é música, limpa título, busca no Spotify e dá `PUT /me/player/play`.
- **Keep-alive:** loop `setTimeout` no SW, mantido vivo porque cada tick chama uma API de extensão (`chrome.storage.session.set`), + `chrome.alarms` de 30 s como watchdog/despertador.

Nomes dos modos no código: `'sync' | 'handoff' | 'open'` (UI em pt-BR: "Vídeo mudo sincronizado", "Áudio no YouTube", "Só abrir o vídeo").

---

## 1. Estrutura de arquivos

```
Spoty_Tube/
├── manifest.json
├── icons/
│   ├── icon16.png  icon32.png  icon48.png  icon128.png   # gerados por tools/gen-icons.mjs a partir da logo
│   └── logo.svg                    # logo (robô com fone, pixel art) — design system "SpotyTube"
├── docs/
│   └── ARCHITECTURE.md
├── src/
│   ├── shared/                     # ES modules usados por SW, popup e options (NÃO pelo content script)
│   │   ├── constants.js            # TODAS as constantes (ms, limiares, pesos, chaves de storage)
│   │   ├── messages.js             # enum MSG com os tipos de mensagem + helpers send/ok/err
│   │   ├── settings.js             # DEFAULT_SETTINGS, getSettings(), setSettings(partial), onSettingsChanged(cb)
│   │   ├── text-normalize.js       # normalize(), tokens(), dice(), cleanSpotifyTitle(), parseDuration() — PURO
│   │   ├── log.js                  # log.debug/info/warn/error com prefixo e flag settings.debug
│   │   ├── theme.css               # design system: @font-face, tokens (escuro padrão / claro) e componentes st-*
│   │   └── fonts/                  # Figtree e JetBrains Mono (woff2, subset latin, OFL)
│   ├── background/
│   │   ├── service-worker.js       # entrypoint: registra TODOS os listeners de forma síncrona no topo; bootstrap
│   │   ├── state.js                # estado runtime (memória + espelho em storage.session); getState(), patchState()
│   │   ├── poller.js               # loop adaptativo, keep-alive, watchdog alarm, start/stop/pokeNow
│   │   ├── playback-tracker.js     # diffPlayback(prev, curr, now, openedTrackKey) -> PlaybackEvent[] — PURO
│   │   ├── controller.js           # orquestrador: reage a eventos, aplica modos, prevenção de loop, debounce
│   │   ├── spotify-auth.js         # PKCE, launchWebAuthFlow, troca de code, refresh single-flight, logout
│   │   ├── spotify-api.js          # spotifyFetch() com 401/429/5xx; getPlayer(), play(), pause(), getDevices(), searchTracks(), addToQueue()
│   │   ├── youtube-html.js         # extractJsonAssignment(html, varName) — PURO (brace matching)
│   │   ├── youtube-search.js       # searchYouTube(query) -> Candidate[]; parseSearchData(ytInitialData) — parser PURO
│   │   ├── youtube-watch-meta.js   # getVideoMeta(videoId) -> VideoMeta (fetch watch page, ytInitialPlayerResponse)
│   │   ├── youtube-data-api.js     # fallback opcional com API key: searchViaDataApi(query, key) -> Candidate[]
│   │   ├── clip-ranker.js          # buildQuery(track), scoreCandidate(c, track), rankCandidates() — PURO
│   │   ├── clip-finder.js          # findClip(track, {force}) -> ClipResult; usa cache, scraper, Data API, fallback
│   │   ├── clip-cache.js           # get/put/markRejected/clear/prune do cache trackKey -> ClipEntry
│   │   ├── tab-manager.js          # aba SpotyTube: ensure/navigate/focus/onRemoved; buildWatchUrl()
│   │   ├── yt-to-spotify.js        # pipeline YouTube -> Spotify; parseVideoTitle(), scoreTrackMatch() (puros)
│   │   ├── loop-guard.js           # TTL sets: extOpenedVideos, extPlayedTracks, ytVideoCooldown
│   │   ├── messaging.js            # router de chrome.runtime.onMessage; broadcastState()
│   │   └── badge.js                # setBadge(status)
│   ├── content/
│   │   └── youtube.js              # content script CLÁSSICO (sem import), autocontido; SPA + controle do <video>
│   ├── popup/
│   │   ├── popup.html  popup.css  popup.js
│   └── options/
│       ├── options.html  options.css  options.js
└── tests/
    ├── README.md                   # como rodar: `node --test tests/` (Node ≥ 20, só dev, sem npm install)
    ├── fixtures/
    │   ├── yt-search-*.html        # HTMLs salvos de results?search_query=... (capturados manualmente)
    │   └── yt-watch-*.html
    ├── text-normalize.test.js
    ├── clip-ranker.test.js
    ├── youtube-search.test.js      # extractJsonAssignment + parseSearchData com fixtures
    ├── playback-tracker.test.js
    └── yt-to-spotify.test.js       # parseVideoTitle, scoreTrackMatch
```

**Regras de módulo**
- Módulos marcados PURO não podem referenciar `chrome.*` nem `fetch` (testáveis com `node --test`).
- Content scripts declarados no manifest **não** suportam ES modules → `src/content/youtube.js` é um arquivo único, IIFE, com as poucas constantes que precisa duplicadas no topo (comentário `// mirror of constants.js`).
- Popup/options carregam `<script type="module" src="popup.js">` e importam de `../shared/*`.
- `service-worker.js` é declarado com `"type": "module"`; **não** use `import()` dinâmico no SW (proibido em SW). Imports estáticos apenas.
- Todos os listeners (`runtime.onMessage`, `alarms.onAlarm`, `tabs.onRemoved`, `runtime.onStartup`, `runtime.onInstalled`, `commands.onCommand`, `storage.onChanged`) registrados sincronamente no topo de `service-worker.js`, antes de qualquer `await`.

### 1.1 Tipos (JSDoc, definir em `src/shared/messages.js` ou num `types.js` só com typedefs)

```js
/** @typedef {'sync'|'handoff'|'open'} ClipMode */
/** @typedef {'play-mute-video'|'play-pause-video'|'queue'} YtToSpotifyAction */

/** Faixa normalizada a partir do item do Spotify
 * @typedef {Object} Track
 * @property {string} key          // trackKey: item.id, ou 'local:'+normalize(artist+'|'+name) se is_local/id null
 * @property {string|null} id
 * @property {string} uri
 * @property {string} name         // original
 * @property {string[]} artists    // nomes, ordem do Spotify
 * @property {string} album
 * @property {number} durationMs
 * @property {boolean} isLocal
 * @property {string|null} imageUrl // album.images menor >= 64px
 */

/** Snapshot de playback
 * @typedef {Object} PlaybackSnapshot
 * @property {'playing'|'paused'|'no_device'|'unsupported'} status  // unsupported = ad/episode/unknown
 * @property {Track|null} track
 * @property {number} progressMs
 * @property {number} sampledAt     // Date.now() no recebimento da resposta
 * @property {string|null} deviceId
 * @property {string|null} deviceName
 * @property {'off'|'track'|'context'} repeatState
 */

/** Candidato de vídeo
 * @typedef {Object} Candidate
 * @property {string} videoId
 * @property {string} title
 * @property {string} channel
 * @property {string|null} channelUrl     // '/@handle' ou '/channel/UC..'
 * @property {number|null} durationSec
 * @property {number|null} views
 * @property {'oac'|'verified'|null} badge
 * @property {boolean} isLive
 * @property {number} position            // índice 0-based nos resultados
 * @property {number} [score]
 * @property {string[]} [reasons]         // ex.: ['+official video 25','-lyrics 40'] (debug/popup)
 */

/** Entrada de cache
 * @typedef {Object} ClipEntry
 * @property {string} trackKey
 * @property {string|null} videoId        // null = fallback de busca
 * @property {Candidate[]} candidates     // ordenados por score desc, máx CANDIDATES_KEEP
 * @property {number} chosenIndex
 * @property {string[]} rejected          // videoIds rejeitados via "próximo candidato"
 * @property {string} query
 * @property {'scrape'|'data-api'|'search-fallback'} source
 * @property {number} offsetMs            // ajuste de sync por clipe (default 0)
 * @property {number} cachedAt
 * @property {number} lastUsedAt
 */
```

---

## 2. manifest.json (completo)

```json
{
  "manifest_version": 3,
  "name": "SpotyTube",
  "version": "0.1.0",
  "description": "Abre o videoclipe oficial do que está tocando no Spotify e toca no Spotify o que você abre no YouTube.",
  "minimum_chrome_version": "116",
  "icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "background": { "service_worker": "src/background/service-worker.js", "type": "module" },
  "action": {
    "default_title": "SpotyTube",
    "default_popup": "src/popup/popup.html",
    "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png" }
  },
  "options_ui": { "page": "src/options/options.html", "open_in_tab": true },
  "permissions": ["identity", "storage", "alarms"],
  "host_permissions": [
    "https://api.spotify.com/*",
    "https://accounts.spotify.com/*",
    "https://www.youtube.com/*"
  ],
  "optional_host_permissions": ["https://www.googleapis.com/*"],
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/*"],
      "js": ["src/content/youtube.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "commands": {
    "next-candidate": { "suggested_key": { "default": "Alt+Shift+N" }, "description": "Próximo candidato de clipe" },
    "toggle-enabled": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "Pausar/retomar SpotyTube" }
  }
}
```

Justificativas:
- **Sem `"tabs"`**: `chrome.tabs.create/update/get/onRemoved` funcionam sem ela; `tab.url` de abas `youtube.com` fica visível pela host permission. Não precisamos da URL de outras abas.
- **Sem `"scripting"`**: content script é declarativo. Abas do YouTube abertas **antes** da instalação/reload não têm o script — aceitável (a aba SpotyTube é sempre criada/navegada pela extensão, então recebe o script). Popup mostra dica "recarregue abas do YouTube abertas antes".
- **Sem `"notifications"`**: feedback por badge + popup.
- **`googleapis.com` opcional**: options page chama `chrome.permissions.request({origins:['https://www.googleapis.com/*']})` ao salvar uma API key (gesto do usuário).
- **ID estável (recomendado)**: com "Load unpacked" o ID deriva do caminho da pasta; se a pasta mudar de lugar, a redirect URI muda. Opcional: adicionar `"key"` (public key base64) ao manifest para fixar o ID. Em qualquer caso a options page mostra a redirect URI atual.
- `music.youtube.com` e `m.youtube.com` ficam **fora de escopo** na v1.

### 2.1 `src/shared/constants.js` (valores normativos)

```js
// --- Polling (ms) ---
export const POLL_PLAYING_MS = 5000;        // tocando, longe do fim (cota do Development Mode é baixa)
export const POLL_NEAR_END_GRACE_MS = 400;  // agenda poll em remaining + grace
export const POLL_MIN_MS = 800;             // piso absoluto entre polls
export const POLL_PAUSED_MS = 10_000;
export const POLL_NO_DEVICE_MS = 15_000;    // 204 / sem device / ad / episode
export const POLL_MAX_LOOP_MS = 20000;      // NUNCA agendar tick > 20s com loop ativo (idle timer do SW = 30s)
export const IDLE_AFTER_MS = 10 * 60_000;   // sem tocar por 10 min -> modo idle (só alarm)
export const WATCHDOG_ALARM = 'spotytube-watchdog';
export const WATCHDOG_PERIOD_MIN = 0.5;     // 30s (mínimo permitido)
export const BACKOFF_BASE_MS = 5000;        // rede/5xx: 5s,10s,20s,40s,60s
export const BACKOFF_MAX_MS = 60_000;
export const FETCH_TIMEOUT_MS = 8000;       // AbortSignal.timeout em todo fetch
export const TOKEN_REFRESH_SKEW_MS = 60_000;

// --- Detecção / debounce ---
export const SEEK_DETECT_THRESHOLD_MS = 3000;     // |progress - esperado| > 3s => SEEKED
export const RESTART_MAX_PROGRESS_MS = 5000;      // ver 4.3 (TRACK_RESTARTED)
export const MIN_TAB_NAV_INTERVAL_MS = 1500;      // entre navegações da aba SpotyTube (latest wins)

// --- Sync (content script espelha) ---
export const SYNC_DRIFT_MAX_MS = 2000;      // corrigir drift > 2s
export const SYNC_SEEK_COOLDOWN_MS = 3000;  // não re-seekar antes disso
export const SYNC_CHECK_INTERVAL_MS = 1000; // timer local do CS
export const SYNC_URL_LEAD_MS = 1500;       // somado ao &t= p/ compensar load da página
export const MUTE_ENFORCE_WINDOW_MS = 8000; // reaplica muted em volumechange nesse período após load
export const USER_GESTURE_WINDOW_MS = 3000; // ação "do usuário" se houve gesto confiável há < 3s

// --- Loop guard (TTL) ---
export const EXT_VIDEO_TTL_MS = 15 * 60_000;
export const EXT_TRACK_TTL_MS = 2 * 60_000;
export const YT_VIDEO_COOLDOWN_MS = 10 * 60_000;
export const YT_TO_SP_DEBOUNCE_MS = 2000;

// --- Ranking clipe ---
export const CLIP_ACCEPT_SCORE = 40;        // abaixo => 2ª query; ainda abaixo => fallback busca
export const CLIP_MIN_TITLE_COVERAGE = 0.5;
export const CANDIDATES_KEEP = 10;
export const CACHE_MAX_ENTRIES = 1000;
export const CACHE_TTL_MS = 60 * 24 * 3600_000; // 60 dias

// --- YouTube -> Spotify ---
export const YT_MATCH_AUTOPLAY = 0.72;
export const YT_MATCH_SUGGEST = 0.50;
export const YT_MUSIC_MIN_SEC = 60;
export const YT_MUSIC_MAX_SEC = 15 * 60;
export const SPOTIFY_SEARCH_LIMIT = 10;
```

---

## 3. Storage

### 3.1 `chrome.storage.local` (persistente)

| Chave | Formato | Notas |
|---|---|---|
| `settings` | `Settings` | merge com `DEFAULT_SETTINGS` na leitura |
| `auth` | `{ accessToken, expiresAt:number, refreshToken, scope }` | ausente = deslogado |
| `clip:<trackKey>` | `ClipEntry` | uma chave por faixa (writes pequenos) |
| `clipIndex` | `{ [trackKey]: lastUsedAt }` | LRU; `pruneCache()` no boot e após `put` quando > `CACHE_MAX_ENTRIES` (remove os 10% mais antigos) |
| `parserHealth` | `{ lastOkAt, lastFailAt, consecutiveFails, lastError }` | popup avisa se `consecutiveFails >= 3` |

```js
/** @typedef {Object} Settings
 * @property {string} clientId               // '' até configurar
 * @property {boolean} enabled               // master switch ("Pausar SpotyTube" => false). default true
 * @property {boolean} spotifyToYoutube      // default true
 * @property {boolean} youtubeToSpotify      // default false
 * @property {ClipMode} mode                 // default 'sync'
 * @property {YtToSpotifyAction} ytAction    // default 'play-mute-video'
 * @property {boolean} focusTab              // default false (atualiza em background)
 * @property {boolean} pinTab                // default false
 * @property {string} ytApiKey               // '' = desativado
 * @property {string|null} preferredDeviceId // usado em NO_ACTIVE_DEVICE
 * @property {boolean} debug                 // default false
 */
```

`settings.js` expõe `DEFAULT_SETTINGS`, `getSettings()`, `setSettings(partial)` (merge + grava) e o SW reage via `chrome.storage.onChanged` (área `local`, chave `settings`) → `controller.onSettingsChanged(old, new)`.

### 3.2 `chrome.storage.session` (some ao fechar o browser; sobrevive à morte do SW)

| Chave | Formato |
|---|---|
| `rt` | `RuntimeState` — espelho do estado em memória; gravado a cada tick (é também o keep-alive) |
| `pkce` | `{ verifier, state, createdAt }` durante o login |
| `guard` | `{ extOpenedVideos:{[videoId]:expiresAt}, extPlayedTracks:{[trackKey]:expiresAt}, ytCooldown:{[videoId]:expiresAt} }` |

```js
/** @typedef {Object} RuntimeState
 * @property {'needs_setup'|'logged_out'|'disabled'|'idle'|'polling'|'error'} status
 * @property {PlaybackSnapshot|null} playback
 * @property {{trackKey:string, videoId:string|null, title:string, channel:string, source:string, candidateIndex:number, candidateCount:number}|null} currentClip
 * @property {number|null} spotyTabId              // tab ids não sobrevivem ao restart do browser => session é o lugar certo
 * @property {string|null} spotyTabExpectedVideoId
 * @property {{tabId:number, videoId:string, trackKey:string, offsetMs:number}|null} syncTarget
 * @property {{trackUri:string, name:string, artists:string, score:number, sourceVideoId:string}|null} suggestion
 * @property {{trackKey:string, at:number}|null} handoff   // modo handoff ativo p/ essa faixa
 * @property {number} lastPollAt
 * @property {number} lastPlayingAt
 * @property {number} backoffUntil
 * @property {number} consecutiveErrors
 * @property {{code:string, message:string, at:number}|null} lastError
 * @property {number} lastTabNavAt
 */
```

`state.js`: `let rt` em memória; `loadState()` no boot lê `storage.session` (o SW pode ter morrido); `patchState(partial)` faz merge, agenda `storage.session.set({rt})` (microtask coalescida) e chama `broadcastState()`.
Não alterar `storage.session.setAccessLevel` (o content script recebe tudo por mensagem).

---

## 4. OAuth Spotify (`spotify-auth.js`)

```js
export async function login()            // interativo; chamado a partir de clique no popup/options
export async function logout()
export async function getAccessToken({ forceRefresh = false } = {}) // -> string; lança AuthError('LOGGED_OUT'|'REVOKED')
export function getRedirectUri()         // chrome.identity.getRedirectURL() => "https://<ext-id>.chromiumapp.org/"
```

`login()`:
1. `clientId` vazio → `AuthError('NEEDS_SETUP')`.
2. `verifier` = 64 bytes `crypto.getRandomValues` → base64url. `challenge` = base64url(SHA-256(verifier)) via `crypto.subtle.digest`. `state` = 16 bytes base64url. Salvar `pkce` em `storage.session`.
3. URL: `https://accounts.spotify.com/authorize?response_type=code&client_id=…&scope=user-read-currently-playing%20user-read-playback-state%20user-modify-playback-state&redirect_uri=<encodeURIComponent(getRedirectUri())>&code_challenge_method=S256&code_challenge=…&state=…`
4. `const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true })`. Ler `new URL(redirect).searchParams`; `error` → `AuthError('DENIED')`; `state` diferente → `AuthError('STATE_MISMATCH')`.
5. `POST https://accounts.spotify.com/api/token` (`application/x-www-form-urlencoded`): `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier`.
6. Salvar `auth = { accessToken, refreshToken, expiresAt: Date.now() + expires_in*1000, scope }`; remover `pkce`; `poller.start()`.

`getAccessToken()`:
- sem `auth` → `AuthError('LOGGED_OUT')`.
- `forceRefresh || expiresAt - Date.now() < TOKEN_REFRESH_SKEW_MS` → `refresh()`.
- `refresh()` é **single-flight** (`let refreshPromise = null`; concorrentes aguardam a mesma promise; `finally` zera).
- `POST /api/token`: `grant_type=refresh_token, refresh_token, client_id`. Se vier `refresh_token` novo, substituir; senão manter.
- `400` com `error=invalid_grant` → revogado: remove `auth`, `status='logged_out'`, badge `!`, `poller.stop()`, lança `AuthError('REVOKED')`.
- Erro de rede no refresh → `NetworkError` (o poller faz backoff); **não** desloga.

`logout()`: remove `auth`, `poller.stop()`, limpa `playback/currentClip/syncTarget`. Spotify não tem endpoint de revogação → options mostra "remova o acesso em https://www.spotify.com/account/apps/".

---

## 5. Spotify API (`spotify-api.js`)

```js
export async function spotifyFetch(path, { method='GET', query, body, retryOn401=true } = {}) // -> {status, data, headers}
export async function getPlayer()                           // GET /v1/me/player?additional_types=episode -> PlaybackSnapshot
export async function play({ uris, positionMs, deviceId })  // PUT /v1/me/player/play[?device_id=]  body {uris, position_ms}
export async function pause({ deviceId } = {})              // PUT /v1/me/player/pause
export async function getDevices()                          // GET /v1/me/player/devices -> Device[]
export async function searchTracks(q, limit = SPOTIFY_SEARCH_LIMIT) // GET /v1/search?type=track&q=&limit=
export async function addToQueue(uri, deviceId)             // POST /v1/me/player/queue?uri=
```

Regras de `spotifyFetch`:
- `Authorization: Bearer ${await getAccessToken()}`; `signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)`.
- `401` → uma única vez `getAccessToken({forceRefresh:true})` e repete; 2º 401 → `AuthError('REVOKED')`.
- `429` → `Retry-After` (segundos; ausente = 5) → lança `RateLimitError(retryAfterMs)`. Não repetir internamente; o poller seta `backoffUntil = now + retryAfterMs + rand(0..500)`.
- `5xx` → `ServerError`. `TypeError`/`AbortError`/`TimeoutError` → `NetworkError`.
- `404` com `error.reason === 'NO_ACTIVE_DEVICE'` → `NoDeviceError`. `403` (ex.: `PREMIUM_REQUIRED`, ação restrita) → `PlayerRestrictedError(reason)`.
- `200/202/204` em comandos de player = sucesso. `204` em GET → `data:null`.
- Erros são classes em `spotify-api.js` estendendo `Error` com `code` string (usado na UI).

`getPlayer()` → `toSnapshot(json, sampledAt)` (PURO, exportado p/ teste):
- `204`/`null` → `{status:'no_device', track:null, progressMs:0}`.
- `currently_playing_type` em `'ad'|'episode'|'unknown'` ou `item == null` → `{status:'unsupported', track:null}` (ignorar; não mexer na aba).
- `item.type === 'track'` → `Track`: `key = item.id ?? ('local:' + normalize(item.artists.map(a=>a.name).join(',') + '|' + item.name))`; `isLocal = item.is_local === true`.
- `status = is_playing ? 'playing' : 'paused'`; `deviceId/deviceName` de `device`; `repeatState = repeat_state`.
- `sampledAt = Date.now()` no recebimento (não usar `json.timestamp`).

> Nota 2026: o Spotify vem restringindo apps em Development Mode (nº de usuários, campos e limites de alguns endpoints). Não dependa de `popularity`, `available_markets` nem de `limit > 10` em `/search`. Se o dashboard exigir, cadastre o próprio e-mail em *User Management* do app.

---

## 6. Polling no MV3 (`poller.js`)

### 6.1 Decisão

**Loop `setTimeout` no service worker + keep-alive por chamada de API de extensão a cada tick + `chrome.alarms` de 30 s como watchdog/despertador.**

| Opção | Veredito |
|---|---|
| Loop `setTimeout` no SW, cada tick chama `chrome.storage.session.set` | **Escolhida.** Desde Chrome 110 cada chamada de API de extensão/evento reinicia o idle timer de 30 s, e não há mais limite fixo de 5 min de vida. Tick ≤ 20 s (`POLL_MAX_LOOP_MS`) ⇒ SW nunca fica 30 s ocioso enquanto o loop roda. Latência de detecção = intervalo de poll (2,5 s). |
| `chrome.alarms` sozinho | Rejeitada como mecanismo principal: mínimo 30 s ⇒ detecção de 0–30 s. Usada como **watchdog** e como polling lento no modo idle. |
| Offscreen document | Rejeitada: exige `reason` legítimo (nenhum cobre "polling de API"), mais permissão (`offscreen`) e mais um contexto para sincronizar. |
| Port de content script | Rejeitada: só existe com aba do YouTube aberta; Spotify→YouTube precisa funcionar antes de existir qualquer aba. (Mensagens do CS ainda acordam o SW naturalmente — bônus, não dependência.) |

Degradação: se o SW for morto mesmo assim (update do Chrome, crash, política futura), o alarm acorda o SW em ≤ 30 s, `onAlarm` chama `poller.ensureRunning()` e o loop recomeça. Pior caso = 30 s de atraso, nunca parada total.

### 6.2 API

```js
export function start()            // idempotente; cria alarm; agenda tick imediato
export function stop()             // limpa timer; chrome.alarms.clear(WATCHDOG_ALARM); status 'disabled'/'logged_out'
export function ensureRunning()    // se deveria rodar e não há timer em memória -> tick imediato
export function pokeNow(reason)    // cancela timer e roda tick já (popup aberto, mensagem de CS, comando); respeita backoffUntil e POLL_MIN_MS
export function shouldRun(settings, auth, rt) // PURO: enabled && auth && (spotifyToYoutube || rt.syncTarget || rt.handoff)
export function computeNextDelay(snapshot, rt, now) // PURO, ver 6.3
```

Estado em memória do módulo: `let timer = null; let inFlight = false; let loopMode = 'fast'|'idle';`

`tick()`:
```
if inFlight return; inFlight = true
try:
  if !shouldRun(...) -> stop(); return
  if now < rt.backoffUntil -> schedule(rt.backoffUntil - now); return
  snap = await spotifyApi.getPlayer()
  events = diffPlayback(rt.playback, snap, now)        // playback-tracker.js
  patchState({ playback: snap, lastPollAt: now, consecutiveErrors: 0, lastError: null,
               lastPlayingAt: snap.status==='playing' ? now : rt.lastPlayingAt })
  await controller.handleEvents(events, snap)          // NÃO aguardar a busca do clipe: controller dispara findClip sem bloquear o tick (ver 7)
  schedule(computeNextDelay(snap, rt, now))
catch e:
  RateLimitError -> backoffUntil = now + e.retryAfterMs + jitter; schedule(...)
  AuthError      -> stop(); status 'logged_out'
  Network/Server -> consecutiveErrors++; delay = min(BACKOFF_BASE_MS * 2^(n-1), BACKOFF_MAX_MS); status 'error' se n>=3; schedule(delay)
finally:
  inFlight = false
  await chrome.storage.session.set({ rt, heartbeat: Date.now() })   // keep-alive explícito, sempre
```

`schedule(ms)`: `clearTimeout(timer)`; se `loopMode==='idle'` **não** agenda (só o alarm acorda); senão `timer = setTimeout(tick, clamp(ms, POLL_MIN_MS, POLL_MAX_LOOP_MS))`. Note que backoff > 20 s é quebrado em ticks de 20 s que apenas re-verificam `backoffUntil` (mantém SW vivo e o alarm é redundante).

### 6.3 Polling adaptativo — `computeNextDelay(snap, rt, now)`

```
switch snap.status:
  'playing':
     remaining = snap.track.durationMs - snap.progressMs
     if remaining <= POLL_PLAYING_MS: return max(remaining + POLL_NEAR_END_GRACE_MS, POLL_MIN_MS)
     return POLL_PLAYING_MS
  'paused':      return now - rt.lastPlayingAt > IDLE_AFTER_MS ? IDLE : POLL_PAUSED_MS
  'no_device', 'unsupported':
                 return now - rt.lastPlayingAt > IDLE_AFTER_MS ? IDLE : POLL_NO_DEVICE_MS
```
`IDLE` ⇒ `loopMode='idle'`, timer limpo, SW pode morrer; o alarm de 30 s executa `tick()`; se o snapshot voltar a `'playing'`, `loopMode='fast'` e o loop rápido recomeça.

Orçamento: tocando ≈ 1 req/2,5 s ≈ 1.440 req/h — aceitável para 1 usuário. Pausado 900/h, sem device 450/h, idle 120/h.

### 6.4 Liga/desliga e gatilhos

- `settings.enabled=false` (popup "Pausar SpotyTube" ou `Alt+Shift+S`) → `stop()`, badge `OFF`, CS recebe `SW_STOP_SYNC`. `true` → `start()`.
- `runtime.onStartup`, `runtime.onInstalled`, `alarms.onAlarm(WATCHDOG_ALARM)`, qualquer `onMessage` → `await loadState(); poller.ensureRunning()`.
- Popup abriu (`GET_STATE`) e `now - lastPollAt > 4000` → `pokeNow('popup')`.
- Login concluído → `start()`. Logout/revogado → `stop()`.
- Alarm: `chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN })` em `start()` (create com mesmo nome substitui; ok).

### 6.5 `playback-tracker.js` — `diffPlayback(prev, curr, now, openedTrackKey)` (PURO)

`openedTrackKey` = `rt.currentClip?.trackKey ?? null` (passado pelo poller: `diffPlayback(rt.playback, snap, now, rt.currentClip?.trackKey ?? null)`).

```js
/** @typedef {{type:'TRACK_CHANGED'|'PLAY_STATE_CHANGED'|'SEEKED'|'TRACK_RESTARTED'|'STOPPED'|'UNSUPPORTED', track?:Track, prevTrack?:Track}} PlaybackEvent */
```
Regras (avaliadas em ordem; pode emitir mais de um):
1. `curr.status` ∈ {`no_device`} e `prev` tinha track → `STOPPED`.
2. `curr.status === 'unsupported'` → `UNSUPPORTED` (controller não faz nada além de parar sync — `SW_SYNC` com `isPlaying:false`).
3. `prev?.track && curr.track && curr.track.key !== prev.track.key` → `TRACK_CHANGED`. Se `prev?.track` é null (primeiro poll, ou vindo de `no_device`/`unsupported`) ver regra 6.
4. Mesma faixa: `expected = prev.progressMs + (prev.status==='playing' ? now - prev.sampledAt : 0)`.
   - `prev.progressMs >= RESTART_MAX_PROGRESS_MS + POLL_PLAYING_MS && curr.progressMs < RESTART_MAX_PROGRESS_MS && expected - curr.progressMs > SEEK_DETECT_THRESHOLD_MS` → `TRACK_RESTARTED` (repeat-one ou "voltar"). Também emitir se `expected >= durationMs` e `curr.progressMs < RESTART_MAX_PROGRESS_MS` (fim → recomeço com repeat-one).
   - senão `|curr.progressMs - expected| > SEEK_DETECT_THRESHOLD_MS` → `SEEKED`.
5. `prev.status !== curr.status` (playing↔paused) → `PLAY_STATE_CHANGED`.
6. `!prev?.track && curr.track`: emitir `TRACK_CHANGED` **somente se** `openedTrackKey !== curr.track.key` (evita reabrir a mesma música após restart do SW/browser ou depois de um podcast). Regras 4–5 não se aplicam neste caso.

Nota: `prev` vem de `rt.playback`, que sobrevive à morte do SW (storage.session); só é null no primeiro poll após abrir o browser/login.

---

## 7. Controller — Spotify → YouTube (`controller.js`)

```js
export async function handleEvents(events, snap)
export async function onTrackChanged(track, snap)      // dispara pipeline (não bloqueia o tick)
export async function nextCandidate()                  // popup / comando
export async function reopenClip()
export async function onContentMessage(msg, sender)    // ver 9/10
export async function onSettingsChanged(prev, next)
```

Estado do módulo: `let generation = 0;` (incrementa a cada `TRACK_CHANGED`), `let pendingNav = null` (timer de navegação adiada).

### 7.1 `onTrackChanged(track, snap)`
```
gen = ++generation
if !settings.spotifyToYoutube: return
if loopGuard.isExtPlayedTrack(track.key):           // faixa que NÓS mandamos tocar (YT->SP)
   -> não abre clipe; syncTarget continua a aba de origem (definida no pipeline YT->SP); return
if rt.syncTarget && rt.syncTarget.trackKey !== track.key && rt.syncTarget.tabId !== rt.spotyTabId:
   -> send SW_STOP_SYNC à aba vinculada; syncTarget = null   // aba manual do usuário deixa de ser seguida
clip = await clipFinder.findClip(track)               // cache -> scrape -> data api -> fallback
if gen !== generation: return                         // pulos rápidos: resultado obsoleto descartado
await openClip(track, clip, rt.playback)             // snapshot MAIS RECENTE (a busca pode ter levado 1-2 s)
```
`openClip(track, clip, snap)`:
```
mode = settings.mode
posMs = projectedProgress(snap)  // snap.progressMs + (playing ? Date.now()-snap.sampledAt : 0)
switch mode:
  'sync':    url = buildWatchUrl(videoId, (posMs + offsetMs + SYNC_URL_LEAD_MS)/1000)
  'handoff': await spotifyApi.pause(); url = buildWatchUrl(videoId, posMs/1000); rt.handoff = {trackKey, at}
  'open':    url = buildWatchUrl(videoId, 0)
if clip.videoId == null: url = clip.searchUrl          // fallback de busca; sem sync
if videoId && videoId === rt.spotyTabExpectedVideoId && (await tabManager.getSpotyTab()):
   -> não navegar (mesmo clipe já aberto, ex.: outra versão da mesma música); só atualizar currentClip/syncTarget e sendSync(snap); return
loopGuard.addExtVideo(videoId)
await tabManager.navigate(url, { expectedVideoId: videoId, role: mode })   // respeita MIN_TAB_NAV_INTERVAL_MS
patchState({ currentClip: {...}, syncTarget: mode==='sync' && videoId ? {tabId, videoId, trackKey, offsetMs} : null })
```
- Ao navegar, o CS da aba recarrega e manda `CS_HELLO`; o SW responde com `SW_SET_ROLE` (ver 10). Não é necessário mandar nada antes do load.

### 7.2 Outros eventos
- `PLAY_STATE_CHANGED` / `SEEKED` / `TRACK_RESTARTED`: se `syncTarget` → `sendSync(snap)` imediatamente. No modo `handoff`: se `snap.status==='playing'` e `rt.handoff.trackKey === snap.track.key` (usuário retomou o Spotify) → `SW_PAUSE_VIDEO` à aba SpotyTube e `rt.handoff = null` (evita áudio duplo; **não** re-pausar o Spotify).
- `TRACK_RESTARTED` em modo `open`/`handoff`: nada. Em `sync`: `SW_SYNC` faz o CS seekar para ~0 (não recarrega a aba).
- `STOPPED`: `SW_SYNC {isPlaying:false}` → vídeo pausa.
- A cada tick com `syncTarget` e `snap.status` ∈ {playing, paused} → `sendSync(snap)` (heartbeat de sync; o CS extrapola entre ticks).

`sendSync(snap)` → `chrome.tabs.sendMessage(syncTarget.tabId, {type:'SW_SYNC', payload:{videoId, isPlaying, progressMs, sampledAt, offsetMs}})`; se lançar "Receiving end does not exist" → ignorar (aba carregando). Se `tabs.get` falhar → `syncTarget=null`.

### 7.3 Pulos rápidos (debounce)
- Sem atraso artificial na detecção. Proteções: (1) `generation` descarta buscas obsoletas; (2) `tabManager.navigate` só navega se `now - lastTabNavAt >= MIN_TAB_NAV_INTERVAL_MS`; senão agenda `pendingNav` para o restante do intervalo, substituindo qualquer `pendingNav` anterior (latest wins); (3) o cache torna repetições instantâneas.
- Mesma faixa repetida (repeat-one, ou `prev.key === curr.key`) **nunca** gera `TRACK_CHANGED` ⇒ não recarrega a aba.

### 7.4 Prefetch (fase 4, opcional)
Quando `remaining < 20 s`, `GET /v1/me/player/queue` → `findClip(queue[0])` em background (só popula cache, sem abrir aba). Limite: 1 prefetch por faixa.

---

## 8. Busca e ranking do clipe

### 8.1 `clip-finder.js` — `findClip(track, { force=false, excludeVideoIds=[] })` → `ClipResult`

```js
/** @typedef {{ videoId:string|null, searchUrl:string, entry:ClipEntry, fromCache:boolean }} ClipResult */
```
```
entry = clipCache.get(track.key)
if entry && !force && now - entry.cachedAt < CACHE_TTL_MS && entry.source !== 'search-fallback':
    touch(entry); return entry.candidates[entry.chosenIndex]
q1 = buildQuery(track, { withOfficial: true })
cands = await scrapeOrApi(q1)             // scrape; se lançar ParserError/Consent/Network e ytApiKey -> data api
ranked = rankCandidates(cands, track).filter(c => !entry?.rejected.includes(c.videoId))
if !ranked[0] || ranked[0].score < CLIP_ACCEPT_SCORE:
    q2 = buildQuery(track, { withOfficial: false })
    ranked = mergeDedup(ranked, rankCandidates(await scrapeOrApi(q2), track)).sort(desc)
if ranked[0]?.score >= CLIP_ACCEPT_SCORE: source scrape/data-api; videoId = ranked[0].videoId
else: source 'search-fallback'; videoId = null
entry = { trackKey, videoId, candidates: ranked.slice(0, CANDIDATES_KEEP), chosenIndex: 0, rejected: entry?.rejected ?? [], query: q1, source, offsetMs: entry?.offsetMs ?? 0, cachedAt: now, lastUsedAt: now }
clipCache.put(entry)   // fallback também é cacheado, mas sem TTL útil (re-tenta na próxima vez)
searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q1)
```
Mesmo no fallback, `candidates` fica salvo (score < limiar) para "próximo candidato" poder escolher manualmente.

### 8.2 Normalização (`text-normalize.js`, PURO)

```js
export function normalize(s)
// s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
//  .replace(/&/g,' and ').replace(/['’`´]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ')
export function tokens(s)            // normalize(s).split(' ') sem stopwords {the,a,an,o,a,os,as,de,da,do,el,la,los,las,le,les}; se ficar vazio, retorna sem filtrar
export function dice(aTokens, bTokens) // 2|A∩B|/(|A|+|B|), 0 se vazio
export function coverage(needle, hay)  // |needle ∩ hay| / |needle|
export function containsPhrase(normHay, normPhrase) // (' '+hay+' ').includes(' '+phrase+' ')
export function parseDuration(text)  // "1:02:03"|"3:45" -> segundos | null
export function parseViews(text)     // "1,234,567 views" -> número | null (hl=en)
export function cleanSpotifyTitle(name) // -> { clean:string, flags:{remix,live,acoustic,instrumental,remaster,edit} }
```
`cleanSpotifyTitle(name)`:
1. `flags` calculados sobre `normalize(name)` com palavras inteiras: `remix|mix` (mas não "remaster"), `live|ao vivo|en vivo`, `acoustic|acustico`, `instrumental`, `remaster|remastered`, `radio edit|edit`.
2. Remover sufixo após ` - ` quando ele casar `/(remaster|remastered|version|versão|edit|mono|stereo|mix|remix|live|ao vivo|acoustic|deluxe|bonus|from |feat|with |single|anniversary|\d{4})/i`. Ex.: "Something - Remastered 2009" → "Something".
3. Remover grupos `(...)`/`[...]` contendo `feat|ft\.|with|com|remaster|version|edit|from|mix|live|ao vivo`.
4. Trim. Se ficar vazio, usar o original.

### 8.3 Query — `buildQuery(track, { withOfficial })`
```
artist = track.artists[0]
q = `${artist} ${cleanSpotifyTitle(track.name).clean}`
if withOfficial: q += ' official video'
if flags.remix:  q += ' remix'           // quando a faixa É remix, buscar remix
if flags.live:   q += ' live'
```
URL de scraping: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en` (`sp` = filtro "Vídeos"; `hl=en` padroniza `lengthText`/`viewCountText`).

### 8.4 Scraper — `youtube-search.js`

```js
export async function searchYouTube(query) // -> Candidate[]; lança ConsentError | ParserError | NetworkError
export function parseSearchData(ytInitialData) // PURO -> Candidate[]
```
Fetch: `fetch(url, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'Accept-Language': 'en-US,en;q=0.9' } })`.
- `res.url` contém `consent.youtube.com` ou HTML sem `ytInitialData` mas com `consent` → `ConsentError` (instruir: abrir youtube.com uma vez e aceitar cookies).
- `extractJsonAssignment(html, 'ytInitialData')` (`youtube-html.js`):
```
markers = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = ']
i = primeiro indexOf de algum marker; se -1 -> null
start = html.indexOf('{', i)
depth=0; inStr=false; esc=false
for j from start:
  ch = html[j]
  if inStr: if esc {esc=false} else if ch=='\\' {esc=true} else if ch=='"' {inStr=false}; continue
  if ch=='"' inStr=true
  else if ch=='{' depth++
  else if ch=='}' { depth--; if depth==0 return JSON.parse(html.slice(start, j+1)) }
return null
```
(Não usar regex `{.*?};</script>` — quebra com `};` dentro de strings.) `JSON.parse` falhou/null → `ParserError('NO_INITIAL_DATA')`.

`parseSearchData(data)`:
```
sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? []
renderers = []
for s in sections: for it in (s.itemSectionRenderer?.contents ?? []): if it.videoRenderer: renderers.push(it.videoRenderer)
if renderers.length == 0: renderers = deepCollect(data, 'videoRenderer', maxDepth=40, max=40)  // fallback robusto a mudanças de caminho
                          + lockups = deepCollect(data, 'lockupViewModel') filtrando contentType 'LOCKUP_CONTENT_TYPE_VIDEO' (best-effort)
dedupe por videoId mantendo ordem; position = índice
map videoRenderer v -> Candidate:
  videoId    = v.videoId
  title      = v.title?.runs?.map(r=>r.text).join('') ?? v.title?.simpleText ?? ''
  channel    = (v.ownerText ?? v.longBylineText ?? v.shortBylineText)?.runs?.[0]?.text ?? ''
  channelUrl = (...)?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ?? null
  durationSec= parseDuration(v.lengthText?.simpleText ?? v.lengthText?.accessibility?.accessibilityData?.label)
  views      = parseViews(v.viewCountText?.simpleText ?? v.viewCountText?.runs?.map(r=>r.text).join(''))
  styles     = (v.ownerBadges ?? []).map(b => b.metadataBadgeRenderer?.style)
  badge      = styles.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST') ? 'oac' : styles.includes('BADGE_STYLE_TYPE_VERIFIED') ? 'verified' : null
  isLive     = (v.badges ?? []).some(b => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW') || !v.lengthText
map lockupViewModel l (best-effort):
  videoId = l.contentId; title = l.metadata?.lockupMetadataViewModel?.title?.content
  channel = l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content
  durationSec = parseDuration(primeiro thumbnailBadgeViewModel.text encontrado via deepCollect em l.contentImage)
  badge = null
descartar sem videoId; descartar isLive; descartar shorts (deepCollect pegou reelItemRenderer -> ignorar essa chave)
```
`deepCollect(obj, key)`: DFS iterativa com pilha, coleta `node[key]` sem descer dentro do coletado.
Resultado vazio com HTTP 200 → `ParserError('NO_RESULTS_PARSED')` e `parserHealth.consecutiveFails++`; sucesso → `consecutiveFails=0, lastOkAt`.

### 8.5 Fallback Data API (`youtube-data-api.js`) — só se `settings.ytApiKey`
1. `GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=<q>&key=<key>` (100 unidades).
2. `GET .../videos?part=contentDetails&id=<ids>&key=<key>` → `durationSec` de ISO-8601 `PT#H#M#S`.
3. Mapear para `Candidate` (`channel=snippet.channelTitle`, `badge=null`, `views=null`, `title` com `decodeHtmlEntities`).
4. `403 quotaExceeded`/`400 keyInvalid` → erro registrado em `lastError`, segue p/ fallback de busca.

### 8.6 Ranking — `scoreCandidate(c, track)` (PURO, `clip-ranker.js`)

Pré-cálculo: `T = normalize(cleanSpotifyTitle(track.name).clean)`, `A = track.artists.map(normalize)`, `A0 = A[0]`, `V = normalize(c.title)`, `Ch = normalize(c.channel)`, `ChCore = Ch` sem sufixos `vevo|official|oficial|topic|tv|music|records` (regex de fim, e `vevo` grudado: `taylorswiftvevo` → `taylorswift`), `trackTerms = normalize(track.name + ' ' + track.album)`, `flags` de `cleanSpotifyTitle`.

Termo negativo **não** penaliza se aparecer em `trackTerms` (ex.: música chamada "Cover Me", "Audio", "Live Forever").

| Regra | Pontos |
|---|---|
| `cov = coverage(tokens(T), tokens(V))`; se `cov < CLIP_MIN_TITLE_COVERAGE` | **−100** (praticamente descarta) |
| título | `+40 * cov` |
| artista `A0` (ou qualquer `A[i]`) como frase em `V` | +20 |
| canal = artista: `ChCore === compact(A0)` ou `Ch` contém `A0` como frase ou `compact(Ch)` começa com `compact(A0)` (`compact` = sem espaços) | +25 |
| canal termina com `vevo` | +20 (+5 extra se também casa artista) |
| `badge==='oac'` | +20 |
| `badge==='verified'` | +8 |
| frase `official music video` | +30 |
| senão `official video` / `video oficial` / `clipe oficial` / `videoclipe` / `videoclip oficial` | +25 |
| senão `mv` / `m v` (k-pop) | +15 |
| senão `official` / `oficial` | +5 |
| `lyric`, `lyrics`, `lyric video`, `letra`, `legendado`, `traducao`, `tradução` | −40 |
| `audio`, `official audio`, `áudio` | −30 |
| `visualizer`, `visualiser` | −35 |
| `live`, `ao vivo`, `en vivo`, `concert`, `show` (se `!flags.live`) | −30 |
| `cover` (se canal não casa artista) | −50 |
| `karaoke`, `instrumental` (se `!flags.instrumental`) | −60 |
| `reaction`, `react`, `reagindo` | −60 |
| `8d`, `slowed`, `sped up`, `speed up`, `reverb`, `nightcore`, `bass boosted` | −60 |
| `remix` (se `!flags.remix`) | −35 |
| `full album`, `album completo`, `tutorial`, `how to play`, `guitar lesson`, `drum cover` | −60 |
| `teaser`, `trailer`, `preview` | −25 |
| `behind the scenes`, `making of`, `bastidores` | −40 |
| canal termina com `topic` (auto-gerado, é só áudio) | −25 |
| duração: `d = |c.durationSec - track.durationMs/1000|`: d ≤ 10 → +15; ≤ 30 → +10; ≤ 90 → +3; > 120 → −15; > 600 → −40; `durationSec < 60` → −40; null → 0 | |
| relevância do YouTube: `+max(0, 10 - c.position)` | 0..+10 |
| views: `views ? min(12, 2*log10(views)) : 0` | 0..+12 |

Frases buscadas com `containsPhrase(V, ...)`. As categorias "official…" são **mutuamente exclusivas** (pega a maior). Negativos acumulam. `reasons[]` registra cada regra aplicada (`'+oac 20'`), útil no popup/debug.

`rankCandidates(cands, track)` → `cands.map(c => ({...c, ...scoreCandidate(c, track)})).sort((a,b)=>b.score-a.score)`.

Calibração de referência (testes unitários devem cobrir): "Artist - Song (Official Music Video)" em canal VEVO/OAC, duração +40 s ⇒ ~40+20+25+20+20+30+3+10+12 ≈ 180; "Artist - Song (Lyrics)" de canal aleatório ⇒ ~40+20−40+15+... ≈ 50–60; vídeo errado com cov 0 ⇒ < 0. Limiar `CLIP_ACCEPT_SCORE = 40`.

### 8.7 Cache (`clip-cache.js`)
```js
export async function get(trackKey)           // ClipEntry|null
export async function put(entry)              // grava clip:<key> + clipIndex; prune se necessário
export async function touch(trackKey)
export async function setChosen(trackKey, index)
export async function markRejected(trackKey, videoId)
export async function setOffset(trackKey, offsetMs)
export async function clear()                 // remove todas as clip:* e clipIndex
export async function count()
export async function prune()
```

### 8.8 Próximo candidato (`controller.nextCandidate()`)
```
entry = cache.get(rt.currentClip.trackKey)
markRejected(current videoId)
next = primeiro índice i > chosenIndex cujo videoId não está em rejected; se não houver -> se rejected cobre todos, findClip(track,{force:true}) com excludes; se ainda nada -> abrir searchUrl
setChosen(i); openClip(track, next, snapshot atual)  // mesma lógica de modo/posição
```
Rejeição persiste: a faixa abre direto o candidato escolhido nas próximas vezes (é o que `chosenIndex` guarda).

---

## 9. Aba SpotyTube (`tab-manager.js`)

```js
export function buildWatchUrl(videoId, startSec) // `https://www.youtube.com/watch?v=${id}` + (startSec>=1 ? `&t=${Math.floor(startSec)}s` : '')
export async function getSpotyTab()               // tab|null: chrome.tabs.get(rt.spotyTabId) com try/catch
export async function navigate(url, { expectedVideoId, role })  // cria ou reutiliza; respeita MIN_TAB_NAV_INTERVAL_MS
export function onTabRemoved(tabId)               // listener registrado no topo do SW
export async function focusSpotyTab()             // popup "Ir para a aba"
```
`navigate()`:
```
wait = MIN_TAB_NAV_INTERVAL_MS - (now - rt.lastTabNavAt); if wait > 0: substituir pendingNav e agendar; return
tab = await getSpotyTab()
if tab:
   await chrome.tabs.update(tab.id, { url, active: settings.focusTab, ...(settings.pinTab ? {pinned:true} : {}) })
   if settings.focusTab: await chrome.windows.update(tab.windowId, { focused: true })
else:
   tab = await chrome.tabs.create({ url, active: settings.focusTab, pinned: settings.pinTab })
patchState({ spotyTabId: tab.id, spotyTabExpectedVideoId: expectedVideoId, lastTabNavAt: now })
```
- `tabId` em `storage.session` (ids não valem após restart do browser — e session é limpo exatamente nesse momento).
- `chrome.tabs.onRemoved(tabId)`: se `tabId === rt.spotyTabId` → `spotyTabId=null, spotyTabExpectedVideoId=null`; se `=== syncTarget.tabId` → `syncTarget=null`. Na próxima música, recria.
- Usuário arrastou a aba para outra janela: `tabs.get` continua válido — ok.
- Sempre navegação completa via `tabs.update({url})` (1–2 s de load). Navegação SPA interna não é confiável a partir do isolated world — fora de escopo.
- `focusTab=false`: a aba atualiza em background; YouTube autoplay **mudo** é sempre permitido pelo Chrome; áudio em background (modo `handoff`) normalmente toca porque o youtube.com tem alto Media Engagement Index; se bloquear, CS reporta `autoplay-blocked` (ver 12).

---

## 10. Content script (`src/content/youtube.js`)

Arquivo clássico em IIFE. Nenhum `import`. Duplicar no topo: `SYNC_DRIFT_MAX_MS=2000, SYNC_SEEK_COOLDOWN_MS=3000, SYNC_CHECK_INTERVAL_MS=1000, MUTE_ENFORCE_WINDOW_MS=8000, USER_GESTURE_WINDOW_MS=3000`.

### 10.1 Estado local
```js
let role = 'normal';         // 'normal' | 'spotytube' | 'linked'   (linked = aba do usuário vinculada pelo YT->SP)
let mode = null;             // ClipMode quando role != 'normal'
let expectedVideoId = null;
let sync = null;             // {videoId, isPlaying, progressMs, sampledAt, offsetMs, receivedAt}
let lastSeekAt = 0, loadedAt = Date.now();
let lastGestureAt = 0;       // pointerdown/keydown com isTrusted, capture:true, no document
let userPausedAt = 0, userUnmuted = false;
let currentVideoId = null, navStartGestureAt = 0;
```

### 10.2 Navegação SPA
- `document.addEventListener('yt-navigate-start', () => navStartGestureAt = lastGestureAt)`.
- `document.addEventListener('yt-navigate-finish', onNavigate)` + chamada inicial `onNavigate()` no load (document_idle).
- Também `window.addEventListener('popstate', ...)` → `onNavigate` (defensivo).
- `onNavigate()`:
```
vid = new URL(location.href).searchParams.get('v') se pathname === '/watch'; senão null
if vid === currentVideoId: return
currentVideoId = vid; userPausedAt = 0; userUnmuted = false; loadedAt = now
userInitiated = (now - navStartGestureAt < USER_GESTURE_WINDOW_MS) || isFullPageLoadNotFromExtension
send CS_VIDEO_CHANGED { videoId: vid, url, title, channel, durationSec, userInitiated, visible: document.visibilityState==='visible' }
attachVideo()   // espera <video> (MutationObserver/polling 250ms até 10s)
```
- Primeira execução após load completo envia antes `CS_HELLO {videoId, url}` e aplica a resposta `SW_SET_ROLE` (resposta síncrona do `sendMessage`).
- `isFullPageLoadNotFromExtension`: no load inicial `userInitiated = true` (o SW decide comparando com `expectedVideoId` — se igual, foi a extensão).
- Leitura de metadados (DOM, best-effort; o SW confirma via watch page): título `document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent` ou `document.title.replace(/ - YouTube$/,'')`; canal `#owner #channel-name a`?.textContent; duração `video.duration`. Como o DOM pode estar desatualizado logo após `yt-navigate-finish`, aguardar 500 ms e conferir que `document.title` mudou.

### 10.3 Vídeo e anúncio
- `getVideo()` = `document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video')`.
- `isAd()` = `!!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting')`.
- `MutationObserver` em `#movie_player` (`attributes:['class']`): transição ad→sem ad → `applySync(true)` imediato; envia `CS_PLAYER_EVENT ad-start/ad-end`.
- Listeners no `<video>`: `playing`, `pause`, `ended`, `volumechange` → `CS_PLAYER_EVENT` (só para `role !== 'normal'` ou quando o SW pede; para `normal`, enviar apenas o primeiro `playing` não-anúncio de cada videoId — gatilho do YT→SP).
- `ended` em `role==='spotytube'`: `video.pause()` e **não** deixar o autoplay do YouTube levar a outro vídeo: se ocorrer `yt-navigate-start` sem gesto em `role==='spotytube'`, o SW ignora (ver 11). Opcional: desligar autoplay clicando `.ytp-autonav-toggle-button[aria-checked="true"]` uma vez por sessão na aba SpotyTube.

### 10.4 Modo `sync` (role `spotytube` ou `linked` com mode `sync`)
- `SW_SYNC` → `sync = {...payload, receivedAt: Date.now()}`; `applySync(false)`.
- Timer `setInterval(applySync, SYNC_CHECK_INTERVAL_MS)` enquanto `sync != null`.
```
applySync(force):
  v = getVideo(); if !v || !sync || sync.videoId !== currentVideoId: return
  if !userUnmuted && !v.muted: v.muted = true
  if isAd(): return                                   // nunca seekar durante anúncio
  if !sync.isPlaying: if !v.paused: v.pause(); return
  if userPausedAt: return                             // usuário pausou o vídeo; zerado quando SW_SYNC traz isPlaying false->true ou outro videoId
  expectedSec = (sync.progressMs + (Date.now() - sync.sampledAt) + sync.offsetMs) / 1000
  if v.duration && expectedSec >= v.duration - 0.5: if !v.paused v.pause(); return   // clipe mais curto que a faixa
  if v.paused: v.play().catch(()=> send autoplay-blocked)
  if (force || Date.now() - lastSeekAt > SYNC_SEEK_COOLDOWN_MS) && |v.currentTime - expectedSec|*1000 > SYNC_DRIFT_MAX_MS:
      v.currentTime = expectedSec; lastSeekAt = Date.now()
```
- **Pausa do usuário**: evento `pause` com gesto confiável nos últimos `USER_GESTURE_WINDOW_MS` → `userPausedAt = now`; limpa quando o SW manda um `SW_SYNC` com transição `isPlaying` false→true (Spotify retomado) ou outra faixa. (v1 não propaga play/pause do vídeo para o Spotify.)
- **Mute**: em `volumechange` com `v.muted===false`: se houve gesto confiável recente → `userUnmuted=true` (respeitar, enviar `user-unmuted`); senão, se `now - loadedAt < MUTE_ENFORCE_WINDOW_MS` → `v.muted = true` (YouTube restaurando preferência).
- `SW_STOP_SYNC` → `sync=null`, limpa timer, `role='normal'` (não desmuta).

### 10.5 Outros comandos
- `SW_PLAY_VIDEO {unmute:boolean, atSec?:number}` (modo `handoff`): `v.muted=false` se unmute; `currentTime=atSec` se dado e não-anúncio; `play()`. Ao receber `SW_SET_ROLE` com `mode:'handoff'` o CS aplica isso uma vez assim que o vídeo existir (posição já vem no `&t=`).
- `SW_PAUSE_VIDEO` → `pause()`.
- `SW_MUTE_VIDEO {muted}` → aplica (usado pelo YT→SP `play-mute-video`).
- `SW_GET_STATUS` → responde `{videoId, currentTime, paused, muted, isAd}` (debug/popup).

---

## 11. Prevenção de loop entre direções (`loop-guard.js`)

```js
export async function addExtVideo(videoId)        // TTL EXT_VIDEO_TTL_MS
export async function isExtVideo(videoId)
export async function addExtPlayedTrack(trackKey) // TTL EXT_TRACK_TTL_MS
export async function isExtPlayedTrack(trackKey)
export async function setYtCooldown(videoId)      // TTL YT_VIDEO_COOLDOWN_MS
export async function inYtCooldown(videoId)
// mapas em storage.session.guard; expirados removidos a cada escrita
```

Regras (aplicadas em `controller.onContentMessage` para `CS_VIDEO_CHANGED`/primeiro `playing`):
1. **Aba SpotyTube** (`sender.tab.id === rt.spotyTabId`):
   - `videoId === spotyTabExpectedVideoId` ou `isExtVideo(videoId)` → é nosso; responder `SW_SET_ROLE {role:'spotytube', mode, expectedVideoId}`; **nunca** dispara YT→SP.
   - `userInitiated === false` (autoplay/fim de vídeo/navegação sem gesto) → ignorar; manter `syncTarget` apontando p/ o videoId antigo (o CS ignora `SW_SYNC` com videoId diferente).
   - `userInitiated === true` e vídeo diferente → navegação manual dentro da aba: `syncTarget=null`, CS vira `role:'normal'`, e segue o pipeline YT→SP (se ligado). A aba **continua** sendo a aba SpotyTube (a próxima troca do Spotify a reutiliza).
   - URL sem `v` (home, busca, canal) → `syncTarget=null`; nada mais.
2. **Outras abas**: só considera YT→SP no **primeiro `playing` não-anúncio** de um videoId com `visible:true` (abas abertas em background não disparam). Ignora se `isExtVideo(videoId)` ou `inYtCooldown(videoId)`.
3. **Faixas que a extensão mandou tocar**: ao dar `play` via YT→SP, `addExtPlayedTrack(trackKey)`. O `TRACK_CHANGED` resultante **não** abre clipe (a aba de origem vira `syncTarget` com `role:'linked'`).
4. **Debounce YT→SP**: após o gatilho, esperar `YT_TO_SP_DEBOUNCE_MS`; se nesse intervalo chegou outro `CS_VIDEO_CHANGED` da mesma aba, cancelar (generation por tabId). Após agir (ou decidir não agir), `setYtCooldown(videoId)`.
5. **Já tocando**: se o Spotify já está tocando a faixa casada (`rt.playback.track.uri === match.uri`) → não dá play; só vincula sync (se `ytAction === 'play-mute-video'`).
6. `settings.mode === 'handoff'` e o vídeo é a aba SpotyTube → nunca YT→SP (seria pingue-pongue: pausamos o Spotify de propósito).

---

## 12. YouTube → Spotify (`yt-to-spotify.js`)

```js
export async function handleManualVideo({ tabId, videoId, domTitle, domChannel, currentTimeSec }) // pipeline
export function isLikelyMusic(meta)                  // PURO
export function parseVideoTitle(title, channel)      // PURO -> { artist:string|null, track:string, featured:string[], flags }
export function cleanChannelName(channel)            // PURO
export function buildSpotifyQueries(parsed)          // PURO -> string[]
export function scoreTrackMatch(spTrack, parsed, videoDurationSec) // PURO -> number 0..1+
```

### 12.1 Metadados (`youtube-watch-meta.js`)
`getVideoMeta(videoId)`: `fetch('https://www.youtube.com/watch?v='+id+'&hl=en', {credentials:'include'})` → `extractJsonAssignment(html, 'ytInitialPlayerResponse')` →
```js
/** @typedef {{videoId, title, author, channelId, lengthSec:number, isLive:boolean, category:string|null}} VideoMeta */
title = pr.videoDetails.title; author = pr.videoDetails.author; lengthSec = +pr.videoDetails.lengthSeconds
isLive = pr.videoDetails.isLiveContent && pr.videoDetails.isLive !== false   // lives encerradas também contam como live
category = pr.microformat?.playerMicroformatRenderer?.category ?? null
```
Falhou → usar `domTitle/domChannel` do CS e `category=null`.

### 12.2 `isLikelyMusic(meta)`
```
if meta.isLive && lengthSec==0: false
if lengthSec < YT_MUSIC_MIN_SEC || lengthSec > YT_MUSIC_MAX_SEC: false
true se qualquer: category === 'Music'; author termina com 'VEVO' ou ' - Topic';
  normalize(title) contém 'official video'|'official music video'|'official audio'|'clipe oficial'|'videoclipe'|'lyric video'|' mv'
false caso contrário
```

### 12.3 Limpeza — `parseVideoTitle(title, channel)`
1. `t = title`; remover grupos `(...)`/`[...]`/`【...】` que contenham (case-insensitive): `official|oficial|video|vídeo|clipe|clip|audio|áudio|lyric|lyrics|letra|visualizer|hd|hq|4k|mv|m/v|remaster|remastered|explicit|legendado|tradução`.
2. Remover sufixos soltos: `/\s*[|｜]\s*(official|oficial).*$/i`, `/\s+(official\s+(music\s+)?video|clipe oficial|videoclipe)\s*$/i`.
3. Extrair featured: `/\s*[\(\[]?\s*(?:feat\.?|ft\.?|featuring|part\.?|participação)\s+([^\)\]\-|]+)[\)\]]?/i` → `featured = split(/,|&| e | and | x /)`; remover do texto.
4. Separar artista/música, nesta ordem:
   - separadores `' - '`, `' – '`, `' — '`, `' ~ '` → `artist = esquerda`, `track = direita`;
   - padrão `Artista "Música"` / `Artista 'Música'` / `Artista “Música”`;
   - `track | artist` quando a parte direita de `|` casa `cleanChannelName(channel)`;
   - senão `artist = cleanChannelName(channel)`, `track = t`.
5. Se a esquerda do separador casa `cleanChannelName(channel)` só pela direita (ex.: "Música - Artista"), trocar. Regra: se `dice(tokens(direita), tokens(canal)) > dice(tokens(esquerda), tokens(canal))` → inverter.
6. `flags` = mesmas de `cleanSpotifyTitle` aplicadas ao título original (remix/live/acoustic...).

`cleanChannelName(ch)`: remover `/ - Topic$/`, `/VEVO$/i` (depois separar CamelCase: `TaylorSwiftVEVO` → `Taylor Swift`), `/\b(official|oficial|music|tv|channel|canal)\b/gi`; trim.

### 12.4 Busca e score
Queries (para na primeira com match ≥ `YT_MATCH_AUTOPLAY`):
1. `track:"${track}" artist:"${artist}"` (se artist)
2. `${artist} ${track}`
3. `${track}` (só se não havia artista)

`scoreTrackMatch(sp, parsed, videoDurationSec)`:
```
titleSim  = dice(tokens(cleanSpotifyTitle(sp.name).clean), tokens(parsed.track))
artistSim = max over sp.artists de: containsPhrase(normalize(parsed.artist), normalize(a.name)) ? 1 : dice(tokens(a.name), tokens(parsed.artist))
            (se parsed.artist null: artistSim = sp.artists casam frase no título original ? 1 : 0.5)
score = 0.55*titleSim + 0.35*artistSim
d = |sp.duration_ms/1000 - videoDurationSec|; d <= 10 -> +0.10; d <= 30 -> +0.05; d > 90 -> -0.10   (clipes têm intro; peso baixo)
para cada flag em {remix, live, acoustic, instrumental}: sp tem e parsed não -> -0.20; parsed tem e sp não -> -0.10
karaoke/tribute/"originally performed by" no sp.name ou artista -> -0.50
featured: cada featured presente em sp.artists -> +0.03 (máx +0.09)
```
Decisão: `best >= YT_MATCH_AUTOPLAY (0.72)` → age; `>= YT_MATCH_SUGGEST (0.50)` → `rt.suggestion` (popup mostra "Tocar no Spotify?" com botão `PLAY_SUGGESTION`); senão nada (popup mostra "sem match").

### 12.5 Ação (`settings.ytAction`)
- `'play-mute-video'` (default): `play({ uris:[uri], positionMs: round(currentTimeSec*1000) })`; `addExtPlayedTrack`; `SW_MUTE_VIDEO {muted:true}` + `SW_SET_ROLE {role:'linked', mode:'sync'}` à aba; `syncTarget = {tabId, videoId, trackKey, offsetMs:0}`. (Spotify passa a ser o "relógio"; o vídeo segue.)
- `'play-pause-video'`: `play({uris, positionMs})` + `SW_PAUSE_VIDEO`. Sem sync.
- `'queue'`: `addToQueue(uri, deviceId)`; nenhuma alteração no vídeo.

Device:
```
try play(...)
catch NoDeviceError:
   devices = getDevices().filter(d => !d.is_restricted)
   target = devices.find(d => d.id === settings.preferredDeviceId) ?? devices.find(d=>d.is_active) ?? devices.find(d=>d.type==='Computer') ?? devices[0]
   if !target: lastError = {code:'NO_DEVICE', message:'Abra o Spotify em algum dispositivo'}; badge '!'; return
   play({ ..., deviceId: target.id })
catch PlayerRestrictedError: lastError; return
```
Toggle: `settings.youtubeToSpotify` (popup). Desligado → CS continua mandando eventos, SW ignora.

---

## 13. Mensageria

Envelope: `{ type: string, payload?: object }`. Resposta: `{ ok: true, data?: any } | { ok: false, error: { code: string, message: string } }`.
`messaging.js`: um único `chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => { route(msg, sender).then(sendResponse, e => sendResponse(err(e))); return true; })`. Popup e options usam `sendMessage(type, payload)` de `shared/messages.js`, que lança se `ok:false`.

### 13.1 Popup/Options → SW
| type | payload | resposta `data` |
|---|---|---|
| `GET_STATE` | — | `UiState` (13.4) |
| `LOGIN` | — | `UiState` |
| `LOGOUT` | — | — |
| `SET_SETTINGS` | `Partial<Settings>` | `Settings` |
| `NEXT_CANDIDATE` | — | `UiState` |
| `REOPEN_CLIP` | — | — |
| `OPEN_YT_SEARCH` | — | — (abre `searchUrl` da faixa atual na aba SpotyTube) |
| `FOCUS_SPOTY_TAB` | — | — |
| `PLAY_SUGGESTION` | `{ trackUri }` | — |
| `SET_CLIP_OFFSET` | `{ deltaMs }` (±1000) | `{ offsetMs }` (fase 4) |
| `CLEAR_CACHE` | — | `{ removed:number }` |
| `GET_CACHE_STATS` | — | `{ count:number }` |
| `TEST_YT_API_KEY` | `{ key }` | `{ valid:boolean, message }` |
| `GET_DEVICES` | — | `Device[]` (options: dispositivo preferido) |
| `GET_REDIRECT_URI` | — | `{ uri }` |

### 13.2 SW → Popup/Options (broadcast)
| type | payload |
|---|---|
| `STATE_UPDATED` | `UiState` |
`broadcastState()` usa `chrome.runtime.sendMessage(...).catch(() => {})` (sem receptor = erro esperado). Throttle 250 ms.

### 13.3 Content script ↔ SW
| Direção | type | payload |
|---|---|---|
| CS→SW | `CS_HELLO` | `{ videoId:string|null, url }` → resposta `SW_SET_ROLE` payload |
| CS→SW | `CS_VIDEO_CHANGED` | `{ videoId:string|null, url, title, channel, durationSec:number|null, userInitiated:boolean, visible:boolean }` |
| CS→SW | `CS_PLAYER_EVENT` | `{ videoId, event:'playing'|'paused'|'ended'|'ad-start'|'ad-end'|'autoplay-blocked'|'user-unmuted'|'user-paused', currentTime:number, visible:boolean }` |
| SW→CS | `SW_SET_ROLE` | `{ role:'normal'|'spotytube'|'linked', mode:ClipMode|null, expectedVideoId:string|null }` |
| SW→CS | `SW_SYNC` | `{ videoId, isPlaying:boolean, progressMs:number, sampledAt:number, offsetMs:number }` |
| SW→CS | `SW_STOP_SYNC` | — |
| SW→CS | `SW_PLAY_VIDEO` | `{ unmute:boolean, atSec?:number }` |
| SW→CS | `SW_PAUSE_VIDEO` | — |
| SW→CS | `SW_MUTE_VIDEO` | `{ muted:boolean }` |
| SW→CS | `SW_GET_STATUS` | — → `{ videoId, currentTime, paused, muted, isAd }` |

SW→CS via `chrome.tabs.sendMessage(tabId, msg)` sempre com `.catch(() => {})` (aba carregando). `sampledAt` é `Date.now()` do SW; mesmo relógio da máquina do CS ⇒ comparável.

### 13.4 `UiState` (derivado de `rt` + settings + auth)
```js
{ status, loggedIn:boolean, needsSetup:boolean,
  settings: Settings (sem ytApiKey; só hasYtApiKey:boolean),
  playback: { status, trackName, artists, albumImage, progressMs, durationMs, deviceName } | null,
  clip: { videoId, title, channel, thumbnail:`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, source, candidateIndex, candidateCount, score } | null,
  suggestion, lastError, parserWarning:boolean, spotyTabOpen:boolean }
```

---

## 14. Popup e Options

### 14.1 Popup (`src/popup/*`, ~340 px de largura, sem framework)
Ao abrir: `GET_STATE` → render; escuta `STATE_UPDATED`; re-renderiza a barra de progresso localmente a cada 1 s (extrapolando `progressMs`).

Blocos (de cima para baixo):
1. **Header**: "SpotyTube" + switch **master** ("Ativo" / "Pausado") → `SET_SETTINGS {enabled}`.
2. **Status de login**: `needsSetup` → botão "Configurar" (`chrome.runtime.openOptionsPage()`); `!loggedIn` → botão "Conectar Spotify" (`LOGIN`); logado → texto "Conectado" + link "Sair" (`LOGOUT`).
3. **Faixa atual**: capa (64 px), nome, artistas, device, barra de progresso; estados: "Nada tocando", "Podcast/anúncio — ignorado", "Sem dispositivo ativo".
4. **Clipe**: thumbnail, título, canal, `candidateIndex+1 / candidateCount`, selo da fonte (`scrape`/`api`/`busca`). Botões: **"Próximo candidato"** (`NEXT_CANDIDATE`), "Reabrir" (`REOPEN_CLIP`), "Ir para a aba" (`FOCUS_SPOTY_TAB`), "Buscar no YouTube" (`OPEN_YT_SEARCH`). (Fase 4: "−1s / +1s" → `SET_CLIP_OFFSET`.)
5. **Sugestão YT→SP** (se `suggestion`): "Tocar ‘X — Y’ no Spotify? (73%)" + botão (`PLAY_SUGGESTION`).
6. **Toggles**: "Spotify → YouTube" (`spotifyToYoutube`), "YouTube → Spotify" (`youtubeToSpotify`).
7. **Modo** (radio): "Vídeo mudo sincronizado" (`sync`, default) · "Pausar Spotify, áudio no YouTube" (`handoff`) · "Só abrir o vídeo" (`open`). Mudança vale a partir da próxima faixa; para a atual, oferecer "Reabrir".
8. **Erro** (se `lastError` ou `parserWarning`): faixa vermelha com mensagem pt-BR e ação sugerida.
9. Rodapé: link "Opções".

### 14.2 Options (`src/options/*`)
Seções:
1. **Spotify**
   - Campo **Client ID** (32 hex; validar `/^[0-9a-f]{32}$/i`) + Salvar.
   - **Redirect URI** em campo read-only + botão "Copiar" (valor de `chrome.identity.getRedirectURL()`, ex.: `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/` — com a barra final).
   - Instruções (texto fixo):
     1. Acesse https://developer.spotify.com/dashboard e faça login.
     2. "Create app": nome livre; **Redirect URIs**: cole exatamente a URI acima (incluindo `/` final); em "Which API/SDKs are you planning to use?" marque **Web API**; aceite os termos.
     3. Abra o app → Settings → copie o **Client ID** e cole acima. (Não precisa de Client Secret — usamos PKCE.)
     4. Se o app estiver em Development Mode e o dashboard tiver *User Management*, adicione seu e-mail da conta Spotify.
     5. Clique "Conectar Spotify".
     6. Se você mover a pasta da extensão, o ID muda → atualize a Redirect URI no dashboard.
   - Botões "Conectar"/"Desconectar"; status; link para spotify.com/account/apps (revogar).
   - **Dispositivo preferido** (select de `GET_DEVICES`, opcional).
2. **YouTube**
   - Abrir aba: em primeiro plano / em segundo plano (`focusTab`); "Fixar aba" (`pinTab`).
   - **YouTube Data API key (opcional)**: input + "Testar" (`TEST_YT_API_KEY`); ao salvar com valor, `chrome.permissions.request({origins:['https://www.googleapis.com/*']})` no handler do clique.
   - Ação YT→SP (`ytAction`): "Tocar no Spotify e silenciar o vídeo (sincronizado)" / "Tocar no Spotify e pausar o vídeo" / "Adicionar à fila do Spotify".
3. **Cache**: "N clipes em cache" (`GET_CACHE_STATS`) + "Limpar cache" (`CLEAR_CACHE`, com confirm()).
4. **Avançado**: "Logs de debug" (`debug`).

---

## 15. Erros e casos de borda

| Caso | Comportamento |
|---|---|
| Offline / DNS / timeout | `NetworkError` → backoff 5→60 s; `status='error'` após 3 falhas; badge `!`; ao voltar, limpa. Não desloga. |
| Token expirado | refresh proativo (skew 60 s) + 401 reativo (1 retry). |
| Token revogado (`invalid_grant` / 2º 401) | remove `auth`, para poller, badge `!`, popup "Reconecte o Spotify". |
| 429 | respeita `Retry-After` + jitter; não conta como erro de rede. |
| 5xx Spotify | backoff igual a rede. |
| 204 / sem device | `no_device`, poll 8 s → idle após 10 min; vídeo de sync pausa. |
| Ad / podcast / `item:null` | `unsupported`: ignora; não navega; sync recebe `isPlaying:false`. |
| Faixa local (`is_local`, `id:null`) | `trackKey='local:'+normalize(...)`; busca normal; YT→SP nunca casa com locais (search não retorna). |
| Mesma faixa de novo / repeat-one | sem `TRACK_CHANGED`; `TRACK_RESTARTED` → seek no modo `sync`; aba não recarrega. |
| Mesma música, versão diferente (outro `id`) | é `TRACK_CHANGED`; cache por id; ok abrir de novo (normalmente cai no mesmo videoId — se `videoId === currentClip.videoId` e aba está nele, **não** navegar, só `sendSync`). |
| Pulos rápidos | `generation` + `MIN_TAB_NAV_INTERVAL_MS` latest-wins (7.3). |
| HTML do YouTube mudou | `ParserError` → `parserHealth++`; Data API se houver key; senão abre URL de busca; popup alerta após 3 falhas seguidas. Fixtures em `tests/fixtures` facilitam o conserto. |
| Página de consentimento (EU) | `ConsentError` → fallback; mensagem "abra youtube.com e aceite cookies". |
| Nenhum candidato ≥ limiar | abre `results?search_query=` na aba SpotyTube; `source='search-fallback'`; candidatos guardados. |
| Aba SpotyTube fechada | `onRemoved` limpa; recriada na próxima faixa (ou "Reabrir"). |
| Usuário navega na aba SpotyTube | seção 11, regra 1. |
| Autoplay do YouTube ao fim do clipe | CS pausa no `ended`; navegação sem gesto ignorada. |
| Clipe mais curto/longo que a faixa | CS pausa no fim do vídeo; se o vídeo tem intro, usuário usa "próximo candidato" ou (fase 4) offset ±1 s persistido em `ClipEntry.offsetMs`. |
| Anúncio no YouTube | CS não seeka durante `.ad-showing`; reaplica sync no fim do anúncio; mantém mudo. |
| Autoplay com áudio bloqueado (handoff em background) | CS envia `autoplay-blocked` → `lastError` "Clique na aba do YouTube para tocar" + botão "Ir para a aba" (`FOCUS_SPOTY_TAB`). No modo `sync` (mudo) isso não ocorre. |
| Spotify sem Premium / ação restrita | `PlayerRestrictedError` → mensagem; Spotify→YouTube continua funcionando (só leitura). |
| SW reiniciado no meio | `loadState()` recupera `rt`; primeiro poll não reabre a música já aberta (6.5 regra 6). |
| Browser reiniciado | `storage.session` vazio → `spotyTabId=null` (nova aba na próxima faixa); `auth` persiste; `onStartup` → `start()`. |
| Content script ausente (aba antiga) | `tabs.sendMessage` falha → ignorado; aba SpotyTube sempre recebe o CS porque é navegada pela extensão. |
| Vários devices tocando | Spotify só reporta o ativo; segue o ativo. |
| Usuário logado em outra conta no YouTube / sem cookies | `credentials:'include'` usa o que houver; resultados podem variar, ranking compensa. |

Badge (`badge.js`): `''` normal; `'OFF'` (cinza) desativado; `'!'` (vermelho `#d93025`) erro/deslogado; `'?'` (âmbar) faixa atual caiu em fallback de busca.

---

## 16. `service-worker.js` (bootstrap)

```js
import { ... } from './...';
// 1) listeners síncronos no topo
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.onAlarm.addListener(a => a.name === WATCHDOG_ALARM && boot());
chrome.runtime.onMessage.addListener(messaging.onMessage);   // chama boot() antes de rotear
chrome.tabs.onRemoved.addListener(tabManager.onTabRemoved);
chrome.storage.onChanged.addListener(onStorageChanged);      // settings -> controller.onSettingsChanged
chrome.commands.onCommand.addListener(onCommand);            // 'next-candidate' | 'toggle-enabled'
// 2) boot também ao avaliar o script (SW acordou por qualquer motivo)
boot();

let booted = null;
function boot() { return booted ??= (async () => { await loadState(); await clipCache.prune(); poller.ensureRunning(); })(); }
```
`boot()` é idempotente por instância do SW (a promise é recriada quando o SW reinicia, pois o módulo é reavaliado).

---

## 17. Plano de implementação

**Fase 0 — Esqueleto e auth (meio dia)**
`manifest.json`, ícones placeholder, `shared/*`, `state.js`, `messaging.js`, `spotify-auth.js`, options (Client ID, redirect URI, conectar), popup mínimo (status login). Pronto quando: conecta, token renova sozinho (forçar `expiresAt=0` no storage e ver refresh).

**Fase 1 — Spotify → YouTube ponta a ponta (prioridade)**
`spotify-api.js`, `playback-tracker.js`, `poller.js` (loop + alarm + adaptativo), `youtube-html.js`, `youtube-search.js`, `clip-ranker.js`, `clip-cache.js`, `clip-finder.js`, `tab-manager.js`, `controller.js` (só `TRACK_CHANGED` → abrir no modo `open`, mas com URL `&t=` do modo sync), popup com faixa atual + clipe + "Próximo candidato" + toggle master. Testes unitários de normalização, parser (com fixtures) e ranking.
Pronto quando: tocar músicas no celular troca o clipe na mesma aba em ≤ 3 s, sem abrir abas novas.

**Fase 2 — Content script e modos**
`content/youtube.js` (SPA, ad, mute, sync, gestos), `SW_SET_ROLE/SW_SYNC`, modos `sync` (default) e `handoff`, `loop-guard.js` (parte de vídeos da extensão), regras de navegação manual na aba SpotyTube, seletor de modo no popup.

**Fase 3 — YouTube → Spotify**
`youtube-watch-meta.js`, `yt-to-spotify.js`, device fallback, `extPlayedTracks`, `linked` sync, sugestões no popup, toggle, `ytAction` nas options.

**Fase 4 — Polimento**
Fallback Data API + teste de key, offset ±1 s por clipe, prefetch da fila, comandos de teclado, `parserHealth` na UI, badge completo, prune de cache.

---

## 18. Testes

### 18.1 Unitários (`node --test tests/`, Node ≥ 20, sem npm)
- `text-normalize`: acentos ("Coração" → "coracao"), `&`, apóstrofos; `cleanSpotifyTitle` para "Song - Remastered 2011", "Song (feat. X)", "Song - Live at Wembley" (flag live), "Song - X Remix" (flag remix), "Song [with Y]".
- `youtube-search`: `extractJsonAssignment` com `};` dentro de string; `parseSearchData` com ≥ 3 fixtures reais (salvar via "Salvar como" de `results?search_query=...&sp=EgIQAQ%253D%253D&hl=en`), retorna ≥ 10 candidatos com `videoId` de 11 chars, duração e badges.
- `clip-ranker`: oficial VEVO > lyric > audio Topic > cover > reaction; remix só ganha se a faixa é remix; música chamada "Cover Me Up" não é penalizada.
- `playback-tracker`: troca de faixa, pause/play, seek, repeat-one (progress volta a ~0), 204, ad.
- `yt-to-spotify`: "Artist - Song (Official Video) ft. X", "Song | Artist", `Artist "Song"`, canal "ArtistVEVO", "Artist - Topic"; `scoreTrackMatch` rejeita karaoke/remix indevido.

### 18.2 Checklist manual
- [ ] Options mostra redirect URI; login PKCE ok; recarregar extensão mantém login.
- [ ] Token: editar `auth.expiresAt` para 0 → próximo poll renova sem erro.
- [ ] Revogar acesso em spotify.com/account/apps → popup pede reconexão, badge `!`.
- [ ] Tocar no **app desktop**, **celular** e **web player**: clipe abre em ≤ 3 s.
- [ ] 5 músicas seguidas: sempre a **mesma** aba; fechar a aba → próxima música recria.
- [ ] Pular 5 faixas em 3 s: aba termina no clipe da última; no máx. ~1 navegação/1,5 s.
- [ ] Modo sync: vídeo mudo, posição ≈ Spotify (±2 s); pausar/retomar no celular reflete em ≤ 4 s; seek no Spotify reflete.
- [ ] Anúncio no início do vídeo: nada de seek durante o anúncio; sincroniza ao terminar.
- [ ] Desmutar manualmente o vídeo: extensão não remuta. Pausar o vídeo manualmente: extensão não força play até o Spotify mudar de estado.
- [ ] Modo handoff: Spotify pausa, vídeo toca com áudio na posição certa; retomar Spotify pausa o vídeo.
- [ ] Modo open: só abre.
- [ ] Repeat-one: aba não recarrega; vídeo volta ao início (sync).
- [ ] Podcast/episódio: nada acontece. Nada tocando por 10 min: SW entra em idle (ver `chrome://serviceworker-internals`), e ao dar play volta em ≤ 30 s.
- [ ] Faixa local: busca funciona por nome/artista.
- [ ] "Próximo candidato": troca o vídeo; ao tocar a faixa de novo, abre o candidato escolhido.
- [ ] Música obscura sem clipe: abre página de busca, badge `?`.
- [ ] Simular parser quebrado (renomear marker em código): fallback de busca; com API key, usa Data API.
- [ ] Offline (desligar Wi-Fi 1 min): backoff, sem logout; volta sozinho.
- [ ] Deixar o PC 1 h com música tocando: continua detectando (SW não morreu ou foi reacordado pelo alarm).
- [ ] YT→SP ligado: abrir clipe oficial manualmente → toca no Spotify na posição do vídeo, vídeo mudo e sincronizado; **não** abre outra aba SpotyTube.
- [ ] YT→SP: vídeo não-musical (tutorial) → nada. Abrir vídeos em background (ctrl+clique) → nada até assistir.
- [ ] YT→SP sem device ativo → usa dispositivo preferido / mostra erro.
- [ ] Navegar manualmente para outro clipe dentro da aba SpotyTube → YT→SP toca a faixa; próxima música do Spotify reutiliza a aba.
- [ ] Autoplay do YouTube no fim do clipe na aba SpotyTube → não dispara YT→SP.
- [ ] Desligar master: nenhum poll (ver Network do SW), badge `OFF`.
- [ ] Reiniciar o browser: login persiste, nova aba é criada na próxima música.
