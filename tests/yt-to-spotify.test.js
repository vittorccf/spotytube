import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoTitle, cleanChannelName, buildSpotifyQueries, scoreTrackMatch, isLikelyMusic,
} from '../src/background/yt-to-spotify.js';
import { YT_MATCH_AUTOPLAY, YT_MATCH_SUGGEST } from '../src/shared/constants.js';
import { parseIsoDuration, decodeHtmlEntities } from '../src/background/youtube-data-api.js';

test('cleanChannelName', () => {
  assert.equal(cleanChannelName('TaylorSwiftVEVO'), 'Taylor Swift');
  assert.equal(cleanChannelName('Artist - Topic'), 'Artist');
  assert.equal(cleanChannelName('Anitta Official'), 'Anitta');
  assert.equal(cleanChannelName('Coldplay'), 'Coldplay');
});

test('"Artist - Song (Official Video) ft. X"', () => {
  const p = parseVideoTitle('Artist - Song (Official Video) ft. X', 'Artist');
  assert.equal(p.artist, 'Artist');
  assert.equal(p.track, 'Song');
  assert.deepEqual(p.featured, ['X']);
});

test('"Artist - Song (feat. A & B) [Official Music Video]"', () => {
  const p = parseVideoTitle('Artist - Song (feat. A & B) [Official Music Video]', 'ArtistVEVO');
  assert.equal(p.artist, 'Artist');
  assert.equal(p.track, 'Song');
  assert.deepEqual(p.featured, ['A', 'B']);
});

test('"Song | Artist"', () => {
  const p = parseVideoTitle('Song | Artist', 'Artist');
  assert.equal(p.artist, 'Artist');
  assert.equal(p.track, 'Song');
});

test('Artist "Song"', () => {
  const p = parseVideoTitle('Artist "Song" (Official Video)', 'Some Label');
  assert.equal(p.artist, 'Artist');
  assert.equal(p.track, 'Song');
  const p2 = parseVideoTitle('Artista “Música”', 'x');
  assert.equal(p2.artist, 'Artista');
  assert.equal(p2.track, 'Música');
});

test('canal "ArtistVEVO" sem separador no título', () => {
  const p = parseVideoTitle('Song (Official Video)', 'TheArtistVEVO');
  assert.equal(p.artist, 'The Artist');
  assert.equal(p.track, 'Song');
});

test('canal "Artist - Topic"', () => {
  const p = parseVideoTitle('Song', 'Artist - Topic');
  assert.equal(p.artist, 'Artist');
  assert.equal(p.track, 'Song');
});

test('"Música - Artista" inverte quando a direita casa com o canal', () => {
  const p = parseVideoTitle('Envolver - Anitta', 'Anitta');
  assert.equal(p.artist, 'Anitta');
  assert.equal(p.track, 'Envolver');
});

test('flags do título do vídeo', () => {
  assert.equal(parseVideoTitle('Artist - Song (Live at Wembley)', 'Artist').flags.live, true);
  assert.equal(parseVideoTitle('Artist - Song (DJ Remix)', 'Artist').flags.remix, true);
  assert.equal(parseVideoTitle('Oasis - Live Forever (Official Video)', 'Oasis').flags.live, false);
});

test('buildSpotifyQueries', () => {
  assert.deepEqual(buildSpotifyQueries({ artist: 'A', track: 'S' }), ['track:"S" artist:"A"', 'A S']);
  assert.deepEqual(buildSpotifyQueries({ artist: null, track: 'S' }), ['S']);
});

const sp = (name, artists, sec) => ({ name, artists: artists.map((n) => ({ name: n })), duration_ms: sec * 1000, uri: 'spotify:track:' + name, id: name });

test('scoreTrackMatch: casamento correto passa do autoplay', () => {
  const p = parseVideoTitle('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley');
  const s = scoreTrackMatch(sp('Never Gonna Give You Up', ['Rick Astley'], 213), p, 213);
  assert.ok(s >= YT_MATCH_AUTOPLAY, `score=${s}`);
});

test('scoreTrackMatch: rejeita karaoke e remix indevido', () => {
  const p = parseVideoTitle('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley');
  const good = scoreTrackMatch(sp('Never Gonna Give You Up', ['Rick Astley'], 213), p, 213);
  const karaoke = scoreTrackMatch(sp('Never Gonna Give You Up (Karaoke Version)', ['Karaoke Hits'], 213), p, 213);
  const remix = scoreTrackMatch(sp('Never Gonna Give You Up - PWL Remix', ['Rick Astley'], 213), p, 213);
  assert.ok(karaoke < YT_MATCH_SUGGEST, `karaoke=${karaoke}`);
  // remix indevido perde para a versão original (o pipeline escolhe o maior score)
  assert.ok(remix < good, `remix=${remix} good=${good}`);
  assert.ok(good - remix >= 0.15, `remix=${remix} good=${good}`);
});

test('scoreTrackMatch: featured dá bônus, artista errado perde', () => {
  const p = parseVideoTitle('Artist - Song (Official Video) ft. Guest', 'Artist');
  const withFeat = scoreTrackMatch(sp('Song (feat. Guest)', ['Artist', 'Guest'], 200), p, 200);
  const noFeat = scoreTrackMatch(sp('Song', ['Artist'], 200), p, 200);
  const wrongArtist = scoreTrackMatch(sp('Song', ['Someone Else'], 200), p, 200);
  assert.ok(withFeat > noFeat);
  assert.ok(wrongArtist < YT_MATCH_AUTOPLAY, `wrong=${wrongArtist}`);
});

test('isLikelyMusic', () => {
  assert.equal(isLikelyMusic({ title: 'x', author: 'y', lengthSec: 200, isLive: false, category: 'Music' }), true);
  assert.equal(isLikelyMusic({ title: 'Song', author: 'ArtistVEVO', lengthSec: 200, isLive: false, category: null }), true);
  assert.equal(isLikelyMusic({ title: 'A - B (Official Video)', author: 'z', lengthSec: 200, isLive: false, category: 'Entertainment' }), true);
  assert.equal(isLikelyMusic({ title: 'How to fix a bike', author: 'z', lengthSec: 600, isLive: false, category: 'Howto & Style' }), false);
  assert.equal(isLikelyMusic({ title: 'x', author: 'y', lengthSec: 30, isLive: false, category: 'Music' }), false);
  assert.equal(isLikelyMusic({ title: 'x', author: 'y', lengthSec: 3600, isLive: false, category: 'Music' }), false);
  assert.equal(isLikelyMusic({ title: 'x', author: 'y', lengthSec: 0, isLive: true, category: 'Music' }), false);
});

test('Data API helpers', () => {
  assert.equal(parseIsoDuration('PT3M33S'), 213);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration('xx'), null);
  assert.equal(decodeHtmlEntities('Rock &amp; Roll &quot;Live&quot; &#39;x&#39;'), 'Rock & Roll "Live" \'x\'');
});
