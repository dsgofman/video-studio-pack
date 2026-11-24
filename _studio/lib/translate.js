// Subtitle translation helpers (pure + testable). The HTTP call to Gemini lives in server.js; this builds
// the prompt and robustly parses the model's reply back into one translated line per source cue. We
// translate cue TEXT only — timestamps + numbering are reattached unchanged, so timing never drifts.
'use strict';

// Big-audience languages worth shipping caption tracks in (code → English name for the prompt + filename).
const LANGS = {
  es: 'Spanish', pt: 'Portuguese', hi: 'Hindi', ar: 'Arabic', fr: 'French', de: 'German',
  id: 'Indonesian', ja: 'Japanese', ru: 'Russian', it: 'Italian', tr: 'Turkish', ko: 'Korean',
  'zh-Hans': 'Simplified Chinese', pl: 'Polish', vi: 'Vietnamese', nl: 'Dutch', th: 'Thai',
};

// One translation prompt for a whole subtitle file. Numbered + tab-delimited so the reply is easy to
// realign by index, with explicit "same count, same order, nothing else" guardrails.
function buildPrompt(texts, langName) {
  const numbered = texts.map((t, i) => (i + 1) + '\t' + String(t == null ? '' : t).replace(/\s+/g, ' ').trim()).join('\n');
  return [
    `You are a professional subtitle translator. Translate each numbered English subtitle line below into ${langName}.`,
    `Rules: translate naturally for spoken narration; keep proper nouns, place names and scientific names sensible in ${langName}; do NOT merge, split, renumber or reorder lines; keep numbers/units intact.`,
    `Return EXACTLY ${texts.length} lines, each as "<number><TAB><translation>", in the same order, and NOTHING else — no preamble, no notes, no blank lines.`,
    '',
    numbered,
  ].join('\n');
}

// Parse the model reply into exactly `expected` strings, realigned by leading line number when present,
// else positionally. Tolerates "N\t", "N. ", "N) ", "N:" prefixes and stray blank lines / fences.
function parseLines(modelText, expected) {
  const out = new Array(expected).fill(null);
  const raw = String(modelText || '').replace(/```[a-z]*\n?/gi, '').split('\n');
  let positional = 0;
  for (const ln of raw) {
    const s = ln.replace(/\r$/, '');
    if (!s.trim()) continue;
    const m = s.match(/^\s*(\d{1,5})\s*(?:\t|[.)\]:]\s|\s-\s|\s)\s*(.*)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < expected && out[idx] == null) { out[idx] = m[2].trim(); continue; }
    }
    // no usable number → drop into the next empty positional slot
    while (positional < expected && out[positional] != null) positional++;
    if (positional < expected) out[positional++] = s.trim();
  }
  return out;   // entries may be null where the model dropped a line — caller falls back to the source text
}

module.exports = { LANGS, buildPrompt, parseLines };
