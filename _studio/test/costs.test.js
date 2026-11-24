const assert = require('assert');
const C = require('../lib/costs.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('image cost by model', () => {
  assert.strictEqual(C.imageUsd('flash'), 0.039);
  assert.strictEqual(C.imageUsd('pro'), 0.134);
  assert.strictEqual(C.imageUsd('pro', 3), 0.134 * 3);
});

t('tts credits + usd (turbo 0.5 cr/char, Starter $5/30k)', () => {
  assert.strictEqual(C.ttsCredits(1000), 500);
  assert.ok(Math.abs(C.ttsUsd(30000) - 2.5) < 1e-9, 'a 30k-char video ≈ $2.50 on Starter');
});

t('eventFromPatch maps patches to billable events', () => {
  assert.deepStrictEqual(C.eventFromPatch({ images: 1 }, 'History/008', 5), { ts: 5, key: 'History/008', type: 'image', model: 'flash', units: 1, usd: 0.039, ctx: 'initial' });
  assert.strictEqual(C.eventFromPatch({ imagesPro: 2, ctx: 'thumbnail' }, 'k', 1).usd, 0.268);
  const tts = C.eventFromPatch({ ttsChars: 1000, ctx: 'revoice' }, 'k', 1);
  assert.strictEqual(tts.type, 'tts'); assert.strictEqual(tts.credits, 500); assert.strictEqual(tts.ctx, 'revoice');
  assert.strictEqual(C.eventFromPatch({}, 'k', 1), null);
});

t('aggregate splits re-do spend from initial', () => {
  const events = [
    { key: 'v1', type: 'image', model: 'flash', units: 10, usd: 0.39, ctx: 'initial' },
    { key: 'v1', type: 'image', model: 'flash', units: 2, usd: 0.078, ctx: 'rerender' },  // 2 re-renders
    { key: 'v1', type: 'tts', model: '', units: 7500, usd: 0.625, credits: 3750, ctx: 'initial' },
    { key: 'v1', type: 'tts', model: '', units: 7500, usd: 0.625, credits: 3750, ctx: 'revoice' }, // a full re-voice
  ];
  const { perVideo, total } = C.aggregate(events);
  const v = perVideo.v1;
  assert.strictEqual(v.flashImages, 12);
  assert.strictEqual(v.ttsChars, 15000);
  assert.strictEqual(v.ttsCredits, 7500);
  // re-do USD = the 2 rerenders (0.078) + the revoice (0.625) = 0.703 → rounds to 0.70
  assert.strictEqual(v.redoUsd, 0.70);
  assert.strictEqual(v.redoImages, 2);
  assert.strictEqual(v.redoChars, 7500);
  assert.strictEqual(v.totalUsd, 1.72);   // 0.39 + 0.078 + 0.625 + 0.625 = 1.718 → 1.72
  assert.strictEqual(total.flashImages, 12);   // total mirrors single-video here
});

t('aggregate handles multiple videos + empty', () => {
  const { perVideo, total } = C.aggregate([
    { key: 'a', type: 'image', model: 'pro', units: 1, usd: 0.134, ctx: 'initial' },
    { key: 'b', type: 'image', model: 'flash', units: 1, usd: 0.039, ctx: 'initial' },
  ]);
  assert.strictEqual(perVideo.a.proImages, 1);
  assert.strictEqual(perVideo.b.flashImages, 1);
  assert.strictEqual(total.totalUsd, 0.17);   // 0.134 + 0.039 = 0.173 → 0.17
  assert.deepStrictEqual(C.aggregate([]).perVideo, {});
});

t('parseLedger tolerates blank + torn lines', () => {
  const blob = '{"key":"a","type":"image","model":"flash","units":1,"usd":0.039,"ctx":"initial"}\n\n{torn line\n{"key":"b","type":"tts","units":100,"usd":0.01,"ctx":"initial"}\n';
  const evs = C.parseLedger(blob);
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].key, 'a'); assert.strictEqual(evs[1].key, 'b');
});

t('setTtsPlan switches the credit rate', () => {
  const orig = C.RATES.ttsUsdPerCredit;
  C.setTtsPlan('creator');
  assert.ok(Math.abs(C.RATES.ttsUsdPerCredit - 22 / 100000) < 1e-12);
  C.setTtsPlan('starter');   // restore
  assert.ok(Math.abs(C.RATES.ttsUsdPerCredit - orig) < 1e-12);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
