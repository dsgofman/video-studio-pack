// War operational-layer primitives — territory fills, front lines, pockets, broad attack arrows.
// Each returns an SVG string (injected by WarMap). Coords accept [lng,lat], {place}, or a name string.
import { coordOf } from '../gazetteer.mjs';

function smooth(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
function resolve(arr, proj) {
  return (arr || []).map((c) => {
    const r = coordOf(Array.isArray(c) ? { coord: c } : (typeof c === 'string' ? { place: c } : c));
    return r && proj(r);
  }).filter(Boolean);
}
const polyD = (pts) => pts.length < 3 ? '' : 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' Z';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const INK = '#2c2114', CASE = '#f4f1ea', TRACK = '#cfc3a4';

// on-map COUNTER chip: a stamped readout (e.g. casualties) — side-colored spine + label + big value
export function counterChipSvg({ x, y, w = 426, label, value, color }) {
  return `<g transform="translate(${x},${y})" font-family="'Archivo Black', Arial Black, Helvetica, sans-serif">`
    + `<rect width="${w}" height="96" rx="12" fill="${CASE}" stroke="${INK}" stroke-width="3" />`
    + `<rect width="14" height="96" rx="6" fill="${color}" />`
    + `<text x="34" y="42" font-family="sans-serif" font-size="26" font-weight="800" fill="${INK}" letter-spacing="2">${esc(String(label).toUpperCase())}</text>`
    + `<text x="34" y="84" font-size="46" font-weight="900" fill="${color}">${esc(value)}</text>`
    + `</g>`;
}

// on-map STRENGTH BARS panel: one proportional bar per side (value / max), side-colored
export function strengthBarsSvg({ x, y, w = 440, bars, sideColor, sides }) {
  const rowH = 60, padT = 60, panelH = padT + bars.length * rowH + 6;
  const max = Math.max(...bars.map((b) => b.max || b.value || 1), 1);
  let rows = '';
  bars.forEach((b, i) => {
    const col = sideColor(b.side), by = padT + i * rowH;
    const label = String(b.label || (sides[b.side] && sides[b.side].label) || b.side || '').toUpperCase();
    const trackW = w - 210, bw = trackW * Math.min(1, (b.value || 0) / (b.max || max));
    const vlabel = b.valueLabel != null ? b.valueLabel : (b.value != null ? b.value : '');
    rows += `<text x="22" y="${by - 4}" font-family="sans-serif" font-size="22" font-weight="800" fill="${INK}">${esc(label)}</text>`
      + `<rect x="22" y="${by}" width="${trackW}" height="22" rx="6" fill="${TRACK}" />`
      + `<rect x="22" y="${by}" width="${bw.toFixed(1)}" height="22" rx="6" fill="${col}" />`
      + `<text x="${w - 22}" y="${by + 19}" text-anchor="end" font-family="'Archivo Black', Arial Black, sans-serif" font-size="26" font-weight="900" fill="${col}">${esc(vlabel)}</text>`;
  });
  return `<g transform="translate(${x},${y})"><rect width="${w}" height="${panelH}" rx="12" fill="${CASE}" stroke="${INK}" stroke-width="3" />`
    + `<text x="22" y="38" font-family="'Archivo Black', Arial Black, sans-serif" font-size="28" font-weight="900" fill="${INK}">STRENGTH</text>${rows}</g>`;
}
export const strengthPanelH = (n) => 60 + n * 60 + 6;

// territory: low-opacity control fill by side
export function territorySvg(territory, proj, sideColor) {
  return (territory || []).map((t) => {
    const d = polyD(resolve(t.polygon || t.region || [], proj)); if (!d) return '';
    const col = sideColor(t.side);
    return `<path d="${d}" fill="${col}" fill-opacity="0.20" stroke="${col}" stroke-opacity="0.45" stroke-width="2" />`;
  }).join('');
}

// pockets: an encircled area — bold dashed side-colored ring + a denser fill (reads "surrounded")
export function pocketSvg(pockets, proj, sideColor) {
  return (pockets || []).map((p) => {
    const d = polyD(resolve(p.polygon || [], proj)); if (!d) return '';
    const col = sideColor(p.side);
    return `<path d="${d}" fill="${col}" fill-opacity="0.30" stroke="${col}" stroke-width="5" stroke-dasharray="15 9" stroke-linejoin="round" />`;
  }).join('');
}

// fronts: the jagged dividing line — cream casing, ink core, accent dashes
export function frontSvg(fronts, proj, accent) {
  return (fronts || []).map((f) => {
    const pts = resolve(f.line || [], proj); if (pts.length < 2) return '';
    const d = smooth(pts);
    return `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="#f4f1ea" stroke-width="13" /><path d="${d}" stroke="#2c2114" stroke-width="9" /><path d="${d}" stroke="${accent}" stroke-width="4" stroke-dasharray="2 13" /></g>`;
  }).join('');
}

// arrows: broad attack/pincer (thick side-colored stroke + big arrowhead); retreat = thinner + dashed
export function arrowsSvg(arrows, proj, sideColor) {
  return (arrows || []).map((a) => {
    const pts = resolve(a.path || [a.from, a.to], proj); if (pts.length < 2) return '';
    const col = sideColor(a.side), d = smooth(pts);
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]), ah = 44;
    const a1 = [last[0] - ah * Math.cos(ang - 0.5), last[1] - ah * Math.sin(ang - 0.5)];
    const a2 = [last[0] - ah * Math.cos(ang + 0.5), last[1] - ah * Math.sin(ang + 0.5)];
    const retreat = a.style === 'retreat', w = retreat ? 10 : 18;
    const dash = retreat ? ' stroke-dasharray="11 10"' : '';
    return `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="#f4f1ea" stroke-width="${w + 8}" /><path d="${d}" stroke="${col}" stroke-width="${w}"${dash} /><path d="M${last[0].toFixed(1)},${last[1].toFixed(1)} L${a1[0].toFixed(1)},${a1[1].toFixed(1)} L${a2[0].toFixed(1)},${a2[1].toFixed(1)} Z" fill="${col}" stroke="#f4f1ea" stroke-width="6" stroke-linejoin="round" /></g>`;
  }).join('');
}
