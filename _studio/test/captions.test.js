const assert = require('assert');
const { wordTimings, parseCues, captionTexts } = require('../lib/captions.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('wordTimings splits chars into words with first-char start time', () => {
  // "Hi there" : chars H,i,space,t,h,e,r,e
  const al = { characters: ['H','i',' ','t','h','e','r','e'], character_start_times_seconds: [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7] };
  assert.deepStrictEqual(wordTimings(al), [{ w: 'hi', t: 0 }, { w: 'there', t: 0.3 }]);
});
t('wordTimings strips punctuation from the matchable word', () => {
  const al = { characters: ['D','N','A','.',' ','3'], character_start_times_seconds: [0,0.1,0.2,0.3,0.4,0.5] };
  assert.deepStrictEqual(wordTimings(al), [{ w: 'dna', t: 0 }, { w: '3', t: 0.5 }]);
});
t('wordTimings returns [] on missing alignment', () => {
  assert.deepStrictEqual(wordTimings({}), []);
  assert.deepStrictEqual(wordTimings(null), []);
});
t('parseCues parses a 3-item build group', () => {
  const cell = 'build~center~species~Neanderthals~Neanderthals~Neanderthals || build~center~species~Denisovans~Denisovans~Denisovans || build~center~species~Hobbit~Hobbit~the Hobbit';
  const c = parseCues(cell);
  assert.strictEqual(c.length, 3);
  assert.deepStrictEqual(c[0], { kind: 'build', pos: 'center', group: 'species', anchor: 'Neanderthals', emph: 'Neanderthals', text: 'Neanderthals' });
  assert.strictEqual(c[2].text, 'the Hobbit');
});
t('parseCues parses a single stat cue with empty group', () => {
  const c = parseCues('stat~top-center~~forty-four~44%~44% less aggressive');
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0], { kind: 'stat', pos: 'top-center', group: '', anchor: 'forty-four', emph: '44%', text: '44% less aggressive' });
});
t('parseCues: empty/absent → []', () => {
  assert.deepStrictEqual(parseCues(''), []);
  assert.deepStrictEqual(parseCues(null), []);
});
t('parseCues skips malformed cues (missing fields)', () => {
  const c = parseCues('badcue || stat~top-center~~x~5~five things');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].text, 'five things');
});
t('parseCues clamps an invalid kind/pos to safe defaults', () => {
  const c = parseCues('weird~nowhere~~a~b~hello there');
  assert.strictEqual(c[0].kind, 'label');       // unknown kind → label
  assert.strictEqual(c[0].pos, 'top-center');   // unknown pos → top-center
});

t('captionTexts: no onScreenText, no cues → []', () => {
  assert.deepStrictEqual(captionTexts({}), []);
  assert.deepStrictEqual(captionTexts({ onScreenText: '', cues: [] }), []);
});
t('captionTexts: legacy onScreenText only', () => {
  assert.deepStrictEqual(captionTexts({ onScreenText: 'NOT FOOD' }), ['NOT FOOD']);
});
t('captionTexts: modern cues[] only (onScreenText empty, as real beats now ship)', () => {
  const scene = { onScreenText: '', cues: [{ text: 'Neanderthals' }, { text: 'Denisovans' }] };
  assert.deepStrictEqual(captionTexts(scene), ['Neanderthals', 'Denisovans']);
});
t('captionTexts: combines legacy + cues, skips cues with empty/missing text', () => {
  const scene = { onScreenText: 'WHAT HAPPENED', cues: [{ text: '  ' }, { text: 'the Hobbit' }, {}] };
  assert.deepStrictEqual(captionTexts(scene), ['WHAT HAPPENED', 'the Hobbit']);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
