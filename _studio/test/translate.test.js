const assert = require('assert');
const T = require('../lib/translate.js');
const S = require('../lib/subtitles.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('buildPrompt numbers every line + states the target language + count', () => {
  const pr = T.buildPrompt(['Hello there.', 'A second line.'], 'Spanish');
  assert.ok(/into Spanish/.test(pr));
  assert.ok(/EXACTLY 2 lines/.test(pr));
  assert.ok(/1\tHello there\./.test(pr) && /2\tA second line\./.test(pr));
});

t('parseLines realigns by leading number (tab / dot / paren)', () => {
  const r = T.parseLines('1\tHola.\n2. Una segunda línea.\n3) Tercera.', 3);
  assert.deepStrictEqual(r, ['Hola.', 'Una segunda línea.', 'Tercera.']);
});

t('parseLines strips code fences + blank lines, fills positionally when unnumbered', () => {
  const r = T.parseLines('```\nHola.\n\nUna segunda línea.\n```', 2);
  assert.deepStrictEqual(r, ['Hola.', 'Una segunda línea.']);
});

t('parseLines pads with null when the model drops a line (caller falls back)', () => {
  const r = T.parseLines('1\tHola.\n3\tTercera.', 3);
  assert.deepStrictEqual(r, ['Hola.', null, 'Tercera.']);
});

t('LANGS has the big-audience codes', () => {
  ['es', 'pt', 'hi', 'ar', 'fr', 'de', 'id'].forEach((c) => assert.ok(T.LANGS[c], 'missing ' + c));
});

t('subtitles: parseSrt round-trips with buildSrtFromCues', () => {
  const srt = '1\n00:00:00,000 --> 00:00:03,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:06,000\nSecond line.\n';
  const cues = S.parseSrt(srt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, '00:00:00,000');
  assert.strictEqual(cues[1].text, 'Second line.');
  assert.strictEqual(S.buildSrtFromCues(cues), srt);
});

t('subtitles: translated cues keep timing, swap text; vtt mirrors', () => {
  const cues = S.parseSrt('1\n00:00:00,000 --> 00:00:03,000\nHello.\n');
  cues[0].text = 'Hola.';
  assert.ok(/00:00:00,000 --> 00:00:03,000\nHola\./.test(S.buildSrtFromCues(cues)));
  const vtt = S.buildVttFromCues(cues);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(/00:00:00\.000 --> 00:00:03\.000/.test(vtt));
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
