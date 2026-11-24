const assert = require('assert');
const WM = require('../lib/warmap.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

// --- mapPoint / mapPoints: the coordinate shapes render/src/gazetteer.mjs's coordOf() accepts ---
t('mapPoint keeps a raw [lng,lat] pair', () => {
  assert.deepStrictEqual(WM.mapPoint([44.5, 48.7]), [44.5, 48.7]);
});
t('mapPoint keeps a bare place-name string', () => {
  assert.strictEqual(WM.mapPoint('Stalingrad'), 'Stalingrad');
});
t('mapPoint keeps a {place} object', () => {
  assert.deepStrictEqual(WM.mapPoint({ place: 'Stalingrad' }), { place: 'Stalingrad' });
});
t('mapPoint keeps a {coord} object', () => {
  assert.deepStrictEqual(WM.mapPoint({ coord: [44.5, 48.7] }), { coord: [44.5, 48.7] });
});
t('mapPoint rejects malformed entries', () => {
  assert.strictEqual(WM.mapPoint(null), null);
  assert.strictEqual(WM.mapPoint(42), null);
  assert.strictEqual(WM.mapPoint([1]), null);
  assert.strictEqual(WM.mapPoint({}), null);
  assert.strictEqual(WM.mapPoint({ coord: ['a', 'b'] }), null);
});
t('mapPoints filters malformed entries out of a mixed array', () => {
  assert.deepStrictEqual(
    WM.mapPoints([[44.5, 48.7], 'Stalingrad', { place: 'Kursk' }, null, 42, { coord: [1, 2] }]),
    [[44.5, 48.7], 'Stalingrad', { place: 'Kursk' }, { coord: [1, 2] }]
  );
});

// --- sanitizeWarFields: the whole §4 field set, as extended in server.js update-scene ---
t('sanitizeWarFields keeps theme/zoom only when a valid enum value', () => {
  assert.strictEqual(WM.sanitizeWarFields({ theme: 'war' }).theme, 'war');
  assert.strictEqual(WM.sanitizeWarFields({ theme: 'atlas' }).theme, 'atlas');
  assert.strictEqual(WM.sanitizeWarFields({ theme: 'bogus' }).theme, undefined);
  assert.strictEqual(WM.sanitizeWarFields({ zoom: 'operational' }).zoom, 'operational');
  assert.strictEqual(WM.sanitizeWarFields({ zoom: 'strategic' }).zoom, 'strategic');
  assert.strictEqual(WM.sanitizeWarFields({ zoom: 'tactical' }).zoom, undefined);
});

t('sanitizeWarFields sanitizes sides: label/color kept, bad color falls back, non-objects dropped', () => {
  const out = WM.sanitizeWarFields({
    sides: { axis: { label: 'German 6th Army', color: '#c0392b' }, sov: { label: 'Soviet 62nd', color: 'not-a-color' }, bad: 'nope' },
  });
  assert.deepStrictEqual(out.sides.axis, { label: 'German 6th Army', color: '#c0392b' });
  assert.strictEqual(out.sides.sov.color, '#cf3a2e');
  assert.ok(!('bad' in out.sides));
});

t('sanitizeWarFields keeps a full round-trip of territory/fronts/pockets with resolved coord shapes', () => {
  const out = WM.sanitizeWarFields({
    territory: [{ polygon: [[44, 48], [45, 48], [45, 49]], side: 'axis' }],
    fronts: [{ line: [[44, 48], 'Stalingrad'], sideA: 'axis', sideB: 'sov', shade: true }],
    pockets: [{ polygon: [[44, 48], [45, 48], [45, 49]], side: 'sov' }],
  });
  assert.deepStrictEqual(out.territory, [{ polygon: [[44, 48], [45, 48], [45, 49]], side: 'axis' }]);
  assert.deepStrictEqual(out.fronts, [{ line: [[44, 48], 'Stalingrad'], sideA: 'axis', sideB: 'sov', shade: true }]);
  assert.deepStrictEqual(out.pockets, [{ polygon: [[44, 48], [45, 48], [45, 49]], side: 'sov' }]);
});

t('sanitizeWarFields drops territory/pockets with fewer than 3 polygon points, fronts with fewer than 2', () => {
  const out = WM.sanitizeWarFields({
    territory: [{ polygon: [[44, 48], [45, 48]], side: 'axis' }],
    fronts: [{ line: [[44, 48]], sideA: 'axis', sideB: 'sov' }],
  });
  assert.deepStrictEqual(out.territory, []);
  assert.deepStrictEqual(out.fronts, []);
});

t('sanitizeWarFields keeps units by place OR coord, drops units with neither', () => {
  const out = WM.sanitizeWarFields({
    units: [
      { place: 'Stalingrad', side: 'axis', type: 'infantry', name: '6th Army', strength: '90,000', facing: 90 },
      { coord: [44.6, 48.6], side: 'sov', type: 'armor', name: '4th Tank', strength: '12,000' },
      { side: 'sov', type: 'hq' },
    ],
  });
  assert.strictEqual(out.units.length, 2);
  assert.deepStrictEqual(out.units[0], { side: 'axis', place: 'Stalingrad', type: 'infantry', name: '6th Army', strength: '90,000', facing: 90 });
  assert.deepStrictEqual(out.units[1], { side: 'sov', coord: [44.6, 48.6], type: 'armor', name: '4th Tank', strength: '12,000' });
});

t('sanitizeWarFields keeps arrows by path OR from+to, honors the style enum, drops arrows with neither', () => {
  const out = WM.sanitizeWarFields({
    arrows: [
      { from: 'Kalach', to: 'Stalingrad', side: 'sov', style: 'pincer' },
      { path: [[44, 48], [45, 49], [46, 50]], side: 'axis', style: 'retreat' },
      { side: 'sov', style: 'bogus-style' },
    ],
  });
  assert.strictEqual(out.arrows.length, 2);
  assert.deepStrictEqual(out.arrows[0], { side: 'sov', style: 'pincer', from: 'Kalach', to: 'Stalingrad' });
  assert.deepStrictEqual(out.arrows[1], { side: 'axis', style: 'retreat', path: [[44, 48], [45, 49], [46, 50]] });
});

t('sanitizeWarFields keeps counters (label+value required) and a valid anchor', () => {
  const out = WM.sanitizeWarFields({
    counters: [
      { label: 'German casualties', value: '850,000', side: 'axis', anchor: 'tr' },
      { label: '', value: 5 },
      { value: 5 },
    ],
  });
  assert.deepStrictEqual(out.counters, [{ label: 'German casualties', value: '850,000', side: 'axis', anchor: 'tr' }]);
});

t('sanitizeWarFields keeps strengthBars (numeric value required), max/label optional', () => {
  const out = WM.sanitizeWarFields({
    strengthBars: [{ side: 'axis', value: 90000, max: 1000000 }, { side: 'sov', value: 'not-a-number' }],
  });
  assert.deepStrictEqual(out.strengthBars, [{ side: 'axis', value: 90000, max: 1000000 }]);
});

t('sanitizeWarFields keeps legend/title/date/phase with length caps', () => {
  const out = WM.sanitizeWarFields({ legend: true, title: 'Stalingrad', date: 'Nov 1942', phase: 'Operation Uranus' });
  assert.deepStrictEqual(out, { legend: true, title: 'Stalingrad', date: 'Nov 1942', phase: 'Operation Uranus' });
});

t('sanitizeWarFields omits fields entirely when absent from the patch (no phantom defaults)', () => {
  assert.deepStrictEqual(WM.sanitizeWarFields({ title: 'X' }), { title: 'X' });
  assert.deepStrictEqual(WM.sanitizeWarFields({}), {});
  assert.deepStrictEqual(WM.sanitizeWarFields(null), {});
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
