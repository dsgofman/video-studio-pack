// Phase-1 verification: render war BASE maps through the REAL Map.jsx (theme:'war') — no studio.json,
// no units yet. Confirms war mode + the bigger bundle (WarMap, theme, NE rivers/lakes, world-atlas 50m).
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '_spike-out');
fs.mkdirSync(outDir, { recursive: true });

console.log('bundling map-index…');
const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'map-index.jsx') });

const SPECS = {
  'warbase-stalingrad': {
    theme: 'war', zoom: 'operational', focus: [[42.6, 47.5], [46.8, 49.9]],
    title: 'Stalingrad', date: 'Nov 1942', phase: 'Operation Uranus', legend: true,
    sides: { axis: { label: 'German 6th Army', color: '#c0392b' }, sov: { label: 'Soviet 62nd Army', color: '#3f6f9f' } },
    labels: [{ text: 'Stalingrad', coord: 'stalingrad' }, { text: 'Don', coord: [42.0, 49.5], size: 26 }],
  },
  'warbase-eastfront': {
    theme: 'war', zoom: 'strategic', focus: [[8, 40], [46, 60]],
    title: 'Eastern Front', date: '1942', legend: true,
    sides: { axis: { label: 'Axis', color: '#c0392b' }, sov: { label: 'USSR', color: '#3f6f9f' } },
    labels: [{ text: 'Moscow', coord: 'moscow' }, { text: 'Stalingrad', coord: 'stalingrad' }, { text: 'Berlin', coord: 'berlin' }, { text: 'Kyiv', coord: 'kyiv' }],
  },
  // Phase-2 full military layer (approximate geography — a tech demo, NOT a sourced final map):
  // Operation Uranus, Nov 1942 — Soviet double-envelopment traps the German 6th Army at Stalingrad.
  'warmap-uranus': {
    theme: 'war', zoom: 'operational', focus: [[42.2, 47.6], [46.4, 50.0]],
    title: 'Stalingrad', date: 'Nov 1942', phase: 'Operation Uranus', legend: true,
    sides: { axis: { label: 'German 6th Army', color: '#c0392b' }, sov: { label: 'Red Army', color: '#3f6f9f' } },
    territory: [{ polygon: [[42.4, 49.85], [46.3, 49.85], [46.3, 47.75], [42.4, 47.75]], side: 'sov' }],
    pockets: [{ polygon: [[43.45, 48.4], [44.95, 48.35], [45.0, 48.95], [43.55, 49.0]], side: 'axis' }],
    fronts: [{ line: [[42.6, 49.7], [42.95, 48.9], [43.05, 48.1]], sideA: 'sov', sideB: 'axis' }],
    arrows: [
      { path: [[42.8, 49.65], [43.2, 49.1], [43.62, 48.72]], side: 'sov', style: 'attack' },
      { path: [[44.75, 47.95], [44.0, 48.32], [43.7, 48.66]], side: 'sov', style: 'attack' },
    ],
    units: [
      { coord: [44.18, 48.72], side: 'axis', type: 'infantry', name: '6th Army', strength: '250k' },
      { coord: [43.9, 48.08], side: 'axis', type: 'armor', name: '4th Panzer', strength: '90k' },
      { coord: [42.85, 49.45], side: 'sov', type: 'armor', name: '5th Tank', strength: '90k' },
      { coord: [44.85, 47.88], side: 'sov', type: 'infantry', name: '51st Army', strength: '60k' },
    ],
    counters: [{ label: 'Germans encircled', value: '~265,000', side: 'axis' }],
    strengthBars: [
      { side: 'sov', value: 1100000, max: 1100000, valueLabel: '1.1M' },
      { side: 'axis', value: 265000, max: 1100000, valueLabel: '265k' },
    ],
    labels: [{ text: 'Stalingrad', coord: 'stalingrad', size: 28 }, { text: 'Kalach', coord: [43.53, 48.69], size: 24 }],
  },
};

for (const [name, props] of Object.entries(SPECS)) {
  const comp = await selectComposition({ serveUrl, id: 'map', inputProps: props });
  const out = path.join(outDir, name + '.png');
  await renderStill({ composition: comp, serveUrl, output: out, inputProps: props });
  console.log('rendered → ' + out);
}
console.log('done.');
