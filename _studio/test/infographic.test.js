const assert = require('assert');
const I = require('../lib/infographic.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('rejects junk + unknown types', () => {
  assert.strictEqual(I.normalize(null), null);
  assert.strictEqual(I.normalize({ type: 'pie' }), null);
  assert.strictEqual(I.normalize({ type: 'compare', items: [] }), null);
});

t('compare keeps labelled numeric items + unit', () => {
  const o = I.normalize({ type: 'compare', title: 'Brain size', unit: 'cc', items: [
    { label: 'Aus', value: 450, color: '#111', valueLabel: '450 cc' },
    { label: '', value: 9 },           // dropped (no label)
  ] });
  assert.strictEqual(o.type, 'compare');
  assert.strictEqual(o.items.length, 1);
  assert.strictEqual(o.items[0].valueLabel, '450 cc');
  assert.strictEqual(o.unit, 'cc');
});

t('timeline keeps bars with from/to + markers', () => {
  const o = I.normalize({ type: 'timeline', bars: [
    { label: 'Neanderthal', from: 400000, to: 40000 },
    { label: 'bad', from: 'x', to: 1 },   // dropped (from not numeric)
  ], markers: [{ at: 40000, label: 'extinction' }, { at: null, label: 'x' }] });
  assert.strictEqual(o.bars.length, 1);
  assert.strictEqual(o.markers.length, 1);
});

t('plot preserves point ORDER (reversed-time axis not reordered)', () => {
  const o = I.normalize({ type: 'plot', smooth: true, xFrom: 3500000, xTo: 0, yUnit: 'cc',
    series: [{ color: '#b4642b', points: [[3500000, 450, 'Aus'], [1800000, 800], [0, 1350, 'Us']] }] });
  assert.strictEqual(o.type, 'plot');
  assert.strictEqual(o.smooth, true);
  assert.strictEqual(o.xFrom, 3500000);
  assert.strictEqual(o.yUnit, 'cc');
  // order preserved oldest→youngest (NOT sorted ascending by x)
  assert.deepStrictEqual(o.series[0].points.map((pt) => pt[0]), [3500000, 1800000, 0]);
  assert.strictEqual(o.series[0].points[0][2], 'Aus');     // callout kept
  assert.strictEqual(o.series[0].points[1][2], undefined); // no callout
});

t('plot drops non-numeric points + series with <2 valid points', () => {
  const o = I.normalize({ type: 'curve', series: [
    { points: [[1, 2], ['x', 3], [4, 5]] },   // middle dropped → 2 valid → kept
    { points: [[1, 2]] },                       // <2 → series dropped
  ] });
  assert.strictEqual(o.series.length, 1);
  assert.strictEqual(o.series[0].points.length, 2);
});

t('aliases line/area/curve normalize as plots; area flag passes through', () => {
  assert.strictEqual(I.normalize({ type: 'line', series: [{ points: [[0, 0], [1, 1]] }] }).type, 'line');
  assert.strictEqual(I.normalize({ type: 'area', area: true, series: [{ points: [[0, 0], [1, 1]] }] }).area, true);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
