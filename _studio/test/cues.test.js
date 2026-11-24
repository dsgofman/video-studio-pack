// Tests for render/cues.mjs — the caption-timing engine (frame-windowed render cues).
// ESM module, so we load it via dynamic import once and run the suite after it resolves.
const assert = require('assert');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

const FPS = 30;
// helper: a 10s beat (300 frames) with evenly spaced words
const WT = [
  { w: 'the', t: 0.5 }, { w: 'chin', t: 1.0 }, { w: 'is', t: 1.5 }, { w: 'a', t: 2.0 },
  { w: 'mystery', t: 2.5 }, { w: '150', t: 4.0 }, { w: 'years', t: 4.5 }, { w: 'of', t: 5.0 },
  { w: 'debate', t: 5.5 }, { w: 'bone', t: 9.5 },
];

import('../render/cues.mjs').then(({ resolveCues }) => {

  t('empty/null cues resolve to []', () => {
    assert.deepStrictEqual(resolveCues([], WT, 10, FPS, 300), []);
    assert.deepStrictEqual(resolveCues(null, WT, 10, FPS, 300), []);
  });

  t('anchored cue starts at its word start time', () => {
    const out = resolveCues([{ kind: 'label', pos: 'center', text: 'THE CHIN', anchor: 'chin' }], WT, 10, FPS, 300);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].startFrame, Math.round(1.0 * FPS));           // word "chin" @ 1.0s
  });

  t('anchor matching normalizes punctuation/case', () => {
    const out = resolveCues([{ kind: 'stat', pos: 'center', text: '150 YEARS', anchor: '"150,"' }], WT, 10, FPS, 300);
    assert.strictEqual(out[0].startFrame, Math.round(4.0 * FPS));           // matches w:'150' @ 4.0s
  });

  t('kind floor applies for short text (label = 1.8s)', () => {
    const out = resolveCues([{ kind: 'label', pos: 'center', text: 'CHIN', anchor: 'chin' }], WT, 10, FPS, 300);
    assert.strictEqual(out[0].endFrame - out[0].startFrame, Math.round(1.8 * FPS));
  });

  t('reading-time stretches the hold for wordy cues', () => {
    // 8 words => 8*0.34 + 0.5 = 3.22s > reveal floor 1.7s
    const out = resolveCues([{ kind: 'reveal', pos: 'center', text: 'one two three four five six seven eight', anchor: 'chin' }], WT, 10, FPS, 300);
    const sec = (out[0].endFrame - out[0].startFrame) / FPS;
    assert.ok(Math.abs(sec - 3.22) < 0.05, 'expected ~3.22s, got ' + sec);
  });

  t('per-cue hold override wins over the reading-time default', () => {
    const out = resolveCues([{ kind: 'stat', pos: 'center', text: '150', anchor: '150', hold: 3.3 }], WT, 10, FPS, 300);
    const sec = (out[0].endFrame - out[0].startFrame) / FPS;
    assert.ok(Math.abs(sec - 3.3) < 0.05, 'expected 3.3s, got ' + sec);
  });

  t('per-cue hold below MIN_HOLD clamps to 0.9s', () => {
    const out = resolveCues([{ kind: 'stat', pos: 'center', text: '150', anchor: '150', hold: 0.2 }], WT, 10, FPS, 300);
    const sec = (out[0].endFrame - out[0].startFrame) / FPS;
    assert.ok(Math.abs(sec - 0.9) < 0.05, 'expected 0.9s, got ' + sec);
  });

  t('non-numeric / non-positive hold is ignored (falls back to default)', () => {
    for (const bad of ['3.3', 0, -1, null]) {
      const out = resolveCues([{ kind: 'label', pos: 'center', text: 'CHIN', anchor: 'chin', hold: bad }], WT, 10, FPS, 300);
      assert.strictEqual(out[0].endFrame - out[0].startFrame, Math.round(1.8 * FPS), 'hold=' + JSON.stringify(bad));
    }
  });

  t('late-anchored cue SLIDES earlier to keep its full hold (never clipped to a flash)', () => {
    // "bone" @ 9.5s in a 10s beat, label hold 1.8s => window slides to [8.2, 10.0]
    const out = resolveCues([{ kind: 'label', pos: 'center', text: 'BONE', anchor: 'bone' }], WT, 10, FPS, 300);
    assert.strictEqual(out[0].endFrame, 300);
    assert.strictEqual(out[0].startFrame, Math.round(8.2 * FPS));
  });

  t('beat shorter than the hold clamps to the whole beat', () => {
    const out = resolveCues([{ kind: 'marker', pos: 'center', text: 'NOW', anchor: 'the' }], [{ w: 'the', t: 0.2 }], 1, FPS, 30);
    assert.strictEqual(out[0].startFrame, 0);
    assert.strictEqual(out[0].endFrame, 30);
  });

  t('unanchored cue falls back to a proportional position inside the beat', () => {
    const out = resolveCues([{ kind: 'label', pos: 'center', text: 'X' }], [], 10, FPS, 300);
    // single missing cue: lo + span*0.15 = 1.2 + 7*0.15 = 2.25s
    assert.strictEqual(out[0].startFrame, Math.round(2.25 * FPS));
  });

  t('out-of-order anchors are forced non-decreasing (+0.25s)', () => {
    const cues = [
      { kind: 'label', pos: 'center', text: 'LATE', anchor: 'debate' },   // 5.5s
      { kind: 'label', pos: 'center', text: 'EARLY', anchor: 'mystery' }, // 2.5s but must not precede 5.5
    ];
    const out = resolveCues(cues, WT, 10, FPS, 300);
    const late = out.find((c) => c.text === 'LATE'), early = out.find((c) => c.text === 'EARLY');
    assert.strictEqual(early.startFrame, Math.round((5.5 + 0.25) * FPS));
    assert.ok(early.startFrame >= late.startFrame);
  });

  t('build group: members share one clear time; brightUntil hands off to the next item', () => {
    const cues = [
      { kind: 'build', pos: 'center', group: 'g', text: 'A', anchor: 'chin' },    // 1.0s
      { kind: 'build', pos: 'center', group: 'g', text: 'B', anchor: 'mystery' }, // 2.5s
      { kind: 'build', pos: 'center', group: 'g', text: 'C', anchor: 'debate' },  // 5.5s
    ];
    const out = resolveCues(cues, WT, 10, FPS, 300);
    assert.strictEqual(out.length, 3);
    const clear = Math.round((5.5 + 1.4) * FPS);                        // last start + HOLD.build
    for (const c of out) assert.strictEqual(c.endFrame, clear);
    assert.strictEqual(out[0].brightUntil, Math.round(2.5 * FPS));      // A dims when B lands
    assert.strictEqual(out[1].brightUntil, Math.round(5.5 * FPS));      // B dims when C lands
    assert.strictEqual(out[2].brightUntil, clear);                      // C stays bright to the end
    assert.deepStrictEqual(out.map((c) => c.stackIndex), [0, 1, 2]);
    assert.ok(out.every((c) => c.groupSize === 3));
  });

  t('build group overflowing the beat slides the WHOLE group earlier', () => {
    const cues = [
      { kind: 'build', pos: 'center', group: 'g', text: 'A', anchor: 'debate' }, // 5.5s
      { kind: 'build', pos: 'center', group: 'g', text: 'B', anchor: 'bone' },   // 9.5s + 1.4 hold => overflows
    ];
    const out = resolveCues(cues, WT, 10, FPS, 300);
    const shift = (9.5 + 1.4) - 10;                                     // 0.9s slide
    assert.strictEqual(out[0].startFrame, Math.round((5.5 - shift) * FPS));
    assert.strictEqual(out[1].startFrame, Math.round((9.5 - shift) * FPS));
    assert.ok(out.every((c) => c.endFrame === 300));
  });

  t('a big hold slide never crosses the PREVIOUS cue\'s start (display order preserved)', () => {
    // A @2.0s (default hold); B @2.5s with hold:4.5 in a 6s beat would slide to 1.5s — BEFORE A.
    // The floor keeps B at A's start (2.0s) and trims the hold instead: order beats linger.
    const cues = [
      { kind: 'label', pos: 'center', text: 'FIRST', anchor: 'a' },
      { kind: 'label', pos: 'center', text: 'SECOND', anchor: 'b', hold: 4.5 },
    ];
    const out = resolveCues(cues, [{ w: 'a', t: 2.0 }, { w: 'b', t: 2.5 }], 6, FPS, 180);
    const first = out.find((c) => c.text === 'FIRST'), second = out.find((c) => c.text === 'SECOND');
    assert.ok(second.startFrame >= first.startFrame, 'SECOND must not appear before FIRST');
    assert.strictEqual(second.startFrame, Math.round(2.0 * FPS));   // floored at FIRST's start
    assert.strictEqual(second.endFrame, 180);                       // still runs to the beat end
  });

  t('build group honors a member\'s per-cue hold for the stack linger', () => {
    const cues = [
      { kind: 'build', pos: 'center', group: 'g', text: 'A', anchor: 'chin' },              // 1.0s
      { kind: 'build', pos: 'center', group: 'g', text: 'B', anchor: 'mystery', hold: 3.0 }, // 2.5s
    ];
    const out = resolveCues(cues, WT, 10, FPS, 300);
    const clear = Math.round((2.5 + 3.0) * FPS);   // last start + authored hold (not HOLD.build 1.4)
    assert.ok(out.every((c) => c.endFrame === clear), 'stack lingers for the authored 3.0s');
  });

  t('a group slide is also floored at the previous cue\'s start', () => {
    const cues = [
      { kind: 'label', pos: 'center', text: 'EARLY', anchor: 'debate' },                    // 5.5s
      { kind: 'build', pos: 'center', group: 'g', text: 'A', anchor: 'of', hold: 6.0 },     // 5.0s → bumped to 5.75
      { kind: 'build', pos: 'center', group: 'g', text: 'B', anchor: 'bone' },              // 9.5s + 6.0 hold overflows
    ];
    const out = resolveCues(cues, WT, 10, FPS, 300);
    const early = out.find((c) => c.text === 'EARLY');
    const groupFirst = out.find((c) => c.text === 'A');
    assert.ok(groupFirst.startFrame >= early.startFrame, 'group may not slide across the earlier cue');
  });

  t('output is sorted by startFrame and windows never exceed the beat', () => {
    const cues = [
      { kind: 'label', pos: 'center', text: 'L2', anchor: 'debate' },
      { kind: 'stat', pos: 'center', text: 'L1', anchor: 'chin' },
    ];
    const out = resolveCues(cues, WT, 10, FPS, 300);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].startFrame >= out[i - 1].startFrame);
    for (const c of out) { assert.ok(c.startFrame >= 0); assert.ok(c.endFrame <= 300); assert.ok(c.brightUntil <= 300); }
  });

  console.log('\n' + p + ' passed, ' + f + ' failed');
  process.exit(f ? 1 : 0);
}).catch((e) => { console.error('IMPORT FAILED: ' + e.message); process.exit(1); });
