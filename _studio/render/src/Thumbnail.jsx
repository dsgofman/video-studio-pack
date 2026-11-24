import { AbsoluteFill, Img, staticFile } from 'remotion';
import { ARCHIVO_BLACK, BANGERS, ANTON } from './fonts.mjs';

// Deterministic thumbnail TEXT-OVERLAY: composite a bold UPPERCASE headline onto finished
// thumbnail ART (1920x1080). The headline sits in a UI-safe zone, in a heavy bold font, with a
// thick outline + a soft contrast scrim so it is ALWAYS legible on any background — no pixel
// sampling needed (the outline + scrim guarantee the contrast).
//
// Props (via defaultProps or inputProps): { art, hook, accent, side, font }
//   art    : static path (relative to publicDir) to the background art PNG, full-bleed cover.
//   hook   : headline text (rendered UPPERCASE).
//   accent : one accent hex (#RRGGBB) — used as a subtle glow/underline + scrim tint. Text stays white.
//   side   : 'left' | 'right' — which half the headline lives in.
//   font   : 'anton' (default) | 'archivo' | 'bebas'. Anton is the heavy-condensed default ("Impact
//            replacement"). 'archivo' = the wide Archivo Black. 'bebas' isn't embedded, so it maps to
//            Anton (the closest embedded condensed face) rather than breaking the render.

// Embedded headline fonts (base64 data URLs) — no network, mirrors src/Video.jsx FontFaces().
// 'bebas' has no embedded .ttf; we alias it to the Anton bytes (closest condensed face) so the render
// never breaks on a missing font dependency (per spec: do NOT add a missing-font dependency).
const FontFaces = () => (
  <style>{`
    @font-face { font-family: 'Anton'; src: url('${ANTON}') format('truetype'); }
    @font-face { font-family: 'Archivo Black'; src: url('${ARCHIVO_BLACK}') format('truetype'); }
    @font-face { font-family: 'Bangers'; src: url('${BANGERS}') format('truetype'); }
  `}</style>
);

// mirrors lib/thumbnail.js safeTextRect — copied (NOT imported: that module is CJS and can't be
// pulled into this ESM Remotion bundle). Off the 4 UI-hazard corners, inside the central band,
// above the bottom-15% progress-bar zone.
function safeTextRect(W, H, side) {
  const sideMargin = Math.round(W * 0.06);
  const gutter = Math.round(W * 0.04);
  const top = Math.round(H * 0.10);
  const bottom = Math.round(H * 0.85); // leaves the bottom 15% for the progress bar
  const midX = Math.round(W * 0.5);
  if (side === 'left') return { x: sideMargin, y: top, w: (midX - gutter) - sideMargin, h: bottom - top };
  return { x: midX + gutter, y: top, w: (W - sideMargin) - (midX + gutter), h: bottom - top };
}

// Auto-size the headline to fill the safe rect without overflowing. We measure with a rough
// per-glyph advance that depends on the resolved face (Anton's condensed caps advance much less per
// em than Archivo Black's wide caps), and a line-height of ~0.92–1.0, then wrap words greedily across
// candidate font sizes (largest first) and pick the biggest size whose wrapped block fits inside
// rect.w x rect.h. Deterministic — no DOM measurement, so it renders identically headless.
// GLYPH_ADV / LINE_H are passed in (font-aware) — see METRICS below.
const METRICS = {
  // family -> { adv: mean glyph advance / font-size for UPPERCASE, lh: line box / font-size }
  'Anton':         { adv: 0.42, lh: 0.92 }, // heavy + condensed: much narrower caps, tight stack
  'Archivo Black': { adv: 0.60, lh: 1.0  }, // wide heavy caps
};
const DEFAULT_ADV = 0.6, DEFAULT_LINE_H = 1.0;

function wrapAt(words, fontSize, maxW, glyphAdv) {
  const lines = [];
  let cur = '';
  const widthOf = (s) => s.length * fontSize * glyphAdv;
  for (const w of words) {
    const trial = cur ? cur + ' ' + w : w;
    if (widthOf(trial) <= maxW || !cur) cur = trial;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitHeadline(text, rect, glyphAdv, lineH) {
  const adv = glyphAdv || DEFAULT_ADV;
  const lh = lineH || DEFAULT_LINE_H;
  const words = String(text || '').toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [''], fontSize: 120 };
  // Try from a large size down; first one that fits both width (longest line) and height wins.
  for (let fs = 220; fs >= 36; fs -= 2) {
    const lines = wrapAt(words, fs, rect.w, adv);
    const widest = Math.max(...lines.map((l) => l.length * fs * adv));
    const blockH = lines.length * fs * lh;
    if (widest <= rect.w && blockH <= rect.h) return { lines, fontSize: fs };
  }
  // Worst case (one very long word): force-wrap at smallest size.
  return { lines: wrapAt(words, 36, rect.w, adv), fontSize: 36 };
}

export const Thumbnail = ({ art, hook, accent, side, font }) => {
  const W = 1920, H = 1080;
  const sideKey = side === 'left' ? 'left' : 'right';
  const rect = safeTextRect(W, H, sideKey);
  const acc = /^#?[0-9a-f]{6}$/i.test(String(accent || '')) ? (accent[0] === '#' ? accent : '#' + accent) : '#FF7A1A';
  // Resolve the headline face from the `font` prop. Anton (heavy + condensed) is the default.
  //   'archivo' -> the wide Archivo Black; 'bebas' -> Anton (Bebas isn't embedded, Anton is the
  //   closest condensed match); anything else / 'anton' / undefined -> Anton.
  const fontKey = String(font || '').toLowerCase();
  const familyName = fontKey === 'archivo' ? 'Archivo Black' : 'Anton'; // 'bebas' & default fall to Anton
  const family = `'${familyName}', sans-serif`;
  const { adv: glyphAdv, lh: lineH } = METRICS[familyName] || { adv: DEFAULT_ADV, lh: DEFAULT_LINE_H };

  const { lines, fontSize } = fitHeadline(hook, rect, glyphAdv, lineH);

  // Layered black outline via WebkitTextStroke + many textShadow offsets so the type reads on ANY
  // background. The accent contributes a thin outer glow only — the fill stays pure white.
  const strokeShadows = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      if (dx === 0 && dy === 0) continue;
      strokeShadows.push(`${dx}px ${dy}px 0 #000`);
    }
  }
  const textShadow = [
    ...strokeShadows,
    '0 6px 18px rgba(0,0,0,0.85)',     // drop for separation from the art
    `0 0 26px ${acc}`,                 // subtle accent glow
  ].join(', ');

  // Outer-edge alignment: left side hugs the frame's left edge, right side hugs the right edge.
  const align = sideKey === 'left' ? 'left' : 'right';

  // Soft contrast scrim BEHIND the words only — a radial vignette darkest at the text block center,
  // fading to fully transparent at the rect edges. Subtle (not a hard plate); it just buys contrast.
  const scrimW = Math.round(rect.w * 1.18);
  const scrimH = Math.round(rect.h * 0.9);
  const scrimCenterX = sideKey === 'left' ? rect.x + rect.w * 0.42 : rect.x + rect.w * 0.58;
  const scrimCenterY = rect.y + rect.h / 2;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <FontFaces />

      {/* full-bleed art, object-fit cover */}
      {art ? (
        // scale(1.06) = a slight overscan: any thin uniform frame Gemini adds (despite the "bleed off
        // all edges" instruction) gets pushed off-frame on all four sides. Subject stays central, so
        // the ~3%/edge crop is safe.
        <Img src={staticFile(art)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scale(1.06)' }} />
      ) : null}

      {/* soft scrim behind the headline (radial, fades out — never a hard box) */}
      <div
        style={{
          position: 'absolute',
          left: Math.round(scrimCenterX - scrimW / 2),
          top: Math.round(scrimCenterY - scrimH / 2),
          width: scrimW,
          height: scrimH,
          background: 'radial-gradient(closest-side, rgba(0,0,0,0.58), rgba(0,0,0,0.30) 55%, rgba(0,0,0,0) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* headline container at the safe rect, vertically centered, aligned to the outer edge */}
      <div
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: align === 'left' ? 'flex-start' : 'flex-end',
          textAlign: align,
        }}
      >
        <div
          style={{
            fontFamily: family,
            fontSize,
            lineHeight: lineH,
            color: '#fff',
            textTransform: 'uppercase',
            letterSpacing: '-0.5px',
            WebkitTextStroke: '8px #000',
            paintOrder: 'stroke fill',     // stroke UNDER the fill so the white face stays crisp
            textShadow,
            margin: 0,
          }}
        >
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'block' }}>{l}</div>
          ))}
        </div>
        {/* thin accent underline beneath the block, on the outer edge */}
        <div
          style={{
            marginTop: Math.round(fontSize * 0.16),
            width: Math.min(rect.w, Math.round(fontSize * 4.2)),
            height: Math.max(6, Math.round(fontSize * 0.07)),
            background: acc,
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
            alignSelf: align === 'left' ? 'flex-start' : 'flex-end',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
