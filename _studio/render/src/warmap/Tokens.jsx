// The graduated unit token: D "Field Counter", WARMED toward a war-dossier look (operator's pick).
// Side-color body is KEPT (instant allegiance = the design's legibility win); warming = hand-drawn rough
// edges (filter url(#tokRough), defined by WarMap), a parchment-tinted glyph panel, the Archivo channel
// font, and a strength chip pinned to ONE parchment tone for cross-token consistency (judge fixes).
import { coordOf } from '../gazetteer.mjs';
import { placeBoxes } from './placeBoxes.mjs';

export const TOKEN_W = 150, TOKEN_H = 118;
const BLACK = '#1c1d1a', CASE = '#f4f1ea', SMOKE = '#2a2c2e', PARCH = '#e8dcc0';
const NAMEF = "'Archivo Black', Arial Black, Helvetica, sans-serif";

function hexToRgb(h) { let s = String(h).replace('#', ''); if (s.length === 3) s = s.split('').map((c) => c + c).join(''); const n = parseInt(s, 16); return Number.isFinite(n) ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 } : { r: 207, g: 58, b: 46 }; }
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function unitToken({ cx, cy, color, type, name, strength, scale = 1 }) {
  const fill = (typeof color === 'string' && color.trim()) ? color.trim() : '#cf3a2e';
  const { r, g, b } = hexToRgb(fill);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const ink = lum > 0.62 ? SMOKE : CASE;
  // glyph panel tinted toward PARCHMENT (warming) instead of pure white
  const pr = hexToRgb(PARCH), mix = (c, t, a) => Math.round(c + (t - c) * a), pa = 0.42;
  const panel = `rgb(${mix(r, pr.r, pa)},${mix(g, pr.g, pa)},${mix(b, pr.b, pa)})`;
  const S = String(strength == null ? '' : strength).trim();
  const NM = String(name == null ? '' : name).trim().slice(0, 14).toUpperCase();
  const BW = TOKEN_W, BH = TOKEN_H, x0 = -BW / 2, y0 = -BH / 2, rad = 12, ow = 6, cw = ow + 5, bandH = 34;
  const gcy = y0 + (BH - bandH) / 2;
  function glyph(t) {
    const sw = 8, k = 22, L = { stroke: ink, fill: 'none', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const a = (o) => Object.entries(o).map(([p, v]) => `${p}="${v}"`).join(' ');
    switch ((t || '').toLowerCase()) {
      case 'infantry': return `<rect x="${-k}" y="${-k * 0.74}" width="${k * 2}" height="${k * 1.48}" rx="3" ${a(L)} /><path d="M${-k},${-k * 0.74} L${k},${k * 0.74} M${k},${-k * 0.74} L${-k},${k * 0.74}" ${a(L)} />`;
      case 'armor': case 'armour': case 'tank': return `<rect x="${-k}" y="${-k * 0.5}" width="${k * 2}" height="${k}" rx="${k * 0.5}" ${a(L)} /><rect x="${-k * 0.34}" y="${-k * 0.92}" width="${k * 0.68}" height="${k * 0.42}" rx="3" ${a({ ...L, fill: ink })} />`;
      case 'cavalry': case 'recon': return `<path d="M${-k * 0.95},${k * 0.85} L${k * 0.85},${-k * 0.85}" ${a(L)} /><path d="M${k * 0.32},${-k * 0.85} L${k * 0.85},${-k * 0.85} L${k * 0.85},${-k * 0.32}" ${a(L)} />`;
      case 'artillery': case 'arty': return `<circle cx="0" cy="${-k * 0.42}" r="${k * 0.4}" ${a({ ...L, fill: ink })} /><path d="M${-k * 0.85},${k * 0.7} L${k * 0.85},${-k * 0.05}" ${a({ ...L, 'stroke-width': sw * 1.3 })} />`;
      case 'air': case 'aircraft': return `<path d="M0,${-k * 0.9} L${k * 0.9},${k * 0.7} L0,${k * 0.3} L${-k * 0.9},${k * 0.7} Z" ${a({ ...L, fill: ink })} />`;
      case 'naval': case 'navy': return `<path d="M${-k},0 L${k},0 L${k * 0.6},${k * 0.7} L${-k * 0.6},${k * 0.7} Z" ${a({ ...L, fill: ink })} /><path d="M0,0 L0,${-k * 0.9} M0,${-k * 0.9} L${k * 0.55},${-k * 0.5}" ${a(L)} />`;
      case 'hq': case 'command': return `<path d="M${-k * 0.6},${k} L${-k * 0.6},${-k}" ${a(L)} /><path d="M${-k * 0.6},${-k} L${k * 0.95},${-k * 0.55} L${-k * 0.6},${-k * 0.05} Z" ${a({ ...L, fill: ink })} />`;
      default: { let d = '', N = 5, R = k, rin = k * 0.42; for (let i = 0; i < N * 2; i++) { const rr = i % 2 ? rin : R, ang = -Math.PI / 2 + i * Math.PI / N; d += (i ? 'L' : 'M') + (rr * Math.cos(ang)).toFixed(1) + ',' + (rr * Math.sin(ang)).toFixed(1) + ' '; } return `<path d="${d}Z" ${a({ ...L, fill: ink, 'stroke-width': sw * 0.7 })} />`; }
    }
  }
  const nameSize = NM.length > 9 ? 19 : 23;
  const tabW = Math.max(46, S.length * 14 + 18), tabH = 30;
  return `<g transform="translate(${cx},${cy}) scale(${scale})" font-family="${NAMEF}">
  <ellipse cx="3" cy="${y0 + BH + 7}" rx="${BW * 0.46}" ry="9" fill="#1c1d1a" fill-opacity="0.18" />
  <g filter="url(#tokRough)">
    <rect x="${x0}" y="${y0}" width="${BW}" height="${BH}" rx="${rad}" fill="none" stroke="${CASE}" stroke-width="${cw}" stroke-linejoin="round" />
    <rect x="${x0}" y="${y0}" width="${BW}" height="${BH}" rx="${rad}" fill="${fill}" stroke="${BLACK}" stroke-width="${ow}" stroke-linejoin="round" />
  </g>
  <rect x="${x0 + 12}" y="${y0 + 11}" width="${BW - 24}" height="${BH - bandH - 18}" rx="7" fill="${panel}" stroke="${BLACK}" stroke-width="3.5" stroke-linejoin="round" />
  <g transform="translate(0,${gcy})">${glyph(type)}</g>
  <path d="M${x0 + ow / 2},${y0 + BH - bandH} H${x0 + BW - ow / 2} V${y0 + BH - rad} a${rad - ow / 2},${rad - ow / 2} 0 0 1 ${-(rad - ow / 2)},${rad - ow / 2} H${x0 + rad} a${rad - ow / 2},${rad - ow / 2} 0 0 1 ${-(rad - ow / 2)},${-(rad - ow / 2)} Z" fill="${BLACK}" fill-opacity="${lum > 0.62 ? 0.16 : 0.30}" />
  <line x1="${x0 + ow / 2}" y1="${y0 + BH - bandH}" x2="${x0 + BW - ow / 2}" y2="${y0 + BH - bandH}" stroke="${BLACK}" stroke-width="3" />
  <text x="0" y="${y0 + BH - bandH / 2 + 1}" text-anchor="middle" dominant-baseline="central" font-size="${nameSize}" font-weight="900" letter-spacing="1.5" fill="${ink}">${esc(NM)}</text>
  ${S ? `<g transform="translate(${x0 + BW - tabW + 2},${y0 - 2})"><rect x="0" y="0" width="${tabW}" height="${tabH}" rx="6" fill="${CASE}" stroke="${BLACK}" stroke-width="5" stroke-linejoin="round" /><rect x="2.5" y="2.5" width="${tabW - 5}" height="${tabH - 5}" rx="4" fill="${PARCH}" /><text x="${tabW / 2}" y="${tabH / 2 + 1}" text-anchor="middle" dominant-baseline="central" font-size="22" font-weight="900" letter-spacing="0.5" fill="${SMOKE}">${esc(S)}</text></g>` : ''}
</g>`;
}

// Resolve unit coords → de-collide → emit token SVGs + leader lines. Honors the ≤8 legibility cap by
// LOGGING overflow (never silently dropping — "no silent caps"). sideColor(side) → hex.
export function renderUnits(units, proj, opts = {}) {
  const scale = opts.scale || 1, sideColor = opts.sideColor || (() => '#cf3a2e');
  const items = [];
  for (const u of (units || [])) {
    const c = coordOf(u.place != null ? { place: u.place } : (u.coord != null ? { coord: u.coord } : u));
    const p = c && proj(c); if (!p) continue;
    items.push({ anchor: p, w: TOKEN_W * scale, h: TOKEN_H * scale, u });
  }
  let render = items, dropped = [];
  if (items.length > 8) { render = items.slice(0, 8); dropped = items.slice(8).map((x) => x.u.name); console.warn('[warmap] >8 unit tokens (' + items.length + ') — rendering 8, aggregate to higher echelon. Dropped:', dropped.join(', ')); }
  const placed = placeBoxes(render, { safe: opts.safe });
  const svgs = [], leaders = [];
  for (const it of placed) {
    const col = sideColor(it.u.side);
    svgs.push(unitToken({ cx: it.cx, cy: it.cy, color: col, type: it.u.type, name: it.u.name, strength: it.u.strength, scale }));
    if (it.nudged) leaders.push({ x1: it.anchor[0], y1: it.anchor[1], x2: it.cx, y2: it.cy, color: col });
  }
  return { svgs, leaders, dropped };
}
