// Assemble a rough-cut MP4 from a video's studio.json storyboard + rendered images + per-beat narration.
// Usage: node render.mjs <channel> <id> [fromBeat] [toBeat] [--vertical] [--name=clip-1] [--hook=TEXT]
//   --name=X    → a SHORT: writes 05-edit/shorts/X.mp4 with its own X.status.json (never clobbers the
//                 main render-status.json the Studio's assemble UI polls).
//   --vertical  → 1080x1920 (Shorts/Reels). Images center-crop via objectFit:cover; maps cover-scale.
//   --hook=TEXT → burns TEXT as a punch-in caption on the first beat of the range (the Short's hook).
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildManifest } from './manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');     // _studio/render -> Z:\Youtube
const flags = {}; const pos = [];
for (const a of process.argv.slice(2)) {
  if (a === '--vertical') flags.vertical = true;
  else if (a.startsWith('--name=')) flags.name = a.slice(7).replace(/[^a-zA-Z0-9._-]/g, '');
  else if (a.startsWith('--hook=')) flags.hook = a.slice(7);
  else if (a.startsWith('--ovmid=')) flags.ovmid = a.slice(8);
  else if (a.startsWith('--ovend=')) flags.ovend = a.slice(8);
  else pos.push(a);
}
const [channel, id, fromArg, toArg] = pos;
const from = fromArg ? parseInt(fromArg, 10) : null;
const to = toArg ? parseInt(toArg, 10) : null;
const sample = !!(from || to);
const isShort = !!flags.name;
const outName = isShort ? path.join('shorts', flags.name + '.mp4') : (sample ? 'rough-cut-sample.mp4' : 'rough-cut.mp4');

const videoDir = path.join(ROOT, channel, id);
const editDir = path.join(videoDir, '05-edit');
const statusFile = isShort ? path.join(editDir, 'shorts', flags.name + '.status.json') : path.join(editDir, 'render-status.json');
fs.mkdirSync(isShort ? path.join(editDir, 'shorts') : editDir, { recursive: true });

// Housekeeping: each bundle() leaves a remotion-webpack-bundle-* dir in the temp dir; they pile up
// (~38 seen). Sweep ones older than a day — never the fresh one a concurrent render may be using.
try {
  const tmp = os.tmpdir(), dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const d of fs.readdirSync(tmp)) {
    if (!d.startsWith('remotion-webpack-bundle-')) continue;
    const p = path.join(tmp, d);
    try { if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }
} catch (_) {}
const writeStatus = (o) => { try { fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: new Date().toISOString(), ...o })); } catch (_) {} };

// Find a Content-ID-safe music bed: video's own 04-assets/music first, else the channel's _assets/music
// (copied in so Remotion's publicDir can serve it). Prefer a file named bed.*.
// ⚠️ The compositor silently DROPS audio that isn't 44.1/48 kHz (verified: a 22050 Hz bed never
// reached the mix) — so probe the file and auto-resample to 44.1 kHz with the bundled ffmpeg.
// Cross-platform ffmpeg/ffprobe: prefer the binary bundled in whatever @remotion/compositor-* package
// is installed for THIS platform (win32-x64, darwin-arm64, darwin-x64, linux-*); else fall back to a
// system install on PATH (e.g. `brew install ffmpeg` on macOS). Returns a path or a bare command name.
function resolveBin(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  try {
    const base = path.join(__dirname, 'node_modules', '@remotion');
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('compositor-')) continue;
      const p = path.join(base, d, exe);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return name;   // let spawn resolve it from PATH (system ffmpeg)
}
function ensureMixable(dir, name) {
  try {
    const file = path.join(dir, name);
    const ffprobe = resolveBin('ffprobe'), ffmpeg = resolveBin('ffmpeg');
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    if (probe.error) return name;   // no ffprobe available -> skip resample (render still works)
    const rate = parseInt(String(probe.stdout || '').trim(), 10) || 0;
    if (rate === 44100 || rate === 48000) return name;
    const fixed = name.replace(/\.[^.]+$/, '') + '-44k.mp3';
    if (!fs.existsSync(path.join(dir, fixed))) {
      const r = spawnSync(ffmpeg, ['-i', file, '-ar', '44100', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '192k', path.join(dir, fixed), '-y'], { encoding: 'utf8' });
      if (r.error || r.status !== 0 || !fs.existsSync(path.join(dir, fixed))) return name;
    }
    console.log('music bed resampled to 44.1 kHz:', fixed, '(was', rate, 'Hz — the mixer drops those silently)');
    return fixed;
  } catch (_) { return name; }
}
function findMusic() {
  const localDir = path.join(videoDir, '04-assets', 'music');
  const channelDir = path.join(ROOT, channel, '_assets', 'music');
  const pick = (dir) => {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a|aac)$/i.test(f) && !/-44k\.mp3$/i.test(f));
    if (!files.length) return null;
    return files.find((f) => /^bed\./i.test(f)) || files[0];
  };
  let name = pick(localDir);
  if (name) return 'music/' + ensureMixable(localDir, name);
  name = pick(channelDir);
  if (name) {
    fs.mkdirSync(localDir, { recursive: true });
    fs.copyFileSync(path.join(channelDir, name), path.join(localDir, name));
    return 'music/' + ensureMixable(localDir, name);
  }
  return null;
}

// Stage the channel's brand art (logo + banner) into the video's 04-assets/brand so the end-card
// component can serve them via staticFile(). Returns { logo?, banner? } rel paths (or empty).
function brandAssets() {
  const out = {};
  const srcDir = path.join(ROOT, channel, '_assets', 'brand');
  const dstDir = path.join(videoDir, '04-assets', 'brand');
  for (const [key, file] of [['logo', 'logo.png'], ['banner', 'banner.png']]) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) continue;
    try { fs.mkdirSync(dstDir, { recursive: true }); fs.copyFileSync(src, path.join(dstDir, file)); out[key] = 'brand/' + file; } catch (_) {}
  }
  try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(srcDir, 'brand.json'), 'utf8'))); } catch (_) {}   // tagline/handle/promise
  return out;
}

// Pick a REAL, already-produced sibling video to feature as "watch next" — NEVER invent one. Only
// videos with a rough cut (or an upload) and a locked title qualify; most-recently-updated wins. Its
// thumbnail (if any) is staged into this video's public dir so the end-card frame shows the real art.
function pickWatchNext(limit = 2) {
  const chDir = path.join(ROOT, channel);
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return []; }
  const cands = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name === id) continue;
    const sp = path.join(chDir, d.name, 'studio.json');
    if (!fs.existsSync(sp)) continue;
    let doc; try { doc = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (_) { continue; }
    const hasCut = fs.existsSync(path.join(chDir, d.name, '05-edit', 'rough-cut.mp4'));
    const uploaded = !!(doc.youtube && doc.youtube.videoId);
    if (!hasCut && !uploaded) continue;                                   // only REAL, produced videos
    const pk = (doc.stages || {}).packaging || {};
    const t = ((pk.candidates || {}).titles || []).find((x) => x.id === (pk.decision || {}).primaryTitle);
    const title = (t && t.text) || doc.workingTitle;
    if (!title) continue;
    cands.push({ title, id: d.name, when: String(doc.updatedAt || ''), thumbAbs: path.join(chDir, d.name, '00-packaging', 'thumbnails', 'final-1.png') });
  }
  cands.sort((a, b) => b.when.localeCompare(a.when));                      // newest first
  const out = [];
  cands.slice(0, limit).forEach((c, i) => {
    const wn = { title: c.title, id: c.id };
    try {
      if (fs.existsSync(c.thumbAbs)) {
        const dst = path.join(videoDir, '04-assets', 'brand', 'watchnext-' + (i + 1) + '.png');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(c.thumbAbs, dst);
        wn.thumb = 'brand/watchnext-' + (i + 1) + '.png';
      }
    } catch (_) {}
    out.push(wn);
  });
  return out;
}

async function main() {
  if (!channel || !id) throw new Error('usage: node render.mjs <channel> <id>');
  const sp = path.join(videoDir, 'studio.json');
  const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const props = buildManifest(doc, {});   // ALWAYS build the full timeline
  if (!props.beats.length) throw new Error('Nothing to assemble — no beats have an image or narration yet.');
  // Caption look: per-channel style chosen in the Studio (font/color/size/case/treatment). Default = handwriting.
  try { props.captionStyle = JSON.parse(fs.readFileSync(path.join(ROOT, channel, '_assets', 'caption-style.json'), 'utf8')); } catch (_) {}
  if (doc.captionStyle) props.captionStyle = Object.assign({}, props.captionStyle, doc.captionStyle);   // optional per-video override
  const musicSrc = findMusic();
  if (musicSrc) props.music = { src: musicSrc };
  console.log('music bed:', musicSrc || '(none found)');
  // Full renders get the branded end card; samples stay just-the-beats. doc.endCard=false opts out.
  if (!sample && doc.endCard !== false) {
    const brand = brandAssets();   // copy logo/banner into publicDir so the end card can staticFile() them
    props.endCard = Object.assign({ seconds: 14, ...brand },
      typeof doc.endCard === 'object' ? doc.endCard : {});
    // Feature up to TWO REAL produced videos as watch-next (newest first) — the classic YouTube
    // end-screen with two video element zones. studio.json may set endCard.watchNext explicitly (an
    // array or a single object) or false to suppress.
    if (props.endCard.watchNext === undefined) {
      const wns = pickWatchNext(2);
      if (wns.length) props.endCard.watchNext = wns;
    } else if (props.endCard.watchNext === false) {
      delete props.endCard.watchNext;
    }
    if (props.endCard.watchNext && !Array.isArray(props.endCard.watchNext)) props.endCard.watchNext = [props.endCard.watchNext];
    console.log('watch-next:', (props.endCard.watchNext || []).map((w) => w.title).join(' + ') || '(none — no prior produced video)');
  }
  // A sample renders a FRAME WINDOW of the full composition — NOT a sliced sub-composition. Slicing the
  // beats array silently dropped the per-beat narration <Audio> (verified: sample renders came out mute);
  // rendering a frameRange of the intact timeline keeps every beat's audio. Window covers beats [from..to].
  let frameRange = null;
  if (sample) {
    let acc = 0, start = null, end = null; const inRange = [];
    for (const b of props.beats) {
      const inR = (!from || b.n >= from) && (!to || b.n <= to);
      if (inR && start === null) start = acc;
      acc += b.durationInFrames;
      if (inR) { end = acc; inRange.push(b); }
    }
    if (start === null || end === null || end <= start) throw new Error('No beats in range ' + (from || '') + '..' + (to || '') + '.');
    frameRange = [start, end - 1];
    console.log('sample frame range:', frameRange[0] + '..' + frameRange[1]);
    // Shorts overlays replace whatever captions those beats had: the hook IS the opener, the mid
    // overlay lands on the middle beat, the end overlay on the final beat (Shorts retention text).
    // raw:true → render exactly as written (a punchy hook stays punchy, acronyms intact). Positions use
    // the vertical bands: hook top, mid centered (big), the funnel CTA in the otherwise-empty bottom band.
    const cap = (t, pos, anim) => ({ text: t, pos: pos || 'top-center', anim: anim || 'punch', raw: true });
    if (flags.hook && inRange.length) inRange[0].caption = cap(flags.hook, 'top-center', 'punch');
    if (flags.ovmid && inRange.length >= 3) inRange[Math.floor(inRange.length / 2)].caption = cap(flags.ovmid, 'center', 'punch');
    if (flags.ovend && inRange.length >= 2) inRange[inRange.length - 1].caption = cap(flags.ovend, 'lower-third', 'fade');
  }
  if (flags.vertical) { props.width = 1080; props.height = 1920; console.log('vertical 1080x1920 (Shorts)'); }
  const mode = sample ? 'sample' : 'full';
  writeStatus({ state: 'bundling', mode, beats: props.beats.length, skipped: props.skipped });

  const publicDir = path.join(videoDir, '04-assets');
  const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'index.jsx'), publicDir });
  const composition = await selectComposition({ serveUrl, id: 'video', inputProps: props });

  const out = path.join(editDir, outName);
  writeStatus({ state: 'rendering', mode, progress: 0, beats: props.beats.length, durationInFrames: composition.durationInFrames });
  // Cap parallel Chrome tabs (each ~one frame-renderer) — unbounded concurrency is what tips a
  // tight machine into the "Page.bringToFront: Target closed" crash we hit on the sample render.
  const concurrency = Math.max(1, Math.min(4, (os.cpus() || []).length - 2));
  const renderOnce = () => renderMedia({
    composition, serveUrl, codec: 'h264', outputLocation: out, inputProps: props,
    concurrency, crf: 18,                                  // explicit: visually-clean h264 for the CapCut intermediate
    ...(frameRange ? { frameRange } : {}),                 // sample = a frame window of the full (audio-intact) timeline
    onProgress: ({ progress }) => writeStatus({ state: 'rendering', mode, progress: Math.round(progress * 100), beats: props.beats.length, durationInFrames: composition.durationInFrames }),
  });
  try {
    await renderOnce();
  } catch (e) {
    // A headless-Chrome tab crash ("Target closed" / ProtocolError) is transient — retry once before failing.
    if (/target closed|protocol error|frame .*timed out|navigation/i.test(String(e && e.message || ''))) {
      console.warn('render crashed (' + (e && e.message) + ') — retrying once at lower concurrency…');
      writeStatus({ state: 'rendering', mode, progress: 0, beats: props.beats.length, durationInFrames: composition.durationInFrames, note: 'retry' });
      await renderMedia({
        composition, serveUrl, codec: 'h264', outputLocation: out, inputProps: props,
        concurrency: Math.max(1, Math.floor(concurrency / 2)), crf: 18,
        ...(frameRange ? { frameRange } : {}),
        onProgress: ({ progress }) => writeStatus({ state: 'rendering', mode, progress: Math.round(progress * 100), beats: props.beats.length, durationInFrames: composition.durationInFrames, note: 'retry' }),
      });
    } else throw e;
  }
  writeStatus({ state: 'done', mode, output: '05-edit/' + outName, beats: props.beats.length, skipped: props.skipped, durationSec: Math.round(composition.durationInFrames / props.fps) });
  console.log('rough cut written:', out);
}

main().catch((e) => {
  writeStatus({ state: 'error', message: String(e && e.message || e) });
  console.error(e);
  process.exit(1);
});
