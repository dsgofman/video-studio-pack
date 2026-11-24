import { AbsoluteFill, Sequence, Img, Audio, OffthreadVideo, useCurrentFrame, useVideoConfig, interpolate, spring, staticFile, Easing } from 'remotion';
import { MapStill } from './Map.jsx';
import { InfographicStill } from './Infographic.jsx';
import { PERMANENT_MARKER, ARCHIVO_BLACK, GLORIA_HALLELUJAH, PATRICK_HAND, KALAM_BOLD, BANGERS } from './fonts.mjs';

const CREAM = '#fff7ec', ACCENT = '#e07a3c', INK = '#221a10';
const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);   // deterministic 0..1 (no Math.random → renders identically each pass)

// Caption font registry — key (stored in caption-style.json) -> @font-face family name.
const CAP_FONTS = { gloria: 'Gloria', marker: 'Marker', patrick: 'Patrick', kalam: 'Kalam', bangers: 'Bangers', archivo: 'Archivo Black' };
const CAP_DEFAULT = { font: 'gloria', color: '#fffdf7', accent: '#f0883c', size: 70, case: 'sentence', treatment: 'shadow', tilt: true };
// Sans key that actually HAS a bold weight (so the emph token can bold); handwriting fonts don't,
// so for those the emphasis reads via accent color + a subtle scale + glow instead.
const BOLD_FONTS = new Set(['archivo']);

// Per-kind entrance choreography — motion as grammar. `startY` (px, +down/-up) is where the cue
// slides in FROM; `fromScale` is the pop-in scale floor; `spring` tunes the settle (low damping =
// a little overshoot/bounce); `stagger` = frames between successive WORDS (word-by-word write-on);
// `underline` sweeps a hand-underline under the line. All frame/seed-driven → renders identically.
const ENTRANCE = {
  label:  { startY: -18, fromScale: 1.0,  spring: { damping: 11, stiffness: 175, mass: 0.7 }, stagger: 2, underline: false },   // name-tag drops in from above
  stat:   { startY: 0,   fromScale: 0.82, spring: { damping: 12, stiffness: 210, mass: 0.6 }, stagger: 0, underline: false },   // firm pop; number counts up
  reveal: { startY: 22,  fromScale: 0.9,  spring: { damping: 14, stiffness: 150, mass: 0.85 }, stagger: 2, underline: true },   // rises up, hand-underline sweeps on
  build:  { startY: 16,  fromScale: 0.95, spring: { damping: 13, stiffness: 195, mass: 0.6 }, stagger: 0, underline: false },   // slides UP into its stack slot
  marker: { startY: 12,  fromScale: 0.84, spring: { damping: 10, stiffness: 225, mass: 0.6 }, stagger: 1.5, underline: false }, // scripted hook — lands hard
};

// Normalize a word for emphasis matching: lowercase, strip non-alphanumeric, drop a trailing
// possessive/plural 's' (chin ↔ chins) so we match the intended token WITHOUT the old substring
// over-match ("art" no longer lights up "part"/"start").
const emphNorm = (w) => {
  let b = String(w || '').toLowerCase().replace(/[^a-z0-9%]/g, '');
  b = b.replace(/'s$/, '');
  if (b.length > 3 && b.endsWith('s')) b = b.slice(0, -1);
  return b;
};
// emph may be a multi-word phrase → a Set of normalized tokens; a word is emphasized if it's one.
function emphSet(emph) {
  const s = new Set();
  for (const tok of String(emph || '').split(/\s+/)) { const b = emphNorm(tok); if (b) s.add(b); }
  return s;
}

// Embedded fonts (base64 data URLs) — no network, no webpack font config needed.
export const FontFaces = () => (
  <style>{`
    @font-face { font-family: 'Marker'; src: url('${PERMANENT_MARKER}') format('truetype'); }
    @font-face { font-family: 'Archivo Black'; src: url('${ARCHIVO_BLACK}') format('truetype'); }
    @font-face { font-family: 'Gloria'; src: url('${GLORIA_HALLELUJAH}') format('truetype'); }
    @font-face { font-family: 'Patrick'; src: url('${PATRICK_HAND}') format('truetype'); }
    @font-face { font-family: 'Kalam'; src: url('${KALAM_BOLD}') format('truetype'); }
    @font-face { font-family: 'Bangers'; src: url('${BANGERS}') format('truetype'); }
    .cap-firstcap::first-letter { text-transform: uppercase; }
  `}</style>
);

// ---- Ken Burns with variety: origin cycles per beat, intensity scales with hold length ----
const ORIGINS = ['50% 42%', '42% 50%', '58% 46%', '50% 58%', '46% 38%', '56% 56%'];
function motionStyle(motion, frame, dur, seed) {
  const p = dur > 1 ? Math.min(1, frame / dur) : 0;
  const e = Easing.out(Easing.quad)(p);                     // settle into the move
  const deep = dur < 105 ? 0.10 : dur < 240 ? 0.08 : 0.06;  // short beat = punchier move
  let scale = 1.025 + 0.012 * e, x = 0, y = 0;              // 'static' still drifts a hair so it's not dead
  if (motion === 'push-in') scale = 1.0 + deep * e;
  else if (motion === 'push-out') scale = (1.0 + deep) - deep * e;
  else if (motion === 'pan-left') { scale = 1.0 + deep; x = interpolate(e, [0, 1], [2.2, -2.2]); }
  else if (motion === 'pan-right') { scale = 1.0 + deep; x = interpolate(e, [0, 1], [-2.2, 2.2]); }
  // Continuous micro-"breathing" layered over the Ken Burns move: a slow, phase-varied sine ripple so a
  // settled/held frame is NEVER dead-still — the fix for the "static stills + popping captions" feel.
  // Deliberately tiny (~±0.4% scale, ~±0.18% drift over 5-7s) → reads as life, not motion-sickness. The
  // translate stays well inside the ≥2.5% overscan, so no edge is ever exposed.
  const ph = seed * 0.7;
  scale += 0.004 * Math.sin((frame / 196 + ph) * TAU);
  x += 0.18 * Math.sin((frame / 150 + ph * 0.4) * TAU);
  y += 0.14 * Math.sin((frame / 132 + ph * 1.15) * TAU);
  return { transform: `scale(${scale}) translate(${x}%, ${y}%)`, transformOrigin: ORIGINS[seed % ORIGINS.length] };
}

// ---- Opt-in ambient particle layer: a subtle, content-motivated drifting field (firelit → embers,
// cold → snow, the mushroom video → spores). Per-beat via scene.ambientFx; default off so it's never
// overkill. Deterministic (index-hashed positions + frame-driven drift, wrapped) → identical each render.
const AMBIENT = {
  embers: { count: 22, color: '#ffb15a', size: [3, 8], dir: 'up', speed: 0.55, sway: 26, glow: 9, op: [0.22, 0.7] },
  spores: { count: 20, color: '#eaf7d0', size: [3, 7], dir: 'up', speed: 0.30, sway: 30, glow: 8, op: [0.18, 0.55] },
  pollen: { count: 20, color: '#f3ecc4', size: [3, 7], dir: 'up', speed: 0.30, sway: 28, glow: 7, op: [0.18, 0.5] },
  dust: { count: 18, color: '#fff4e0', size: [2, 5], dir: 'drift', speed: 0.18, sway: 18, glow: 3, op: [0.08, 0.3] },
  snow: { count: 26, color: '#ffffff', size: [3, 7], dir: 'down', speed: 0.7, sway: 34, glow: 3, op: [0.4, 0.85] },
  rain: { count: 30, color: '#bcd6e8', size: [2, 3], dir: 'down', speed: 2.4, sway: 5, glow: 0, op: [0.16, 0.4], streak: 17 },
};
function Ambient({ kind }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cfg = AMBIENT[kind];
  if (!cfg) return null;
  const items = [];
  for (let i = 0; i < cfg.count; i++) {
    const h1 = frac(Math.sin(i * 12.9898) * 43758.5453);
    const h2 = frac(Math.sin(i * 78.233) * 12543.123);
    const h3 = frac(Math.sin(i * 39.425) * 9123.77);
    const sz = cfg.size[0] + h2 * (cfg.size[1] - cfg.size[0]);
    const speed = cfg.speed * (0.6 + h3 * 0.8);
    let x, y;
    if (cfg.dir === 'drift') {
      x = frac(h1 + (frame * speed) / width * 0.3) * width + Math.sin(frame / 70 + i) * cfg.sway;
      y = frac(h2 + (frame * speed) / height * 0.4) * height;
    } else {
      const t = frac(h1 + (frame * speed) / height);   // 0..1 along the travel axis, wraps
      y = (cfg.dir === 'down' ? t : 1 - t) * (height + 40) - 20;
      x = h1 * width + Math.sin(frame / 60 * (0.6 + h2) + i) * cfg.sway;
    }
    const flick = cfg.op[0] + (cfg.op[1] - cfg.op[0]) * (0.5 + 0.5 * Math.sin(frame / 22 + i * 1.7));
    items.push(<div key={i} style={{
      position: 'absolute', left: x, top: y, width: cfg.streak ? cfg.size[0] : sz, height: cfg.streak || sz,
      borderRadius: cfg.streak ? 1 : '50%', background: cfg.color, opacity: flick,
      filter: cfg.glow ? `blur(${(cfg.glow * 0.18).toFixed(2)}px)` : 'none',
      boxShadow: cfg.glow ? `0 0 ${cfg.glow}px ${cfg.color}` : 'none',
    }} />);
  }
  return <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen' }}>{items}</AbsoluteFill>;
}

// All of a beat's stills stacked with TRUE crossfades between them (no dip to black between frames).
function SubImages({ images, motion, dur, seed }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vert = height > width;                              // Shorts/vertical: fit the WHOLE 16:9 frame (no side crop)
  const n = images.length;
  const sub = Math.max(1, Math.floor(dur / n));
  const XF = Math.min(10, Math.floor(sub / 3));             // crossfade length between sub-images
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
      {images.map((src, i) => {
        const start = i * sub;
        const end = i === n - 1 ? dur : (i + 1) * sub;
        const fadeIn = i === 0 ? 1 : interpolate(frame, [start, start + XF], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        if (frame < start - 1) return null;                  // not yet (later image covers earlier ones once on)
        const local = Math.max(0, frame - start);
        const mo = motionStyle(motion, local, Math.max(1, end - start), seed + i);
        if (vert) {
          // Fit the entire landscape frame to width (nothing cropped) over a blurred fill of itself.
          return (
            <AbsoluteFill key={i} style={{ opacity: fadeIn }}>
              <Img src={staticFile(src)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(30px) brightness(0.45)', transform: 'scale(1.2)' }} />
              <Img src={staticFile(src)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', ...mo }} />
            </AbsoluteFill>
          );
        }
        return (
          <Img key={i} src={staticFile(src)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: fadeIn, ...mo }} />
        );
      })}
    </AbsoluteFill>
  );
}

// Accurate map beat rendered LIVE: the route draws itself across the map as the narration plays.
// motion:'static' holds the camera dead-steady (the route draw-on IS the motion) — used for route
// sequences so consecutive map beats don't zoom-bounce and read as one continuous map.
function MapBeat({ spec, dur, motion }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const p = Math.min(1, frame / Math.max(1, dur - 8));
  const zoom = motion === 'static' ? 1.0 : 1.0 + 0.035 * Easing.inOut(Easing.ease)(p);   // gentle push, or steady hold
  // The map engine draws a fixed 1920x1080 canvas. Landscape: scale to cover (no-op at 1920x1080).
  // Vertical (Shorts): scale to CONTAIN so the whole map — including edge labels — fits the width,
  // framed on a dark backdrop instead of cropping the sides off.
  const vert = height > width;
  const fit = vert ? Math.min(width / 1920, height / 1080) : Math.max(width / 1920, height / 1080);
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: vert ? '#13242c' : 'transparent' }}>
      <div style={{ position: 'absolute', left: (width - 1920) / 2, top: (height - 1080) / 2, width: 1920, height: 1080, transform: `scale(${fit})` }}>
        <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: '50% 46%' }}>
          <MapStill {...spec} labelStyle={spec.labelStyle || 'serif'} progress={p >= 0.999 ? 0.9999 : p} />
        </AbsoluteFill>
      </div>
    </AbsoluteFill>
  );
}

// Deterministic infographic beat (timeline / comparison / chart) — rendered LIVE from structured data,
// so labels + proportions are always correct. Cover-scaled like MapBeat for vertical/Shorts frames.
function InfographicBeat({ spec, dur, motion }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const p = Math.min(1, frame / Math.max(1, dur - 8));
  const zoom = motion === 'static' ? 1.0 : 1.0 + 0.02 * Easing.inOut(Easing.ease)(p);
  // Vertical (Shorts): contain so the whole chart fits the width; parchment backdrop is seamless with
  // the infographic's own background (looks like extra margin, not a crop).
  const vert = height > width;
  const fit = vert ? Math.min(width / 1920, height / 1080) : Math.max(width / 1920, height / 1080);
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: vert ? '#f3e9d2' : 'transparent' }}>
      <div style={{ position: 'absolute', left: (width - 1920) / 2, top: (height - 1080) / 2, width: 1920, height: 1080, transform: `scale(${fit})` }}>
        <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: '50% 50%' }}>
          <InfographicStill {...spec} progress={p >= 0.999 ? 0.9999 : p} />
        </AbsoluteFill>
      </div>
    </AbsoluteFill>
  );
}

// A REAL artifact photo (from Pexels) rendered as a field-guide "specimen plate": the photo under a cream
// frame + vignette with a handwritten "the actual ___" tag, Ken Burns + breathing. The deliberate framing
// reads as "here's the real thing" against the cartoon, without diluting the animated identity.
export function RealPhotoBeat({ photo, dur, seed }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vert = height > width;
  const mo = motionStyle('push-in', frame, dur, seed);
  const label = (photo.label || '').trim();
  const media = photo.video
    // a REAL artifact/site clip (Pexels video): muted (the beat's narration is a separate <Audio>),
    // looped so a short clip covers a longer beat. Keep the same subtle push-in so it matches the
    // stills' Ken Burns, and the same field-guide colour grade so a real clip reads as a "specimen".
    ? <OffthreadVideo src={staticFile(photo.src)} muted loop style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', ...mo, filter: 'saturate(0.93) contrast(1.02)' }} />
    : <Img src={staticFile(photo.src)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', ...mo, filter: 'saturate(0.93) contrast(1.02)' }} />;
  return (
    <AbsoluteFill style={{ backgroundColor: '#17110a', overflow: 'hidden' }}>
      {media}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 56%, rgba(8,6,3,0.36) 100%)', pointerEvents: 'none' }} />
      <AbsoluteFill style={{ border: `${vert ? 10 : 15}px solid ${CREAM}`, boxShadow: 'inset 0 0 0 2px rgba(34,26,16,0.5)', opacity: 0.92, pointerEvents: 'none' }} />
      {label ? (
        <div style={{ position: 'absolute', left: vert ? 26 : 42, bottom: vert ? '15%' : 42, background: 'rgba(18,14,10,0.82)', borderRadius: 10, padding: '6px 16px 9px', transform: 'rotate(-1.4deg)', boxShadow: '0 6px 18px rgba(0,0,0,0.42)' }}>
          <span style={{ fontFamily: "'Gloria', cursive", color: CREAM, fontSize: vert ? 34 : 30, letterSpacing: 0.3 }}>{label}{photo.video ? '  ▶' : ''}</span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

// A Veo motion clip = the ANIMATED version of a beat. Plays full-bleed, muted (the beat's narration is a
// separate <Audio>), looped so a short ~6s clip still covers a longer beat.
function VideoBeat({ clip }) {
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      <OffthreadVideo src={staticFile(clip.src)} muted loop style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
    </AbsoluteFill>
  );
}

export function Caption({ caption, dur, cstyle }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const vert = height > width;   // Shorts: image is fit-to-width (centered) with blurred bands top/bottom
  if (!caption || !caption.text) return null;
  const cs = { ...CAP_DEFAULT, ...(cstyle || {}) };
  const { text, pos, anim, raw } = caption;   // raw = a Shorts overlay: render its case exactly as written (don't sentence-case a punchy hook)
  let opacity = 1, scale = 1, shown = text;
  if (anim === 'fade') opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  else if (anim === 'punch') {
    scale = spring({ frame, fps, config: { damping: 12, stiffness: 200, mass: 0.6 } });
    opacity = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: 'clamp' });
  } else if (anim === 'type') {
    const n = Math.floor(interpolate(frame, [0, Math.min(dur, text.length * 1.5)], [0, text.length], { extrapolateRight: 'clamp' }));
    shown = text.slice(0, n);
  }
  // Vertical/Shorts: nudge captions off the extreme edges so they sit cleanly inside the blurred bands.
  const place = pos === 'center' ? { top: '50%', transform: 'translateY(-50%)' }
    : pos === 'lower-third' ? { bottom: vert ? '20%' : '9%' } : { top: vert ? '13%' : '7%' };
  const fam = `'${CAP_FONTS[cs.font] || 'Gloria'}', cursive`;
  // case: sentence = lowercase + ::first-letter cap (handwriting reads better mixed-case); a raw Shorts
  // overlay keeps its exact case so a punchy ALL-CAPS hook (and acronyms like DNA) stay intact.
  const tc = raw ? 'none' : cs.case === 'upper' ? 'uppercase' : (cs.case === 'lower' || cs.case === 'sentence') ? 'lowercase' : 'none';
  const firstCap = (!raw && cs.case === 'sentence') ? 'cap-firstcap' : '';
  let deco;
  if (cs.treatment === 'outline') deco = { WebkitTextStroke: '1px rgba(10,7,4,0.6)', textShadow: '0 2px 13px rgba(0,0,0,0.6)' };
  else if (cs.treatment === 'plate') deco = { background: 'rgba(18,14,10,0.84)', borderRadius: 16, padding: '4px 22px 8px', boxShadow: '0 8px 22px rgba(0,0,0,0.4)' };
  else deco = { textShadow: '0 0 6px rgba(10,7,4,0.85), 0 3px 14px rgba(0,0,0,0.55)' };   // soft halo + drop
  const tilt = cs.tilt ? ' rotate(-1.6deg)' : '';
  // punch (Shorts hook — the highest-value moment): reveal word-by-word (~2f apart) so the hook
  // WRITES ON in sync with the read, matching the main-video cues. The spring still pops the whole
  // line. fade/type keep their existing single-block behavior.
  const staggerOn = anim === 'punch';
  let wi = -1;
  const content = anim === 'type' ? shown : text.split(/(\s+)/).map((tok, i) => {
    if (/^\s+$/.test(tok)) return <span key={i}>{tok}</span>;
    wi++;
    const o = staggerOn ? interpolate(frame - wi * 2, [0, 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
    return <span key={i} style={{ opacity: o }}>{tok}</span>;
  });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', ...place }}>
        <span className={firstCap} style={{
          display: 'inline-block', transform: `scale(${scale})${tilt}`, opacity: staggerOn ? 1 : opacity, maxWidth: vert ? '88%' : '82%',
          color: cs.color || '#fffdf7', fontFamily: fam, fontSize: (cs.size || 54) * (vert ? 1.4 : 1),   // bigger for mobile/Shorts
          textTransform: tc, letterSpacing: 0.3, lineHeight: 1.24, ...deco,
        }}>{content}</span>
      </div>
    </AbsoluteFill>
  );
}

// Count the first number in a stat cue UP to its value over prog (0..1), preserving commas/decimals/% and
// accenting the figure. Returns an array of spans, or null if the cue has no number to animate.
function statParts(text, accent, prog) {
  const m = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const raw = m[0];
  const target = parseFloat(raw.replace(/,/g, ''));
  if (!isFinite(target)) return null;
  const decimals = (raw.split('.')[1] || '').length;
  const cur = decimals ? +(target * prog).toFixed(decimals) : Math.round(target * prog);
  const shown = raw.includes(',') ? cur.toLocaleString('en-US', { maximumFractionDigits: decimals })
    : (decimals ? cur.toFixed(decimals) : String(cur));
  return [
    text.slice(0, m.index) ? <span key="b">{text.slice(0, m.index)}</span> : null,
    <span key="n" style={{ color: accent, fontWeight: 700 }}>{shown}</span>,
    text.slice(m.index + raw.length) ? <span key="a">{text.slice(m.index + raw.length)}</span> : null,
  ];
}
function CueText({ c, frame, fps, vert, cs, fam }) {
  const local = frame - c.startFrame;
  const E = ENTRANCE[c.kind] || ENTRANCE.label;
  // Entrance progress via a per-kind spring (0→1, may overshoot 1 slightly for a settle/bounce).
  const ent = spring({ frame: Math.max(0, local), fps, config: E.spring });
  const outA = interpolate(frame, [c.endFrame - 8, c.endFrame], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dim = frame >= c.brightUntil ? 0.55 : 1;
  // slide in FROM startY → 0, pop from fromScale → 1, and on exit drift gently DOWN (settle-out, not blink-off)
  const slideY = (1 - ent) * E.startY;
  const exitY = interpolate(frame, [c.endFrame - 8, c.endFrame], [0, 7], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const scale = E.fromScale + (1 - E.fromScale) * ent;
  // vertical placement: base by pos; build groups stack downward, centered on their anchor row
  const lineH = (cs.size || 54) * (vert ? 1.4 : 1) * 1.3;
  const stackShift = c.groupSize > 1 ? (c.stackIndex - (c.groupSize - 1) / 2) * lineH : 0;
  const base = c.pos === 'center' ? { top: '50%', mt: -lineH / 2 }
    : c.pos === 'lower-third' ? { bottom: vert ? '20%' : '9%', mt: 0 } : { top: vert ? '13%' : '7%', mt: 0 };
  const fontSize = (cs.size || 54) * (vert ? 1.4 : 1) * (c.kind === 'reveal' ? 1.18 : 1);
  let deco;
  if (cs.treatment === 'outline') deco = { WebkitTextStroke: '1px rgba(10,7,4,0.6)', textShadow: '0 2px 13px rgba(0,0,0,0.6)' };
  else if (cs.treatment === 'plate') deco = { background: 'rgba(18,14,10,0.84)', borderRadius: 16, padding: '4px 22px 8px', boxShadow: '0 8px 22px rgba(0,0,0,0.4)' };
  else deco = { textShadow: '0 0 6px rgba(10,7,4,0.85), 0 3px 14px rgba(0,0,0,0.55)' };
  const accent = cs.accent || '#ffd23f';
  const canBold = BOLD_FONTS.has(cs.font);
  // emphasis token style: accent color always; bold ONLY if the font has a bold weight, else a
  // subtle scale + glow so the emphasis is visible in handwriting fonts too.
  const emphStyle = { color: accent, textTransform: 'uppercase',
    ...(canBold ? { fontWeight: 700 } : { display: 'inline-block', transform: 'scale(1.07)', textShadow: `0 0 10px ${accent}66` }) };
  // word-by-word fade: each successive word enters `stagger` frames after the previous (write-on).
  const wordFade = (idx) => interpolate(local - idx * E.stagger, [0, 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // stat cues: count the number UP to value as the cue enters (the figure is the hero + carries the accent).
  const statP = (c.kind === 'stat') ? statParts(c.text, accent, interpolate(local, [0, 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })) : null;
  let parts;
  if (statP) {
    parts = <span style={{ opacity: wordFade(0) }}>{statP}</span>;   // whole stat appears together; count-up IS the motion
  } else {
    const es = emphSet(c.emph);
    let wi = -1;                                    // word index (spaces don't advance it → they don't stagger)
    parts = c.text.split(/(\s+)/).map((tok, i) => {
      if (/^\s+$/.test(tok)) return <span key={i}>{tok}</span>;
      wi++;
      const isEmph = es.has(emphNorm(tok));
      return <span key={i} style={{ opacity: wordFade(wi), ...(isEmph ? emphStyle : null) }}>{tok}</span>;
    });
  }
  const placeStyle = base.top != null ? { top: base.top } : { bottom: base.bottom };
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', ...placeStyle, transform: `translateY(${(base.mt || 0) + stackShift + slideY + exitY}px)` }}>
      <span style={{
        position: 'relative', display: 'inline-block', transform: `scale(${scale})`, opacity: outA * dim, maxWidth: vert ? '88%' : '82%',
        color: cs.color || '#fffdf7', fontFamily: fam, fontSize, letterSpacing: 0.3, lineHeight: 1.24, ...deco,
      }}>
        {parts}
        {E.underline ? (
          // hand-underline that sweeps left→right under the reveal (whiteboard flourish, auto-matches
          // text width since it's a child of the inline-block text span). Slight tilt = drawn-by-hand feel.
          <div style={{ position: 'absolute', left: 0, bottom: cs.treatment === 'plate' ? 2 : -4,
            height: Math.max(3, fontSize * 0.07), width: interpolate(local, [4, 16], [0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) + '%',
            background: accent, borderRadius: 4, transform: 'rotate(-0.6deg)', transformOrigin: 'left center', opacity: 0.9 }} />
        ) : null}
      </span>
    </div>
  );
}
export function Cues({ cues, cstyle }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const vert = height > width;
  if (!cues || !cues.length) return null;
  const cs = { ...CAP_DEFAULT, ...(cstyle || {}) };
  const fam = `'${CAP_FONTS[cs.font] || 'Gloria'}', cursive`;
  const active = cues.filter((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!active.length) return null;
  // Auto-separate overlapping cues: two non-build cues at the SAME screen position would stack on top
  // of each other (the El Sidrón / 50,000-years label+stat collision). Keep the first at its slot and
  // bump any later collision to a free slot. Build cues of the SAME group share a slot ON PURPOSE
  // (they stack via stackShift), so they count as a single occupant. Index-keyed → deterministic, no flicker.
  const SLOTS = ['lower-third', 'top-center', 'center'];
  const occupant = {};
  const placed = active.map((c, i) => {
    const key = (c.kind === 'build' && c.group) ? ('build:' + c.group) : ('solo:' + i);
    if (!occupant[c.pos] || occupant[c.pos] === key) { occupant[c.pos] = key; return c; }
    const free = SLOTS.find((p) => !occupant[p]);
    if (!free) return c;                       // all slots taken (rare) — leave it
    occupant[free] = key;
    return { ...c, pos: free };
  });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {placed.map((c, i) => <CueText key={i} c={c} frame={frame} fps={fps} vert={vert} cs={cs} fam={fam} />)}
    </AbsoluteFill>
  );
}

function Beat({ beat, isFirst, cstyle }) {
  const frame = useCurrentFrame();
  const dur = beat.durationInFrames;
  const imgs = (beat.images && beat.images.length) ? beat.images : [];
  // Only the very first beat of the video fades up from black; every other beat HARD CUTS (no flashing).
  const fadeUp = isFirst ? interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <AbsoluteFill style={{ opacity: fadeUp }}>
        {beat.realPhoto ? <RealPhotoBeat photo={beat.realPhoto} dur={dur} seed={beat.n || 0} />
          : beat.motionClip ? <VideoBeat clip={beat.motionClip} />
          : beat.infographic ? <InfographicBeat spec={beat.infographic} dur={dur} motion={beat.motion} />
            : beat.map ? <MapBeat spec={beat.map} dur={dur} motion={beat.motion} />
              : imgs.length ? <SubImages images={imgs} motion={beat.motion} dur={dur} seed={beat.n || 0} /> : null}
      </AbsoluteFill>
      {beat.ambientFx ? <Ambient kind={beat.ambientFx} /> : null}
      {/* a raw Shorts overlay OVERRIDES authored cues; else cues win; else legacy caption */}
      {beat.caption && beat.caption.raw
        ? <Caption caption={beat.caption} dur={dur} cstyle={cstyle} />
        : beat.cues && beat.cues.length
          ? <Cues cues={beat.cues} cstyle={cstyle} />
          : <Caption caption={beat.caption} dur={dur} cstyle={cstyle} />}
      {beat.audio ? <Audio src={staticFile(beat.audio)} /> : null}
    </AbsoluteFill>
  );
}

// ---- End card: branded outro over the channel banner, with marked YouTube end-screen zones ----
function EndCard({ endCard }) {
  const frame = useCurrentFrame();
  const inAt = (f0) => interpolate(frame, [f0, f0 + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rise = (f0) => interpolate(frame, [f0, f0 + 16], [22, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.quad) });
  const tagline = endCard.tagline || '';
  const bgZoom = 1.06 + 0.05 * interpolate(frame, [0, 360], [0, 1], { extrapolateRight: 'clamp' });   // slow drift in
  return (
    <AbsoluteFill style={{ backgroundColor: '#160f08', color: CREAM, overflow: 'hidden' }}>
      {/* cinematic banner backdrop with a warm scrim for legibility + thumbnail pop */}
      {endCard.banner ? (
        <AbsoluteFill>
          <Img src={staticFile(endCard.banner)} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${bgZoom})`, transformOrigin: '50% 40%' }} />
          <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(18,12,6,0.08) 0%, rgba(18,12,6,0.30) 42%, rgba(15,10,5,0.86) 80%, rgba(12,8,4,0.96) 100%)' }} />
          <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(12,8,4,0.88) 0%, rgba(12,8,4,0.44) 33%, rgba(12,8,4,0) 60%)' }} />
        </AbsoluteFill>
      ) : (
        <svg width="100%" height="100%" viewBox="0 0 1920 1080" style={{ position: 'absolute', opacity: 0.05 }}>
          {[230, 330, 430, 530, 650].map((r, i) => <circle key={i} cx="1490" cy="860" r={r} fill="none" stroke={CREAM} strokeWidth="2" />)}
        </svg>
      )}

      {/* left: sign-off + the channel strapline + weekly promise */}
      <div style={{ position: 'absolute', left: 122, top: 244, maxWidth: 780 }}>
        <div style={{ fontFamily: 'Marker, cursive', fontSize: 82, color: CREAM, lineHeight: 1, opacity: inAt(4), transform: `translateY(${rise(4)}px)`, textShadow: '0 3px 18px rgba(0,0,0,0.6)' }}>Thanks for watching</div>
        <div style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 33, color: ACCENT, marginTop: 20, opacity: inAt(12), transform: `translateY(${rise(12)}px)`, textShadow: '0 2px 12px rgba(0,0,0,0.65)' }}>{tagline}</div>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: 25, color: '#ebdcc2', marginTop: 24, lineHeight: 1.45, maxWidth: 560, opacity: inAt(20), transform: `translateY(${rise(20)}px)`, textShadow: '0 2px 10px rgba(0,0,0,0.7)' }}>
          {endCard.promise || 'A new video every week — subscribe so you never miss one.'}
        </div>
      </div>

      {/* lower-left: subscribe zone — channel avatar (logo) marks where the subscribe element goes */}
      <div style={{ position: 'absolute', left: 122, bottom: 150, display: 'flex', alignItems: 'center', gap: 24, opacity: inAt(30), transform: `translateY(${rise(30)}px)` }}>
        <div style={{ width: 150, height: 150, borderRadius: '50%', overflow: 'hidden', border: `3px solid ${ACCENT}`, boxShadow: '0 6px 26px rgba(0,0,0,0.6)', background: '#0d0905', flex: '0 0 auto' }}>
          {endCard.logo ? <Img src={staticFile(endCard.logo)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
        </div>
        <div>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 31, letterSpacing: 1, color: CREAM, textTransform: 'uppercase', textShadow: '0 2px 8px rgba(0,0,0,0.7)' }}>Subscribe</div>
          <div style={{ fontFamily: 'Marker, cursive', fontSize: 31, color: ACCENT, marginTop: 4, textShadow: '0 2px 8px rgba(0,0,0,0.6)' }}>{endCard.handle || ''}</div>
        </div>
      </div>

      {/* right: WATCH-NEXT zone — sized & placed to coincide with YouTube's right-side end-screen VIDEO
          element. Features a REAL, already-produced video (passed in by render.mjs from a sibling that
          has a rough cut); if there's no prior video yet, this whole block is simply absent. The frame
          is where the operator drops the clickable end-screen element in YouTube Studio. */}
      {Array.isArray(endCard.watchNext) && endCard.watchNext.length ? (
        <div style={{ position: 'absolute', right: 122, top: 148, width: 520 }}>
          <div style={{ display: 'inline-block', background: 'rgba(12,8,4,0.7)', borderRadius: 10, padding: '7px 16px', fontFamily: "'Archivo Black', sans-serif", fontSize: 24, letterSpacing: 3, color: ACCENT, textTransform: 'uppercase', marginBottom: 8, opacity: inAt(20), transform: `translateY(${rise(20)}px)`, textShadow: '0 2px 10px rgba(0,0,0,0.75)' }}>▶ Watch next</div>
          {endCard.watchNext.slice(0, 2).map((wn, i) => (
            <div key={i} style={{ position: 'relative', width: 520, height: 293, borderRadius: 14, overflow: 'hidden', border: `3px solid ${CREAM}`, boxShadow: '0 12px 40px rgba(0,0,0,0.62)', background: '#0d0905', marginTop: i === 0 ? 6 : 22, opacity: inAt(24 + i * 10), transform: `translateY(${rise(24 + i * 10)}px)` }}>
              {wn.thumb ? <Img src={staticFile(wn.thumb)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
              <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(12,8,4,0.10) 40%, rgba(12,8,4,0.92) 100%)' }} />
              <div style={{ position: 'absolute', top: '44%', left: '50%', transform: 'translate(-50%,-50%)', width: 76, height: 76, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', border: `3px solid ${CREAM}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 0, height: 0, borderLeft: `23px solid ${CREAM}`, borderTop: '14px solid transparent', borderBottom: '14px solid transparent', marginLeft: 7 }} />
              </div>
              <div style={{ position: 'absolute', left: 18, right: 18, bottom: 14, fontFamily: 'Georgia, serif', fontWeight: 'bold', fontSize: 26, lineHeight: 1.18, color: CREAM, textShadow: '0 2px 10px rgba(0,0,0,0.85)' }}>{wn.title}</div>
            </div>
          ))}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

// ---- Music bed: loops under everything, ducks below narration, swells on the end card ----
function musicVolume(f, beats, totalFrames, endCardFrames) {
  const RAMP = 14, UNDER = 0.07, OPEN = 0.16, CARD = 0.2;
  const lvl = (frame) => {
    if (endCardFrames && frame >= totalFrames - endCardFrames) return CARD;
    let off = 0;
    for (const b of beats) {
      if (frame < off + b.durationInFrames) return b.audio ? UNDER : OPEN;
      off += b.durationInFrames;
    }
    return CARD;
  };
  // 3-tap average around f -> smooth ~1s ducking ramps instead of hard volume steps
  const target = (lvl(Math.max(0, f - RAMP)) + lvl(f) + lvl(f + RAMP)) / 3;
  const fadeIn = interpolate(f, [0, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fadeOut = interpolate(f, [totalFrames - 75, totalFrames - 5], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return Math.max(0.0001, target * fadeIn * fadeOut);
}

export const Video = ({ beats, music, endCard, captionStyle, fps = 30 }) => {
  const list = beats || [];
  const beatFrames = list.reduce((a, b) => a + b.durationInFrames, 0);
  const endCardFrames = endCard ? Math.round((endCard.seconds || 12) * fps) : 0;
  const totalFrames = beatFrames + endCardFrames;
  const starts = []; { let o = 0; for (const b of list) { starts.push(o); o += b.durationInFrames; } }
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <FontFaces />
      {list.map((b, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={b.durationInFrames}>
          <Beat beat={b} isFirst={i === 0} cstyle={captionStyle} />
        </Sequence>
      ))}
      {endCard ? (
        <Sequence from={beatFrames} durationInFrames={endCardFrames}>
          <EndCard endCard={endCard} />
        </Sequence>
      ) : null}
      {music && music.src ? (
        <Audio loop src={staticFile(music.src)} volume={(f) => musicVolume(f, list, totalFrames, endCardFrames)} />
      ) : null}
      {/* paper grain + breath of vignette over everything: unifies AI stills into one "filmed" look */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <svg width="100%" height="100%">
          <filter id="paper"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" /><feColorMatrix type="saturate" values="0" /></filter>
          <rect width="100%" height="100%" filter="url(#paper)" opacity="0.045" />
        </svg>
        <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 62%, rgba(10,8,4,0.16) 100%)' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
