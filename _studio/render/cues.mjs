// Pure (ESM): resolve authored cues + word timings into frame-windowed render cues for Video.jsx.
//
// Timing model (why each piece exists):
// - Cues anchor to the START time of their anchor word, so they land in sync with the narration.
// - HOLD is the *target* on-screen time per kind; readHold() stretches it for wordier cues so a
//   6-word reveal isn't gone before it can be read (reading-time budget).
// - A cue can't outlive its beat (it renders inside the beat's Sequence). So instead of CLAMPING a
//   late-anchored cue's end to the beat boundary — which silently shortened it into a "flash" — we
//   SLIDE its whole window earlier to preserve the full hold. This fixed the "reveals flash by / feel
//   behind" problem: a punch line anchored to the last spoken word now appears ~1.5-2.5s before the cut
//   and holds, instead of blinking for 1.2s. Only when the beat is genuinely shorter than the hold does
//   it clamp.
const HOLD = { label: 1.8, stat: 1.6, reveal: 1.7, marker: 2.2, build: 1.4 };  // seconds the LAST item lingers
const MIN_HOLD = 0.9;                     // a cue never shows shorter than this
const READ_PER_WORD = 0.34, READ_BASE = 0.5;   // reading-time budget: longer text => longer hold
const norm = (s) => String(s || '').toLowerCase().replace(/^[^a-z0-9%]+|[^a-z0-9%]+$/gi, '');

// Target on-screen seconds for a cue: the per-kind floor, stretched to a comfortable reading time.
function readHold(kind, text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(HOLD[kind] || 1.5, words * READ_PER_WORD + READ_BASE);
}

// Find a word's start time, scanning at/after `fromIdx` to keep list order; returns { t, idx } or null.
function findWord(wordTimings, anchor, fromIdx) {
  const a = norm(anchor);
  if (!a) return null;
  for (let i = Math.max(0, fromIdx); i < wordTimings.length; i++) {
    if (wordTimings[i].w === a) return { t: wordTimings[i].t, idx: i };
  }
  return null;
}

export function resolveCues(cues, wordTimings, beatSeconds, fps, beatFrames) {
  if (!cues || !cues.length) return [];
  const wt = wordTimings || [];
  // 1) assign each cue a startSec (anchor first, then proportional fallback) preserving array order
  const items = cues.map((c) => ({ ...c }));
  let lastIdx = -1;
  for (const it of items) {
    const hit = findWord(wt, it.anchor, lastIdx + 1);
    if (hit) { it.startSec = hit.t; lastIdx = hit.idx; }
  }
  // proportional fill for any without a startSec: spread across the middle 70% of the beat, in order
  const lo = beatSeconds * 0.12, hi = beatSeconds * 0.82, span = Math.max(0.001, hi - lo);
  const missing = items.filter((it) => it.startSec == null);
  missing.forEach((it, i) => { it.startSec = lo + span * (missing.length === 1 ? 0.15 : i / (missing.length - 1 || 1)); });
  // keep non-decreasing in array order (anchors can be slightly out of order)
  for (let i = 1; i < items.length; i++) if (items[i].startSec < items[i - 1].startSec) items[i].startSec = items[i - 1].startSec + 0.25;

  const mk = (it, startSec, endSec, brightSec, k, size) => ({
    text: it.text, emph: it.emph || '', kind: it.kind, pos: it.pos,
    group: it.group || '', stackIndex: k, groupSize: size,
    startFrame: Math.max(0, Math.round(startSec * fps)),
    endFrame: Math.min(beatFrames, Math.round(endSec * fps)),
    brightUntil: Math.min(beatFrames, Math.round(brightSec * fps)),
  });

  // 2) compute windows. Build groups clear together; others get a reading-time hold. A window that would
  //    overflow the beat slides EARLIER (preserving the hold) instead of being clipped to a flash —
  //    but a slide may never cross the PREVIOUS cue's resolved start (`floorStart`), or a big
  //    author-set `hold` on a late cue would make it appear on screen before an earlier cue and
  //    read out of sync with the narration. Order beats linger: when both can't fit, trim the hold.
  const groups = {};
  items.forEach((it, i) => { const g = it.group || ('__' + i); (groups[g] = groups[g] || []).push(it); });
  const out = [];
  let floorStart = 0;   // resolved start of the previously processed cue (groups iterate in array order)
  for (const g of Object.keys(groups)) {
    const members = groups[g];
    const isBuild = members.length > 1 || members[0].kind === 'build';
    if (isBuild) {
      // per-cue `hold` works in groups too: the largest author-set hold extends the stack's linger.
      const authored = Math.max(0, ...members.map((m) => (typeof m.hold === 'number' && m.hold > 0) ? m.hold : 0));
      const hold = Math.max(MIN_HOLD, authored || HOLD.build);
      let clearWant = members[members.length - 1].startSec + hold;
      if (clearWant > beatSeconds) {                       // slide the whole group earlier so the last item holds
        const shift = Math.min(clearWant - beatSeconds, Math.max(0, members[0].startSec - floorStart));
        members.forEach((it) => { it.startSec = Math.max(0, it.startSec - shift); });
        clearWant = members[members.length - 1].startSec + hold;
      }
      const clear = Math.min(beatSeconds, clearWant);
      members.forEach((it, k) => {
        const brightSec = (k < members.length - 1) ? members[k + 1].startSec : clear;
        out.push(mk(it, it.startSec, clear, brightSec, k, members.length));
      });
      floorStart = members[members.length - 1].startSec;
    } else {
      const it = members[0];
      // per-cue `hold` (seconds) override wins over the reading-time default — lets a specific cue linger.
      const want = (typeof it.hold === 'number' && it.hold > 0) ? it.hold : readHold(it.kind, it.text);
      const hold = Math.max(MIN_HOLD, want);
      let startSec = it.startSec, endSec = startSec + hold;
      if (endSec > beatSeconds) {                          // slide, don't clip — floored at the previous cue's start
        startSec = Math.max(Math.max(0, beatSeconds - hold), Math.min(floorStart, it.startSec));
        endSec = beatSeconds;
      }
      out.push(mk(it, startSec, endSec, endSec, 0, 1));
      floorStart = startSec;
    }
  }
  out.sort((a, b) => a.startFrame - b.startFrame);
  return out;
}
