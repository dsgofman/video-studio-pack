import assert from 'assert';
import { resolveCues } from './cues.mjs';
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }
const FPS = 30;

t('anchored cue starts on its word time', () => {
  const cues = [{ kind: 'stat', pos: 'top-center', group: '', anchor: '44%', emph: '44%', text: '44% less' }];
  const wt = [{ w: 'men', t: 0.5 }, { w: '44%', t: 2.0 }];
  const r = resolveCues(cues, wt, 6, FPS, 180);
  assert.strictEqual(r[0].startFrame, 60);            // 2.0s * 30
  assert.ok(r[0].endFrame > r[0].startFrame && r[0].endFrame <= 180);
});
t('build group: members in order, all clear together, stackIndex set', () => {
  const cues = [
    { kind: 'build', pos: 'center', group: 'g', anchor: 'a', emph: 'a', text: 'A' },
    { kind: 'build', pos: 'center', group: 'g', anchor: 'b', emph: 'b', text: 'B' },
    { kind: 'build', pos: 'center', group: 'g', anchor: 'c', emph: 'c', text: 'C' },
  ];
  const wt = [{ w: 'a', t: 1 }, { w: 'b', t: 2 }, { w: 'c', t: 3 }];
  const r = resolveCues(cues, wt, 6, FPS, 180);
  assert.deepStrictEqual(r.map((c) => c.startFrame), [30, 60, 90]);
  assert.strictEqual(r[0].endFrame, r[1].endFrame);   // share a clear time
  assert.strictEqual(r[1].endFrame, r[2].endFrame);
  assert.deepStrictEqual(r.map((c) => c.stackIndex), [0, 1, 2]);
  assert.strictEqual(r[0].brightUntil, 60);           // dims when B arrives
});
t('unanchored cues fall back to proportional spread', () => {
  const cues = [
    { kind: 'build', pos: 'center', group: 'g', anchor: '', emph: '', text: 'A' },
    { kind: 'build', pos: 'center', group: 'g', anchor: '', emph: '', text: 'B' },
  ];
  const r = resolveCues(cues, [], 10, FPS, 300);
  assert.ok(r[0].startFrame < r[1].startFrame, 'spread in order');
  assert.ok(r[0].startFrame >= 0 && r[1].endFrame <= 300, 'within beat');
});
t('endFrame clamps to beat end', () => {
  const cues = [{ kind: 'label', pos: 'lower-third', group: '', anchor: 'x', emph: '', text: 'X' }];
  const r = resolveCues(cues, [{ w: 'x', t: 5.5 }], 6, FPS, 180);
  assert.ok(r[0].endFrame <= 180);
});
t('late-anchored cue slides earlier to keep its hold (no flash)', () => {
  // reveal anchored at 5.5s in a 6s beat would only have 0.5s left if clamped; instead it slides earlier.
  const cues = [{ kind: 'reveal', pos: 'center', group: '', anchor: 'x', emph: '', text: 'So is it true?' }];
  const r = resolveCues(cues, [{ w: 'x', t: 5.5 }], 6, FPS, 180);
  const holdFrames = r[0].endFrame - r[0].startFrame;
  assert.ok(r[0].endFrame <= 180, 'ends within beat');
  assert.ok(holdFrames >= 30, 'holds at least ~1s instead of flashing, got ' + (holdFrames / FPS).toFixed(2) + 's');
  assert.ok(r[0].startFrame < Math.round(5.5 * FPS), 'started earlier than the raw anchor to make room');
});
t('reading-time stretches hold for a wordy reveal', () => {
  const cues = [{ kind: 'reveal', pos: 'center', group: '', anchor: 'a', emph: '', text: 'Only the sick one had it' }];
  const r = resolveCues(cues, [{ w: 'a', t: 1.0 }], 10, FPS, 300);   // plenty of room
  const holdSec = (r[0].endFrame - r[0].startFrame) / FPS;
  assert.ok(holdSec > 1.7, '6-word reveal holds longer than the 1.7s floor, got ' + holdSec.toFixed(2) + 's');
});
t('no cues → []', () => { assert.deepStrictEqual(resolveCues([], [], 6, FPS, 180), []); });

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
