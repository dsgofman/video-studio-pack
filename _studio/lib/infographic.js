// Validate + normalize a scene.infographic spec (compare | timeline | plot) before it reaches the
// deterministic renderer (render/src/Infographic.jsx), so authored data can't ship malformed. Pure +
// tested. Point order is PRESERVED (the author lists points left→right to match their axis, incl. a
// reversed "years ago" axis where xFrom>xTo) — we never reorder a curve out from under the author.
'use strict';

const TYPES = ['compare', 'bars', 'timeline', 'plot', 'curve', 'line', 'area'];
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function normalize(spec) {
  if (!spec || typeof spec !== 'object' || !TYPES.includes(spec.type)) return null;
  const t = spec.type;
  const out = { type: t };
  if (spec.title) out.title = str(spec.title, 120);
  if (spec.note) out.note = str(spec.note, 160);

  if (t === 'compare' || t === 'bars') {
    const items = (Array.isArray(spec.items) ? spec.items : []).map((it) => Object.assign(
      { label: str(it.label, 60), value: num(it.value) != null ? num(it.value) : 0 },
      it.valueLabel ? { valueLabel: str(it.valueLabel, 40) } : {},
      it.color ? { color: str(it.color, 24) } : {},
      it.note ? { note: str(it.note, 80) } : {},
    )).filter((it) => it.label);
    if (!items.length) return null;
    out.items = items;
    if (spec.unit) out.unit = str(spec.unit, 16);
    return out;
  }

  if (t === 'timeline') {
    const bars = (Array.isArray(spec.bars) ? spec.bars : []).map((b) => Object.assign(
      { label: str(b.label, 60), from: num(b.from), to: num(b.to) },
      b.sublabel ? { sublabel: str(b.sublabel, 40) } : {},
      b.color ? { color: str(b.color, 24) } : {},
    )).filter((b) => b.label && b.from != null && b.to != null);
    if (!bars.length) return null;
    out.bars = bars;
    if (spec.axis && (num(spec.axis.from) != null || num(spec.axis.to) != null)) out.axis = { from: num(spec.axis.from), to: num(spec.axis.to) };
    if (Array.isArray(spec.markers)) {
      const mk = spec.markers.map((m) => Object.assign({ at: num(m.at), label: str(m.label, 40) }, m.color ? { color: str(m.color, 24) } : {})).filter((m) => m.at != null);
      if (mk.length) out.markers = mk;
    }
    if (spec.overlap && num(spec.overlap.from) != null) out.overlap = { from: num(spec.overlap.from), to: num(spec.overlap.to), label: str(spec.overlap.label, 40) };
    return out;
  }

  // plot / curve / line / area — a quantity over a continuous axis
  const series = (Array.isArray(spec.series) ? spec.series : []).map((s) => {
    const points = (Array.isArray(s.points) ? s.points : [])
      .map((pt) => (Array.isArray(pt) ? [num(pt[0]), num(pt[1]), (pt[2] != null && pt[2] !== '' ? str(pt[2], 40) : undefined)] : null))
      .filter((pt) => pt && pt[0] != null && pt[1] != null);   // order preserved (do NOT sort — reversed-time axes)
    return Object.assign({ points }, s.label ? { label: str(s.label, 40) } : {}, s.color ? { color: str(s.color, 24) } : {}, s.valueLabel ? { valueLabel: str(s.valueLabel, 40) } : {});
  }).filter((s) => s.points.length >= 2);
  if (!series.length) return null;
  out.series = series;
  for (const k of ['xFrom', 'xTo', 'yMax']) if (num(spec[k]) != null) out[k] = num(spec[k]);
  for (const k of ['xLabel', 'yLabel', 'yUnit', 'xFromLabel', 'xToLabel']) if (spec[k] != null) out[k] = str(spec[k], 40);
  if (spec.smooth) out.smooth = true;
  if (spec.area) out.area = true;
  if (Array.isArray(spec.markers)) {
    const mk = spec.markers.map((m) => ({ at: num(m.at), label: str(m.label, 40) })).filter((m) => m.at != null);
    if (mk.length) out.markers = mk;
  }
  return out;
}

module.exports = { TYPES, normalize };
