'use strict';
// Vivid Blue/Orange/Green/Yellow — chosen to pop against YouTube's red/black/white UI.
const BOGY = { blue: '#2F6BFF', orange: '#FF7A1A', green: '#22C55E', yellow: '#FFD21A' };
// Color names Claude may emit for a thumbnail accent → resolved to a hex.
const NAMED_ACCENTS = { blue: BOGY.blue, orange: BOGY.orange, green: BOGY.green, yellow: BOGY.yellow,
  red: '#FF3B30', purple: '#A855F7', cyan: '#22D3EE', pink: '#FF4D8D', teal: '#14B8A6', white: '#F5F5F5' };
function resolveAccent(a) {
  const s = String(a || '').trim();
  if (/^#?[0-9a-f]{6}$/i.test(s)) return s.startsWith('#') ? s : '#' + s;
  return NAMED_ACCENTS[s.toLowerCase()] || BOGY.orange;
}

function _lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function relativeLuminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim()); if (!m) return 0;
  const n = parseInt(m[1], 16);
  return 0.2126 * _lin((n >> 16) & 255) + 0.7152 * _lin((n >> 8) & 255) + 0.0722 * _lin(n & 255);
}
function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// WCAG AA for large bold text is 3:1, but the framework asks 4.5:1 — use the stricter bar.
function needsScrim(textHex, bgHex) { return contrastRatio(textHex, bgHex) < 4.5; }

// Safe rectangle for the headline on the given side. Off the 4 UI-hazard corners, inside the
// central band, above the bottom-15% progress-bar zone. W/H in px (designed at 1920x1080, scales).
function safeTextRect(W, H, side) {
  const sideMargin = Math.round(W * 0.06);
  const gutter = Math.round(W * 0.04);
  const top = Math.round(H * 0.10);
  const bottom = Math.round(H * 0.85);   // leaves the bottom 15% for the progress bar
  const midX = Math.round(W * 0.5);
  if (side === 'left') return { x: sideMargin, y: top, w: (midX - gutter) - sideMargin, h: bottom - top };
  return { x: midX + gutter, y: top, w: (W - sideMargin) - (midX + gutter), h: bottom - top };
}
// Hook word policy: 0-2 ideal, 3 allowed, 6+ rejected (clutter). Returns the (possibly trimmed) text.
function capHook(hook) {
  const words = String(hook || '').trim().split(/\s+/).filter(Boolean);
  return { text: words.slice(0, 5).join(' '), words: words.length, ok: words.length <= 3 };
}

function buildThumbArtPrompt(concept, _title, channelStyle) {
  const s = concept.subject || {};
  const side = concept.textSide || (s.gaze === 'left' ? 'left' : 'right');
  const accent = concept.accent || BOGY.orange;
  // Gaze: direct eye contact (at-camera) is the single biggest CTR lever for a face (~+20%), so it's the
  // default; side-gaze is only for deliberately leading the eye to a key element. Negative space for the
  // composited title still lives on `side` either way.
  const gazeClause = s.gaze === 'at-camera'
    ? 'The subject looks STRAIGHT INTO THE LENS — direct, locked eye contact with the viewer (a face making eye contact is the strongest click driver; render it convincingly).'
    : `The subject's eyes/gaze point toward the ${side}, leading the viewer's eye to the clean text zone.`;
  return [
    `[STYLE] Flat hand-drawn cartoon, bold black outlines, flat cels, light shading, no photorealism.${channelStyle ? ' ' + channelStyle : ''}`,
    `[SUBJECT] ${s.who || 'the cast member'} with a SPECIFIC, AUTHENTIC expression of ${s.emotion || 'genuine emotion'} (a real, readable feeling — never a generic open-mouth shock face); drawn exactly from the attached cast references.${concept.support ? ' Supporting element: ' + concept.support + '.' : ''}`,
    `[MOOD] ${concept.mood || 'tense, cinematic'}`,
    `[COMPOSITION] One dominant subject filling 40-60% of the frame, on the ${s.zone || 'left'} rule-of-thirds intersection, inside the middle 60-70%. Explicit depth: distinct background, mid-ground subject, foreground. ${gazeClause} The image should pose a VISUAL curiosity gap — a "wait, what?" moment (a surprising juxtaposition, an impossible-looking object, a partial reveal) the title can't state — not just a portrait. Reserve the ${side} 30-40% of the frame as CLEAN, uncluttered negative space (a title is composited there later).`,
    `[COLOR] ONE dominant accent color ${accent}. Reverse-contrast so the focal subject GLOWS against both light and dark UI (aim well past 4.5:1 subject-to-background contrast). NEVER wash the whole image a single color and NEVER use a flat mid-gray background — keep strong tonal contrast between subject and background.`,
    `[TECHNICAL] Wide 16:9, must read at 120x68 px on a phone (mobile is 70%+ of views): bold shapes, one clear focal point, nothing fiddly. Keep the face and key element OUT of the bottom-right corner (YouTube overlays the duration stamp there). Artwork BLEEDS off all four edges — no border, frame, matte or margin. The art is COMPLETELY TEXT-FREE: ZERO text, letters, numbers, headline, punch word, caption, sign, label, logo or watermark anywhere in the image — not even stylized or decorative lettering. The title is composited separately, so ANY lettering in the image is a defect; if any style note above implies adding a headline or word, IGNORE it and draw NONE.`,
  ].join('\n');
}

// ChatGPT-READY thumbnail prompt: a vivid, one-shot creative brief that renders the HEADLINE TEXT
// baked INTO the image (unlike buildThumbArtPrompt, which is text-free because the Studio overlays type
// deterministically). This is the manual fallback the Script page surfaces — paste into ChatGPT / GPT-image
// with the cast sheet attached and get a finished thumbnail in one go. Tolerant of sparse concepts.
function buildChatGptThumbPrompt(concept, _title, channelStyle) {
  concept = concept || {};
  const s = concept.subject || {};
  const lay = concept.layout || {};
  const who = (s.who && String(s.who).trim()) || 'the cast member';
  const emotion = (s.emotion && String(s.emotion).trim()) || 'a genuine, specific realization';
  const pose = String(lay.subject && lay.subject.pose || '').trim();
  const support = String(concept.support || '').trim();
  const mood = String(concept.mood || lay.mood || 'tense, cinematic').trim();
  const accent = resolveAccent(concept.accent || lay.accent);
  const side = (concept.textSide === 'left') ? 'LEFT' : 'RIGHT';
  const heroSide = side === 'RIGHT' ? 'LEFT' : 'RIGHT';   // hero sits opposite the text
  // Headline lines: prefer the structured layout.text [{line,role}], else split the hook (last word = accent).
  let lines = Array.isArray(lay.text) && lay.text.length
    ? lay.text.map((t) => ({ line: String(t.line || '').toUpperCase(), accent: t.role === 'accent' }))
    : capHook(concept.hook).text.toUpperCase().split(/\s+/).filter(Boolean).map((w, i, a) => ({ line: w, accent: i === a.length - 1 }));
  lines = lines.filter((l) => l.line);
  const OFFWHITE = '#F5F5F5';
  const lineSpec = lines.length
    ? lines.map((l, i) => `   Line ${i + 1}: "${l.line}" — in ${l.accent ? 'vivid accent ' + accent : 'off-white ' + OFFWHITE}`).join('\n')
    : '   (no headline)';
  const gaze = s.gaze === 'at-camera' || !s.gaze
    ? 'They stare STRAIGHT INTO THE CAMERA with locked, direct eye contact — the single biggest click driver, so render the eyes large, emotive and convincing.'
    : `Their gaze is turned toward the ${side.toLowerCase()}, leading the viewer's eye to the headline.`;
  return [
    `Create ONE finished 16:9 YouTube thumbnail (1280x720) in our channel's flat hand-drawn cartoon style: thick bold black outlines, flat SATURATED cel fills, light cel-shading, no photorealism, no painterly gradients.${channelStyle ? ' ' + channelStyle : ''}`,
    ``,
    `SCENE — ${mood}. On the ${heroSide}, drawn LARGE (filling ~55% of the frame) and matching the attached cast reference EXACTLY, is ${who}, showing a real, specific look of ${emotion}${pose ? ' (' + pose + ')' : ''}. ${gaze}${support ? ' ' + support[0].toUpperCase() + support.slice(1) + ' — a silent visual contrast that makes the viewer think "wait... what?".' : ''}`,
    ``,
    `HEADLINE TEXT — render this text INSIDE the image (do NOT leave it blank). In the clean negative space on the ${side} third of the frame, set a bold headline in a HEAVY CONDENSED sans-serif (Anton / Impact style), ALL CAPS, tightly stacked:`,
    lineSpec,
    `Make it BIG and dominant (each line roughly 18-24% of the frame height), with a thick dark outline (4-6px) and a soft drop shadow so it stays razor-sharp and legible even at 120x68 px on a phone. The text must NOT overlap the face or the key element. Spell every word EXACTLY as written.`,
    ``,
    `COLOR & CONTRAST — ONE dominant accent (${accent}) on the hero's focal point and the accent word; cool, desaturated tones everywhere else so the accent and the face POP. Reverse-contrast the subject so it glows against both light and dark UI (well past 4.5:1). Never a flat mid-gray wash, never a single full-image color cast.`,
    ``,
    `COMPOSITION & TECH — rule-of-thirds: hero on the ${heroSide}, headline on the ${side}, clear depth (background / mid-ground subject / foreground). Artwork bleeds off all four edges (no border, frame, matte or margin). Keep the face AND the headline OUT of the bottom-right corner (YouTube stamps the duration there). It must read instantly at tiny size: one clear focal point, bold shapes, nothing fiddly.`,
  ].join('\n');
}

// 9:16 VERTICAL variant for a Short's custom thumbnail/cover. Same two-layer philosophy as the
// main thumbnail — TEXT-FREE art (the punch word is composited/added separately) — but framed
// portrait, with the reacting face high and large so it reads at thumbnail size on the Shorts shelf.
// Tolerant of sparse input (Claude may omit fields): every field has a sane default.
function buildShortThumbPrompt(concept, channelStyle) {
  concept = concept || {};
  const who = (concept.who && String(concept.who).trim()) || 'the cast member';
  const emotion = (concept.emotion && String(concept.emotion).trim()) || 'a genuine, specific emotion';
  const accent = resolveAccent(concept.accent);
  const support = String(concept.support || concept.scene || '').trim();
  const mood = String(concept.mood || 'tense, cinematic, high-curiosity').trim();
  return [
    `[STYLE] Flat hand-drawn cartoon, bold black outlines, flat cels, light shading, no photorealism.${channelStyle ? ' ' + channelStyle : ''}`,
    `[SUBJECT] ${who} with a SPECIFIC, AUTHENTIC expression of ${emotion} (never a generic open-mouth shock face), looking STRAIGHT AT THE VIEWER (direct eye contact reads strongest at tiny shelf size); drawn exactly from the attached cast references.${support ? ' Scene / supporting element: ' + support + '.' : ''}`,
    `[MOOD] ${mood}`,
    `[COMPOSITION] Vertical 9:16 thumbnail for a Short — it is seen TINY on the Shorts shelf, so ONE dominant face/subject fills the UPPER 55-70% of the frame, large and high, reading instantly at a glance. Explicit depth: distinct background, mid-ground subject, foreground. Keep the BOTTOM third comparatively clean and uncluttered (a bold punch word is composited there later).`,
    `[COLOR] ONE dominant accent color ${accent}. Reverse-contrast so the focal subject GLOWS against both light and dark feeds. NEVER wash the whole image a single color — keep strong tonal contrast between subject and background.`,
    `[TECHNICAL] Tall vertical 9:16 (1080x1920 portrait). Artwork BLEEDS off all four edges — no border, frame, matte or margin. The art is COMPLETELY TEXT-FREE: ZERO text, letters, numbers, headline, punch word, caption, sign, label, logo or watermark anywhere in the image — not even stylized or decorative lettering. The punch word is composited separately, so ANY lettering in the image is a defect; draw NONE.`,
  ].join('\n');
}

// Distil a 1-3 word ALL-CAPS punch word for a Short thumbnail from the best available source.
function shortPunchWord(s) {
  return String(s || '').replace(/["'.,!?]/g, '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ').toUpperCase();
}

// Framework gate for a thumbnail CONCEPT (the structured "angle" that feeds the art prompt).
// Returns { ok, issues[] }. ok === true only when every framework field is present + valid.
function validateConcept(c) {
  const issues = [];
  c = c || {};
  const s = c.subject || {};
  if (!(s.who && typeof s.who === 'string' && s.who.trim())) issues.push('no subject');
  if (!(s.emotion && typeof s.emotion === 'string' && s.emotion.trim()) || /\b(shocked?|shock)\b/i.test(String(s.emotion || ''))) issues.push('missing/banned emotion');
  if (!['left', 'right', 'at-camera'].includes(s.gaze)) issues.push('bad gaze');
  if (!capHook(c.hook).ok) issues.push('hook too long');
  if (!['left', 'right'].includes(c.textSide)) issues.push('bad textSide');
  if (!/^#?[0-9a-f]{6}$/i.test(String(c.accent || ''))) issues.push('bad accent');
  return { ok: issues.length === 0, issues };
}

module.exports = { BOGY, NAMED_ACCENTS, resolveAccent, relativeLuminance, contrastRatio, needsScrim, safeTextRect, capHook, buildThumbArtPrompt, buildChatGptThumbPrompt, buildShortThumbPrompt, shortPunchWord, validateConcept };
