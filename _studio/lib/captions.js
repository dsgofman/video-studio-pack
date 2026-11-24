// Pure caption helpers (CommonJS) used by server.js: word-timing extraction from the ElevenLabs alignment,
// and parsing the storyboard CSV's compact `cues` column. No fs, no deps — unit-testable.

// Build a word->start-time index from ElevenLabs character alignment. Returns [{ w, t }] where w is the
// lowercased, punctuation-stripped word and t is the start time (sec) of its FIRST character.
function wordTimings(alignment) {
  const al = alignment || {};
  const chars = al.characters || [];
  const starts = al.character_start_times_seconds || [];
  if (!chars.length || chars.length !== starts.length) return [];
  const out = [];
  let buf = '', bufStart = null;
  const flush = () => {
    if (!buf) return;
    const w = buf.toLowerCase().replace(/^[^a-z0-9%]+|[^a-z0-9%]+$/gi, '');
    if (w) out.push({ w, t: bufStart });
    buf = ''; bufStart = null;
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) { flush(); continue; }
    if (!buf) bufStart = starts[i];
    buf += c;
  }
  flush();
  return out;
}

const CUE_KINDS = ['label', 'stat', 'build', 'reveal', 'marker'];
const CUE_POS = ['top-center', 'center', 'lower-third'];
// Parse the `cues` CSV cell. Format: cues joined by ' || '; fields per cue joined by '~' in order
// kind~pos~group~anchor~emph~text. Tolerant: malformed cues (fewer than 6 fields, or empty text) are skipped.
function parseCues(cell) {
  const s = String(cell == null ? '' : cell).trim();
  if (!s) return [];
  const out = [];
  for (const part of s.split('||')) {
    const fields = part.split('~').map((x) => x.trim());
    if (fields.length < 6) continue;
    const [kind, pos, group, anchor, emph, ...rest] = fields;
    const text = rest.join('~').trim();   // tolerate a stray '~' inside text
    if (!text) continue;
    out.push({
      kind: CUE_KINDS.includes(kind) ? kind : 'label',
      pos: CUE_POS.includes(pos) ? pos : 'top-center',
      group: group || '',
      anchor: anchor || '',
      emph: emph || '',
      text: text.slice(0, 80),
    });
  }
  return out;
}

// All caption text actually shown on a scene: the legacy single `onScreenText` plus every
// `cues[]` entry's text. QC checks (caption-length, map-captions) use this so they see the
// modern kinetic-caption pipeline instead of the legacy field alone.
function captionTexts(scene) {
  const s = scene || {};
  const out = [];
  const legacy = (s.onScreenText || '').trim();
  if (legacy) out.push(legacy);
  for (const c of (Array.isArray(s.cues) ? s.cues : [])) {
    const t = ((c && c.text) || '').trim();
    if (t) out.push(t);
  }
  return out;
}

module.exports = { wordTimings, parseCues, captionTexts };
