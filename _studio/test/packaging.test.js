const assert = require('assert');
const P = require('../lib/packaging.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('contentTokens strips stopwords + punctuation', () => {
  assert.deepStrictEqual(P.contentTokens('The reason humans cry.'), ['reason', 'humans', 'cry']);
});
t('tokenOverlap identical = 1', () => assert.strictEqual(P.tokenOverlap('humans cry tears', 'humans cry tears'), 1));
t('tokenOverlap disjoint = 0', () => assert.strictEqual(P.tokenOverlap('lizards birds', 'mammoth tiger'), 0));
t('tokenOverlap catches a literal reword (>0.6)', () => {
  assert.ok(P.tokenOverlap('Why Humans Cry', 'Why Do Humans Cry') > 0.6);
});
t('tokenOverlap leaves a structurally distinct pair low (<=0.6)', () => {
  assert.ok(P.tokenOverlap('The Reason Crying Blurs Your Vision', 'Why Humans Are the Only Animal That Cries') <= 0.6);
});
t('nonAnswerHit flags dead-end / non-answer title framings', () => {
  assert.ok(P.nonAnswerHit("Why Do You Have a Chin? Science Doesn't Know"));
  assert.ok(P.nonAnswerHit('The Chin Mystery: 150 Years, Still No Answer'));
  assert.ok(P.nonAnswerHit('The Bone That Remains a Mystery'));
  assert.ok(P.nonAnswerHit('A Fossil That Stumped Scientists'));
});
t('nonAnswerHit passes titles that promise a payoff', () => {
  assert.strictEqual(P.nonAnswerHit('Your Chin Hints We Tamed Ourselves Like Dogs'), null);
  assert.strictEqual(P.nonAnswerHit("Why You Have a Chin and Neanderthals Didn't"), null);
  assert.strictEqual(P.nonAnswerHit('Your Chin Is Leftover Bone From a Shrinking Face'), null);
});
t('layoutHeadline joins the text lines', () => {
  assert.strictEqual(P.layoutHeadline({ text: [{ line: 'ONLY', role: 'white' }, { line: 'US', role: 'accent' }] }), 'ONLY US');
});
t('layoutElementCount = subject + props + text lines', () => {
  assert.strictEqual(P.layoutElementCount({ subject: { who: 'The Guy' }, props: ['tear', 'eyes'], text: [{ line: 'ONLY US' }] }), 4);
  assert.strictEqual(P.layoutElementCount({ subject: { who: 'none' }, props: [], text: [] }), 0);
});
t('titlesMdTitleBlank flags the unfilled template placeholder', () => {
  const blankTemplate = [
    '## Chosen pair',
    '- **Title:** ____________________  (40–60 chars; keyword in first 3–5 words)',
    '- **Thumbnail concept:** ____________________',
  ].join('\n');
  assert.strictEqual(P.titlesMdTitleBlank(blankTemplate), true);
});
t('titlesMdTitleBlank passes a synced real title', () => {
  const synced = [
    '## Chosen pair',
    '- **Title:** How Did Humans End Up on Every Continent?',
    '- **Thumbnail concept:** We\'re Everywhere (th-globe)',
  ].join('\n');
  assert.strictEqual(P.titlesMdTitleBlank(synced), false);
});
t('titlesMdTitleBlank treats a missing file (null/undefined text) as blank', () => {
  assert.strictEqual(P.titlesMdTitleBlank(null), true);
  assert.strictEqual(P.titlesMdTitleBlank(undefined), true);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
