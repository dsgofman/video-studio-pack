// Deterministic, DATA-DRIVEN infographics (timelines, quantity comparisons, simple charts) rendered
// by CODE — never by an image model. So the labels, numbers and proportions are ALWAYS correct and
// consistent. Same idea as the d3 Map engine: precise information should never be hallucinated.
//
// Scene contract:  scene.infographic = { type, ...spec }   (rendered instead of a Gemini image)
//   type:'timeline' { title, axis:{from,to}, bars:[{label,from,to,color,sublabel}], overlap:{from,to,label},
//                     markers:[{at,label,color}], note }
//   type:'compare'  { title, items:[{label,value,valueLabel,color,note}], unit, note }
//   type:'bars'     alias of compare
import { AbsoluteFill } from 'remotion';
import { ARCHIVO_BLACK, PERMANENT_MARKER } from './fonts.mjs';

const W = 1920, H = 1080;
const PAPER = '#f3e9d2', PAPER2 = '#ece0c4', INK = '#2c2114', ACCENT = '#e07a3c', GRID = '#c9b894';
const SERIES = ['#b4642b', '#3f6f9f', '#5b8c5a', '#9a6a9c', '#c2933a'];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const Fonts = () => (
  <style>{`
    @font-face { font-family: 'Archivo Black'; src: url('${ARCHIVO_BLACK}') format('truetype'); }
    @font-face { font-family: 'Marker'; src: url('${PERMANENT_MARKER}') format('truetype'); }
  `}</style>
);

// 12,500 -> "12,500"; 40000 -> "40,000"; 0 -> "today"
function commas(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function yLabel(y, to) { return (y === 0 && (to === 0 || to == null)) ? 'today' : commas(y); }

function Frame({ title, note, children }) {
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER }}>
      <Fonts />
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <radialGradient id="ig-bg" cx="50%" cy="42%" r="80%">
            <stop offset="0%" stopColor={PAPER} /><stop offset="100%" stopColor={PAPER2} />
          </radialGradient>
          <radialGradient id="ig-vig" cx="50%" cy="50%" r="72%">
            <stop offset="62%" stopColor="#1d140a" stopOpacity="0" /><stop offset="100%" stopColor="#1d140a" stopOpacity="0.10" />
          </radialGradient>
          <filter id="ig-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#3a2c18" floodOpacity="0.18" />
          </filter>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#ig-bg)" />
        {title ? (
          <text x={W / 2} y="118" textAnchor="middle" fontFamily="'Archivo Black', sans-serif" fontSize="58" fill={INK}>{title}</text>
        ) : null}
        {children}
        {note ? (
          <text x={W / 2} y={H - 70} textAnchor="middle" fontFamily="Georgia, serif" fontStyle="italic" fontSize="33" fill="#5d4a2f">{note}</text>
        ) : null}
        <rect x="0" y="0" width={W} height={H} fill="url(#ig-vig)" />
      </svg>
    </AbsoluteFill>
  );
}

// ---- TIMELINE: bars on a shared time axis (years-ago, oldest on the LEFT) ----------------------------
function Timeline({ spec, progress }) {
  const bars = spec.bars || [];
  const markers = spec.markers || [];
  const axis = spec.axis || {};
  const allYears = [...bars.flatMap((b) => [b.from, b.to]), ...markers.map((m) => m.at)];
  const from = axis.from != null ? axis.from : Math.max(...allYears, 1);   // oldest (left)
  const to = axis.to != null ? axis.to : Math.min(...allYears, 0);         // youngest (right)
  const L = 250, R = W - 170, baseY = H - 250, topY = 250;
  const span = (from - to) || 1;
  const x = (y) => L + ((from - y) / span) * (R - L);                      // older -> left
  const rows = bars.length;
  const laneH = Math.min(96, (baseY - topY) / Math.max(1, rows) - 30);
  const drawn = (v0) => clamp01((progress - v0) / 0.5);                    // staggered grow-in

  return (
    <Frame title={spec.title} note={spec.note}>
      {/* axis */}
      <line x1={L} y1={baseY} x2={R} y2={baseY} stroke={INK} strokeWidth="3" />
      {[from, to].map((yr, i) => (
        <g key={'ax' + i}>
          <line x1={x(yr)} y1={baseY - 8} x2={x(yr)} y2={baseY + 8} stroke={INK} strokeWidth="3" />
          <text x={x(yr)} y={baseY + 42} textAnchor={i === 0 ? 'start' : 'end'} fontFamily="'Archivo Black', sans-serif" fontSize="28" fill={INK}>{yLabel(yr, to)}</text>
        </g>
      ))}
      <text x={(L + R) / 2} y={baseY + 80} textAnchor="middle" fontFamily="Georgia, serif" fontSize="24" fill="#6a553a" letterSpacing="4">YEARS AGO  ◄  TIME  ►  TODAY</text>

      {/* overlap highlight band */}
      {spec.overlap ? (() => {
        const ox = x(spec.overlap.from), ox2 = x(spec.overlap.to);
        return (
          <g opacity={clamp01((progress - 0.55) / 0.3)}>
            <rect x={Math.min(ox, ox2)} y={topY - 6} width={Math.abs(ox2 - ox)} height={baseY - topY + 6} fill={ACCENT} fillOpacity="0.16" />
            <line x1={ox} y1={topY - 6} x2={ox} y2={baseY} stroke={ACCENT} strokeWidth="2.5" strokeDasharray="6 6" />
            <line x1={ox2} y1={topY - 6} x2={ox2} y2={baseY} stroke={ACCENT} strokeWidth="2.5" strokeDasharray="6 6" />
            <text x={(ox + ox2) / 2} y={topY - 18} textAnchor="middle" fontFamily="'Archivo Black', sans-serif" fontSize="30" fill={ACCENT}>{spec.overlap.label || ''}</text>
          </g>
        );
      })() : null}

      {/* bars */}
      {bars.map((b, i) => {
        const y = topY + 30 + i * (laneH + 34);
        const x0 = x(b.from), x1 = x(b.to), w = (x1 - x0) * drawn(0.1 + i * 0.12);
        const color = b.color || SERIES[i % SERIES.length];
        return (
          <g key={'bar' + i} filter="url(#ig-soft)">
            <text x={x0} y={y - 14} fontFamily="'Archivo Black', sans-serif" fontSize="32" fill={INK}>{b.label}</text>
            <rect x={x0} y={y} width={(x1 - x0)} height={laneH} rx={laneH / 2} fill="#fff" fillOpacity="0.35" stroke={color} strokeWidth="2" strokeDasharray="3 7" />
            <rect x={x0} y={y} width={Math.max(0, w)} height={laneH} rx={laneH / 2} fill={color} />
            {b.sublabel && drawn(0.1 + i * 0.12) > 0.6 ? (
              <text x={x0 + 22} y={y + laneH / 2 + 10} fontFamily="'Archivo Black', sans-serif" fontSize="27" fill="#fff">{b.sublabel}</text>
            ) : null}
          </g>
        );
      })}

      {/* markers */}
      {markers.map((m, i) => {
        const mx = x(m.at), c = m.color || '#c0392b';
        const on = clamp01((progress - 0.6 - i * 0.1) / 0.3);
        return (
          <g key={'mk' + i} opacity={on}>
            <line x1={mx} y1={topY - 30} x2={mx} y2={baseY} stroke={c} strokeWidth="3.5" strokeDasharray="2 8" />
            <circle cx={mx} cy={baseY} r="9" fill={c} />
            <g transform={`translate(${mx}, ${topY - 30})`}>
              <rect x="-8" y="-46" width={(m.label || '').length * 13 + 26} height="42" rx="8" fill={c} />
              <text x={(m.label || '').length * 6.5 + 5} y="-18" textAnchor="middle" fontFamily="'Archivo Black', sans-serif" fontSize="24" fill="#fff">{m.label}</text>
            </g>
          </g>
        );
      })}
    </Frame>
  );
}

// ---- COMPARE: proportional horizontal bars for quantities (always-correct ratios) ------------------
function Compare({ spec, progress }) {
  const items = spec.items || [];
  const max = Math.max(...items.map((it) => Math.abs(it.value || 0)), 1);
  const L = 430, R = W - 220, topY = 260, rowH = Math.min(150, (H - 420) / Math.max(1, items.length));
  return (
    <Frame title={spec.title} note={spec.note}>
      {items.map((it, i) => {
        const y = topY + i * rowH, color = it.color || SERIES[i % SERIES.length];
        const full = (R - L) * (Math.abs(it.value || 0) / max);
        const w = full * clamp01((progress - i * 0.15) / 0.55);
        return (
          <g key={i} filter="url(#ig-soft)">
            <text x={L - 30} y={y + rowH * 0.42} textAnchor="end" fontFamily="'Archivo Black', sans-serif" fontSize="34" fill={INK}>{it.label}</text>
            <rect x={L} y={y} width={Math.max(0, w)} height={rowH * 0.5} rx={rowH * 0.12} fill={color} />
            {clamp01((progress - i * 0.15) / 0.55) > 0.5 ? (
              <text x={L + full + 22} y={y + rowH * 0.42} fontFamily="'Archivo Black', sans-serif" fontSize="32" fill={color}>{it.valueLabel || (commas(it.value) + (spec.unit ? ' ' + spec.unit : ''))}</text>
            ) : null}
            {it.note ? <text x={L} y={y + rowH * 0.78} fontFamily="Georgia, serif" fontStyle="italic" fontSize="26" fill="#6a553a">{it.note}</text> : null}
          </g>
        );
      })}
    </Frame>
  );
}

// Catmull-Rom → cubic-bezier smoothing for natural growth/decay curves (opt-in via spec.smooth).
function smoothPath(pts) {
  if (pts.length < 3) return 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  let d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// ---- LINE / AREA / PLOT: a quantity over a continuous axis — the math-viz curve (growth, decay, trends).
// spec: { title, note, xFrom, xTo, xLabel, yLabel, yUnit, xFromLabel, xToLabel, yMax, smooth, area,
//         series:[{label,color,valueLabel,points:[[x,y] | [x,y,'callout']]}], markers:[{at,label}] }.
// Reversed time works out of the box (set xFrom>xTo for "years ago" on the left). Draws left→right.
function Curve({ spec, progress, area }) {
  const series = spec.series || [];
  const allX = series.flatMap((s) => (s.points || []).map((p) => p[0]));
  const allY = series.flatMap((s) => (s.points || []).map((p) => p[1]));
  const xFrom = spec.xFrom != null ? spec.xFrom : Math.min(0, ...allX);
  const xTo = spec.xTo != null ? spec.xTo : Math.max(1, ...allX);
  const yMax = spec.yMax != null ? spec.yMax : Math.max(1, ...allY) * 1.1;
  const L = 250, R = W - 170, baseY = H - 250, topY = 250;
  const xS = (x) => L + ((x - xFrom) / ((xTo - xFrom) || 1)) * (R - L);
  const yS = (v) => baseY - (v / (yMax || 1)) * (baseY - topY);
  const revW = Math.max(0, clamp01(progress) * (R - L));
  const revealedX = L + revW;
  const yUnit = spec.yUnit ? ' ' + spec.yUnit : '';
  const grid = [0.25, 0.5, 0.75, 1];
  return (
    <Frame title={spec.title} note={spec.note}>
      <clipPath id="curveReveal"><rect x={L} y={topY - 30} width={revW} height={baseY - topY + 60} /></clipPath>
      {grid.map((g, i) => (
        <g key={'g' + i}>
          <line x1={L} y1={yS(g * yMax)} x2={R} y2={yS(g * yMax)} stroke={GRID} strokeWidth="1.5" strokeDasharray="2 8" />
          <text x={L - 18} y={yS(g * yMax) + 9} textAnchor="end" fontFamily="'Archivo Black', sans-serif" fontSize="24" fill="#6a553a">{commas(g * yMax) + yUnit}</text>
        </g>
      ))}
      <line x1={L} y1={baseY} x2={R} y2={baseY} stroke={INK} strokeWidth="3" />
      <line x1={L} y1={topY - 30} x2={L} y2={baseY} stroke={INK} strokeWidth="3" />
      <text x={L} y={baseY + 44} textAnchor="start" fontFamily="'Archivo Black', sans-serif" fontSize="26" fill={INK}>{spec.xFromLabel != null ? spec.xFromLabel : xFrom}</text>
      <text x={R} y={baseY + 44} textAnchor="end" fontFamily="'Archivo Black', sans-serif" fontSize="26" fill={INK}>{spec.xToLabel != null ? spec.xToLabel : xTo}</text>
      {spec.xLabel ? <text x={(L + R) / 2} y={baseY + 80} textAnchor="middle" fontFamily="Georgia, serif" fontSize="24" fill="#6a553a" letterSpacing="3">{spec.xLabel}</text> : null}
      {spec.yLabel ? <text x={L - 150} y={(topY + baseY) / 2} textAnchor="middle" fontFamily="Georgia, serif" fontSize="24" fill="#6a553a" letterSpacing="3" transform={`rotate(-90 ${L - 150} ${(topY + baseY) / 2})`}>{spec.yLabel}</text> : null}

      {/* legend (top-left of plot) — only when there's more than one series */}
      {(series.length > 1 ? series : []).map((s, i) => {
        const col = s.color || SERIES[i % SERIES.length];
        return (
          <g key={'lg' + i} transform={`translate(${L + 12 + i * 320},${topY - 8})`}>
            <line x1="0" y1="-6" x2="34" y2="-6" stroke={col} strokeWidth="7" strokeLinecap="round" />
            <text x="46" y="2" fontFamily="'Archivo Black', sans-serif" fontSize="26" fill={INK}>{s.label}</text>
          </g>
        );
      })}

      {/* event markers */}
      {(spec.markers || []).map((m, i) => {
        const mx = xS(m.at), on = clamp01((revealedX - mx) / 30);
        return (
          <g key={'mk' + i} opacity={on}>
            <line x1={mx} y1={topY - 10} x2={mx} y2={baseY} stroke="#c0392b" strokeWidth="2.5" strokeDasharray="3 7" />
            <text x={mx} y={topY - 20} textAnchor="middle" fontFamily="'Archivo Black', sans-serif" fontSize="22" fill="#c0392b">{m.label}</text>
          </g>
        );
      })}

      {/* series, revealed left→right */}
      <g clipPath="url(#curveReveal)">
        {series.map((s, i) => {
          const col = s.color || SERIES[i % SERIES.length];
          const pts = (s.points || []).map((p) => [xS(p[0]), yS(p[1])]);
          if (pts.length < 2) return null;
          const d = spec.smooth ? smoothPath(pts) : 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
          const areaD = d + ` L${pts[pts.length - 1][0].toFixed(1)},${baseY} L${pts[0][0].toFixed(1)},${baseY} Z`;
          return (
            <g key={'s' + i}>
              {area ? <path d={areaD} fill={col} fillOpacity="0.16" /> : null}
              <path d={d} fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="9" strokeLinejoin="round" strokeLinecap="round" />
              <path d={d} fill="none" stroke={col} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
      </g>

      {/* per-point annotations: a point [x, y, 'callout'] gets a dot + label, revealed as the curve passes it */}
      {series.map((s, i) => {
        const col = s.color || SERIES[i % SERIES.length];
        return (s.points || []).map((pt, j) => {
          if (pt[2] == null || pt[2] === '') return null;
          const px = xS(pt[0]), py = yS(pt[1]), on = clamp01((revealedX - px) / 30), above = py > topY + 70;
          return (
            <g key={'an' + i + '_' + j} opacity={on} filter="url(#ig-soft)">
              <circle cx={px} cy={py} r="8" fill={col} stroke="#fff" strokeWidth="3" />
              <text x={px} y={above ? py - 18 : py + 36} textAnchor="middle" fontFamily="'Archivo Black', sans-serif" fontSize="26" fill={col}>{pt[2]}</text>
            </g>
          );
        });
      })}

      {/* end value readout (for series.valueLabel, when the last point isn't already annotated) */}
      {series.map((s, i) => {
        const col = s.color || SERIES[i % SERIES.length], pts = s.points || [];
        if (!pts.length || !s.valueLabel) return null;
        const last = pts[pts.length - 1];
        if (last[2] != null && last[2] !== '') return null;   // already shown by an annotation
        const px = xS(last[0]), py = yS(last[1]), on = clamp01((progress - 0.82) / 0.18);
        return (
          <g key={'e' + i} opacity={on} filter="url(#ig-soft)">
            <circle cx={px} cy={py} r="9" fill={col} stroke="#fff" strokeWidth="3" />
            <text x={px - 14} y={py - 16} textAnchor="end" fontFamily="'Archivo Black', sans-serif" fontSize="30" fill={col}>{s.valueLabel || commas(last[1])}</text>
          </g>
        );
      })}
    </Frame>
  );
}

export const InfographicStill = ({ type = 'timeline', progress = 1, ...spec }) => {
  const p = progress >= 0.999 ? 1 : progress;
  if (type === 'compare' || type === 'bars') return <Compare spec={spec} progress={p} />;
  if (type === 'line' || type === 'area' || type === 'plot' || type === 'curve') return <Curve spec={spec} progress={p} area={type === 'area' || ((type === 'plot' || type === 'curve') && !!spec.area)} />;
  return <Timeline spec={spec} progress={p} />;
};
