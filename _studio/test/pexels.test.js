const assert = require('assert');
const P = require('../lib/pexels.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

// a trimmed real Pexels /v1/search response shape
const SAMPLE = {
  photos: [
    { id: 1, width: 800, height: 1200, photographer: 'A', photographer_url: 'http://a', url: 'http://px/1', alt: 'portrait', src: { large2x: 'l2x1', large: 'l1', medium: 'm1', original: 'o1' } },
    { id: 2, width: 1920, height: 1280, photographer: 'B', photographer_url: 'http://b', url: 'http://px/2', alt: 'iceman mummy', src: { large2x: 'l2x2', large: 'l2', medium: 'm2', original: 'o2' } },
    { id: 3, width: 4000, height: 2667, photographer: 'C', photographer_url: 'http://c', url: 'http://px/3', alt: 'cave', src: { large2x: 'l2x3', large: 'l3', medium: 'm3', original: 'o3' } },
  ],
};

t('searchUrl encodes query + landscape + per_page', () => {
  const u = P.searchUrl('the actual Ötzi iceman mummy');
  assert.ok(u.startsWith('https://api.pexels.com/v1/search?'));
  assert.ok(/orientation=landscape/.test(u));
  assert.ok(/per_page=15/.test(u));
  assert.ok(/query=the\+actual/.test(u));
});

t('searchUrl clamps a very long query', () => {
  const u = P.searchUrl('x'.repeat(500));
  const q = decodeURIComponent((u.match(/query=([^&]+)/) || [])[1] || '');
  assert.ok(q.length <= 120);
});

t('pickBest skips the portrait, takes the first wide landscape', () => {
  const best = P.pickBest(SAMPLE.photos);
  assert.strictEqual(best.id, 2);   // #1 is portrait (800<1200 and taller); #2 is the first wide landscape
});

t('pickBest falls back to the first when none meet minWidth', () => {
  const best = P.pickBest([{ id: 9, width: 600, height: 400, src: { large: 'x' } }]);
  assert.strictEqual(best.id, 9);
  assert.strictEqual(P.pickBest([]), null);
});

t('bestSrc prefers large2x then degrades', () => {
  assert.strictEqual(P.bestSrc(SAMPLE.photos[1]), 'l2x2');
  assert.strictEqual(P.bestSrc({ src: { medium: 'only' } }), 'only');
  assert.strictEqual(P.bestSrc({}), '');
});

t('attribution maps the credit fields', () => {
  const a = P.attribution(SAMPLE.photos[2]);
  assert.deepStrictEqual(a, { id: 3, photographer: 'C', photographerUrl: 'http://c', pexelsUrl: 'http://px/3', alt: 'cave' });
});

// ---- relevance-aware image picking ----
t('terms folds diacritics (Ötzi→otzi) + drops stop-words/short tokens', () => {
  assert.deepStrictEqual(P.terms('the ACTUAL Ötzi iceman mummy'), ['otzi', 'iceman', 'mummy']);
});
t('relevance matches an accented query against an ASCII alt (Ötzi ↔ Otzi)', () => {
  assert.strictEqual(P.relevanceScore('Ötzi mummy', 'the Otzi mummy exhibit'), 1);
});
t('relevanceScore = fraction of query content words present in the text', () => {
  assert.strictEqual(P.relevanceScore('iceman mummy', 'a frozen iceman mummy on ice'), 1);
  assert.strictEqual(P.relevanceScore('iceman mummy', 'a snowy mountain'), 0);
  assert.ok(Math.abs(P.relevanceScore('iceman mummy fossil', 'the iceman exhibit') - 1 / 3) < 1e-9);
});
t('pickBest with a query prefers the alt-relevant landscape over raw order', () => {
  const photos = [
    { id: 1, width: 1920, height: 1080, alt: 'snowy mountain landscape', url: 'http://px/mtn', src: { large: 'a' } },
    { id: 2, width: 1920, height: 1080, alt: 'the iceman mummy on display', url: 'http://px/mummy', src: { large: 'b' } },
  ];
  assert.strictEqual(P.pickBest(photos, { query: 'iceman mummy' }).id, 2);   // #1 is first but off-topic
});
t('pickBest with a query falls back to first when nothing matches', () => {
  const photos = [
    { id: 1, width: 1920, height: 1080, alt: 'random', url: 'http://px/x', src: { large: 'a' } },
    { id: 2, width: 1920, height: 1080, alt: 'other', url: 'http://px/y', src: { large: 'b' } },
  ];
  assert.strictEqual(P.pickBest(photos, { query: 'iceman mummy' }).id, 1);
});
t('pickBest without a query keeps the old first-wide-landscape behavior', () => {
  assert.strictEqual(P.pickBest(SAMPLE.photos).id, 2);
});

// ---- video ----
const VIDS = {
  videos: [
    { id: 10, width: 640, height: 1138, duration: 8, url: 'https://www.pexels.com/video/portrait-clip-10/', user: { name: 'V1', url: 'http://v1' },
      video_files: [{ quality: 'sd', file_type: 'video/mp4', width: 640, height: 1138, link: 'p10.mp4' }] },
    { id: 11, width: 3840, height: 2160, duration: 12, url: 'https://www.pexels.com/video/lascaux-cave-paintings-11/', user: { name: 'V2', url: 'http://v2' },
      video_files: [
        { quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'p11-4k.mp4' },
        { quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'p11-1080.mp4' },
        { quality: 'sd', file_type: 'video/mp4', width: 960, height: 540, link: 'p11-540.mp4' },
      ] },
    { id: 12, width: 1920, height: 1080, duration: 1, url: 'https://www.pexels.com/video/quick-sting-12/', user: { name: 'V3', url: 'http://v3' },
      video_files: [{ quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'p12.mp4' }] },
  ],
};
t('videoSearchUrl hits the videos endpoint, landscape, encoded', () => {
  const u = P.videoSearchUrl('Lascaux cave paintings');
  assert.ok(u.startsWith('https://api.pexels.com/videos/search?'));
  assert.ok(/orientation=landscape/.test(u));
  assert.ok(/query=Lascaux\+cave/.test(u));
});
t('pickBestVideo skips portrait + too-short, prefers the relevant landscape', () => {
  const v = P.pickBestVideo(VIDS.videos, { query: 'lascaux cave paintings' });
  assert.strictEqual(v.id, 11);   // #10 portrait, #12 duration 1s too short, #11 matches slug
});
t('pickBestVideo requires a usable mp4 file', () => {
  assert.strictEqual(P.pickBestVideo([{ id: 1, width: 1920, height: 1080, duration: 10, video_files: [{ file_type: 'video/webm', link: 'x.webm' }] }]), null);
  assert.strictEqual(P.pickBestVideo([]), null);
});
t('bestVideoFile picks ~1080p, never the 4K original', () => {
  assert.strictEqual(P.bestVideoFile(VIDS.videos[1]), 'p11-1080.mp4');
});
t('bestVideoFile degrades to the largest under cap when no exact 1080', () => {
  const v = { video_files: [{ file_type: 'video/mp4', width: 960, height: 540, link: 'a.mp4' }, { file_type: 'video/mp4', width: 1280, height: 720, link: 'b.mp4' }] };
  assert.strictEqual(P.bestVideoFile(v), 'b.mp4');   // 720 nearest 1080 under cap
});
t('videoAttribution maps user → credit fields', () => {
  assert.deepStrictEqual(P.videoAttribution(VIDS.videos[1]), { id: 11, photographer: 'V2', photographerUrl: 'http://v2', pexelsUrl: 'https://www.pexels.com/video/lascaux-cave-paintings-11/', duration: 12 });
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
