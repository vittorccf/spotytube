import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery, scoreCandidate, rankCandidates, channelCore, channelMatchesArtist, mergeDedup, buildSearchScrapeUrl,
} from '../src/background/clip-ranker.js';
import { CLIP_ACCEPT_SCORE } from '../src/shared/constants.js';

const track = { key: 't1', name: 'Song Title', artists: ['The Artist'], album: 'Album', durationMs: 200_000 };
const cand = (o) => ({ videoId: 'x', title: '', channel: '', channelUrl: null, durationSec: 200, views: 1_000_000, badge: null, isLive: false, position: 5, ...o });

test('buildQuery', () => {
  assert.equal(buildQuery(track, { withOfficial: true }), 'The Artist Song Title official video');
  assert.equal(buildQuery(track, { withOfficial: false }), 'The Artist Song Title');
  assert.equal(buildQuery({ ...track, name: 'Song - X Remix' }, { withOfficial: true }), 'The Artist Song official video remix');
  assert.equal(buildQuery({ ...track, name: 'Song - Live at Wembley' }, { withOfficial: false }), 'The Artist Song live');
  assert.match(buildSearchScrapeUrl('a b'), /search_query=a%20b&sp=EgIQAQ%253D%253D&hl=en$/);
});

test('channelCore / channelMatchesArtist', () => {
  assert.equal(channelCore('taylorswiftvevo'), 'taylorswift');
  assert.equal(channelCore('the artist official'), 'the artist');
  assert.equal(channelCore('the artist topic'), 'the artist');
  assert.ok(channelMatchesArtist('taylorswiftvevo', 'taylor swift'));
  assert.ok(channelMatchesArtist('the artist', 'the artist'));
  assert.ok(!channelMatchesArtist('random covers', 'the artist'));
});

const official = cand({ videoId: 'official', title: 'The Artist - Song Title (Official Music Video)', channel: 'TheArtistVEVO', badge: 'oac', durationSec: 240, views: 500_000_000, position: 0 });
const lyric = cand({ videoId: 'lyric', title: 'The Artist - Song Title (Lyrics)', channel: 'Lyrics Hub', durationSec: 200, views: 2_000_000, position: 1 });
const topic = cand({ videoId: 'topic', title: 'Song Title', channel: 'The Artist - Topic', durationSec: 200, views: 3_000_000, position: 2 });
const cover = cand({ videoId: 'cover', title: 'Song Title - The Artist (Cover by Someone)', channel: 'Someone Music', durationSec: 210, views: 100_000, position: 3 });
const reaction = cand({ videoId: 'reaction', title: 'REACTION to The Artist - Song Title', channel: 'Reactor', durationSec: 900, views: 50_000, position: 4 });
const wrong = cand({ videoId: 'wrong', title: 'Completely Different Thing', channel: 'Other', durationSec: 200, position: 5 });

test('calibração: oficial VEVO/OAC ~180, lyric ~50-60, errado < 0', () => {
  const o = scoreCandidate(official, track);
  assert.ok(o.score >= 160 && o.score <= 200, `oficial=${o.score}`);
  assert.ok(o.reasons.includes('+oac 20'));
  const l = scoreCandidate(lyric, track);
  assert.ok(l.score >= 40 && l.score <= 80, `lyric=${l.score}`);
  const w = scoreCandidate(wrong, track);
  assert.ok(w.score < 0, `errado=${w.score}`);
});

test('ordem: oficial > lyric > audio Topic > cover > reaction', () => {
  const ranked = rankCandidates([reaction, cover, topic, lyric, official], track).map((c) => c.videoId);
  assert.deepEqual(ranked, ['official', 'lyric', 'topic', 'cover', 'reaction']);
  const top = rankCandidates([official, lyric], track)[0];
  assert.ok(top.score >= CLIP_ACCEPT_SCORE);
});

test('remix só ganha se a faixa é remix', () => {
  const orig = cand({ videoId: 'orig', title: 'The Artist - Song Title (Official Video)', channel: 'The Artist', position: 1 });
  const rmx = cand({ videoId: 'rmx', title: 'The Artist - Song Title (DJ Remix) (Official Video)', channel: 'The Artist', position: 0 });
  assert.equal(rankCandidates([rmx, orig], track)[0].videoId, 'orig');
  const remixTrack = { ...track, name: 'Song Title - DJ Remix' };
  assert.equal(rankCandidates([orig, rmx], remixTrack)[0].videoId, 'rmx');
});

test('música chamada "Cover Me Up" não é penalizada por "cover"', () => {
  const t = { ...track, name: 'Cover Me Up', artists: ['Jason Isbell'] };
  const c = cand({ title: 'Jason Isbell - Cover Me Up (Official Video)', channel: 'Jason Isbell' });
  const r = scoreCandidate(c, t);
  assert.ok(!r.reasons.some((x) => x.includes('cover')), r.reasons.join(','));
  // música "Live Forever" não leva -live
  const lf = scoreCandidate(cand({ title: 'Oasis - Live Forever (Official Video)', channel: 'Oasis' }), { ...track, name: 'Live Forever', artists: ['Oasis'] });
  assert.ok(!lf.reasons.some((x) => x.startsWith('-live')), lf.reasons.join(','));
});

test('negativos: live, 8d/slowed, teaser, duração curta', () => {
  const live = scoreCandidate(cand({ title: 'The Artist - Song Title (Live at Rock in Rio)', channel: 'The Artist' }), track);
  assert.ok(live.reasons.some((x) => x.startsWith('-live')));
  const slowed = scoreCandidate(cand({ title: 'The Artist - Song Title (slowed + reverb)' }), track);
  assert.ok(slowed.reasons.some((x) => x.startsWith('-edited')));
  const teaser = scoreCandidate(cand({ title: 'The Artist - Song Title (Teaser)', durationSec: 30 }), track);
  assert.ok(teaser.reasons.some((x) => x.startsWith('-teaser')));
  assert.ok(teaser.reasons.some((x) => x.startsWith('-too short')));
});

test('mergeDedup mantém maior score e ordena', () => {
  const a = [{ videoId: 'a', score: 10 }, { videoId: 'b', score: 50 }];
  const b = [{ videoId: 'a', score: 70 }, { videoId: 'c', score: 5 }];
  assert.deepEqual(mergeDedup(a, b).map((c) => [c.videoId, c.score]), [['a', 70], ['b', 50], ['c', 5]]);
});
