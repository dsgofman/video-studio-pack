// Subtitles: build a broadcast-quality .srt (and .vtt) from the SAME beat timeline the renderer uses,
// so the captions sync EXACTLY to the assembled video. Extracted from server.js so the logic has one
// home and can run offline (no YouTube connection required) — server.js, the local /api/subtitles
// endpoint, and the YouTube caption upload all share it.
//
// Timeline rule mirrors render/manifest.mjs: each non-excluded beat that has an image, audio, or a map
// holds for its REAL voiced duration (audioSeconds), falling back to the storyboard estimate. Long beats
// are split into readable cues (≈84 chars, prefer sentence breaks); each cue's window is allocated
// proportionally by word count.

'use strict';

// Which scenes make the timeline and how long each holds (mirror of render/manifest.mjs beat rules).
function beatTimeline(scenes) {
  const out = []; let t = 0;
  for (const s of (scenes || [])) {
    if (s.exclude) continue;
    const isMap = s.kind === 'map' && s.map && Array.isArray(s.map.focus);
    if (!s.imagePath && !s.audioPath && !isMap) continue;            // manifest skips asset-less beats
    const secs = Math.max(1.2, s.audioSeconds || s.seconds || 2);
    out.push({ n: s.n, start: t, end: t + secs, secs, narration: (s.narration || '').trim() });
    t += secs;
  }
  return out;
}

function srtTime(t) {
  t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms === 1000 ? 999 : ms, 3);
}

// Split one beat's narration into reading-speed cues: keep whole sentences when short; balance-split a
// long sentence into N≈ceil(len/MAX) roughly-equal word groups (avoids a tiny orphan tail like "to lose.").
function splitCue(text) {
  text = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); if (!text) return [];
  const MAX = 84;
  const sentences = text.match(/[^.!?]+[.!?]*(?:\s+|$)/g) || [text];
  const cues = [];
  for (let sent of sentences) {
    sent = sent.trim(); if (!sent) continue;
    if (sent.length <= MAX) { cues.push(sent); continue; }
    const words = sent.split(' '), n = Math.max(2, Math.ceil(sent.length / MAX)), per = Math.ceil(words.length / n);
    for (let i = 0; i < words.length; i += per) cues.push(words.slice(i, i + per).join(' '));
  }
  return cues;
}

// Build the full SRT. Returns { srt, cues, seconds }.
function buildSrt(scenes) {
  const tl = beatTimeline(scenes); const out = []; let idx = 0;
  for (const b of tl) {
    const cues = splitCue(b.narration); if (!cues.length) continue;
    const span = Math.max(0.6, b.end - b.start);
    const totalW = cues.reduce((a, c) => a + c.split(' ').length, 0) || 1;
    let t = b.start;
    for (const c of cues) {
      const dur = span * (c.split(' ').length / totalW);
      const start = t, end = Math.min(b.end, t + dur);
      idx++;
      out.push(idx + '\n' + srtTime(start) + ' --> ' + srtTime(end) + '\n' + c);
      t = end;
    }
  }
  return { srt: out.join('\n\n') + '\n', cues: idx, seconds: tl.length ? tl[tl.length - 1].end : 0 };
}

// WebVTT sibling — same cues, comma→dot timestamps + a WEBVTT header (for web <track> players / some tools).
function buildVtt(scenes) {
  const { srt, cues, seconds } = buildSrt(scenes);
  const body = srt.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
  return { vtt: 'WEBVTT\n\n' + body, cues, seconds };
}

// Parse an .srt back into cues — used by translation (translate text, keep timing). Tolerant of blank lines.
function parseSrt(srt) {
  const cues = [];
  for (const block of String(srt || '').replace(/\r/g, '').trim().split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;
    const n = parseInt(lines[0], 10);
    const tm = lines[1].match(/^(\d\d:\d\d:\d\d,\d{3})\s*-->\s*(\d\d:\d\d:\d\d,\d{3})/);
    if (!tm) continue;
    cues.push({ n: isFinite(n) ? n : cues.length + 1, start: tm[1], end: tm[2], text: lines.slice(2).join('\n').trim() });
  }
  return cues;
}

// Rebuild .srt text from cues [{n,start,end,text}] (timestamps preserved verbatim — translation only swaps text).
function buildSrtFromCues(cues) {
  return (cues || []).map((c, i) => (c.n || i + 1) + '\n' + c.start + ' --> ' + c.end + '\n' + (c.text || '')).join('\n\n') + '\n';
}

// .vtt sibling of a cue list (comma→dot timestamps + WEBVTT header).
function buildVttFromCues(cues) {
  return 'WEBVTT\n\n' + buildSrtFromCues(cues).replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
}

module.exports = { beatTimeline, srtTime, splitCue, buildSrt, buildVtt, parseSrt, buildSrtFromCues, buildVttFromCues };
