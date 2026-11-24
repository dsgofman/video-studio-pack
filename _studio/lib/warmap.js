// lib/warmap.js — validates & sanitizes the war-map §4 fields for update-scene's `map`
// patch (theme/zoom/sides/territory/fronts/pockets/units/arrows/counters/strengthBars/legend/
// title/date/phase — the Phase 4.1 field list in docs/2026-06-15-war-maps-plan.md). The legacy
// atlas fields (focus/rotateLng/routes/arcs/labels/labelStyle/hand/padding) are untouched and stay
// inline in server.js — this module only covers what Phase 4.1 adds, so legacy behavior can't drift.
'use strict';

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const sideKey = (v) => (typeof v === 'string' ? v.slice(0, 24) : '');

// A war-map coordinate — same shapes render/src/gazetteer.mjs's coordOf() resolves: a raw
// [lng,lat] pair, a bare place-name string, {place:"name"}, or {coord:[lng,lat]}.
function mapPoint(c) {
  if (Array.isArray(c) && c.length === 2 && c.every(isNum)) return c;
  if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 60);
  if (isPlainObj(c)) {
    if (typeof c.place === 'string' && c.place.trim()) return { place: c.place.trim().slice(0, 60) };
    if (Array.isArray(c.coord) && c.coord.length === 2 && c.coord.every(isNum)) return { coord: c.coord };
  }
  return null;
}
function mapPoints(a) { return Array.isArray(a) ? a.map(mapPoint).filter((x) => x !== null) : []; }

function sanitizeSides(v) {
  if (!isPlainObj(v)) return {};
  const out = {};
  for (const k of Object.keys(v).slice(0, 12)) {
    const s = v[k];
    if (!isPlainObj(s)) continue;
    const key = sideKey(k); if (!key) continue;
    const color = (typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color.trim())) ? s.color.trim() : '#cf3a2e';
    out[key] = { label: str(s.label, 40) || key, color };
  }
  return out;
}
function sanitizeTerritory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlainObj)
    .map((t) => ({ polygon: mapPoints(t.polygon || t.region), side: sideKey(t.side) }))
    .filter((t) => t.polygon.length >= 3);
}
function sanitizePockets(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlainObj)
    .map((p) => ({ polygon: mapPoints(p.polygon), side: sideKey(p.side) }))
    .filter((p) => p.polygon.length >= 3);
}
function sanitizeFronts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlainObj)
    .map((f) => ({ line: mapPoints(f.line), sideA: sideKey(f.sideA), sideB: sideKey(f.sideB), shade: !!f.shade }))
    .filter((f) => f.line.length >= 2);
}
function sanitizeUnits(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlainObj).map((u) => {
    const out = { side: sideKey(u.side) };
    if (typeof u.place === 'string' && u.place.trim()) out.place = u.place.trim().slice(0, 60);
    else if (Array.isArray(u.coord) && u.coord.length === 2 && u.coord.every(isNum)) out.coord = u.coord;
    if (typeof u.type === 'string') out.type = u.type.slice(0, 20);
    if (typeof u.name === 'string') out.name = u.name.slice(0, 40);
    if (u.strength !== undefined) out.strength = isNum(u.strength) ? u.strength : str(String(u.strength), 20);
    if (isNum(u.facing)) out.facing = u.facing;
    return out;
  }).filter((u) => u.place !== undefined || u.coord !== undefined);
}
function sanitizeArrows(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlainObj).map((a) => {
    const out = { side: sideKey(a.side) };
    if (['attack', 'pincer', 'retreat'].includes(a.style)) out.style = a.style;
    const path = mapPoints(a.path);
    if (path.length >= 2) { out.path = path; return out; }
    const from = mapPoint(a.from), to = mapPoint(a.to);
    if (from !== null && to !== null) { out.from = from; out.to = to; }
    return out;
  }).filter((a) => a.path || (a.from !== undefined && a.to !== undefined));
}
function sanitizeCounters(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((c) => isPlainObj(c) && typeof c.label === 'string' && c.label.trim() && c.value !== undefined && c.value !== null)
    .map((c) => {
      const out = { label: c.label.slice(0, 40), value: isNum(c.value) ? c.value : str(String(c.value), 20), side: sideKey(c.side) };
      if (['tl', 'tr', 'bl', 'br'].includes(c.anchor)) out.anchor = c.anchor;
      return out;
    });
}
function sanitizeStrengthBars(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((b) => isPlainObj(b) && isNum(b.value)).map((b) => {
    const out = { side: sideKey(b.side), value: b.value };
    if (isNum(b.max)) out.max = b.max;
    if (typeof b.label === 'string') out.label = b.label.slice(0, 40);
    return out;
  });
}

// Sanitize ONLY the war-map fields present in a raw `map` patch object. Returns a plain object
// meant to be spread onto the legacy-field s.map server.js already builds — a field is present in
// the output iff it was present (in any recognizable shape) in the input, so a patch that omits a
// field never clobbers it with a phantom default.
function sanitizeWarFields(mapPatch) {
  const p = isPlainObj(mapPatch) ? mapPatch : {};
  const out = {};
  if (p.theme === 'war' || p.theme === 'atlas') out.theme = p.theme;
  if (p.zoom === 'strategic' || p.zoom === 'operational') out.zoom = p.zoom;
  if (p.sides !== undefined) out.sides = sanitizeSides(p.sides);
  if (p.territory !== undefined) out.territory = sanitizeTerritory(p.territory);
  if (p.fronts !== undefined) out.fronts = sanitizeFronts(p.fronts);
  if (p.pockets !== undefined) out.pockets = sanitizePockets(p.pockets);
  if (p.units !== undefined) out.units = sanitizeUnits(p.units);
  if (p.arrows !== undefined) out.arrows = sanitizeArrows(p.arrows);
  if (p.counters !== undefined) out.counters = sanitizeCounters(p.counters);
  if (p.strengthBars !== undefined) out.strengthBars = sanitizeStrengthBars(p.strengthBars);
  if (typeof p.legend === 'boolean') out.legend = p.legend;
  if (typeof p.title === 'string') out.title = p.title.slice(0, 80);
  if (typeof p.date === 'string') out.date = p.date.slice(0, 40);
  if (typeof p.phase === 'string') out.phase = p.phase.slice(0, 60);
  return out;
}

module.exports = { sanitizeWarFields, mapPoint, mapPoints };
