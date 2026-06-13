// Pure: turn a studio.json doc into the inputProps the Remotion composition renders.
// Paths are made relative to the video's 04-assets/ folder (the Remotion publicDir).
const FPS = 30, WIDTH = 1920, HEIGHT = 1080;

function rel(p) { return String(p || '').replace(/^.*04-assets[\/\\]/, ''); }
function estSeconds(t) {
  const w = (t || '').trim().split(/\s+/).filter(Boolean).length;
  return w ? Math.max(1.5, (w / 135) * 60) : 2;
}

export function buildManifest(doc, opts = {}) {
  const all = ((((doc || {}).stages || {}).scenes || {}).candidates || {}).scenes || [];
  const from = opts.from || null, to = opts.to || null;
  const scenes = (from || to) ? all.filter((s) => (!from || s.n >= from) && (!to || s.n <= to)) : all;
  const beats = [];
  let skipped = 0;
  for (const s of scenes) {
    if (s.exclude) continue;                                // intentionally dropped from the cut (assets kept on disk)
    const images = [];
    if (s.imagePath) images.push(rel(s.imagePath));
    for (const f of (s.frames || [])) if (f && f.imagePath) images.push(rel(f.imagePath));
    const audio = s.audioPath ? rel(s.audioPath) : null;
    const caption = (s.onScreenText || '').trim()
      ? { text: (s.onScreenText || '').trim(), pos: s.textPos || 'top-center', anim: s.textAnim || 'punch' }
      : null;
    const map = (s.kind === 'map' && s.map && Array.isArray(s.map.focus)) ? s.map : null;
    if (!images.length && !audio && !map) { skipped++; continue; }   // nothing to show
    const secs = Math.max(1.2, s.audioSeconds || s.seconds || estSeconds(s.narration));
    beats.push({
      n: s.n,
      images,
      audio,
      map,                                                  // accurate-map beats animate live (route draw-on)
      durationInFrames: Math.max(1, Math.round(secs * FPS)),
      motion: s.motion || (s.kind === 'infographic' ? 'static' : 'push-in'),
      caption,
    });
  }
  const totalFrames = beats.reduce((a, b) => a + b.durationInFrames, 0);
  return { fps: FPS, width: WIDTH, height: HEIGHT, beats, totalFrames, skipped };
}
