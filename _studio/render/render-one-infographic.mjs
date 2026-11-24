// Render deterministic infographic STILLS from scene.infographic specs to images/NNN.png.
// (The assembler renders the same spec live; this still is the Studio preview + a fallback.)
// Usage: node render-one-infographic.mjs <channel> <id> <sceneN|all> [--force]
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const [, , channel, id, sceneN, forceFlag] = process.argv;
if (!channel || !id || !sceneN) { console.error('usage: node render-one-infographic.mjs <channel> <id> <sceneN|all> [--force]'); process.exit(1); }
const force = forceFlag === '--force' || sceneN !== 'all';

const videoDir = path.join(ROOT, channel, id);
const sp = path.join(videoDir, 'studio.json');
const imgDir = path.join(videoDir, '04-assets', 'images');
fs.mkdirSync(imgDir, { recursive: true });

const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
const has = (s) => s.infographic && s.infographic.type;
const targets = sceneN === 'all' ? scenes.filter(has) : scenes.filter((s) => String(s.n) === String(sceneN));
if (!targets.length) { console.error(sceneN === 'all' ? 'no scenes have scene.infographic' : 'scene ' + sceneN + ' not found'); process.exit(1); }
const bad = targets.find((s) => !has(s));
if (bad) { console.error('scene ' + bad.n + ' has no infographic spec'); process.exit(1); }

const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'infographic-index.jsx') });
let made = 0, skipped = 0;
for (const scene of targets) {
  const nn = String(scene.n).padStart(3, '0');
  const out = path.join(imgDir, nn + '.png');
  if (!force && fs.existsSync(out)) { skipped++; continue; }
  const props = scene.infographic;
  const comp = await selectComposition({ serveUrl, id: 'infographic', inputProps: props });
  await renderStill({ composition: comp, serveUrl, output: out, inputProps: props });
  const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const ls = ((((live.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(scene.n));
  if (ls) { ls.imagePath = '04-assets/images/' + nn + '.png'; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
  made++;
  console.log('infographic ' + scene.n + ' rendered + persisted');
}
console.log('done: ' + made + ' rendered, ' + skipped + ' skipped (existing)');
