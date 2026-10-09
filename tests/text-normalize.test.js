import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, tokens, dice, coverage, containsPhrase, parseDuration, parseViews, cleanSpotifyTitle,
} from '../src/shared/text-normalize.js';

test('normalize: acentos, &, apóstrofos, pontuação', () => {
  assert.equal(normalize('Coração'), 'coracao');
  assert.equal(normalize('Simon & Garfunkel'), 'simon and garfunkel');
  assert.equal(normalize("Don't Stop Me Now"), 'dont stop me now');
  assert.equal(normalize('Don’t  Stop!!'), 'dont stop');
  assert.equal(normalize('  AC/DC — Back in Black  '), 'ac dc back in black');
  assert.equal(normalize('Beyoncé'), 'beyonce');
  assert.equal(normalize(null), '');
});

test('tokens remove stopwords, mas não fica vazio', () => {
  assert.deepEqual(tokens('The Beatles'), ['beatles']);
  assert.deepEqual(tokens('O Rappa'), ['rappa']);
  assert.deepEqual(tokens('The The'), ['the', 'the']);
});

test('dice / coverage / containsPhrase', () => {
  assert.equal(dice(['a', 'b'], ['a', 'b']), 1);
  assert.equal(dice([], ['a']), 0);
  assert.equal(dice(['a', 'b'], ['b', 'c']), 0.5);
  assert.equal(coverage(['never', 'gonna'], ['never', 'gonna', 'give']), 1);
  assert.equal(coverage(['x', 'y'], ['x']), 0.5);
  assert.ok(containsPhrase('rick astley never gonna', 'never gonna'));
  assert.ok(!containsPhrase('coverage report', 'cover'));
});

test('parseDuration', () => {
  assert.equal(parseDuration('3:45'), 225);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('0:59'), 59);
  assert.equal(parseDuration('3 minutes, 33 seconds'), 213);
  assert.equal(parseDuration('1 hour, 2 minutes'), 3720);
  assert.equal(parseDuration('LIVE'), null);
  assert.equal(parseDuration(undefined), null);
});

test('parseViews', () => {
  assert.equal(parseViews('1,234,567 views'), 1234567);
  assert.equal(parseViews('1 view'), 1);
  assert.equal(parseViews('No views'), 0);
  assert.equal(parseViews('1.2M views'), 1200000);
  assert.equal(parseViews(null), null);
});

test('cleanSpotifyTitle: remaster', () => {
  const r = cleanSpotifyTitle('Song - Remastered 2011');
  assert.equal(r.clean, 'Song');
  assert.equal(r.flags.remaster, true);
  assert.equal(r.flags.live, false);
  assert.equal(cleanSpotifyTitle('Something - Remastered 2009').clean, 'Something');
});

test('cleanSpotifyTitle: feat / with', () => {
  assert.equal(cleanSpotifyTitle('Song (feat. X)').clean, 'Song');
  assert.equal(cleanSpotifyTitle('Song [with Y]').clean, 'Song');
  assert.equal(cleanSpotifyTitle('Song (ft. Z & W)').clean, 'Song');
});

test('cleanSpotifyTitle: live / remix flags', () => {
  const live = cleanSpotifyTitle('Song - Live at Wembley');
  assert.equal(live.clean, 'Song');
  assert.equal(live.flags.live, true);
  const remix = cleanSpotifyTitle('Song - X Remix');
  assert.equal(remix.clean, 'Song');
  assert.equal(remix.flags.remix, true);
  assert.equal(cleanSpotifyTitle('Song (Acoustic)').flags.acoustic, true);
  assert.equal(cleanSpotifyTitle('Song - Radio Edit').flags.edit, true);
});

test('cleanSpotifyTitle: palavras do próprio nome não viram flag', () => {
  const r = cleanSpotifyTitle('Live Forever');
  assert.equal(r.clean, 'Live Forever');
  assert.equal(r.flags.live, false);
  assert.equal(cleanSpotifyTitle('Remix to Ignition').flags.remix, false);
});

test('cleanSpotifyTitle: mantém título normal e grupos não decorativos', () => {
  assert.equal(cleanSpotifyTitle('Bohemian Rhapsody').clean, 'Bohemian Rhapsody');
  assert.equal(cleanSpotifyTitle('Hey Jude (Take 2)').clean, 'Hey Jude (Take 2)');
  assert.equal(cleanSpotifyTitle('Song - Part 1').clean, 'Song - Part 1');
  assert.equal(cleanSpotifyTitle('(feat. X)').clean, '(feat. X)'); // vazio => original
});
