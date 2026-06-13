import { AbsoluteFill } from 'remotion';
import { geoNaturalEarth1, geoPath, geoGraticule10 } from 'd3-geo';
import { feature } from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';

const W = 1920, H = 1080;
const land = feature(landTopo, landTopo.objects.land);   // coastline only — no political borders
const graticule = geoGraticule10();
const ACCENT = '#e07a3c', CASING = '#fff7ec';

// Smooth Catmull-Rom spline through projected waypoints -> SVG path (organic coast-hugging route)
function smooth(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---- Label layout: greedy, non-overlapping, on-screen, legible ----------------------------------
// SVG <text> exposes no measurable box in the Remotion render pipeline, so we ESTIMATE each label's
// footprint from font metrics and lay labels out so they never collide with each other, with the
// prominent route markers, or with the frame edge. The pass is a pure function of (labels, proj) —
// no randomness, no per-frame state — so positions are rock-steady while the route animates on.
function labelBox(text, size, ls) {
  // uppercase, letter-spaced serif: ~0.6em advance per glyph + tracking, plus a little plate padding
  const w = String(text).length * size * 0.6 + Math.max(0, String(text).length - 1) * ls + size * 0.55;
  return { w, h: size * 1.02 };
}
const interArea = (a, b) => {
  const x = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const y = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return x * y;
};
const ptBox = (p, r) => ({ x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r });
// Place labels biggest-first (region names anchor where they sit; bigger = more important). Each gets
// a ranked list of candidate offsets; we take the first with zero overlap, else the least-overlapping.
function placeLabels(labels, proj, ls, obstacles, safe) {
  const placed = [];                                   // boxes already committed (for collision tests)
  const out = new Array(labels.length).fill(null);
  const order = labels.map((l, i) => ({ l, i })).sort((a, b) => (b.l.size || 44) - (a.l.size || 44));
  for (const { l, i } of order) {
    const p = proj(l.coord); if (!p) continue;
    const size = l.size || 44;
    const { w, h } = labelBox(l.text, size, ls);
    const isMarker = !!l.dot || !!l.marker;
    const gap = isMarker ? size * 0.55 : 0;
    // candidate CENTER offsets from the anchor point, in priority order
    const cands = isMarker
      ? [[w / 2 + gap, 0], [-w / 2 - gap, 0], [0, -h - gap], [0, h + gap],
         [w / 2 + gap, -h - gap], [-w / 2 - gap, -h - gap], [w / 2 + gap, h + gap], [-w / 2 - gap, h + gap]]
      : [[0, 0], [0, -h * 0.95], [0, h * 0.95], [w * 0.62, 0], [-w * 0.62, 0],
         [0, -h * 1.9], [0, h * 1.9], [w * 0.62, -h * 0.95], [-w * 0.62, -h * 0.95], [w * 0.62, h * 0.95], [-w * 0.62, h * 0.95]];
    let best = null, bestScore = Infinity;
    for (const [dx, dy] of cands) {
      let cx = p[0] + dx, cy = p[1] + dy;
      cx = Math.max(safe.x0 + w / 2, Math.min(safe.x1 - w / 2, cx));   // keep fully inside the safe frame
      cy = Math.max(safe.y0 + h / 2, Math.min(safe.y1 - h / 2, cy));
      const box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
      let score = 0;
      for (const o of obstacles) score += interArea(box, o) * 1.4;
      for (const q of placed) score += interArea(box, q);
      if (score < bestScore) { bestScore = score; best = { cx, cy, box, anchor: p, isMarker, l, i }; if (score === 0) break; }
    }
    if (best) { placed.push(best.box); out[i] = best; }
  }
  return out;   // index-aligned with labels; each entry: { cx, cy, anchor, isMarker, l, i } | null
}

// inputProps: rotateLng, focus[[lng,lat]], routes[[ [lng,lat],... ]], arcs[{from,to}], labels[{text,coord,size}], hand, wobble
// progress (0..1, default 1 = fully drawn still): animates route draw-on, label fades and the arrowhead reveal.
const LABEL_STYLES = {
  // clean cream on a soft dark plate
  modern: { fill: '#fff', family: 'sans-serif', weight: '700', ls: 5, filter: 'lblShadow', opacity: 1, plate: '#13242c', plateOp: 0.42, dot: '#fff' },
  // classic atlas: tracked dark-brown serif on a faint cream plate
  serif: { fill: '#3c2c19', family: 'Georgia, "Times New Roman", serif', weight: '600', ls: 7, filter: 'lblGlow', opacity: 0.97, plate: '#fbf3e2', plateOp: 0.5, dot: '#b5532a' },
  // understated editorial: dark, light weight, heavily tracked, faint plate
  minimal: { fill: '#26312a', family: 'sans-serif', weight: '500', ls: 9, filter: 'lblGlow', opacity: 0.85, plate: '#fbf6ec', plateOp: 0.4, dot: '#3c4a40' },
};

export const MapStill = ({ rotateLng = 0, focus = [[0, 0]], routes = [], arcs = [], labels = [], padding = 165, hand = false, wobble = 14, labelStyle = 'serif', progress = 1 }) => {
  const proj = geoNaturalEarth1().rotate([rotateLng, 0]);
  proj.fitExtent([[padding, padding], [W - padding, H - padding]], { type: 'MultiPoint', coordinates: focus });
  const path = geoPath(proj);
  const allRoutes = [...routes, ...arcs.map((a) => [a.from, a.to])];
  // Route draws from 12%..82% of the beat; the land/sea are always fully there.
  const drawP = progress >= 1 ? 1 : clamp01((progress - 0.12) / 0.7);
  // Lay the labels out ONCE (independent of progress): avoid each other, the route markers, and the
  // frame edge. Obstacles = the prominent origin dots + arrowheads so a place name never lands on one.
  const SAFE = { x0: 86, y0: 76, x1: W - 86, y1: H - 80 };
  const obstacles = [];
  for (const wp of allRoutes) {
    const pts = wp.map((c) => proj(c)).filter(Boolean);
    if (pts.length < 2) continue;
    obstacles.push(ptBox(pts[0], 26), ptBox(pts[pts.length - 1], 42));
  }
  const LS = (LABEL_STYLES[labelStyle] || LABEL_STYLES.modern).ls;
  const placements = placeLabels(labels, proj, LS, obstacles, SAFE);
  return (
    <AbsoluteFill style={{ backgroundColor: '#9cc3d8' }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <radialGradient id="sea" cx="50%" cy="40%" r="78%">
            <stop offset="0%" stopColor="#c4e1ee" /><stop offset="100%" stopColor="#93bccf" />
          </radialGradient>
          <radialGradient id="vig" cx="50%" cy="50%" r="72%">
            <stop offset="60%" stopColor="#13242c" stopOpacity="0" /><stop offset="100%" stopColor="#13242c" stopOpacity="0.30" />
          </radialGradient>
          <filter id="landsh" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="7" stdDeviation="10" floodColor="#243318" floodOpacity="0.30" />
          </filter>
          <filter id="lblShadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="5" floodColor="#0f1f28" floodOpacity="0.7" />
          </filter>
          <filter id="lblGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#fdf6e9" floodOpacity="1" />
          </filter>
          {hand && (
            <filter id="rough" x="-6%" y="-6%" width="112%" height="112%">
              <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="n" />
              <feDisplacementMap in="SourceGraphic" in2="n" scale={wobble} xChannelSelector="R" yChannelSelector="G" />
            </filter>
          )}
        </defs>

        <rect x="0" y="0" width={W} height={H} fill="url(#sea)" />
        <path d={path(graticule)} fill="none" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="1" />

        <g filter={hand ? 'url(#rough)' : undefined}>
          <g filter="url(#landsh)">
            <path d={path(land)} fill="#aac487" stroke="#586c3a" strokeWidth={hand ? 2.4 : 1.7} strokeLinejoin="round" />
          </g>
        </g>

        {allRoutes.map((wp, i) => {
          const pts = wp.map((c) => proj(c)).filter(Boolean);
          if (pts.length < 2) return null;
          const d = smooth(pts);
          const last = pts[pts.length - 1], prev = pts[pts.length - 2];
          const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
          const ah = 34;
          const a1 = [last[0] - ah * Math.cos(ang - 0.45), last[1] - ah * Math.sin(ang - 0.45)];
          const a2 = [last[0] - ah * Math.cos(ang + 0.45), last[1] - ah * Math.sin(ang + 0.45)];
          const o = pts[0];
          // pathLength normalization lets strokeDashoffset draw the route on exactly, casing and core together.
          const dash = drawP >= 1 ? {} : { pathLength: 100, strokeDasharray: 100, strokeDashoffset: 100 - drawP * 100 };
          const dotIn = drawP >= 1 ? 1 : clamp01(drawP / 0.06);              // origin dot pops first
          const headIn = drawP >= 1 ? 1 : clamp01((drawP - 0.96) / 0.04);    // arrowhead lands last
          return (
            <g key={i} strokeLinecap="round" strokeLinejoin="round">
              <path d={d} fill="none" stroke={CASING} strokeWidth="20" {...dash} />
              <path d={d} fill="none" stroke={ACCENT} strokeWidth="11" {...dash} />
              <g transform={`translate(${o[0]},${o[1]}) scale(${dotIn})`}>
                <circle r="14" fill={CASING} /><circle r="8.5" fill={ACCENT} />
              </g>
              <path d={`M${last[0]},${last[1]} L${a1[0]},${a1[1]} L${a2[0]},${a2[1]} Z`} fill={ACCENT} stroke={CASING} strokeWidth="6" strokeLinejoin="round" opacity={headIn} />
            </g>
          );
        })}

        <rect x="0" y="0" width={W} height={H} fill="url(#vig)" />

        {placements.map((pl) => {
          if (!pl) return null;
          const { l, i, cx, cy, anchor, isMarker, box } = pl;
          const s = LABEL_STYLES[labelStyle] || LABEL_STYLES.modern;
          // Labels fade in staggered while the route draws (still: progress=1 -> all fully on).
          const lblIn = progress >= 1 ? 1 : clamp01((progress - (0.06 + i * 0.14)) / 0.12);
          const w = box.x1 - box.x0, h = box.y1 - box.y0;
          const offset = Math.hypot(cx - anchor[0], cy - anchor[1]);
          return (
            <g key={i} opacity={lblIn}>
              {/* leader line when a place name had to be pushed off its dot to clear a collision */}
              {isMarker && offset > h * 0.95 ? (
                <line x1={anchor[0].toFixed(1)} y1={anchor[1].toFixed(1)} x2={cx.toFixed(1)} y2={cy.toFixed(1)} stroke={s.dot} strokeWidth="2" strokeOpacity="0.55" />
              ) : null}
              {/* soft legibility plate sized to the label — de-collision guarantees plates don't overlap */}
              <rect x={(cx - w / 2).toFixed(1)} y={(cy - h / 2).toFixed(1)} width={w.toFixed(1)} height={h.toFixed(1)} rx={(h * 0.34).toFixed(1)} fill={s.plate} fillOpacity={s.plateOp} />
              {isMarker ? <circle cx={anchor[0].toFixed(1)} cy={anchor[1].toFixed(1)} r="7" fill={s.dot} stroke="#fff7ec" strokeWidth="2.5" /> : null}
              <text x={cx.toFixed(1)} y={cy.toFixed(1)} textAnchor="middle" dominantBaseline="central" fontFamily={s.family}
                fontSize={l.size || 44} fontWeight={s.weight} letterSpacing={s.ls} fill={s.fill} fillOpacity={s.opacity}
                filter={`url(#${s.filter})`}>{l.text}</text>
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
