#!/usr/bin/env node
// QC scanner: asks Gemini vision to judge whether each rendered scene image still matches the
// channel's house style (flat hand-drawn cartoon, bold black outlines, flat color + light shading,
// NO photorealism/gradients/3D — see the channel's _assets/style-bible.md §1). Unlike scan-image-borders.mjs
// (pure pixel math, free), this makes ONE Gemini text+vision call per image — cheap
// (gemini-3.6-flash, a fraction of a cent/image) but NOT free, so it is a deliberate, manually-run
// audit tool, same category as the optional Pexels/Veo features (CLAUDE.md §6) — not wired into the
// free /api/qc checks that run on every QC-tab load. Run it as part of a video's QC sweep, or narrow
// it to specific beats you're suspicious of.
//
//   node _studio/scan-image-style.mjs MyChannel/001-my-first-video/04-assets/images
//   node _studio/scan-image-style.mjs <images-dir> 073.png 074.png     # just these files
//
// Exit code 1 if anything is flagged (so it can gate a script), 0 otherwise.
import fs from 'node:fs';
import path from 'node:path';

const SECRETS_FILE = new URL('.secrets.json', import.meta.url);
function getGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try { return (JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8').replace(/^﻿/, '')) || {}).geminiKey || ''; }
  catch (_) { return ''; }
}
function sniffMime(buf) {
  if (buf && buf.length > 11) {
    const h = buf.slice(0, 4).toString('hex');
    if (h === '89504e47') return 'image/png';
    if (h.startsWith('ffd8ff')) return 'image/jpeg';
  }
  return 'image/png';
}

const STYLE_PROMPT = `You are a visual-style QC reviewer for an animated YouTube channel. The channel's house style is:
flat hand-drawn cartoon illustration — bold, thick, hand-drawn black outlines; MAIN SUBJECTS (hands,
characters, objects, creatures) are flat color fills with at most light/flat cel-shading, never
continuous photographic gradients, airbrushed shading, photorealistic rendering, 3D render, or
photo-real skin/material texture.

KNOWN, ALLOWED, NOT a defect: a small glowing "halo"/bloom effect around a light source, magical
object, or psychoactive/supernatural element (e.g. a glowing mushroom, a luminous swirl icon) — this
is a deliberate recurring accent in the house style. A soft radial glow confined to a small
background accent does NOT make an image off-style. Only judge the MAIN SUBJECT'S own rendering
technique (its outlines, fill, and shading), not any glow/light effect around it.

Look at the attached image and answer with ONLY a single-line minified JSON object, no markdown
fences, no commentary:
{"onStyle": true|false, "reason": "<one short phrase — what you saw>"}

"onStyle" is false ONLY if the main subject itself (not a background glow accent) is rendered with
continuous photographic/painterly shading, soft gradients across its form, or photorealistic detail
instead of flat cartoon outlines+fills. "onStyle" is true if the main subject reads as flat
hand-drawn cartoon art, even if a small glow/bloom accent appears elsewhere in the frame.`;

const VISION_MODEL = 'gemini-3.6-flash';   // text+vision judge model; server.js's image-GEN models (2.5-flash-image / 3-pro-image) are separate and unaffected

async function geminiVisionJudge(key, imgBuf, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: STYLE_PROMPT }, { inline_data: { mime_type: mime, data: imgBuf.toString('base64') } }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 60000);
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) { throw new Error(ctrl.signal.aborted ? 'Gemini vision request timed out' : ('Gemini vision request failed: ' + (e && e.message || e))); }
  finally { clearTimeout(to); }
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!r.ok) throw new Error('Gemini API ' + r.status + ': ' + ((j && j.error && j.error.message) || txt.slice(0, 200)));
  const cps = (((j || {}).candidates || [])[0] || {}).content;
  const out = ((cps && cps.parts) || []).map((p) => p.text || '').join('').trim();
  if (!out) throw new Error('No text returned by Gemini');
  const cleaned = out.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  let parsed; try { parsed = JSON.parse(cleaned); } catch (_) { throw new Error('Unparseable verdict: ' + cleaned.slice(0, 200)); }
  if (typeof parsed.onStyle !== 'boolean') throw new Error('Missing onStyle in verdict: ' + cleaned.slice(0, 200));
  return parsed;
}

async function withRetry(fn, tries = 3, delayMs = 3000) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try { return await fn(); } catch (e) { lastErr = e; if (a < tries - 1) await new Promise((r) => setTimeout(r, delayMs * (a + 1))); }
  }
  throw lastErr;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: node scan-image-style.mjs <images-dir> [file1.png file2.png ...]'); process.exit(1); }
const explicit = process.argv.slice(3);
const files = (explicit.length ? explicit : fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f))).sort();

const key = getGeminiKey();
if (!key) { console.error('No Gemini API key set (GEMINI_API_KEY env or _studio/.secrets.json geminiKey).'); process.exit(1); }

const flagged = [];
const errored = [];
for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { errored.push([f, 'not found']); continue; }
  const buf = fs.readFileSync(p);
  try {
    const verdict = await withRetry(() => geminiVisionJudge(key, buf, sniffMime(buf)));
    const tag = verdict.onStyle ? 'ok  ' : 'FLAG';
    console.log(`${tag}  ${f}  — ${verdict.reason || ''}`);
    if (!verdict.onStyle) flagged.push({ file: f, reason: verdict.reason || '' });
  } catch (e) {
    console.log(`ERR   ${f}  — ${String(e && e.message || e)}`);
    errored.push([f, String(e && e.message || e)]);
  }
}
console.log(`\nScanned ${files.length} image(s) in ${dir}`);
console.log(`Flagged (style drift): ${flagged.length ? flagged.map((x) => x.file).join(', ') : 'none'}`);
if (errored.length) console.log(`Errors: ${errored.map(([f]) => f).join(', ')}`);
process.exit((flagged.length || errored.length) ? 1 : 0);
