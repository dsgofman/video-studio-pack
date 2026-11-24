const assert = require('assert');
const { beatTimeline, srtTime, splitCue, buildSrt, buildVtt } = require('../lib/subtitles.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('srtTime formats h:m:s,ms', () => {
  assert.strictEqual(srtTime(0), '00:00:00,000');
  assert.strictEqual(srtTime(6.22), '00:00:06,220');
  assert.strictEqual(srtTime(3661.5), '01:01:01,500');
});

t('srtTime never emits ,1000 (rounds up second instead clamps ms to 999)', () => {
  // 0.9999 rounds ms to 1000 -> clamp to 999 so the timestamp stays valid
  assert.strictEqual(srtTime(0.9999), '00:00:00,999');
});

t('splitCue keeps a short sentence whole', () => {
  assert.deepStrictEqual(splitCue('Hello there.'), ['Hello there.']);
});

t('splitCue strips tags and collapses whitespace', () => {
  assert.deepStrictEqual(splitCue('A <b>bold</b>   move.'), ['A bold move.']);
});

t('splitCue splits one over-long sentence into balanced word groups', () => {
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen';
  const cues = splitCue(long);
  assert.ok(cues.length >= 2, 'expected a split, got ' + cues.length);
  assert.strictEqual(cues.join(' '), long, 'no words lost or reordered');
  cues.forEach((c) => assert.ok(c.trim().length > 0));
});

t('beatTimeline skips asset-less + excluded beats and uses real audioSeconds', () => {
  const scenes = [
    { n: 1, audioPath: 'a/001.mp3', audioSeconds: 5, narration: 'first' },
    { n: 2, audioPath: 'a/002.mp3', audioSeconds: 3, narration: 'second', exclude: true },
    { n: 3, narration: 'no asset, skipped' },
    { n: 4, imagePath: 'i/004.png', audioSeconds: 2.4, narration: 'third' },
  ];
  const tl = beatTimeline(scenes);
  assert.deepStrictEqual(tl.map((b) => b.n), [1, 4]);
  assert.strictEqual(tl[0].start, 0);
  assert.strictEqual(tl[0].end, 5);
  assert.strictEqual(tl[1].start, 5);     // contiguous, no gap from the skipped beats
  assert.strictEqual(+tl[1].end.toFixed(2), 7.4);
});

t('buildSrt produces sequential, monotonic, in-bounds cues', () => {
  const scenes = [
    { n: 1, audioPath: 'a/001.mp3', audioSeconds: 6, narration: 'A short line. And a second short line here.' },
    { n: 2, audioPath: 'a/002.mp3', audioSeconds: 4, narration: 'Solo line two.' },
  ];
  const { srt, cues, seconds } = buildSrt(scenes);
  assert.strictEqual(seconds, 10);
  assert.ok(cues >= 3, 'expected the first beat to split into >=2 cues, total >=3');
  // indices are 1..cues in order
  const blocks = srt.trim().split('\n\n');
  assert.strictEqual(blocks.length, cues);
  blocks.forEach((b, i) => assert.strictEqual(b.split('\n')[0], String(i + 1)));
  // last cue end must not exceed total runtime
  const lastEnd = srt.trim().split('\n\n').pop().split('\n')[1].split(' --> ')[1];
  assert.ok(lastEnd <= '00:00:10,001', 'last cue ends within runtime, got ' + lastEnd);
});

t('buildSrt returns 0 cues when there is no narration', () => {
  const { cues } = buildSrt([{ n: 1, audioPath: 'a/001.mp3', audioSeconds: 3, narration: '' }]);
  assert.strictEqual(cues, 0);
});

t('buildVtt mirrors buildSrt with a WEBVTT header and dot timestamps', () => {
  const scenes = [{ n: 1, audioPath: 'a/001.mp3', audioSeconds: 5, narration: 'Hello world.' }];
  const { vtt, cues } = buildVtt(scenes);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(/00:00:00\.000 --> /.test(vtt), 'uses dot, not comma');
  assert.ok(!/,\d\d\d --> /.test(vtt), 'no comma timestamps remain');
  assert.strictEqual(cues, 1);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
