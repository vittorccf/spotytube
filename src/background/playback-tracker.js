// diffPlayback (§6.5). PURO.
import { RESTART_MAX_PROGRESS_MS, POLL_PLAYING_MS, SEEK_DETECT_THRESHOLD_MS } from '../shared/constants.js';

/** @typedef {{type:'TRACK_CHANGED'|'PLAY_STATE_CHANGED'|'SEEKED'|'TRACK_RESTARTED'|'STOPPED'|'UNSUPPORTED', track?:any, prevTrack?:any}} PlaybackEvent */

/** Posição projetada para `now` (extrapola se tocando). */
export function projectedProgress(snap, now = Date.now()) {
  if (!snap) return 0;
  return snap.progressMs + (snap.status === 'playing' ? Math.max(0, now - snap.sampledAt) : 0);
}

/**
 * @param {import('../shared/messages.js').PlaybackSnapshot|null} prev
 * @param {import('../shared/messages.js').PlaybackSnapshot} curr
 * @param {number} now
 * @param {string|null} openedTrackKey  rt.currentClip?.trackKey ?? null
 * @returns {PlaybackEvent[]}
 */
export function diffPlayback(prev, curr, now, openedTrackKey = null) {
  const events = [];
  if (!curr) return events;
  const prevTrack = prev?.track ?? null;

  // 1. sem device
  if (curr.status === 'no_device') {
    if (prevTrack) events.push({ type: 'STOPPED', prevTrack });
    return events;
  }
  // 2. ad / episode / unknown
  if (curr.status === 'unsupported') {
    events.push({ type: 'UNSUPPORTED', ...(prevTrack ? { prevTrack } : {}) });
    return events;
  }
  if (!curr.track) return events;

  // 6. primeiro poll / vindo de no_device ou unsupported
  if (!prevTrack) {
    if (openedTrackKey !== curr.track.key) events.push({ type: 'TRACK_CHANGED', track: curr.track });
    return events;
  }

  // 3. troca de faixa
  if (curr.track.key !== prevTrack.key) {
    events.push({ type: 'TRACK_CHANGED', track: curr.track, prevTrack });
    return events;
  }

  // 4. mesma faixa: restart / seek
  const expected = prev.progressMs + (prev.status === 'playing' ? now - prev.sampledAt : 0);
  const durationMs = curr.track.durationMs || prevTrack.durationMs || 0;
  const restarted =
    (prev.progressMs >= RESTART_MAX_PROGRESS_MS + POLL_PLAYING_MS
      && curr.progressMs < RESTART_MAX_PROGRESS_MS
      && expected - curr.progressMs > SEEK_DETECT_THRESHOLD_MS)
    || (durationMs > 0 && expected >= durationMs && curr.progressMs < RESTART_MAX_PROGRESS_MS
      && prev.progressMs > curr.progressMs);
  if (restarted) events.push({ type: 'TRACK_RESTARTED', track: curr.track });
  else if (Math.abs(curr.progressMs - expected) > SEEK_DETECT_THRESHOLD_MS) events.push({ type: 'SEEKED', track: curr.track });

  // 5. play/pause
  if (prev.status !== curr.status) events.push({ type: 'PLAY_STATE_CHANGED', track: curr.track });

  return events;
}
