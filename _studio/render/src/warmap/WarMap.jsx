// War-map mode. Phase 1: geographic BASE (parchment theme, land, borders, rivers, lakes) +
// chrome (legend, title/date). Phase 2: the MILITARY LAYER — territory control, front lines, pockets,
// broad attack arrows, and de-collided cartoon unit tokens (the warmed Field Counter). Delegated to
// from Map.jsx when map.theme === 'war'; the legacy atlas path is untouched. Deterministic + free.
import { AbsoluteFill } from 'remotion';
import { geoNaturalEarth1, geoMercator, geoPath, geoBounds } from 'd3-geo';
import { feature } from 'topojson-client';
import land50topo from 'world-atlas/land-50m.json';
import land110topo from 'world-atlas/land-110m.json';
import countries50topo from 'world-atlas/countries-50m.json';
import riversGeo from '../geo/rivers-50m.json';
import lakesGeo from '../geo/lakes-50m.json';
import { coordOf } from '../gazetteer.mjs';
import { themeOf, SIDE_FALLBACK } from './theme.mjs';
import { renderUnits } from './Tokens.jsx';
import { territorySvg, pocketSvg, frontSvg, arrowsSvg, counterChipSvg, strengthBarsSvg, strengthPanelH } from './layers.jsx';
import { ARCHIVO_BLACK } from '../fonts.mjs';

const W = 1920, H = 1080;
const land50 = feature(land50topo, land50topo.objects.land);
const land110 = feature(land110topo, land110topo.objects.land);
const countries50 = feature(countries50topo, countries50topo.objects.countries);

function overlaps(b, f) {
  let fb; try { fb = geoBounds(f); } catch (_) { return true; }
  if (!fb || !isFinite(fb[0][0])) return true;
  return !(fb[1][0] < b[0][0] || fb[0][0] > b[1][0] || fb[1][1] < b[0][1] || fb[0][1] > b[1][1]);
}

export function WarMapStill(props) {
  const { focus = [[0, 0]], zoom = 'strategic', sides = {}, territory = [], fronts = [], pockets = [],
    units = [], arrows = [], counters = [], strengthBars = [], title = '', date = '', phase = '', legend = false, labels = [], padding = 150 } = props || {};
  const TH = themeOf('war');
  const sideKeys = Object.keys(sides);
  const sideColor = (k) => (sides[k] && sides[k].color) || SIDE_FALLBACK[Math.max(0, sideKeys.indexOf(k)) % SIDE_FALLBACK.length] || TH.accent;

  const focusPts = focus.map(coordOf).filter(Boolean);
  const proj = (zoom === 'operational' ? geoMercator() : geoNaturalEarth1());   // C4
  proj.fitExtent([[padding, padding], [W - padding, H - padding]], { type: 'MultiPoint', coordinates: focusPts.length ? focusPts : [[0, 0]] });
  const path = geoPath(proj);
  const land = zoom === 'operational' ? land50 : land110;

  // clip borders/rivers/lakes to the visible frame (C5)
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map((p) => proj.invert(p)).filter(Boolean);
  let frameB = null;
  if (corners.length === 4) {
    const lngs = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);
    const dLng = (Math.max(...lngs) - Math.min(...lngs)) * 0.12, dLat = (Math.max(...lats) - Math.min(...lats)) * 0.12;
    frameB = [[Math.min(...lngs) - dLng, Math.min(...lats) - dLat], [Math.max(...lngs) + dLng, Math.max(...lats) + dLat]];
  }
  const clip = (fc) => (frameB ? (fc.features || []).filter((f) => overlaps(frameB, f)) : (fc.features || []));
  const borderD = path({ type: 'FeatureCollection', features: clip(countries50) });
  const riverFeats = clip(riversGeo);
  const lakeD = path({ type: 'FeatureCollection', features: clip(lakesGeo) });

  // military layer (strings) + de-collided unit tokens
  const territoryHtml = territorySvg(territory, proj, sideColor);
  const pocketHtml = pocketSvg(pockets, proj, sideColor);
  const frontHtml = frontSvg(fronts, proj, TH.accent);
  const arrowHtml = arrowsSvg(arrows, proj, sideColor);
  const unitOut = renderUnits(units, proj, { scale: 1, sideColor, safe: { x0: 70, y0: 190, x1: W - 70, y1: H - 70 } });

  const sideEntries = Object.entries(sides || {});

  return (
    <AbsoluteFill style={{ backgroundColor: TH.sea }}>
      <style>{`@font-face{font-family:'Archivo Black';src:url(${ARCHIVO_BLACK}) format('truetype');font-display:block;}`}</style>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <radialGradient id="wsea" cx="50%" cy="42%" r="80%"><stop offset="0%" stopColor={TH.seaGrad[0]} /><stop offset="100%" stopColor={TH.seaGrad[1]} /></radialGradient>
          <radialGradient id="wvig" cx="50%" cy="50%" r="74%"><stop offset="60%" stopColor="#1d140a" stopOpacity="0" /><stop offset="100%" stopColor="#1d140a" stopOpacity="0.20" /></radialGradient>
          <filter id="wlandsh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#3a2c18" floodOpacity="0.28" /></filter>
          {/* hand-drawn edge for unit tokens (the "warming") */}
          <filter id="tokRough" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.014" numOctaves="2" seed="5" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G" /></filter>
        </defs>

        <rect x="0" y="0" width={W} height={H} fill="url(#wsea)" />
        <g filter="url(#wlandsh)"><path d={path(land)} fill={TH.land} stroke={TH.landStroke} strokeWidth="1.6" strokeLinejoin="round" /></g>

        {/* control: territory fills + encircled pockets (under borders/rivers so geography shows through) */}
        {territoryHtml ? <g dangerouslySetInnerHTML={{ __html: territoryHtml }} /> : null}
        {pocketHtml ? <g dangerouslySetInnerHTML={{ __html: pocketHtml }} /> : null}

        {/* borders (faint reference — NOT control), lakes, rivers */}
        {borderD ? <path d={borderD} fill="none" stroke={TH.border} strokeWidth="1.5" strokeOpacity="0.5" strokeDasharray="5 6" strokeLinejoin="round" /> : null}
        {lakeD ? <path d={lakeD} fill={TH.lake} stroke={TH.river} strokeWidth="1" /> : null}
        {riverFeats.map((f, i) => <path key={'rv' + i} d={path(f)} fill="none" stroke={TH.river} strokeWidth="2.2" strokeOpacity="0.85" strokeLinecap="round" strokeLinejoin="round" />)}

        {/* fronts + attack arrows */}
        {frontHtml ? <g dangerouslySetInnerHTML={{ __html: frontHtml }} /> : null}
        {arrowHtml ? <g dangerouslySetInnerHTML={{ __html: arrowHtml }} /> : null}

        {/* leader lines for nudged tokens, then the tokens */}
        {unitOut.leaders.map((l, i) => <line key={'ld' + i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth="3" strokeOpacity="0.7" />)}
        {unitOut.leaders.map((l, i) => <circle key={'la' + i} cx={l.x1} cy={l.y1} r="6" fill={l.color} stroke={TH.casing} strokeWidth="2.5" />)}
        {unitOut.svgs.map((s, i) => <g key={'u' + i} dangerouslySetInnerHTML={{ __html: s }} />)}

        {/* place labels (simple; full de-collision shares placeBoxes in a later pass) */}
        {labels.map((l, i) => {
          const c = coordOf(l.coord != null ? l.coord : l); if (!c) return null;
          const p = proj(c); if (!p) return null;
          return (
            <g key={'lb' + i}>
              <circle cx={p[0]} cy={p[1]} r="5" fill={TH.ink} stroke={TH.casing} strokeWidth="2" />
              <text x={p[0] + 12} y={p[1] + 6} fontFamily="Georgia, serif" fontSize={l.size || 30} fontWeight="600" fill={TH.ink} stroke={TH.casing} strokeWidth="4" paintOrder="stroke" letterSpacing="1">{l.text}</text>
            </g>
          );
        })}

        <rect x="0" y="0" width={W} height={H} fill="url(#wvig)" />

        {(title || date || phase) ? (
          <g transform="translate(44,44)">
            <rect width="470" height={phase ? 120 : 92} rx="12" fill={TH.ink} />
            <text x="28" y="62" fontFamily="'Archivo Black',Arial Black,sans-serif" fontSize="52" fontWeight="900" fill={TH.casing}>{(title || '').toUpperCase()}</text>
            {(date || phase) ? <text x="28" y="98" fontFamily="sans-serif" fontSize="24" fontWeight="700" fill={TH.accent} letterSpacing="2">{[date, phase].filter(Boolean).join(' · ').toUpperCase()}</text> : null}
          </g>
        ) : null}

        {legend && sideEntries.length ? (
          <g transform={`translate(44,${H - 56 - sideEntries.length * 46})`}>
            <rect width="430" height={sideEntries.length * 46 + 28} rx="12" fill={TH.casing} stroke={TH.ink} strokeWidth="3" />
            {sideEntries.map(([k, v], i) => (
              <g key={k} transform={`translate(24,${22 + i * 46})`}>
                <rect width="40" height="26" rx="5" fill={sideColor(k)} stroke={TH.ink} strokeWidth="2" />
                <text x="58" y="21" fontFamily="sans-serif" fontSize="26" fontWeight="700" fill={TH.ink}>{(v && v.label) || k}</text>
              </g>
            ))}
          </g>
        ) : null}

        {/* on-map data: casualty/strength counters (top-right, stacked) + strength bars (bottom-right) */}
        {counters.map((c, i) => (
          <g key={'ct' + i} dangerouslySetInnerHTML={{ __html: counterChipSvg({ x: W - 470, y: 44 + i * 110, label: c.label, value: c.value, color: sideColor(c.side) }) }} />
        ))}
        {strengthBars.length ? (
          <g dangerouslySetInnerHTML={{ __html: strengthBarsSvg({ x: W - 484, y: H - 44 - strengthPanelH(strengthBars.length), bars: strengthBars, sideColor, sides }) }} />
        ) : null}
      </svg>
    </AbsoluteFill>
  );
}
