import { AbsoluteFill, Sequence, Img, Audio, useCurrentFrame, useVideoConfig, interpolate, spring, staticFile, Easing } from 'remotion';
import { MapStill } from './Map.jsx';
import { PERMANENT_MARKER, ARCHIVO_BLACK } from './fonts.mjs';

const CREAM = '#fff7ec', ACCENT = '#e07a3c', INK = '#221a10';

// Embedded fonts (base64 data URLs) — no network, no webpack font config needed.
const FontFaces = () => (
  <style>{`
    @font-face { font-family: 'Marker'; src: url('${PERMANENT_MARKER}') format('truetype'); }
    @font-face { font-family: 'Archivo Black'; src: url('${ARCHIVO_BLACK}') format('truetype'); }
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
  return { transform: `scale(${scale}) translate(${x}%, ${y}%)`, transformOrigin: ORIGINS[seed % ORIGINS.length] };
}

// All of a beat's stills stacked with TRUE crossfades between them (no dip to black between frames).
function SubImages({ images, motion, dur, seed }) {
  const frame = useCurrentFrame();
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
        return (
          <Img key={i} src={staticFile(src)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: fadeIn, ...motionStyle(motion, local, Math.max(1, end - start), seed + i) }} />
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
  // The map engine draws a fixed 1920x1080 canvas; cover-scale it so vertical (Shorts) frames
  // center-crop instead of squashing. At 1920x1080 cover === 1 and this wrapper is a no-op.
  const cover = Math.max(width / 1920, height / 1080);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: (width - 1920) / 2, top: (height - 1080) / 2, width: 1920, height: 1080, transform: `scale(${cover})` }}>
        <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: '50% 46%' }}>
          <MapStill {...spec} labelStyle={spec.labelStyle || 'serif'} progress={p >= 0.999 ? 0.9999 : p} />
        </AbsoluteFill>
      </div>
    </AbsoluteFill>
  );
}

function Caption({ caption, dur }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!caption || !caption.text) return null;
  const { text, pos, anim } = caption;
  let opacity = 1, scale = 1, shown = text;
  if (anim === 'fade') opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  else if (anim === 'punch') {
    scale = spring({ frame, fps, config: { damping: 12, stiffness: 200, mass: 0.6 } });
    opacity = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: 'clamp' });
  } else if (anim === 'type') {
    const n = Math.floor(interpolate(frame, [0, Math.min(dur, text.length * 1.5)], [0, text.length], { extrapolateRight: 'clamp' }));
    shown = text.slice(0, n);
  }
  const place = pos === 'center' ? { top: '50%', transform: 'translateY(-50%)' }
    : pos === 'lower-third' ? { bottom: '8%' } : { top: '6%' };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', ...place }}>
        <span style={{
          display: 'inline-block', transform: `scale(${scale})`, opacity, maxWidth: '78%',
          color: '#fffdf7', fontFamily: "'Archivo Black', sans-serif", fontSize: 58,
          textTransform: 'uppercase', letterSpacing: 1, lineHeight: 1.12,
          WebkitTextStroke: '2px rgba(24,18,10,0.82)',
          textShadow: '0 3px 0 rgba(24,18,10,0.55), 0 6px 18px rgba(0,0,0,0.45)',
        }}>{shown}</span>
      </div>
    </AbsoluteFill>
  );
}

function Beat({ beat, isFirst }) {
  const frame = useCurrentFrame();
  const dur = beat.durationInFrames;
  const imgs = (beat.images && beat.images.length) ? beat.images : [];
  // Only the very first beat of the video fades up from black; every other beat HARD CUTS (no flashing).
  const fadeUp = isFirst ? interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <AbsoluteFill style={{ opacity: fadeUp }}>
        {beat.map ? <MapBeat spec={beat.map} dur={dur} motion={beat.motion} />
          : imgs.length ? <SubImages images={imgs} motion={beat.motion} dur={dur} seed={beat.n || 0} /> : null}
      </AbsoluteFill>
      <Caption caption={beat.caption} dur={dur} />
      {beat.audio ? <Audio src={staticFile(beat.audio)} /> : null}
    </AbsoluteFill>
  );
}

// ---- End card: branded outro over the channel banner, with marked YouTube end-screen zones ----
function EndCard({ endCard }) {
  const frame = useCurrentFrame();
  const inAt = (f0) => interpolate(frame, [f0, f0 + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rise = (f0) => interpolate(frame, [f0, f0 + 16], [22, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.quad) });
  const tagline = endCard.tagline || 'The human story, before history began.';
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
          A new deep-history story every week — subscribe so you never miss one.
        </div>
      </div>

      {/* lower-left: subscribe zone — channel avatar (logo) marks where the subscribe element goes */}
      <div style={{ position: 'absolute', left: 122, bottom: 150, display: 'flex', alignItems: 'center', gap: 24, opacity: inAt(30), transform: `translateY(${rise(30)}px)` }}>
        <div style={{ width: 150, height: 150, borderRadius: '50%', overflow: 'hidden', border: `3px solid ${ACCENT}`, boxShadow: '0 6px 26px rgba(0,0,0,0.6)', background: '#0d0905', flex: '0 0 auto' }}>
          {endCard.logo ? <Img src={staticFile(endCard.logo)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
        </div>
        <div>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 31, letterSpacing: 1, color: CREAM, textTransform: 'uppercase', textShadow: '0 2px 8px rgba(0,0,0,0.7)' }}>Subscribe</div>
          <div style={{ fontFamily: 'Marker, cursive', fontSize: 31, color: ACCENT, marginTop: 4, textShadow: '0 2px 8px rgba(0,0,0,0.6)' }}>@beforelore</div>
        </div>
      </div>

      {/* right: WATCH-NEXT zone — sized & placed to coincide with YouTube's right-side end-screen VIDEO
          element. Features a REAL, already-produced video (passed in by render.mjs from a sibling that
          has a rough cut); if there's no prior video yet, this whole block is simply absent. The frame
          is where the operator drops the clickable end-screen element in YouTube Studio. */}
      {endCard.watchNext && endCard.watchNext.title ? (
        <div style={{ position: 'absolute', right: 122, top: 330, width: 600, opacity: inAt(24), transform: `translateY(${rise(24)}px)` }}>
          <div style={{ display: 'inline-block', background: 'rgba(12,8,4,0.7)', borderRadius: 10, padding: '7px 16px', fontFamily: "'Archivo Black', sans-serif", fontSize: 25, letterSpacing: 3, color: ACCENT, textTransform: 'uppercase', marginBottom: 14, textShadow: '0 2px 10px rgba(0,0,0,0.75)' }}>▶ Watch next</div>
          <div style={{ position: 'relative', width: 600, height: 338, borderRadius: 16, overflow: 'hidden', border: `3px solid ${CREAM}`, boxShadow: '0 12px 44px rgba(0,0,0,0.65)', background: '#0d0905' }}>
            {endCard.watchNextThumb ? <Img src={staticFile(endCard.watchNextThumb)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
            <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(12,8,4,0.10) 38%, rgba(12,8,4,0.92) 100%)' }} />
            <div style={{ position: 'absolute', top: '46%', left: '50%', transform: 'translate(-50%,-50%)', width: 92, height: 92, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', border: `3px solid ${CREAM}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 0, height: 0, borderLeft: `28px solid ${CREAM}`, borderTop: '17px solid transparent', borderBottom: '17px solid transparent', marginLeft: 8 }} />
            </div>
            <div style={{ position: 'absolute', left: 22, right: 22, bottom: 18, fontFamily: 'Georgia, serif', fontWeight: 'bold', fontSize: 30, lineHeight: 1.2, color: CREAM, textShadow: '0 2px 10px rgba(0,0,0,0.85)' }}>{endCard.watchNext.title}</div>
          </div>
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

export const Video = ({ beats, music, endCard, fps = 30 }) => {
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
          <Beat beat={b} isFirst={i === 0} />
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
