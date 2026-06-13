// Render accurate maps for the key geographic beats and persist them into studio.json (kind='map').
// Usage: node render-maps.mjs <channel> <id>
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const [, , channel, id] = process.argv;
const videoDir = path.join(ROOT, channel, id);
const sp = path.join(videoDir, 'studio.json');
const imgDir = path.join(videoDir, '04-assets', 'images');
fs.mkdirSync(imgDir, { recursive: true });

const SPECS = {
  17: { // Out of Africa — the great dispersal eastward (coastal sweep to SE Asia)
    rotateLng: -72,
    focus: [[2, 44], [22, -34], [115, -12], [108, 42]],
    routes: [[[44, 11], [55, 17], [64, 22], [73, 16], [80, 8], [95, 14], [103, 5]]],
    labels: [{ text: 'AFRICA', coord: [20, 4], size: 50 }, { text: 'ASIA', coord: [84, 48], size: 50 }],
  },
  27: { // The crossing into Australia (Wallacea / Sunda -> Sahul)
    rotateLng: -125,
    focus: [[96, 20], [100, -42], [156, -42], [150, 14]],
    routes: [[[119, -8], [123, -9.5], [127, -11], [131, -13]]],
    labels: [{ text: 'ASIA', coord: [104, 16], size: 44 }, { text: 'AUSTRALIA', coord: [134, -25], size: 50 }],
  },
  41: { // Siberia -> Alaska across the Bering land bridge
    rotateLng: -180,
    focus: [[160, 70], [-150, 70], [150, 52], [-135, 54]],
    routes: [[[172, 65], [180, 66], [-178, 65], [-166, 64.5], [-158, 64]]],
    labels: [{ text: 'SIBERIA', coord: [150, 64], size: 50 }, { text: 'ALASKA', coord: [-150, 64], size: 50 }],
  },
  57: { // Down the Pacific coast of the Americas by boat (route hugs the west coast)
    rotateLng: 102,
    focus: [[-162, 66], [-58, 60], [-68, -53], [-150, -47]],
    routes: [[[-150, 61], [-128, 52], [-124, 44], [-121, 35], [-112, 25], [-103, 18], [-91, 14], [-83, 9], [-80, 1], [-78, -12], [-73, -28], [-73, -43]]],
    labels: [{ text: 'N. AMERICA', coord: [-104, 47], size: 42 }, { text: 'S. AMERICA', coord: [-60, -16], size: 42 }],
  },
};

const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'map-index.jsx') });
for (const [n, spec] of Object.entries(SPECS)) {
  const props = { ...spec, labelStyle: 'serif' };
  const comp = await selectComposition({ serveUrl, id: 'map', inputProps: props });
  const nn = String(n).padStart(3, '0');
  await renderStill({ composition: comp, serveUrl, output: path.join(imgDir, nn + '.png'), inputProps: props });
  const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const ls = live.stages.scenes.candidates.scenes.find((x) => String(x.n) === String(n));
  if (ls) { ls.imagePath = '04-assets/images/' + nn + '.png'; ls.kind = 'map'; ls.map = spec; fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
  console.log('map', n, 'rendered + persisted');
}
console.log('done');
