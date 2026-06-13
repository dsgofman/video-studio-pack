#!/usr/bin/env node
/*
 * YouTube Studio — tiny zero-dependency local server.
 * Serves the Studio SPA and auto-saves the human's decisions into each video's studio.json.
 *
 * It only ever writes the `stages.<stage>.decision` objects (the human's calls) — it never
 * touches the `candidates` Claude generates. Run:  node _studio/server.js   (or: npm start)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');           // workspace root (Z:\Youtube)
const PORT = process.env.PORT || 4317;
const SYSTEM_DIRS = new Set(['_studio', '_templates', 'node_modules', '.git']);
// The Claude Code CLI used for headless generation. Override with CLAUDE_BIN if it isn't on PATH.
// Default: resolve `claude` from PATH (macOS/Linux + most Windows installs); fall back to a known
// Windows install path if PATH resolution isn't set up. (Cross-platform so the Studio is portable.)
const WIN_CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');   // common install spot; no hardcoded username
const CLAUDE = process.env.CLAUDE_BIN
  || (process.platform === 'win32'
    ? (fs.existsSync(WIN_CLAUDE) ? WIN_CLAUDE : 'claude.cmd')
    : 'claude');
const startedSessions = new Set();   // which video chats have a live Claude session
const generatingScripts = new Set(); // which videos currently have a script job running
const generatingScenes = new Set();  // which videos currently have a scene job running
const generatingIdeas = new Set();   // videos currently brainstorming idea candidates
const generatingPackaging = new Set(); // videos currently generating packaging titles
const generatingShorts = new Set();    // videos with a Shorts-Lab analysis running
const renderingShorts = new Set();     // short clips rendering (key: ch|id|clipId)

function sessionId(key) {
  const h = crypto.createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function chatSystemPrompt(studioFile) {
  return [
    'You are the in-Studio assistant embedded in a local YouTube "Video Studio" web app, chatting with the channel operator while they work on one video.',
    `The Studio UI is driven by this file: ${studioFile}`,
    'It holds stages.packaging.candidates.titles[] and .thumbnails[] — each thumbnail has a structured `layout` object (the Studio renders it into a wireframe + drives the final-art prompt).',
    'The cast (Max, Luna, Zed, Nova), the art style, and the rules live in History/_assets/style-bible.md, History/_assets/character-sheet/cast-sheet.png, and CLAUDE.md.',
    'When the operator asks to add / change / regenerate a title or thumbnail, EDIT that studio.json directly with the Write/Edit tools:',
    '- Keep the file VALID JSON and preserve the stages.packaging.decision object exactly.',
    '- A thumbnail = { id (unique "th-..."), name (short), rationale (short), layout: { bg (one of sky|dawn|sunset|ember|night|ocean|snow|forest|sand|stone|cave|blizzard), accent (hex; ONE accent), subject:{ who (Max|Luna|Zed|Nova|none), pose (short), zone (left|center|right), scale (hero|medium) }, props (<=3 short labels), text:[{line (UPPERCASE 1-3 words), role (accent|dark|white)}], textZone (left|right|center|top|bottom) } } — use the structured `layout`, NOT raw svg; max 2-3 elements, ONE accent, key subject in the left ~60%, legible at 120x68 (style-bible §9).',
    '- The UI auto-refreshes when you finish, so the operator will see your changes.',
    'Reply in 1-4 short, conversational sentences describing what you changed or answering the question. Never paste raw SVG or JSON into the chat. Be a sharp, opinionated creative partner.',
  ].join('\n');
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', done = false;
    const finish = (r) => { if (done) return; done = true; if (t) clearTimeout(t); resolve(r); };
    const t = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish({ code: -2, out, err: err + '\n[killed: exceeded ' + timeoutMs + 'ms]' }); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: -1, out: '', err: String(e) }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

// ---- Image generation (Gemini 2.5 Flash Image / "Nano Banana") ----
const generatingImages = new Set();    // videos with a full image run in progress
const regeneratingScenes = new Set();  // single scenes being re-rendered (key: ch|id|n)
const generatingNarration = new Set(); // videos with a full narration run in progress
const revoicingScenes = new Set();     // single beats being re-voiced (key: ch|id|n)
const renderingFrames = new Set();     // single reveal/reaction frames being rendered (key: ch|id|n|f|idx)
const assembling = new Set();           // videos with a rough-cut render in progress
const renderingMaps = new Set();        // videos with an accurate-map still render in progress
const generatingThumbs = new Set();     // videos with final thumbnail art generating
const RENDER_DIR = path.join(__dirname, 'render');
// Remotion bundles into the OS temp dir; point render children at Z: so a tight C: never breaks renders.
const RENDER_TMP = path.join(RENDER_DIR, '.tmp');
const renderEnv = () => { try { fs.mkdirSync(RENDER_TMP, { recursive: true }); } catch (_) {} return Object.assign({}, process.env, { TEMP: RENDER_TMP, TMP: RENDER_TMP }); };
const GEMINI_MODEL = 'gemini-2.5-flash-image';
const SECRETS_FILE = path.join(__dirname, '.secrets.json');   // local only, never shared
const CAST = [
  { name: 'Max', desc: 'light skin, brown tousled/spiky hair, brown hide tunic' },
  { name: 'Luna', desc: 'light skin, long blonde hair, brown hide tunic' },
  { name: 'Zed', desc: 'light skin, brown spiky hair, brown hide tunic' },
  { name: 'Nova', desc: 'dark skin, dark tousled hair, brown hide tunic' },
];
function readSecrets() { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return {}; } }   // BOM-tolerant
function writeSecrets(patch) { const s = readSecrets(); Object.assign(s, patch); fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2)); return s; }
function getGeminiKey() { return process.env.GEMINI_API_KEY || readSecrets().geminiKey || ''; }

// ---- Per-channel cast roster (the "character bank"). cast.json is the source of truth; the built-in
//      CAST above is the seed/fallback. Entry: { name, desc, color? }. Portraits live as <name>.png. ----
function castFile(channel) { return path.join(ROOT, channel, '_assets', 'character-sheet', 'cast.json'); }
function readCast(channel) {
  try { const c = JSON.parse(fs.readFileSync(castFile(channel), 'utf8')); if (Array.isArray(c) && c.length) return c; } catch (_) {}
  return CAST;
}
function writeCast(channel, roster) {
  const f = castFile(channel); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(roster, null, 2)); return roster;
}
// Generate/refresh ONE character's reference portrait in the channel's exact style (cast sheet as anchor).
async function genCharRef(channel, name, desc, slug) {
  const key = getGeminiKey();
  if (!key) throw new Error('No Gemini API key set.');
  const refDir = sheetDirFor(channel, slug) || path.join(ROOT, channel, '_assets', 'character-sheet');   // slug → that sheet's dir
  const sheet = path.join(refDir, 'cast-sheet.png');
  const own = path.join(refDir, name + '.png');
  const refs = [];
  if (fs.existsSync(sheet)) refs.push(sheet);
  if (fs.existsSync(own)) refs.push(own);   // keep an existing character consistent with itself
  const prompt = `Draw ONLY the character ${name} (${desc || 'a person'}) — full body, neutral relaxed pose, facing forward, on a plain white background, in the EXACT flat hand-drawn colored cartoon stick-figure style of the attached reference(s): same line weight, big expressive eyes, flat colors with light shading. No other characters, no text, no background scene. A clean single-character reference.`;
  const buf = await geminiImage(key, prompt, refs);
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(own, buf);
  return name;
}
// Reference dir for a video's image generation = the ACTIVE character sheet for that video. Priority:
// a per-video CUSTOM sheet (<video>/04-assets/cast/) > the channel sheet the video selected
// (studio.json.sheetSlug → <channel>/_assets/sheets/<slug>/) > the channel default character-sheet.
// (activeSheet() is declared further down; function declarations hoist, so this resolves at call time.)
function castRefDir(channel, id) {
  return activeSheet(channel, id).dir;
}

// ---- Shared plumbing: per-file write lock (parallel jobs persist into the same studio.json),
//      retry with backoff for flaky API calls, a small worker pool, and usage/cost tracking ----
const fileLocks = new Map();
function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(file, next.then(() => {}, () => {}));
  return next;
}
async function withRetry(fn, tries = 2, delayMs = 1500) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try { return await fn(); } catch (e) { lastErr = e; if (a < tries - 1) await new Promise((r) => setTimeout(r, delayMs * (a + 1))); }
  }
  throw lastErr;
}
async function mapPool(items, limit, worker) {
  const ret = new Array(items.length); let i = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const k = i++; try { ret[k] = await worker(items[k], k); } catch (e) { ret[k] = { __err: String(e && e.message || e) }; } }
  });
  await Promise.all(lanes);
  return ret;
}
// Usage ledger: _studio/usage.json — per-video Gemini image count + ElevenLabs character count.
const USAGE_FILE = path.join(__dirname, 'usage.json');
const PRICE_PER_IMAGE = 0.039;                         // Gemini 2.5 Flash Image, USD
function usageKeyFromSp(sp) { return path.relative(ROOT, path.dirname(sp)).split(path.sep).join('/'); }
function logUsage(key, patch) {
  return withFileLock(USAGE_FILE, () => {
    let u = {}; try { u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) {}
    const v = u[key] = u[key] || { images: 0, ttsChars: 0 };
    v.images += patch.images || 0;
    v.ttsChars += patch.ttsChars || 0;
    v.updatedAt = new Date().toISOString();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
  });
}
function readUsage() { try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) { return {}; } }
// Returns a PNG Buffer or throws with a readable message. Passes reference images for consistency.
async function geminiImage(key, promptText, imagePaths) {
  const parts = [{ text: promptText }];
  for (const p of imagePaths || []) {
    if (p && fs.existsSync(p)) {
      const mime = /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png';
      parts.push({ inline_data: { mime_type: mime, data: fs.readFileSync(p).toString('base64') } });
    }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const call = async (genCfg) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: genCfg }),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) { /* leave null */ }
    return { ok: r.ok, status: r.status, j, txt };
  };
  // Try with 16:9 aspect ratio; if the field/config is rejected, retry minimal (16:9 is also in the prompt).
  let res = await call({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } });
  if (!res.ok) res = await call({ responseModalities: ['IMAGE'] });
  if (!res.ok) {
    const m = (res.j && res.j.error && res.j.error.message) || (res.txt || '').slice(0, 300);
    throw new Error('Gemini API ' + res.status + ': ' + m);
  }
  const cps = (((res.j || {}).candidates || [])[0] || {}).content;
  for (const part of (cps && cps.parts) || []) {
    const inl = part.inlineData || part.inline_data;
    if (inl && inl.data) return Buffer.from(inl.data, 'base64');
  }
  throw new Error('No image returned by Gemini: ' + JSON.stringify(res.j || res.txt).slice(0, 300));
}

// Style suffix appended to every generation. Illustrations stay CLEAN (no baked caption — text is a
// CapCut overlay added later, top-center) and leave headroom; infographics ARE the diagram + short labels.
const STYLE_SUFFIX = {
  illustration: ' Keep the characters EXACTLY consistent with the reference images — same face, hair, skin tone, hide tunic and proportions. Flat colored hand-drawn stick-figure style, bold outlines, no photorealism. Do NOT draw any text, letters, captions, labels, speech bubbles, boxes, banners, frames or UI of any kind anywhere in the image. Compose ONE single cohesive scene that fills the ENTIRE frame edge to edge — never a split/diptych/before-after/multi-panel layout, and NO white border, margin, frame or gutter around the image. Keep the upper third of the frame calm and uncluttered — open sky or plain background. Wide 16:9 landscape.',
  infographic: ' Render this as a clean hand-drawn INFOGRAPHIC in the same flat colored doodle style as the references (bold black outlines, flat fills, no photorealism, no gradients) — a clear diagram / map / timeline / comparison. Keep any labels SHORT and spelled exactly. If a cast character appears, match the references. Wide 16:9 landscape with generous margins.',
};

// Reference images for a scene. Illustrations: cast sheet + each named character + the previous frame
// (continuity). Infographics: cast sheet (for style) + any named characters, but NOT the previous frame,
// so the diagram isn't biased to copy the prior shot.
function imageRefsFor(scenes, idx, refDir, sheet, imgDir) {
  const s = scenes[idx];
  const refs = []; if (fs.existsSync(sheet)) refs.push(sheet);
  for (const c of (s.characters || [])) { const cp = path.join(refDir, c + '.png'); if (fs.existsSync(cp)) refs.push(cp); }
  if (s.kind !== 'infographic' && idx > 0) { const pn = String(scenes[idx - 1].n || idx).padStart(3, '0'); const pf = path.join(imgDir, pn + '.png'); if (fs.existsSync(pf)) refs.push(pf); }
  return refs;
}

// Render ONE scene via Gemini, save the PNG, and persist its imagePath into studio.json. Returns the relative path.
async function renderScene(key, sp, scenes, idx, imgDir, refDir, sheet) {
  const s = scenes[idx];
  const nn = String(s.n || (idx + 1)).padStart(3, '0');
  const outAbs = path.join(imgDir, nn + '.png');
  const suffix = STYLE_SUFFIX[s.kind === 'infographic' ? 'infographic' : 'illustration'];
  const buf = await geminiImage(key, (s.imagePrompt || s.visual || '') + suffix, imageRefsFor(scenes, idx, refDir, sheet, imgDir));
  fs.writeFileSync(outAbs, buf);
  logUsage(usageKeyFromSp(sp), { images: 1 });
  const rel = '04-assets/images/' + nn + '.png';
  await withFileLock(sp, () => {
    const live = JSON.parse(fs.readFileSync(sp, 'utf8'));   // re-read + persist so the UI can poll progress
    const ls = live.stages.scenes && live.stages.scenes.candidates && (live.stages.scenes.candidates.scenes || []).find((x) => String(x.n) === String(s.n));
    if (ls) { ls.imagePath = rel; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
  });
  return rel;
}

// A reveal/reaction frame is a DELTA off the previous frame — match it exactly, change only what's asked.
const FRAME_SUFFIX = ' Match the attached previous frame EXACTLY — same art style, composition, colors, characters, framing and layout. Change ONLY what this instruction describes. Flat colored hand-drawn stick-figure style, bold outlines, no photorealism, no caption text. Wide 16:9 landscape.';
// Render additional frame j (0-based) of scene idx, using the previous frame as the anchor. Saves NNN-f{j+1}.png.
async function renderFrame(key, sp, scenes, idx, j, imgDir, refDir, sheet) {
  const s = scenes[idx];
  const fr = (s.frames || [])[j];
  if (!fr) throw new Error('frame ' + j + ' not found');
  const nn = String(s.n || (idx + 1)).padStart(3, '0');
  const prevAbs = j === 0 ? path.join(imgDir, nn + '.png') : path.join(imgDir, nn + '-f' + j + '.png');
  const refs = []; if (fs.existsSync(sheet)) refs.push(sheet);
  for (const c of (s.characters || [])) { const cp = path.join(refDir, c + '.png'); if (fs.existsSync(cp)) refs.push(cp); }
  if (fs.existsSync(prevAbs)) refs.push(prevAbs);
  const buf = await geminiImage(key, (fr.prompt || '') + FRAME_SUFFIX, refs);
  fs.writeFileSync(path.join(imgDir, nn + '-f' + (j + 1) + '.png'), buf);
  logUsage(usageKeyFromSp(sp), { images: 1 });
  const rel = '04-assets/images/' + nn + '-f' + (j + 1) + '.png';
  await withFileLock(sp, () => {
    const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const ls = live.stages.scenes && live.stages.scenes.candidates && (live.stages.scenes.candidates.scenes || []).find((x) => String(x.n) === String(s.n));
    if (ls && ls.frames && ls.frames[j]) { ls.frames[j].imagePath = rel; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
  });
  return rel;
}

// ---- Narration (ElevenLabs TTS) — per-beat clips, with exact durations from the timestamp endpoint ----
// Default model is turbo_v2_5: same quality tier for narration at HALF the credit burn of
// multilingual_v2 (≈0.5 credits/char) — the difference between needing Creator and fitting Starter.
const ELEVEN_DEFAULTS = { voiceId: 'nPczCjzI2devNBz1zQrb', model: 'eleven_turbo_v2_5', stability: 0.45, style: 0.30 };
// Voice identity is PER-CHANNEL (each channel has its own branded narrator): <channel>/_assets/voice.json
// overrides the global .secrets.json fields; the ElevenLabs API key itself is always global.
function channelVoiceFile(channel) { return path.join(ROOT, channel, '_assets', 'voice.json'); }
function getElevenCfg(channel) {
  const s = readSecrets();
  let cv = {};
  if (channel && safeSeg(channel)) { try { cv = JSON.parse(fs.readFileSync(channelVoiceFile(channel), 'utf8')); } catch (_) {} }
  return {
    key: process.env.ELEVENLABS_API_KEY || s.elevenKey || '',
    voiceId: cv.voiceId || s.elevenVoiceId || ELEVEN_DEFAULTS.voiceId,
    model: cv.model || s.elevenModel || ELEVEN_DEFAULTS.model,
    stability: typeof cv.stability === 'number' ? cv.stability : (typeof s.elevenStability === 'number' ? s.elevenStability : ELEVEN_DEFAULTS.stability),
    style: typeof cv.style === 'number' ? cv.style : (typeof s.elevenStyle === 'number' ? s.elevenStyle : ELEVEN_DEFAULTS.style),
    scope: cv.voiceId ? 'channel' : 'global',
  };
}
// Returns { buf: <mp3 Buffer>, seconds }. Uses /with-timestamps so we get exact duration without parsing MP3.
async function elevenTTS(cfg, text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/with-timestamps`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.model, voice_settings: { stability: cfg.stability, similarity_boost: 0.75, style: cfg.style, use_speaker_boost: true } }),
  });
  const txt = await r.text();
  if (!r.ok) {
    let m = (txt || '').slice(0, 300);
    try { const j = JSON.parse(txt); m = (j.detail && (j.detail.message || (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)))) || j.message || m; } catch (_) { /* keep raw */ }
    throw new Error('ElevenLabs ' + r.status + ': ' + m);
  }
  let j = null; try { j = JSON.parse(txt); } catch (_) { throw new Error('ElevenLabs: unexpected non-JSON response'); }
  const b64 = j.audio_base64 || j.audio;
  if (!b64) throw new Error('ElevenLabs: no audio returned');
  const al = j.alignment || j.normalized_alignment || {};
  const ends = al.character_end_times_seconds || [];
  // Exact spoken length + a 0.6s breathing gap (documentary rhythm: the cut never lands flush on
  // the last syllable, and ~94 beats of gaps keep an 8-min script safely past the 8:00 mid-roll line).
  const seconds = ends.length ? Math.max(1, Math.round((ends[ends.length - 1] + 0.6) * 100) / 100) : Math.max(1, Math.round(text.length / 14));
  return { buf: Buffer.from(b64, 'base64'), seconds };
}
// Voice ONE beat, save NNN.mp3, persist audioPath + audioSeconds. Returns { rel, seconds } or null (no narration).
async function renderNarration(cfg, sp, scenes, idx, audioDir) {
  const s = scenes[idx];
  // voiceText is the TTS-only override (pauses via <break time="1.2s"/>, pronunciation fixes) — keeps the
  // display `narration` clean for captions/chapters/word-count. Falls back to narration when absent.
  const text = (s.voiceText || s.narration || '').trim();
  if (!text) return null;
  const nn = String(s.n || (idx + 1)).padStart(3, '0');
  const { buf, seconds } = await elevenTTS(cfg, text);
  fs.writeFileSync(path.join(audioDir, nn + '.mp3'), buf);
  logUsage(usageKeyFromSp(sp), { ttsChars: text.length });
  const rel = '04-assets/audio/' + nn + '.mp3';
  await withFileLock(sp, () => {
    const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const ls = live.stages.scenes && live.stages.scenes.candidates && (live.stages.scenes.candidates.scenes || []).find((x) => String(x.n) === String(s.n));
    if (ls) { ls.audioPath = rel; ls.audioSeconds = seconds; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
  });
  return { rel, seconds };
}

// ---- Scene CSV parsing (server imports Claude's CSV -> studio.json, fast & reliable) ----
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, inq = false;
  while (i < text.length) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inq = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inq = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function importScenesCsv(folder) {
  const csv = fs.readFileSync(path.join(folder, '03-scenes', 'scene-list.csv'), 'utf8');
  const rows = parseCSV(csv).filter((r) => r.length > 1 && r.some((x) => x && x.trim()));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const ix = (n) => header.indexOf(n);
  const ci = { scene: ix('scene'), segment: ix('segment'), seconds: ix('seconds'), kind: ix('kind'), characters: ix('characters'), narration: ix('narration'), visual: ix('visual'), onscreen: ix('on_screen_text'), textpos: ix('text_pos'), textanim: ix('text_anim'), motion: ix('motion'), sfx: ix('sfx'), ambient: ix('ambient'), musiccue: ix('music_cue'), castaction: ix('cast_action'), prompt: ix('image_prompt') };
  // Cast names for the fallback character-detection come from THIS video's ACTIVE sheet roster (not a
  // hardcode) — so a video using a custom/Neanderthal sheet detects ITS characters by name.
  const __pp = path.relative(ROOT, folder).split(path.sep);
  const NAMES = videoRoster(__pp[0] || '', __pp[1] || '').map((c) => c.name);
  const POS = ['top-center', 'center', 'lower-third', 'none'];
  const MOTION = ['push-in', 'push-out', 'pan-left', 'pan-right', 'static'];
  const TANIM = ['punch', 'fade', 'type', 'none'];
  const CUE = ['act1', 'rehook', 'act2', 'payoff', 'outro'];
  const scenes = rows.map((row, k) => {
    const prompt = (row[ci.prompt] || '').trim();
    const narration = (row[ci.narration] || '').trim();
    let chars = [];
    if (ci.characters >= 0 && row[ci.characters]) chars = row[ci.characters].split(/[|,;]/).map((s) => s.trim()).filter(Boolean);
    if (!chars.length) { const hay = prompt + ' ' + narration; chars = NAMES.filter((n) => new RegExp('\\b' + n + '\\b', 'i').test(hay)); }
    const kind = (ci.kind >= 0 && /info/i.test(row[ci.kind] || '')) ? 'infographic' : 'illustration';
    const onScreenText = ci.onscreen >= 0 ? (row[ci.onscreen] || '').trim() : '';
    let textPos = ci.textpos >= 0 ? (row[ci.textpos] || '').trim().toLowerCase() : '';
    if (!POS.includes(textPos)) textPos = onScreenText ? 'top-center' : 'none';
    let motion = ci.motion >= 0 ? (row[ci.motion] || '').trim().toLowerCase() : '';
    if (!MOTION.includes(motion)) motion = kind === 'infographic' ? 'static' : 'push-in';
    let textAnim = ci.textanim >= 0 ? (row[ci.textanim] || '').trim().toLowerCase() : '';
    if (!TANIM.includes(textAnim)) textAnim = onScreenText ? 'punch' : 'none';
    const sfx = ci.sfx >= 0 && row[ci.sfx] ? row[ci.sfx].split(/[|,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    const ambient = ci.ambient >= 0 ? (row[ci.ambient] || '').trim().toLowerCase().replace(/^none$/, '') : '';
    let musicCue = ci.musiccue >= 0 ? (row[ci.musiccue] || '').trim().toLowerCase() : '';
    if (!CUE.includes(musicCue)) musicCue = '';
    const castAction = ci.castaction >= 0 ? (row[ci.castaction] || '').trim() : '';
    return { n: parseInt(row[ci.scene], 10) || (k + 1), segment: (row[ci.segment] || '').trim(), seconds: parseInt(row[ci.seconds], 10) || 6, kind, narration, visual: (row[ci.visual] || '').trim(), characters: chars, onScreenText, textPos, textAnim, motion, sfx, ambient, musicCue, castAction, imagePrompt: prompt };
  // Reject template/placeholder rows (their fields are literal `<...>` stubs) so a FAILED scene
  // generation surfaces as "no scenes" instead of silently importing one garbage beat.
  }).filter((s) => s.imagePrompt && !/[<>]/.test(s.imagePrompt) && !/[<>]/.test(s.narration));
  return { scenes, totalSeconds: scenes.reduce((a, s) => a + (s.seconds || 0), 0) };
}

// Re-importing the CSV must NOT throw away generated assets (images cost real money, narration
// costs credits, map specs are hand-tuned) — carry them over from the old scenes by scene number.
function mergeScenes(prevScenes, nextScenes) {
  const prev = new Map((prevScenes || []).map((s) => [String(s.n), s]));
  for (const s of nextScenes) {
    const old = prev.get(String(s.n));
    if (!old) continue;
    for (const k of ['imagePath', 'audioPath', 'audioSeconds', 'frames', 'map'])
      if (old[k] !== undefined && s[k] === undefined) s[k] = old[k];
    if (old.kind === 'map') s.kind = 'map';   // accurate-map beats stay maps — Gemini must not overwrite the d3 still
  }
  return nextScenes;
}

function safeSeg(s) {
  // reject anything that could escape the workspace
  return typeof s === 'string' && s.length > 0 && !s.includes('..') &&
    !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

function listVideos() {
  const out = [];
  for (const channel of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!channel.isDirectory() || channel.name.startsWith('_') || SYSTEM_DIRS.has(channel.name)) continue;
    const chDir = path.join(ROOT, channel.name);
    for (const vid of fs.readdirSync(chDir, { withFileTypes: true })) {
      if (!vid.isDirectory() || vid.name.startsWith('_')) continue;
      const studioFile = path.join(chDir, vid.name, 'studio.json');
      if (!fs.existsSync(studioFile)) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(studioFile, 'utf8'));
        const pk = ((doc.stages || {}).packaging || {});
        const locked = ((pk.candidates || {}).titles || []).find((t) => t.id === (pk.decision || {}).primaryTitle);
        const act = ((((doc.stages || {}).scenes || {}).candidates || {}).scenes || []).filter((s) => !s.exclude);
        out.push({
          channel: channel.name,
          id: vid.name,
          title: (locked && locked.text) || doc.workingTitle || vid.name,
          stages: Object.fromEntries(Object.entries(doc.stages || {}).map(([k, v]) => [k, v.status || 'locked'])),
          updatedAt: doc.updatedAt || null,
          meta: {
            beats: act.length,
            voiced: act.filter((s) => s.audioPath).length,
            imgs: act.filter((s) => s.imagePath).length,
            secs: Math.round(act.reduce((a, s) => a + (s.audioSeconds || s.seconds || 0), 0)),
            hasCut: fs.existsSync(path.join(chDir, vid.name, '05-edit', 'rough-cut.mp4')),
            thumb: fs.existsSync(path.join(chDir, vid.name, '00-packaging', 'thumbnails', 'final-1.png')),
            shorts: (((doc.stages || {}).shorts || {}).candidates || {}).clips ? doc.stages.shorts.candidates.clips.length : 0,
          },
        });
      } catch (_) { /* skip malformed */ }
    }
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// Channels = top-level folders that have a channel.md (the multi-channel roster).
function listChannels() {
  const out = [];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_') || SYSTEM_DIRS.has(d.name)) continue;
    if (!fs.existsSync(path.join(ROOT, d.name, 'channel.md'))) continue;
    let name = d.name;
    try {
      const head = fs.readFileSync(path.join(ROOT, d.name, 'channel.md'), 'utf8')
        .split('\n').find((l) => /^#\s+Channel:/i.test(l));
      if (head) name = head.replace(/^#\s+Channel:\s*/i, '').split(/[—–-]/)[0].trim() || d.name;
    } catch (_) {}
    out.push({ id: d.name, name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// kebab-case a topic into a folder slug (≤6 words).
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 6).join('-');
}

function studioPath(channel, id) {
  if (!safeSeg(channel) || !safeSeg(id)) return null;
  const p = path.join(ROOT, channel, id, 'studio.json');
  if (!p.startsWith(ROOT)) return null;
  return p;
}

// ---- Character SHEET BANK ------------------------------------------------------------------------
// A "sheet" is a named set of characters + a group cast-sheet.png + per-character portraits. Channel
// sheets live in <channel>/_assets/sheets/<slug>/ (cast-sheet.png + cast.json + <name>.png + meta.json).
// The legacy <channel>/_assets/character-sheet/ is the implicit DEFAULT sheet (slug '__default'). A
// video either selects a channel sheet (studio.json.sheetSlug) or carries its OWN custom sheet in
// <video>/04-assets/cast/ (uploaded / generated / adapted just for that episode). This is what lets a
// Neanderthal episode bring its own cast without touching other videos.
function sheetDirFor(channel, slug) {
  if (!slug || slug === '__default') return path.join(ROOT, channel, '_assets', 'character-sheet');
  if (!safeSeg(slug)) return null;
  return path.join(ROOT, channel, '_assets', 'sheets', slug);
}
function readSheetRoster(channel, slug) {
  if (!slug || slug === '__default') return readCast(channel);   // default sheet = the channel roster
  const dir = sheetDirFor(channel, slug); if (!dir) return [];
  try { const c = JSON.parse(fs.readFileSync(path.join(dir, 'cast.json'), 'utf8')); if (Array.isArray(c)) return c; } catch (_) {}
  return [];
}
function writeSheetRoster(channel, slug, roster) {
  if (!slug || slug === '__default') return writeCast(channel, roster);
  const dir = sheetDirFor(channel, slug); if (!dir) return;
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'cast.json'), JSON.stringify(roster, null, 2));
}
function listSheets(channel) {
  const out = [];
  const defDir = sheetDirFor(channel, '__default');
  out.push({ slug: '__default', title: 'Default cast', count: readCast(channel).length, hasImage: fs.existsSync(path.join(defDir, 'cast-sheet.png')), source: 'default' });
  const base = path.join(ROOT, channel, '_assets', 'sheets');
  let dirs = []; try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch (_) {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (_) {}
    out.push({ slug: d.name, title: meta.title || d.name, count: readSheetRoster(channel, d.name).length, hasImage: fs.existsSync(path.join(dir, 'cast-sheet.png')), source: meta.source || 'custom' });
  }
  return out;
}
// Resolve the ACTIVE sheet for a video: custom per-video sheet wins, then the selected channel sheet,
// then the default. Returns { kind, dir, slug }.
function activeSheet(channel, id) {
  if (id && safeSeg(id)) {
    const cdir = path.join(ROOT, channel, id, '04-assets', 'cast');
    if (fs.existsSync(path.join(cdir, 'cast-sheet.png'))) return { kind: 'custom', dir: cdir, slug: '__custom' };
  }
  let slug = '';
  if (id && safeSeg(id)) { try { const d = JSON.parse(fs.readFileSync(studioPath(channel, id), 'utf8')); slug = d.sheetSlug || ''; } catch (_) {} }
  if (slug && slug !== '__default') {
    const dir = sheetDirFor(channel, slug);
    if (dir && fs.existsSync(path.join(dir, 'cast-sheet.png'))) return { kind: 'sheet', dir, slug };
  }
  return { kind: 'default', dir: sheetDirFor(channel, '__default'), slug: '__default' };
}
// The roster (names + descs) for a video's active sheet.
function videoRoster(channel, id) {
  const a = activeSheet(channel, id);
  if (a.kind === 'custom') { try { const c = JSON.parse(fs.readFileSync(path.join(a.dir, 'cast.json'), 'utf8')); if (Array.isArray(c) && c.length) return c; } catch (_) {} return readCast(channel); }
  if (a.kind === 'sheet') { const r = readSheetRoster(channel, a.slug); return r.length ? r : readCast(channel); }
  return readCast(channel);
}

// ---- Per-video cast context for generators (script / scenes / thumbnails). roster + names come from
//      the ACTIVE sheet; `note` is an optional reskin instruction saved to studio.json.castAdapt. ----
function videoCast(channel, id) {
  const roster = videoRoster(channel, id);
  let doc = {}; const sp = studioPath(channel, id);
  if (sp) { try { doc = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (_) {} }
  const adapt = doc.castAdapt || {};
  const a = activeSheet(channel, id);
  const used = new Set(((((doc.stages || {}).scenes || {}).candidates || {}).scenes || []).flatMap((s) => s.characters || []));
  return { roster, names: roster.map((c) => c.name), used: [...used], note: String(adapt.note || '').trim(), adapted: a.kind !== 'default', sheet: a.slug };
}
// One prompt line describing the cast for a generator (script / scenes / thumbnails).
function castPromptLine(vc) {
  const names = vc.names.join(' / ') || '(no named characters)';
  if (vc.note) {
    return `CAST LOOK (per-video adaptation): the cast (${names}) appear in THIS video REIMAGINED — ${vc.note}. The Studio has matching adapted references, so describe each character in THAT look (era/species/wardrobe), NOT a default appearance. Keep each recognizable by name and hair.`;
  }
  if (vc.adapted) {
    return `CAST: this video uses a CUSTOM character sheet — the cast are ${names}. Use the attached cast sheet + per-character references for each one's exact look and keep them perfectly consistent across every scene. Do NOT substitute the channel's default characters.`;
  }
  return `CAST: the recurring cast are ${names} in the channel's standard hand-drawn look (use them where the beat calls for a character).`;
}
// REAL, already-produced videos in a channel (have a rough cut or an upload) + a locked title, newest
// first, excluding one id. The ONLY pool a "watch next" recommendation may draw from — never a video
// we haven't made yet.
function producedVideos(channel, excludeId) {
  const out = [];
  const chDir = path.join(ROOT, channel);
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name === excludeId) continue;
    const sp = path.join(chDir, d.name, 'studio.json');
    if (!fs.existsSync(sp)) continue;
    let doc; try { doc = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (_) { continue; }
    const hasCut = fs.existsSync(path.join(chDir, d.name, '05-edit', 'rough-cut.mp4'));
    const uploaded = !!(doc.youtube && doc.youtube.videoId);
    if (!hasCut && !uploaded) continue;
    const pk = (doc.stages || {}).packaging || {};
    const t = ((pk.candidates || {}).titles || []).find((x) => x.id === (pk.decision || {}).primaryTitle);
    const title = (t && t.text) || doc.workingTitle;
    if (!title) continue;
    out.push({ id: d.name, title, when: String(doc.updatedAt || '') });
  }
  out.sort((a, b) => b.when.localeCompare(a.when));
  return out;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Mirror of render/manifest.mjs beat rules: which scenes make the timeline and how long each holds.
// Used by the Shorts Lab so clip beat-ranges and on-screen timings match the render exactly.
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

// ---- YouTube connect (OAuth 2.0 → Data API + Analytics API). The OAuth *app* (client id/secret) is
//      global in .secrets.json; the per-channel refresh token + channel info live in
//      <channel>/_assets/youtube.json so each Studio channel binds to its own YouTube channel. ----
const YT_REDIRECT = 'http://localhost:' + PORT + '/api/youtube/oauth-callback';
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/yt-analytics.readonly'].join(' ');
const ytStates = new Map();   // one-time OAuth state nonce -> { channel, at }
const uploadingYT = new Set(); // ch|id currently uploading to YouTube
const ytUploadStatus = {};     // ch|id -> { state, pct, videoId, url, error }
function ytFile(channel) { return path.join(ROOT, channel, '_assets', 'youtube.json'); }
function readYT(channel) { try { return JSON.parse(fs.readFileSync(ytFile(channel), 'utf8')); } catch (_) { return null; } }
function escH(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
// Exchange the stored refresh token for a fresh access token (access tokens expire hourly).
async function ytAccessToken(channel) {
  const yt = readYT(channel), s = readSecrets();
  if (!yt || !yt.refreshToken) throw new Error('this channel is not connected to YouTube');
  if (!s.youtubeClientId || !s.youtubeClientSecret) throw new Error('YouTube app credentials are missing');
  const body = new URLSearchParams({ client_id: s.youtubeClientId, client_secret: s.youtubeClientSecret, refresh_token: yt.refreshToken, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error('token refresh failed: ' + (j.error_description || j.error || 'unknown') + ' (try reconnecting)');
  return j.access_token;
}

// Attribution line for the channel's CURRENT bed (matches bed.mp3 by size to a library.json track).
// Returns '' for a no-attribution bed (e.g. a YouTube Audio Library track) — so the publish kit
// only prints a MUSIC credit when one is actually required (CC-BY). Auto-updates if the bed changes.
function musicCredit(channel) {
  try {
    const musicDir = path.join(ROOT, channel, '_assets', 'music');
    const bed = path.join(musicDir, 'bed.mp3');
    if (!fs.existsSync(bed)) return '';
    const bedSize = fs.statSync(bed).size;
    const audDir = path.join(musicDir, '_auditions');
    const man = JSON.parse(fs.readFileSync(path.join(audDir, 'library.json'), 'utf8'));
    for (const t of (man.tracks || [])) {
      const f = path.join(audDir, t.file);
      if (fs.existsSync(f) && fs.statSync(f).size === bedSize && t.attribution) return t.attribution;
    }
  } catch (_) {}
  return '';
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  // Local-only guard. The Studio can spawn headless Claude and write files, so requests must
  // come from this machine (loopback bind at the bottom) AND from a localhost page — a foreign
  // Origin means some website is trying to drive the Studio cross-origin (CSRF). Block both.
  const reqHost = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (reqHost && reqHost !== 'localhost' && reqHost !== '127.0.0.1' && reqHost !== '[::1]')
    return send(res, 403, JSON.stringify({ error: 'localhost only' }));
  const reqOrigin = req.headers.origin;
  if (reqOrigin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(reqOrigin))
    return send(res, 403, JSON.stringify({ error: 'cross-origin request blocked' }));

  // --- API ---
  if (pathname === '/api/videos' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(listVideos()));
  }

  // List channels (folders with a channel.md) for the channel switcher + New-project picker.
  if (pathname === '/api/channels' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(listChannels()));
  }

  // Scaffold a new video in a channel: copy the _video template, write a fresh studio.json (Idea
  // stage awaiting the human, the rest locked). It then appears in the video list automatically.
  if (pathname === '/api/new-video' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { channel, topic } = JSON.parse(body || '{}');
        if (!safeSeg(channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
        const chDir = path.join(ROOT, channel);
        if (!fs.existsSync(path.join(chDir, 'channel.md'))) return send(res, 404, JSON.stringify({ error: 'channel not found' }));
        let max = 0;
        for (const d of fs.readdirSync(chDir, { withFileTypes: true })) {
          const m = /^(\d{1,4})-/.exec(d.name);
          if (d.isDirectory() && m) max = Math.max(max, parseInt(m[1], 10));
        }
        const id = String(max + 1).padStart(3, '0') + '-' + (slugify(topic) || 'untitled');
        const dest = path.join(chDir, id);
        if (fs.existsSync(dest)) return send(res, 409, JSON.stringify({ error: 'folder already exists: ' + id }));
        fs.cpSync(path.join(ROOT, '_templates', '_video'), dest, { recursive: true });
        const now = new Date().toISOString();
        const doc = {
          channel, id, workingTitle: (topic || '').trim(), createdBy: 'studio', createdAt: now, updatedAt: now,
          endCard: true,
          stages: {
            idea: { status: 'awaiting-human', candidates: {}, decision: {} },
            packaging: { status: 'locked', candidates: {}, decision: {} },
            script: { status: 'locked', candidates: {}, decision: {} },
            scenes: { status: 'locked', candidates: {}, decision: {} },
            qc: { status: 'locked', candidates: {}, decision: {} },
          },
        };
        fs.writeFileSync(path.join(dest, 'studio.json'), JSON.stringify(doc, null, 2));
        return send(res, 200, JSON.stringify({ ok: true, channel, id }));
      } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  if (pathname === '/api/video' && req.method === 'GET') {
    const p = studioPath(query.channel, query.id);
    if (!p || !fs.existsSync(p)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    return send(res, 200, fs.readFileSync(p, 'utf8'));
  }

  if (pathname === '/api/video' && req.method === 'POST') {
    const p = studioPath(query.channel, query.id);
    if (!p || !fs.existsSync(p)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body || '{}');
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        doc.stages = doc.stages || {};
        for (const [stage, decision] of Object.entries(incoming.decisions || {})) {
          doc.stages[stage] = doc.stages[stage] || {};
          doc.stages[stage].decision = decision;        // ONLY the human's decision is written
          if (decision && (decision.primaryTitle || decision.chosen || decision.chosenThumbnail)) {
            doc.stages[stage].status = 'decided';
          }
        }
        doc.updatedAt = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(doc, null, 2));
        send(res, 200, JSON.stringify({ ok: true, updatedAt: doc.updatedAt }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }

  // --- Chat: drive Claude headless on the user's Max plan ---
  if (pathname === '/api/chat' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const msg = (JSON.parse(body || '{}').message || '').trim();
        if (!msg) return send(res, 400, JSON.stringify({ error: 'empty message' }));
        const key = query.channel + '|' + query.id;
        const sid = sessionId(key);
        const base = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT];
        const first = startedSessions.has(key) ? ['--resume', sid] : ['--session-id', sid];
        let r = await runClaude(base.concat(first, ['--', msg]), 5 * 60 * 1000);
        if (r.code !== 0) {
          const alt = startedSessions.has(key) ? ['--session-id', sid] : ['--resume', sid];
          r = await runClaude(base.concat(alt, ['--', msg]), 5 * 60 * 1000);
        }
        startedSessions.add(key);
        let reply = '(no response)', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || r.out || 'Claude returned no output.').slice(0, 1500); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) {
        send(res, 500, JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }

  // --- Regenerate a single option (title or thumbnail) in place ---
  if (pathname === '/api/regenerate' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { kind, targetId, note } = JSON.parse(body || '{}');
        if (!targetId) return send(res, 400, JSON.stringify({ error: 'missing targetId' }));
        const n = (note || '').trim();
        const vc = videoCast(query.channel, query.id);
        let instr;
        if (kind === 'title') {
          instr = `In ${sp}, revise ONLY the title whose id is "${targetId}". `
            + (n ? `Apply this note: "${n}". ` : `Produce a stronger variation of it. `)
            + `Update its "text" (aim 40-60 chars, an honest strong curiosity gap) and its "note". Keep its id. `
            + `Do NOT change any other title, any thumbnail, or the decision object. Keep the file valid JSON. Reply in ONE short sentence.`;
        } else {
          instr = `In ${sp}, regenerate ONLY the thumbnail whose id is "${targetId}". Keep that id and its core concept, but revise it`
            + (n ? ` per this note: "${n}". ` : ` with a fresh take. `)
            + `Rewrite its "layout" object (the structured wireframe spec, NOT an "svg" string): { "bg":"<sky|dawn|sunset|ember|night|ocean|snow|forest|sand|stone|cave|blizzard>", "accent":"<hex; ONE accent>", "subject":{ "who":"<${vc.names.join('|')}|none>", "pose":"<short, specific action + facial expression>", "zone":"<left|center|right>", "scale":"<hero|medium>" }, "props":[<=3 short labels], "mood":"<one-phrase lighting/atmosphere>", "text":[ {"line":"<UPPERCASE 1-3 words>","role":"<accent|dark|white>"} ], "textZone":"<left|right|center|top|bottom>" }. ${vc.note ? 'The cast are reimagined for this video: ' + vc.note + ' — keep the concept in that look. ' : ''}Keep 2-3 elements, ONE accent, the key subject in the left ~60%, a strong emotional facial read, legible at 120x68 (History/_assets/style-bible.md §9). `
            + `Update its "rationale" if relevant. Do NOT modify any other thumbnail, the titles, or the decision object. Keep the file valid JSON. Reply in ONE short sentence.`;
        }
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 5 * 60 * 1000);
        let reply = 'Done.', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || 'Claude returned no output.').slice(0, 800); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) {
        send(res, 500, JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }

  // --- Regenerate the WHOLE thumbnail set from all accumulated hints ---
  if (pathname === '/api/regenerate-all' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const pk = doc.stages.packaging, dec = pk.decision || {}, thumbs = pk.candidates.thumbnails || [];
        const nameOf = (id) => (thumbs.find((t) => t.id === id) || {}).name || id;
        const primary = (pk.candidates.titles || []).find((t) => t.id === dec.primaryTitle);
        const warm = thumbs.filter((t) => (dec.thumbFeedback || {})[t.id] && dec.thumbFeedback[t.id].temp === 'warmer').map((t) => t.name);
        const cold = thumbs.filter((t) => (dec.thumbFeedback || {})[t.id] && dec.thumbFeedback[t.id].temp === 'colder').map((t) => t.name);
        const tnotes = Object.entries(dec.thumbNotes || {}).filter(([, v]) => v && v.trim()).map(([id, v]) => `  - ${nameOf(id)}: ${v.trim()}`);
        const vc = videoCast(query.channel, query.id);
        const whoList = vc.names.join('|') + '|none';
        const instr = [
          `You are a top-tier YouTube thumbnail strategist for an educational deep-history channel. In ${sp}, REGENERATE the whole thumbnail set (stages.packaging.candidates.thumbnails) for this video using the operator's accumulated feedback. Produce EXACTLY 6 strong, genuinely DIFFERENT concepts — not six rewordings of one idea.`,
          `Primary title to match: "${primary ? primary.text : '(none picked yet)'}". First, identify the title's PIVOT — the single most curiosity-loaded word or idea (the thing that makes someone need to click) — and make every concept dramatize THAT, not the generic topic.`,
          castPromptLine(vc),
          `DIVERSITY IS THE POINT. Across the 6, deliberately vary the EMOTIONAL register and the COMPOSITION so they are real alternative bets:`,
          `  - Emotion: spread them across (lonely/vulnerable), (shocked/disbelief), (tense/ominous), (awe/wonder), (myth-busted/"actually…"), (curious/mysterious) — at least 4 distinct emotions across the set.`,
          `  - Composition: vary scale (some a HERO close-up on one face filling the frame, some a MEDIUM figure-in-a-scene), vary the subject's zone (left vs centre vs right), and vary the background mood. No two should feel like the same shot.`,
          `  - Subject: most use ONE cast member as the emotional anchor (a big, unmistakable facial expression is the #1 click driver); 1-2 may be a striking object/scene with "none". Pick the cast member whose role best carries each concept.`,
          `LEAN INTO (operator marked warmer): ${warm.length ? warm.join('; ') : '(none marked)'}.`,
          `MOVE AWAY FROM (operator marked colder): ${cold.length ? cold.join('; ') : '(none marked)'}.`,
          `Per-thumbnail notes:\n${tnotes.length ? tnotes.join('\n') : '  (none)'}`,
          `Overall note: ${(dec.notes || '').trim() || '(none)'}`,
          `Evolve the warmer concepts in the noted direction, drop/avoid the colder ones, and fill the rest with fresh distinct bets — all aligned to the title and CLAUDE.md §3 + History/_assets/style-bible.md §9 packaging rules (max 2-3 elements, ONE accent, <=3-5 bold words, key subject in the left ~60%, legible at 120x68 in light AND dark mode).`,
          `Each thumbnail = { "id":"th-<unique>", "name":"<short>", "rationale":"<one line: the click bet + which emotion/composition slot it fills>", "layout": { "bg":"<one of: sky|dawn|sunset|ember|night|ocean|snow|forest|sand|stone|cave|blizzard>", "accent":"<hex; ONE dominant accent>", "subject": { "who":"<${whoList}>", "pose":"<short, SPECIFIC action + facial expression>", "zone":"<left|center|right>", "scale":"<hero|medium>" }, "props":[<up to 3 SHORT prop labels>], "mood":"<a vivid one-phrase lighting/atmosphere note, e.g. 'cold blue dusk, single warm fire glow'>", "text":[ {"line":"<UPPERCASE 1-3 words>","role":"<accent|dark|white>"} ], "textZone":"<left|right|center|top|bottom>" } }. Always include a "mood" phrase. Use the structured "layout" object, NOT an "svg" string.`,
          `Then in stages.packaging.decision: set chosenThumbnail=null, thumbFeedback={}, thumbNotes={}, wouldClick=null — but KEEP primaryTitle, abTitles, customTitles, titleNotes and notes. Keep the file valid JSON. Reply in ONE short sentence summarizing the 6 new bets.`,
        ].join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 8 * 60 * 1000);
        let reply = 'Done.', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || 'no output').slice(0, 800); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Advance a stage (lock current, unlock next) ---
  if (pathname === '/api/advance' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const from = JSON.parse(body || '{}').from;
        const nextOf = { idea: 'packaging', packaging: 'script', script: 'scenes', scenes: 'qc' };
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        if (doc.stages[from]) doc.stages[from].status = 'decided';
        const nx = nextOf[from];
        if (nx && doc.stages[nx] && doc.stages[nx].status === 'locked') doc.stages[nx].status = 'awaiting-human';
        doc.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(doc, null, 2));
        send(res, 200, JSON.stringify({ ok: true, next: nx || null }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Brainstorm idea candidates for a new video, using the CHANNEL's context ---
  if (pathname === '/api/generate-ideas' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const key = query.channel + '|' + query.id;
      if (generatingIdeas.has(key)) return send(res, 200, JSON.stringify({ reply: 'Already brainstorming — hang tight, the candidates appear here when ready.', isError: false, busy: true }));
      generatingIdeas.add(key);
      try {
        const { topic, notes } = JSON.parse(body || '{}');
        const chDir = path.join(ROOT, query.channel);
        const instr = [
          `Brainstorm video IDEAS for the YouTube channel whose identity lives in this folder: ${chDir}.`,
          `READ FIRST so the ideas fit THIS channel's lane/voice/audience and don't repeat past videos: ${path.join(chDir, 'channel.md')}; the style bible ${path.join(chDir, '_assets', 'style-bible.md')} if it exists; and the idea bank ${path.join(chDir, '_ideas.md')} if it exists. Also read ${path.join(ROOT, 'CLAUDE.md')} for the global rules — the "Would I click this if a stranger made it?" gate, packaging-first thinking, and the demand screen.`,
          topic ? `The operator seeded a topic/direction: "${topic}". Anchor every candidate to it.` : `No seed given — propose the strongest candidates in this channel's lane. You may draw on and sharpen ideas from the idea bank, but prefer fresh, specific angles over repeating it verbatim.`,
          `Propose 3-5 DISTINCT candidates. Screen demand honestly for each (who clicks and why; is it over- or under-covered; is it genuinely sourceable). Give each a sharp ORIGINAL ANGLE (a specific argument or question, never a generic survey) and a short STORY SPINE of 4-7 beats.`,
          `Then in ${sp}, set stages.idea.candidates = { "ideas": [ { "id": "i1", "statement": "<the idea as a viewer would hear it, one line>", "demand": "<1-2 sentence demand screen>", "angle": "<the original POV / specific argument>", "spine": ["beat 1","beat 2","..."], "whyItHits": "<why it works for THIS channel + audience>", "risk": "<the main risk / what could make it flop>" } , ... ] } and set stages.idea.status = "awaiting-human". Unique ids (i1, i2, ...). Do NOT modify any other stage. Keep studio.json valid JSON.`,
          notes ? `Apply this redirection from the operator: "${notes}".` : '',
          `Reply in ONE short sentence.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'Edit', 'Write', 'Bash(node *)',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 8 * 60 * 1000);
        let reply = 'Ideas ready.', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || 'no output').slice(0, 800); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingIdeas.delete(key); }
    });
    return;
  }

  // --- Generate packaging TITLES for the approved idea (thumbnails come after a title is locked) ---
  if (pathname === '/api/generate-packaging' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const key = query.channel + '|' + query.id;
      if (generatingPackaging.has(key)) return send(res, 200, JSON.stringify({ reply: 'Titles are already being written — hang tight.', isError: false, busy: true }));
      generatingPackaging.add(key);
      try {
        const folder = path.dirname(sp);
        const chDir = path.join(ROOT, query.channel);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const note = ((doc.stages.packaging && doc.stages.packaging.decision && doc.stages.packaging.decision.notes) || '').trim();
        const instr = [
          `Do the PACKAGING title stage for the video in this folder: ${folder}.`,
          `Read the APPROVED idea from ${sp}: stages.idea.candidates holds the idea(s); the chosen one is the entry whose id === stages.idea.decision.chosenIdea (or the single legacy idea / its .statement). Its statement + angle + spine are your brief.`,
          `Read ${path.join(chDir, 'channel.md')} for THIS channel's TITLE FORMULAS, voice, and audience, and ${path.join(ROOT, 'CLAUDE.md')} §3 packaging rules.`,
          `Write 10-12 candidate TITLES that sell this idea's SPECIFIC angle (not a generic topic). Rules: 40-60 characters; the primary keyword in the first 3-5 words; an honest curiosity gap the video can actually pay off; exact numbers beat round ones; avoid generic superlatives ("Unbelievable"). Vary the FORMULA across the set (specific time-window, behavior-mystery, hidden-knowledge/revelation, compression, identity-challenge, authority+specificity, counterintuitive number, myth-rebuttal) so they are genuinely different bets — not rewordings of one title.`,
          `Then in ${sp}, set stages.packaging.candidates = { "titles": [ { "id":"t1", "text":"<the title>", "why":"<one short line: the bet / why the curiosity gap works>" }, ... ] } and set stages.packaging.status = "awaiting-human". Do NOT add thumbnails (those are generated after the operator locks a primary title). Do NOT modify any other stage. Keep studio.json valid JSON.`,
          note ? `Apply this operator note: "${note}".` : '',
          `Reply in ONE short sentence.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Read', 'Edit', 'Write', 'Bash(node *)',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 6 * 60 * 1000);
        let reply = 'Titles ready.', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || 'no output').slice(0, 800); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingPackaging.delete(key); }
    });
    return;
  }

  // --- SHORTS LAB: find the most viral-able moments in the finished video and plan Shorts ---
  // Claude writes a small clips JSON to 07-publish/shorts-clips.json; the SERVER validates it,
  // computes exact timings from the real beat timeline, merges into studio.json, and writes the
  // durable 07-publish/shorts-plan.md (same Claude-writes-file / server-imports pattern as scenes).
  if (pathname === '/api/generate-shorts' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const key = query.channel + '|' + query.id;
      if (generatingShorts.has(key)) return send(res, 200, JSON.stringify({ reply: 'Shorts analysis already running — hang tight.', isError: false, busy: true }));
      generatingShorts.add(key);
      try {
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
        const beats = beatTimeline(scenes);
        if (beats.length < 8) { generatingShorts.delete(key); return send(res, 200, JSON.stringify({ reply: 'Not enough voiced beats yet — finish the Scenes stage first.', isError: true })); }
        const note = ((doc.stages.shorts && doc.stages.shorts.decision && doc.stages.shorts.decision.notes) || '').trim();
        const fmtT = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
        const table = beats.map((b) => `${b.n} | ${fmtT(b.start)} | ${b.secs.toFixed(1)}s | ${b.narration}`).join('\n');
        const clipsFile = path.join(folder, '07-publish', 'shorts-clips.json');
        try { fs.unlinkSync(clipsFile); } catch (_) {}
        const instr = [
          `You are an expert YouTube Shorts editor and viral-content strategist. Analyze this finished video's narration and find the BEST moments to repurpose as Shorts/Reels/TikToks. The goal is NOT to summarize — find moments of immediate curiosity, surprise, awe, mystery, disbelief, or a misconception being corrected.`,
          `THE VIDEO, as a beat table (beatN | start | hold | narration):\n${table}`,
          `STEP 1 — scan for high-retention moments: surprising facts, counterintuitive claims, shocking stats, mysteries, "wait... what?" lines, major reveals, dangerous journeys, human survival, myths corrected.`,
          `STEP 2 — score each candidate 1-10 on curiosity, shareability, standalone value (understandable without the full video), and visual potential.`,
          `STEP 3 — select the TOP 5-8. Each clip is a CONTIGUOUS beat range [fromBeat..toBeat] whose holds sum to 20-60 seconds (target 30-50). The FIRST beat of the range must work as a hook line — never start mid-thought; if the strongest hook is mid-range, start there and let the payoff carry. Clips may overlap slightly but must not duplicate one another.`,
          `STEP 4 — for each clip also write: a Shorts-rewrite (hook 0-3s / setup / payoff / loop-or-callback ending) for an optional re-voiced cut, 5 title options (curiosity-first, like "Humans Shouldn't Have Reached Australia"), 3 text overlays of 3-6 words (open/mid/end), and a ready-to-paste post caption with 3-5 hashtags.`,
          `Think like a creator chasing 1M views, not a teacher: prioritize curiosity, retention, shareability, emotional reaction, historical surprise — NOT educational completeness.`,
          `OUTPUT: write ONE file at ${clipsFile} — valid JSON, plain ASCII punctuation (straight quotes, hyphens; NO smart quotes or em-dashes), shaped EXACTLY:`,
          `{ "clips": [ { "id":"clip-1", "title":"<short internal name>", "fromBeat":<n>, "toBeat":<n>, "hook":"<first line viewers hear>", "why":"<why it works, 1-2 sentences>", "viralScore":<1-100>, "scores":{"curiosity":<1-10>,"shareability":<1-10>,"standalone":<1-10>,"visual":<1-10>}, "shortsTitles":["t1","t2","t3","t4","t5"], "overlays":{"open":"<3-6 words>","mid":"<3-6 words>","end":"<3-6 words>"}, "shortScript":{"hook":"...","setup":"...","payoff":"...","loop":"..."}, "postCaption":"<caption + hashtags>" } ] }`,
          `Order clips best-first by viralScore. Do NOT edit studio.json — ONLY write that one JSON file.`,
          note ? `Apply this operator redirection: "${note}".` : '',
          `Reply in ONE short sentence with how many clips you found.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Read', 'Write', 'Edit', 'Bash(node *)',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 8 * 60 * 1000);
        // Import + validate what Claude wrote, compute REAL timings, persist, and build the plan doc.
        let reply = '', isError = false;
        try {
          const raw = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
          const byN = new Map(beats.map((b) => [b.n, b]));
          const clips = (raw.clips || []).filter((c) => c && byN.has(c.fromBeat) && byN.has(c.toBeat) && c.toBeat >= c.fromBeat).map((c, i) => {
            const a = byN.get(c.fromBeat), b = byN.get(c.toBeat);
            return Object.assign({}, c, {
              id: String(c.id || 'clip-' + (i + 1)).replace(/[^a-zA-Z0-9_-]/g, ''),
              startSec: +a.start.toFixed(1), endSec: +b.end.toFixed(1), durationSec: +(b.end - a.start).toFixed(1),
            });
          }).filter((c) => c.durationSec >= 12 && c.durationSec <= 90);
          if (!clips.length) throw new Error('no valid clips in shorts-clips.json');
          clips.sort((x, y) => (y.viralScore || 0) - (x.viralScore || 0));
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.stages.shorts = live.stages.shorts || {};
          live.stages.shorts.candidates = { clips, analyzedAt: new Date().toISOString() };
          live.stages.shorts.status = 'awaiting-human';
          live.stages.shorts.decision = live.stages.shorts.decision || {};
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
          // Durable record: the ranked plan, ready to work from on upload day.
          const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
          const md = ['# Shorts plan — ' + (live.workingTitle || query.id), '',
            'Ranked by viral potential. Timings are in the FULL rough cut; each clip renders vertical (1080x1920) from the Studio\'s Shorts tab.', '',
            '| # | Clip | Beats | In full video | Length | Viral |', '|---|---|---|---|---|---|',
            ...clips.map((c, i) => `| ${i + 1} | ${c.title} | ${c.fromBeat}-${c.toBeat} | ${fmt(c.startSec)}-${fmt(c.endSec)} | ${Math.round(c.durationSec)}s | ${c.viralScore} |`), '',
            ...clips.flatMap((c) => ['## ' + c.title + ' (' + c.viralScore + ')', '',
              '- **Hook:** ' + (c.hook || ''), '- **Why:** ' + (c.why || ''),
              '- **Titles:** ' + (c.shortsTitles || []).join(' · '),
              '- **Overlays:** open "' + ((c.overlays || {}).open || '') + '" · mid "' + ((c.overlays || {}).mid || '') + '" · end "' + ((c.overlays || {}).end || '') + '"',
              '- **Post caption:** ' + (c.postCaption || ''),
              '- **Re-voice script (optional):** hook: ' + ((c.shortScript || {}).hook || '') + ' / setup: ' + ((c.shortScript || {}).setup || '') + ' / payoff: ' + ((c.shortScript || {}).payoff || '') + ' / loop: ' + ((c.shortScript || {}).loop || ''), '']),
            '*Generated ' + new Date().toISOString() + ' from the real narration timings.*', ''].join('\n');
          fs.writeFileSync(path.join(folder, '07-publish', 'shorts-plan.md'), md);
          reply = 'Found ' + clips.length + ' clips — ranked in the Shorts tab (top pick: "' + clips[0].title + '", ' + clips[0].viralScore + '/100).';
        } catch (e) {
          let claudeSaid = ''; try { const j = JSON.parse(r.out); claudeSaid = j.result || ''; } catch (_) {}
          reply = 'Shorts analysis failed to import: ' + String(e && e.message || e) + (claudeSaid ? ' — Claude said: ' + claudeSaid.slice(0, 300) : '');
          isError = true;
        }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingShorts.delete(key); }
    });
    return;
  }

  // --- Render ONE planned Short as a vertical 1080x1920 MP4 (frameRange of the real timeline) ---
  if (pathname === '/api/render-short' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    if (!fs.existsSync(path.join(RENDER_DIR, 'node_modules', 'remotion')))
      return send(res, 200, JSON.stringify({ error: 'Remotion not installed. Run once:  cd _studio/render && npm install', isError: true }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { clipId } = JSON.parse(body || '{}');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const clip = ((((doc.stages || {}).shorts || {}).candidates || {}).clips || []).find((c) => c.id === clipId);
        if (!clip) return send(res, 404, JSON.stringify({ error: 'no such clip' }));
        const rk = query.channel + '|' + query.id + '|' + clip.id;
        if (renderingShorts.has(rk)) return send(res, 200, JSON.stringify({ reply: 'That clip is already rendering.', running: true }));
        renderingShorts.add(rk);
        const shortsDir = path.join(path.dirname(sp), '05-edit', 'shorts');
        fs.mkdirSync(shortsDir, { recursive: true });
        const log = fs.createWriteStream(path.join(shortsDir, 'render.log'), { flags: 'a' });
        const args = [path.join(RENDER_DIR, 'render.mjs'), query.channel, query.id, String(clip.fromBeat), String(clip.toBeat), '--vertical', '--name=' + clip.id];
        const ov = clip.overlays || {};
        if ((ov.open || '').trim()) args.push('--hook=' + ov.open.trim());
        if ((ov.mid || '').trim()) args.push('--ovmid=' + ov.mid.trim());
        if ((ov.end || '').trim()) args.push('--ovend=' + ov.end.trim());
        const child = spawn(process.execPath, args, { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
        child.stdout.on('data', (d) => log.write(d)); child.stderr.on('data', (d) => log.write(d));
        child.on('error', () => renderingShorts.delete(rk));
        child.on('close', () => { renderingShorts.delete(rk); try { log.end(); } catch (_) {} });
        send(res, 200, JSON.stringify({ started: true, clipId: clip.id }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  if (pathname === '/api/shorts-status' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp) return send(res, 400, JSON.stringify({ error: 'bad' }));
    const k = query.channel + '|' + query.id;
    const shortsDir = path.join(path.dirname(sp), '05-edit', 'shorts');
    const files = {}, progress = {};
    if (fs.existsSync(shortsDir)) {
      for (const f of fs.readdirSync(shortsDir)) {
        if (f.endsWith('.mp4')) { try { const st = fs.statSync(path.join(shortsDir, f)); files[f.replace(/\.mp4$/, '')] = { size: st.size, t: st.mtimeMs }; } catch (_) {} }
        else if (f.endsWith('.status.json')) { try { progress[f.replace(/\.status\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(shortsDir, f), 'utf8')); } catch (_) {} }
      }
    }
    const rendering = [...renderingShorts].filter((x) => x.startsWith(k + '|')).map((x) => x.slice(k.length + 1));
    return send(res, 200, JSON.stringify({ analyzing: generatingShorts.has(k), rendering, files, progress }));
  }
  if (pathname === '/api/short-file' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !safeSeg(query.name) || !/^[\w-]+\.mp4$/.test(query.name)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(path.dirname(sp), '05-edit', 'shorts', query.name);
    if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    const stat = fs.statSync(f), range = req.headers.range;
    const pipeGuarded = (opts) => { const s = fs.createReadStream(f, opts); s.on('error', () => { try { res.destroy(); } catch (_) {} }); s.pipe(res); };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end > stat.size - 1) end = stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-store' }); return res.end(); }
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
      pipeGuarded({ start, end });
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      pipeGuarded({});
    }
    return;
  }

  // --- Generate the script stage (research -> fact-check -> draft) ---
  if (pathname === '/api/generate-script' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const key = query.channel + '|' + query.id;
      if (generatingScripts.has(key)) return send(res, 200, JSON.stringify({ reply: 'A script is already being written for this video — hang tight, it appears here when done.', isError: false, busy: true }));
      generatingScripts.add(key);
      try {
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const note = ((doc.stages.script && doc.stages.script.decision && doc.stages.script.decision.notes) || '').trim();
        const vc = videoCast(query.channel, query.id);
        const made = producedVideos(query.channel, query.id);
        const madeList = made.length ? made.map((v) => `"${v.title}"`).join('; ') : "(none yet — this is one of the channel's first videos)";
        const instr = [
          `Do the next pipeline stage (research -> fact-check -> script + thumbnail prompt) for the video in this folder: ${folder}`,
          `Follow CLAUDE.md standards (8-10 min, ~1000-1400 words, hook in first 5s, retention beats, mid-video re-hook, payoff that delivers the locked title, memorable takeaway).`,
          `EDITORIAL SPINE (this is the "No Atlantis, No Aliens, No Nonsense" brand): (1) Build the WHOLE video around ONE non-obvious, load-bearing INSIGHT — a specific reframing the viewer leaves with — set it up early and pay it off at the climax; do not write a flat survey. (2) Include at least one beat where the skeptic dismantles a SPECIFIC popular myth or misconception relevant to the topic (pseudo-archaeology, a debunked "fact", an outdated textbook claim) — name it and correct it. (3) Explicitly LABEL consensus vs. active debate: when something is contested, say so and say what the evidence actually supports; never state a contested date/claim as settled. (4) Sources must be primary/recent and credible (peer-reviewed journals, museums, universities) — distinguish established from contested in 01-research/sources.md.`,
          `CRITICAL: the script is PURE NARRATION — a single voiceover. NO character dialogue, NO speaker names or labels, no "Max says". The cast (${vc.names.join(' / ')}) appear ONLY in the visuals; the narrator tells the entire story. Visual/scene cues may appear in [brackets], but every spoken line is narration.`,
          castPromptLine(vc),
          `OUTRO / WATCH-NEXT RULE: end on the ONE most memorable takeaway plus a brief subscribe nudge. Do NOT invent, tease, or promise a specific other video that may not exist (no "watch this next: the story of X" unless X is real). You may bridge to a "watch next" ONLY if it is one of the channel's ALREADY-PUBLISHED videos: ${madeList}. If none fit, close cleanly and let the end card + YouTube end screen carry the watch-next. The FINAL beat's visual should keep the right third of the frame clear for an end-screen card.`,
          `1) Research the topic with credible sources (use web search if available; otherwise rely on your knowledge and say so). 2) Fact-check load-bearing claims; reject pseudo-archaeology. 3) Write the script.`,
          `4) Also write a ready-to-paste ChatGPT image-generation prompt for the CHOSEN thumbnail (read stages.packaging.decision.chosenThumbnail and use that thumbnail's concept/cast/scene/text; if none is chosen, base it on the primary title). Use the thumbnail prompt skeleton in History/_assets/style-bible.md: tell ChatGPT to attach cast-sheet.png, draw the named cast member(s) in the colored cast style, wide 16:9, with the exact bold hook text spelled out.`,
          `Write these files in the folder: 01-research/research-brief.md, 01-research/sources.md, 02-script/script.md, and 00-packaging/thumbnail-prompt.md.`,
          `Then in ${sp}, set stages.script.candidates = { "script": <full script markdown string>, "words": <number>, "sources": [<short source strings>], "thumbnailPrompt": <the ChatGPT thumbnail prompt as one string> } and stages.script.status = "awaiting-human". Do NOT modify the packaging stage. Keep studio.json valid JSON.`,
          note ? `Apply this revision note: "${note}".` : '',
          `Reply in ONE short sentence.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'Edit', 'Write', 'Bash(node *)',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 12 * 60 * 1000);   // hard cap so a wedged headless call can't hang the job
        let reply = 'Script ready.', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || 'no output').slice(0, 800); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingScripts.delete(key); }
    });
    return;
  }

  // --- Generate the scene list + a ChatGPT image prompt per shot ---
  if (pathname === '/api/generate-scenes' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const key = query.channel + '|' + query.id;
      if (generatingScenes.has(key)) return send(res, 200, JSON.stringify({ reply: 'Scenes are already being generated — hang tight.', isError: false, busy: true }));
      generatingScenes.add(key);
      try {
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const note = ((doc.stages.scenes && doc.stages.scenes.decision && doc.stages.scenes.decision.notes) || '').trim();
        const vc = videoCast(query.channel, query.id);
        const instr = [
          `Build the scene/image list for the video in this folder: ${folder}. The video is a series of STANDALONE still images — ONE image per content beat (sub-segment) — each held on screen while its narration plays, then a hard cut to the next image when the narration moves to the next idea. We are NOT using zooms/overlays to fake motion; each new image marks a new beat.`,
          castPromptLine(vc),
          `Read the narration script from stages.script.candidates.script in ${sp} (and 02-script/script.md).`,
          `Segment it the way a video editor would: group the narration into SEGMENTS (the major sections of the video) and, within each, SUB-SEGMENTS — each sub-segment is one coherent visual moment (a new place, action, concept, character, list item, or reveal). Start a NEW image whenever the visual idea changes; keep ONE image while the narration stays on the same idea. So hold time VARIES with the content — a quick punchy beat is its own briefly-held image; a single dense idea is one image held longer. Each image's hold time = the spoken length of its narration (words / 135 * 60 seconds). Do NOT impose a uniform cadence and do NOT pad.`,
          `Editor judgment: lists/enumerations -> a separate quick image per item; a complex map or diagram -> ONE image held for the whole explanation; a reveal/payoff -> its own held image. Cut on sentence/clause breaks, never mid-phrase. Avoid both extremes (frantic over-segmentation and a static slideshow). The image COUNT emerges from the content.`,
          `TWO IMAGE KINDS (set per scene): "illustration" = the cast acting out the beat (the default); "infographic" = a clean hand-drawn DIAGRAM / MAP / TIMELINE / COMPARISON in the same doodle style, used when the narration turns technical (a process or mechanism, competing/contested dates, migration routes on a map, a timeline, the Ice-Age sea-level drop, drift-vs-deliberate odds, statistics). Reach for an infographic on technical beats where a diagram explains it better than a character shot.`,
          `ON-SCREEN TEXT (read History/_assets/style-bible.md §8): critical text is an OVERLAY added in editing, NOT drawn into illustrations. So for illustration scenes, DO NOT instruct the image to render caption text — keep the art clean. Instead, for any beat with a real date / stat / key term / punch-line (the script's [TEXT:"…"] cues and key numbers), put that SHORT exact caption in on_screen_text (else blank) and set text_pos = top-center by default (use lower-third for a running place-name label, center for one big reveal, none if no text). Infographic scenes may carry their own short baked labels as part of the diagram.`,
          `EDIT BLUEPRINT — this is an edit-ready storyboard, not just images. For each beat also specify, using these controlled vocabularies (History/_assets/style-bible.md §10): cast_action = a SHORT stage direction dramatizing the narrative engine (Max wonders → Zed doubts → Nova explains → Luna marvels), e.g. "Zed crosses arms, then throws hands up"; motion = the camera move (push-in | push-out | pan-left | pan-right | static) — give nearly every illustration a subtle move (push-in default; pan across maps/landscapes; static or slow pan for infographics); text_anim = how the caption enters (punch | fade | type | none — punch for a hard stat, none when there is no caption); sfx = 0-2 short cue tokens joined by | (whoosh, pop, ding, thud, riser, water, wind, fire, click, page, boom); ambient = the background bed (ocean | wind | cave | forest | savanna | ice | fire | crowd | none); music_cue = ONLY on beats where the music should shift (act1 | rehook | act2 | payoff | outro), blank otherwise.`,
          `For EACH beat produce: n (1-based), segment, kind (illustration|infographic), seconds (hold = narration length, rounded), characters (cast appearing by name; [] if none), narration (exact narration on screen this beat), visual (one-line), on_screen_text (short caption or blank), text_pos (top-center|lower-third|center|none), text_anim, motion, sfx, ambient, music_cue, cast_action, imagePrompt (CONCISE 1-2 sentences: for an illustration, attach cast-sheet.png and draw the cast member(s) in their ESTABLISHED look from the cast references — match face, hair and wardrobe exactly (if the cast was adapted for this video, use that adapted era/species/wardrobe, NOT default modern dress), big expressive face, performing the cast_action, NO caption text, headroom at top; for an infographic, describe the clean hand-drawn diagram/map/timeline with SHORT exact labels; wide 16:9, flat, bold outlines, no photorealism).`,
          `Write 03-scenes/scene-list.csv with columns in EXACTLY this order: scene,segment,seconds,kind,characters,narration,visual,on_screen_text,text_pos,text_anim,motion,sfx,ambient,music_cue,cast_action,image_prompt — characters and sfx are |-joined (blank if none). Use proper CSV quoting for any field containing a comma.`,
          `Do NOT edit studio.json at all — ONLY write the CSV. The server imports it into studio.json automatically. (This keeps the step fast and reliable even for 80+ scenes.)`,
          note ? `Apply this revision note: "${note}".` : '',
          `Reply in ONE short sentence with the image count and total runtime.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Read', 'Write', 'Edit', 'Bash(node *)',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        await runClaude(args, 15 * 60 * 1000);   // 15-min cap: a full 80-95 beat storyboard can take >8 min to write (a wedged call still can't hang forever)
        // Server-side import: parse the CSV Claude wrote -> studio.json (fast & reliable, no giant model write)
        let reply = '', isError = false;
        try {
          const { scenes, totalSeconds } = importScenesCsv(folder);
          if (!scenes.length) throw new Error('no scenes parsed from the CSV');
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.stages.scenes = live.stages.scenes || {};
          const prevScenes = ((live.stages.scenes.candidates || {}).scenes) || [];
          live.stages.scenes.candidates = { scenes: mergeScenes(prevScenes, scenes), totalSeconds };
          live.stages.scenes.status = 'awaiting-human';
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
          reply = 'Built ' + scenes.length + ' scenes (~' + Math.round(totalSeconds / 60) + ' min) from the script.';
        } catch (e) { reply = 'Scene generation problem: ' + String(e && e.message || e); isError = true; }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingScenes.delete(key); }
    });
    return;
  }

  // --- Import 03-scenes/scene-list.csv into studio.json directly (no Claude needed) ---
  if (pathname === '/api/import-scenes' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const folder = path.dirname(sp);
        const { scenes, totalSeconds } = importScenesCsv(folder);
        if (!scenes.length) throw new Error('no scenes parsed from the CSV');
        const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
        live.stages.scenes = live.stages.scenes || {};
        const prevScenes = ((live.stages.scenes.candidates || {}).scenes) || [];
        live.stages.scenes.candidates = { scenes: mergeScenes(prevScenes, scenes), totalSeconds };
        live.stages.scenes.status = 'awaiting-human';
        live.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        send(res, 200, JSON.stringify({ ok: true, scenes: scenes.length, totalSeconds }));
      } catch (e) { send(res, 400, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Which jobs are currently running for this video? ---
  if (pathname === '/api/status' && req.method === 'GET') {
    const k = query.channel + '|' + query.id;
    return send(res, 200, JSON.stringify({ ideas: generatingIdeas.has(k), packaging: generatingPackaging.has(k), script: generatingScripts.has(k), scenes: generatingScenes.has(k), images: generatingImages.has(k) || generatingImages.has('lockcast|' + query.channel), narration: generatingNarration.has(k), shorts: generatingShorts.has(k) }));
  }

  // --- Gemini API key (stored locally only) ---
  if (pathname === '/api/key-status' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ hasKey: !!getGeminiKey() }));
  }
  if (pathname === '/api/set-key' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const k = (JSON.parse(body || '{}').key || '').trim();
        if (!k) return send(res, 400, JSON.stringify({ error: 'empty key' }));
        writeSecrets({ geminiKey: k });
        send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- ElevenLabs voice key + config (stored locally only) ---
  if (pathname === '/api/voice-status' && req.method === 'GET') {
    const c = getElevenCfg(query.channel);
    return send(res, 200, JSON.stringify({ hasKey: !!c.key, voiceId: c.voiceId, model: c.model, stability: c.stability, style: c.style, scope: c.scope }));
  }
  if (pathname === '/api/set-voice' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        // The API key is account-wide → always the global secrets file.
        if (typeof b.key === 'string' && b.key.trim()) writeSecrets({ elevenKey: b.key.trim() });
        // Voice identity → the channel's voice.json when a channel is in scope (each channel keeps
        // its own branded narrator); fall back to the legacy global fields otherwise.
        const v = {};
        if (typeof b.voiceId === 'string' && b.voiceId.trim()) v.voiceId = b.voiceId.trim();
        if (typeof b.model === 'string' && b.model.trim()) v.model = b.model.trim();
        if (typeof b.stability === 'number') v.stability = Math.min(1, Math.max(0, b.stability));
        if (typeof b.style === 'number') v.style = Math.min(1, Math.max(0, b.style));
        if (Object.keys(v).length) {
          if (query.channel && safeSeg(query.channel) && fs.existsSync(path.join(ROOT, query.channel, 'channel.md'))) {
            const f = channelVoiceFile(query.channel);
            let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(Object.assign(cur, v), null, 2));
          } else {
            const patch = {};
            if (v.voiceId) patch.elevenVoiceId = v.voiceId;
            if (v.model) patch.elevenModel = v.model;
            if (typeof v.stability === 'number') patch.elevenStability = v.stability;
            if (typeof v.style === 'number') patch.elevenStyle = v.style;
            writeSecrets(patch);
          }
        } else if (!(typeof b.key === 'string' && b.key.trim())) {
          return send(res, 400, JSON.stringify({ error: 'nothing to set' }));
        }
        const c = getElevenCfg(query.channel);
        send(res, 200, JSON.stringify({ ok: true, hasKey: !!c.key, voiceId: c.voiceId, model: c.model, stability: c.stability, style: c.style, scope: c.scope }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Voice Lab: list account voices ---
  if (pathname === '/api/voice-list' && req.method === 'GET') {
    const cfg = getElevenCfg(query.channel);
    (async () => {
      if (!cfg.key) return send(res, 200, JSON.stringify({ voices: [], error: 'No ElevenLabs key set.' }));
      try {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': cfg.key } });
        const j = await r.json();
        const voices = (j.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name, labels: v.labels || {}, preview_url: v.preview_url || '', category: v.category }));
        send(res, 200, JSON.stringify({ voices, current: cfg.voiceId }));
      } catch (e) { send(res, 200, JSON.stringify({ voices: [], error: String(e && e.message || e) })); }
    })();
    return;
  }
  // --- Voice Lab: search the shared voice library ---
  if (pathname === '/api/shared-voices' && req.method === 'GET') {
    const cfg = getElevenCfg(query.channel);
    (async () => {
      if (!cfg.key) return send(res, 200, JSON.stringify({ voices: [] }));
      try {
        const p = new URLSearchParams(); p.set('page_size', '40'); p.set('language', 'en');
        if (query.search) p.set('search', query.search);
        if (query.gender) p.set('gender', query.gender);
        if (query.age) p.set('age', query.age);
        if (query.use_case) p.set('use_cases', query.use_case);
        const r = await fetch('https://api.elevenlabs.io/v1/shared-voices?' + p.toString(), { headers: { 'xi-api-key': cfg.key } });
        const j = await r.json();
        const voices = (j.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name, preview_url: v.preview_url || '', accent: v.accent, age: v.age, gender: v.gender, use_case: v.use_case, descriptive: v.descriptive, clones: v.cloned_by_count }));
        send(res, 200, JSON.stringify({ voices }));
      } catch (e) { send(res, 200, JSON.stringify({ voices: [], error: String(e && e.message || e) })); }
    })();
    return;
  }
  // --- Voice Lab: preview a voice saying the test line (cached so re-listening is free) ---
  if (pathname === '/api/voice-preview' && req.method === 'GET') {
    const cfg = getElevenCfg(query.channel);
    if (!cfg.key) return send(res, 400, 'no key', 'text/plain');
    const voiceId = query.voiceId, text = (query.text || '').slice(0, 600);
    if (!voiceId || !safeSeg(voiceId) || !text) return send(res, 400, 'bad', 'text/plain');
    const model = query.model || 'eleven_multilingual_v2';
    const stab = query.stability !== undefined ? Math.min(1, Math.max(0, parseFloat(query.stability) || 0)) : 0.4;
    const style = query.style !== undefined ? Math.min(1, Math.max(0, parseFloat(query.style) || 0)) : 0.3;
    (async () => {
      try {
        const cacheDir = path.join(__dirname, '.voicecache'); fs.mkdirSync(cacheDir, { recursive: true });
        const h = crypto.createHash('sha256').update([voiceId, model, stab, style, text].join('|')).digest('hex').slice(0, 24);
        const f = path.join(cacheDir, h + '.mp3');
        if (!fs.existsSync(f)) {
          const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
            method: 'POST', headers: { 'xi-api-key': cfg.key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: model, voice_settings: { stability: stab, similarity_boost: 0.75, style, use_speaker_boost: true } }),
          });
          if (!r.ok) { const t = await r.text(); return send(res, 502, 'tts error: ' + t.slice(0, 200), 'text/plain'); }
          fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f));
      } catch (e) { send(res, 502, 'err: ' + String(e && e.message || e), 'text/plain'); }
    })();
    return;
  }

  // --- Serve a generated scene image or a cast reference ---
  if (pathname === '/api/asset' && req.method === 'GET') {
    if (!safeSeg(query.channel) || !safeSeg(query.id) || !safeSeg(query.name)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(ROOT, query.channel, query.id, '04-assets', 'images', query.name);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return;
  }
  if (pathname === '/api/castref' && req.method === 'GET') {
    if (!safeSeg(query.channel) || !safeSeg(query.name)) return send(res, 400, 'bad', 'text/plain');
    const dir = sheetDirFor(query.channel, query.slug || '__default'); if (!dir) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(dir, query.name);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return;
  }
  if (pathname === '/api/audio' && req.method === 'GET') {
    if (!safeSeg(query.channel) || !safeSeg(query.id) || !safeSeg(query.name)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(ROOT, query.channel, query.id, '04-assets', 'audio', query.name);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return;
  }

  // --- Music bed library: browse/audition candidate beds in <channel>/_assets/music/_auditions ---
  // Data-driven: any .mp3/.wav/.m4a dropped there is listed; library.json supplies title/composer/
  // license/attribution/mood/note. The track whose byte size matches the live bed.mp3 is flagged.
  if (pathname === '/api/music-library' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const musicDir = path.join(ROOT, query.channel, '_assets', 'music');
    const audDir = path.join(musicDir, '_auditions');
    let manifest = { tracks: [] };
    try { manifest = JSON.parse(fs.readFileSync(path.join(audDir, 'library.json'), 'utf8')); } catch (_) {}
    const meta = {}; (manifest.tracks || []).forEach((t) => { if (t.file) meta[t.file] = t; });
    let bedSize = null;
    try { bedSize = fs.statSync(path.join(musicDir, 'bed.mp3')).size; } catch (_) {}
    const tracks = [];
    if (fs.existsSync(audDir)) {
      for (const f of fs.readdirSync(audDir)) {
        if (!/\.(mp3|wav|m4a|aac)$/i.test(f) || /-44k\.mp3$/i.test(f)) continue;
        let size = 0; try { size = fs.statSync(path.join(audDir, f)).size; } catch (_) {}
        const m = meta[f] || {};
        tracks.push({
          file: f,
          title: m.title || f.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          composer: m.composer || '', license: m.license || '', attribution: m.attribution || '',
          mood: m.mood || [], source: m.source || '', note: m.note || '',
          size, isBed: bedSize != null && size === bedSize,
        });
      }
    }
    const order = (manifest.tracks || []).map((t) => t.file);
    tracks.sort((a, b) => {
      const ia = order.indexOf(a.file), ib = order.indexOf(b.file);
      if (ia !== ib) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      return a.title.localeCompare(b.title);
    });
    return send(res, 200, JSON.stringify({ hasBed: bedSize != null, tracks }));
  }
  if (pathname === '/api/music-file' && req.method === 'GET') {
    if (!safeSeg(query.channel) || !safeSeg(query.name)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(ROOT, query.channel, '_assets', 'music', '_auditions', query.name);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    const type = /\.wav$/i.test(f) ? 'audio/wav' : (/\.(m4a|aac)$/i.test(f) ? 'audio/mp4' : 'audio/mpeg');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return;
  }
  // --- Promote an audition track to the channel bed (copies it to bed.mp3; renders nothing). ---
  if (pathname === '/api/set-bed' && req.method === 'POST') {
    if (!safeSeg(query.channel) || !safeSeg(query.name)) return send(res, 400, JSON.stringify({ error: 'bad request' }));
    const musicDir = path.join(ROOT, query.channel, '_assets', 'music');
    const src = path.join(musicDir, '_auditions', query.name);
    if (!src.startsWith(ROOT) || !fs.existsSync(src)) return send(res, 404, JSON.stringify({ error: 'track not found' }));
    try {
      fs.copyFileSync(src, path.join(musicDir, 'bed.mp3'));
      const r44 = path.join(musicDir, 'bed-44k.mp3'); if (fs.existsSync(r44)) { try { fs.unlinkSync(r44); } catch (_) {} }
      // The assembler copies the channel bed into <video>/04-assets/music and resamples it; clear the
      // working video's cached copies so the NEXT assemble re-derives from the new bed.
      if (safeSeg(query.id)) {
        const vidMusic = path.join(ROOT, query.channel, query.id, '04-assets', 'music');
        if (fs.existsSync(vidMusic)) for (const f of fs.readdirSync(vidMusic)) if (/^bed.*\.(mp3|wav|m4a|aac)$/i.test(f)) { try { fs.unlinkSync(path.join(vidMusic, f)); } catch (_) {} }
      }
      let attribution = '';
      try {
        const man = JSON.parse(fs.readFileSync(path.join(musicDir, '_auditions', 'library.json'), 'utf8'));
        const t = (man.tracks || []).find((x) => x.file === query.name);
        if (t) attribution = t.attribution || '';
      } catch (_) {}
      return send(res, 200, JSON.stringify({ ok: true, bed: query.name, attribution }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }

  // --- Lock the cast: make a clean per-character reference from the cast sheet ---
  if (pathname === '/api/lock-cast' && req.method === 'POST') {
    const ch = query.channel;
    if (!safeSeg(ch)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
    const slug = query.slug || '__default';
    const dir = sheetDirFor(ch, slug); if (!dir) return send(res, 400, JSON.stringify({ error: 'bad sheet' }));
    const sheet = path.join(dir, 'cast-sheet.png');
    if (!fs.existsSync(sheet)) return send(res, 400, JSON.stringify({ error: 'cast-sheet.png not found' }));
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const lk = 'lockcast|' + ch;
      if (generatingImages.has(lk)) return send(res, 200, JSON.stringify({ reply: 'Already locking the cast — hang tight.', busy: true }));
      generatingImages.add(lk);
      try {
        const made = [];
        for (const c of readSheetRoster(ch, slug)) {
          const prompt = `From the attached cast sheet, draw ONLY ${c.name} (${c.desc}) — full body, neutral relaxed pose, facing forward, on a plain white background, in the exact same flat hand-drawn colored stick-figure style. No other characters, no text. This is a clean character reference.`;
          const buf = await geminiImage(key, prompt, [sheet]);
          fs.writeFileSync(path.join(dir, c.name + '.png'), buf);
          made.push(c.name);
        }
        send(res, 200, JSON.stringify({ reply: 'Locked the cast: ' + made.join(', ') + '. These per-character refs keep each one consistent.', made }));
      } catch (e) { send(res, 200, JSON.stringify({ reply: 'Lock-cast failed: ' + String(e && e.message || e), isError: true })); }
      finally { generatingImages.delete(lk); }
    });
    return;
  }

  // --- Character bank: list / add / remove / regenerate the channel's cast roster ---
  if (pathname === '/api/cast' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const slug = query.slug || '__default';
    const refDir = sheetDirFor(query.channel, slug);
    if (!refDir) return send(res, 400, JSON.stringify({ error: 'bad sheet' }));
    const roster = readSheetRoster(query.channel, slug).map((c) => ({
      name: c.name, desc: c.desc || '', color: c.color || null,
      hasRef: fs.existsSync(path.join(refDir, c.name + '.png')),
    }));
    const busy = generatingImages.has('cast|' + query.channel) || generatingImages.has('lockcast|' + query.channel);
    return send(res, 200, JSON.stringify({ slug, roster, hasSheet: fs.existsSync(path.join(refDir, 'cast-sheet.png')), busy }));
  }
  if (pathname === '/api/cast/add' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { name, desc, color } = JSON.parse(body || '{}');
        const slug = query.slug || '__default';
        const clean = String(name || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9]{1,19}$/.test(clean)) return send(res, 400, JSON.stringify({ error: 'Name must be one word: a letter then letters/numbers, 2–20 chars (e.g. "Rok").' }));
        if (!String(desc || '').trim()) return send(res, 400, JSON.stringify({ error: 'Add a short visual description (skin, hair, clothing).' }));
        const roster = readSheetRoster(query.channel, slug);
        if (roster.some((c) => c.name.toLowerCase() === clean.toLowerCase())) return send(res, 409, JSON.stringify({ error: 'A character named ' + clean + ' already exists.' }));
        const lk = 'cast|' + query.channel;
        if (generatingImages.has(lk)) return send(res, 200, JSON.stringify({ busy: true, reply: 'Already generating a character portrait — hang tight.' }));
        if (!getGeminiKey()) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set — add it on the Scenes tab first.' }));
        generatingImages.add(lk);
        try {
          await genCharRef(query.channel, clean, String(desc || '').trim(), slug);
          roster.push(Object.assign({ name: clean, desc: String(desc || '').trim() }, color ? { color } : {}));
          writeSheetRoster(query.channel, slug, roster);
          send(res, 200, JSON.stringify({ ok: true, name: clean }));
        } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
        finally { generatingImages.delete(lk); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  if (pathname === '/api/cast/regenerate' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { name } = JSON.parse(body || '{}');
        const slug = query.slug || '__default';
        const c = readSheetRoster(query.channel, slug).find((x) => x.name === name);
        if (!c) return send(res, 404, JSON.stringify({ error: 'no such character' }));
        const lk = 'cast|' + query.channel;
        if (generatingImages.has(lk)) return send(res, 200, JSON.stringify({ busy: true, reply: 'Already generating — hang tight.' }));
        if (!getGeminiKey()) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
        generatingImages.add(lk);
        try { await genCharRef(query.channel, c.name, c.desc || '', slug); send(res, 200, JSON.stringify({ ok: true, name: c.name })); }
        catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
        finally { generatingImages.delete(lk); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  if (pathname === '/api/cast/remove' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body || '{}');
        const slug = query.slug || '__default';
        if (!safeSeg(String(name || ''))) return send(res, 400, JSON.stringify({ error: 'bad name' }));
        const roster = readSheetRoster(query.channel, slug).filter((c) => c.name !== name);
        writeSheetRoster(query.channel, slug, roster);
        try { fs.unlinkSync(path.join(sheetDirFor(query.channel, slug), name + '.png')); } catch (_) {}
        send(res, 200, JSON.stringify({ ok: true, roster: roster.map((c) => c.name) }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  // Which roster members are cast in THIS video (stored on doc.cast).
  if (pathname === '/api/video-cast' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { cast } = JSON.parse(body || '{}');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        doc.cast = Array.isArray(cast) ? cast.filter((x) => typeof x === 'string') : [];
        doc.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(doc, null, 2));
        send(res, 200, JSON.stringify({ ok: true, cast: doc.cast }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- CHARACTER SHEET BANK: list / create (generate or upload) / delete; select one per video ---
  if (pathname === '/api/sheets' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const sheets = listSheets(query.channel);
    const active = (query.id && safeSeg(query.id)) ? activeSheet(query.channel, query.id).slug : '__default';
    return send(res, 200, JSON.stringify({ sheets, active, busy: generatingImages.has('cast|' + query.channel) }));
  }
  // Select which sheet a video uses. Picking a channel sheet clears any per-video custom cast + adapt
  // note, so the chosen sheet actually takes effect (a custom per-video sheet otherwise wins).
  if (pathname === '/api/video/select-sheet' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const s = (JSON.parse(body || '{}').slug) || '__default';
        if (s !== '__default') { const d = sheetDirFor(query.channel, s); if (!d || !fs.existsSync(path.join(d, 'cast-sheet.png'))) return send(res, 400, JSON.stringify({ error: 'no such sheet' })); }
        const cdir = path.join(ROOT, query.channel, query.id, '04-assets', 'cast');
        if (fs.existsSync(cdir)) for (const f of fs.readdirSync(cdir)) if (/\.(png|json)$/i.test(f)) { try { fs.unlinkSync(path.join(cdir, f)); } catch (_) {} }
        const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
        live.sheetSlug = (s === '__default') ? '' : s;
        delete live.castAdapt;
        live.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        send(res, 200, JSON.stringify({ ok: true, sheetSlug: live.sheetSlug }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  if (pathname === '/api/sheets/create' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 14e6) req.destroy(); });
    req.on('end', async () => {
      let o = {}; try { o = JSON.parse(body || '{}'); } catch (_) {}
      const title = String(o.title || '').trim();
      if (!title) return send(res, 400, JSON.stringify({ error: 'Name the sheet (e.g. "Ice-Age Neanderthals").' }));
      const mode = o.mode === 'upload' ? 'upload' : 'generate';
      const chars = Array.isArray(o.characters)
        ? o.characters.map((c) => ({ name: String(c.name || '').trim(), desc: String(c.desc || '').trim() })).filter((c) => /^[A-Za-z][A-Za-z0-9]{1,19}$/.test(c.name))
        : [];
      const base = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) || 'sheet';
      const baseDir = path.join(ROOT, query.channel, '_assets', 'sheets');
      let slug = base, n = 1; while (fs.existsSync(path.join(baseDir, slug))) slug = base + '-' + (++n);
      const dir = path.join(baseDir, slug);
      const lk = 'cast|' + query.channel;
      if (generatingImages.has(lk)) return send(res, 200, JSON.stringify({ busy: true, reply: 'Already generating — hang tight.' }));
      generatingImages.add(lk);
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (mode === 'upload') {
          const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(o.dataUrl || ''));
          if (!m) { generatingImages.delete(lk); try { fs.rmdirSync(dir); } catch (_) {} return send(res, 400, JSON.stringify({ error: 'Upload a PNG/JPEG/WebP image of the cast sheet.' })); }
          fs.writeFileSync(path.join(dir, 'cast-sheet.png'), Buffer.from(m[2], 'base64'));
        } else {
          const key = getGeminiKey();
          if (!key) { generatingImages.delete(lk); try { fs.rmdirSync(dir); } catch (_) {} return send(res, 400, JSON.stringify({ error: 'No Gemini API key set (add it on the Scenes tab) to generate a sheet — or upload an image instead.' })); }
          const styleRef = path.join(ROOT, query.channel, '_assets', 'character-sheet', 'cast-sheet.png');
          const desc = String(o.description || '').trim();
          const list = chars.length ? chars.map((c) => c.name + (c.desc ? (' (' + c.desc + ')') : '')).join(', ') : desc;
          if (!list) { generatingImages.delete(lk); try { fs.rmdirSync(dir); } catch (_) {} return send(res, 400, JSON.stringify({ error: 'Describe the characters, or add at least one character row.' })); }
          const hasStyle = fs.existsSync(styleRef);
          const styleLine = hasStyle
            ? 'in the EXACT flat hand-drawn colored stick-figure style of the attached reference (same line weight, big expressive eyes, flat colors with light shading, bold outlines)'
            : 'in a clean flat hand-drawn colored cartoon stick-figure style — big expressive eyes, bold black outlines, flat colors';
          const prompt = `Draw a clean character cast sheet ${styleLine}: ${list}. Show each character FULL BODY, standing in a row, facing forward, evenly spaced on a plain white background. Keep each visually DISTINCT (hair, build, wardrobe). No text, no labels, no scene.`;
          fs.writeFileSync(path.join(dir, 'cast-sheet.png'), await geminiImage(key, prompt, hasStyle ? [styleRef] : []));
        }
        writeSheetRoster(query.channel, slug, chars);
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title, source: mode, createdAt: new Date().toISOString() }, null, 2));
        const made = [];
        if (getGeminiKey() && o.genPortraits !== false) {
          for (const c of chars) { try { await genCharRef(query.channel, c.name, c.desc, slug); made.push(c.name); } catch (_) {} }
        }
        send(res, 200, JSON.stringify({ ok: true, slug, title, characters: chars.map((c) => c.name), portraits: made }));
      } catch (e) { try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); } catch (_) {} send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingImages.delete(lk); }
    });
    return;
  }
  if (pathname === '/api/sheets/delete' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const slug = JSON.parse(body || '{}').slug;
        if (!slug || slug === '__default' || !safeSeg(slug)) return send(res, 400, JSON.stringify({ error: 'cannot delete that sheet' }));
        const dir = sheetDirFor(query.channel, slug);
        if (dir && fs.existsSync(dir)) { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} } try { fs.rmdirSync(dir); } catch (_) {} }
        send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- YouTube connect: status / save-app / OAuth dance / disconnect / refresh stats ---
  if (pathname === '/api/youtube/status' && req.method === 'GET') {
    const s = readSecrets(), yt = readYT(query.channel);
    return send(res, 200, JSON.stringify({
      hasApp: !!(s.youtubeClientId && s.youtubeClientSecret),
      connected: !!(yt && yt.refreshToken),
      channelTitle: yt && yt.channelTitle || null, channelId: yt && yt.channelId || null,
      subs: yt && yt.subs || null, views: yt && yt.views || null, connectedAt: yt && yt.connectedAt || null,
      redirect: YT_REDIRECT,
    }));
  }
  if (pathname === '/api/youtube/app' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        const cid = String(b.clientId || '').trim(), sec = String(b.clientSecret || '').trim();
        if (!cid || !sec) return send(res, 400, JSON.stringify({ error: 'paste both the Client ID and Client Secret' }));
        writeSecrets({ youtubeClientId: cid, youtubeClientSecret: sec });
        send(res, 200, JSON.stringify({ ok: true, hasApp: true }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  if (pathname === '/api/youtube/connect' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, 'bad channel', 'text/plain');
    const s = readSecrets();
    if (!s.youtubeClientId) return send(res, 400, 'Save your YouTube app credentials in the Studio first.', 'text/plain');
    const nonce = crypto.randomBytes(12).toString('hex');
    ytStates.set(nonce, { channel: query.channel, at: Date.now() });
    const p = new URLSearchParams({
      client_id: s.youtubeClientId, redirect_uri: YT_REDIRECT, response_type: 'code',
      scope: YT_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: nonce,
    });
    res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString() });
    return res.end();
  }
  if (pathname === '/api/youtube/oauth-callback' && req.method === 'GET') {
    const page = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>YouTube · Studio</title><body style="font-family:system-ui,sans-serif;background:#17120d;color:#f3ece0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:460px;padding:24px;line-height:1.5">' + msg + '</div></body>'); };
    const st = ytStates.get(query.state);
    if (query.error) return page('<h2>Authorization cancelled</h2><p style="opacity:.7">' + escH(query.error) + '</p>');
    if (!st || Date.now() - st.at > 10 * 60 * 1000) { ytStates.delete(query.state); return page('<h2>This link expired</h2><p style="opacity:.7">Start the connect again from the Studio (the link is good for 10 minutes).</p>'); }
    ytStates.delete(query.state);
    (async () => {
      try {
        const s = readSecrets();
        const tb = new URLSearchParams({ code: query.code || '', client_id: s.youtubeClientId, client_secret: s.youtubeClientSecret, redirect_uri: YT_REDIRECT, grant_type: 'authorization_code' });
        const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tb });
        const tj = await tr.json();
        if (!tj.access_token) throw new Error(tj.error_description || tj.error || 'token exchange failed');
        const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: 'Bearer ' + tj.access_token } });
        const cj = await cr.json();
        const ch = (cj.items || [])[0] || {};
        let refreshToken = tj.refresh_token;
        if (!refreshToken) { const prev = readYT(st.channel); if (prev && prev.refreshToken) refreshToken = prev.refreshToken; }
        if (!refreshToken) throw new Error('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions, then reconnect.');
        const info = { refreshToken, channelId: ch.id || '', channelTitle: (ch.snippet && ch.snippet.title) || '', subs: (ch.statistics && ch.statistics.subscriberCount) || null, views: (ch.statistics && ch.statistics.viewCount) || null, connectedAt: new Date().toISOString() };
        fs.mkdirSync(path.dirname(ytFile(st.channel)), { recursive: true });
        fs.writeFileSync(ytFile(st.channel), JSON.stringify(info, null, 2));
        page('<div style="font-size:46px">&#10003;</div><h2 style="margin:.3em 0">Connected to ' + escH(info.channelTitle || 'your channel') + '</h2>' + (info.subs ? '<p style="opacity:.7">' + Number(info.subs).toLocaleString() + ' subscribers</p>' : '') + '<p style="opacity:.55;font-size:14px">You can close this tab and return to the Studio.</p>');
      } catch (e) { page('<h2>Connection failed</h2><p style="opacity:.7">' + escH(String(e && e.message || e)) + '</p>'); }
    })();
    return;
  }
  if (pathname === '/api/youtube/disconnect' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    try { fs.unlinkSync(ytFile(query.channel)); } catch (_) {}
    return send(res, 200, JSON.stringify({ ok: true }));
  }
  if (pathname === '/api/youtube/refresh' && req.method === 'GET') {
    (async () => {
      try {
        const token = await ytAccessToken(query.channel);
        const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: 'Bearer ' + token } });
        const ch = ((await cr.json()).items || [])[0] || {};
        const yt = readYT(query.channel) || {};
        yt.channelTitle = (ch.snippet && ch.snippet.title) || yt.channelTitle;
        yt.subs = (ch.statistics && ch.statistics.subscriberCount) || yt.subs;
        yt.views = (ch.statistics && ch.statistics.viewCount) || yt.views;
        fs.writeFileSync(ytFile(query.channel), JSON.stringify(yt, null, 2));
        send(res, 200, JSON.stringify({ ok: true, channelTitle: yt.channelTitle, subs: yt.subs, views: yt.views }));
      } catch (e) { send(res, 200, JSON.stringify({ error: String(e && e.message || e) })); }
    })();
    return;
  }

  // --- Adapt the cast to THIS video's subject: generate per-video character portraits (e.g.
  //     Neanderthal versions) into <video>/04-assets/cast so image-gen reskins the cast for this
  //     video only, leaving other videos' default look untouched. Channel sheet is the style anchor. ---
  if (pathname === '/api/cast/adapt' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const lk = 'cast|' + query.channel + '|' + query.id;
      if (generatingImages.has(lk)) return send(res, 200, JSON.stringify({ busy: true, reply: 'Already adapting the cast — hang tight.' }));
      const key = getGeminiKey();
      if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
      const channelSheet = path.join(ROOT, query.channel, '_assets', 'character-sheet', 'cast-sheet.png');
      if (!fs.existsSync(channelSheet)) return send(res, 400, JSON.stringify({ error: 'channel cast-sheet.png not found' }));
      let opts = {}; try { opts = JSON.parse(body || '{}'); } catch (_) {}
      const note = String(opts.note || '').trim();
      if (!note) return send(res, 400, JSON.stringify({ error: 'Describe the adaptation, e.g. "as a Neanderthal: heavy brow, broad nose, stocky build, fur clothing".' }));
      const roster = readCast(query.channel);
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const used = new Set(((((doc.stages || {}).scenes || {}).candidates || {}).scenes || []).flatMap((s) => s.characters || []));
      let members;
      if (Array.isArray(opts.members) && opts.members.length) members = roster.filter((c) => opts.members.includes(c.name));
      else members = roster.filter((c) => used.has(c.name));
      if (!members.length) members = roster.slice(0, 4);
      const outDir = path.join(ROOT, query.channel, query.id, '04-assets', 'cast');
      // Optional LOOK reference image (e.g. an example thumbnail) placed in the cast dir — the
      // primary style/wardrobe anchor; the channel sheet stays for each character's identity.
      const refImg = (opts.refImage && safeSeg(String(opts.refImage))) ? path.join(outDir, String(opts.refImage)) : null;
      const lookAnchor = (refImg && fs.existsSync(refImg)) ? refImg : null;
      generatingImages.add(lk);
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const names = members.map((m) => m.name).join(', ');
        const lookLine = lookAnchor
          ? `Match the CHARACTER ART STYLE and wardrobe of the FIRST attached image (the look reference) — same clean rounded heads, big expressive eyes, thin simple limbs, bold outlines, and that style of fur garment. Use the SECOND attached image (the cast sheet) only to keep each character's identity (hair, colors).`
          : `Use the attached cast sheet for the style and each character's identity.`;
        const groupPrompt = `Draw a clean character cast sheet: ${names} standing in a row, full body, facing forward, on a plain white background. ${lookLine} Re-imagine EVERY one of them ${note}. Keep each visually DISTINCT (different hair) so they remain individual characters. Flat colored hand-drawn cartoon style, bold outlines, no text, no scene.`;
        const groupRefs = [lookAnchor, channelSheet].filter((f) => f && fs.existsSync(f));
        fs.writeFileSync(path.join(outDir, 'cast-sheet.png'), await geminiImage(key, groupPrompt, groupRefs));
        const sheetRef = path.join(outDir, 'cast-sheet.png');
        const made = ['cast-sheet'];
        for (const c of members) {
          const channelPortrait = path.join(ROOT, query.channel, '_assets', 'character-sheet', c.name + '.png');
          const p = `Draw ONLY ${c.name}. ${lookLine} Re-imagine ${c.name} ${note}. Keep ${c.name}'s identity recognizable (${c.desc || 'a person'}). Full body, neutral relaxed pose, facing forward, plain white background, flat colored hand-drawn cartoon style, bold outlines. No other characters, no text, no background scene.`;
          const charRefs = [lookAnchor, sheetRef, fs.existsSync(channelPortrait) ? channelPortrait : null].filter((f) => f && fs.existsSync(f));
          fs.writeFileSync(path.join(outDir, c.name + '.png'), await geminiImage(key, p, charRefs));
          made.push(c.name);
        }
        // Persist the adaptation so the WHOLE pipeline (script, scenes, thumbnail prompts) knows this
        // video's cast wears the adapted look — videoCast()/castPromptLine() read studio.json.cast.note.
        await withFileLock(sp, () => {
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.castAdapt = { note, refImage: lookAnchor ? path.basename(lookAnchor) : (opts.refImage || null), members: members.map((m) => m.name), adaptedAt: new Date().toISOString() };
          // write a roster for the per-video custom sheet so videoRoster() resolves these members
          try { fs.writeFileSync(path.join(outDir, 'cast.json'), JSON.stringify(members, null, 2)); } catch (_) {}
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        });
        send(res, 200, JSON.stringify({ ok: true, made, dir: '04-assets/cast', usedRef: !!lookAnchor }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingImages.delete(lk); }
    });
    return;
  }

  // --- Upload a LOOK-REFERENCE image (data URL) into the video's cast dir as _reference.png, so
  //     /api/cast/adapt can use it as the primary style/wardrobe anchor. ---
  if (pathname === '/api/cast/upload-ref' && req.method === 'POST') {
    if (!safeSeg(query.channel) || !safeSeg(query.id)) return send(res, 400, JSON.stringify({ error: 'bad channel/id' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 12e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { dataUrl } = JSON.parse(body || '{}');
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
        if (!m) return send(res, 400, JSON.stringify({ error: 'expected a PNG/JPEG/WebP data URL' }));
        const outDir = path.join(ROOT, query.channel, query.id, '04-assets', 'cast');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, '_reference.png'), Buffer.from(m[2], 'base64'));
        send(res, 200, JSON.stringify({ ok: true, refImage: '_reference.png' }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  // --- Clear a video's per-video cast adaptation (revert to the channel's default cast). ---
  if (pathname === '/api/cast/clear' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try {
      const dir = path.join(ROOT, query.channel, query.id, '04-assets', 'cast');
      for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) { if (/\.png$/i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} } }
      const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
      delete live.castAdapt; live.updatedAt = new Date().toISOString();
      fs.writeFileSync(sp, JSON.stringify(live, null, 2));
      send(res, 200, JSON.stringify({ ok: true }));
    } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    return;
  }
  // --- Status of a video's cast adaptation (for the Studio UI). ---
  if (pathname === '/api/cast/adapt-status' && req.method === 'GET') {
    const vc = videoCast(query.channel, query.id);
    const dir = path.join(ROOT, query.channel, query.id, '04-assets', 'cast');
    const portraits = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /\.png$/i.test(f) && f !== 'cast-sheet.png' && f !== '_reference.png').map((f) => f.replace(/\.png$/i, ''));
    const hasRef = fs.existsSync(path.join(dir, '_reference.png'));
    return send(res, 200, JSON.stringify({ adapted: vc.adapted, note: vc.note, roster: vc.names, used: vc.used, portraits, hasRef, busy: generatingImages.has('cast|' + query.channel + '|' + query.id) }));
  }
  // --- Serve a per-video cast image (cast-sheet / portrait / reference) for the Studio UI. ---
  if (pathname === '/api/cast/file' && req.method === 'GET') {
    if (!safeSeg(query.channel) || !safeSeg(query.id) || !safeSeg(query.name)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(ROOT, query.channel, query.id, '04-assets', 'cast', query.name);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return;
  }

  // --- Upload the finished rough cut to YouTube (resumable, chunked for progress) ---
  if (pathname === '/api/youtube/upload' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const k = query.channel + '|' + query.id;
      if (uploadingYT.has(k)) return send(res, 200, JSON.stringify({ running: true, reply: 'Already uploading — watch the progress.' }));
      let opts = {}; try { opts = JSON.parse(body || '{}'); } catch (_) {}
      const privacy = ['private', 'unlisted', 'public'].includes(opts.privacy) ? opts.privacy : 'private';
      const yt = readYT(query.channel);
      if (!yt || !yt.refreshToken) return send(res, 400, JSON.stringify({ error: 'Connect this channel to YouTube first (the 📺 button).' }));
      const folder = path.dirname(sp);
      const video = path.join(folder, '05-edit', 'rough-cut.mp4');
      if (!fs.existsSync(video)) return send(res, 400, JSON.stringify({ error: 'No rough-cut.mp4 yet — assemble the video first.' }));
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const pk = doc.stages.packaging || {}, dec = pk.decision || {};
      const tObj = ((pk.candidates || {}).titles || []).find((t) => t.id === dec.primaryTitle);
      const title = String((tObj && tObj.text) || doc.workingTitle || query.id).slice(0, 100);
      let description = ''; try { description = fs.readFileSync(path.join(folder, '07-publish', 'description.txt'), 'utf8'); } catch (_) {}
      if (!description.trim()) description = title + '\n\nAnimated explainers on deep human prehistory, every week.';
      let tags = []; try { const kit = fs.readFileSync(path.join(folder, '07-publish', 'publish-kit.md'), 'utf8'); const m = kit.match(/##\s*Tags\s*\n([^\n]+)/i); if (m) tags = m[1].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 15); } catch (_) {}
      uploadingYT.add(k); ytUploadStatus[k] = { state: 'starting', pct: 0 };
      send(res, 200, JSON.stringify({ started: true }));
      (async () => {
        try {
          const token = await ytAccessToken(query.channel);
          const total = fs.statSync(video).size;
          const meta = { snippet: { title, description: description.slice(0, 4900), tags, categoryId: '27', defaultLanguage: 'en', defaultAudioLanguage: 'en' }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true } };
          const startRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(total) }, body: JSON.stringify(meta) });
          if (!startRes.ok) throw new Error('start session ' + startRes.status + ': ' + (await startRes.text()).slice(0, 300));
          const uploadUrl = startRes.headers.get('location');
          if (!uploadUrl) throw new Error('no resumable session URL returned');
          ytUploadStatus[k] = { state: 'uploading', pct: 0 };
          const fd = fs.openSync(video, 'r'); const CHUNK = 8 * 1024 * 1024; const bufc = Buffer.allocUnsafe(CHUNK);
          let start = 0, videoId = '';
          try {
            while (start < total) {
              const len = Math.min(CHUNK, total - start);
              fs.readSync(fd, bufc, 0, len, start);
              const r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${start + len - 1}/${total}` }, body: bufc.subarray(0, len) });
              if (r.status === 308) { start += len; ytUploadStatus[k] = { state: 'uploading', pct: Math.round((start / total) * 100) }; continue; }
              if (r.status === 200 || r.status === 201) { videoId = (await r.json()).id; start = total; break; }
              throw new Error('chunk ' + r.status + ': ' + (await r.text()).slice(0, 300));
            }
          } finally { fs.closeSync(fd); }
          if (!videoId) throw new Error('upload finished without a video id');
          ytUploadStatus[k] = { state: 'thumbnail', pct: 100, videoId };
          let note = '';
          const thumb = path.join(folder, '00-packaging', 'thumbnails', 'final-1.png');
          if (fs.existsSync(thumb)) {
            try { const tr = await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + videoId, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/png' }, body: fs.readFileSync(thumb) }); if (!tr.ok) note = ' Thumbnail not set (' + tr.status + ' — needs a phone-verified channel; set it in YouTube Studio).'; } catch (_) { note = ' Thumbnail upload skipped.'; }
          }
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.youtube = { videoId, privacy, uploadedAt: new Date().toISOString(), title };
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
          ytUploadStatus[k] = { state: 'done', pct: 100, videoId, url: 'https://youtu.be/' + videoId, studioUrl: 'https://studio.youtube.com/video/' + videoId + '/edit', privacy, note };
        } catch (e) { ytUploadStatus[k] = { state: 'error', error: String(e && e.message || e) }; }
        finally { uploadingYT.delete(k); }
      })();
    });
    return;
  }
  if (pathname === '/api/youtube/upload-status' && req.method === 'GET') {
    const k = query.channel + '|' + query.id;
    return send(res, 200, JSON.stringify(Object.assign({ running: uploadingYT.has(k) }, ytUploadStatus[k] || { state: 'idle' })));
  }

  // --- Generate every scene image via Gemini (resumes; skips existing) ---
  if (pathname === '/api/generate-images' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (generatingImages.has(ik)) return send(res, 200, JSON.stringify({ reply: 'Images are already being generated — hang tight.', busy: true }));
      generatingImages.add(ik);
      try {
        const opts = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
        const testOnly = !!opts.testOnly, force = !!opts.force;
        const folder = path.dirname(sp);
        const imgDir = path.join(folder, '04-assets', 'images');
        fs.mkdirSync(imgDir, { recursive: true });
        const refDir = castRefDir(query.channel, query.id);
        const sheet = path.join(refDir, 'cast-sheet.png');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        let scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        if (!scenes.length) return send(res, 200, JSON.stringify({ reply: 'No scenes yet — generate the scene list first.', isError: true }));
        const work = testOnly ? scenes.slice(0, 1) : scenes;
        let made = 0; const failedScenes = [];
        // Sequential ON PURPOSE: each illustration uses the previous frame as a consistency reference.
        for (const s of work) {
          if (s.kind === 'map') continue;                                      // maps are rendered by the map engine, not Gemini
          const idx = scenes.indexOf(s);
          const nn = String(s.n || (idx + 1)).padStart(3, '0');
          const outAbs = path.join(imgDir, nn + '.png');
          if (!testOnly && !force && s.imagePath && fs.existsSync(outAbs)) continue;   // resume / skip existing
          try { await withRetry(() => renderScene(key, sp, scenes, idx, imgDir, refDir, sheet)); made++; }
          catch (e) { failedScenes.push(s.n); }
        }
        send(res, 200, JSON.stringify({ reply: (testOnly ? 'Test image done. ' : '') + 'Generated ' + made + ' image' + (made === 1 ? '' : 's') + (failedScenes.length ? (', failed: ' + failedScenes.join(', ') + ' (check the key/quota)') : '') + '.', made, failed: failedScenes.length, failedScenes, isError: made === 0 }));
      } catch (e) { send(res, 200, JSON.stringify({ reply: 'Image generation failed: ' + String(e && e.message || e), isError: true })); }
      finally { generatingImages.delete(ik); }
    });
    return;
  }

  // --- Regenerate a SINGLE scene image via Gemini (in place) ---
  if (pathname === '/api/generate-image' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (generatingImages.has(ik)) return send(res, 200, JSON.stringify({ reply: 'A full image run is in progress — wait for it to finish.', busy: true }));
      try {
        const n = JSON.parse(body || '{}').n;
        const folder = path.dirname(sp);
        const imgDir = path.join(folder, '04-assets', 'images'); fs.mkdirSync(imgDir, { recursive: true });
        const refDir = castRefDir(query.channel, query.id);
        const sheet = path.join(refDir, 'cast-sheet.png');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        const idx = scenes.findIndex((s) => String(s.n) === String(n));
        if (idx < 0) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        const rk = ik + '|' + n;
        if (regeneratingScenes.has(rk)) return send(res, 200, JSON.stringify({ reply: 'Scene ' + n + ' is already being rendered.', busy: true }));
        regeneratingScenes.add(rk);
        try {
          const imagePath = await renderScene(key, sp, scenes, idx, imgDir, refDir, sheet);
          send(res, 200, JSON.stringify({ reply: 'Rendered scene ' + n + '.', imagePath }));
        } catch (e) { send(res, 200, JSON.stringify({ reply: 'Scene ' + n + ' failed: ' + String(e && e.message || e), isError: true })); }
        finally { regeneratingScenes.delete(rk); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Render ONE reveal/reaction frame of a scene (delta off the previous frame) ---
  if (pathname === '/api/generate-frame' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (generatingImages.has(ik)) return send(res, 200, JSON.stringify({ reply: 'A full image run is in progress — wait for it to finish.', busy: true }));
      try {
        const { n, index } = JSON.parse(body || '{}');
        const folder = path.dirname(sp);
        const imgDir = path.join(folder, '04-assets', 'images'); fs.mkdirSync(imgDir, { recursive: true });
        const refDir = castRefDir(query.channel, query.id);
        const sheet = path.join(refDir, 'cast-sheet.png');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        const idx = scenes.findIndex((x) => String(x.n) === String(n));
        if (idx < 0) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        if (!((scenes[idx].frames || [])[index])) return send(res, 400, JSON.stringify({ error: 'frame ' + index + ' not found' }));
        const rk = ik + '|f|' + n + '|' + index;
        if (renderingFrames.has(rk)) return send(res, 200, JSON.stringify({ reply: 'That frame is already rendering.', busy: true }));
        renderingFrames.add(rk);
        try {
          const imagePath = await renderFrame(key, sp, scenes, idx, index, imgDir, refDir, sheet);
          send(res, 200, JSON.stringify({ reply: 'Rendered frame ' + (index + 1) + ' of scene ' + n + '.', imagePath }));
        } catch (e) { send(res, 200, JSON.stringify({ reply: 'Frame failed: ' + String(e && e.message || e), isError: true })); }
        finally { renderingFrames.delete(rk); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Generate narration for every beat via ElevenLabs (resumes; skips existing) ---
  if (pathname === '/api/generate-narration' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const cfg = getElevenCfg(query.channel);
    if (!cfg.key) return send(res, 400, JSON.stringify({ error: 'No ElevenLabs API key set.' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (generatingNarration.has(ik)) return send(res, 200, JSON.stringify({ reply: 'Narration is already being generated — hang tight.', busy: true }));
      generatingNarration.add(ik);
      try {
        const opts = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
        const testOnly = !!opts.testOnly, force = !!opts.force;   // force = re-voice everything (e.g. after a voice change)
        const folder = path.dirname(sp);
        const audioDir = path.join(folder, '04-assets', 'audio');
        fs.mkdirSync(audioDir, { recursive: true });
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        if (!scenes.length) return send(res, 200, JSON.stringify({ reply: 'No scenes yet — generate the scene list first.', isError: true }));
        const work = testOnly ? scenes.slice(0, 1) : scenes;
        const targets = work.filter((s, i) => {
          if (!(s.narration || '').trim()) return false;
          if (testOnly || force) return true;
          const nn = String(s.n || (work.indexOf(s) + 1)).padStart(3, '0');
          return !(s.audioPath && fs.existsSync(path.join(audioDir, nn + '.mp3')));   // resume / skip existing
        });
        // 3-wide pool + one retry per beat: ~3x faster for a full 90+ beat run, same credit cost
        const results = await mapPool(targets, 3, (s) => withRetry(() => renderNarration(cfg, sp, scenes, scenes.indexOf(s), audioDir)));
        const failedBeats = targets.filter((s, i) => results[i] && results[i].__err).map((s) => s.n);
        const made = results.filter((r) => r && !r.__err).length;
        send(res, 200, JSON.stringify({ reply: (testOnly ? 'Test narration done. ' : '') + 'Voiced ' + made + ' beat' + (made === 1 ? '' : 's') + (failedBeats.length ? (', failed: ' + failedBeats.join(', ') + ' (check key/quota)') : '') + '.', made, failed: failedBeats.length, failedBeats, isError: made === 0 && failedBeats.length > 0 }));
      } catch (e) { send(res, 200, JSON.stringify({ reply: 'Narration failed: ' + String(e && e.message || e), isError: true })); }
      finally { generatingNarration.delete(ik); }
    });
    return;
  }

  // --- Re-voice a SINGLE beat via ElevenLabs ---
  if (pathname === '/api/generate-voice' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const cfg = getElevenCfg(query.channel);
    if (!cfg.key) return send(res, 400, JSON.stringify({ error: 'No ElevenLabs API key set.' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (generatingNarration.has(ik)) return send(res, 200, JSON.stringify({ reply: 'A full narration run is in progress — wait for it to finish.', busy: true }));
      try {
        const n = JSON.parse(body || '{}').n;
        const folder = path.dirname(sp);
        const audioDir = path.join(folder, '04-assets', 'audio'); fs.mkdirSync(audioDir, { recursive: true });
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        const idx = scenes.findIndex((x) => String(x.n) === String(n));
        if (idx < 0) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        if (!(scenes[idx].narration || '').trim()) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' has no narration to voice' }));
        const rk = ik + '|' + n;
        if (revoicingScenes.has(rk)) return send(res, 200, JSON.stringify({ reply: 'Beat ' + n + ' is already being voiced.', busy: true }));
        revoicingScenes.add(rk);
        try {
          const r = await renderNarration(cfg, sp, scenes, idx, audioDir);
          send(res, 200, JSON.stringify({ reply: 'Re-voiced beat ' + n + ' (' + (r ? r.seconds : '?') + 's).', seconds: r && r.seconds }));
        } catch (e) { send(res, 200, JSON.stringify({ reply: 'Beat ' + n + ' failed: ' + String(e && e.message || e), isError: true })); }
        finally { revoicingScenes.delete(rk); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Patch a single scene's fields in place (human editing the scene list) ---
  if (pathname === '/api/update-scene' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { n, patch } = JSON.parse(body || '{}');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        const s = scenes.find((x) => String(x.n) === String(n));
        if (!s) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        const p = patch || {};
        if (typeof p.imagePrompt === 'string') s.imagePrompt = p.imagePrompt;
        if (typeof p.visual === 'string') s.visual = p.visual;
        if (typeof p.narration === 'string') s.narration = p.narration;
        if (typeof p.onScreenText === 'string') s.onScreenText = p.onScreenText;
        if (['top-center', 'center', 'lower-third', 'none'].includes(p.textPos)) s.textPos = p.textPos;
        if (p.kind === 'illustration' || p.kind === 'infographic' || p.kind === 'map') s.kind = p.kind;
        if (p.map === null) delete s.map;                       // clear an accurate-map spec
        else if (p.map && typeof p.map === 'object' && Array.isArray(p.map.focus) && p.map.focus.length) {
          const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
          const coords = (a) => (Array.isArray(a) ? a.filter((c) => Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === 'number')) : []);
          s.map = {
            rotateLng: num(p.map.rotateLng, 0),
            focus: coords(p.map.focus),
            routes: Array.isArray(p.map.routes) ? p.map.routes.map(coords).filter((r) => r.length >= 2) : [],
            arcs: Array.isArray(p.map.arcs) ? p.map.arcs.filter((a) => a && Array.isArray(a.from) && Array.isArray(a.to)) : [],
            labels: Array.isArray(p.map.labels) ? p.map.labels.filter((l) => l && typeof l.text === 'string' && Array.isArray(l.coord)).map((l) => ({ text: l.text.slice(0, 40), coord: l.coord, size: num(l.size, 44) })) : [],
            labelStyle: ['modern', 'serif', 'minimal'].includes(p.map.labelStyle) ? p.map.labelStyle : 'serif',
            ...(p.map.hand ? { hand: true, wobble: num(p.map.wobble, 14) } : {}),
            ...(typeof p.map.padding === 'number' ? { padding: p.map.padding } : {}),
          };
          if (!s.map.focus.length) delete s.map;
        }
        if (Array.isArray(p.characters)) s.characters = p.characters.filter((x) => typeof x === 'string');
        if (['push-in', 'push-out', 'pan-left', 'pan-right', 'static'].includes(p.motion)) s.motion = p.motion;
        if (['punch', 'fade', 'type', 'none'].includes(p.textAnim)) s.textAnim = p.textAnim;
        if (Array.isArray(p.sfx)) s.sfx = p.sfx.filter((x) => typeof x === 'string');
        if (typeof p.ambient === 'string') s.ambient = p.ambient.trim().toLowerCase().replace(/^none$/, '');
        if (typeof p.musicCue === 'string') s.musicCue = ['act1', 'rehook', 'act2', 'payoff', 'outro'].includes(p.musicCue) ? p.musicCue : '';
        if (typeof p.castAction === 'string') s.castAction = p.castAction;
        if (Array.isArray(p.frames)) s.frames = p.frames.slice(0, 8).map((f) => ({
          role: (f && f.role === 'reaction') ? 'reaction' : 'reveal',
          prompt: (f && typeof f.prompt === 'string') ? f.prompt : '',
          imagePath: (f && typeof f.imagePath === 'string') ? f.imagePath : null,
        }));
        doc.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(doc, null, 2));
        send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) { send(res, 400, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Auto-assembler (Remotion): build a rough-cut MP4 from the storyboard ---
  if (pathname === '/api/assemble-status' && req.method === 'GET') {
    const installed = fs.existsSync(path.join(RENDER_DIR, 'node_modules', 'remotion'));
    const ik = query.channel + '|' + query.id;
    let status = {};
    const sf = studioPath(query.channel, query.id);
    let hasOutput = false;
    let hasSample = false;
    if (sf) {
      const editDir = path.join(path.dirname(sf), '05-edit');
      try { status = JSON.parse(fs.readFileSync(path.join(editDir, 'render-status.json'), 'utf8')); } catch (_) {}
      hasOutput = fs.existsSync(path.join(editDir, 'rough-cut.mp4'));
      hasSample = fs.existsSync(path.join(editDir, 'rough-cut-sample.mp4'));
    }
    return send(res, 200, JSON.stringify({ installed, running: assembling.has(ik), status, hasOutput, hasFull: hasOutput, hasSample }));
  }
  if (pathname === '/api/assemble' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    if (!fs.existsSync(path.join(RENDER_DIR, 'node_modules', 'remotion'))) {
      return send(res, 200, JSON.stringify({ error: 'Remotion not installed. Run once:  cd _studio/render && npm install', needsSetup: true, isError: true }));
    }
    const ik = query.channel + '|' + query.id;
    if (assembling.has(ik)) return send(res, 200, JSON.stringify({ reply: 'A rough cut is already rendering — hang tight.', running: true }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); }); req.on('end', () => {
      let from = '', to = '';
      try { const b = JSON.parse(body || '{}'); if (b.from) from = String(parseInt(b.from, 10) || ''); if (b.to) to = String(parseInt(b.to, 10) || ''); } catch (_) {}
      fs.mkdirSync(path.join(path.dirname(sp), '05-edit'), { recursive: true });
      assembling.add(ik);
      const log = fs.createWriteStream(path.join(path.dirname(sp), '05-edit', 'render.log'), { flags: 'a' });
      const args = [path.join(RENDER_DIR, 'render.mjs'), query.channel, query.id];
      if (from || to) args.push(from || to, to || from);
      const child = spawn(process.execPath, args, { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
      child.stdout.on('data', (d) => log.write(d)); child.stderr.on('data', (d) => log.write(d));
      child.on('error', () => assembling.delete(ik));
      child.on('close', () => { assembling.delete(ik); try { log.end(); } catch (_) {} });
      send(res, 200, JSON.stringify({ started: true }));
    });
    return;
  }
  if (pathname === '/api/video-file' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp) return send(res, 400, 'bad', 'text/plain');
    const name = query.which === 'sample' ? 'rough-cut-sample.mp4' : 'rough-cut.mp4';
    const f = path.join(path.dirname(sp), '05-edit', name);
    if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    const stat = fs.statSync(f), range = req.headers.range;
    // A read-stream 'error' (or an out-of-range start) MUST never crash the whole server.
    const pipeGuarded = (opts) => {
      const s = fs.createReadStream(f, opts);
      s.on('error', () => { try { res.destroy(); } catch (_) {} });
      s.pipe(res);
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end > stat.size - 1) end = stat.size - 1;     // clamp to EOF
      // Unsatisfiable (start past EOF, or inverted) → 416 instead of throwing in createReadStream.
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
      pipeGuarded({ start, end });
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      pipeGuarded({});
    }
    return;
  }

  // --- Render accurate-map still(s) from scene.map specs (n or 'all'); the assembler animates the same spec ---
  if (pathname === '/api/render-map' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    if (!fs.existsSync(path.join(RENDER_DIR, 'node_modules', 'remotion'))) {
      return send(res, 200, JSON.stringify({ error: 'Remotion not installed. Run once:  cd _studio/render && npm install', isError: true }));
    }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const ik = query.channel + '|' + query.id;
      if (renderingMaps.has(ik)) return send(res, 200, JSON.stringify({ reply: 'A map render is already running — hang tight.', busy: true }));
      let n = 'all';
      try { const b = JSON.parse(body || '{}'); if (b.n !== undefined) n = String(b.n); } catch (_) {}
      if (n !== 'all' && !/^\d+$/.test(n)) return send(res, 400, JSON.stringify({ error: 'bad scene number' }));
      renderingMaps.add(ik);
      const child = spawn(process.execPath, [path.join(RENDER_DIR, 'render-one-map.mjs'), query.channel, query.id, n], { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5 * 60 * 1000);
      child.on('error', (e) => { clearTimeout(t); renderingMaps.delete(ik); send(res, 200, JSON.stringify({ reply: 'Map render failed to start: ' + e, isError: true })); });
      child.on('close', (code) => {
        clearTimeout(t); renderingMaps.delete(ik);
        if (code === 0) send(res, 200, JSON.stringify({ reply: (out.trim().split('\n').pop() || 'Map rendered.'), isError: false }));
        else send(res, 200, JSON.stringify({ reply: 'Map render failed: ' + (err || out || 'exit ' + code).slice(-400), isError: true }));
      });
    });
    return;
  }

  // --- Final thumbnail ART via Gemini (the wireframe concept -> real 16:9 art, ~$0.04/variant) ---
  if (pathname === '/api/generate-thumbnail' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini API key set.' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (generatingThumbs.has(ik)) return send(res, 200, JSON.stringify({ reply: 'Thumbnails are already generating — hang tight.', busy: true }));
      generatingThumbs.add(ik);
      try {
        const opts = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
        const variants = Math.min(4, Math.max(1, parseInt(opts.variants, 10) || 2));
        const note = (opts.note || '').trim();
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const pk = (doc.stages || {}).packaging || {};
        const dec = pk.decision || {}, cand = pk.candidates || {};
        const titleObj = (cand.titles || []).find((t) => t.id === dec.primaryTitle);
        const title = (titleObj && titleObj.text) || doc.workingTitle || '';
        const concept = (cand.thumbnails || []).find((t) => t.id === dec.chosenThumbnail);
        const lay = concept && concept.layout;
        // hook text the art must contain, EXACTLY: prefer the structured headline, else scrape a legacy SVG, else the title
        let hook = '';
        if (lay && Array.isArray(lay.text) && lay.text.length) {
          hook = lay.text.map((t) => (typeof t === 'string' ? t : (t && t.line)) || '').join(' ').trim();
        } else if (concept && concept.svg) {
          const texts = []; const re = /<text[^>]*>([^<]+)<\/text>/g; let m;
          while ((m = re.exec(concept.svg))) { const t = m[1].trim(); if (t) texts.push(t); }
          hook = texts.sort((a, b) => b.length - a.length)[0] || '';
        }
        hook = (hook || '').toUpperCase();
        if (!hook) hook = title.split(/[—:–-]/)[0].trim().toUpperCase().slice(0, 28);
        // Build a precise scene description from the structured layout (subject + pose + props + mood)
        let scene = '';
        if (lay) {
          const s = lay.subject || {};
          const subj = (s.who && s.who !== 'none') ? (s.who + ' — ' + (s.pose || 'reacting with a big expressive face')) : (s.pose || 'the key visual');
          const props = (lay.props || []).length ? (' Key elements: ' + lay.props.join(', ') + '.') : '';
          scene = ' Scene: ' + subj + '.' + props + (lay.mood ? ' Mood/setting: ' + lay.mood + '.' : '');
        }
        // image models garble baked-in words; noText (default for multi-word hooks) draws clean art, the title is overlaid later
        const noText = (opts.noText != null) ? !!opts.noText : ((hook || '').trim().split(/\s+/).length > 1);
        const ready = ((doc.stages || {}).script && doc.stages.script.candidates && doc.stages.script.candidates.thumbnailPrompt) || '';
        // In noText mode, ignore the legacy text-laden script prompt and never name a title — both prime the model to render text.
        const base = (!noText && ready) ? ready : [
          noText
            ? 'Draw ONLY the illustration/artwork for a thumbnail (no title — the text is composited separately).'
            : 'Draw a YouTube thumbnail for the video titled "' + title + '".',
          concept ? ('Concept "' + concept.name + '".' + scene + ' ' + (concept.rationale || '')) : 'One dominant cast character with a big expressive face reacting to the key visual.',
        ].join(' ');
        const accent = (lay && lay.accent) ? lay.accent : '';
        const focal = (lay && lay.subject && lay.subject.zone) ? ('the ' + lay.subject.zone) : 'the left two-thirds';
        const textZone = (lay && lay.textZone) || 'left';
        const textClause = noText
          ? ' ABSOLUTELY NO TEXT of any kind — no letters, words, title, captions, signs, logos, numbers, or writing anywhere in the image; output the illustration ONLY. Leave the ' + textZone + ' ~40% of the frame as clean, empty background so a title can be overlaid later.'
          : ' Include the EXACT text "' + hook + '" in huge bold capital letters with a thick dark outline — spell it exactly, letter for letter.';
        const vc = videoCast(query.channel, query.id);
        const adaptClause = vc.note ? ' The cast are REIMAGINED for this video: ' + vc.note + ' — draw them in that adapted look, matching the attached adapted references exactly (not the channel default).' : '';
        const suffix = ' Flat colored hand-drawn stick-figure style EXACTLY matching the attached cast references (same faces, hair, and the wardrobe/look shown in those references, bold outlines, flat fills, no photorealism).' + adaptClause + ' YouTube thumbnail composition readable at 120x68 px: maximum 2-3 elements, ONE dominant focal subject in ' + focal + ', ' + (accent ? 'ONE accent color ' + accent : 'ONE accent color') + ', thick bold outlines, high contrast, dramatic lighting and a clear emotional read on the face, no clutter.' + textClause + ' Wide 16:9 landscape.' + (note ? ' Operator note: ' + note + '.' : '');
        // Use the per-video ADAPTED cast (Neanderthal versions, etc.) when it exists, else channel default.
        const refDir = castRefDir(query.channel, query.id);
        const refs = [path.join(refDir, 'cast-sheet.png')].filter((f) => fs.existsSync(f));
        for (const c of readCast(query.channel)) if ((base + ' ' + suffix).includes(c.name) && fs.existsSync(path.join(refDir, c.name + '.png'))) refs.push(path.join(refDir, c.name + '.png'));
        const outDir = path.join(path.dirname(sp), '00-packaging', 'thumbnails');
        fs.mkdirSync(outDir, { recursive: true });
        const files = [];
        for (let k = 1; k <= variants; k++) {
          const vary = k === 1 ? '' : (' Make this variant compositionally DIFFERENT from a typical take: change the angle, background color or framing while keeping the same concept' + (noText ? '.' : ' and text.'));
          const buf = await withRetry(() => geminiImage(key, base + suffix + vary, refs));
          const name = 'final-' + k + '.png';
          fs.writeFileSync(path.join(outDir, name), buf);
          logUsage(usageKeyFromSp(sp), { images: 1 });
          files.push('00-packaging/thumbnails/' + name);
        }
        await withFileLock(sp, () => {
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.stages.packaging = live.stages.packaging || {};
          live.stages.packaging.candidates = live.stages.packaging.candidates || {};
          live.stages.packaging.candidates.finalThumbs = files;
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        });
        send(res, 200, JSON.stringify({ reply: 'Generated ' + files.length + ' final thumbnail' + (files.length === 1 ? '' : 's') + ' (~$' + (files.length * PRICE_PER_IMAGE).toFixed(2) + ').', files }));
      } catch (e) { send(res, 200, JSON.stringify({ reply: 'Thumbnail generation failed: ' + String(e && e.message || e), isError: true })); }
      finally { generatingThumbs.delete(ik); }
    });
    return;
  }
  if (pathname === '/api/packaging-asset' && req.method === 'GET') {
    if (!safeSeg(query.channel) || !safeSeg(query.id) || !safeSeg(query.name)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(ROOT, query.channel, query.id, '00-packaging', 'thumbnails', query.name);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return;
  }

  // --- QC linter: deterministic Definition-of-Done checks over the storyboard ---
  if (pathname === '/api/qc' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try {
      const folder = path.dirname(sp);
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
      const checks = [];
      const add = (id, level, detail) => checks.push({ id, level, detail });
      if (!scenes.length) { add('scenes', 'fail', 'No storyboard yet.'); return send(res, 200, JSON.stringify({ checks })); }
      const secOf = (s) => s.audioSeconds || s.seconds || 0;
      const words = scenes.reduce((a, s) => a + (s.narration || '').trim().split(/\s+/).filter(Boolean).length, 0);
      const totalSec = scenes.reduce((a, s) => a + secOf(s), 0);
      // the SHIPPED video = narration + the branded end card (12s default; doc.endCard:false opts out) — this is the length YouTube measures for mid-roll eligibility
      const endCardSec = (doc.endCard === false) ? 0 : ((doc.endCard && doc.endCard.seconds) || 12);
      const videoSec = totalSec + endCardSec;
      // word count vs the 8-12 min target band
      add('word-count', words >= 950 && words <= 1700 ? 'pass' : 'warn', words + ' narration words (~' + Math.round(totalSec / 60) + ' min). Target 950–1,650 for 8–12 min.');
      // mid-roll cliff: 8:00 unlocks mid-roll ads; keep a 10s buffer so a fast voice never silently forfeits them
      const mmss = Math.floor(videoSec / 60) + ':' + String(Math.floor(videoSec % 60)).padStart(2, '0');
      add('mid-roll-length', videoSec >= 490 ? 'pass' : (videoSec >= 450 ? 'warn' : 'fail'),
        'Video runtime ' + mmss + ' (narration + ' + endCardSec + 's end card). Mid-roll ads need ≥8:00 — keep ≥8:10 of buffer' + (videoSec < 490 ? ' (add a beat or re-voice at a slower pace).' : '.'));
      // hook: no greeting in the first 15 seconds, first beat punchy
      let cum = 0; const hookText = scenes.filter((s) => { const ok = cum < 15; cum += secOf(s); return ok; }).map((s) => s.narration || '').join(' ');
      const greet = /\b(hi|hello|hey|welcome( back)?|today (we|i)|in this video|what'?s up|guys)\b/i.exec(hookText);
      add('hook-greeting', greet ? 'fail' : 'pass', greet ? ('Greeting/filler in the first 15s: "' + greet[0] + '" — the first spoken word must be tension.') : 'No greeting in the first 15s.');
      add('hook-length', secOf(scenes[0]) <= 15 ? 'pass' : 'warn', 'First beat is ' + Math.round(secOf(scenes[0])) + 's.');
      // mid-video re-hook
      let rehookAt = -1; cum = 0;
      for (const s of scenes) { if (s.musicCue === 'rehook') { rehookAt = cum; break; } cum += secOf(s); }
      const rePos = rehookAt >= 0 ? rehookAt / Math.max(1, totalSec) : -1;
      add('re-hook', rehookAt < 0 ? 'warn' : (rePos > 0.25 && rePos < 0.65 ? 'pass' : 'warn'),
        rehookAt < 0 ? 'No music_cue="rehook" beat found — plant an explicit mid-video re-hook.' : 'Re-hook at ' + Math.round(rehookAt / 60) + ':' + String(Math.round(rehookAt % 60)).padStart(2, '0') + ' (' + Math.round(rePos * 100) + '% of runtime).');
      // captions: short and punchy; map beats must not duplicate the map's own labels
      const longCaps = scenes.filter((s) => (s.onScreenText || '').trim().split(/\s+/).filter(Boolean).length > 6).map((s) => s.n);
      add('caption-length', longCaps.length ? 'warn' : 'pass', longCaps.length ? 'Captions over 6 words on beats: ' + longCaps.join(', ') : 'All captions ≤ 6 words.');
      const dupCaps = scenes.filter((s) => s.kind === 'map' && s.map && (s.map.labels || []).some((l) => (s.onScreenText || '').toUpperCase().includes((l.text || '').toUpperCase()) && l.text)).map((s) => s.n);
      add('map-captions', dupCaps.length ? 'warn' : 'pass', dupCaps.length ? 'Map beats whose overlay caption duplicates a map label: ' + dupCaps.join(', ') : 'No map-label duplication.');
      // narration cadence: a hard period that drops into a ≤2-word orphan fragment makes the TTS lose rhythm
      // (caught on 001 scene 45 "…hopping puddles. Kids playing."). Fix with an em-dash/ellipsis, or a voiceText <break>.
      const cadence = scenes.filter((s) => {
        const t = (s.voiceText || s.narration || '').replace(/<break[^>]*>/gi, ' ').trim(); if (!t) return false;
        const parts = t.split(/[.!?]+(?:\s+|$)/).filter((p) => p.trim());
        if (parts.length < 2) return false;
        const wc = (p) => p.trim().split(/\s+/).filter(Boolean).length;
        // the rhythm-breaker is a LONG flowing sentence (≥8 words) dropping into an abrupt ≤2-word fragment
        // (001 scene 45). Intentional staccato punches ("Before writing." / "Why.") have a SHORT prior clause — not flagged.
        return wc(parts[parts.length - 1]) <= 2 && wc(parts[parts.length - 2]) >= 8;
      }).map((s) => s.n);
      add('narration-cadence', cadence.length ? 'warn' : 'pass', cadence.length
        ? 'A long sentence drops into a ≤2-word fragment (the voice may lose rhythm, as on the old scene 45) on beats: ' + cadence.join(', ') + '. Review by ear — if not an intentional punch, use an em-dash/ellipsis or a voiceText <break>.'
        : 'No risky orphan fragments.');
      // pattern interrupts: no stretch over ~35s without a visual/audio change
      const gaps = []; let run = 0, runStart = 1;
      for (const s of scenes) {
        const interrupt = (s.onScreenText || '').trim() || (s.sfx || []).length || s.musicCue || (s.frames || []).length || s.kind !== 'illustration';
        if (interrupt) { run = 0; runStart = s.n; } else { run += secOf(s); if (run > 35) { gaps.push(runStart + '–' + s.n); run = 0; } }
      }
      add('pattern-interrupts', gaps.length ? 'warn' : 'pass', gaps.length ? 'Stretches >35s with no caption/SFX/cue/frame change around beats: ' + gaps.join('; ') : 'Interrupt cadence OK (≤35s).');
      // pacing extremes
      const slow = scenes.filter((s) => secOf(s) > 13).map((s) => s.n), fast = scenes.filter((s) => secOf(s) < 1.6).map((s) => s.n);
      add('pacing', (slow.length > 3 || fast.length > 6) ? 'warn' : 'pass', 'Avg hold ' + (totalSec / scenes.length).toFixed(1) + 's. ' + (slow.length ? 'Long holds (>13s): ' + slow.join(', ') + '. ' : '') + (fast.length ? 'Very quick (<1.6s): ' + fast.join(', ') + '.' : ''));
      // assets complete
      const noImg = scenes.filter((s) => !(s.imagePath && fs.existsSync(path.join(folder, s.imagePath)))).map((s) => s.n);
      const noAud = scenes.filter((s) => (s.narration || '').trim() && !(s.audioPath && fs.existsSync(path.join(folder, s.audioPath)))).map((s) => s.n);
      add('images', noImg.length ? 'fail' : 'pass', noImg.length ? 'Beats missing images: ' + noImg.join(', ') : 'All beats have images.');
      add('narration-audio', noAud.length ? 'fail' : 'pass', noAud.length ? 'Beats missing narration audio: ' + noAud.join(', ') : 'All narrated beats voiced.');
      // CTA placement: primary CTA should be mid-video, not only at the end
      let ctaPos = -1; cum = 0;
      for (const s of scenes) { if (/\bsubscribe\b/i.test(s.narration || '')) { ctaPos = cum; break; } cum += secOf(s); }
      const ctaPct = ctaPos >= 0 ? ctaPos / Math.max(1, totalSec) : -1;
      add('cta', ctaPos < 0 ? 'warn' : (ctaPct > 0.3 && ctaPct < 0.8 ? 'pass' : 'warn'), ctaPos < 0 ? 'No subscribe CTA found in narration — primary CTA belongs right after the biggest insight.' : 'CTA at ' + Math.round(ctaPct * 100) + '% of runtime.');
      // monetization: narration coverage well above the ~30% commentary heuristic
      const narratedSec = scenes.filter((s) => (s.narration || '').trim()).reduce((a, s) => a + secOf(s), 0);
      add('commentary-share', narratedSec / Math.max(1, totalSec) > 0.7 ? 'pass' : 'fail', Math.round(narratedSec / Math.max(1, totalSec) * 100) + '% of runtime is narrated commentary.');
      // music bed present (Content-ID-safe, from the music folder convention)
      const musicDirs = [path.join(folder, '04-assets', 'music'), path.join(ROOT, query.channel, '_assets', 'music')];
      const hasMusic = musicDirs.some((d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => /\.(mp3|wav|m4a|aac)$/i.test(f)));
      add('music-bed', hasMusic ? 'pass' : 'warn', hasMusic ? 'Music bed found — the assembler will mix it under narration.' : 'No music bed. Drop a YouTube Audio Library track at History/_assets/music/bed.mp3 (one per channel works).');
      // sources on disk for the description
      const srcFile = path.join(folder, '01-research', 'sources.md');
      add('sources', fs.existsSync(srcFile) ? 'pass' : 'fail', fs.existsSync(srcFile) ? '01-research/sources.md exists.' : '01-research/sources.md missing — fact-check gate (and the description source list) needs it.');
      return send(res, 200, JSON.stringify({ checks, stats: { words, minutes: +(totalSec / 60).toFixed(1), beats: scenes.length } }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }

  // --- Publish kit: deterministic chapters + description + tags + pinned comment, written to 07-publish ---
  if (pathname === '/api/publish-kit' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try {
      const folder = path.dirname(sp);
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
      if (!scenes.length) return send(res, 400, JSON.stringify({ error: 'no storyboard yet' }));
      const pk = (doc.stages || {}).packaging || {}; const dec = pk.decision || {}; const cand = pk.candidates || {};
      const titleObj = (cand.titles || []).find((t) => t.id === dec.primaryTitle);
      const title = (titleObj && titleObj.text) || doc.workingTitle || query.id;
      const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
      // chapters: first beat of each storyboard segment
      const chapters = []; let cum = 0, lastSeg = null;
      for (const s of scenes) {
        const seg = (s.segment || '').trim();
        if (seg && seg !== lastSeg) { chapters.push(fmt(chapters.length === 0 ? 0 : cum) + ' ' + seg); lastSeg = seg; }
        cum += s.audioSeconds || s.seconds || 0;
      }
      // sources: pull linked/cited lines out of 01-research/sources.md
      let sources = [];
      try {
        const md = fs.readFileSync(path.join(folder, '01-research', 'sources.md'), 'utf8');
        sources = md.split('\n').filter((l) => /^\s*[-*]\s/.test(l) && /(http|doi|journal|university|museum|\(\d{4}\))/i.test(l)).map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).slice(0, 12);
      } catch (_) {}
      // Keyword-first opener built from the LOCKED TITLE (the keyword sits in its first words),
      // not a raw narration fragment — and never double-punctuated (a "?" title kept its "?").
      const titleClean = title.replace(/\s*[.?!]+\s*$/, '');
      const isQ = /\?\s*$/.test(title.trim()) || /^(how|why|what|when|where|who|did|do|does|are|is|was|were|can|could|should)\b/i.test(titleClean);
      const opener = titleClean + (isQ ? '?' : '.') + ' The real, evidence-based story of how it actually happened — no Atlantis, no aliens, no nonsense.';
      const credit = musicCredit(query.channel);   // CC-BY bed → required attribution; auto-omitted otherwise
      const description = [
        opener, '',
        'CHAPTERS', ...(chapters.length >= 3 ? chapters : ['0:00 ' + title]), '',
        'SOURCES', ...(sources.length ? sources : ['(paste the source list from 01-research/sources.md)']), '',
        ...(credit ? ['MUSIC', credit, ''] : []),
        'Animated explainers on deep human prehistory, every week. Stylized, hand-drawn — and fact-checked.',
        '#prehistory #humanorigins #ancienthistory',
      ].join('\n');
      const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'how', 'why', 'what', 'did', 'was', 'were', 'are', 'is', 'it', 'its', 'their', 'them', 'this', 'that', 'every', 'humans', 'human']);
      const titleWords = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));
      const tags = [...new Set([...titleWords.slice(0, 4).map((w) => w), 'prehistory', 'human origins', 'ancient history', 'archaeology', 'stone age', 'history documentary'])].slice(0, 10);
      const pinned = 'Which part surprised you the most? Tell me below — and drop any "ancient mystery" you want Zed to fact-check in a future video. Full source list is in the description.';
      const nextV = producedVideos(query.channel, query.id)[0];   // real, already-produced video — never an unmade one
      const watchNextLine = nextV
        ? '- [ ] End screen (last ~14s): drop the SUBSCRIBE element over the logo circle, and a VIDEO element over the "watch next" frame on the right — feature "' + nextV.title + '" (already published).'
        : '- [ ] End screen (last ~14s): drop the SUBSCRIBE element over the logo circle. (No other published video yet — add a watch-next video element here once a second video is live.)';
      const kit = [
        '# Publish kit — ' + title, '',
        '## Title', title, '',
        '## Description', '```', description, '```', '',
        '## Tags', tags.join(', '), '',
        '## Pinned comment', pinned, '',
        '## Checklist', '- [ ] Thumbnail uploaded (00-packaging/thumbnails/)', watchNextLine,
        '- [ ] Add to a topic playlist', '- [ ] A/B Test & Compare queued (titles: see studio.json abTitles)', '- [ ] Reply to early comments in the first 2–3 hours', '',
        '*Generated ' + new Date().toISOString() + ' from the storyboard (chapters use real narration timings).*',
      ].join('\n');
      const outDir = path.join(folder, '07-publish'); fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'publish-kit.md'), kit);
      fs.writeFileSync(path.join(outDir, 'description.txt'), description);
      return send(res, 200, JSON.stringify({ ok: true, files: ['07-publish/publish-kit.md', '07-publish/description.txt'], chapters: chapters.length, sources: sources.length, description, tags, pinned }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }

  // --- Cost tracker: per-video + total spend estimates ---
  if (pathname === '/api/costs' && req.method === 'GET') {
    const u = readUsage();
    const summarize = (v) => ({ images: v.images || 0, ttsChars: v.ttsChars || 0, imagesUsd: +((v.images || 0) * PRICE_PER_IMAGE).toFixed(2), ttsCreditPctOfCreator: +(((v.ttsChars || 0) / 100000) * 100).toFixed(1) });
    const all = {}; let ti = 0, tc = 0;
    for (const [k, v] of Object.entries(u)) { if (k === 'updatedAt') continue; all[k] = summarize(v); ti += v.images || 0; tc += v.ttsChars || 0; }
    const key = query.channel && query.id ? query.channel + '/' + query.id : null;
    return send(res, 200, JSON.stringify({ video: key && all[key] ? all[key] : null, total: summarize({ images: ti, ttsChars: tc }), perVideo: all }));
  }

  // --- Voice Lab page ---
  if ((pathname === '/voice-lab' || pathname === '/voicelab') && req.method === 'GET') {
    const html = path.join(__dirname, 'voice-lab.html');
    if (fs.existsSync(html)) return send(res, 200, fs.readFileSync(html), 'text/html; charset=utf-8');
    return send(res, 404, 'voice-lab.html missing', 'text/plain');
  }

  // --- Static: the SPA ---
  if (pathname === '/' || pathname === '/index.html') {
    const html = path.join(__dirname, 'studio.html');
    if (fs.existsSync(html)) return send(res, 200, fs.readFileSync(html), 'text/html; charset=utf-8');
    return send(res, 404, 'studio.html missing', 'text/plain');
  }

  send(res, 404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🎬 YouTube Studio running →  http://localhost:${PORT}\n  Workspace: ${ROOT}\n  (Ctrl+C to stop)\n`);
});
