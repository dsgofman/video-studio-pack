// Phase-3 verification: render the new casualties-over-time LINE chart standalone (the 'infographic'
// composition). Approximate figures — a tech demo, not sourced.
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '_spike-out');
fs.mkdirSync(outDir, { recursive: true });

console.log('bundling infographic-index…');
const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'infographic-index.jsx') });

const spec = {
  type: 'area', title: 'The Cost of Stalingrad', xLabel: 'JUL 1942  →  FEB 1943',
  xFrom: 0, xTo: 7, xFromLabel: 'Jul', xToLabel: 'Feb', yMax: 1200000,
  series: [
    { label: 'Soviet', color: '#3f6f9f', valueLabel: '~1.1M', points: [[0, 30000], [1, 120000], [2, 260000], [3, 440000], [4, 640000], [5, 820000], [6, 980000], [7, 1100000]] },
    { label: 'Axis', color: '#c0392b', valueLabel: '~800k', points: [[0, 20000], [1, 70000], [2, 150000], [3, 260000], [4, 400000], [5, 560000], [6, 720000], [7, 800000]] },
  ],
  markers: [{ at: 4.5, label: 'URANUS' }],
  note: 'Approximate cumulative casualties — tech demo, not sourced',
};
const comp = await selectComposition({ serveUrl, id: 'infographic', inputProps: spec });
await renderStill({ composition: comp, serveUrl, output: path.join(outDir, 'casualty-curve.png'), inputProps: spec });
console.log('rendered → ' + path.join(outDir, 'casualty-curve.png'));
