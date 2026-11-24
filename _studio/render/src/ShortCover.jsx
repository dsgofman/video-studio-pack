import { AbsoluteFill, Img, staticFile } from 'remotion';
import { ANTON } from './fonts.mjs';

// Deterministic vertical (1080x1920) Short COVER: composite a bold UPPERCASE Anton headline,
// centered in the frame's central square, onto a full-bleed background image. The 9:16 sibling of
// Thumbnail.jsx — same outline + scrim + auto-sizer approach, but the headline is ALWAYS Anton and
// ALWAYS center (both axes) so it survives Instagram's profile-grid crop (~center square): the top
// and bottom ~420px get lopped off, so the headline must live in the middle band.
//
// Props (via defaultProps or inputProps): { art, hook, accent }
//   art    : static path (relative to publicDir) to the background art PNG, full-bleed cover.
//   hook   : headline text (rendered UPPERCASE).
//   accent : one accent hex (#RRGGBB) — used as a subtle glow/underline tint. Text stays white.

// Embedded headline font (base64 data URL) — no network, mirrors Thumbnail.jsx FontFaces().
const FontFaces = () => (
  <style>{`
    @font-face { font-family: 'Anton'; src: url('${ANTON}') format('truetype'); }
  `}</style>
);

// mirrors lib/shortsdist.js coverTextRect — copied (NOT imported, that module is CJS and can't be
// pulled into this ESM Remotion bundle). Keeps the headline in the central square so IG's
// profile-grid crop (~3:4 / center square) never cuts it.
function coverTextRect() {
  const W = 1080, H = 1920;
  const w = Math.round(W * 0.86), h = Math.round(W * 0.5);
  const x = Math.round((W - w) / 2), y = Math.round(H / 2 - h / 2); // horizontally + vertically centered
  return { x, y, w, h };
}

// Anton METRICS (mirrors Thumbnail.jsx): mean glyph advance / font-size for UPPERCASE + line box / font-size.
const METRICS = { 'Anton': { adv: 0.42, lh: 0.92 } };

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
  const words = String(text || '').toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [''], fontSize: 120 };
  // Try from a large size down; first one that fits both width (longest line) and height wins.
  for (let fs = 260; fs >= 36; fs -= 2) {
    const lines = wrapAt(words, fs, rect.w, glyphAdv);
    const widest = Math.max(...lines.map((l) => l.length * fs * glyphAdv));
    const blockH = lines.length * fs * lineH;
    if (widest <= rect.w && blockH <= rect.h) return { lines, fontSize: fs };
  }
  return { lines: wrapAt(words, 36, rect.w, glyphAdv), fontSize: 36 };
}

export const ShortCover = ({ art, hook, accent }) => {
  const rect = coverTextRect();
  const acc = /^#?[0-9a-f]{6}$/i.test(String(accent || '')) ? (accent[0] === '#' ? accent : '#' + accent) : '#FF7A1A';
  const familyName = 'Anton';
  const family = `'${familyName}', sans-serif`;
  const { adv: glyphAdv, lh: lineH } = METRICS[familyName];

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

  // Soft contrast scrim BEHIND the words only — a radial vignette darkest at the rect center,
  // fading to transparent at the edges. Centered on the headline rect.
  const scrimW = Math.round(rect.w * 1.18);
  const scrimH = Math.round(rect.h * 1.05);
  const scrimCenterX = rect.x + rect.w / 2;
  const scrimCenterY = rect.y + rect.h / 2;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <FontFaces />

      {/* full-bleed art, object-fit cover. scale(1.06) = a slight overscan: any thin uniform frame
          Gemini adds gets pushed off-frame on all four sides (same border-guard as Thumbnail). */}
      {art ? (
        <Img src={staticFile(art)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scale(1.06)' }} />
      ) : null}

      {/* soft scrim centered on the headline rect (radial, fades out — never a hard box) */}
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

      {/* headline container at the center-safe rect: horizontally + vertically centered */}
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
          alignItems: 'center',
          textAlign: 'center',
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
        {/* thin accent underline beneath the block, centered */}
        <div
          style={{
            marginTop: Math.round(fontSize * 0.16),
            width: Math.min(rect.w, Math.round(fontSize * 4.2)),
            height: Math.max(6, Math.round(fontSize * 0.07)),
            background: acc,
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
            alignSelf: 'center',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
