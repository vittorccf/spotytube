import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPlayback, projectedProgress } from '../src/background/playback-tracker.js';
import { toSnapshot } from '../src/background/spotify-api.js';
import { computeNextDelay, shouldRun, backoffDelay, IDLE } from '../src/background/poller.js';
import {
  POLL_PLAYING_MS, POLL_PAUSED_MS, POLL_NO_DEVICE_MS, POLL_MIN_MS, POLL_NEAR_END_GRACE_MS, IDLE_AFTER_MS,
} from '../src/shared/constants.js';

const T = (key, durationMs = 200_000) => ({ key, id: key, uri: 'spotify:track:' + key, name: key, artists: ['A'], album: '', durationMs, isLocal: false, imageUrl: null });
const S = (status, track, progressMs, sampledAt) => ({ status, track, progressMs, sampledAt, deviceId: 'd', deviceName: 'D', repeatState: 'off' });
const types = (ev) => ev.map((e) => e.type);

test('troca de faixa', () => {
  const prev = S('playing', T('a'), 100_000, 0);
  const curr = S('playing', T('b'), 1_000, 2500);
  const ev = diffPlayback(prev, curr, 2500, 'a');
  assert.deepEqual(types(ev), ['TRACK_CHANGED']);
  assert.equal(ev[0].track.key, 'b');
  assert.equal(ev[0].prevTrack.key, 'a');
});

test('mesma faixa avançando normalmente: nada', () => {
  const prev = S('playing', T('a'), 10_000, 0);
  assert.deepEqual(diffPlayback(prev, S('playing', T('a'), 12_500, 2500), 2500, 'a'), []);
});

test('pause / play', () => {
  const prev = S('playing', T('a'), 10_000, 0);
  assert.deepEqual(types(diffPlayback(prev, S('paused', T('a'), 12_400, 2500), 2500, 'a')), ['PLAY_STATE_CHANGED']);
  const p2 = S('paused', T('a'), 12_400, 2500);
  assert.deepEqual(types(diffPlayback(p2, S('playing', T('a'), 12_600, 6500), 6500, 'a')), ['PLAY_STATE_CHANGED']);
});

test('seek', () => {
  const prev = S('playing', T('a'), 10_000, 0);
  assert.deepEqual(types(diffPlayback(prev, S('playing', T('a'), 60_000, 2500), 2500, 'a')), ['SEEKED']);
  assert.deepEqual(types(diffPlayback(prev, S('playing', T('a'), 5_000, 2500), 2500, 'a')), ['SEEKED']);
});

test('repeat-one: progress volta a ~0 => TRACK_RESTARTED (não TRACK_CHANGED)', () => {
  const prev = S('playing', T('a', 200_000), 198_000, 0);
  const ev = diffPlayback(prev, S('playing', T('a', 200_000), 2_000, 2400), 2400, 'a');
  assert.deepEqual(types(ev), ['TRACK_RESTARTED']);
  const prev2 = S('playing', T('a'), 90_000, 0);
  assert.deepEqual(types(diffPlayback(prev2, S('playing', T('a'), 1_000, 2500), 2500, 'a')), ['TRACK_RESTARTED']);
});

test('204 / sem device => STOPPED só se havia faixa', () => {
  assert.deepEqual(types(diffPlayback(S('playing', T('a'), 1, 0), S('no_device', null, 0, 10), 10, 'a')), ['STOPPED']);
  assert.deepEqual(diffPlayback(S('no_device', null, 0, 0), S('no_device', null, 0, 10), 10, null), []);
});

test('anúncio / episódio => UNSUPPORTED', () => {
  assert.deepEqual(types(diffPlayback(S('playing', T('a'), 1, 0), S('unsupported', null, 0, 10), 10, 'a')), ['UNSUPPORTED']);
});

test('primeiro poll: TRACK_CHANGED só se a faixa não é a já aberta', () => {
  assert.deepEqual(types(diffPlayback(null, S('playing', T('a'), 1, 0), 0, null)), ['TRACK_CHANGED']);
  assert.deepEqual(diffPlayback(null, S('playing', T('a'), 1, 0), 0, 'a'), []);
  // voltando de podcast para a mesma música já aberta
  assert.deepEqual(diffPlayback(S('unsupported', null, 0, 0), S('playing', T('a'), 1, 10), 10, 'a'), []);
  assert.deepEqual(types(diffPlayback(S('unsupported', null, 0, 0), S('playing', T('b'), 1, 10), 10, 'a')), ['TRACK_CHANGED']);
});

test('projectedProgress', () => {
  assert.equal(projectedProgress(S('playing', T('a'), 1000, 0), 500), 1500);
  assert.equal(projectedProgress(S('paused', T('a'), 1000, 0), 500), 1000);
  assert.equal(projectedProgress(null), 0);
});

test('toSnapshot', () => {
  assert.equal(toSnapshot(null, 5).status, 'no_device');
  assert.equal(toSnapshot({ currently_playing_type: 'ad', item: null, is_playing: true }, 5).status, 'unsupported');
  assert.equal(toSnapshot({ currently_playing_type: 'episode', item: { type: 'episode' }, is_playing: true }, 5).status, 'unsupported');
  const s = toSnapshot({
    is_playing: true, progress_ms: 1234, repeat_state: 'track', currently_playing_type: 'track',
    device: { id: 'dev', name: 'PC' },
    item: { type: 'track', id: 'abc', uri: 'spotify:track:abc', name: 'Song', duration_ms: 200000, artists: [{ name: 'X' }, { name: 'Y' }],
      album: { name: 'Alb', images: [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }] } },
  }, 99);
  assert.equal(s.status, 'playing');
  assert.equal(s.sampledAt, 99);
  assert.equal(s.track.key, 'abc');
  assert.deepEqual(s.track.artists, ['X', 'Y']);
  assert.equal(s.track.imageUrl, 'small');
  assert.equal(s.repeatState, 'track');
  assert.equal(s.deviceName, 'PC');
  const local = toSnapshot({ is_playing: false, progress_ms: 0, item: { type: 'track', id: null, is_local: true, name: 'Minha Música', artists: [{ name: 'Fulano' }], duration_ms: 1 } }, 1);
  assert.equal(local.status, 'paused');
  assert.equal(local.track.key, 'local:fulano minha musica');
  assert.equal(local.track.isLocal, true);
});

test('computeNextDelay (§6.3)', () => {
  const now = 1_000_000_000;
  const rt = { lastPlayingAt: now };
  assert.equal(computeNextDelay(S('playing', T('a', 200_000), 10_000, now), rt, now), POLL_PLAYING_MS);
  assert.equal(computeNextDelay(S('playing', T('a', 200_000), 198_500, now), rt, now), Math.max(1500 + POLL_NEAR_END_GRACE_MS, POLL_MIN_MS));
  assert.equal(computeNextDelay(S('playing', T('a', 200_000), 199_900, now), rt, now), POLL_MIN_MS);
  assert.equal(computeNextDelay(S('paused', T('a'), 0, now), rt, now), POLL_PAUSED_MS);
  assert.equal(computeNextDelay(S('no_device', null, 0, now), rt, now), POLL_NO_DEVICE_MS);
  const old = { lastPlayingAt: now - IDLE_AFTER_MS - 1 };
  assert.equal(computeNextDelay(S('paused', T('a'), 0, now), old, now), IDLE);
  assert.equal(computeNextDelay(S('unsupported', null, 0, now), old, now), IDLE);
});

test('shouldRun / backoffDelay', () => {
  const s = { enabled: true, clientId: 'x', spotifyToYoutube: true };
  assert.equal(shouldRun(s, {}, {}), true);
  assert.equal(shouldRun({ ...s, enabled: false }, {}, {}), false);
  assert.equal(shouldRun(s, null, {}), false);
  assert.equal(shouldRun({ ...s, spotifyToYoutube: false }, {}, {}), false);
  assert.equal(shouldRun({ ...s, spotifyToYoutube: false }, {}, { syncTarget: {} }), true);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
});
