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

try { Object.assign(brand, JSON.parse(fs.readFileSync(path.join(srcDir, 'brand.json'), 'utf8'))); } catch (_) {}

// Mirror render.mjs: feature up to TWO real produced sibling videos (newest first) in the watch-next zone.
function pickWatchNext(limit = 2) {
  const chDir = path.join(ROOT, channel);
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return []; }
  const cands = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name === id) continue;
    const f = path.join(chDir, d.name, 'studio.json'); if (!fs.existsSync(f)) continue;
    let dd; try { dd = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    const hasCut = fs.existsSync(path.join(chDir, d.name, '05-edit', 'rough-cut.mp4'));
    if (!hasCut && !(dd.youtube && dd.youtube.videoId)) continue;
    const pk = (dd.stages || {}).packaging || {};
    const t = ((pk.candidates || {}).titles || []).find((x) => x.id === (pk.decision || {}).primaryTitle);
    const title = (t && t.text) || dd.workingTitle; if (!title) continue;
    cands.push({ title, id: d.name, when: String(dd.updatedAt || ''), thumbAbs: path.join(chDir, d.name, '00-packaging', 'thumbnails', 'final-1.png') });
  }
  cands.sort((a, b) => b.when.localeCompare(a.when));
  return cands.slice(0, limit).map((c, i) => {
    const wn = { title: c.title, id: c.id };
    if (fs.existsSync(c.thumbAbs)) { fs.mkdirSync(dstDir, { recursive: true }); fs.copyFileSync(c.thumbAbs, path.join(dstDir, 'watchnext-' + (i + 1) + '.png')); wn.thumb = 'brand/watchnext-' + (i + 1) + '.png'; }
    return wn;
  });
}

const fps = 30, secs = 14;
let captionStyle; try { captionStyle = JSON.parse(fs.readFileSync(path.join(ROOT, channel, '_assets', 'caption-style.json'), 'utf8')); } catch (_) {}
const props = {
  fps, width: 1920, height: 1080, captionStyle,
  beats: [{ n: 0, images: [], audio: null, map: null, durationInFrames: 2, motion: 'static', caption: null }],
  endCard: { seconds: secs, ...brand },
};
const wns = pickWatchNext(2);
if (wns.length) props.endCard.watchNext = wns;

const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'index.jsx'), publicDir });
const composition = await selectComposition({ serveUrl, id: 'video', inputProps: props });
const frame = 2 + Math.round(secs * fps) - 8;   // deep into the card: everything faded in
const out = path.join(videoDir, '05-edit', 'endcard-preview.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
await renderStill({ composition, serveUrl, output: out, inputProps: props, frame });
console.log('wrote', out, 'at frame', frame);
