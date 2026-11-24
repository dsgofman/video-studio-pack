const assert = require('assert');
const { rebuildShortDescription } = require('../lib/funnel.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('appends funnel line when none present', () => {
  const out = rebuildShortDescription('A great caption.\n\n#Shorts', 'https://youtu.be/NEW');
  assert.ok(out.includes('Full video → https://youtu.be/NEW'), 'has new link');
  assert.ok(out.trim().endsWith('#Shorts'), '#Shorts last');
  assert.ok(out.startsWith('A great caption.'), 'caption preserved');
});
t('replaces a stale funnel link without duplicating', () => {
  const cur = 'Caption here.\n\nFull video → https://youtu.be/OLD\n\n#Shorts';
  const out = rebuildShortDescription(cur, 'https://youtu.be/NEW');
  assert.ok(out.includes('https://youtu.be/NEW') && !out.includes('OLD'), 'swapped');
  assert.strictEqual((out.match(/Full video →/g) || []).length, 1, 'exactly one funnel line');
});
t('idempotent — running twice yields the same string', () => {
  const once = rebuildShortDescription('Caption.\n\n#Shorts', 'https://youtu.be/X');
  const twice = rebuildShortDescription(once, 'https://youtu.be/X');
  assert.strictEqual(once, twice);
});
t('keeps #Shorts last even when replacing', () => {
  const out = rebuildShortDescription('Cap.\n\nFull video → https://youtu.be/OLD\n\n#Shorts', 'https://youtu.be/NEW');
  assert.ok(out.trim().endsWith('#Shorts'));
});
t('no longUrl → strips funnel line, leaves caption + tag', () => {
  const out = rebuildShortDescription('Cap.\n\nFull video → https://youtu.be/OLD\n\n#Shorts', '');
  assert.ok(!/Full video →/.test(out) && out.includes('Cap.') && out.trim().endsWith('#Shorts'));
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
