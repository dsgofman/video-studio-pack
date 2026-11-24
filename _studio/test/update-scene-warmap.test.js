// Integration test: spins up the REAL server.js as a child process on a scratch port and posts to
// the real /api/update-scene HTTP endpoint — proves the wiring (not just lib/warmap.js in isolation).
// Uses a throwaway video folder under _test-channel/ that's created and deleted around the test.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const STUDIO_DIR = path.resolve(__dirname, '..');            // _studio
const ROOT = path.resolve(STUDIO_DIR, '..');                 // project root
const CHANNEL = '_test-channel';
const VIDEO_ID = '_test-tmp-warmap-updatescene';
const videoDir = path.join(ROOT, CHANNEL, VIDEO_ID);
const studioJsonPath = path.join(videoDir, 'studio.json');

let p = 0, f = 0;
async function t(n, fn) { try { await fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + (e && e.message || e)); } }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function writeFixture() {
  fs.mkdirSync(videoDir, { recursive: true });
  const doc = { updatedAt: new Date(0).toISOString(), stages: { scenes: { candidates: { scenes: [{ n: 1, imagePrompt: 'x', kind: 'map' }] } } } };
  fs.writeFileSync(studioJsonPath, JSON.stringify(doc, null, 2));
}

function readScene() {
  const doc = JSON.parse(fs.readFileSync(studioJsonPath, 'utf8'));
  return doc.stages.scenes.candidates.scenes.find((s) => s.n === 1);
}

async function waitForReady(base, timeoutMs) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try { await fetch(base + '/api/status'); return; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become ready in time: ' + (lastErr && lastErr.message));
}

const WAR_SPEC = {
  theme: 'war', zoom: 'operational', focus: [[44.5, 48.7]],
  sides: { axis: { label: 'German 6th Army', color: '#c0392b' }, sov: { label: 'Soviet 62nd Army', color: '#3f6f9f' } },
  territory: [{ polygon: [[44, 48], [45, 48], [45, 49]], side: 'axis' }],
  fronts: [{ line: [[44, 48], [44.5, 48.5], 'Stalingrad'], sideA: 'axis', sideB: 'sov', shade: true }],
  pockets: [{ polygon: [[44.2, 48.4], [44.6, 48.4], [44.6, 48.8]], side: 'axis' }],
  units: [{ place: 'Stalingrad', side: 'axis', type: 'infantry', name: '6th Army', strength: '90,000', facing: 90 }],
  arrows: [{ from: 'Kalach', to: 'Stalingrad', side: 'sov', style: 'pincer' }],
  counters: [{ label: 'German casualties', value: '850,000', side: 'axis', anchor: 'tr' }],
  strengthBars: [{ side: 'axis', value: 90000, max: 1000000 }],
  legend: true, title: 'Stalingrad', date: 'Nov 1942', phase: 'Operation Uranus',
};

async function main() {
  let child = null;
  try {
    fs.rmSync(videoDir, { recursive: true, force: true });
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server.js'], {
      cwd: STUDIO_DIR, env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    await waitForReady(base, 10000);

    await t('POST /api/update-scene round-trips every war-map §4 field intact', async () => {
      writeFixture();
      const res = await fetch(base + '/api/update-scene?channel=' + CHANNEL + '&id=' + VIDEO_ID, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: 1, patch: { map: WAR_SPEC } }),
      });
      const resBody = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(resBody.ok, true);
      const scene = readScene();
      const keys = ['theme', 'zoom', 'sides', 'territory', 'fronts', 'pockets', 'units', 'arrows', 'counters', 'strengthBars', 'legend', 'title', 'date', 'phase'];
      for (const k of keys) assert.notStrictEqual(scene.map[k], undefined, 'missing field after round-trip: ' + k);
      assert.deepStrictEqual(scene.map.sides, WAR_SPEC.sides);
      assert.deepStrictEqual(scene.map.territory, WAR_SPEC.territory);
      assert.deepStrictEqual(scene.map.fronts, WAR_SPEC.fronts);
      assert.deepStrictEqual(scene.map.pockets, WAR_SPEC.pockets);
      assert.deepStrictEqual(scene.map.units, WAR_SPEC.units);
      assert.deepStrictEqual(scene.map.arrows, WAR_SPEC.arrows);
      assert.deepStrictEqual(scene.map.counters, WAR_SPEC.counters);
      assert.deepStrictEqual(scene.map.strengthBars, WAR_SPEC.strengthBars);
      assert.strictEqual(scene.map.legend, true);
      assert.strictEqual(scene.map.title, 'Stalingrad');
      assert.strictEqual(scene.map.date, 'Nov 1942');
      assert.strictEqual(scene.map.phase, 'Operation Uranus');
    });

    await t('legacy atlas-only patch through the real endpoint is byte-for-byte unaffected', async () => {
      writeFixture();
      const atlasPatch = { focus: [[10, 20], [11, 21]], rotateLng: 5, routes: [[[10, 20], [11, 21]]], labelStyle: 'modern' };
      const res = await fetch(base + '/api/update-scene?channel=' + CHANNEL + '&id=' + VIDEO_ID, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: 1, patch: { map: atlasPatch } }),
      });
      assert.strictEqual(res.status, 200);
      const scene = readScene();
      assert.deepStrictEqual(scene.map, {
        rotateLng: 5, focus: [[10, 20], [11, 21]], routes: [[[10, 20], [11, 21]]], arcs: [], labels: [], labelStyle: 'modern',
      });
    });
  } finally {
    if (child) { try { child.kill(); } catch (_) {} }
    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmdirSync(path.join(ROOT, CHANNEL)); } catch (_) {}   // the scratch channel, once empty
  }
  console.log('\n' + p + ' passed, ' + f + ' failed');
  process.exit(f ? 1 : 0);
}

main();
