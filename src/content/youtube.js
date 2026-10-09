// SpotyTube — content script do youtube.com (§10).
// Script CLÁSSICO (sem import): content scripts declarados no manifest não suportam ES modules.
(() => {
  'use strict';
  if (window.__spotytubeLoaded) return;
  window.__spotytubeLoaded = true;

  // mirror of constants.js
  const SYNC_DRIFT_MAX_MS = 2000;
  const SYNC_SEEK_COOLDOWN_MS = 3000;
  const SYNC_CHECK_INTERVAL_MS = 1000;
  const MUTE_ENFORCE_WINDOW_MS = 8000;
  const USER_GESTURE_WINDOW_MS = 3000;
  const VIDEO_WAIT_MS = 10000;
  const TITLE_SETTLE_MS = 500;
  const TITLE_MAX_WAIT_MS = 2000;

  // ---- estado local (§10.1)
  let role = 'normal';          // 'normal' | 'spotytube' | 'linked'
  let mode = null;              // ClipMode quando role != 'normal'
  let expectedVideoId = null;
  let sync = null;              // {videoId, isPlaying, progressMs, sampledAt, offsetMs, receivedAt}
  let lastSeekAt = 0;
  let loadedAt = Date.now();
  let lastGestureAt = 0;
  let userPausedAt = 0;
  let userUnmuted = false;
  let currentVideoId = null;
  let navStartGestureAt = 0;
  let titleAtNavStart = document.title;

  let initialized = false;
  let syncTimer = null;
  let ackFor = null;            // videoId cujo CS_VIDEO_CHANGED o SW já processou
  let firstPlayingSentFor = null;
  let handoffAppliedFor = null;
  let selfUnmuteAt = 0;         // unmute feito por nós (handoff) não é "do usuário"
  let autonavDisabled = false;
  let wasAd = false;
  let adObserver = null;
  let navSeq = 0;
  const attached = new WeakSet();

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const gestureRecent = () => now() - lastGestureAt < USER_GESTURE_WINDOW_MS;
  const visible = () => document.visibilityState === 'visible';

  function send(type, payload) {
    if (!alive()) { teardown(); return Promise.resolve(null); }
    try {
      return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
    } catch {
      teardown();
      return Promise.resolve(null);
    }
  }

  function teardown() {
    clearInterval(syncTimer);
    syncTimer = null;
    sync = null;
    if (adObserver) adObserver.disconnect();
  }

  // ---- gestos confiáveis
  const onGesture = (e) => { if (e.isTrusted) lastGestureAt = now(); };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  // ---- vídeo / anúncio (§10.3)
  const getVideo = () => document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
  const isAd = () => !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');

  function playerEvent(event, extra) {
    const v = getVideo();
    return send('CS_PLAYER_EVENT', {
      videoId: currentVideoId,
      event,
      currentTime: v ? v.currentTime : 0,
      visible: visible(),
      ...(extra || {}),
    });
  }

  function readMeta() {
    const v = getVideo();
    const h1 = document.querySelector('ytd-watch-metadata h1 yt-formatted-string');
    const title = (h1?.textContent || '').trim() || document.title.replace(/ - YouTube$/, '').replace(/^\(\d+\)\s*/, '');
    const channel = (document.querySelector('#owner #channel-name a')?.textContent || '').trim();
    const durationSec = v && Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null;
    return { title, channel, durationSec };
  }

  // gatilho do YT->SP: primeiro "playing" não-anúncio, visível, depois do ack do CS_VIDEO_CHANGED
  function maybeSendFirstPlaying() {
    const v = getVideo();
    if (!currentVideoId || ackFor !== currentVideoId || firstPlayingSentFor === currentVideoId) return;
    if (!v || v.paused || isAd() || !visible()) return;
    firstPlayingSentFor = currentVideoId;
    playerEvent('playing');
  }

  function onPlaying() {
    if (isAd()) return;
    if (role !== 'normal' && firstPlayingSentFor === currentVideoId) playerEvent('playing');
    maybeSendFirstPlaying();
    if (role !== 'normal' && mode === 'sync') applySync(false);
  }

  function onPause() {
    if (isAd()) return;
    if (gestureRecent()) {
      userPausedAt = now();
      if (role !== 'normal') playerEvent('user-paused');
    } else if (role !== 'normal') {
      playerEvent('paused');
    }
  }

  function onEnded() {
    if (role === 'spotytube') {
      const v = getVideo();
      try { v?.pause(); } catch { /* ignore */ }
    }
    if (role !== 'normal') playerEvent('ended');
  }

  function onVolumeChange() {
    const v = getVideo();
    if (!v || v.muted) return;
    if (gestureRecent()) {
      userUnmuted = true;
      if (role !== 'normal') playerEvent('user-unmuted');
      return;
    }
    if (now() - selfUnmuteAt < 2000) return;
    if (role !== 'normal' && mode === 'sync' && !userUnmuted && now() - loadedAt < MUTE_ENFORCE_WINDOW_MS) {
      v.muted = true; // YouTube restaurando a preferência de volume
    }
  }

  function observeAds() {
    const player = document.querySelector('#movie_player');
    if (!player || adObserver?._target === player) return;
    if (adObserver) adObserver.disconnect();
    wasAd = isAd();
    adObserver = new MutationObserver(() => {
      const ad = isAd();
      if (ad === wasAd) return;
      wasAd = ad;
      if (role !== 'normal') playerEvent(ad ? 'ad-start' : 'ad-end');
      if (!ad) {
        if (role !== 'normal' && mode === 'sync') applySync(true);
        maybeSendFirstPlaying();
      }
    });
    adObserver._target = player;
    adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  async function waitForVideo() {
    const t0 = now();
    while (now() - t0 < VIDEO_WAIT_MS) {
      const v = getVideo();
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  async function attachVideo() {
    const v = await waitForVideo();
    if (!v) return null;
    observeAds();
    if (!attached.has(v)) {
      attached.add(v);
      v.addEventListener('playing', onPlaying);
      v.addEventListener('pause', onPause);
      v.addEventListener('ended', onEnded);
      v.addEventListener('volumechange', onVolumeChange);
    }
    if (role !== 'normal' && mode === 'sync' && !userUnmuted) v.muted = true;
    return v;
  }

  // ---- papel (SW_SET_ROLE)
  function applyRole(r) {
    if (!r || typeof r !== 'object' || !r.role) return;
    role = r.role;
    mode = r.mode ?? null;
    expectedVideoId = r.expectedVideoId ?? null;
    if (role === 'normal') {
      stopSync();
      return;
    }
    if (mode === 'sync') {
      const v = getVideo();
      if (v && !userUnmuted && currentVideoId === expectedVideoId) v.muted = true;
    }
    if (mode === 'handoff') applyHandoff();
    if (role === 'spotytube') disableAutonavOnce();
  }

  async function applyHandoff() {
    if (!currentVideoId || currentVideoId !== expectedVideoId || handoffAppliedFor === currentVideoId) return;
    handoffAppliedFor = currentVideoId;
    const v = await attachVideo();
    if (!v) return;
    selfUnmuteAt = now();
    v.muted = false;
    if (v.paused) v.play().catch(() => playerEvent('autoplay-blocked'));
  }

  function disableAutonavOnce() {
    if (autonavDisabled) return;
    setTimeout(() => {
      try {
        const btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
        if (btn) { btn.click(); autonavDisabled = true; }
      } catch { /* ignore */ }
    }, 3000);
  }

  // ---- sync (§10.4)
  function stopSync() {
    sync = null;
    clearInterval(syncTimer);
    syncTimer = null;
  }

  function applySync(force) {
    const v = getVideo();
    if (!v || !sync || sync.videoId !== currentVideoId) return;
    if (!userUnmuted && !v.muted) v.muted = true;
    if (isAd()) return; // nunca seekar durante anúncio
    if (!sync.isPlaying) {
      if (!v.paused) v.pause();
      return;
    }
    if (userPausedAt) return; // usuário pausou o vídeo
    const expectedSec = (sync.progressMs + (now() - sync.sampledAt) + (sync.offsetMs || 0)) / 1000;
    if (v.duration && Number.isFinite(v.duration) && expectedSec >= v.duration - 0.5) {
      if (!v.paused) v.pause(); // clipe mais curto que a faixa
      return;
    }
    if (expectedSec < 0) {
      if (!v.paused) v.pause(); // offset positivo: o vídeo começa "antes"
      return;
    }
    if (v.paused) v.play().catch(() => playerEvent('autoplay-blocked'));
    if ((force || now() - lastSeekAt > SYNC_SEEK_COOLDOWN_MS) && Math.abs(v.currentTime - expectedSec) * 1000 > SYNC_DRIFT_MAX_MS) {
      v.currentTime = expectedSec;
      lastSeekAt = now();
    }
  }

  function onSwSync(payload) {
    if (!payload) return;
    const prev = sync;
    sync = { ...payload, receivedAt: now() };
    if (!prev || prev.videoId !== sync.videoId || (prev.isPlaying === false && sync.isPlaying)) userPausedAt = 0;
    if (role === 'normal' && sync.videoId === currentVideoId) { role = 'linked'; mode = 'sync'; expectedVideoId = sync.videoId; }
    if (role !== 'normal' && mode !== 'sync') mode = 'sync';
    if (!syncTimer) syncTimer = setInterval(() => applySync(false), SYNC_CHECK_INTERVAL_MS);
    applySync(!prev);
  }

  // ---- mensagens do SW
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    const v = getVideo();
    const p = msg.payload || {};
    switch (msg.type) {
      case 'SW_SET_ROLE':
        applyRole(p);
        break;
      case 'SW_SYNC':
        onSwSync(p);
        break;
      case 'SW_STOP_SYNC':
        stopSync();
        role = 'normal';
        mode = null;
        break;
      case 'SW_PLAY_VIDEO':
        if (v) {
          if (p.unmute) { selfUnmuteAt = now(); v.muted = false; }
          if (typeof p.atSec === 'number' && !isAd()) v.currentTime = p.atSec;
          v.play().catch(() => playerEvent('autoplay-blocked'));
        }
        break;
      case 'SW_PAUSE_VIDEO':
        if (v && !v.paused) v.pause();
        break;
      case 'SW_MUTE_VIDEO':
        if (v) {
          v.muted = !!p.muted;
          if (p.muted) userUnmuted = false;
        }
        break;
      case 'SW_GET_STATUS':
        sendResponse({
          videoId: currentVideoId,
          currentTime: v ? v.currentTime : 0,
          paused: v ? v.paused : true,
          muted: v ? v.muted : false,
          isAd: isAd(),
        });
        return false;
      default:
        return false;
    }
    sendResponse({ ok: true });
    return false;
  });

  // ---- navegação SPA (§10.2)
  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      return u.pathname === '/watch' ? u.searchParams.get('v') : null;
    } catch {
      return null;
    }
  }

  async function waitForTitle(isFirst) {
    if (isFirst) return;
    await sleep(TITLE_SETTLE_MS);
    const t0 = now();
    while (document.title === titleAtNavStart && now() - t0 < TITLE_MAX_WAIT_MS) await sleep(150);
  }

  async function onNavigate() {
    const vid = videoIdFromLocation();
    if (initialized && vid === currentVideoId) return;
    const isFirst = !initialized;
    initialized = true;
    const seq = ++navSeq;
    currentVideoId = vid;
    userPausedAt = 0;
    userUnmuted = false;
    loadedAt = now();
    ackFor = null;
    // no load completo, userInitiated = true; o SW decide comparando com expectedVideoId
    const userInitiated = isFirst ? true : now() - navStartGestureAt < USER_GESTURE_WINDOW_MS;

    if (isFirst) {
      const hello = await send('CS_HELLO', { videoId: vid, url: location.href });
      if (seq !== navSeq) return;
      applyRole(hello?.data);
    }
    if (vid) attachVideo();
    await waitForTitle(isFirst);
    if (seq !== navSeq) return;
    const meta = readMeta();
    const res = await send('CS_VIDEO_CHANGED', {
      videoId: vid,
      url: location.href,
      title: vid ? meta.title : '',
      channel: vid ? meta.channel : '',
      durationSec: vid ? meta.durationSec : null,
      userInitiated,
      visible: visible(),
    });
    if (seq !== navSeq) return;
    applyRole(res?.data);
    ackFor = vid;
    maybeSendFirstPlaying();
  }

  document.addEventListener('yt-navigate-start', () => {
    navStartGestureAt = lastGestureAt;
    titleAtNavStart = document.title;
  });
  document.addEventListener('yt-navigate-finish', () => { onNavigate(); });
  window.addEventListener('popstate', () => { setTimeout(onNavigate, 300); });
  document.addEventListener('visibilitychange', () => { if (visible()) maybeSendFirstPlaying(); });

  onNavigate();
})();
