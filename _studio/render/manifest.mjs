// Pure: turn a studio.json doc into the inputProps the Remotion composition renders.
// Paths are made relative to the video's 04-assets/ folder (the Remotion publicDir).
import { resolveCues } from './cues.mjs';
const FPS = 30, WIDTH = 1920, HEIGHT = 1080;
const AMBIENT_KINDS = new Set(['embers', 'spores', 'pollen', 'dust', 'snow', 'rain']);   // opt-in particle overlays

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
    const infographic = (s.infographic && s.infographic.type) ? s.infographic : null;   // deterministic diagram
    const realPhoto = (s.realPhoto && s.realPhoto.src) ? { src: rel(s.realPhoto.src), label: s.realPhoto.label || '', video: !!s.realPhoto.video } : null;   // real Pexels artifact plate (photo OR video)
    const motionClip = (s.motionClip && s.motionClip.src) ? { src: rel(s.motionClip.src) } : null;   // Veo image→video (animated beat)
    if (!images.length && !audio && !map && !infographic && !realPhoto && !motionClip) { skipped++; continue; }   // nothing to show
    const secs = Math.max(1.2, s.audioSeconds || s.seconds || estSeconds(s.narration));
    const beatFrames = Math.max(1, Math.round(secs * FPS));
    const cues = resolveCues(s.cues || [], s.wordTimings || [], secs, FPS, beatFrames);
    beats.push({
      n: s.n,
      images,
      audio,
      map,                                                  // accurate-map beats animate live (route draw-on)
      infographic,                                          // deterministic timeline/chart (rendered from data)
      durationInFrames: beatFrames,
      motion: s.motion || (s.kind === 'infographic' ? 'static' : 'push-in'),
      ambientFx: AMBIENT_KINDS.has(s.ambientFx) ? s.ambientFx : null,   // opt-in drifting particle layer
      realPhoto,                                                        // real Pexels artifact (renders as a field-guide plate)
      motionClip,                                                       // Veo animated clip (renders as a video beat)
      caption,    // legacy single caption (used only when cues is empty)
      cues,       // resolved transient cues (preferred)
    });
  }
  const totalFrames = beats.reduce((a, b) => a + b.durationInFrames, 0);
  return { fps: FPS, width: WIDTH, height: HEIGHT, beats, totalFrames, skipped };
}
