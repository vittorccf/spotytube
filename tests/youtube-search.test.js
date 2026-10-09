import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonAssignment } from '../src/background/youtube-html.js';
import { parseSearchData, deepCollect } from '../src/background/youtube-search.js';
import { metaFromPlayerResponse } from '../src/background/youtube-watch-meta.js';
import { rankCandidates } from '../src/background/clip-ranker.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const searchFixtures = fs.readdirSync(dir).filter((f) => /^yt-search-.*\.html$/.test(f));

test('extractJsonAssignment: "};" e chaves dentro de strings', () => {
  const html = '<script>var ytInitialData = {"a":"x};</script>{","b":{"c":"\\"}"},"d":[1,2]};</script>';
  assert.deepEqual(extractJsonAssignment(html, 'ytInitialData'), { a: 'x};</script>{', b: { c: '"}' }, d: [1, 2] });
});

test('extractJsonAssignment: marcadores alternativos e ausência', () => {
  assert.deepEqual(extractJsonAssignment('window["ytInitialData"] = {"k":1};', 'ytInitialData'), { k: 1 });
  assert.deepEqual(extractJsonAssignment('x; ytInitialData = {"k":2};', 'ytInitialData'), { k: 2 });
  assert.equal(extractJsonAssignment('<html>nada</html>', 'ytInitialData'), null);
  assert.equal(extractJsonAssignment('var ytInitialData = {"k":', 'ytInitialData'), null);
  assert.equal(extractJsonAssignment('var ytInitialData = {bad json};', 'ytInitialData'), null);
});

test('há pelo menos 3 fixtures de busca', () => {
  assert.ok(searchFixtures.length >= 3, searchFixtures.join(','));
});

for (const f of searchFixtures) {
  test(`parseSearchData com fixture real ${f}`, () => {
    const data = extractJsonAssignment(read(f), 'ytInitialData');
    assert.ok(data, 'ytInitialData encontrado');
    const cands = parseSearchData(data);
    assert.ok(cands.length >= 10, `candidatos=${cands.length}`);
    for (const c of cands) {
      assert.match(c.videoId, /^[A-Za-z0-9_-]{11}$/);
      assert.equal(typeof c.title, 'string');
      assert.ok(c.title.length > 0);
      assert.equal(c.isLive, false);
    }
    assert.deepEqual(cands.map((c) => c.position), cands.map((_, i) => i));
    assert.ok(cands.filter((c) => Number.isFinite(c.durationSec)).length >= 10, 'durações');
    assert.ok(cands.some((c) => c.badge === 'oac' || c.badge === 'verified'), 'badges');
    assert.ok(cands.some((c) => c.views > 0), 'views');
    assert.equal(new Set(cands.map((c) => c.videoId)).size, cands.length, 'dedupe');
  });
}

test('ranking nas fixtures escolhe o clipe oficial esperado', () => {
  const cases = [
    ['yt-search-rick-astley.html', { name: 'Never Gonna Give You Up', artists: ['Rick Astley'], album: 'Whenever You Need Somebody', durationMs: 213_000 }, 'dQw4w9WgXcQ'],
    ['yt-search-anitta.html', { name: 'Envolver', artists: ['Anitta'], album: 'Envolver', durationMs: 193_000 }, 'hFCjGiawJi4'],
  ];
  for (const [f, track, expected] of cases) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    const ranked = rankCandidates(parseSearchData(extractJsonAssignment(read(f), 'ytInitialData')), track);
    assert.equal(ranked[0].videoId, expected, `${f}: ${ranked[0].title}`);
  }
});

test('parseSearchData: fallback deepCollect quando o caminho muda + ignora shorts/lives', () => {
  const vr = (id, extra = {}) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: 'T ' + id }] }, ownerText: { runs: [{ text: 'Ch' }] }, lengthText: { simpleText: '3:00' }, ...extra } });
  const data = {
    weird: { nested: [{ x: vr('aaaaaaaaaaa') }, vr('bbbbbbbbbbb'), vr('aaaaaaaaaaa')] },
    shorts: { reelItemRenderer: { inner: vr('ccccccccccc') } },
    live: vr('ddddddddddd', { lengthText: undefined, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] }),
  };
  const c = parseSearchData(data);
  assert.deepEqual(c.map((x) => x.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.equal(c[0].durationSec, 180);
});

test('parseSearchData: lockupViewModel best-effort', () => {
  const data = {
    contents: { foo: [{ lockupViewModel: {
      contentId: 'eeeeeeeeeee',
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '4:05' } }] } }] } },
      metadata: { lockupMetadataViewModel: {
        title: { content: 'Artist - Song (Official Video)' },
        metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'ArtistVEVO' } }] }, { metadataParts: [{ text: { content: '1.5M views' } }] }] } },
      } },
    } }] },
  };
  const [c] = parseSearchData(data);
  assert.equal(c.videoId, 'eeeeeeeeeee');
  assert.equal(c.title, 'Artist - Song (Official Video)');
  assert.equal(c.channel, 'ArtistVEVO');
  assert.equal(c.durationSec, 245);
  assert.equal(c.views, 1_500_000);
});

test('deepCollect não desce no coletado', () => {
  const out = deepCollect({ a: { k: { k: 1 } }, b: [{ k: { z: 2 } }] }, 'k');
  assert.equal(out.length, 2);
});

test('watch page fixture -> VideoMeta', () => {
  const f = fs.readdirSync(dir).find((x) => /^yt-watch-.*\.html$/.test(x));
  assert.ok(f, 'fixture de watch');
  const pr = extractJsonAssignment(read(f), 'ytInitialPlayerResponse');
  const meta = metaFromPlayerResponse(pr, 'dQw4w9WgXcQ');
  assert.equal(meta.videoId, 'dQw4w9WgXcQ');
  assert.match(meta.title, /Never Gonna Give You Up/);
  assert.ok(meta.lengthSec > 200 && meta.lengthSec < 220);
  assert.equal(meta.isLive, false);
});
