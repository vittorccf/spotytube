// SpotyTube — constantes normativas (docs/ARCHITECTURE.md §2.1).
// Use os nomes, não números mágicos. O content script espelha algumas delas.

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
export const RESTART_MAX_PROGRESS_MS = 5000;      // ver 6.5 (TRACK_RESTARTED)
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

// --- Extras da implementação (não estavam no §2.1; ver README "Desvios") ---
export const POPUP_POKE_STALE_MS = 4000;    // §6.4: GET_STATE com lastPollAt mais velho que isso => pokeNow
export const BROADCAST_THROTTLE_MS = 250;   // §13.2
export const PREFETCH_REMAINING_MS = 20_000; // §7.4
export const PARSER_WARN_FAILS = 3;         // §3.1 parserHealth
export const ERROR_STATUS_AFTER = 3;        // §6.2: status 'error' após n falhas seguidas
export const CLIP_OFFSET_STEP_MS = 1000;    // §13.1 SET_CLIP_OFFSET

// --- Chaves de storage ---
export const SK_SETTINGS = 'settings';
export const SK_AUTH = 'auth';
export const SK_CLIP_PREFIX = 'clip:';
export const SK_CLIP_INDEX = 'clipIndex';
export const SK_PARSER_HEALTH = 'parserHealth';
export const SK_RT = 'rt';
export const SK_PKCE = 'pkce';
export const SK_GUARD = 'guard';
export const SK_RATE_LIMIT = 'rateLimitUntil';

// --- Spotify ---
export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
export const SPOTIFY_SCOPES = ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state'];
export const SPOTIFY_APPS_URL = 'https://www.spotify.com/account/apps/';
