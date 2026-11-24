// DEV-ONLY: render the caption-preview composition to an MP4 so the caption motion can be reviewed.
// Free + deterministic (no API, no assets). Uses a channel's caption-style.json (arg 1, default MyChannel) so the look matches.
// Usage: node render-caption-preview.mjs [outPath.mp4]
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveCues } from './cues.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const out = process.argv[2] || path.join(__dirname, '_capprev.mp4');

const FPS = 30, SECS = 2.8, BF = Math.round(SECS * FPS);
// synthetic word timings so anchors resolve ~0.5s in and the cue holds within the beat
const wt = (pairs) => pairs.map(([w, t]) => ({ w, t }));
const beat = (tag, cues, timings) => ({ tag, durationInFrames: BF, cues: resolveCues(cues, wt(timings), SECS, FPS, BF) });

const beats = [
  beat('label — drops in', [{ kind: 'label', pos: 'lower-third', group: '', anchor: 'neanderthals', emph: 'Neanderthals', text: 'Neanderthals' }],
    [['neanderthals', 0.5]]),
  beat('stat — pop + count-up', [{ kind: 'stat', pos: 'top-center', group: '', anchor: '150', emph: '150', text: '150 years of debate' }],
    [['150', 0.5], ['years', 0.9], ['of', 1.2], ['debate', 1.5]]),
  beat('reveal — rise + underline + write-on', [{ kind: 'reveal', pos: 'center', group: '', anchor: 'leftover', emph: 'leftover', text: "A leftover, not a tool" }],
    [['a', 0.4], ['leftover', 0.7], ['not', 1.1], ['a', 1.4], ['tool', 1.7]]),
  beat('build — items slide up + stack', [
    { kind: 'build', pos: 'center', group: 'sp', anchor: 'neanderthals', emph: 'Neanderthals', text: 'Neanderthals' },
    { kind: 'build', pos: 'center', group: 'sp', anchor: 'denisovans', emph: 'Denisovans', text: 'Denisovans' },
    { kind: 'build', pos: 'center', group: 'sp', anchor: 'hobbit', emph: 'Hobbit', text: 'the Hobbit' },
  ], [['neanderthals', 0.4], ['denisovans', 0.9], ['hobbit', 1.4]]),
  beat('marker — assertive punch', [{ kind: 'marker', pos: 'top-center', group: '', anchor: 'strange', emph: 'strange', text: "But here it gets strange" }],
    [['but', 0.4], ['here', 0.7], ['it', 0.95], ['gets', 1.2], ['strange', 1.5]]),
];
// Shorts-hook (legacy raw Caption, punch) — verifies the new word-by-word write-on on that path.
beats.push({ tag: 'Shorts hook — punch write-on', durationInFrames: BF, cues: [], caption: { text: 'This bone rewrites history', pos: 'center', anim: 'punch', raw: true } });

let captionStyle = { font: 'gloria', color: '#fffdf7', accent: '#f0883c', size: 70, case: 'sentence', treatment: 'shadow', tilt: true };
try { captionStyle = JSON.parse(fs.readFileSync(path.join(ROOT, process.argv[2] || 'MyChannel', '_assets', 'caption-style.json'), 'utf8')); } catch (_) {}

const props = { beats, captionStyle };
console.log('beats:', beats.map((b) => b.tag).join(' | '));
const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'capprev-index.jsx') });
const composition = await selectComposition({ serveUrl, id: 'capprev', inputProps: props });
await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: out, inputProps: props, concurrency: 2, crf: 18 });
console.log('caption preview written:', out, '(' + composition.durationInFrames + ' frames)');
