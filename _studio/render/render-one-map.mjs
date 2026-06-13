// Render accurate-map stills from the map specs stored in studio.json (scene.map).
// (The assembler animates the same spec live; the still is the Studio preview + fallback.)
// Usage: node render-one-map.mjs <channel> <id> <sceneN|all> [--force]
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const [, , channel, id, sceneN, forceFlag] = process.argv;
if (!channel || !id || !sceneN) { console.error('usage: node render-one-map.mjs <channel> <id> <sceneN|all> [--force]'); process.exit(1); }
const force = forceFlag === '--force' || sceneN !== 'all';   // naming one scene always re-renders it

const videoDir = path.join(ROOT, channel, id);
const sp = path.join(videoDir, 'studio.json');
const imgDir = path.join(videoDir, '04-assets', 'images');
fs.mkdirSync(imgDir, { recursive: true });

const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
const hasSpec = (s) => s.map && Array.isArray(s.map.focus) && s.map.focus.length;
const targets = sceneN === 'all'
  ? scenes.filter((s) => hasSpec(s))
  : scenes.filter((s) => String(s.n) === String(sceneN));
if (!targets.length) { console.error(sceneN === 'all' ? 'no scenes have a map spec (scene.map.focus)' : 'scene ' + sceneN + ' not found'); process.exit(1); }
const bad = targets.find((s) => !hasSpec(s));
if (bad) { console.error('scene ' + bad.n + ' has no map spec (scene.map.focus required)'); process.exit(1); }

const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'map-index.jsx') });
let made = 0, skipped = 0;
for (const scene of targets) {
  const nn = String(scene.n).padStart(3, '0');
  const out = path.join(imgDir, nn + '.png');
  if (!force && fs.existsSync(out)) { skipped++; continue; }
  const props = Object.assign({ labelStyle: 'serif' }, scene.map);
  const comp = await selectComposition({ serveUrl, id: 'map', inputProps: props });
  await renderStill({ composition: comp, serveUrl, output: out, inputProps: props });
  // persist: re-read live (the server may have written while we rendered)
  const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const ls = ((((live.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(scene.n));
  if (ls) {
    ls.imagePath = '04-assets/images/' + nn + '.png';
    ls.kind = 'map';
    live.updatedAt = new Date().toISOString();
    fs.writeFileSync(sp, JSON.stringify(live, null, 2));
  }
  made++;
  console.log('map ' + scene.n + ' rendered + persisted');
}
console.log('done: ' + made + ' rendered, ' + skipped + ' skipped (existing)');
