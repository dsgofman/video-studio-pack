const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/shortsdist.js');

test('PLATFORMS', () => { assert.deepStrictEqual(S.PLATFORMS, ['youtube', 'tiktok', 'instagram']); });

test('UNIVERSAL_SAFE has the four insets, big bottom band', () => {
  for (const k of ['top', 'bottom', 'left', 'right']) assert.ok(typeof S.UNIVERSAL_SAFE[k] === 'number');
  assert.ok(S.UNIVERSAL_SAFE.bottom >= 300);
});

test('coverTextRect is centered within the central square of 1080x1920', () => {
  const r = S.coverTextRect(1080, 1920);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  assert.ok(Math.abs(cx - 540) < 2);          // horizontally centered
  assert.ok(Math.abs(cy - 960) < 60);         // vertically near-centered
  assert.ok(r.y >= 420 && r.y + r.h <= 1500); // within the central ~1080 square (IG grid-safe)
});

const clip = { hook: 'You were prey', postCaption: "You were prey for 2 million years. Full story on the channel: 'X'. #history #evolution", bigLoop: 'why did it stop?' };
const ctx = { channel: 'History', longUrl: 'https://youtu.be/abc123', longTitle: 'X' };

test('youtube caption keeps the funnel URL + #Shorts', () => {
  const c = S.buildCaption('youtube', clip, ctx);
  assert.ok(c.includes('https://youtu.be/abc123'));
  assert.ok(/#Shorts/i.test(c));
});

test('tiktok caption: link-in-bio, NO url, has tiktok hashtags', () => {
  const c = S.buildCaption('tiktok', clip, ctx);
  assert.ok(/link in bio/i.test(c));
  assert.ok(!/https?:\/\/|youtu\.be/i.test(c));
  assert.ok(c.includes('#fyp') || c.includes('#foryou'));
});

test('instagram caption: link-in-bio, NO url, has hashtags', () => {
  const c = S.buildCaption('instagram', clip, ctx);
  assert.ok(/link in bio/i.test(c));
  assert.ok(!/https?:\/\/|youtu\.be/i.test(c));
  assert.ok(/#/.test(c));
});

test('defaultHashtags returns non-empty arrays per platform', () => {
  const h = S.defaultHashtags('History');
  for (const p of S.PLATFORMS) assert.ok(Array.isArray(h[p]) && h[p].length);
});
