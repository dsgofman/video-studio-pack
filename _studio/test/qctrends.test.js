const assert = require('assert');
const Q = require('../lib/qctrends.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

const checksA = [
  { id: 'word-count', level: 'pass', detail: '' },
  { id: 'music-bed', level: 'warn', detail: '' },
  { id: 'opening-decel', level: 'fail', detail: '' },
];
const checksB = [
  { id: 'word-count', level: 'pass', detail: '' },
  { id: 'music-bed', level: 'warn', detail: '' },
  { id: 'opening-decel', level: 'pass', detail: '' },
];

t('summarize counts levels', () => {
  assert.deepStrictEqual(Q.summarize(checksA), { pass: 1, warn: 1, fail: 1 });
});

t('signature is stable + order-independent + change-sensitive', () => {
  const reordered = [checksA[2], checksA[0], checksA[1]];
  assert.strictEqual(Q.signature(checksA), Q.signature(reordered));
  assert.notStrictEqual(Q.signature(checksA), Q.signature(checksB));
});

t('updateTrends records a video keyed (idempotent re-run)', () => {
  let tr = Q.updateTrends({}, 'v1', { ts: '1', checks: checksA });
  assert.deepStrictEqual(tr.videos.v1.fails, ['opening-decel']);
  assert.deepStrictEqual(tr.videos.v1.warns, ['music-bed']);
  // re-run same video with a BETTER outcome → overwrites, does not double count
  tr = Q.updateTrends(tr, 'v1', { ts: '2', checks: checksB });
  assert.strictEqual(Object.keys(tr.videos).length, 1);
  assert.deepStrictEqual(tr.videos.v1.fails, []);
  assert.strictEqual(tr.byCheck['opening-decel'].fail, 0);
  assert.strictEqual(tr.byCheck['opening-decel'].pass, 1);
});

t('byCheck tallies across videos', () => {
  let tr = Q.updateTrends({}, 'v1', { ts: '1', checks: checksA });
  tr = Q.updateTrends(tr, 'v2', { ts: '1', checks: checksA });
  assert.strictEqual(tr.byCheck['music-bed'].warn, 2);
  assert.deepStrictEqual(tr.byCheck['music-bed'].warnVideos.sort(), ['v1', 'v2']);
  assert.strictEqual(tr.byCheck['opening-decel'].fail, 2);
});

t('recurringIssues flags checks across >= minVideos, worst first', () => {
  let tr = Q.updateTrends({}, 'v1', { ts: '1', checks: checksA });
  tr = Q.updateTrends(tr, 'v2', { ts: '1', checks: checksA });
  tr = Q.updateTrends(tr, 'v3', { ts: '1', checks: checksB });   // v3 only warns on music-bed
  const issues = Q.recurringIssues(tr, 2);
  // opening-decel: 2 fails (v1,v2); music-bed: 3 warns (v1,v2,v3). Fails weigh first.
  assert.strictEqual(issues[0].id, 'opening-decel');
  assert.strictEqual(issues[0].fail, 2);
  assert.strictEqual(issues[1].id, 'music-bed');
  assert.strictEqual(issues[1].warn, 3);
  // a check that only ever passes is not "recurring"
  assert.ok(!issues.find((i) => i.id === 'word-count'));
  // minVideos gate: nothing recurs across >=4 here
  assert.deepStrictEqual(Q.recurringIssues(tr, 4), []);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
