// Render a single still of the branded end card for quick design review (no full video needed).
// Usage: node preview-endcard.mjs <channel> <id>
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const [, , channel, id] = process.argv;
if (!channel || !id) throw new Error('usage: node preview-endcard.mjs <channel> <id>');

const videoDir = path.join(ROOT, channel, id);
const publicDir = path.join(videoDir, '04-assets');

// stage brand art into publicDir (same as render.mjs brandAssets)
const srcDir = path.join(ROOT, channel, '_assets', 'brand');
const dstDir = path.join(publicDir, 'brand');
const brand = {};
for (const [key, file] of [['logo', 'logo.png'], ['banner', 'banner.png']]) {
  const src = path.join(srcDir, file);
  if (fs.existsSync(src)) { fs.mkdirSync(dstDir, { recursive: true }); fs.copyFileSync(src, path.join(dstDir, file)); brand[key] = 'brand/' + file; }
}

// Mirror render.mjs: feature a REAL produced sibling video as watch-next so the preview shows that zone.
function pickWatchNext() {
  const chDir = path.join(ROOT, channel);
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return null; }
  let best = null;
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name === id) continue;
    const f = path.join(chDir, d.name, 'studio.json'); if (!fs.existsSync(f)) continue;
    let dd; try { dd = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    const hasCut = fs.existsSync(path.join(chDir, d.name, '05-edit', 'rough-cut.mp4'));
    if (!hasCut && !(dd.youtube && dd.youtube.videoId)) continue;
    const pk = (dd.stages || {}).packaging || {};
    const t = ((pk.candidates || {}).titles || []).find((x) => x.id === (pk.decision || {}).primaryTitle);
    const title = (t && t.text) || dd.workingTitle; if (!title) continue;
    const when = String(dd.updatedAt || '');
    if (!best || when > best.when) best = { title, id: d.name, when, thumbAbs: path.join(chDir, d.name, '00-packaging', 'thumbnails', 'final-1.png') };
  }
  return best;
}

const fps = 30, secs = 14;
const props = {
  fps, width: 1920, height: 1080,
  beats: [{ n: 0, images: [], audio: null, map: null, durationInFrames: 2, motion: 'static', caption: null }],
  endCard: { seconds: secs, tagline: 'The human story, before history began.', ...brand },
};
const wn = pickWatchNext();
if (wn) {
  props.endCard.watchNext = { title: wn.title, id: wn.id };
  if (fs.existsSync(wn.thumbAbs)) { fs.mkdirSync(dstDir, { recursive: true }); fs.copyFileSync(wn.thumbAbs, path.join(dstDir, 'watchnext.png')); props.endCard.watchNextThumb = 'brand/watchnext.png'; }
}

const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'index.jsx'), publicDir });
const composition = await selectComposition({ serveUrl, id: 'video', inputProps: props });
const frame = 2 + Math.round(secs * fps) - 8;   // deep into the card: everything faded in
const out = path.join(videoDir, '05-edit', 'endcard-preview.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
await renderStill({ composition, serveUrl, output: out, inputProps: props, frame });
console.log('wrote', out, 'at frame', frame);
