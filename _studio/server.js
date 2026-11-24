#!/usr/bin/env node
/*
 * YouTube Studio — tiny zero-dependency local server.
 * Serves the YouTube Studio SPA and auto-saves the human's decisions into each video's studio.json.
 *
 * It only ever writes the `stages.<stage>.decision` objects (the human's calls) — it never
 * touches the `candidates` Claude generates. Run:  node _studio/server.js   (or: npm start)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const ER = require('./lib/early-retention.js');
const FUNNEL = require('./lib/funnel.js');
const CAPTIONS = require('./lib/captions.js');
const PACKAGING = require('./lib/packaging.js');
const THUMB = require('./lib/thumbnail.js');
const SHORTSDIST = require('./lib/shortsdist.js');
const SUBS = require('./lib/subtitles.js');
const QCT = require('./lib/qctrends.js');
const PEXELS = require('./lib/pexels.js');
const INFO = require('./lib/infographic.js');
const TRANSLATE = require('./lib/translate.js');
const VEO = require('./lib/veo.js');
const WARMAP = require('./lib/warmap.js');
const STATEDRIFT = require('./lib/state-drift.js');

const ROOT = path.resolve(__dirname, '..');           // workspace root (Z:\Youtube)
const PORT = process.env.PORT || 4317;
const SYSTEM_DIRS = new Set(['_studio', '_templates', 'node_modules', '.git']);
// The Claude Code CLI used for headless generation. Override with CLAUDE_BIN if it isn't on PATH.
// Default: resolve `claude` from PATH (macOS/Linux + most Windows installs); fall back to a known
// Windows install path if PATH resolution isn't set up. (Cross-platform so the Studio is portable.)
// ⚠️ Windows nuance: `spawn()` CANNOT execute a `.cmd`/`.bat` npm shim directly (EINVAL since the
// Node 18.20 CVE fix), so when the CLI is only installed via npm we resolve the shim to its
// underlying cli.js and run it with our own node — no shell, so prompt args need no quoting.
const WIN_CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');   // common install spot; no hardcoded username
function npmShimCli(shimPath) {
  // an npm .cmd shim lives next to the package: <dir>\node_modules\@anthropic-ai\claude-code\cli.js
  const cli = path.join(path.dirname(shimPath), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  return fs.existsSync(cli) ? cli : null;
}
function resolveClaude() {
  const explicit = process.env.CLAUDE_BIN;
  if (explicit) {
    const cli = /\.(cmd|bat)$/i.test(explicit) && npmShimCli(explicit);
    return cli ? { bin: process.execPath, prefix: [cli] } : { bin: explicit, prefix: [] };
  }
  if (process.platform !== 'win32') return { bin: 'claude', prefix: [] };
  if (fs.existsSync(WIN_CLAUDE)) return { bin: WIN_CLAUDE, prefix: [] };
  try {
    const hits = require('child_process').execSync('where claude', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) return { bin: exe, prefix: [] };
    const shim = hits.find((h) => /\.(cmd|bat)$/i.test(h));
    const cli = shim && npmShimCli(shim);
    if (cli) return { bin: process.execPath, prefix: [cli] };
  } catch (_) {}
  return { bin: 'claude.cmd', prefix: [] };   // last resort — spawn failure surfaces as a chat error
}
const CLAUDE_CLI = resolveClaude();
const CLAUDE = CLAUDE_CLI.bin;
const startedSessions = new Set();   // which video chats have a live Claude session
const generatingScripts = new Set(); // which videos currently have a script job running
const generatingResearch = new Set(); // videos with a dedicated deep-research pass running
const generatingScenes = new Set();  // which videos currently have a scene job running
const scenesProgress = new Map();    // key ch|id -> { phase, beats, coverage, pass, passes, ts } live scene-gen progress
const generatingIdeas = new Set();   // videos currently brainstorming idea candidates
const generatingPackaging = new Set(); // videos currently generating packaging titles
const generatingShorts = new Set();    // videos with a Shorts-Lab analysis running
const renderingShorts = new Set();     // short clips rendering (key: ch|id|clipId)

function sessionId(key) {
  const h = crypto.createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function chatSystemPrompt(studioFile) {
  // Ground the prompt in the SELECTED channel — derived from the ROOT/<channel>/<id>/studio.json path —
  // so the assistant uses THAT channel's real cast + style bible, not a hardcoded one. Falls back safely.
  let channel = '', id = '';
  try { const rel = path.relative(ROOT, studioFile).split(path.sep); if (rel.length >= 2) { channel = rel[0]; id = rel[1]; } } catch (_) {}
  let roster = CAST;
  try { roster = (channel && id) ? videoRoster(channel, id) : (channel ? readCast(channel) : CAST); } catch (_) {}
  const names = (roster && roster.length ? roster : CAST).map((c) => c.name);
  const whoEnum = names.concat('none').join('|');
  const styleBible = channel ? `${channel}/_assets/style-bible.md` : "the channel's _assets/style-bible.md";
  const castSheet = channel ? `${channel}/_assets/character-sheet/cast-sheet.png` : "the channel's _assets/character-sheet/cast-sheet.png";
  return [
    'You are the in-Studio assistant embedded in "YouTube Studio", a local web app for producing YouTube videos, chatting with the channel operator while they work on one video.',
    `The Studio UI is driven by this file: ${studioFile}`,
    'It holds stages.packaging.candidates.titles[] and .thumbnails[] — each thumbnail has a structured `layout` object (the Studio renders it into a wireframe + drives the final-art prompt).',
    `This video is on the "${channel || '?'}" channel. Its cast is ${names.join(', ')}; the art style, voice, and packaging rules live in ${styleBible}, ${castSheet}, and CLAUDE.md — READ them first so every title/thumbnail fits THIS channel (never assume another channel's cast or look).`,
    'When the operator asks to add / change / regenerate a title or thumbnail, EDIT that studio.json directly with the Write/Edit tools:',
    '- Keep the file VALID JSON and preserve the stages.packaging.decision object exactly.',
    `- A thumbnail = { id (unique "th-..."), name (short), rationale (short), layout: { bg (one of sky|dawn|sunset|ember|night|ocean|snow|forest|sand|stone|cave|blizzard), accent (hex; ONE accent), subject:{ who (${whoEnum}), pose (short), zone (left|center|right), scale (hero|medium) }, props (<=3 short labels), text:[{line (UPPERCASE 1-3 words), role (accent|dark|white)}], textZone (left|right|center|top|bottom) } } — use the structured \`layout\`, NOT raw svg; max 2-3 elements, ONE accent, key subject in the left ~60%, legible at 120x68 (style-bible §9).`,
    '- The UI auto-refreshes when you finish, so the operator will see your changes.',
    'Reply in 1-4 short, conversational sentences describing what you changed or answering the question. Never paste raw SVG or JSON into the chat. Be a sharp, opinionated creative partner.',
  ].join('\n');
}

function runClaude(args, timeoutMs, envOverride) {
  return new Promise((resolve) => {
    const env = envOverride ? Object.assign({}, process.env, envOverride) : process.env;
    let child;
    try {
      child = spawn(CLAUDE_CLI.bin, CLAUDE_CLI.prefix.concat(args), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (e) {   // spawn can THROW synchronously (e.g. EINVAL on a .cmd) — resolve, never reject
      return resolve({ code: -1, out: '', err: 'Could not launch the Claude CLI (' + String(e && e.message || e) + '). Set CLAUDE_BIN to the full path of your claude executable.' });
    }
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
const animatingBeats = new Set();       // beats being animated by Veo (key: ch|id|n)
const generatingNarration = new Set(); // videos with a full narration run in progress
const revoicingScenes = new Set();     // single beats being re-voiced (key: ch|id|n)
const renderingFrames = new Set();     // single reveal/reaction frames being rendered (key: ch|id|n|f|idx)
const assembling = new Set();           // videos with a rough-cut render in progress
const renderingMaps = new Set();        // videos with an accurate-map still render in progress
const generatingThumbs = new Set();     // videos with final thumbnail art generating
const overlayingThumbs = new Set();     // videos re-running JUST the headline overlay (no Gemini)
const generatingEndcard = new Set();    // videos rendering an end-card preview still
const coveringShorts = new Set();       // shorts clips rendering a vertical cover still (key: ch|id|clipId)
const RENDER_DIR = path.join(__dirname, 'render');
// Remotion bundles into the OS temp dir; point render children at Z: so a tight C: never breaks renders.
const RENDER_TMP = path.join(RENDER_DIR, '.tmp');
const renderEnv = () => { try { fs.mkdirSync(RENDER_TMP, { recursive: true }); } catch (_) {} return Object.assign({}, process.env, { TEMP: RENDER_TMP, TMP: RENDER_TMP }); };
const GEMINI_MODEL = 'gemini-2.5-flash-image';        // standard / default scene model
const GEMINI_MODEL_PRO = 'gemini-3-pro-image';        // "Nano Banana Pro" — HQ: thumbnails + scenes flagged hq
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
function getPexelsKey() { return process.env.PEXELS_API_KEY || readSecrets().pexelsKey || ''; }
// Veo (image→video) is OFF by default — it's slow, pricey, access-gated, and an identity/monetization
// decision. The operator opts in explicitly (Scenes tab toggle → .secrets.json.veoEnabled).
function getVeoEnabled() { return readSecrets().veoEnabled === true || process.env.VEO_ENABLED === '1'; }

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
// Usage ledger: _studio/usage.json keeps per-video running TOTALS (back-compat); usage-events.jsonl is an
// append-only event log so spend can be itemized (initial vs re-render vs re-voice). See lib/costs.js.
const COSTS = require('./lib/costs.js');
const USAGE_FILE = path.join(__dirname, 'usage.json');
const EVENTS_FILE = path.join(__dirname, 'usage-events.jsonl');
const PRICE_PER_IMAGE = COSTS.RATES.imageFlash;        // Gemini 2.5 Flash Image, USD
const PRICE_PER_IMAGE_PRO = COSTS.RATES.imagePro;      // Gemini 3 Pro Image (1K–2K), USD
function usageKeyFromSp(sp) { return path.relative(ROOT, path.dirname(sp)).split(path.sep).join('/'); }
// patch = { images | imagesPro | ttsChars, ctx?: 'initial'|'rerender'|'revoice'|'thumbnail' }. Accumulates
// the running total AND appends one itemized event (so a re-render is visible, not silently summed in).
function logUsage(key, patch) {
  const ev = COSTS.eventFromPatch(patch, key, new Date().toISOString());
  if (ev) { try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n'); } catch (_) {} }
  return withFileLock(USAGE_FILE, () => {
    let u = {}; try { u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) {}
    const v = u[key] = u[key] || { images: 0, ttsChars: 0 };
    v.images += patch.images || 0;
    v.imagesPro = (v.imagesPro || 0) + (patch.imagesPro || 0);   // HQ (Gemini 3 Pro) images, billed higher
    v.ttsChars += patch.ttsChars || 0;
    v.updatedAt = new Date().toISOString();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
  });
}
function readUsage() { try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) { return {}; } }
function readEvents() { try { return COSTS.parseLedger(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch (_) { return []; } }
// Returns a PNG Buffer or throws with a readable message. Passes reference images for consistency.
// Sniff the real image format from magic bytes — Gemini 3 Pro returns JPEG that we store as .png, so
// trusting the extension would mislabel a previous-frame ref fed back into the consistency chain.
function sniffMime(buf, p) {
  if (buf && buf.length > 11) {
    const h = buf.slice(0, 4).toString('hex');
    if (h === '89504e47') return 'image/png';
    if (h.startsWith('ffd8ff')) return 'image/jpeg';
    if (h === '52494646' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  }
  return /\.jpe?g$/i.test(p || '') ? 'image/jpeg' : 'image/png';
}
// Cross-platform ffmpeg lookup. NOT the Remotion-vendored compositor binary — that build disables
// most demuxers (audio-mux tasks only) and can't read an mjpeg stream, confirmed by hand. Prefer the
// full build already sitting in _tools/ (Windows dev machine), else a system install on PATH
// (Mac: `brew install ffmpeg`, per SETUP.md). Returns null if neither is found (caller degrades
// gracefully — see ensureRealPng).
let _ffmpegBin;
function resolveFfmpeg() {
  if (_ffmpegBin !== undefined) return _ffmpegBin;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  try {
    const base = path.join(__dirname, '_tools');
    for (const d of fs.readdirSync(base)) {
      if (!/^ffmpeg/i.test(d)) continue;
      const p = path.join(base, d, 'bin', exe);
      if (fs.existsSync(p)) return (_ffmpegBin = p);
    }
  } catch (_) {}
  const probe = spawnSync(exe, ['-version']);
  return (_ffmpegBin = probe.error ? null : exe);
}
// Gemini 3 Pro returns JPEG bytes even though we save every scene as .png (see sniffMime above) —
// harmless for re-upload (already mime-sniffed) but it makes the PNG-only border-guard (pngHasBorder)
// silently skip these frames. Re-encode to a real PNG right after generation so every downstream
// PNG-assuming step (border-guard, thumbnail size-capping) sees true PNG bytes. Returns the original
// buffer unchanged if it's already PNG or ffmpeg isn't available.
function ensureRealPng(buf) {
  if (sniffMime(buf) !== 'image/jpeg') return buf;
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return buf;
  const r = spawnSync(ffmpeg, ['-y', '-f', 'mjpeg', '-i', 'pipe:0', '-update', '1', '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', 'pipe:1'], { input: buf, maxBuffer: 64 * 1024 * 1024 });
  return (!r.error && r.stdout && r.stdout.length && sniffMime(r.stdout) === 'image/png') ? r.stdout : buf;
}
async function geminiImage(key, promptText, imagePaths, model) {
  const parts = [{ text: promptText }];
  for (const p of imagePaths || []) {
    if (p && fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      parts.push({ inline_data: { mime_type: sniffMime(buf, p), data: buf.toString('base64') } });
    }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL}:generateContent`;
  const call = async (genCfg) => {
    // Hard timeout: a Gemini connection that hangs with no response never throws on its own, so
    // withRetry can't retry and the whole batch loop wedges forever (lock held → nothing else renders).
    // AbortController makes a stuck request fail fast so it retries / is recorded as a failed beat.
    const ctrl = new AbortController();
    // Gemini 3 Pro ("Nano Banana Pro") is far slower under load — a real thumbnail render measured ~250s.
    // Give Pro a generous ceiling so legitimate (slow) renders aren't aborted; keep Flash tight.
    const TIMEOUT_MS = (model === GEMINI_MODEL_PRO) ? 360000 : 180000;
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: genCfg }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? ('Gemini request timed out after ' + (TIMEOUT_MS / 1000) + 's') : ('Gemini request failed: ' + (e && e.message || e)));
    } finally { clearTimeout(to); }
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
  illustration: ' Keep the characters EXACTLY consistent with the reference images — same face, hair, skin tone, clothing and proportions. Include ONLY the character(s) this prompt explicitly describes; do NOT add any other cast members, background extras, or mascots from the reference sheet (for example, do NOT add a pet rock / loose rocks) unless this prompt names them. Flat colored hand-drawn stick-figure style, bold outlines, no photorealism. Do NOT draw any text, letters, captions, labels, numbers, equations, speech bubbles, boxes, banners, frames or UI of any kind anywhere in the image. CRITICAL: IGNORE any text, letters, words or labels that appear in the attached reference images — never copy or reproduce them; the scene must contain ZERO text. Compose ONE single cohesive scene whose artwork BLEEDS off all four edges and fills the ENTIRE frame edge to edge — never a split/diptych/before-after/multi-panel layout. ABSOLUTELY NO border, frame, outline, matte, mount, passe-partout, white/black/colored margin, letterbox or pillarbox bars, gutter, rounded corners, drop shadow, or padding of ANY color around the image — the scene must touch and run past every edge with zero surrounding band. Keep the upper third of the frame calm and uncluttered — open sky or plain background. Wide 16:9 landscape.',
  // For a beat with NO named cast: render ONLY the objects/scene. The cast sheet is NOT attached for
  // these (see imageRefsFor), and this suffix actively FORBIDS giving objects faces/limbs — otherwise
  // Gemini "keeps the characters consistent" by grafting cast faces onto a car/gun/outlet/burger.
  illustrationNoCast: ' This image has NO people and NO characters. Render ONLY the object(s) or scene the prompt describes, as plain objects/scenery — do NOT add faces, eyes, mouths, arms, legs, hands, or any cartoon character, mascot or cast figure to the objects or anywhere in the frame. The objects must stay ordinary inanimate objects. Match ONLY the flat colored hand-drawn cartoon STYLE — bold black outlines, flat fills, light shading, no photorealism; never reproduce a character from any reference. Do NOT draw any text, letters, captions, labels, numbers, equations, speech bubbles, boxes, banners, frames or UI of any kind anywhere in the image. Compose ONE single cohesive scene whose artwork BLEEDS off all four edges and fills the ENTIRE frame edge to edge — never a split/diptych/before-after/multi-panel layout. ABSOLUTELY NO border, frame, outline, matte, mount, passe-partout, white/black/colored margin, letterbox or pillarbox bars, gutter, rounded corners, drop shadow, or padding of ANY color around the image — the scene must touch and run past every edge with zero surrounding band. Keep the upper third of the frame calm and uncluttered. Wide 16:9 landscape.',
  infographic: ' Render this as a clean hand-drawn diagram in the same flat colored doodle style as the references (bold black outlines, flat fills, no photorealism, no gradients), built from ICONS and shapes. AVOID text wherever possible — image models GARBLE words, so prefer wordless visual elements; never invent labels, numbers, dates, axes or measurements (any precise number/date belongs in the on-screen overlay, not baked into the image). IGNORE and do not copy any text in the reference images. If a cast character appears, match the references. Wide 16:9 landscape with generous margins.',
};

// Reference images for a scene. CHARACTER beats: cast sheet + each named character + the previous
// frame (continuity). CHARACTER-FREE beats (objects/scene only): attach NO references at all — the
// face-filled cast sheet (and a prior cast frame) is exactly what makes Gemini graft cast faces onto
// the objects (a gun/outlet/burger wearing a cast face); the no-cast style suffix carries the look.
function imageRefsFor(scenes, idx, refDir, sheet, imgDir, skipPrev) {
  const s = scenes[idx];
  const hasCast = Array.isArray(s.characters) && s.characters.length > 0;
  if (!hasCast) {
    // Character-free beat (objects / scenery / cave-art / icons): do NOT attach the cast SHEET or
    // per-character portraits — that face-grid is what grafted cast faces onto objects. BUT anchor to
    // the PREVIOUS frame for STYLE continuity, so cave-art/icon/scenery beats still render in the
    // channel's flat-cartoon look instead of a disconnected one-off. The no-cast STYLE_SUFFIX
    // (illustrationNoCast) forbids faces, so the previous frame is a style reference only.
    const refs = [];
    if (s.kind !== 'infographic' && s.kind !== 'map' && idx > 0 && !skipPrev) {
      const pn = String(scenes[idx - 1].n || idx).padStart(3, '0'); const pf = path.join(imgDir, pn + '.png');
      if (fs.existsSync(pf)) refs.push(pf);
    }
    return refs;
  }
  const refs = []; if (fs.existsSync(sheet)) refs.push(sheet);
  for (const c of s.characters) { const cp = path.join(refDir, c + '.png'); if (fs.existsSync(cp)) refs.push(cp); }
  // The previous frame (continuity ref) is the heaviest input (~6MB). skipPrev drops it so a single
  // regen stays light enough to clear a throttled/slow Gemini — character refs still hold consistency.
  if (s.kind !== 'infographic' && idx > 0 && !skipPrev) { const pn = String(scenes[idx - 1].n || idx).padStart(3, '0'); const pf = path.join(imgDir, pn + '.png'); if (fs.existsSync(pf)) refs.push(pf); }
  return refs;
}

// ---- Border guard: Gemini intermittently wraps an illustration in a uniform white/black/cream FRAME
//      (and it propagates down the previous-frame reference chain). We decode the PNG (built-in zlib,
//      no deps) and detect a uniform rim distinct from the scene; renderScene then auto-regens (light,
//      no prev-frame ref) so a framed image never ships. ----
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) return null;                 // only the common 8-bit non-interlaced case
  const ch = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (!ch) return null;
  let raw; try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (_) { return null; }
  const lineBytes = w * ch; const px = new Uint8Array(h * lineBytes);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < lineBytes; x++) {
      const rb = raw[rp++];
      const a = x >= ch ? px[y * lineBytes + x - ch] : 0, b = y > 0 ? px[(y - 1) * lineBytes + x] : 0, c = (x >= ch && y > 0) ? px[(y - 1) * lineBytes + x - ch] : 0;
      let v; if (ft === 0) v = rb; else if (ft === 1) v = rb + a; else if (ft === 2) v = rb + b; else if (ft === 3) v = rb + ((a + b) >> 1); else if (ft === 4) v = rb + paeth(a, b, c); else v = rb;
      px[y * lineBytes + x] = v & 255;
    }
  }
  return { w, h, ch, px };
}
// True if the image is wrapped in a uniform frame/letterbox/paper-margin. Safe (false) on any undecodable PNG.
function pngHasBorder(file) {
  let img; try { img = decodePng(file); } catch (_) { return false; }
  if (!img) return false;
  const { w, h, ch, px } = img;
  const at = (x, y, k) => px[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * ch + Math.min(k, ch - 1)];
  const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  // --- (A) THIN uniform frame/letterbox: a near-uniform rim distinct from a shallow inset, on >=3 edges ---
  const thin = Math.max(2, Math.round(Math.min(w, h) * 0.006)), inset = Math.max(8, Math.round(Math.min(w, h) * 0.06)), N = 200;
  const stat = (pts) => { const s = [0, 0, 0], s2 = [0, 0, 0]; for (const [x, y] of pts) for (let k = 0; k < 3; k++) { const v = at(x, y, k); s[k] += v; s2[k] += v * v; } const n = pts.length, m = s.map((t) => t / n); return { mean: m, maxStd: Math.max(...s2.map((t, k) => Math.sqrt(Math.max(0, t / n - m[k] * m[k])))) }; };
  const sides = { top: [], bottom: [], left: [], right: [] }, ins = { top: [], bottom: [], left: [], right: [] };
  for (let i = 0; i < N; i++) {
    const fx = Math.round(i / (N - 1) * (w - 1)), fy = Math.round(i / (N - 1) * (h - 1)), t = thin >> 1;
    sides.top.push([fx, t]); ins.top.push([fx, inset]); sides.bottom.push([fx, h - 1 - t]); ins.bottom.push([fx, h - 1 - inset]);
    sides.left.push([t, fy]); ins.left.push([inset, fy]); sides.right.push([w - 1 - t, fy]); ins.right.push([w - 1 - inset, fy]);
  }
  const flagged = [];
  for (const name of ['top', 'bottom', 'left', 'right']) {
    const rim = stat(sides[name]), is = stat(ins[name]);
    // near-black uniform rims are NOT treated as "pure" here — a full-bleed dark scene (e.g. a spotlight
    // composition) reads identically to a black frame at this rim-only check; (C) below owns near-black
    // borders with a depth-consistency check that tells the two apart.
    const pure = rim.maxStd < 6 && rim.mean.every((v) => v >= 249);
    const distinctFrame = rim.maxStd < 14 && dist(rim.mean, is.mean) > 26;
    if (pure || distinctFrame) flagged.push(rim.mean);
  }
  if (flagged.length >= 3) {
    let agree = 0; for (let i = 1; i < flagged.length; i++) if (dist(flagged[0], flagged[i]) < 24) agree++;
    if ((agree + 1) >= flagged.length - 1) return true;   // a real frame is ~the same color on (nearly) every edge
  }
  const mn = Math.min(w, h);
  // --- (C) DARK letterbox: on a near-black scene, (A)'s rim-vs-inset diff never clears its threshold
  //     (the inset content is itself near-black) and (B) below never fires (its rim must be light paper).
  //     Walk inward from each edge along several cross-sections counting the near-black run; a real
  //     border reads as a SHORT, consistent band on all 4 sides. A deliberate full-bleed dark scene either
  //     never terminates within the cap (real content, not a border) or its edge position swings wildly
  //     cross-section to cross-section (it's scene geometry, not a straight band). ---
  const NEAR_BLACK = 8;
  const isNearBlack = (x, y) => at(x, y, 0) < NEAR_BLACK && at(x, y, 1) < NEAR_BLACK && at(x, y, 2) < NEAR_BLACK;
  const darkCap = Math.round(mn * 0.45), darkFr = [0.2, 0.35, 0.5, 0.65, 0.8];
  const walkDark = (getPix) => { let d = 0; for (; d < darkCap; d++) if (!isNearBlack(...getPix(d))) break; return d; };
  const darkMed = (a) => a.slice().sort((m, n) => m - n)[a.length >> 1];
  const darkDepths = {
    left: darkFr.map((f) => walkDark((d) => [d, Math.round(h * f)])),
    right: darkFr.map((f) => walkDark((d) => [w - 1 - d, Math.round(h * f)])),
    top: darkFr.map((f) => walkDark((d) => [Math.round(w * f), d])),
    bottom: darkFr.map((f) => walkDark((d) => [Math.round(w * f), h - 1 - d])),
  };
  const darkSideMed = {}, darkSideSpread = {};
  for (const k of Object.keys(darkDepths)) { darkSideMed[k] = darkMed(darkDepths[k]); darkSideSpread[k] = Math.max(...darkDepths[k]) - Math.min(...darkDepths[k]); }
  const darkMeds = Object.values(darkSideMed);
  const darkAllPresent = darkMeds.every((d) => d >= 2);           // every side found SOME band
  const darkAnyMaxedOut = darkMeds.some((d) => d >= darkCap);     // a side never terminated -> real content, not a border
  const darkAnyNoisy = Object.values(darkSideSpread).some((s) => s > mn * 0.08);   // a side's own cross-sections disagree -> not a straight band
  const darkConsistent = (Math.max(...darkMeds) - Math.min(...darkMeds)) <= mn * 0.15;   // all 4 sides roughly the same depth
  if (darkAllPresent && !darkAnyMaxedOut && !darkAnyNoisy && darkConsistent) return true;
  // --- (B) WIDE paper margin: Gemini sometimes insets a (usually dark) scene on the off-white page, leaving
  //     a margin too THICK for the shallow inset above to see. Detect a light uniform rim that forms a
  //     CENTERED rectangle: scan inward from each edge to where color first departs from the rim; a true
  //     margin has equal-ish pixel widths on all four sides. A centered subject on full-bleed paper fails
  //     this (its margins are wildly unequal), and a full-bleed dark scene fails the light-rim test. ---
  const P = (x, y) => [at(x, y, 0), at(x, y, 1), at(x, y, 2)];
  const med = (a) => a.slice().sort((m, n) => m - n)[a.length >> 1];
  const ring = []; for (let i = 0; i < w; i += 8) ring.push(P(i, 0), P(i, h - 1)); for (let j = 0; j < h; j += 8) ring.push(P(0, j), P(w - 1, j));
  const rimC = [0, 1, 2].map((k) => med(ring.map((c) => c[k])));
  if (!(rimC.every((v) => v >= 198) && (Math.max(...rimC) - Math.min(...rimC)) < 36)) return false;   // rim must be light/cream paper
  const fr = [0.3, 0.4, 0.5, 0.6, 0.7];
  const depth = (scan, maxd) => { for (let d = 0; d < maxd; d++) if (dist(scan(d), rimC) > 30) return d; return maxd; };
  const dL = med(fr.map((f) => depth((d) => P(d, h * f), w * 0.5)));
  const dR = med(fr.map((f) => depth((d) => P(w - 1 - d, h * f), w * 0.5)));
  const dT = med(fr.map((f) => depth((d) => P(w * f, d), h * 0.5)));
  const dB = med(fr.map((f) => depth((d) => P(w * f, h - 1 - d), h * 0.5)));
  const inRange = [dL, dR, dT, dB].every((d) => d >= mn * 0.02 && d < mn * 0.45);
  const rectangular = Math.abs(dL - dR) < w * 0.04 && Math.abs(dT - dB) < h * 0.04 && Math.abs((dL + dR) / 2 - (dT + dB) / 2) < mn * 0.06;
  return inRange && rectangular;
}

// Minimal truecolor PNG encoder (zlib + crc32) — used to shrink oversized thumbnails for YouTube's 2MB cap.
function encodePngRGB(w, h, rgb) {
  const ck = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0); return Buffer.concat([len, t, data, crc]); };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3)); let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w * 3; x++) raw[o++] = rgb[y * w * 3 + x]; }
  return Buffer.concat([sig, ck('IHDR', ihdr), ck('IDAT', zlib.deflateSync(raw, { level: 9 })), ck('IEND', Buffer.alloc(0))]);
}
// Return PNG bytes for a thumbnail guaranteed under `limit` (default YouTube's 2MB): if the file is already
// small enough use it as-is, else area-downscale (keeping aspect) until it fits. Prevents the 413 on upload.
function thumbUnderLimit(file, limit = 2 * 1024 * 1024) {
  const orig = fs.readFileSync(file);
  if (orig.length <= limit) return orig;
  let img; try { img = decodePng(file); } catch (_) { return orig; }
  if (!img) return orig;
  const { w, h, ch, px } = img; const ar = w / h;
  for (const TW of [1280, 1152, 1024, 896, 800, 640]) {
    const TH = Math.round(TW / ar); if (TW >= w) continue;
    const out = new Uint8Array(TW * TH * 3);
    for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
      const sx0 = Math.floor(tx * w / TW), sx1 = Math.max(Math.floor((tx + 1) * w / TW), sx0 + 1);
      const sy0 = Math.floor(ty * h / TH), sy1 = Math.max(Math.floor((ty + 1) * h / TH), sy0 + 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { const s = (sy * w + sx) * ch; r += px[s]; g += px[s + 1]; b += px[s + 2]; n++; }
      const d = (ty * TW + tx) * 3; out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
    const buf = encodePngRGB(TW, TH, out);
    if (buf.length <= limit) return buf;
  }
  return orig;   // give up gracefully — the API will report the size error
}

// Render ONE scene via Gemini, save the PNG, and persist its imagePath into studio.json. Returns the relative path.
async function renderScene(key, sp, scenes, idx, imgDir, refDir, sheet, opts = {}) {
  const s = scenes[idx];
  const nn = String(s.n || (idx + 1)).padStart(3, '0');
  const outAbs = path.join(imgDir, nn + '.png');
  const hasCast = Array.isArray(s.characters) && s.characters.length > 0;
  const suffix = STYLE_SUFFIX[s.kind === 'infographic' ? 'infographic' : (hasCast ? 'illustration' : 'illustrationNoCast')];
  const pro = !!s.hq;   // per-scene HQ flag → render this shot on Gemini 3 Pro
  // Generate; if Gemini wrapped it in a frame, re-render up to twice WITHOUT the previous-frame ref
  // (which is how a border propagates) so a bordered image never ships. Maps/infographics are exempt.
  let buf; const maxTries = (s.kind === 'illustration') ? 3 : 1;
  for (let tryN = 1; tryN <= maxTries; tryN++) {
    const skipPrev = opts.skipPrev || tryN > 1;
    buf = await geminiImage(key, (s.imagePrompt || s.visual || '') + suffix, imageRefsFor(scenes, idx, refDir, sheet, imgDir, skipPrev), pro ? GEMINI_MODEL_PRO : undefined);
    buf = ensureRealPng(buf);   // HQ (Gemini 3 Pro) returns JPEG bytes — re-encode so pngHasBorder below can actually see it
    fs.writeFileSync(outAbs, buf);
    logUsage(usageKeyFromSp(sp), Object.assign(pro ? { imagesPro: 1 } : { images: 1 }, opts.ctx ? { ctx: opts.ctx } : {}));
    if (tryN >= maxTries || !pngHasBorder(outAbs)) break;   // clean (or out of tries) → keep it
  }
  const rel = '04-assets/images/' + nn + '.png';
  await withFileLock(sp, () => {
    const live = JSON.parse(fs.readFileSync(sp, 'utf8'));   // re-read + persist so the UI can poll progress
    const ls = live.stages.scenes && live.stages.scenes.candidates && (live.stages.scenes.candidates.scenes || []).find((x) => String(x.n) === String(s.n));
    if (ls) { ls.imagePath = rel; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
  });
  return rel;
}

// Gemini text generation (text in → text out) — used for subtitle translation. Same host/key as the
// image API; runs over HTTP so it never contends for the serialized headless-Claude slot.
async function geminiText(key, promptText, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent`;
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 120000);
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }), signal: ctrl.signal });
  } catch (e) { throw new Error(ctrl.signal.aborted ? 'Gemini text request timed out' : ('Gemini text request failed: ' + (e && e.message || e))); }
  finally { clearTimeout(to); }
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!r.ok) throw new Error('Gemini API ' + r.status + ': ' + ((j && j.error && j.error.message) || txt.slice(0, 200)));
  const cps = (((j || {}).candidates || [])[0] || {}).content;
  const out = ((cps && cps.parts) || []).map((p) => p.text || '').join('');
  if (!out) throw new Error('No text returned by Gemini');
  return out;
}

// Veo image→video: submit, poll the long-running operation, download the mp4. Returns a Buffer or throws.
// Same Gemini key/host as images; needs the key to have Veo access (throws a readable error otherwise).
async function geminiVeoAnimate(key, imagePath, prompt, opts = {}) {
  const model = opts.model || VEO.DEFAULT_MODEL;
  let imageB64 = null, mime = 'image/png';
  if (imagePath && fs.existsSync(imagePath)) { const buf = fs.readFileSync(imagePath); imageB64 = buf.toString('base64'); mime = sniffMime(buf, imagePath); }
  const sub = await fetch(VEO.submitUrl(model), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(VEO.requestBody(prompt, imageB64, mime, opts)) });
  const subTxt = await sub.text(); let subJ = null; try { subJ = JSON.parse(subTxt); } catch (_) {}
  if (!sub.ok) throw new Error('Veo submit ' + sub.status + ': ' + ((subJ && subJ.error && subJ.error.message) || subTxt.slice(0, 200)));
  const opName = VEO.operationName(subJ);
  if (!opName) throw new Error('Veo: no operation name returned');
  const deadline = Date.now() + (opts.timeoutMs || 300000); let opJ = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    try { const pr = await fetch(VEO.pollUrl(opName), { headers: { 'x-goog-api-key': key } }); opJ = JSON.parse(await pr.text()); } catch (_) { opJ = null; }
    if (opJ && VEO.isDone(opJ)) break;
  }
  if (!opJ || !VEO.isDone(opJ)) throw new Error('Veo timed out waiting for the video');
  const err = VEO.opError(opJ); if (err) throw new Error(err);
  const result = VEO.videoResult(opJ); if (!result) throw new Error('Veo: no video in the result');
  if (result.uri) { const vr = await fetch(result.uri, { headers: { 'x-goog-api-key': key } }); if (!vr.ok) throw new Error('Veo video download ' + vr.status); return Buffer.from(await vr.arrayBuffer()); }
  return Buffer.from(result.bytes, 'base64');
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
  return { buf: Buffer.from(b64, 'base64'), seconds, words: CAPTIONS.wordTimings(al) };
}
// Voice ONE beat, save NNN.mp3, persist audioPath + audioSeconds. Returns { rel, seconds } or null (no narration).
async function renderNarration(cfg, sp, scenes, idx, audioDir, ctx) {
  const s = scenes[idx];
  // voiceText is the TTS-only override (pauses via <break time="1.2s"/>, pronunciation fixes) — keeps the
  // display `narration` clean for captions/chapters/word-count. Falls back to narration when absent.
  const text = (s.voiceText || s.narration || '').trim();
  if (!text) return null;
  const nn = String(s.n || (idx + 1)).padStart(3, '0');
  const { buf, seconds, words } = await elevenTTS(cfg, text);
  fs.writeFileSync(path.join(audioDir, nn + '.mp3'), buf);
  logUsage(usageKeyFromSp(sp), Object.assign({ ttsChars: text.length }, ctx ? { ctx } : {}));
  const rel = '04-assets/audio/' + nn + '.mp3';
  await withFileLock(sp, () => {
    const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const ls = live.stages.scenes && live.stages.scenes.candidates && (live.stages.scenes.candidates.scenes || []).find((x) => String(x.n) === String(s.n));
    if (ls) { ls.audioPath = rel; ls.audioSeconds = seconds; ls.wordTimings = words || []; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
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
  const ci = { scene: ix('scene'), segment: ix('segment'), seconds: ix('seconds'), kind: ix('kind'), characters: ix('characters'), narration: ix('narration'), visual: ix('visual'), onscreen: ix('on_screen_text'), textpos: ix('text_pos'), textanim: ix('text_anim'), motion: ix('motion'), sfx: ix('sfx'), ambient: ix('ambient'), ambientfx: ix('ambient_fx'), realphoto: ix('real_photo'), musiccue: ix('music_cue'), castaction: ix('cast_action'), prompt: ix('image_prompt'), cues: ix('cues') };
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
    let ambientFx = ci.ambientfx >= 0 ? (row[ci.ambientfx] || '').trim().toLowerCase().replace(/^none$/, '') : '';   // VISUAL particle overlay (distinct from `ambient` audio bed)
    if (!/^(embers|spores|pollen|dust|snow|rain)$/.test(ambientFx)) ambientFx = '';
    const realPhotoQ = ci.realphoto >= 0 ? (row[ci.realphoto] || '').trim().replace(/^none$/i, '') : '';   // a SUGGESTED Pexels query; src is filled by /api/fetch-real-photo
    let musicCue = ci.musiccue >= 0 ? (row[ci.musiccue] || '').trim().toLowerCase() : '';
    if (!CUE.includes(musicCue)) musicCue = '';
    const castAction = ci.castaction >= 0 ? (row[ci.castaction] || '').trim() : '';
    return { n: parseInt(row[ci.scene], 10) || (k + 1), segment: (row[ci.segment] || '').trim(), seconds: parseInt(row[ci.seconds], 10) || 6, kind, narration, visual: (row[ci.visual] || '').trim(), characters: chars, onScreenText, textPos, textAnim, motion, sfx, ambient, ambientFx, musicCue, castAction, imagePrompt: prompt, cues: ci.cues >= 0 ? CAPTIONS.parseCues(row[ci.cues]) : [], realPhoto: realPhotoQ ? { query: realPhotoQ.slice(0, 120), label: realPhotoQ.slice(0, 60) } : undefined };
  // Drop ONLY rows whose imagePrompt is empty or a pure `<...>` placeholder stub (a fully-failed
  // generation → all rows drop → "no scenes"); a real row with one stray bracket keeps the row and
  // just strips the bracketed token, so a single sloppy field can't silently lower coverage.
  }).filter((s) => s.imagePrompt && !/^\s*<[^>]*>\s*$/.test(s.imagePrompt))
    .map((s) => ({ ...s, imagePrompt: s.imagePrompt.replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim(), narration: String(s.narration || '').replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim() }));
  return { scenes, totalSeconds: scenes.reduce((a, s) => a + (s.seconds || 0), 0) };
}

// Re-importing the CSV must NOT throw away generated assets (images cost real money, narration
// costs credits, map specs are hand-tuned) — carry them over from the old scenes by scene number.
function mergeScenes(prevScenes, nextScenes) {
  const prev = new Map((prevScenes || []).map((s) => [String(s.n), s]));
  for (const s of nextScenes) {
    const old = prev.get(String(s.n));
    if (!old) continue;
    for (const k of ['imagePath', 'audioPath', 'audioSeconds', 'frames', 'map', 'wordTimings'])
      if (old[k] !== undefined && s[k] === undefined) s[k] = old[k];
    if (old.realPhoto && old.realPhoto.src) s.realPhoto = old.realPhoto;   // a fetched real photo always survives re-import (CSV only carries the query suggestion)
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

// Per-channel publishing copy: <channel>/_assets/brand/brand.json { blurb, hashtags[], tags[], tagline, handle, promise }.
function channelBrand(channel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, String(channel || ''), '_assets', 'brand', 'brand.json'), 'utf8')) || {}; } catch (_) { return {}; }
}
function channelBlurb(channel) { return channelBrand(channel).blurb || 'A new explainer every week.'; }
function channelHashtags(channel) { const h = channelBrand(channel).hashtags; return Array.isArray(h) && h.length ? [h.join(' ')] : []; }
function channelTags(channel) { const t = channelBrand(channel).tags; return Array.isArray(t) ? t : []; }

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

// Resolve a video's thumbnail CONCEPT (+ locked title) from its packaging stage — the chosen
// wireframe mapped into the framework shape lib/thumbnail.js builders expect. Single source of
// truth used by /api/generate-thumbnail AND the Script-page thumbnailPrompt backfill, so the two
// paths can never drift. Returns { concept, title, picked }; when nothing is picked the concept
// is still built from title-derived defaults (legacy generate-thumbnail behavior) with picked=false.
function resolveThumbConcept(doc) {
  const pk = (doc.stages || {}).packaging || {};
  const dec = pk.decision || {}, cand = pk.candidates || {};
  const titleObj = (cand.titles || []).find((t) => t.id === dec.primaryTitle);
  const title = (titleObj && titleObj.text) || doc.workingTitle || '';
  const picked = (cand.thumbnails || []).find((t) => t.id === dec.chosenThumbnail);
  const chosen = picked || {};
  const lay = chosen.layout || {};
  const s = lay.subject || {};
  // Prefer the NEW explicit framework fields (subject.emotion/gaze, support, hook, accent,
  // textSide) when the concept has them; fall back to layout-derived values per-field.
  const fwSub = chosen.subject || {};
  const zone = s.zone || 'left';
  // textSide: explicit framework field wins; else layout.textZone; else opposite the subject.
  const textSide = (chosen.textSide === 'left' || chosen.textSide === 'right')
    ? chosen.textSide
    : ((lay.textZone === 'left' || lay.textZone === 'right')
      ? lay.textZone
      : (zone === 'right' ? 'left' : 'right'));   // default: opposite the subject
  // hook: explicit framework field → layout text lines → the title's first clause.
  let hook = String(chosen.hook || '').trim();
  if (!hook && Array.isArray(lay.text) && lay.text.length) {
    hook = lay.text.map((t) => (typeof t === 'string' ? t : (t && t.line)) || '').join(' ').trim();
  }
  if (!hook) hook = title.split(/[—:–-]/)[0].trim().slice(0, 28);
  const gaze = (fwSub.gaze === 'left' || fwSub.gaze === 'right' || fwSub.gaze === 'at-camera')
    ? fwSub.gaze : textSide;
  const concept = {
    subject: {
      who: fwSub.who || s.who || 'none',
      emotion: (fwSub.emotion && fwSub.emotion.trim()) || s.pose || '',
      gaze,
      zone,
    },
    support: String(chosen.support || (lay.props || [])[0] || '').trim(),
    mood: lay.mood || '',
    accent: chosen.accent || lay.accent || THUMB.BOGY.orange,
    textSide,
    hook,
    // carry the exact stacked headline lines (per-line accent colors) + the wireframe's pose so
    // text-included prompts (buildChatGptThumbPrompt) keep the concept's full creative detail
    layout: {
      text: Array.isArray(lay.text) && lay.text.length ? lay.text : undefined,
      subject: s.pose ? { pose: s.pose } : undefined,
    },
  };
  return { concept, title, picked: !!picked };
}

// Channel-level thumbnail style hint (operator-saved text formula) — '' when absent.
function channelThumbStyle(channel) {
  try { return fs.readFileSync(path.join(ROOT, channel, '_assets', 'thumbnail-style.txt'), 'utf8').trim(); }
  catch (_) { return ''; }
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

// ---- Script voice: universal CRAFT rules (every persona obeys these) + a library of selectable
//      PERSONAS (the character the narration is written in). The operator picks a persona per video on
//      the Script tab; add/override personas per channel via <channel>/_assets/script-personas.json. ----
const SCRIPT_CRAFT = [
  'WRITING CRAFT (holds for every persona — this is what makes it read like a person, not a model):',
  '- It is read ALOUD over stick-figure animation, so it must SOUND spoken, not read off a slide. Contractions are REQUIRED. Every sentence must be sayable in one breath.',
  '- TEXTURE over polish (the real human/AI tell): let cadence be uneven — a long, momentum-building sentence can crash into a two-word one; drop a fragment; start a sentence with "And" or "But"; let one aside show you find this genuinely cool. Smoothness is the giveaway; a little asymmetry is the cure.',
  '- SHOW before you label: open on a concrete, specific, usually present-tense image, THEN name the concept. Anchor deep time and scale to the viewer\'s own body ("a woman about your height, sixty thousand years ago"), name real people and places, and give every big number a tangible comparison.',
  '- REGISTER, not a blacklist: prefer the plain everyday word over the essay word. Avoid the AI-essay register — delve, tapestry, realm, testament, "navigate the complexities", "in today\'s world", "it\'s worth noting", moreover, furthermore, "in conclusion" — but do NOT contort around a word when it is literally the right one (a sea route can be "navigated").',
  '- NO hollow hedging ("some might argue", "it\'s important to consider"); NO filler list-of-three ("informative, engaging and fun") — but a CONCRETE triple is great ("cat-sized rats, pony-sized elephants, doorway-tall storks").',
  '- CLARITY-PROOF the writing, the hook above all (comprehension loss = viewers leaving): one idea per sentence, plain everyday words, ACTIVE voice ("the flood drowned the valley", not "the valley was drowned by the flood"). Read each hook line cold and ask if there is a SECOND way to read it — if yes, rewrite until there is only one.',
  '- Do not let any one move become the script\'s verbal signature: use the "not X — it\'s Y" reframe AT MOST ONCE in the whole script (yes, even for the central insight — say the reframe once and trust it), and open AT MOST ONE section with a rhetorical question. Vary every other pivot — let a consequence, a contradiction, or a concrete image carry the turn instead.',
  '- KEEP the mandated mid-video re-hook and the closing one-line takeaway + CTA (retention needs them) — but vary the re-hook wording every time, and never write a robotic "So, as we\'ve seen…" recap. End on your single strongest line.',
  '- Playful with the FRAMING, never with the FACTS — credibility is the whole brand. When the evidence is thin, say "we genuinely don\'t know" without flinching.',
  '- The out-loud test: if you would not actually say a line to a smart friend over a drink, cut it.',
].join('\n');
const DEFAULT_PERSONAS = [
  { id: 'skeptic-friend', name: 'The Skeptic Friend', blurb: 'Myth-busting, dry, the real story beats the legend — the evidence-first default.', voice: 'You are the friend who got a little obsessed with this. You think the real past is wilder than the myths, and you are quietly annoyed that the pseudo-archaeology gets the airtime while the actual evidence gets ignored — so you set the record straight, with relish. Warm, fast, precise, dry. You light up over a single good bone or a footprint. You never talk down, and you would rather say "we genuinely don\'t know" than oversell.' },
  { id: 'storyteller', name: 'The Storyteller', blurb: 'Cinematic and scene-driven — drops you into a moment and builds tension.', voice: 'You tell it like a story you cannot wait to reach the good part of. Drop the viewer into a moment — a place, a person, a problem — and let tension pull them through. You favor scenes over summary, you withhold and then reveal, and you trust one vivid image to carry the point. Still rigorous; the facts just arrive as story beats instead of bullet points.' },
  { id: 'excitable-nerd', name: 'The Excitable Nerd', blurb: 'High-energy and genuinely thrilled — the enthusiasm is the hook.', voice: 'You are genuinely, visibly thrilled by this stuff and cannot help sharing it. Fast, bright, a little breathless when something is amazing — but you earn every bit of excitement with the actual evidence, never hype for its own sake. You geek out over the detail everyone else skips, and that delight is the hook.' },
];
function readPersonas(channel) {
  const byId = new Map(DEFAULT_PERSONAS.map((p) => [p.id, p]));
  try {
    const f = path.join(ROOT, channel, '_assets', 'script-personas.json');
    if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j)) for (const p of j) if (p && p.id && p.name && p.voice) byId.set(p.id, p); }
  } catch (_) {}
  return [...byId.values()];
}
function resolvePersona(channel, id) { const list = readPersonas(channel); return list.find((p) => p.id === id) || list[0]; }
// Most-recent OTHER video's declared opening archetype on this channel (for rotation). Null if none.
function prevArchetypeOf(channel, id) {
  try {
    const base = path.join(ROOT, channel);
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d/.test(d.name) && d.name !== id)
      .map((d) => d.name).sort().reverse();   // highest-numbered first
    for (const d of dirs) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(base, d, 'studio.json'), 'utf8'));
        const a = (((doc.stages || {}).script || {}).candidates || {}).opening;
        if (a && a.archetype) return a.archetype;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
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

// ---- Voice pacing calibration — the SINGLE source of truth for words <-> minutes ----------------
// The pipeline used to assume 135 WPM everywhere, but the real ElevenLabs voice reads much faster
// (measured ~167 WPM on a real episode). Stale targets => scripts that miss the 8:00 mid-roll floor.
// So we MEASURE WPM from real voiced audio and drive every length number off that.
const DEFAULT_WPM = 165;          // fallback until a video has voiced audio to measure
const DEFAULT_TARGET_MIN = 8.5;   // channel default; a video overrides via studio.json.targetMinutes
const COVERAGE_EXPECTED = 0.92;   // ~8% of script words are lost turning the script into beats
const wc = (s) => (String(s || '').match(/[A-Za-z0-9'’-]+/g) || []).length;

// Total {words, seconds, beats} of all VOICED beats in one studio.json doc.
function voicedTally(doc) {
  const scenes = ((((doc || {}).stages || {}).scenes || {}).candidates || {}).scenes || [];
  let words = 0, seconds = 0, beats = 0;
  for (const s of scenes) {
    if (s.exclude) continue;
    const sec = +s.audioSeconds || 0;
    if (sec > 0) { seconds += sec; words += wc(s.narration); beats++; }
  }
  return { words, seconds, beats };
}

// Measured words-per-minute for a video's voice. Prefers this video's own audio; if it has < ~45s
// voiced, pools the channel's other videos; falls back to DEFAULT_WPM. Clamped to a sane band.
function measureWPM(channel, id) {
  const clamp = (w) => Math.max(120, Math.min(220, Math.round(w * 10) / 10));
  try {
    const sp = studioPath(channel, id);
    if (sp && fs.existsSync(sp)) {
      const t = voicedTally(JSON.parse(fs.readFileSync(sp, 'utf8')));
      if (t.seconds >= 45 && t.words > 0) return { wpm: clamp(t.words / (t.seconds / 60)), measured: true, sampleSeconds: Math.round(t.seconds) };
    }
  } catch (_) {}
  let words = 0, seconds = 0;
  const chDir = path.join(ROOT, channel);
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) {}
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const sp2 = path.join(chDir, d.name, 'studio.json');
    if (!fs.existsSync(sp2)) continue;
    try { const t = voicedTally(JSON.parse(fs.readFileSync(sp2, 'utf8'))); words += t.words; seconds += t.seconds; } catch (_) {}
  }
  if (seconds >= 45 && words > 0) return { wpm: clamp(words / (seconds / 60)), measured: true, sampleSeconds: Math.round(seconds) };
  return { wpm: DEFAULT_WPM, measured: false, sampleSeconds: 0 };
}

// Everything the UI + generators need to keep a video on-length, computed in ONE place.
function lengthPlan(channel, id, doc) {
  doc = doc || {};
  const v = measureWPM(channel, id), wpm = v.wpm;
  const targetMinutes = +doc.targetMinutes || DEFAULT_TARGET_MIN;
  const FLOOR_MIN = 8 + 10 / 60;                                   // 8:10 — a buffer above the 8:00 mid-roll line
  const endCardSec = (doc.endCard === false) ? 0 : ((doc.endCard && doc.endCard.seconds) || 12);
  const endCardMin = endCardSec / 60;
  // words to WRITE so the FINISHED video (after coverage loss + the end card) lands at >= the minutes given
  const wordsForMin = (m) => Math.round(Math.max(0, m - endCardMin) * wpm / COVERAGE_EXPECTED);
  const scriptText = ((((doc.stages || {}).script || {}).candidates || {}).script) || '';
  const scriptWords = wc(scriptText.replace(/\[[^\]]*\]/g, ' ').replace(/<[^>]*>/g, ' ').replace(/`[^`]*`/g, ' '));
  const t = voicedTally(doc);
  return {
    wpm, measured: v.measured, sampleSeconds: v.sampleSeconds, targetMinutes, floorMinutes: +FLOOR_MIN.toFixed(2), endCardSec,
    targetWords: wordsForMin(targetMinutes), floorWords: wordsForMin(FLOOR_MIN), ceilWords: wordsForMin(targetMinutes + 0.8),
    scriptWords, scriptMinutes: +((scriptWords / wpm) + endCardMin).toFixed(2),
    voicedBeats: t.beats, voicedWords: t.words, voicedSeconds: Math.round(t.seconds),
    voicedMinutes: +(t.seconds > 0 ? (t.seconds / 60) + endCardMin : 0).toFixed(2),
  };
}

// ---- Caption look (per-channel brand style chosen in the Studio; render + preview both read it) ----
const CAPTION_DEFAULT = { font: 'gloria', color: '#fffdf7', accent: '#f0883c', size: 70, case: 'sentence', treatment: 'shadow', tilt: true };
const CAPTION_FONT_FILES = { gloria: 'GloriaHallelujah.ttf', marker: 'PermanentMarker.ttf', patrick: 'PatrickHand.ttf', kalam: 'KalamBold.ttf', bangers: 'Bangers.ttf', archivo: 'ArchivoBlack.ttf' };
const CAPTION_FONT_LABELS = { gloria: 'Gloria Hallelujah', marker: 'Permanent Marker', patrick: 'Patrick Hand', kalam: 'Kalam', bangers: 'Bangers', archivo: 'Archivo Black' };
function captionStylePath(channel) { return path.join(ROOT, channel, '_assets', 'caption-style.json'); }
function readCaptionStyle(channel) { try { return Object.assign({}, CAPTION_DEFAULT, JSON.parse(fs.readFileSync(captionStylePath(channel), 'utf8'))); } catch (_) { return { ...CAPTION_DEFAULT }; } }

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Beat timeline + subtitle builders now live in lib/subtitles.js (one home, runnable offline). Aliased
// here so the existing call sites (Shorts Lab beat-ranges, YouTube caption upload) are unchanged.
// beatTimeline mirrors render/manifest.mjs beat rules; buildSrt syncs exactly to the assembled video.
const beatTimeline = SUBS.beatTimeline;
const buildSrt = SUBS.buildSrt;

// ---- YouTube connect (OAuth 2.0 → Data API + Analytics API). The OAuth *app* (client id/secret) is
//      global in .secrets.json; the per-channel refresh token + channel info live in
//      <channel>/_assets/youtube.json so each Studio channel binds to its own YouTube channel. ----
const YT_REDIRECT = 'http://localhost:' + PORT + '/api/youtube/oauth-callback';
// youtube.force-ssl is REQUIRED for the captions API (insert/list/delete); plain `youtube` covers
// uploads/thumbnails but NOT captions. Adding it means a one-time re-connect to grant the new scope.
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/yt-analytics.readonly'].join(' ');
const ytStates = new Map();   // one-time OAuth state nonce -> { channel, at }
const uploadingYT = new Set(); // ch|id currently uploading to YouTube
const ytUploadStatus = {};     // ch|id -> { state, pct, videoId, url, error }
const uploadingShorts = new Set(); // ch|id currently batch-uploading Shorts
const shortsUploadStatus = {};     // ch|id -> { state, total, done, results:[{clipId,title,videoId,url,error}] }
const syncingFunnel = new Set();        // channels with a funnel sync in progress (key: channel)
const funnelSyncStatus = {};            // channel -> { state, total, done, videos:[], checklist }
// Resumable upload of one local mp4 with the given metadata → returns the new videoId.
async function ytResumableUpload(token, file, meta) {
  const total = fs.statSync(file).size;
  const startRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(total) }, body: JSON.stringify(meta) });
  if (!startRes.ok) throw new Error('start ' + startRes.status + ': ' + (await startRes.text()).slice(0, 300));
  const uploadUrl = startRes.headers.get('location');
  if (!uploadUrl) throw new Error('no resumable session URL');
  const fd = fs.openSync(file, 'r'); const CHUNK = 8 * 1024 * 1024; const bufc = Buffer.allocUnsafe(CHUNK);
  let start = 0, videoId = '';
  try {
    while (start < total) {
      const len = Math.min(CHUNK, total - start); fs.readSync(fd, bufc, 0, len, start);
      const r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${start + len - 1}/${total}` }, body: bufc.subarray(0, len) });
      if (r.status === 308) { start += len; continue; }
      if (r.status === 200 || r.status === 201) { videoId = (await r.json()).id; break; }
      throw new Error('chunk ' + r.status + ': ' + (await r.text()).slice(0, 300));
    }
  } finally { fs.closeSync(fd); }
  if (!videoId) throw new Error('upload finished without a video id');
  return videoId;
}
// Fetch a video's snippet (null if deleted/inaccessible). videos.update needs the full snippet echoed back.
async function ytGetVideoSnippet(token, videoId) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + videoId, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('videos.list ' + r.status + ': ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  return (j.items && j.items[0] && j.items[0].snippet) || null;
}
// Live privacyStatus of a video ('public'|'unlisted'|'private') or null if unknown/inaccessible.
async function ytVideoPrivacy(token, videoId) {
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status&id=' + videoId, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    return (j.items && j.items[0] && j.items[0].status && j.items[0].status.privacyStatus) || null;
  } catch (_) { return null; }
}
async function ytUpdateVideoSnippet(token, videoId, snippet) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, snippet }),
  });
  if (!r.ok) throw new Error('videos.update ' + r.status + ': ' + (await r.text()).slice(0, 160));
  return r.json();
}
// Post a top-level comment as the channel. Needs youtube.force-ssl — throws (caught + reported) if not granted.
async function ytPostComment(token, videoId, text) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
  });
  if (!r.ok) throw new Error('comment ' + r.status + ': ' + (await r.text()).slice(0, 140));
  return (await r.json()).id;
}
// Upload (or replace) a caption track for a video. Idempotent: deletes any existing track in the same
// language we previously added, then inserts the new SRT via the multipart captions.insert upload.
async function ytUpsertCaption(token, videoId, srt, language, name) {
  language = language || 'en'; name = name || 'English';
  // remove existing same-language tracks so re-runs don't pile up duplicates (best-effort)
  try {
    const lr = await fetch('https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=' + videoId, { headers: { Authorization: 'Bearer ' + token } });
    if (lr.ok) {
      const items = ((await lr.json()).items) || [];
      for (const it of items) {
        const sn = it.snippet || {};
        const sameLang = (sn.language || '').toLowerCase().startsWith(language.toLowerCase());
        if (sameLang && sn.trackKind !== 'ASR') {   // don't touch YouTube's auto (ASR) track
          try { await fetch('https://www.googleapis.com/youtube/v3/captions?id=' + it.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  const meta = { snippet: { videoId, language, name, isDraft: false } };
  const boundary = '----loreCaptions' + Date.now();
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'),
    Buffer.from(srt, 'utf8'),
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  const txt = await r.text();
  if (!r.ok) throw new Error('captions.insert ' + r.status + ': ' + txt.slice(0, 300));
  return JSON.parse(txt);
}
function ytFile(channel) { return path.join(ROOT, channel, '_assets', 'youtube.json'); }
function readYT(channel) { try { return JSON.parse(fs.readFileSync(ytFile(channel), 'utf8')); } catch (_) { return null; } }
// YouTube rejects ANY '<' or '>' in a title/description (HTTP 400 invalidDescription / invalidTitle).
// Our shorts captions use "->" as a funnel arrow, which contains '>' → every upload bounced. Turn the
// common arrows into real glyphs, then strip any stray angle brackets. Shared by both upload paths.
function ytSafeText(s) { return String(s == null ? '' : s).replace(/-+>/g, '→').replace(/<-+/g, '←').replace(/[<>]/g, ''); }
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

// ---- YouTube Analytics API (scope yt-analytics.readonly already granted — no re-auth). Query
//      v2/reports; the caller fetches a bearer token ONCE via ytAccessToken and reuses it across the
//      many per-video reports a refresh makes. Throws on an API error; returns { columnHeaders, rows }. ----
async function ytAnalytics(token, params) {
  const qs = new URLSearchParams(Object.assign({ ids: 'channel==MINE' }, params));
  const r = await fetch('https://youtubeanalytics.googleapis.com/v2/reports?' + qs.toString(), { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j.error) throw new Error('analytics ' + (j.error.code || '') + ': ' + (j.error.message || 'unknown'));
  return j;
}
// Map a single-row report → { metricName: value }.
function rowObj(report) {
  const heads = (report.columnHeaders || []).map((h) => h.name), row = ((report.rows || [])[0]) || [];
  const out = {}; heads.forEach((h, i) => { out[h] = row[i]; }); return out;
}
// Every published video in a channel (has doc.youtube.videoId) → {id, videoId, uploadedAt(YYYY-MM-DD), title}.
function publishedVideos(channel) {
  const out = [], chDir = path.join(ROOT, channel);
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(chDir, d.name, 'studio.json'), 'utf8')); } catch (_) { continue; }
    const vid = doc.youtube && doc.youtube.videoId; if (!vid) continue;
    out.push({ id: d.name, videoId: vid, uploadedAt: String(doc.youtube.uploadedAt || '').slice(0, 10), title: doc.youtube.title || doc.workingTitle || d.name });
  }
  return out;
}

// ---- REAL UPLOADS: the channel's ACTUAL published videos from the Data API (uploads playlist), not
//      just the ones the Studio uploaded. Pages every videoId+title+publishedAt. ----
async function fetchRealUploads(token) {
  const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', { headers: { Authorization: 'Bearer ' + token } });
  const cj = await cr.json();
  if (cj.error) throw new Error('channels.list ' + (cj.error.code || '') + ': ' + (cj.error.message || ''));
  const pl = (((cj.items || [])[0] || {}).contentDetails || {}).relatedPlaylists;
  const uploads = pl && pl.uploads;
  if (!uploads) return [];
  const out = []; let pageToken = '';
  for (let guard = 0; guard < 20; guard++) {
    const u = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' + uploads + (pageToken ? '&pageToken=' + pageToken : '');
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.error) throw new Error('playlistItems.list ' + (j.error.code || '') + ': ' + (j.error.message || ''));
    for (const it of (j.items || [])) {
      const vid = (it.contentDetails && it.contentDetails.videoId) || (it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId);
      if (!vid) continue;
      out.push({ videoId: vid, title: (it.snippet && it.snippet.title) || '', uploadedAt: String((it.contentDetails && it.contentDetails.videoPublishedAt) || (it.snippet && it.snippet.publishedAt) || '').slice(0, 10) });
    }
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}
function normTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function titleSim(a, b) {
  const A = new Set(normTitle(a).split(' ').filter(Boolean)), B = new Set(normTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}
function localVideosForMatch(channel) {
  const chDir = path.join(ROOT, channel), out = [];
  let dirs = []; try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const sp = path.join(chDir, d.name, 'studio.json');
    let doc; try { doc = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (_) { continue; }
    const pk = ((doc.stages || {}).packaging || {});
    const locked = ((pk.candidates || {}).titles || []).find((t) => t.id === (pk.decision || {}).primaryTitle);
    out.push({ id: d.name, path: sp, doc, existingVideoId: (doc.youtube && doc.youtube.videoId) || null, title: (locked && locked.text) || doc.workingTitle || d.name });
  }
  return out;
}
// Reconcile real uploads with local videos; writes matched videoId back into the matched studio.json
// (candidate-side youtube block) so the pipeline/dashboard treat it as published. Returns the full
// published set (matched + orphan real uploads) in publishedVideos() shape for the analytics pull.
async function reconcileUploads(channel, token) {
  const real = await fetchRealUploads(token), locals = localVideosForMatch(channel);
  const usedLocal = new Set(), SIM_MIN = 0.5, published = [], report = { matched: [], orphans: [], alreadyBound: [] };
  const byExisting = {};
  for (const lv of locals) if (lv.existingVideoId) { byExisting[lv.existingVideoId] = lv; usedLocal.add(lv.id); }
  for (const ru of real) {
    if (byExisting[ru.videoId]) {
      const lv = byExisting[ru.videoId];
      published.push({ id: lv.id, videoId: ru.videoId, uploadedAt: ru.uploadedAt || (lv.doc.youtube && lv.doc.youtube.uploadedAt) || '', title: ru.title || lv.title });
      report.alreadyBound.push({ videoId: ru.videoId, id: lv.id });
      continue;
    }
    let best = null, bestSim = 0;
    for (const lv of locals) { if (usedLocal.has(lv.id)) continue; const sim = titleSim(ru.title, lv.title); if (sim > bestSim) { bestSim = sim; best = lv; } }
    if (best && bestSim >= SIM_MIN) {
      usedLocal.add(best.id);
      best.doc.youtube = Object.assign({}, best.doc.youtube, { videoId: ru.videoId, url: 'https://youtu.be/' + ru.videoId, title: ru.title || best.title, uploadedAt: ru.uploadedAt || (best.doc.youtube && best.doc.youtube.uploadedAt) || '', matchedBy: 'title-similarity', matchSim: +bestSim.toFixed(2), matchedAt: new Date().toISOString().slice(0, 10) });
      try { fs.writeFileSync(best.path, JSON.stringify(best.doc, null, 2)); } catch (_) {}
      published.push({ id: best.id, videoId: ru.videoId, uploadedAt: best.doc.youtube.uploadedAt, title: best.doc.youtube.title });
      report.matched.push({ videoId: ru.videoId, id: best.id, sim: +bestSim.toFixed(2), realTitle: ru.title, localTitle: best.title });
    } else {
      published.push({ id: null, videoId: ru.videoId, uploadedAt: ru.uploadedAt, title: ru.title, orphan: true });
      report.orphans.push({ videoId: ru.videoId, title: ru.title });
    }
  }
  return { published, report };
}

// ---- COACH: turn published-video performance into data-grounded suggestions. Cold-start-aware
//      (benchmark-first at low N, sharper as videos ship). Reads the analytics caches only. ----
function readCaches(channel) {
  const dir = path.join(ROOT, channel, '_analytics', 'cache');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; }
}
function buildCoach(channel) {
  const all = readCaches(channel);
  const pub = all.filter((c) => typeof c.averageViewPercentage === 'number');
  const n = pub.length, sugg = [];
  const add = (tier, conf, kind, surface, detail, videoId) => sugg.push({ tier, conf, kind, surface, detail, videoId });
  const med = (xs) => { const a = xs.filter((x) => typeof x === 'number').sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
  const short = (t) => '"' + String(t || '').slice(0, 40) + '"';
  const scored = pub.filter((c) => (c.views || 0) >= 3);   // ignore sparse/0-view uploads in channel medians + best/worst
  const medAvp = med(scored.map((c) => c.averageViewPercentage)), medViews = med(scored.map((c) => c.views));
  const subsPer1k = (c) => { const v = num(c.views), g = num(c.subscribersGained); return (v && v > 0 && g != null) ? (g / v) * 1000 : null; };
  const studioFor = (c) => { try { return c.id ? JSON.parse(fs.readFileSync(path.join(ROOT, channel, c.id, 'studio.json'), 'utf8')) : null; } catch (_) { return null; } };
  for (const c of pub) {
    const avp = c.averageViewPercentage, ctr = typeof c.ctr === 'number' ? c.ctr : null, t = String(c.title || '').slice(0, 40);
    if (Array.isArray(c.retention) && c.retention.length) {
      const p15 = c.retention.find((p) => p.t >= 0.15);
      if (p15 && p15.watch * 100 < 50) add(1, 'Benchmark', 'hook', 'script', '"' + t + '": only ' + Math.round(p15.watch * 100) + '% still watching at 0:15 (target 50%+). Rewrite the first 15s — open in-medias-res, no greeting/setup.', c.videoId);
      let cliff = null; for (let i = 2; i < c.retention.length - 1; i++) { if ((c.retention[i - 1].watch - c.retention[i].watch) > 0.06 && c.retention[i].t > 0.18 && c.retention[i].t < 0.7) { cliff = c.retention[i].t; break; } }
      if (cliff) add(1, 'Established', 'cliff', 'script', '"' + t + '": a retention cliff ~' + Math.round(cliff * 100) + '% through — add a re-hook or cut the tangent at that point.', c.videoId);
    }
    const tv = (c.traffic || []).reduce((a, x) => a + (x.views || 0), 0) || c.views || 0;
    const disc = (c.traffic || []).filter((x) => /BROWSE|SUGGESTED|YT_SEARCH/.test(String(x.source))).reduce((a, x) => a + (x.views || 0), 0);
    if (avp >= 50 && (ctr == null || ctr >= 4) && tv >= 1 && disc / tv < 0.3) add(0, 'Benchmark', 'reach', 'pulse', '"' + t + '" retains well (' + Math.round(avp) + '% viewed' + (ctr != null ? ', ' + ctr + '% CTR' : '') + ') but barely any browse/suggested reach — the content is good, the algorithm just isn\'t distributing it yet. Levers: ship consistently (authority), sharpen SEO (keyword-first title + tags + description) for search, and a stronger thumbnail for browse.', c.videoId);
    if (avp < 35 && (c.views || 0) >= 50) add(1, 'Established', 'retention', 'script', '"' + t + '": ' + Math.round(avp) + '% avg viewed is below the ~40% bar — tighten pacing and add a pattern interrupt every 20-30s.', c.videoId);
  }
  if (n >= 1) { const best = pub.slice().sort((a, b) => (b.ctr || 0) - (a.ctr || 0))[0]; if (best && typeof best.ctr === 'number') add(1, n >= 3 ? 'Established' : 'Early', 'packaging', 'packaging', 'Best click-through so far: ' + short(best.title) + ' at ' + best.ctr + '% CTR. Lean the next title/thumbnail toward that style — keep what clicks.', best.videoId); }

  // B.1 — best & worst video, with the reason (n>=2)
  if (scored.length >= 2) {
    const byAvp = scored.slice().sort((a, b) => b.averageViewPercentage - a.averageViewPercentage), best = byAvp[0], worst = byAvp[byAvp.length - 1];
    const reason = (c) => { const b = []; if (num(c.averageViewPercentage) != null) b.push(Math.round(c.averageViewPercentage) + '% viewed'); const sp = subsPer1k(c); if (sp != null) b.push(sp.toFixed(1) + ' subs/1k'); if (num(c.views) != null) b.push(c.views + ' views'); return b.join(', '); };
    add(2, n >= 4 ? 'Established' : 'Early', 'compare', 'pulse', 'Your strongest video is ' + short(best.title) + ' (' + reason(best) + ') and the weakest is ' + short(worst.title) + ' (' + reason(worst) + '). Make the next idea look like the winner, not the loser.', best.videoId);
  }
  // B.3 — best traffic source + what it implies
  { const agg = {}; let total = 0; pub.forEach((c) => (c.traffic || []).forEach((x) => { const v = num(x.views) || 0; agg[x.source] = (agg[x.source] || 0) + v; total += v; }));
    if (total > 0) { const top = Object.entries(agg).sort((a, b) => b[1] - a[1])[0], share = Math.round((top[1] / total) * 100), src = top[0];
      const implies = /YT_SEARCH/.test(src) ? 'evergreen/search demand — double down on keyword-first titles + tight SEO; these compound for months.' : /SUGGESTED/.test(src) ? 'the algorithm is recommending you next to other videos — make companion videos on adjacent topics to ride that.' : /BROWSE/.test(src) ? 'your thumbnails are winning the home feed — keep that thumbnail style and post consistently.' : /(SHORTS|RELATED)/.test(src) ? 'short-form / related surfaces — add a long-form CTA and a series hook.' : 'external/other — your off-platform sharing is doing the work.';
      add(1, n >= 3 ? 'Established' : 'Early', 'reach', 'pulse', 'Most of your views come from ' + src + ' (' + share + '%). That implies ' + implies, null); } }
  // B.4 — subs-per-1000-views leaderboard (n>=2)
  if (n >= 2) { const conv = pub.map((c) => ({ c, sp: subsPer1k(c) })).filter((x) => x.sp != null).sort((a, b) => b.sp - a.sp);
    if (conv.length >= 2) { const top = conv[0], bot = conv[conv.length - 1]; add(2, 'Established', 'compare', 'pulse', short(top.c.title) + ' converts ' + top.sp.toFixed(1) + ' subscribers per 1,000 views — your best. ' + short(bot.c.title) + ' only ' + bot.sp.toFixed(1) + '. Whatever the winner did to earn the sub (the CTA, the payoff, the depth), repeat it.', top.c.videoId); } }
  // B.5 — outliers vs channel median (n>=4)
  if (n >= 4 && medViews && medAvp) { pub.forEach((c) => {
    if (num(c.views) != null && c.views >= medViews * 1.8) add(2, 'Established', 'compare', 'pulse', short(c.title) + ' is an OUTPERFORMER — ' + Math.round(c.views / medViews * 100) + '% of your median views. Mine it: same topic lane, same packaging angle, a follow-up.', c.videoId);
    if (num(c.averageViewPercentage) != null && c.averageViewPercentage <= medAvp * 0.6) add(2, 'Established', 'retention', 'script', short(c.title) + ' under-retains badly — ' + Math.round(c.averageViewPercentage) + '% vs your ' + Math.round(medAvp) + '% median. Rewatch its first 30s + mid-section against your best video.', c.videoId); }); }
  // B.6 — momentum from daily history
  { let hist = {}; try { hist = JSON.parse(fs.readFileSync(path.join(ROOT, channel, '_analytics', 'stats-history.json'), 'utf8')); } catch (_) {}
    const daily = hist.daily || [];
    if (daily.length >= 14) { const cut = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), cut2 = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
      const sumK = (from, to, k) => daily.filter((d) => d.date >= from && (!to || d.date < to)).reduce((a, d) => a + (+d[k] || 0), 0);
      const v14 = sumK(cut, null, 'views'), vPrev = sumK(cut2, cut, 'views'), subs14 = sumK(cut, null, 'subsGained') - sumK(cut, null, 'subsLost');
      if (vPrev > 0) { const chg = Math.round((v14 - vPrev) / vPrev * 100);
        if (chg >= 25) add(1, 'Early', 'momentum', 'pulse', 'Momentum is UP: views +' + chg + '% vs the prior 14 days (' + (subs14 >= 0 ? '+' : '') + subs14 + ' net subs). Ship the next video NOW while the algorithm is leaning in.', null);
        else if (chg <= -25) add(1, 'Early', 'momentum', 'pulse', 'Momentum is COOLING: views ' + chg + '% vs the prior 14 days. Don\'t change the formula on a dip — ship one more on your best topic to re-warm it.', null); } } }
  // B.7 — length/runtime that retains best (n>=4)
  if (n >= 4) { const lenOf = (c) => { const doc = studioFor(c); const scenes = doc && ((((doc.stages || {}).scenes || {}).candidates || {}).scenes || []).filter((s) => !s.exclude); const fromScenes = scenes && scenes.length ? scenes.reduce((a, s) => a + (s.audioSeconds || s.seconds || 0), 0) : 0; if (fromScenes > 60) return fromScenes; const avd = num(c.averageViewDuration), avp = num(c.averageViewPercentage); return (avd && avp) ? avd / (avp / 100) : null; };
    const buckets = { 'under 8 min': [], '8-10 min': [], 'over 10 min': [] };
    pub.forEach((c) => { const L = lenOf(c); if (!L) return; const k = L < 480 ? 'under 8 min' : L <= 600 ? '8-10 min' : 'over 10 min'; buckets[k].push(c.averageViewPercentage); });
    const ranked = Object.entries(buckets).filter(([, v]) => v.length >= 2).map(([k, v]) => ({ k, avp: v.reduce((a, x) => a + x, 0) / v.length, nn: v.length })).sort((a, b) => b.avp - a.avp);
    if (ranked.length >= 2 && (ranked[0].avp - ranked[ranked.length - 1].avp) >= 4) add(3, 'Strong', 'length', 'script', ranked[0].k + ' videos retain best for you (' + Math.round(ranked[0].avp) + '% over ' + ranked[0].nn + ') — target that length on the next script.', null); }
  // B.8 — retention-shape clustering (n>=3)
  if (n >= 3) { const shapeOf = (c) => { const r = c.retention; if (!Array.isArray(r) || r.length < 5) return null; const at = (frac) => { const p = r.find((x) => x.t >= frac); return p ? p.watch : null; }; const a05 = at(0.05), a15 = at(0.15), a50 = at(0.5), a90 = at(0.9);
      if (a05 != null && a15 != null && a05 - a15 > 0.25) return 'cliff'; if (a15 != null && a90 != null && a15 - a90 > 0.55) return 'bleed'; if (a15 != null && a50 != null && a90 != null && (a15 - a50) > (a50 - a90) * 2) return 'mid-sag'; return 'hold'; };
    const tally = {}; pub.forEach((c) => { const s = shapeOf(c); if (s) tally[s] = (tally[s] || 0) + 1; });
    const dom = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (dom && dom[1] >= 2 && dom[0] !== 'hold') { const fix = { cliff: 'Your hooks are the recurring failure — viewers bail in the first 15s. Open in-medias-res, cut all setup.', bleed: 'Steady drain throughout — pacing is too flat. Add a content-motivated pattern interrupt every 20-30s and a mid-video re-hook.', 'mid-sag': 'You lose people in the MIDDLE consistently — the act-2 tangent is too long. Cut a sub-loop or move the payoff earlier.' }[dom[0]]; add(2, 'Established', dom[0] === 'cliff' ? 'hook' : 'retention', 'script', 'Across ' + dom[1] + ' videos the retention curves share one shape: "' + dom[0] + '". ' + fix, null); } }
  // B.9 — channel verdict: hook vs packaging (n>=3)
  if (n >= 3) { const medCtr = med(pub.map((c) => num(c.ctr)).filter((x) => x != null)), lowAvp = medAvp != null && medAvp < 40;
    if (medCtr != null) { const lowCtr = medCtr < 4; let verdict;
      if (lowCtr && !lowAvp) verdict = 'PACKAGING is your bottleneck: people who click STAY (median ' + Math.round(medAvp) + '% viewed) but too few click (median ' + medCtr + '% CTR). Pour effort into titles + thumbnails, not the script.';
      else if (!lowCtr && lowAvp) verdict = 'YOUR HOOK/SCRIPT is the bottleneck: your packaging earns the click (median ' + medCtr + '% CTR) but viewers leave early (median ' + Math.round(medAvp) + '% viewed). Fix the first 30s + pacing — leave the thumbnails alone.';
      else if (lowCtr && lowAvp) verdict = 'BOTH are weak (median ' + medCtr + '% CTR, ' + Math.round(medAvp) + '% viewed) — rethink the topic/angle itself, not just the trim.';
      else verdict = 'Healthy on both (median ' + medCtr + '% CTR, ' + Math.round(medAvp) + '% viewed) — the lever now is VOLUME + consistency, not optimization.';
      add(2, 'Established', 'verdict', 'pulse', 'CHANNEL VERDICT: ' + verdict, null);
    } else if (medAvp != null) add(1, 'Early', 'verdict', 'pulse', 'CHANNEL VERDICT (CTR not entered yet): median retention is ' + Math.round(medAvp) + '% viewed' + (lowAvp ? ' — below the 40% bar, so the script/hook is the first thing to fix. Enter your CTR per video to diagnose packaging too.' : ' — solid; enter your CTR per video to see if packaging is the limiter.'), null); }
  // B.10 — best-converting topic lane for Idea gen (n>=4)
  if (n >= 4) { const lanes = {}; pub.forEach((c) => { const doc = studioFor(c); const lane = doc && ((doc.idea && (doc.idea.topic || doc.idea.lane)) || doc.topic); if (!lane) return; const sp = subsPer1k(c); (lanes[lane] = lanes[lane] || []).push({ avp: c.averageViewPercentage, sp }); });
    const ranked = Object.entries(lanes).filter(([, v]) => v.length >= 2).map(([k, v]) => ({ k, score: v.reduce((a, x) => a + (x.avp || 0) + (x.sp || 0) * 5, 0) / v.length, nn: v.length })).sort((a, b) => b.score - a.score);
    if (ranked.length >= 2) add(3, 'Strong', 'idea', 'idea', 'Topic lane "' + ranked[0].k + '" is your best performer (' + ranked[0].nn + ' videos, top retention+sub-pull). Generate the next idea inside that lane before branching out.', null); }

  // B.11 — rank the one-fix by impact × confidence (verdict + hook/retention first)
  const confW = { Strong: 3, Established: 2.5, Early: 1.5, Benchmark: 1 };
  const kindW = { verdict: 5, hook: 4, cliff: 3.5, retention: 3, packaging: 3, length: 2, momentum: 2, reach: 1.5, compare: 1.5, idea: 1 };
  const score = (s) => (kindW[s.kind] || 1) * (confW[s.conf] || 1) / (s.tier + 1);
  const oneFix = n >= 5 ? sugg.slice().sort((a, b) => score(b) - score(a))[0] : null;   // Step-13: ONE binding fix per 5-video cycle
  return { channel, n, suggestions: sugg, oneFix };
}
// The learnings preamble injected into the generate-* prompts (the "suggestions based on previous posts").
function coachPreamble(channel, surface) {
  const c = buildCoach(channel);
  if (!c.n) return 'PERFORMANCE COACH: no published-video data on this channel yet — apply the channel defaults (the title formulas + thumbnail rules in channel.md, a hook in the first 5-15s, an 8-10 min target, the myth-buster spine). These notes sharpen as videos ship.';
  const rel = c.suggestions.filter((s) => !surface || s.surface === surface || s.surface === 'pulse');
  if (!rel.length) return 'PERFORMANCE COACH (' + c.n + ' published): nothing flagged for this stage — follow the channel defaults.';
  return ['PERFORMANCE COACH — bias this toward what has worked on THIS channel (from ' + c.n + ' published video' + (c.n > 1 ? 's' : '') + '). Apply these data-grounded notes:'].concat(rel.map((s) => '- [' + s.conf + '] ' + s.detail)).join('\n');
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

  // Decode request bodies as UTF-8 via a proper StringDecoder. Every route accumulates text with
  // `body += chunk`; without this, each raw Buffer chunk is decoded INDEPENDENTLY, so a multi-byte
  // character (em dash, curly quote…) split across a ~64KB chunk boundary is corrupted to U+FFFD.
  // All bodies here are text/JSON (uploads are base64-in-JSON), so a global setEncoding is safe.
  req.setEncoding('utf8');

  // Local-only guard. The Studio can spawn headless Claude and write files, so requests must
  // come from this machine (loopback bind at the bottom) AND from a localhost page — a foreign
  // Origin means some website is trying to drive the Studio cross-origin (CSRF). Block both.
  const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  const reqHost = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (reqHost && !ALLOWED_HOSTS.includes(reqHost))
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
    // BACKFILL: hand-authored scripts often lack the Script-page ChatGPT thumbnail prompt. If a
    // script exists and a thumbnail concept is picked, rebuild the prompt once and persist it —
    // it can then never "go missing" again (the 009 regression). One-time write per video.
    try {
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      const sc = ((doc.stages || {}).script || {}).candidates;
      if (sc && sc.script && !sc.thumbnailPrompt) {
        const { concept, title, picked } = resolveThumbConcept(doc);
        if (picked) {
          sc.thumbnailPrompt = THUMB.buildChatGptThumbPrompt(concept, title, channelThumbStyle(query.channel));
          fs.writeFileSync(p, JSON.stringify(doc, null, 2));
          return send(res, 200, JSON.stringify(doc, null, 2));
        }
      }
    } catch (_) { /* malformed studio.json → serve the raw file untouched */ }
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

  // --- Length plan: calibrated WPM + target + projected/actual runtime (the UI's length readout) ---
  if (pathname === '/api/length' && req.method === 'GET') {
    const p = studioPath(query.channel, query.id);
    if (!p || !fs.existsSync(p)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try { return send(res, 200, JSON.stringify(lengthPlan(query.channel, query.id, JSON.parse(fs.readFileSync(p, 'utf8'))))); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }

  // --- Set a video's target length (minutes). Top-level field, so it survives decision-only saves. ---
  if (pathname === '/api/set-target' && req.method === 'POST') {
    const p = studioPath(query.channel, query.id);
    if (!p || !fs.existsSync(p)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const m = +(JSON.parse(body || '{}').minutes);
        if (!(m >= 8 && m <= 15)) return send(res, 400, JSON.stringify({ error: 'minutes must be 8–15' }));
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        doc.targetMinutes = Math.round(m * 2) / 2;     // half-minute granularity
        doc.updatedAt = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(doc, null, 2));
        send(res, 200, JSON.stringify(lengthPlan(query.channel, query.id, doc)));
      } catch (e) { send(res, 400, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Script personas: the selectable voices for the picker on the Script tab (built-ins + channel file) ---
  if (pathname === '/api/script-personas' && req.method === 'GET') {
    const list = readPersonas(query.channel).map((p) => ({ id: p.id, name: p.name, blurb: p.blurb || '' }));
    return send(res, 200, JSON.stringify({ list, default: (list[0] && list[0].id) || 'skeptic-friend' }));
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
            + `Rewrite both the framework fields and the "layout" object. Framework fields (these drive the final art): "subject":{ "who":"<${vc.names.join('|')}|none>", "emotion":"<a SPECIFIC AUTHENTIC feeling e.g. 'dawning dread' — NEVER generic 'shocked'>", "gaze":"<at-camera|left|right; PREFER at-camera direct eye contact (~+20% CTR); use left/right only to lead the eye toward textSide>" }, "support":"<the ONE supporting element>", "hook":"<<=2 words; ALL the thumbnail text; COMPLEMENTS the title, never restates it>", "accent":"<ONE BOGY hex: #2F6BFF|#FF7A1A|#22C55E|#FFD21A>", "textSide":"<left|right; OPPOSITE the subject>". `
            + `Then the "layout" object (the structured wireframe spec, NOT an "svg" string), kept consistent with the above: { "bg":"<sky|dawn|sunset|ember|night|ocean|snow|forest|sand|stone|cave|blizzard>", "accent":"<hex; the SAME BOGY accent>", "subject":{ "who":"<${vc.names.join('|')}|none>", "pose":"<short, specific action + facial expression>", "zone":"<left|center|right; opposite textSide>", "scale":"<hero|medium>" }, "props":[<=3 short labels], "mood":"<one-phrase lighting/atmosphere>", "text":[ {"line":"<UPPERCASE 1-3 words>","role":"<accent|dark|white>"} ], "textZone":"<left|right|center|top|bottom>" }. ${vc.note ? 'The cast are reimagined for this video: ' + vc.note + ' — keep the concept in that look. ' : ''}Rule of three: ONE subject + ONE support + the hook. Keep 2-3 elements, ONE accent, the key subject in the left ~60%, a strong emotional facial read, legible at 120x68 (the channel's _assets/style-bible.md §9). `
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
          `You are a top-tier YouTube thumbnail strategist for an educational explainer channel. In ${sp}, REGENERATE the whole thumbnail set (stages.packaging.candidates.thumbnails) for this video using the operator's accumulated feedback. Produce EXACTLY 6 strong, genuinely DIFFERENT concepts — not six rewordings of one idea. Every concept must obey legibility: ≤3 elements (subject + props + text lines), the hero subject in the left ~60% (zone:"left", scale:"hero"), ≤3 headline words, and the headline must COMPLEMENT the locked title (add emotion/stakes) — never re-spell it.`,
          `Primary title to match: "${primary ? primary.text : '(none picked yet)'}". First, identify the title's PIVOT — the single most curiosity-loaded word or idea (the thing that makes someone need to click) — and make every concept dramatize THAT, not the generic topic.`,
          castPromptLine(vc),
          `FRAMEWORK (each concept is a structured ANGLE, not just a layout): obey the rule of three — exactly ONE dominant subject + ONE supporting element + the hook text (no more). The subject's emotion must be a SPECIFIC, AUTHENTIC feeling (e.g. "dawning dread", "stunned realization", "quiet grief") — NEVER the generic open-mouth "shocked" face (the algorithm flags those as low-quality spam; they are explicitly banned). By DEFAULT the subject makes DIRECT EYE CONTACT (gaze:"at-camera") — a face looking straight into the lens is the single biggest CTR lever (~+20%); use side-gaze (toward the textSide, to lead the eye to a key element) only as a deliberate variant, not the norm. The hook is ALL the thumbnail text: <=2 words, and it must COMPLEMENT the locked title — adding the emotion/stakes the title can't state — never restate or re-spell it. Use exactly ONE BOGY accent: Blue #2F6BFF, Orange #FF7A1A, Green #22C55E, or Yellow #FFD21A.`,
          `Each concept must (a) pose a VISUAL CURIOSITY GAP — a "wait, what?" image (a surprising juxtaposition, an impossible-looking object, a partial reveal) the title can't state, not just a portrait; and (b) be an HONEST promise the video pays off. The 2026 algorithm weighs "Quality CTR" (retention right after the click) and DEMOTES bait — so lean on AWE / SURPRISE / CURIOSITY, never fear/shock-bait (it spikes clicks then craters trust). Contrast hard: a glowing subject on a clean, NON-gray background (well past 4.5:1), reading cleanly at 120x68 on a phone (mobile = 70%+ of views).`,
          `DIVERSITY IS THE POINT. Across the 6, deliberately vary the EMOTIONAL register and the COMPOSITION so they are real alternative bets:`,
          `  - Emotion: spread them across (lonely/vulnerable), (dread/disbelief), (tense/ominous), (awe/wonder), (myth-busted/"actually…"), (curious/mysterious) — at least 4 distinct, SPECIFIC emotions across the set (never the banned generic "shocked").`,
          `  - Composition: vary scale (some a HERO close-up on one face filling the frame, some a MEDIUM figure-in-a-scene), vary the subject's zone (left vs centre vs right), and vary the background mood. No two should feel like the same shot.`,
          `  - Subject: most use ONE cast member as the emotional anchor (a big, unmistakable facial expression is the #1 click driver); 1-2 may be a striking object/scene with "none". Pick the cast member whose role best carries each concept.`,
          `  - Gaze: MOST concepts make direct at-camera eye contact (gaze:"at-camera" — the ~20% CTR lift); reserve side-gaze for 1-2 where the eyes should lead the viewer to the supporting element.`,
          `LEAN INTO (operator marked warmer): ${warm.length ? warm.join('; ') : '(none marked)'}.`,
          `MOVE AWAY FROM (operator marked colder): ${cold.length ? cold.join('; ') : '(none marked)'}.`,
          `Per-thumbnail notes:\n${tnotes.length ? tnotes.join('\n') : '  (none)'}`,
          `Overall note: ${(dec.notes || '').trim() || '(none)'}`,
          `Evolve the warmer concepts in the noted direction, drop/avoid the colder ones, and fill the rest with fresh distinct bets — all aligned to the title and CLAUDE.md §3 + the channel's _assets/style-bible.md §9 packaging rules (max 2-3 elements, ONE accent, <=3-5 bold words, key subject in the left ~60%, legible at 120x68 in light AND dark mode).`,
          `Each thumbnail = { "id":"th-<unique>", "name":"<short>", "rationale":"<one line: the click bet + which emotion/composition slot it fills>", "subject": { "who":"<${whoList}>", "emotion":"<a SPECIFIC, AUTHENTIC feeling e.g. 'dawning dread' / 'stunned realization' — NEVER the generic 'shocked'>", "gaze":"<at-camera|left|right; PREFER at-camera direct eye contact (~+20% CTR) — left/right only to lead the eye, pointing toward textSide>" }, "support":"<the ONE supporting element (the rule-of-three middle element)>", "hook":"<<=2 words; ALL the thumbnail text; COMPLEMENTS the title — never restates it>", "accent":"<ONE BOGY hex: #2F6BFF|#FF7A1A|#22C55E|#FFD21A>", "textSide":"<left|right; the side OPPOSITE the subject (the gaze side), reserved for the hook>", "layout": { "bg":"<one of: sky|dawn|sunset|ember|night|ocean|snow|forest|sand|stone|cave|blizzard>", "accent":"<hex; ONE dominant accent — match the BOGY accent above>", "subject": { "who":"<${whoList}>", "pose":"<short, SPECIFIC action + facial expression>", "zone":"<left|center|right>", "scale":"<hero|medium>" }, "props":[<up to 3 SHORT prop labels>], "mood":"<a vivid one-phrase lighting/atmosphere note, e.g. 'cold blue dusk, single warm fire glow'>", "text":[ {"line":"<UPPERCASE 1-3 words>","role":"<accent|dark|white>"} ], "textZone":"<left|right|center|top|bottom>" } }. The new framework fields (subject/support/hook/accent/textSide) are REQUIRED and drive the final art prompt; keep the "layout" object too (it renders the wireframe preview) and keep it consistent with them — layout.subject.zone OPPOSITE the textSide, layout.accent === the BOGY accent, layout.text mirroring the hook. Always include a "mood" phrase in layout. Use the structured "layout" object, NOT an "svg" string.`,
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
        // Unlock the next stage — and CREATE it if the doc is missing it (e.g. a hand-authored studio.json),
        // otherwise this silently no-ops and the next tab stays falsely locked forever.
        if (nx) {
          if (!doc.stages[nx]) doc.stages[nx] = { status: 'awaiting-human', candidates: {}, decision: {} };
          else if (doc.stages[nx].status === 'locked') doc.stages[nx].status = 'awaiting-human';
        }
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
          coachPreamble(query.channel, 'idea'),
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
          coachPreamble(query.channel, 'packaging'),
          `Do the PACKAGING title stage for the video in this folder: ${folder}.`,
          `Read the APPROVED idea from ${sp}: stages.idea.candidates holds the idea(s); the chosen one is the entry whose id === stages.idea.decision.chosenIdea (or the single legacy idea / its .statement). Its statement + angle + spine are your brief.`,
          `Read ${path.join(chDir, 'channel.md')} for THIS channel's TITLE FORMULAS, voice, and audience, and ${path.join(ROOT, 'CLAUDE.md')} §3 packaging rules.`,
          `Write 10-12 candidate TITLES that sell this idea's SPECIFIC angle (not a generic topic). Length ~45-62 characters with the hook + primary keyword inside the first ~40 (mobile shows ~the first 40 chars; desktop truncates near 70 — never overexplain past 70). Exact/odd numbers beat round ones; avoid generic superlatives ("Unbelievable", "Amazing"). Vary the FORMULA across the set so they are genuinely different BETS, not rewordings — draw from: behavior-mystery, hidden-revelation ("The real reason..."), counterintuitive number, myth-rebuttal, CONTRARIAN / mistake-frame ("Everyone thinks X — they're wrong"), CONTRAST / versus (A vs B), and the PHILOSOPHICAL HOOK ("[familiar concept]: [surprising implication]" — the Kurzgesagt/Veritasium move that overperforms for explainer content).`,
          `TITLE CRAFT (research-backed — the 2026 algorithm rewards "Quality CTR": a click whose first 30s actually pays off, and DEMOTES titles that overpromise, so honest-but-compelling is the literal optimum and rigor is a CTR strategy, not a tax): (1) CURIOSITY GAP THAT GETS FILLED — open a specific knowledge gap AND signal the video closes it; NEVER promise a non-answer ("science doesn't know", "nobody knows", "still no answer", "remains a mystery", "we may never know") — tease the REVEAL, not the dead-end. (2) HIGH-AROUSAL, HONEST EMOTION — awe, surprise, unease, FOMO; make the viewer FEEL the stakes, not just identify the topic. Cut low-arousal abstractions ("how we became us", "the newest face on Earth") and empty words ("mystery", "secrets", "the truth about") unless made concrete. (3) RECOGNITION + NOVELTY — anchor on something familiar, then twist it into a context they haven't considered (our myth->reframe IS this). (4) LEAD WITH THE PAYOFF on at least 2-3 candidates — put the most surprising REVEAL in the title, not just the setup question. (5) CONCRETE beats abstract every time — a specific noun, number, or image over a poetic phrase.`,
          `KEYWORD-FIRST: put the primary search keyword in the first ~40 characters (search is the surface a small channel can actually reach). Every title must be one the SCRIPT CAN HONESTLY PAY OFF — never nominate the softest or over-promising claim; rigor is the brand.`,
          `NOMINATE THE BETS: set recommendedPrimary = the id of the single strongest HONEST click that LEADS WITH A CONCRETE REVEAL OR STAKES (not a bare topic-question and never a non-answer framing), and recommendedAB = the id of the most STRUCTURALLY DISTINCT challenger to it (a different formula AND breadth — e.g. a reveal-led awe bet vs a keyword-first search-safe bet — NOT a reworded near-duplicate). Add abRationale: one line naming what the A/B actually tests.`,
          `Then in ${sp}, set stages.packaging.candidates = { "titles": [ { "id":"t1", "text":"<the title>", "why":"<one short line: the bet>" }, ... ], "recommendedPrimary":"<id of the best honest primary>", "recommendedAB":"<id of the most distinct A/B challenger>", "abRationale":"<one line: what the A/B tests>" } and set stages.packaging.status = "awaiting-human". Do NOT add thumbnails (those come after the operator locks a primary title). Do NOT modify any other stage. Keep studio.json valid JSON.`,
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
        // FUNNEL context: the long-form this Short is mined from is the destination we drive viewers to.
        const _pk = (doc.stages || {}).packaging || {};
        const _pt = ((_pk.candidates || {}).titles || []).find((t) => t.id === (_pk.decision || {}).primaryTitle);
        const fullTitle = (_pt && _pt.text) || doc.workingTitle || query.id;
        const fullUrl = (doc.youtube && doc.youtube.videoId) ? ('https://youtu.be/' + doc.youtube.videoId) : '';
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
          `HOOK CRAFT — a Short is skipped in ~1.5 seconds unless the FIRST line nails two jobs: TOPIC CLARITY (the viewer instantly knows what it is about) and ON-TARGET CURIOSITY (it is for them, a payoff is coming, they need to know what's next). Avoid the four hook killers: (1) DELAY / vague tease — never open with content-free suspense ("you won't believe this", "the craziest thing"); name the CONCRETE subject in the first ~1.5s. (2) CONFUSION — plain words, ONE possible interpretation, active voice. (3) IRRELEVANCE — use "you / your" and agitate the exact curiosity or pain this clip resolves, so it feels made for the viewer. (4) DISINTEREST — open a curiosity loop via CONTRAST: A (what people assume) vs B (the surprising truth this clip pays off); state it ("everyone thinks X — actually Y") or imply it. A hook is usually 2-3 lines: clarity first, contrast next. The clip's "hook" field, the "open" overlay, AND the thumbnail punchWord must all reflect this.`,
          `STEP 4 — for each clip also write: a Shorts-rewrite (hook 0-3s / setup / payoff / loop-or-callback ending) for an optional re-voiced cut, 5 title options (curiosity-first, like "Humans Shouldn't Have Reached Australia"), 3 text overlays of 3-6 words IN ALL CAPS, bold and punchy (open hook / mid / END), a ready-to-paste post caption with 3-5 hashtags, and a custom THUMBNAIL concept (see below).`,
          `THUMBNAIL (per clip) — design a custom vertical (9:16) cover for THIS clip. The cover ART is TEXT-FREE (a bold punch word is composited on top later), so describe only the IMAGE: which CAST MEMBER carries it and the SPECIFIC, authentic emotion that sells this clip's surprise (never "shocked"), the single arresting SCENE/image, and ONE accent color. Separately give a 1-3 word ALL-CAPS punch word pulled from the hook. Think: one big reacting face high in the frame that reads at thumbnail size.`,
          `SATISFY + EXTEND (do NOT sabotage the Short to feed the funnel): each clip MUST deliver its OWN complete, satisfying micro-payoff — that standalone value is what earns the Shorts-feed push and high retention. Do NOT withhold the Short's payoff or end on a pure cliffhanger. THEN, after the payoff, open a SEPARATE, bigger question that ONLY the full video answers — put it in a new field "bigLoop" (one line). Funnel to that: the "end" overlay, the postCaption nudge, and the pinnedComment all reference the bigLoop ("…and that's not even the strangest part — full story on the channel"), naming the full video "${fullTitle}". The server appends the real link.`,
          `VERTICAL FRAMING: each clip renders as a 9:16 Short with the FULL landscape frame FIT TO WIDTH — nothing is cropped off the sides (so edge content like map labels survives), and the captions/overlays sit in the top & bottom margin bands. So keep every overlay SHORT (3-6 words) and punchy, and don't assume anything is edge-to-edge full-screen.`,
          `Think like a creator chasing 1M views, not a teacher: prioritize curiosity, retention, shareability, emotional reaction, historical surprise — NOT educational completeness.`,
          `OUTPUT: write ONE file at ${clipsFile} — valid JSON, plain ASCII punctuation (straight quotes, hyphens; NO smart quotes or em-dashes), shaped EXACTLY:`,
          `{ "clips": [ { "id":"clip-1", "title":"<short internal name>", "fromBeat":<n>, "toBeat":<n>, "hook":"<first line viewers hear>", "why":"<why it works, 1-2 sentences>", "viralScore":<1-100>, "scores":{"curiosity":<1-10>,"shareability":<1-10>,"standalone":<1-10>,"visual":<1-10>}, "shortsTitles":["t1","t2","t3","t4","t5"], "overlays":{"open":"<3-6 words>","mid":"<3-6 words>","end":"<funnel CTA naming the bigLoop>"}, "bigLoop":"<the bigger question only the full video answers>", "shortScript":{"hook":"...","setup":"...","payoff":"...","loop":"..."}, "postCaption":"<caption + hashtags, ending with a funnel nudge>", "pinnedComment":"<warm one-liner sending viewers to the full video>", "thumb":{"who":"<cast member + what they are reacting to>","emotion":"<specific authentic emotion, NOT 'shocked'>","punchWord":"<1-3 word ALL-CAPS, from the hook>","accent":"<color name or #hex>","scene":"<one line: the single arresting image>"} } ] }`,
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
          // Append the REAL funnel link to each pinned comment (the long-form this Short came from).
          clips.forEach((c) => {
            const base = String(c.pinnedComment || ('Watch the full video: "' + fullTitle + '"')).trim();
            c.pinnedComment = base + (fullUrl ? ('  ' + fullUrl) : '  (full video on the channel)');
          });
          clips.sort((x, y) => (y.viralScore || 0) - (x.viralScore || 0));
          // Name the rendered file after the clip's title (e.g. "humans-shouldnt-have-reached-australia.mp4")
          // instead of "clip-1.mp4" — deduped slug stored as clip.file, used by render + status + UI.
          const _seen = new Set();
          clips.forEach((c) => {
            let base = String((c.shortsTitles && c.shortsTitles[0]) || c.title || c.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'clip';
            let out = base, n = 1; while (_seen.has(out)) out = base + '-' + (++n); _seen.add(out);
            c.file = out;
          });
          // THUMBNAIL PROMPT per clip — deterministic, so every clip ALWAYS carries a ready-to-paste
          // 9:16 text-free art prompt (channel style folded in) + a punch word, even if Claude's
          // structured `thumb` is sparse. Mirrors the main-thumbnail two-layer approach.
          let channelStyleTxt = '';
          try { channelStyleTxt = fs.readFileSync(path.join(ROOT, query.channel, '_assets', 'thumbnail-style.txt'), 'utf8').trim(); } catch (_) {}
          const castNames = readCast(query.channel).map((c) => c.name).filter(Boolean);
          clips.forEach((c) => {
            const t = c.thumb || {};
            c.thumbWord = THUMB.shortPunchWord(t.punchWord || (c.overlays && c.overlays.open) || c.hook || c.title);
            const who = String(t.who || '').trim()
              || castNames.find((nm) => String(c.hook || '').includes(nm))
              || (castNames[0] ? (castNames[0] + ' (host), reacting') : 'the cast member');
            c.thumbPrompt = THUMB.buildShortThumbPrompt({ who, emotion: t.emotion, accent: t.accent, scene: t.scene }, channelStyleTxt);
          });
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
              '- **🖼️ Thumbnail (9:16) punch word:** ' + (c.thumbWord || '(none)'),
              '- **🖼️ Thumbnail art prompt** (text-free 9:16 — paste with the cast sheet attached, then add the punch word): ' + (c.thumbPrompt || '').replace(/\n+/g, '  ·  '),
              '- **🪝 Big loop (full-video hook):** ' + (c.bigLoop || '(none)'),
              '- **Post caption:** ' + (c.postCaption || ''),
              '- **📌 Pinned comment (funnel → full video):** ' + (c.pinnedComment || ''),
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
        // File base = the title slug (clip.file), so the output is "<title>.mp4" not "clip-1.mp4".
        const fb = (clip.file && /^[\w-]+$/.test(clip.file)) ? clip.file : clip.id;
        const rk = query.channel + '|' + query.id + '|' + fb;
        if (renderingShorts.has(rk)) return send(res, 200, JSON.stringify({ reply: 'That clip is already rendering.', running: true }));
        renderingShorts.add(rk);
        const shortsDir = path.join(path.dirname(sp), '05-edit', 'shorts');
        fs.mkdirSync(shortsDir, { recursive: true });
        const log = fs.createWriteStream(path.join(shortsDir, 'render.log'), { flags: 'a' });
        const args = [path.join(RENDER_DIR, 'render.mjs'), query.channel, query.id, String(clip.fromBeat), String(clip.toBeat), '--vertical', '--name=' + fb];
        const ov = clip.overlays || {};
        if ((ov.open || '').trim()) args.push('--hook=' + ov.open.trim());
        if ((ov.mid || '').trim()) args.push('--ovmid=' + ov.mid.trim());
        if ((ov.end || '').trim()) args.push('--ovend=' + ov.end.trim());
        const child = spawn(process.execPath, args, { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
        child.stdout.on('data', (d) => log.write(d)); child.stderr.on('data', (d) => log.write(d));
        child.on('error', () => renderingShorts.delete(rk));
        child.on('close', () => { renderingShorts.delete(rk); try { log.end(); } catch (_) {} });
        send(res, 200, JSON.stringify({ started: true, clipId: clip.id, file: fb }));
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
    // Serve the rendered vertical clip (.mp4) OR its cover still (.cover.png) from 05-edit/shorts/.
    const isCover = /^[\w-]+\.cover\.png$/.test(query.name || '');
    if (!sp || !safeSeg(query.name) || !(/^[\w-]+\.mp4$/.test(query.name) || isCover)) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(path.dirname(sp), '05-edit', 'shorts', query.name);
    if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    if (isCover) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(f));
      return;
    }
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

  // --- Multi-platform Shorts distribution kit: per-clip captions for YouTube / TikTok / Instagram ---
  if (pathname === '/api/shorts-distribution' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try {
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const clips = ((((doc.stages || {}).shorts || {}).candidates || {}).clips) || [];
      if (!clips.length) return send(res, 200, JSON.stringify({ clips: [] }));
      const longUrl = doc.youtube && doc.youtube.videoId ? 'https://youtu.be/' + doc.youtube.videoId : '';
      const longTitle = (doc.youtube && doc.youtube.title) || '';
      const ctx = { channel: query.channel, longUrl, longTitle };
      // Beat lookup so we can sum a clip's beat durations when it carries no explicit length.
      const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
      const byBeat = new Map(scenes.map((s) => [s.n, s]));
      const clipDuration = (c) => {
        if (typeof c.seconds === 'number') return c.seconds;
        if (typeof c.durationSec === 'number') return c.durationSec;
        if (typeof c.fromBeat === 'number' && typeof c.toBeat === 'number') {
          let sum = 0, any = false;
          for (let n = c.fromBeat; n <= c.toBeat; n++) {
            const s = byBeat.get(n);
            if (s && typeof s.audioSeconds === 'number') { sum += s.audioSeconds; any = true; }
          }
          if (any) return sum;
        }
        return null;
      };
      const out = clips.map((clip) => {
        const dur = clipDuration(clip);
        return {
          id: clip.id,
          file: clip.file || clip.id,
          lengthOK: dur == null ? null : dur <= 90,
          captions: {
            youtube: SHORTSDIST.buildCaption('youtube', clip, ctx),
            tiktok: SHORTSDIST.buildCaption('tiktok', clip, ctx),
            instagram: SHORTSDIST.buildCaption('instagram', clip, ctx),
          },
        };
      });
      return send(res, 200, JSON.stringify({ clips: out }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }

  // --- Render ONE vertical 1080x1920 Short COVER still (hook-beat art + bold headline) via render/cover.mjs ---
  if (pathname === '/api/shorts-cover' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const opts = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const clips = ((((doc.stages || {}).shorts || {}).candidates || {}).clips) || [];
        // Resolve the clip: by explicit id / file, else by 1-based index n.
        let clip = null;
        if (opts.id != null) clip = clips.find((c) => c.id === opts.id || c.file === opts.id);
        if (!clip && opts.n != null) { const i = parseInt(opts.n, 10) - 1; if (i >= 0 && i < clips.length) clip = clips[i]; }
        if (!clip) return send(res, 404, JSON.stringify({ error: 'no such clip' }));
        const fb = clip.file || clip.id;
        const ik = query.channel + '|' + query.id + '|' + clip.id;
        if (coveringShorts.has(ik)) return send(res, 200, JSON.stringify({ error: 'A cover is already rendering for this clip — hang tight.', busy: true }));
        coveringShorts.add(ik);
        try {
          // Background art = the clip's hook-beat scene image, else the final thumbnail art.
          let artAbs = path.join(folder, '04-assets', 'images', String(clip.fromBeat).padStart(3, '0') + '.png');
          if (!fs.existsSync(artAbs)) artAbs = path.join(folder, '00-packaging', 'thumbnails', 'final-1.art.png');
          if (!fs.existsSync(artAbs)) { send(res, 400, JSON.stringify({ error: 'no source image for the cover — generate scene images first' })); return; }
          const headline = String((clip.overlays && clip.overlays.open) || clip.hook || '');
          const shortsDir = path.join(folder, '05-edit', 'shorts');
          fs.mkdirSync(shortsDir, { recursive: true });
          const outAbs = path.join(shortsDir, fb + '.cover.png');
          const relOut = '05-edit/shorts/' + fb + '.cover.png';
          // Mirror the thumb.mjs spawn EXACTLY (cwd RENDER_DIR, renderEnv, reject on non-zero / missing output).
          await new Promise((resolve, reject) => {
            const args = [
              path.join(RENDER_DIR, 'cover.mjs'),
              '--art', artAbs,
              '--hook', headline,
              '--accent', '#FF7A1A',
              '--out', outAbs,
            ];
            const child = spawn(process.execPath, args, { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
            let err = '';
            child.stderr.on('data', (d) => { err += d; });
            child.stdout.on('data', () => {});
            child.on('error', (e) => reject(e));
            child.on('close', (code) => {
              if (code === 0 && fs.existsSync(outAbs)) resolve();
              else reject(new Error('cover.mjs failed (exit ' + code + '): ' + (err.slice(-500).trim() || 'no output')));
            });
          });
          await withFileLock(sp, () => {
            const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
            const lc = ((((live.stages || {}).shorts || {}).candidates || {}).clips || []).find((c) => c.id === clip.id);
            if (lc) lc.coverPath = relOut;
            live.updatedAt = new Date().toISOString();
            fs.writeFileSync(sp, JSON.stringify(live, null, 2));
          });
          send(res, 200, JSON.stringify({ ok: true, file: relOut }));
        } finally { coveringShorts.delete(ik); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Deep research pass: a DEDICATED sourced research-brief BEFORE scripting (split out of the one big
  //     script call so research goes deeper + better-sourced). Headless Claude + live WebSearch/WebFetch. ---
  if (pathname === '/api/research' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const k = query.channel + '|' + query.id;
      if (generatingResearch.has(k)) return send(res, 200, JSON.stringify({ reply: 'A research pass is already running — hang tight.', busy: true }));
      generatingResearch.add(k);
      try {
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const pk = (doc.stages && doc.stages.packaging) || {};
        const locked = ((pk.candidates || {}).titles || []).concat((pk.decision || {}).customTitles || []).find((t) => t.id === (pk.decision || {}).primaryTitle);
        const idea = (doc.stages && doc.stages.idea && doc.stages.idea.decision) || {};
        const topic = ((() => { try { return JSON.parse(body || '{}').topic; } catch (_) { return ''; } })() || '').trim() || (locked && locked.text) || doc.workingTitle || '';
        const angle = idea.statement || idea.angle || '';
        const instr = [
          `Do a DEEP RESEARCH pass for the video in this folder: ${folder}. This is a DEDICATED research step that runs BEFORE scripting — go deeper and source harder than a quick pass.`,
          topic ? `Topic / working title: "${topic}".` : '',
          angle ? `The channel's angle: "${angle}".` : '',
          `Use live WebSearch + WebFetch to gather PRIMARY, RECENT, CREDIBLE sources (peer-reviewed journals, museum/university pages, reputable science press). Prefer recent work where the field has moved; note when a finding is recent or revised.`,
          `Per CLAUDE.md §1-§4: assemble the FACTUAL backbone, fact-check every load-bearing claim against a real source, strip pseudo-archaeology, and EXPLICITLY label consensus vs. active debate — never present a contested date/claim as settled.`,
          `Write TWO files (overwrite if present): (1) 01-research/research-brief.md — the factual backbone organized for scripting: the core insight/argument, key facts with the specific numbers/dates, the strongest evidence, the main myth(s) to dismantle, and what is contested; (2) 01-research/sources.md — a clean source list (title + outlet/author + year + URL), grouped ESTABLISHED vs. CONTESTED, each with a one-line note on what it supports.`,
          `Do NOT write the script or modify studio.json. Reply in ONE short sentence: what you found + how many sources.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'Write', 'Edit', 'Bash(node *)', '--exclude-dynamic-system-prompt-sections',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const r = await runClaude(args, 12 * 60 * 1000);
        let reply = 'Research brief written.', isError = false;
        try { const j = JSON.parse(r.out); reply = j.result || reply; isError = !!j.is_error; }
        catch (_) { reply = (r.err || 'no output').slice(0, 800); isError = true; }
        const wrote = fs.existsSync(path.join(folder, '01-research', 'research-brief.md'));
        send(res, 200, JSON.stringify({ reply, isError: isError && !wrote, wroteBrief: wrote }));
      } catch (e) { send(res, 200, JSON.stringify({ reply: 'Research failed: ' + String(e && e.message || e), isError: true })); }
      finally { generatingResearch.delete(k); }
    });
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
        const scriptDec = (doc.stages.script && doc.stages.script.decision) || {};
        const note = (scriptDec.notes || '').trim();
        const persona = resolvePersona(query.channel, scriptDec.persona);
        const vc = videoCast(query.channel, query.id);
        const L = lengthPlan(query.channel, query.id, doc);
        const made = producedVideos(query.channel, query.id);
        const madeList = made.length ? made.map((v) => `"${v.title}"`).join('; ') : "(none yet — this is one of the channel's first videos)";
        const instr = [
          coachPreamble(query.channel, 'script'),
          `Do the next pipeline stage (research -> fact-check -> script + thumbnail prompt) for the video in this folder: ${folder}`,
          `Follow CLAUDE.md standards (hook in first 5s, retention beats, mid-video re-hook, payoff that delivers the locked title, memorable takeaway). PLACE THE PRIMARY SUBSCRIBE CTA MID-VIDEO — a brief, in-voice nudge right after the biggest insight/payoff, NOT only at the end (end-only CTAs convert worst); a short outro sign-off at the very end is fine, but the main ask lands mid-video.`,
          `LENGTH IS A HARD REQUIREMENT — the #1 reason past videos failed is they came in TOO SHORT. Your narrator reads ~${Math.round(L.wpm)} words per minute (${L.measured ? 'MEASURED from this channel\'s real voiced audio' : 'estimated until there is voiced audio'}), NOT the old 135-WPM assumption. The target length is ${L.targetMinutes} minutes, so write ${L.targetWords}–${L.ceilWords} words of SPOKEN NARRATION — count ONLY spoken words (exclude every [bracketed] direction and structure marker). This is a FLOOR, not a ceiling: NEVER come in under ${L.floorWords} narration words, because the finished video must clear 8:00 to keep mid-roll ads. If the topic feels thin for that length, ADD real substance — another line of evidence, a concrete example, a vivid scene, a deeper myth-bust — never filler, padding, or repetition. In 02-script/script.md's header, state the target length, the ${Math.round(L.wpm)} WPM you wrote to, and the final spoken-word count.`,
          `EDITORIAL SPINE (the channel's evidence-first edge): (1) Build the WHOLE video around ONE non-obvious, load-bearing INSIGHT — a specific reframing the viewer leaves with — set it up early and pay it off at the climax; do not write a flat survey. (2) Include at least one beat where the skeptic dismantles a SPECIFIC popular myth or misconception relevant to the topic (pseudo-archaeology, a debunked "fact", an outdated textbook claim) — name it and correct it. (3) Explicitly LABEL consensus vs. active debate: when something is contested, say so and say what the evidence actually supports; never state a contested date/claim as settled. (4) Sources must be primary/recent and credible (peer-reviewed journals, museums, universities) — distinguish established from contested in 01-research/sources.md.`,
          `COMPARABLE NUMBERS ARE GOLD: where it strengthens a point, give concrete, comparable figures the viewer can grasp — durations, quantities, dates, counts, sizes (e.g. "Neanderthals lasted ~390,000 years; we've managed ~300,000 so far"). Beats like these get turned into clean ANIMATED on-screen charts (a top-performing visual), so surfacing real comparable numbers in the script directly feeds them. Don't force it — but when a genuine comparison is there, make it explicit and concrete rather than vague ("far longer").`,
          `PERSONA — write the ENTIRE script as this one narrator, "${persona.name}": ${persona.voice}`,
          SCRIPT_CRAFT,
          ER.EARLY_RETENTION,
          (() => {
            const prevArch = prevArchetypeOf(query.channel, query.id);
            const menu = ER.readOpeningArchetypes(ROOT, query.channel).map((a) => `${a.id} (${a.name}: ${a.blurb})`).join(' · ');
            return `OPENING ARCHETYPE — choose exactly ONE opening shape from this menu and write the cold open in it: ${menu}. ` +
              (prevArch ? `The previous video used "${prevArch}" — pick a DIFFERENT one for freshness. ` : '') +
              `Whatever you pick, the universal EARLY RETENTION rules above still apply.`;
          })(),
          `CRITICAL: the script is PURE NARRATION — a single voiceover. NO character dialogue, NO speaker names or labels, no "Max says". The cast (${vc.names.join(' / ')}) appear ONLY in the visuals; the narrator tells the entire story. Visual/scene cues may appear in [brackets], but every spoken line is narration.`,
          castPromptLine(vc),
          `OUTRO / WATCH-NEXT RULE: end on the ONE most memorable takeaway plus a brief subscribe nudge. Do NOT invent, tease, or promise a specific other video that may not exist (no "watch this next: the story of X" unless X is real). You may bridge to a "watch next" ONLY if it is one of the channel's ALREADY-PUBLISHED videos: ${madeList}. If none fit, close cleanly and let the end card + YouTube end screen carry the watch-next. The FINAL beat's visual should keep the right third of the frame clear for an end-screen card.`,
          `1) Research the topic with credible sources (use web search if available; otherwise rely on your knowledge and say so). 2) Fact-check load-bearing claims; reject pseudo-archaeology. 3) Write the script.`,
          `4) Also write a ready-to-paste ChatGPT image-generation prompt for the CHOSEN thumbnail (read stages.packaging.decision.chosenThumbnail and use that thumbnail's concept/cast/scene/text; if none is chosen, base it on the primary title). Use the thumbnail prompt skeleton in the channel's _assets/style-bible.md: tell ChatGPT to attach cast-sheet.png, draw the named cast member(s) in the colored cast style, wide 16:9, with the exact bold hook text spelled out.`,
          `Write these files in the folder: 01-research/research-brief.md, 01-research/sources.md, 02-script/script.md, and 00-packaging/thumbnail-prompt.md.`,
          `Then in ${sp}, set stages.script.candidates = { "script": <full script markdown string>, "words": <number>, "sources": [<short source strings>], "thumbnailPrompt": <the ChatGPT thumbnail prompt as one string>, "opening": { "archetype": "<the ONE archetype id you chose from the menu>" } } and stages.script.status = "awaiting-human". Do NOT modify the packaging stage. Keep studio.json valid JSON.`,
          note ? `Apply this revision note: "${note}".` : '',
          `Reply in ONE short sentence.`,
        ].filter(Boolean).join('\n');
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'Edit', 'Write', 'Bash(node *)', '--exclude-dynamic-system-prompt-sections',
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
        const L = lengthPlan(query.channel, query.id, doc);
        const WPM = Math.round(L.wpm);
        let bodyObj = {}; try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
        const force = query.force === '1' || bodyObj.force === true;   // regenerate from scratch even if partial scenes exist
        // Spoken-word count of the script (strip [directions] and <stubs>) — drives the coverage check.
        const scriptText = ((doc.stages.script && doc.stages.script.candidates && doc.stages.script.candidates.script) || '');
        const scriptWords = (scriptText.replace(/\[[^\]]*\]/g, ' ').replace(/<[^>]*>/g, ' ').match(/[\w’'-]+/g) || []).length;
        // --- shared storyboard rules (identical for a fresh build and a continuation) ---
        const shared = [
          castPromptLine(vc),
          `IMAGE KINDS (set per scene): "illustration" = the cast acting out the beat (the default). "map" = ANY geographic beat — a place, a migration route, a species range, dig-site locations, "across Europe/Asia", two groups far apart, a refuge. MAPS ARE RENDERED BY AN ACCURATE MAP ENGINE (real coastlines + a gazetteer of correct coordinates), not drawn by the image model — so set kind=map and write image_prompt as "MAP: <what it shows — the region, the places by their REAL names, any route or range>"; do NOT describe a hand-drawn map. "infographic" = a DATA diagram (a timeline, a duration/quantity comparison, a single date marker, a chart, or a TREND/GROWTH/DECAY curve over a continuous variable like time) — these are ALSO rendered deterministically from structured data, so set kind=infographic and write image_prompt as "TIMELINE: <the bars/markers with their exact years>", "COMPARE: <the quantities>", or "PLOT: <a quantity over time — the curve's key points with REAL numbers, e.g. brain size 450cc at 3.5M years ago, 800cc at 1.8M, climbing to 1,350cc today>" giving the REAL numbers (they are drawn correctly by code, never guessed). Reserve a Gemini-DRAWN infographic only for a purely PICTORIAL concept (an icon montage, a family-tree shape, a DNA helix) and keep it WORDLESS.`,
          `PREFER DETERMINISTIC INFOGRAPHICS — actively HUNT for them; they are a PROVEN high-performer (they animate in well, even in Shorts) and always render correct. Whenever the narration compares DURATIONS, QUANTITIES, DATES, COUNTS, SIZES or PROPORTIONS, walks a TIMELINE / sequence of dates, or describes a quantity RISING or FALLING over time (a trend / growth / decline — a PLOT curve), make that beat a deterministic infographic (kind=infographic; image_prompt "TIMELINE: <bars/markers with the exact years>", "COMPARE: <the quantities/values>", or "PLOT: <the curve's key points with REAL numbers over time>" with the REAL numbers) — do NOT bury the comparison inside a flat illustration or leave it only in the narration. Ask of EVERY data-bearing beat "could this be a clean animated chart?" — if yes, make it one. Aim for ~2-4 infographic beats in a typical 8-12 min video wherever the content genuinely supports it; never invent data to force one.`,
          `ABSOLUTE TEXT RULE for EVERY image prompt: never describe text, words, numbers, equations, chalkboards, charts, axes, graphs, dates, "labels", "measurements", or a "row of portraits / cast lineup" inside an illustration or pictorial-infographic prompt — image models garble them and copy labels straight off the cast sheet. Any number, date or stat goes in on_screen_text (the editor overlay), NEVER baked into the art. Keep every illustration and pictorial infographic completely text-free.`,
          `NO-CAST OBJECT/SCENE BEATS: when a beat's characters is EMPTY (objects, icons, scenery, diagrams — no named cast), the image is rendered with NO cast reference attached, so write the image_prompt for PLAIN INANIMATE objects/scenery. NEVER call them "friendly", "cute", "smiling", "happy", "with a face/eyes", or otherwise anthropomorphize them, and never name or imply a cast member in that prompt — any "friendly/face" wording makes the model graft a face onto the object (a car/gun/outlet/burger with eyes). Faces and expressions belong ONLY on beats that list a named cast member in characters.`,
          `ON-SCREEN TEXT (CUES) — on-screen text is a SECOND channel, NOT subtitles and NOT an echo of the narration. DEFAULT IS NO TEXT. A beat gets text ONLY if it clears one of four gates: (a) an unfamiliar proper NOUN the first time it's said — species/place/person the ear can't catch (kind=label); (b) a NUMBER/stat (kind=stat); (c) the ONE turn/myth-bust/payoff in the beat (kind=reveal, at most one); (d) a scripted hook / re-hook / [TEXT:"..."] cue (kind=marker). NEVER caption: a paraphrase of the sentence, common words the viewer hears plainly, a second cue just because the beat is long, or ANYTHING on a map/infographic beat (they carry their own labels). Most beats get NO cues — that restraint is the point.`,
          `LISTS BUILD: when the narration enumerates ("three species: X, Y, and Z"), emit ONE cue per item with the SAME group name and kind=build, in spoken order, each anchor=that item's exact spoken word — they pop in one-by-one and stack. This is the highest-value on-screen moment; always do it for enumerations.`,
          `CUE CASE: write each cue's text in normal Mixed Case; put the ONE word to emphasize in its emph field (the editor renders that token in ALL-CAPS + accent). Do not ALL-CAPS the whole text. Keep text <= 6 words.`,
          `CUES COLUMN FORMAT: the cues column packs all cues for the beat. Cues are separated by " || "; each cue is six fields joined by "~" in EXACTLY this order: kind~pos~group~anchor~emph~text  (pos = top-center|center|lower-third; group blank unless it's a build set; anchor = the exact narration word it syncs to; emph = the one word to highlight; text = the words shown). Leave the cues column EMPTY for beats with no on-screen text. Example (a 3-species build): build~center~species~Neanderthals~Neanderthals~Neanderthals || build~center~species~Denisovans~Denisovans~Denisovans || build~center~species~Hobbit~Hobbit~the Hobbit  — and a single stat: stat~top-center~~forty-four~44%~44% less aggressive . Leave on_screen_text/text_pos/text_anim EMPTY when you use cues.`,
          `EDIT BLUEPRINT — this is an edit-ready storyboard, not just images. For each beat also specify, using these controlled vocabularies (the channel's _assets/style-bible.md §10): cast_action = a SHORT stage direction dramatizing the narrative engine (Max wonders → Zed doubts → Nova explains → Luna marvels), e.g. "Zed crosses arms, then throws hands up"; motion = the camera move (push-in | push-out | pan-left | pan-right | static) — give nearly every illustration a subtle move (push-in default; pan across maps/landscapes; static or slow pan for infographics); text_anim = how the caption enters (punch | fade | type | none — punch for a hard stat, none when there is no caption); sfx = 0-2 short cue tokens joined by | (whoosh, pop, ding, thud, riser, water, wind, fire, click, page, boom); ambient = the background bed (ocean | wind | cave | forest | savanna | ice | fire | crowd | none); ambient_fx = an OPTIONAL drifting PARTICLE overlay, ONLY where the scene genuinely motivates it (embers for firelit/night beats | spores or pollen for fungal/forest beats | dust for ancient/dry interiors | snow for ice-age cold | rain for storms | blank for MOST beats) — use sparingly, it is accent not default; real_photo = a SHORT Pexels search phrase ONLY for a beat about a SPECIFIC, real, photographable artifact / fossil / mummy / site / object (e.g. "Otzi the iceman mummy", "Lascaux cave paintings", "Stonehenge stones") — it shows the ACTUAL thing as a credibility cutaway; blank for everything else. Use it RARELY (0-4 per video); NEVER for generic concepts, living people, emotions, or abstract ideas (those stay cartoon); music_cue = ONLY on beats where the music should shift (act1 | rehook | act2 | payoff | outro), blank otherwise.`,
          `For EACH beat produce: n (1-based), segment, kind (illustration|infographic), seconds (hold = narration length, rounded), characters (cast appearing by name; [] if none), narration (exact narration on screen this beat), visual (one-line), on_screen_text (short caption or blank), text_pos (top-center|lower-third|center|none), text_anim, motion, sfx, ambient, ambient_fx, real_photo, music_cue, cast_action, imagePrompt (CONCISE 1-2 sentences: for an illustration, attach cast-sheet.png and draw the cast member(s) in their ESTABLISHED look from the cast references — match face, hair and wardrobe exactly (if the cast was adapted for this video, use that adapted era/species/wardrobe, NOT default modern dress), big expressive face, performing the cast_action, NO caption text, headroom at top; for an infographic, describe the clean hand-drawn diagram/map/timeline with SHORT exact labels; wide 16:9, flat, bold outlines, no photorealism).`,
          `COVERAGE WITHIN THIS PASSAGE IS MANDATORY: turn the narration passage you are given COMPLETELY into beats — every sentence becomes one or more beats. Do NOT skip, summarize, abbreviate, or write "...". (A full 8-12 min script totals ~50-90 beats; you are storyboarding ONE chunk of it.)`,
          `Do NOT edit studio.json. Write ONLY the single CSV file named in the WRITE instruction below — the server imports it automatically.`,
        ];
        const COLS = 'scene,segment,seconds,kind,characters,narration,visual,on_screen_text,text_pos,text_anim,motion,sfx,ambient,ambient_fx,real_photo,music_cue,cast_action,image_prompt,cues';
        // Clean spoken text + a bounded-chunk splitter. We storyboard the script in ~CHUNK_WORDS-word
        // passages so no single claude call must write the whole CSV at once (the old monolith got
        // SIGKILLed past the cap with NOTHING written). Each chunk extends to the next sentence end.
        const CHUNK_WORDS = 300;
        const cleanScript = scriptText.replace(/\[[^\]]*\]/g, ' ').replace(/`[^`]*`/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextChunk = (text) => {
          const words = String(text || '').trim().split(/\s+/).filter(Boolean);
          if (words.length <= Math.round(CHUNK_WORDS * 1.3)) return { chunk: words.join(' '), final: true };
          let n = CHUNK_WORDS;
          const look = words.slice(CHUNK_WORDS, CHUNK_WORDS + 60);   // extend to the next sentence end
          const rel = look.findIndex((w) => /[.!?]["'’)\]]?$/.test(w));
          if (rel >= 0) n = CHUNK_WORDS + rel + 1;
          return { chunk: words.slice(0, n).join(' '), final: n >= words.length };
        };
        const coverageFinal = `This passage reaches the END of the script — the FINAL beat MUST be an explicit OUTRO / end-card beat (music_cue=outro) that lands the closing thought and invites the viewer to subscribe / watch next.`;
        const moreFollows = `This is only PART of the script — MORE narration follows and will be storyboarded in the next pass. Do NOT write an outro, end-card, recap or wrap-up yet; storyboard ONLY the passage you were given and then stop.`;
        const segRules = `Segment like a video editor: group the narration into SEGMENTS and, within each, SUB-SEGMENTS — each sub-segment is one coherent visual moment (a new place, action, concept, character, list item, or reveal). Start a NEW image whenever the visual idea changes; keep ONE image while the narration stays on the same idea, so hold time VARIES. Each image's hold = its narration length (words / ${WPM} * 60 seconds, at this voice's MEASURED pace). Lists/enumerations → a separate quick image per item; a complex map or diagram → ONE image held for the whole explanation; a reveal/payoff → its own held image. Cut on sentence/clause breaks, never mid-phrase. Do NOT impose a uniform cadence and do NOT pad.`;
        const seedInstr = (chunk, final) => [
          `Build the START of the scene/image list for the video in this folder: ${folder}. The video is a series of STANDALONE still images — ONE image per content beat (sub-segment) — each held on screen while its narration plays, then a hard cut to the next image when the narration moves on.`,
          `Storyboard EXACTLY this narration passage (verbatim, in order) into beats — turn ALL of it into beats:\n"""\n${chunk}\n"""`,
          segRules,
          final ? coverageFinal : moreFollows,
          ...shared,
          `Write 03-scenes/scene-list.csv with columns in EXACTLY this order: ${COLS} — include the header row. Scene numbers start at 1. characters and sfx are |-joined (blank if none). Use proper CSV quoting for any field containing a comma.`,
          note ? `Apply this revision note: "${note}".` : '',
          `Reply in ONE short sentence with the beat count.`,
        ].filter(Boolean).join('\n');
        // Pull out the script text AFTER the last existing beat, so a continuation gets the exact, bounded
        // passage to storyboard (the model failed when asked to "find where you left off" on its own).
        const remainingAfter = (lastNarr) => {
          const clean = scriptText.replace(/\[[^\]]*\]/g, ' ').replace(/`[^`]*`/g, ' ');   // drop [directions] + `markers`
          // Anchor on the last ~6 words of the previous beat. Match on alphanumeric RUNS joined by a
          // flexible separator, so an internal hyphen ("full-grown") or punctuation can't break the match.
          const tail = String(lastNarr || '').trim().split(/\s+/).filter(Boolean).slice(-6).join(' ');
          const runs = tail.match(/[A-Za-z0-9]+/g) || [];
          if (runs.length < 3) return '';
          const rx = new RegExp(runs.join('[^A-Za-z0-9]+'), 'i');
          const m = clean.match(rx);
          return m ? clean.slice(m.index + m[0].length).trim() : '';
        };
        const continueInstr = (maxN, last, chunk, final) => [
          `CONTINUE an existing scene list for the video in this folder: ${folder}. The file 03-scenes/scene-list.csv ALREADY contains beats 1..${maxN}; the last one's narration is: "${String(last).slice(0, 180)}". Those beats are FINAL and already voiced — do NOT open, edit, renumber, re-order or rewrite scene-list.csv.`,
          `Storyboard EXACTLY this next narration passage (verbatim, in order) into NEW beats — turn ALL of it into beats:\n"""\n${chunk}\n"""`,
          segRules,
          final ? coverageFinal : moreFollows,
          ...shared,
          `WRITE: put ONLY the new beats in a NEW file 03-scenes/scene-list.append.csv — DATA ROWS ONLY, NO header row — columns in EXACTLY this order: ${COLS}. Scene numbers start at ${maxN + 1} and increment by 1. characters and sfx are |-joined. Use proper CSV quoting for any field with a comma. Do NOT touch scene-list.csv.`,
          note ? `Apply this revision note: "${note}".` : '',
          `Reply in ONE short sentence with how many beats you appended.`,
        ].filter(Boolean).join('\n');
        // FAST, SINGLE-SHOT headless storyboarder. The real bottleneck was NOT the model or throttling
        // (a trivial headless call returns in ~5s) — it was the AGENTIC TOOL LOOP: with Read/Edit/Bash
        // available the model turned "write a CSV" into a long coding session (writing+running node
        // scripts, re-reading/editing the file over many turns), ~16-20 min PER 300-word chunk → tripped
        // the kill. Restricting --allowedTools to a single 'Write' forces it to emit the CSV in ONE shot
        // (~1-3 min). --model sonnet keeps each token fast; --strict-mcp-config loads zero MCP servers.
        const mkArgs = (instr) => ['-p', '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'acceptEdits',
          '--strict-mcp-config', '--allowedTools', 'Write',
          '--exclude-dynamic-system-prompt-sections',
          '--append-system-prompt', chatSystemPrompt(sp), '--add-dir', ROOT, '--', instr];
        const sceneDir = path.join(folder, '03-scenes');
        const mainCsv = path.join(sceneDir, 'scene-list.csv');
        const appendCsv = path.join(sceneDir, 'scene-list.append.csv');
        // Fold the continuation's append-file into the main CSV server-side, so existing voiced rows are
        // preserved byte-for-byte (the model never rewrites them). Returns rows added.
        const foldAppend = () => {
          if (!fs.existsSync(appendCsv)) return 0;
          const add = fs.readFileSync(appendCsv, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !/^\s*scene\s*,/i.test(l));
          try { fs.unlinkSync(appendCsv); } catch (_) {}
          if (!add.length) return 0;
          const cur = fs.existsSync(mainCsv) ? fs.readFileSync(mainCsv, 'utf8').replace(/\s+$/, '') : COLS;
          fs.writeFileSync(mainCsv, cur + '\n' + add.join('\n') + '\n');
          return add.length;
        };
        let lastTotal = 0;
        const importNow = () => {
          const out = importScenesCsv(folder);
          if (!out.scenes.length) throw new Error('no scenes parsed from the CSV');
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.stages.scenes = live.stages.scenes || {};
          const prevScenes = ((live.stages.scenes.candidates || {}).scenes) || [];
          live.stages.scenes.candidates = { scenes: mergeScenes(prevScenes, out.scenes), totalSeconds: out.totalSeconds };
          live.stages.scenes.status = 'awaiting-human';
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
          lastTotal = out.totalSeconds;
        };
        const coverage = () => {
          let cur = []; try { cur = ((JSON.parse(fs.readFileSync(sp, 'utf8')).stages.scenes || {}).candidates || {}).scenes || []; } catch (_) {}
          const w = cur.reduce((a, s) => a + (String(s.narration || '').match(/[\w’'-]+/g) || []).length, 0);
          const maxN = cur.reduce((m, s) => Math.max(m, +s.n || 0), 0);
          const last = (cur.find((s) => (+s.n || 0) === maxN) || {}).narration || '';
          return { count: cur.length, ratio: scriptWords ? w / scriptWords : 1, maxN, last };
        };
        // Publish a live snapshot the client can poll for a determinate progress bar.
        const pushProg = (phase, pass, passes) => { const c = coverage(); scenesProgress.set(key, { phase, beats: c.count, coverage: Math.min(1, c.ratio), pass: pass || 0, passes: passes || 0, ts: Date.now() }); };
        try { fs.unlinkSync(appendCsv); } catch (_) {}   // clear any stale append file
        const SGLOG = path.join(__dirname, 'scenegen.log');
        const sglog = (m) => { try { fs.appendFileSync(SGLOG, new Date().toISOString() + ' ' + key + ' ' + m + '\n'); } catch (_) {} };
        let reply = '', isError = false;
        const MAX_PASSES = 14;
        try {
          // BOUNDED, DURABLE CHUNKING — replaces the old monolithic 15-min "storyboard the ENTIRE script"
          // call that wrote the whole CSV in one final Write. When Max-plan serialization slowed that past
          // the cap it was SIGKILLed having written NOTHING (observed: code=-2, csvLines=1, all work lost).
          // Now the script is storyboarded in ~CHUNK_WORDS-word passages: each pass finishes well within its
          // 9-min cap and is folded+imported immediately, so a kill loses at most one chunk and a re-click
          // resumes from the last saved beat. A partial VOICED build resumes the same way (scene numbers
          // are stable, so asset carry-over via mergeScenes is preserved).
          if (force) {
            try { fs.unlinkSync(mainCsv); } catch (_) {}
            try { const lv = JSON.parse(fs.readFileSync(sp, 'utf8')); if (lv.stages.scenes) { lv.stages.scenes.candidates = { scenes: [], totalSeconds: 0 }; fs.writeFileSync(sp, JSON.stringify(lv, null, 2)); } } catch (_) {}
          }
          sglog('START words=' + scriptWords + ' chunkWords=' + CHUNK_WORDS + ' force=' + !!force);
          let guard = 0, cov = coverage(), stale = 0, lastBeats = cov.count;
          pushProg(cov.count ? 'continue' : 'full', 0, MAX_PASSES);
          while (guard < MAX_PASSES) {
            const rem = cov.count ? remainingAfter(cov.last) : cleanScript;
            if (!rem || cov.ratio >= 0.97) break;
            const nc = nextChunk(rem);
            if (!nc.chunk) break;
            guard++;
            const fresh = cov.count === 0;
            pushProg(fresh ? 'full' : 'continue', guard, MAX_PASSES);
            // MAX_THINKING_TOKENS cap: the storyboard pass was spending ~14 min of extended THINKING on
            // the dense prompt (5s trivial call vs 14min task; not model/throttle/tools/prompt-size). A
            // tight thinking budget forces it to just emit the CSV — the suspected real fix.
            const r = await runClaude(mkArgs(fresh ? seedInstr(nc.chunk, nc.final) : continueInstr(cov.maxN, cov.last, nc.chunk, nc.final)), 20 * 60 * 1000, { MAX_THINKING_TOKENS: '1024' });
            const added = fresh ? 0 : foldAppend();
            let csvLines = 0; try { csvLines = fs.readFileSync(mainCsv, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length; } catch (_) {}
            try { importNow(); } catch (e) { sglog('pass#' + guard + ' import-fail ' + e.message); }
            cov = coverage();
            sglog('pass#' + guard + ' ' + (fresh ? 'seed' : 'cont') + ' final=' + nc.final + ' remChars=' + rem.length + ' code=' + r.code + ' csvLines=' + csvLines + ' added=' + added + ' beats=' + cov.count + ' cov=' + Math.round(cov.ratio * 100) + '% err=' + String(r.err || '').slice(-140).replace(/\s+/g, ' '));
            if (cov.count <= lastBeats) stale++; else stale = 0;
            lastBeats = cov.count;
            pushProg('continue', guard, MAX_PASSES);
            if (stale >= 2) { sglog('stalled (no new beats x2) — stop'); break; }
          }
          const f = coverage();
          pushProg('done', guard, MAX_PASSES);
          reply = 'Built ' + f.count + ' scenes (~' + Math.round(lastTotal / 60) + ' min, ' + Math.round(f.ratio * 100) + '% coverage)' + (f.ratio < 0.92 ? ' — click Generate once more to finish the rest.' : '.');
          if (f.count === 0 || f.ratio < 0.5) isError = true;
          sglog('DONE beats=' + f.count + ' cov=' + Math.round(f.ratio * 100) + '% passes=' + guard + ' isError=' + isError);
        } catch (e) { reply = 'Scene generation problem: ' + String(e && e.message || e); isError = true; sglog('THROW ' + String(e && e.message || e)); }
        send(res, 200, JSON.stringify({ reply, isError }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
      finally { generatingScenes.delete(key); setTimeout(() => scenesProgress.delete(key), 15000); }
    });
    return;
  }
  // --- Live progress for an in-flight scene-gen job (determinate bar) ---
  if (pathname === '/api/generate-scenes/progress' && req.method === 'GET') {
    const k = query.channel + '|' + query.id;
    return send(res, 200, JSON.stringify({ running: generatingScenes.has(k), progress: scenesProgress.get(k) || null }));
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

  // --- Recover a script written to 02-script/script.md back into studio.json (no Claude needed).
  //     The headless script generator sometimes writes script.md but dies before it syncs
  //     studio.json (Max-plan inference starvation kills the job mid-run) — leaving the Studio
  //     showing "no script" even though the full draft is sitting on disk. This re-imports the
  //     on-disk markdown so a killed job can never lose the script. Mirrors /api/import-scenes. ---
  if (pathname === '/api/import-script' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const folder = path.dirname(sp);
        const mdPath = path.join(folder, '02-script', 'script.md');
        if (!fs.existsSync(mdPath)) return send(res, 400, JSON.stringify({ error: 'no 02-script/script.md on disk' }));
        const md = fs.readFileSync(mdPath, 'utf8');
        // Prefer the body between the generator's markers; fall back to the whole file.
        const m = md.match(/<!--SCRIPT-START-->([\s\S]*?)<!--SCRIPT-END-->/);
        const script = (m ? m[1] : md).trim();
        // Spoken-word count: strip [directions], <stubs>, and `code` (same rule as lengthPlan/scene-gen).
        const words = (script.replace(/\[[^\]]*\]/g, ' ').replace(/<[^>]*>/g, ' ').replace(/`[^`]*`/g, ' ').match(/[\w’'-]+/g) || []).length;
        if (!script || words < 50) return send(res, 400, JSON.stringify({ error: 'script.md is empty or still the blank template (' + words + ' words)' }));
        const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
        live.stages.script = live.stages.script || {};
        const prev = live.stages.script.candidates || {};
        // Preserve any structured fields a prior sync set (sources, opening, thumbnailPrompt).
        live.stages.script.candidates = Object.assign({}, prev, { script, words });
        live.stages.script.status = 'awaiting-human';
        live.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        send(res, 200, JSON.stringify({ ok: true, words }));
      } catch (e) { send(res, 400, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Which jobs are currently running for this video? ---
  if (pathname === '/api/status' && req.method === 'GET') {
    const k = query.channel + '|' + query.id;
    const flags = {
      ideas: generatingIdeas.has(k), packaging: generatingPackaging.has(k), script: generatingScripts.has(k),
      research: generatingResearch.has(k), scenes: generatingScenes.has(k),
      images: generatingImages.has(k) || generatingImages.has('lockcast|' + query.channel),
      narration: generatingNarration.has(k), shorts: generatingShorts.has(k),
    };
    // Build a human label (+ live counts) for whatever is running, so the Studio can show real
    // progress instead of a static screen. Only touches disk when something is actually running.
    const FRIENDLY = { ideas: 'Brainstorming ideas', packaging: 'Writing titles', script: 'Researching + writing the script', research: 'Deep research', scenes: 'Building the scene list', images: 'Generating images', narration: 'Voicing narration', shorts: 'Finding Shorts' };
    const tasks = [];
    let total = 0, folder = null;
    if (flags.images || flags.narration || flags.scenes) {
      try { const sp2 = studioPath(query.channel, query.id); folder = sp2 && path.dirname(sp2);
        const doc2 = JSON.parse(fs.readFileSync(sp2, 'utf8'));
        total = ((((doc2.stages || {}).scenes || {}).candidates || {}).scenes || []).length; } catch (_) {}
    }
    const countDir = (sub, rx) => { try { return fs.readdirSync(path.join(folder, sub)).filter((f) => rx.test(f)).length; } catch (_) { return 0; } };
    if (flags.scenes) { const p = scenesProgress.get(k); tasks.push({ task: 'scenes', label: FRIENDLY.scenes + (p && p.coverage ? ' (' + Math.round(p.coverage * 100) + '%)' : (total ? ' (' + total + ' beats)' : '')) }); }
    if (flags.images) { const d = folder ? countDir(path.join('04-assets', 'images'), /\.png$/i) : 0; tasks.push({ task: 'images', label: FRIENDLY.images + (total ? ' (' + d + '/' + total + ')' : ''), done: d, total }); }
    if (flags.narration) { const d = folder ? countDir(path.join('04-assets', 'audio'), /\.(mp3|wav|m4a)$/i) : 0; tasks.push({ task: 'narration', label: FRIENDLY.narration + (total ? ' (' + d + '/' + total + ')' : ''), done: d, total }); }
    for (const key2 of ['ideas', 'packaging', 'script', 'research', 'shorts']) if (flags[key2]) tasks.push({ task: key2, label: FRIENDLY[key2] });
    return send(res, 200, JSON.stringify(Object.assign(flags, { busy: tasks.length > 0, label: tasks.map((t) => t.label).join('  ·  '), tasks })));
  }

  // --- Gemini API key (stored locally only) ---
  if (pathname === '/api/key-status' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ hasKey: !!getGeminiKey(), veoEnabled: getVeoEnabled() }));
  }
  // Toggle Veo image→video on/off (off by default). Off = the 🎬 Animate button is hidden + the endpoint refuses.
  if (pathname === '/api/veo-enable' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { const on = !!JSON.parse(body || '{}').on; writeSecrets({ veoEnabled: on }); send(res, 200, JSON.stringify({ ok: true, veoEnabled: on })); }
      catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
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
  // --- Pexels key (for real-artifact photo cutaways) — stored locally like the others ---
  if (pathname === '/api/pexels-key-status' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ hasKey: !!getPexelsKey() }));
  }
  if (pathname === '/api/pexels-key' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const k = (JSON.parse(body || '{}').key || '').trim();
        if (!k) return send(res, 400, JSON.stringify({ error: 'empty key' }));
        writeSecrets({ pexelsKey: k });
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

  // --- Caption style: read / write the per-channel caption look + serve fonts to the preview ---
  if (pathname === '/api/caption-style' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    return send(res, 200, JSON.stringify({ style: readCaptionStyle(query.channel), fonts: Object.keys(CAPTION_FONT_FILES).map((k) => ({ key: k, label: CAPTION_FONT_LABELS[k] })) }));
  }
  if (pathname === '/api/caption-style' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const o = JSON.parse(body || '{}'); const cur = readCaptionStyle(query.channel);
        const hex = (v) => /^#[0-9a-fA-F]{3,8}$/.test(String(v || ''));
        const clean = {
          font: CAPTION_FONT_FILES[o.font] ? o.font : cur.font,
          color: hex(o.color) ? o.color : cur.color,
          accent: hex(o.accent) ? o.accent : cur.accent,
          size: Math.max(28, Math.min(96, parseInt(o.size, 10) || cur.size)),
          case: ['as-is', 'upper', 'lower', 'sentence'].includes(o.case) ? o.case : cur.case,
          treatment: ['shadow', 'outline', 'plate'].includes(o.treatment) ? o.treatment : cur.treatment,
          tilt: typeof o.tilt === 'boolean' ? o.tilt : cur.tilt,
        };
        fs.mkdirSync(path.dirname(captionStylePath(query.channel)), { recursive: true });
        fs.writeFileSync(captionStylePath(query.channel), JSON.stringify(clean, null, 2));
        send(res, 200, JSON.stringify({ ok: true, style: clean }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  if (pathname === '/api/font' && req.method === 'GET') {
    const f = CAPTION_FONT_FILES[query.name];
    const fp = f && path.join(RENDER_DIR, 'fonts', f);
    if (!fp || !fs.existsSync(fp)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400' });
    return res.end(fs.readFileSync(fp));
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
    const page = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>YouTube · YouTube Studio</title><body style="font-family:system-ui,sans-serif;background:#17120d;color:#f3ece0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:460px;padding:24px;line-height:1.5">' + msg + '</div></body>'); };
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

  // --- ANALYTICS pull: per-video metrics + retention curve + traffic from the YouTube Analytics API →
  //     <channel>/_analytics/cache/<videoId>.json, plus a daily channel snapshot → stats-history.json.
  //     Scope already granted; reads serve from cache so the dashboard never hits the API on render. ---
  if (pathname === '/api/analytics/refresh' && req.method === 'GET') {
    (async () => {
      try {
        if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
        const token = await ytAccessToken(query.channel);
        const today = new Date().toISOString().slice(0, 10);
        // 1) channel stats (Data API) → youtube.json
        const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: 'Bearer ' + token } });
        const ch = ((await cr.json()).items || [])[0] || {};
        const yt = readYT(query.channel) || {};
        yt.channelTitle = (ch.snippet && ch.snippet.title) || yt.channelTitle;
        yt.subs = (ch.statistics && ch.statistics.subscriberCount) || yt.subs;
        yt.views = (ch.statistics && ch.statistics.viewCount) || yt.views;
        yt.statsAt = today;
        fs.writeFileSync(ytFile(query.channel), JSON.stringify(yt, null, 2));
        // 2) per-video analytics → cache (four small reports each; separate calls avoid invalid combos)
        const cacheDir = path.join(ROOT, query.channel, '_analytics', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        // Reconcile against the channel's REAL uploads (Data API), not just Studio-uploaded videos.
        // Side effect: binds matched videoIds back into each studio.json. Falls back to local-only on error.
        let reconcile = { published: publishedVideos(query.channel), report: { matched: [], orphans: [], alreadyBound: [], reconcileError: null } };
        try { reconcile = await reconcileUploads(query.channel, token); }
        catch (e) { reconcile.report = { matched: [], orphans: [], alreadyBound: [], reconcileError: String(e.message || e) }; }
        const pv = reconcile.published;
        // enrich accurate publish dates (the upload flow doesn't always store uploadedAt) in one Data-API call
        const pubMap = {};
        try {
          if (pv.length) { const vr = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + pv.map((v) => v.videoId).join(',') + '&maxResults=50', { headers: { Authorization: 'Bearer ' + token } }); ((await vr.json()).items || []).forEach((it) => { pubMap[it.id] = String((it.snippet && it.snippet.publishedAt) || '').slice(0, 10); }); }
        } catch (_) {}
        const summary = [];
        for (const v of pv) {
          const uploaded = pubMap[v.videoId] || v.uploadedAt;   // accurate publish date (for display/cadence)
          // Query a WIDE lifetime window — a publish-date-tight start misses all data on a very-new video
          // (the Analytics API's last ~2-3 days aren't processed yet, so a 2-day range returns empty rows).
          const vf = 'video==' + v.videoId, range = { startDate: '2020-01-01', endDate: today };
          let prev = {}; try { prev = JSON.parse(fs.readFileSync(path.join(cacheDir, v.videoId + '.json'), 'utf8')); } catch (_) {}
          const out = { videoId: v.videoId, id: v.id, orphan: !!v.orphan, title: v.title, uploadedAt: uploaded, fetchedAt: today };
          try { Object.assign(out, rowObj(await ytAnalytics(token, Object.assign({ metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost', filters: vf }, range)))); }
          catch (e) { out.coreError = String(e.message || e); }
          out.ctr = (typeof prev.ctr === 'number') ? prev.ctr : null;   // CTR isn't in the public Analytics API → operator-entered; preserved across re-pulls
          try { const ret = await ytAnalytics(token, Object.assign({ dimensions: 'elapsedVideoTimeRatio', metrics: 'audienceWatchRatio,relativeRetentionPerformance', filters: vf }, range)); out.retention = (ret.rows || []).map((r) => ({ t: r[0], watch: r[1], rel: r[2] })); }
          catch (e) { out.retentionError = String(e.message || e); }
          try { const tr = await ytAnalytics(token, Object.assign({ dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched', filters: vf, sort: '-views' }, range)); out.traffic = (tr.rows || []).map((r) => ({ source: r[0], views: r[1], minutes: r[2] })); }
          catch (e) { out.trafficError = String(e.message || e); }
          fs.writeFileSync(path.join(cacheDir, v.videoId + '.json'), JSON.stringify(out, null, 2));
          summary.push({ videoId: v.videoId, views: out.views, ctr: out.ctr, avgPct: out.averageViewPercentage, retentionPts: (out.retention || []).length, errors: ['coreError', 'retentionError', 'trafficError'].filter((k) => out[k]) });
        }
        // 3) channel daily snapshot store (backfill last 365d + append today's totals)
        const histFile = path.join(ROOT, query.channel, '_analytics', 'stats-history.json');
        let hist; try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch (_) { hist = {}; }
        hist.daily = hist.daily || []; hist.snapshots = hist.snapshots || [];
        try {
          const start365 = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
          const daily = await ytAnalytics(token, { startDate: start365, endDate: today, dimensions: 'day', metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost', sort: 'day' });
          hist.daily = (daily.rows || []).map((r) => ({ date: r[0], views: r[1], minutes: r[2], subsGained: r[3], subsLost: r[4] }));
          delete hist.dailyError;
        } catch (e) { hist.dailyError = String(e.message || e); }
        hist.snapshots = hist.snapshots.filter((s) => s.date !== today);
        hist.snapshots.push({ date: today, subs: Number(yt.subs) || 0, totalViews: Number(yt.views) || 0 });
        fs.mkdirSync(path.dirname(histFile), { recursive: true });
        fs.writeFileSync(histFile, JSON.stringify(hist, null, 2));
        send(res, 200, JSON.stringify({ ok: true, channel: query.channel, channelTitle: yt.channelTitle, subs: yt.subs, videos: summary, reconcile: reconcile.report, dailyPoints: hist.daily.length, dailyError: hist.dailyError }));
      } catch (e) { send(res, 200, JSON.stringify({ error: String(e && e.message || e) })); }
    })();
    return;
  }
  // --- ANALYTICS read (serves from cache; never hits the API) ---
  if (pathname === '/api/analytics' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const aDir = path.join(ROOT, query.channel, '_analytics'), cacheDir = path.join(aDir, 'cache');
    const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
    if (query.id) {
      const doc = rj(studioPath(query.channel, query.id) || '');
      const vid = doc && doc.youtube && doc.youtube.videoId;
      return send(res, 200, JSON.stringify({ video: vid ? rj(path.join(cacheDir, vid + '.json')) : null }));
    }
    let videos = []; try { videos = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => rj(path.join(cacheDir, f))).filter(Boolean); } catch (_) {}
    return send(res, 200, JSON.stringify({ history: rj(path.join(aDir, 'stats-history.json')), videos }));
  }
  // --- Operator-entered CTR (impressions-CTR isn't in the public Analytics API) → stored on the cache ---
  if (pathname === '/api/analytics/ctr' && req.method === 'POST') {
    if (!safeSeg(query.channel) || !safeSeg(query.id)) return send(res, 400, JSON.stringify({ error: 'bad channel/id' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const ctr = Number(JSON.parse(body || '{}').ctr);
        const doc = JSON.parse(fs.readFileSync(studioPath(query.channel, query.id), 'utf8'));
        const vid = doc.youtube && doc.youtube.videoId;
        if (!vid) return send(res, 404, JSON.stringify({ error: 'video not published yet' }));
        const cf = path.join(ROOT, query.channel, '_analytics', 'cache', vid + '.json');
        let ca = {}; try { ca = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch (_) { ca = { videoId: vid, id: query.id }; }
        ca.ctr = isFinite(ctr) ? ctr : null;
        fs.mkdirSync(path.dirname(cf), { recursive: true }); fs.writeFileSync(cf, JSON.stringify(ca, null, 2));
        send(res, 200, JSON.stringify({ ok: true, ctr: ca.ctr }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  // --- PULSE: the dashboard aggregator. Reads ONLY from disk caches (never hits the API on render). ---
  if (pathname === '/api/pulse' && req.method === 'GET') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
      const inRange = (daily, from, to) => (daily || []).filter((d) => d.date >= from && (!to || d.date < to));
      const sum = (rows, k) => rows.reduce((a, d) => a + (+d[k] || 0), 0);
      const med = (arr) => { const a = arr.filter((x) => typeof x === 'number').sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
      const STAGE_ORDER = ['idea', 'packaging', 'script', 'scenes', 'qc', 'shorts'];
      const GATE = { idea: 'Pick idea', packaging: 'Pick title/thumbnail', script: 'Approve script', scenes: 'Review scenes', qc: 'QC', shorts: 'Shorts' };
      const vids = listVideos(), usage = readUsage();
      const out = { generatedAt: new Date().toISOString(), channels: [], gateQueue: [], spend: {}, alerts: [] };
      const A = (sev, icon, text, extra) => out.alerts.push(Object.assign({ sev, icon, text }, extra || {}));

      const perVid = Object.entries(usage).map(([k, v]) => ({ key: k, usd: +(((v.images || 0) * PRICE_PER_IMAGE) + ((v.imagesPro || 0) * PRICE_PER_IMAGE_PRO)).toFixed(2), at: v.updatedAt }));
      const monthPrefix = today.slice(0, 7);
      out.spend = { monthUsd: +perVid.filter((x) => String(x.at || '').slice(0, 7) === monthPrefix).reduce((a, x) => a + x.usd, 0).toFixed(2), perVideoAvg: perVid.length ? +(perVid.reduce((a, x) => a + x.usd, 0) / perVid.length).toFixed(2) : 0, runaway: perVid.filter((x) => x.usd > 8) };
      out.spend.runaway.forEach((rv) => A('warn', '💸', 'Runaway spend: ' + rv.key + ' $' + rv.usd));

      for (const c of listChannels()) {
        const yt = readYT(c.id) || {}, connected = !!yt.refreshToken;
        const aDir = path.join(ROOT, c.id, '_analytics');
        let hist = {}; try { hist = JSON.parse(fs.readFileSync(path.join(aDir, 'stats-history.json'), 'utf8')); } catch (_) {}
        const daily = hist.daily || [];
        let caches = []; try { caches = fs.readdirSync(path.join(aDir, 'cache')).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(aDir, 'cache', f), 'utf8')); } catch (_) { return null; } }).filter(Boolean); } catch (_) {}
        const subs = Number(yt.subs) || 0;
        const views28 = sum(inRange(daily, daysAgo(28)), 'views'), viewsPrev28 = sum(inRange(daily, daysAgo(56), daysAgo(28)), 'views');
        const watchHrs28 = +(sum(inRange(daily, daysAgo(28)), 'minutes') / 60).toFixed(1);
        const watchHrs12mo = +(sum(inRange(daily, daysAgo(365)), 'minutes') / 60).toFixed(1);
        const subsGained28 = sum(inRange(daily, daysAgo(28)), 'subsGained') - sum(inRange(daily, daysAgo(28)), 'subsLost');
        const mine = vids.filter((v) => v.channel === c.id);
        const pipeline = {}; STAGE_ORDER.forEach((s) => { pipeline[s] = mine.filter((v) => (v.stages || {})[s]).length; });
        const medViews = med(caches.map((x) => x.views)), medAvg = med(caches.map((x) => x.averageViewPercentage));
        const recent = caches.slice().sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))).slice(0, 5).map((x) => ({ id: x.id, videoId: x.videoId, title: x.title, uploadedAt: x.uploadedAt, views: x.views, avgPct: x.averageViewPercentage, ctr: x.ctr, vsViews: (typeof x.views === 'number' && medViews) ? (x.views >= medViews ? 'up' : 'down') : null, vsAvg: (typeof x.averageViewPercentage === 'number' && medAvg) ? (x.averageViewPercentage >= medAvg ? 'up' : 'down') : null }));
        const ups = caches.map((x) => x.uploadedAt).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();   // cadence = PUBLISHED upload dates only
        const last = ups[0] || null, daysSince = last ? Math.round((Date.parse(today) - Date.parse(last)) / 864e5) : null;

        out.channels.push({
          id: c.id, name: c.name, connected, statsAt: yt.statsAt || null,
          vitals: { subs, totalViews: Number(yt.views) || 0, views28, views28Delta: views28 - viewsPrev28, watchHrs28, subsGained28 },
          ypp: { subs: { cur: subs, mid: 500, goal: 1000 }, watchHours: { cur: watchHrs12mo, goal: 4000 } },
          cadence: { up7: ups.filter((d) => d >= daysAgo(7)).length, up28: ups.filter((d) => d >= daysAgo(28)).length, daysSinceLast: daysSince, lastUpload: last, target: 1 },
          pipeline, recent, medians: { views: medViews, avgPct: medAvg },
          quadrant: caches.filter((x) => typeof x.averageViewPercentage === 'number').map((x) => ({ id: x.id, title: x.title, avgPct: x.averageViewPercentage, ctr: x.ctr, views: x.views })),
          trend: inRange(daily, daysAgo(60)).map((d) => +d.views || 0),   // last 60d daily views (trajectory sparkline)
          sponsorPct: Math.min(100, Math.round((subs / 50000) * 100)),     // toward the ~50k sponsor threshold
        });

        mine.forEach((v) => { const g = STAGE_ORDER.find((s) => (v.stages || {})[s] === 'awaiting-human'); if (g) out.gateQueue.push({ channel: c.id, channelName: c.name, id: v.id, title: v.title, gate: GATE[g], stage: g }); });

        if (!connected) { A('warn', '🔌', c.name + ': not connected to YouTube'); }
        else {
          if (subs >= 1000) A('good', '🎯', c.name + ': 1,000 subs — ad-revenue YPP gate hit');
          else if (subs >= 500) A('good', '🎯', c.name + ': ' + subs + ' subs — past the 500 fan-funding gate');
          else if (subs / 1000 >= 0.8) A('good', '🎯', c.name + ': ' + subs + '/1000 subs');
          if (yt.statsAt && yt.statsAt < daysAgo(2)) A('warn', '🔌', c.name + ': analytics ' + yt.statsAt + ' (stale — refresh)');
        }
        if (daysSince != null && daysSince > 13) A('warn', '⏳', c.name + ': ' + daysSince + ' days since last upload');
        mine.forEach((v) => { const g = STAGE_ORDER.find((s) => (v.stages || {})[s] === 'awaiting-human'); const stale = v.updatedAt && (Date.parse(today) - Date.parse(v.updatedAt)) / 864e5 > 10; if (g && stale) A('warn', '⏳', c.name + ' "' + String(v.title).slice(0, 28) + '" stalled at ' + g); });
        caches.forEach((x) => { if (typeof x.averageViewPercentage === 'number' && x.averageViewPercentage < 35 && (x.views || 0) >= 50) A('bad', '📉', c.name + ' "' + String(x.title).slice(0, 24) + '": ' + Math.round(x.averageViewPercentage) + '% avg viewed (low)'); });
      }
      return send(res, 200, JSON.stringify(out));
    } catch (e) { return send(res, 200, JSON.stringify({ error: String(e && e.message || e) })); }
  }
  // --- COACH: the suggestion engine output for a channel (suggestions + the 5-video one-fix) ---
  if (pathname === '/api/coach' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    return send(res, 200, JSON.stringify(buildCoach(query.channel)));
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
      if (!description.trim()) description = title + '\n\n' + channelBlurb(query.channel);
      let tags = []; try { const kit = fs.readFileSync(path.join(folder, '07-publish', 'publish-kit.md'), 'utf8'); const m = kit.match(/##\s*Tags\s*\n([^\n]+)/i); if (m) tags = m[1].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 15); } catch (_) {}
      uploadingYT.add(k); ytUploadStatus[k] = { state: 'starting', pct: 0 };
      send(res, 200, JSON.stringify({ started: true }));
      (async () => {
        try {
          const token = await ytAccessToken(query.channel);
          const total = fs.statSync(video).size;
          const meta = { snippet: { title: ytSafeText(title), description: ytSafeText(description).slice(0, 4900), tags, categoryId: '27', defaultLanguage: 'en', defaultAudioLanguage: 'en' }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true } };
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
          // Prefer the operator's hand-picked/edited thumbnail (00-packaging/thumbnail.png); fall back to generated art.
          const thumb = [path.join(folder, '00-packaging', 'thumbnail.png'), path.join(folder, '00-packaging', 'thumbnails', 'final-1.png')].find((f) => fs.existsSync(f));
          if (thumb) {
            try {
              const tbytes = thumbUnderLimit(thumb);   // auto-shrink to stay under YouTube's 2MB cap (else 413)
              const tr = await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + videoId, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/png' }, body: tbytes });
              if (tr.ok) note = ' Thumbnail set.';
              else note = ' Thumbnail not set (' + tr.status + ': ' + (await tr.text()).slice(0, 120) + ').';
            } catch (e) { note = ' Thumbnail upload skipped (' + String(e && e.message || e).slice(0, 80) + ').'; }
          }
          // English subtitles: build the .srt from the beat timeline + upload as a caption track (best-effort)
          ytUploadStatus[k] = { state: 'captions', pct: 100, videoId };
          try {
            const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
            const cap = buildSrt(scenes);
            if (cap.cues) {
              try { fs.mkdirSync(path.join(folder, '07-publish'), { recursive: true }); fs.writeFileSync(path.join(folder, '07-publish', 'subtitles.en.srt'), cap.srt); } catch (_) {}
              await ytUpsertCaption(token, videoId, cap.srt, 'en', 'English');
              note += ' ' + cap.cues + ' subtitle cues uploaded.';
            }
          } catch (e) { note += ' Subtitles skipped (' + String(e && e.message || e).slice(0, 80) + ').'; }
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
  // --- Batch-upload this video's rendered Shorts (05-edit/shorts/<file>.mp4) to YouTube as private/etc.
  //     Each clip uses its chosenTitle + postCaption + a funnel link to the full video + #Shorts. Detached,
  //     resume-safe (skips clips already uploaded), and records clip.youtube back into studio.json. ---
  if (pathname === '/api/youtube/upload-shorts' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const k = query.channel + '|' + query.id;
      if (uploadingShorts.has(k)) return send(res, 200, JSON.stringify({ running: true, reply: 'Already uploading Shorts — watch the progress.' }));
      let opts = {}; try { opts = JSON.parse(body || '{}'); } catch (_) {}
      const privacy = ['private', 'unlisted', 'public'].includes(opts.privacy) ? opts.privacy : 'private';
      const force = !!opts.force;
      const yt = readYT(query.channel);
      if (!yt || !yt.refreshToken) return send(res, 400, JSON.stringify({ error: 'Connect this channel to YouTube first (the 📺 button).' }));
      const folder = path.dirname(sp);
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const clips = (((doc.stages || {}).shorts || {}).candidates || {}).clips || [];
      const decTitles = ((((doc.stages || {}).shorts || {}).decision) || {}).titles || {};   // the human's per-clip title picks
      const titleFor = (c) => decTitles[c.id] || c.chosenTitle || c.title;
      const shortsDir = path.join(folder, '05-edit', 'shorts');
      const onlyIds = Array.isArray(opts.clipIds) && opts.clipIds.length ? new Set(opts.clipIds) : null;
      const mainUrl = (doc.youtube && doc.youtube.videoId) ? ('https://youtu.be/' + doc.youtube.videoId) : '';
      const longPrivate = !doc.youtube || !doc.youtube.videoId || (doc.youtube.privacy && doc.youtube.privacy !== 'public');
      const targets = clips.filter((c) => (!onlyIds || onlyIds.has(c.id)) && titleFor(c) && c.file
        && fs.existsSync(path.join(shortsDir, c.file + '.mp4')) && (force || !(c.youtube && c.youtube.videoId)));
      if (!targets.length) return send(res, 200, JSON.stringify({ reply: 'No Shorts to upload (none with a chosen title + rendered file, or all already uploaded).', isError: false, total: 0 }));
      uploadingShorts.add(k); shortsUploadStatus[k] = { state: 'starting', total: targets.length, done: 0, results: [] };
      send(res, 200, JSON.stringify({ started: true, total: targets.length }));
      (async () => {
        const st = shortsUploadStatus[k];
        try {
          const token = await ytAccessToken(query.channel);   // one fresh token for the whole batch
          for (const c of targets) {
            const title = String(titleFor(c)).slice(0, 100);
            st.state = 'uploading'; st.current = title;
            try {
              const file = path.join(shortsDir, c.file + '.mp4');
              let desc = String(c.postCaption || '').trim();
              if (mainUrl) desc += (desc ? '\n\n' : '') + 'Full video → ' + mainUrl;
              desc += '\n\n#Shorts';
              const tags = ((String(c.postCaption || '').match(/#(\w+)/g) || []).map((t) => t.slice(1))).concat('Shorts').slice(0, 15);
              const meta = { snippet: { title: ytSafeText(title), description: ytSafeText(desc).slice(0, 4900), tags, categoryId: '27', defaultLanguage: 'en', defaultAudioLanguage: 'en' }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true } };
              const videoId = await ytResumableUpload(token, file, meta);
              await withFileLock(sp, () => {
                const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
                const lc = (((live.stages || {}).shorts || {}).candidates || {}).clips || [];
                const target = lc.find((x) => x.id === c.id);
                if (target) { target.youtube = { videoId, url: 'https://youtu.be/' + videoId, title, privacy, uploadedAt: new Date().toISOString() }; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
              });
              st.results.push({ clipId: c.id, title, videoId, url: 'https://youtu.be/' + videoId });
            } catch (e) {
              const msg = String(e && e.message || e);
              st.results.push({ clipId: c.id, title, error: msg });
              if (/quota|quotaExceeded|403/i.test(msg)) { st.quotaHit = true; st.done++; break; }   // out of daily quota → stop, the rest resume later
            }
            st.done++;
          }
          st.state = 'done';
          if (longPrivate) st.warn = 'The long video is private or missing — these Shorts will not funnel until you publish it and run Sync funnel.';
        } catch (e) { st.state = 'error'; st.error = String(e && e.message || e); }
        finally { uploadingShorts.delete(k); }
      })();
    });
    return;
  }
  if (pathname === '/api/youtube/upload-shorts-status' && req.method === 'GET') {
    const k = query.channel + '|' + query.id;
    return send(res, 200, JSON.stringify(Object.assign({ running: uploadingShorts.has(k) }, shortsUploadStatus[k] || { state: 'idle' })));
  }
  // --- Channel-wide funnel sync: rewrite EVERY published Short's description link to its own parent long
  //     video's correct live URL; flag private/dead/missing destinations; post the funnel comment if force-ssl
  //     is granted; write a Studio checklist. Detached + status-polled. Outward writes to YouTube. ---
  if (pathname === '/api/youtube/sync-shorts-funnel' && req.method === 'POST') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const ch = query.channel;
    if (syncingFunnel.has(ch)) return send(res, 200, JSON.stringify({ running: true, reply: 'Funnel sync already running.' }));
    const yt = readYT(ch);
    if (!yt || !yt.refreshToken) return send(res, 400, JSON.stringify({ error: 'Connect this channel to YouTube first (the 📺 button).' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let opts = {}; try { opts = JSON.parse(body || '{}'); } catch (_) {}
      const onlyIds = Array.isArray(opts.ids) && opts.ids.length ? new Set(opts.ids) : null;
      syncingFunnel.add(ch);
      funnelSyncStatus[ch] = { state: 'starting', total: 0, done: 0, videos: [], fixed: 0, flagged: 0 };
      send(res, 200, JSON.stringify({ started: true }));
      (async () => {
        const st = funnelSyncStatus[ch];
        const checklistLines = ['# Shorts funnel checklist — ' + ch, '', 'Studio-only steps the API cannot do. Per Short: set the **Related video** and **pin** the comment.', ''];
        try {
          const token = await ytAccessToken(ch);
          const base = path.join(ROOT, ch);
          const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d/.test(d.name)).map((d) => d.name).sort();
          // count work first
          const work = [];
          for (const d of dirs) {
            if (onlyIds && !onlyIds.has(d)) continue;
            let doc; try { doc = JSON.parse(fs.readFileSync(path.join(base, d, 'studio.json'), 'utf8')); } catch (_) { continue; }
            const clips = (((doc.stages || {}).shorts || {}).candidates || {}).clips || [];
            const published = clips.filter((c) => c.youtube && c.youtube.videoId);
            if (published.length) work.push({ id: d, doc, published });
          }
          st.total = work.reduce((a, w) => a + w.published.length, 0);
          for (const w of work) {
            const longId = w.doc.youtube && w.doc.youtube.videoId;
            const vrec = { id: w.id, longId: longId || null, privateDestination: false, fixed: 0, ok: 0, dead: 0, comment: 0, note: '' };
            if (!longId) { vrec.note = 'no long video — skipped'; st.videos.push(vrec); st.done += w.published.length; continue; }
            const longUrl = 'https://youtu.be/' + longId;
            const longTitle = (w.doc.youtube.title || w.id);
            const livePriv = await ytVideoPrivacy(token, longId);   // accurate live privacy, not the (possibly stale/absent) stored value
            vrec.privateDestination = livePriv ? (livePriv !== 'public') : !!(w.doc.youtube.privacy && w.doc.youtube.privacy !== 'public');
            checklistLines.push('## ' + w.id + (vrec.privateDestination ? '  ⚠️ DESTINATION PRIVATE — publish it to activate the funnel' : ''), '');
            const fssl = true;   // optimistic; ytPostComment throws on 403 and we degrade gracefully
            for (const c of w.published) {
              const shortId = c.youtube.videoId;
              try {
                const snip = await ytGetVideoSnippet(token, shortId);
                if (!snip) { vrec.dead++; st.done++; continue; }
                const newDesc = FUNNEL.rebuildShortDescription(snip.description || '', longUrl);
                if (newDesc !== (snip.description || '')) { snip.description = newDesc; await ytUpdateVideoSnippet(token, shortId, snip); vrec.fixed++; }
                else vrec.ok++;
                const cbase = String(c.pinnedComment || '').replace(/\s*\(full video on the channel\)\s*$/i, '').trim();
                const commentText = !cbase ? '' : (/youtu\.be\/|youtube\.com\//i.test(cbase) ? cbase : (cbase + '  ' + longUrl));   // don't double a URL the comment already has
                if (fssl && !c.funnelCommentId && commentText) {
                  try { const cid = await ytPostComment(token, shortId, commentText); c.funnelCommentId = cid; vrec.comment++; }
                  catch (e) { vrec.note = 'comment skipped (needs force-ssl reconnect)'; }
                }
                checklistLines.push('- **Short** https://youtu.be/' + shortId + '  →  set Related video to "' + longTitle + '" (' + longUrl + ')',
                  '  - pin comment: ' + (commentText || '(none)'));
              } catch (e) { vrec.note = (vrec.note ? vrec.note + '; ' : '') + 'short ' + shortId + ': ' + String(e.message || e).slice(0, 80); }
              st.done++;
            }
            checklistLines.push('');
            // persist comment ids + sync markers
            await withFileLock(path.join(base, w.id, 'studio.json'), () => {
              const live = JSON.parse(fs.readFileSync(path.join(base, w.id, 'studio.json'), 'utf8'));
              const lc = (((live.stages || {}).shorts || {}).candidates || {}).clips || [];
              for (const c of w.published) { const m = lc.find((x) => x.id === c.id); if (m && c.funnelCommentId) m.funnelCommentId = c.funnelCommentId; }
              if (live.stages && live.stages.shorts) { live.stages.shorts.funnelSyncedTo = longId; live.stages.shorts.funnelSyncedAt = new Date().toISOString(); }
              if (livePriv && live.youtube) live.youtube.privacy = livePriv;   // refresh stored privacy so the no-API funnel-status banner is accurate
              fs.writeFileSync(path.join(base, w.id, 'studio.json'), JSON.stringify(live, null, 2));
            });
            st.fixed += vrec.fixed; if (vrec.privateDestination) st.flagged++;
            st.videos.push(vrec);
          }
          try { fs.mkdirSync(path.join(base, '_assets'), { recursive: true }); fs.writeFileSync(path.join(base, '_assets', 'shorts-funnel-checklist.md'), checklistLines.join('\n')); } catch (_) {}
          st.state = 'done'; st.checklist = '_assets/shorts-funnel-checklist.md';
        } catch (e) { st.state = 'error'; st.error = String(e && e.message || e); }
        finally { syncingFunnel.delete(ch); }
      })();
    });
    return;
  }
  if (pathname === '/api/youtube/sync-shorts-funnel-status' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(Object.assign({ running: syncingFunnel.has(query.channel) }, funnelSyncStatus[query.channel] || { state: 'idle' })));
  }
  // --- Read-only funnel health (no API calls): which videos have stale/inactive Short funnels ---
  if (pathname === '/api/youtube/funnel-status' && req.method === 'GET') {
    if (!safeSeg(query.channel)) return send(res, 400, JSON.stringify({ error: 'bad channel' }));
    const base = path.join(ROOT, query.channel);
    const out = [];
    let dirs = []; try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d/.test(d.name)).map((d) => d.name); } catch (_) {}
    for (const d of dirs) {
      let doc; try { doc = JSON.parse(fs.readFileSync(path.join(base, d, 'studio.json'), 'utf8')); } catch (_) { continue; }
      const shorts = ((doc.stages || {}).shorts) || {};
      const published = ((shorts.candidates || {}).clips || []).filter((c) => c.youtube && c.youtube.videoId);
      if (!published.length) continue;
      const longId = doc.youtube && doc.youtube.videoId;
      const stale = !longId || shorts.funnelSyncedTo !== longId;
      const priv = !!(doc.youtube && doc.youtube.privacy && doc.youtube.privacy !== 'public');
      out.push({ id: d, shorts: published.length, stale, privateDestination: priv, status: !longId ? 'no-long-video' : stale ? 'stale' : priv ? 'private-destination' : 'ok' });
    }
    const staleShorts = out.filter((v) => v.stale || v.privateDestination).reduce((a, v) => a + v.shorts, 0);
    return send(res, 200, JSON.stringify({ videos: out, staleShorts, needsSync: out.some((v) => v.stale) }));
  }
  // --- Generate timed subtitles (.srt + .vtt) from the narration timeline and SAVE them to 07-publish/.
  //     No YouTube connection required — this is the local "I just want the caption file" path. ---
  if (pathname === '/api/subtitles' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try {
      const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
      const { srt, cues, seconds } = SUBS.buildSrt(scenes);
      if (!cues) return send(res, 200, JSON.stringify({ error: 'No voiced narration beats yet — generate the narration first.', isError: true }));
      const { vtt } = SUBS.buildVtt(scenes);
      const outDir = path.join(path.dirname(sp), '07-publish');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'subtitles.en.srt'), srt);
      fs.writeFileSync(path.join(outDir, 'subtitles.en.vtt'), vtt);
      const mm = Math.floor(seconds / 60), ss = String(Math.round(seconds % 60)).padStart(2, '0');
      return send(res, 200, JSON.stringify({ ok: true, cues, seconds: Math.round(seconds), srt,
        reply: cues + ' cues · ' + mm + ':' + ss + ' — saved 07-publish/subtitles.en.srt + .vtt' }));
    } catch (e) {
      return send(res, 200, JSON.stringify({ error: String(e && e.message || e), isError: true }));
    }
  }
  // --- Translate the English .srt into other languages via Gemini → 07-publish/subtitles.<code>.{srt,vtt}.
  //     Cue text only; timestamps + numbering preserved so timing never drifts. A faceless animated channel
  //     travels across languages for free — this is the reach lever. No YouTube needed (writes files). ---
  if (pathname === '/api/translate-subtitles' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini key set (Scenes tab).', isError: true }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const langs = (Array.isArray(JSON.parse(body || '{}').langs) ? JSON.parse(body || '{}').langs : []).filter((l) => TRANSLATE.LANGS[l]);
        if (!langs.length) return send(res, 200, JSON.stringify({ error: 'Pick at least one language.', isError: true }));
        const outDir = path.join(path.dirname(sp), '07-publish'); fs.mkdirSync(outDir, { recursive: true });
        const enPath = path.join(outDir, 'subtitles.en.srt');
        let enSrt;
        if (fs.existsSync(enPath)) enSrt = fs.readFileSync(enPath, 'utf8');
        else {
          const scenes = ((((JSON.parse(fs.readFileSync(sp, 'utf8')).stages || {}).scenes || {}).candidates) || {}).scenes || [];
          const built = SUBS.buildSrt(scenes);
          if (!built.cues) return send(res, 200, JSON.stringify({ error: 'No voiced narration to caption yet — generate narration first.', isError: true }));
          enSrt = built.srt; fs.writeFileSync(enPath, enSrt); fs.writeFileSync(path.join(outDir, 'subtitles.en.vtt'), SUBS.buildVtt(scenes).vtt);
        }
        const cues = SUBS.parseSrt(enSrt), texts = cues.map((c) => c.text);
        const done = [];
        for (const code of langs) {
          const name = TRANSLATE.LANGS[code];
          try {
            const lines = TRANSLATE.parseLines(await geminiText(key, TRANSLATE.buildPrompt(texts, name)), texts.length);
            const tCues = cues.map((c, i) => Object.assign({}, c, { text: (lines[i] != null && lines[i] !== '') ? lines[i] : c.text }));
            fs.writeFileSync(path.join(outDir, 'subtitles.' + code + '.srt'), SUBS.buildSrtFromCues(tCues));
            fs.writeFileSync(path.join(outDir, 'subtitles.' + code + '.vtt'), SUBS.buildVttFromCues(tCues));
            done.push({ code, name, cues: tCues.length, filled: lines.filter((x) => x != null && x !== '').length });
          } catch (e) { done.push({ code, name, error: String(e && e.message || e).slice(0, 140) }); }
        }
        const ok = done.filter((d) => !d.error);
        send(res, 200, JSON.stringify({ ok: ok.length > 0, done, langTotal: langs.length, reply: ok.length + '/' + langs.length + ' language' + (langs.length === 1 ? '' : 's') + ' written to 07-publish/' + (ok.length ? ' (' + ok.map((d) => d.code).join(', ') + ')' : '') + '.' }));
      } catch (e) { send(res, 200, JSON.stringify({ error: String(e && e.message || e), isError: true })); }
    });
    return;
  }
  // --- Generate the .srt from the beat timeline and (re)upload it as the video's English caption track.
  //     Works on an already-uploaded video; also runs automatically at the end of the main upload. ---
  if (pathname === '/api/youtube/captions' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const videoId = doc.youtube && doc.youtube.videoId;
        if (!videoId) return send(res, 400, JSON.stringify({ error: 'This video is not uploaded to YouTube yet — upload it first.' }));
        const yt = readYT(query.channel);
        if (!yt || !yt.refreshToken) return send(res, 400, JSON.stringify({ error: 'Connect this channel to YouTube first (the 📺 button).' }));
        const scenes = (((doc.stages || {}).scenes || {}).candidates || {}).scenes || [];
        const { srt, cues } = buildSrt(scenes);
        if (!cues) return send(res, 200, JSON.stringify({ error: 'No narration beats to caption.', isError: true }));
        try { fs.mkdirSync(path.join(path.dirname(sp), '07-publish'), { recursive: true }); fs.writeFileSync(path.join(path.dirname(sp), '07-publish', 'subtitles.en.srt'), srt); } catch (_) {}
        const token = await ytAccessToken(query.channel);
        await ytUpsertCaption(token, videoId, srt, 'en', 'English');
        send(res, 200, JSON.stringify({ ok: true, cues, videoId, reply: 'Uploaded ' + cues + ' English subtitle cues to ' + videoId + ' (saved 07-publish/subtitles.en.srt).' }));
      } catch (e) {
        let msg = String(e && e.message || e);
        if (/scope|insufficientPermissions|insufficient authentication|403/i.test(msg)) msg = 'YouTube needs re-connecting to grant subtitle permission — click 📺 in the top bar and re-connect this channel, then try again. (The .srt was still saved to 07-publish/subtitles.en.srt.)';
        send(res, 200, JSON.stringify({ error: msg, isError: true }));
      }
    });
    return;
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
          if (s.infographic && s.infographic.type) continue;                   // deterministic infographics aren't drawn by Gemini
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
        const reqBody = JSON.parse(body || '{}');
        const n = reqBody.n, light = !!reqBody.light;   // light => skip the heavy previous-frame ref (throttle-safe)
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
          // Retry with backoff: Gemini can hang/throttle (esp. after a burst), and a single render
          // should survive a transient timeout — the backoff also gives the throttle time to ease.
          const imagePath = await withRetry(() => renderScene(key, sp, scenes, idx, imgDir, refDir, sheet, { skipPrev: light, ctx: 'rerender' }), 3, 5000);
          send(res, 200, JSON.stringify({ reply: 'Rendered scene ' + n + '.', imagePath }));
        } catch (e) { send(res, 200, JSON.stringify({ reply: 'Scene ' + n + ' failed: ' + String(e && e.message || e), isError: true })); }
        finally { regeneratingScenes.delete(rk); }
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }

  // --- Animate ONE beat's still into a few-second motion clip via Veo (image→video) → 04-assets/video/NNN.mp4
  //     + scene.motionClip. The beat then renders as that video instead of a Ken-Burns still. Use selectively
  //     (cost + keep the simple charm). Key-ready: a clear error if the Gemini key lacks Veo access. ---
  if (pathname === '/api/animate-beat' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    if (!getVeoEnabled()) return send(res, 200, JSON.stringify({ error: 'Veo animation is off by default — turn it on with the toggle in the Scenes tab first.', isError: true }));
    const key = getGeminiKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Gemini key set (Scenes tab).', isError: true }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const opts = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
      const n = opts.n, rk = query.channel + '|' + query.id + '|' + n;
      if (animatingBeats.has(rk)) return send(res, 200, JSON.stringify({ reply: 'Beat ' + n + ' is already animating — hang tight.', busy: true }));
      try {
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const s = ((((doc.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(n));
        if (!s) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        const imgAbs = s.imagePath ? path.join(folder, s.imagePath) : null;
        if (!imgAbs || !fs.existsSync(imgAbs)) return send(res, 200, JSON.stringify({ error: "Generate beat " + n + "'s still image first — Veo animates FROM it.", isError: true }));
        const prompt = (opts.prompt || ('Subtly animate this illustration with gentle, natural motion in the SAME flat hand-drawn cartoon style; keep any characters exactly on-model; add NO new elements and NO text. Scene: ' + (s.visual || s.narration || '').slice(0, 200))).trim();
        animatingBeats.add(rk);
        try {
          const buf = await geminiVeoAnimate(key, imgAbs, prompt, {});
          const vdir = path.join(folder, '04-assets', 'video'); fs.mkdirSync(vdir, { recursive: true });
          const nn = String(s.n).padStart(3, '0'); const rel = '04-assets/video/' + nn + '.mp4';
          fs.writeFileSync(path.join(vdir, nn + '.mp4'), buf);
          await withFileLock(sp, () => {
            const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
            const t = ((((live.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(n));
            if (t) { t.motionClip = { src: rel, prompt, model: VEO.DEFAULT_MODEL, createdAt: new Date().toISOString() }; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
          });
          send(res, 200, JSON.stringify({ ok: true, src: rel, reply: 'Animated beat ' + n + ' with Veo.' }));
        } finally { animatingBeats.delete(rk); }
      } catch (e) {
        animatingBeats.delete(rk);
        let msg = String(e && e.message || e);
        if (/not found|not supported|permission|403|404|access|model|unavailable/i.test(msg)) msg = "Veo isn't available on this Gemini key/plan yet — the integration is built and ready; enable Veo on the key and retry. (" + msg.slice(0, 120) + ')';
        send(res, 200, JSON.stringify({ error: msg, isError: true }));
      }
    });
    return;
  }
  // --- Set / clear a beat's deterministic infographic (compare | timeline | plot) from structured data.
  //     Validated through lib/infographic.js so a malformed spec never reaches the renderer. ---
  if (pathname === '/api/set-infographic' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { n, infographic } = JSON.parse(body || '{}');
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const s = ((((doc.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(n));
        if (!s) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        if (infographic === null) { delete s.infographic; if (s.kind === 'infographic') s.kind = 'illustration'; }
        else { const norm = INFO.normalize(infographic); if (!norm) return send(res, 200, JSON.stringify({ error: 'Invalid infographic spec (need a valid type + data).', isError: true })); s.infographic = norm; s.kind = 'infographic'; }
        doc.updatedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(doc, null, 2));
        send(res, 200, JSON.stringify({ ok: true, type: infographic === null ? null : s.infographic.type, reply: infographic === null ? ('Cleared infographic on beat ' + n + '.') : ('Set a ' + s.infographic.type + ' infographic on beat ' + n + '.') }));
      } catch (e) { send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  // --- Fetch a REAL artifact photo from Pexels for a beat → 04-assets/real/NNN.jpg + scene.realPhoto.
  //     The beat then renders as a field-guide "specimen plate" instead of its AI illustration. ---
  if (pathname === '/api/fetch-real-photo' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getPexelsKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Pexels key yet — add a free key (pexels.com/api) on the Scenes tab.', isError: true }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const opts = JSON.parse(body || '{}');
        const n = opts.n;
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        const s = scenes.find((x) => String(x.n) === String(n));
        if (!s) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        const q = (opts.query || (s.realPhoto && s.realPhoto.query) || '').trim();
        if (!q) return send(res, 200, JSON.stringify({ error: 'No search query for this beat.', isError: true }));
        const label = (opts.label || (s.realPhoto && s.realPhoto.label) || q).trim().slice(0, 60);
        const r = await fetch(PEXELS.searchUrl(q), { headers: { Authorization: key } });
        if (!r.ok) { const tx = await r.text(); return send(res, 200, JSON.stringify({ error: 'Pexels ' + r.status + ': ' + tx.slice(0, 160), isError: true })); }
        const j = await r.json();
        const photo = PEXELS.pickBest(j.photos, { query: q });   // relevance-ranked: prefer an alt that names the artifact
        if (!photo) return send(res, 200, JSON.stringify({ error: 'No Pexels results for "' + q + '" — try a different phrase.', isError: true }));
        const ir = await fetch(PEXELS.bestSrc(photo));
        if (!ir.ok) return send(res, 200, JSON.stringify({ error: 'Could not download the photo (' + ir.status + ').', isError: true }));
        const buf = Buffer.from(await ir.arrayBuffer());
        const realDir = path.join(folder, '04-assets', 'real'); fs.mkdirSync(realDir, { recursive: true });
        const nn = String(s.n).padStart(3, '0');
        const rel = '04-assets/real/' + nn + '.jpg';
        fs.writeFileSync(path.join(realDir, nn + '.jpg'), buf);
        const attr = PEXELS.attribution(photo);
        await withFileLock(sp, () => {
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          const t = ((((live.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(n));
          if (t) { t.realPhoto = { query: q, label, src: rel, photographer: attr.photographer, photographerUrl: attr.photographerUrl, pexelsUrl: attr.pexelsUrl, pexelsId: attr.id, fetchedAt: new Date().toISOString() }; live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2)); }
        });
        send(res, 200, JSON.stringify({ ok: true, src: rel, label, photographer: attr.photographer, reply: 'Fetched a real photo for beat ' + n + ' (© ' + (attr.photographer || 'Pexels') + ').' }));
      } catch (e) { send(res, 200, JSON.stringify({ error: String(e && e.message || e), isError: true })); }
    });
    return;
  }

  // --- Fetch a REAL artifact/site VIDEO from Pexels for a beat → 04-assets/real/NNN.mp4 + scene.realPhoto
  //     (video:true). The beat then renders as a MOVING field-guide "specimen plate" (same cream frame +
  //     label) instead of its AI illustration — a FREE alternative to Veo for motion on a real-object beat.
  //     Artifacts/sites ONLY, sparingly (the animated-identity moat) — same rule as the photo cutaway. ---
  if (pathname === '/api/fetch-real-video' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const key = getPexelsKey();
    if (!key) return send(res, 400, JSON.stringify({ error: 'No Pexels key yet — add a free key (pexels.com/api) on the Scenes tab.', isError: true }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const opts = JSON.parse(body || '{}');
        const n = opts.n;
        const folder = path.dirname(sp);
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const scenes = (doc.stages.scenes && doc.stages.scenes.candidates && doc.stages.scenes.candidates.scenes) || [];
        const s = scenes.find((x) => String(x.n) === String(n));
        if (!s) return send(res, 400, JSON.stringify({ error: 'scene ' + n + ' not found' }));
        const q = (opts.query || (s.realPhoto && s.realPhoto.query) || '').trim();
        if (!q) return send(res, 200, JSON.stringify({ error: 'No search query for this beat.', isError: true }));
        const label = (opts.label || (s.realPhoto && s.realPhoto.label) || q).trim().slice(0, 60);
        const r = await fetch(PEXELS.videoSearchUrl(q), { headers: { Authorization: key } });
        if (!r.ok) { const tx = await r.text(); return send(res, 200, JSON.stringify({ error: 'Pexels ' + r.status + ': ' + tx.slice(0, 160), isError: true })); }
        const j = await r.json();
        const video = PEXELS.pickBestVideo(j.videos, { query: q });
        if (!video) return send(res, 200, JSON.stringify({ error: 'No Pexels video results for "' + q + '" — try a photo, or a different phrase.', isError: true }));
        const fileUrl = PEXELS.bestVideoFile(video);
        if (!fileUrl) return send(res, 200, JSON.stringify({ error: 'No usable mp4 in the top Pexels result — try a different phrase.', isError: true }));
        const vr = await fetch(fileUrl);
        if (!vr.ok) return send(res, 200, JSON.stringify({ error: 'Could not download the video (' + vr.status + ').', isError: true }));
        const buf = Buffer.from(await vr.arrayBuffer());
        const realDir = path.join(folder, '04-assets', 'real'); fs.mkdirSync(realDir, { recursive: true });
        const nn = String(s.n).padStart(3, '0');
        const rel = '04-assets/real/' + nn + '.mp4';
        fs.writeFileSync(path.join(realDir, nn + '.mp4'), buf);
        const attr = PEXELS.videoAttribution(video);
        await withFileLock(sp, () => {
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          const t = ((((live.stages || {}).scenes || {}).candidates || {}).scenes || []).find((x) => String(x.n) === String(n));
          if (t) {
            // stored on the SAME realPhoto field (video:true) so the renderer, revert, census + QC all keep working
            t.realPhoto = { query: q, label, src: rel, video: true, duration: attr.duration, photographer: attr.photographer, photographerUrl: attr.photographerUrl, pexelsUrl: attr.pexelsUrl, pexelsId: attr.id, fetchedAt: new Date().toISOString() };
            live.updatedAt = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(live, null, 2));
          }
        });
        send(res, 200, JSON.stringify({ ok: true, src: rel, label, video: true, photographer: attr.photographer, reply: 'Fetched a real ' + (attr.duration ? attr.duration + 's ' : '') + 'video for beat ' + n + ' (© ' + (attr.photographer || 'Pexels') + ').' }));
      } catch (e) { send(res, 200, JSON.stringify({ error: String(e && e.message || e), isError: true })); }
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
        const results = await mapPool(targets, 3, (s) => withRetry(() => renderNarration(cfg, sp, scenes, scenes.indexOf(s), audioDir, force ? 'revoice' : 'initial')));
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
          const r = await renderNarration(cfg, sp, scenes, idx, audioDir, 'revoice');
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
            ...WARMAP.sanitizeWarFields(p.map),   // war-map fields (theme/zoom/sides/territory/…) — C3
          };
          if (!s.map.focus.length) delete s.map;
        }
        if (Array.isArray(p.characters)) s.characters = p.characters.filter((x) => typeof x === 'string');
        if (['push-in', 'push-out', 'pan-left', 'pan-right', 'static'].includes(p.motion)) s.motion = p.motion;
        if (['punch', 'fade', 'type', 'none'].includes(p.textAnim)) s.textAnim = p.textAnim;
        if (Array.isArray(p.sfx)) s.sfx = p.sfx.filter((x) => typeof x === 'string');
        if (typeof p.ambient === 'string') s.ambient = p.ambient.trim().toLowerCase().replace(/^none$/, '');
        if (typeof p.ambientFx === 'string') { const v = p.ambientFx.trim().toLowerCase().replace(/^none$/, ''); s.ambientFx = /^(embers|spores|pollen|dust|snow|rain)$/.test(v) ? v : ''; }
        if (p.realPhoto === null) delete s.realPhoto;   // revert to the AI illustration
        if (p.motionClip === null) delete s.motionClip;  // revert from a Veo motion clip to the still
        else if (p.realPhoto && typeof p.realPhoto.query === 'string') s.realPhoto = Object.assign({}, s.realPhoto, { query: p.realPhoto.query.slice(0, 120), label: (p.realPhoto.label || p.realPhoto.query || '').slice(0, 60) });
        if (typeof p.musicCue === 'string') s.musicCue = ['act1', 'rehook', 'act2', 'payoff', 'outro'].includes(p.musicCue) ? p.musicCue : '';
        if (typeof p.castAction === 'string') s.castAction = p.castAction;
        if (typeof p.hq === 'boolean') s.hq = p.hq;   // HQ render (Gemini 3 Pro) for this beat
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
  // --- End-card preview: render JUST the branded end card to a still (fast — no full video) so the
  //     operator can see the outro / watch-next cards without assembling the whole rough cut. ---
  if (pathname === '/api/preview-endcard' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    if (!fs.existsSync(path.join(RENDER_DIR, 'node_modules', 'remotion'))) return send(res, 200, JSON.stringify({ error: 'Remotion not installed (cd _studio/render && npm install).', isError: true }));
    const ik = query.channel + '|' + query.id;
    if (generatingEndcard.has(ik)) return send(res, 200, JSON.stringify({ reply: 'Already rendering the end-card preview — hang tight.', running: true }));
    generatingEndcard.add(ik);
    let replied = false; const finish = (o) => { if (replied) return; replied = true; send(res, 200, JSON.stringify(o)); };
    const child = spawn(process.execPath, [path.join(RENDER_DIR, 'preview-endcard.mjs'), query.channel, query.id], { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
    let err = '';
    child.stderr.on('data', (d) => { err += d; }); child.stdout.on('data', () => {});
    child.on('error', (e) => { generatingEndcard.delete(ik); finish({ error: String(e && e.message || e), isError: true }); });
    child.on('close', (code) => {
      generatingEndcard.delete(ik);
      const out = path.join(path.dirname(sp), '05-edit', 'endcard-preview.png');
      if (code === 0 && fs.existsSync(out)) finish({ ok: true });
      else finish({ error: 'Render failed: ' + (err.slice(-300).trim() || 'exit ' + code), isError: true });
    });
    return;
  }
  if (pathname === '/api/endcard-img' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp) return send(res, 400, 'bad', 'text/plain');
    const f = path.join(path.dirname(sp), '05-edit', 'endcard-preview.png');
    if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(f));
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

  // --- Final thumbnail via the TWO-LAYER pipeline: (1) Gemini renders TEXT-FREE art from a structured
  //     master-prompt, (2) a Remotion still (render/thumb.mjs) composites the headline in a UI-safe zone.
  //     Renders ONE thumbnail; persists finalThumbs + finalThumbMeta so the UI can re-overlay later. ---
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
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const resolved = resolveThumbConcept(doc);   // shared with the Script-page prompt backfill
        const title = resolved.title;
        // Resolve the CONCEPT: explicit override in the POST body wins; else the chosen wireframe.
        const concept = (opts.concept && typeof opts.concept === 'object') ? opts.concept : resolved.concept;
        concept.subject = concept.subject || {};
        concept.accent = concept.accent || THUMB.BOGY.orange;
        concept.textSide = (concept.textSide === 'left' || concept.textSide === 'right')
          ? concept.textSide
          : (concept.subject.zone === 'right' ? 'left' : 'right');
        const hook = String(concept.hook || '').toUpperCase().trim()
          || title.split(/[—:–-]/)[0].trim().toUpperCase().slice(0, 28);
        concept.hook = hook;
        // CHANNEL THUMBNAIL STYLE HINT (operator-saved text formula): folded into the [STYLE] block.
        const channelStyleTxt = channelThumbStyle(query.channel);
        // LAYER 1 — build the TEXT-FREE art prompt + render it on Gemini 3 Pro. The operator's
        // per-thumbnail note (typed on the Packaging tab, sent as opts.note) steers the art too —
        // it was previously accepted by the client and silently dropped here.
        const opNote = String(opts.note || '').trim();
        const artPrompt = THUMB.buildThumbArtPrompt(concept, title, channelStyleTxt)
          + (opNote ? `\n[OPERATOR NOTE — fold this direction into the art (image stays TEXT-FREE)] ${opNote}` : '');
        // Cast references for consistency: the group cast sheet + the chosen subject's own portrait.
        const refDir = castRefDir(query.channel, query.id);
        const refs = [path.join(refDir, 'cast-sheet.png')].filter((f) => fs.existsSync(f));
        const who = String((concept.subject && concept.subject.who) || '');
        for (const c of readCast(query.channel)) {
          if (who.includes(c.name) && fs.existsSync(path.join(refDir, c.name + '.png'))) refs.push(path.join(refDir, c.name + '.png'));
        }
        const outDir = path.join(path.dirname(sp), '00-packaging', 'thumbnails');
        fs.mkdirSync(outDir, { recursive: true });
        const artAbs = path.join(outDir, 'final-1.art.png');
        const finalAbs = path.join(outDir, 'final-1.png');
        const artBuf = await withRetry(() => geminiImage(key, artPrompt, refs, GEMINI_MODEL_PRO));   // thumbnail art always HQ
        fs.writeFileSync(artAbs, artBuf);
        logUsage(usageKeyFromSp(sp), { imagesPro: 1, ctx: 'thumbnail' });
        // LAYER 2 — composite the headline via render/thumb.mjs (mirror the server's child-process spawn).
        await new Promise((resolve, reject) => {
          const args = [
            path.join(RENDER_DIR, 'thumb.mjs'),
            '--art', artAbs,
            '--hook', hook,
            '--accent', concept.accent,
            '--side', concept.textSide,
            '--out', finalAbs,
          ];
          const child = spawn(process.execPath, args, { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
          let err = '';
          child.stderr.on('data', (d) => { err += d; });
          child.stdout.on('data', () => {});
          child.on('error', (e) => reject(e));
          child.on('close', (code) => {
            if (code === 0 && fs.existsSync(finalAbs)) resolve();
            else reject(new Error('thumb.mjs overlay failed (exit ' + code + '): ' + (err.slice(-500).trim() || 'no output')));
          });
        });
        const files = ['00-packaging/thumbnails/final-1.png'];
        await withFileLock(sp, () => {
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.stages.packaging = live.stages.packaging || {};
          live.stages.packaging.candidates = live.stages.packaging.candidates || {};
          live.stages.packaging.candidates.finalThumbs = files;
          live.stages.packaging.candidates.finalThumbMeta = { hook, accent: concept.accent, side: concept.textSide, artFile: '00-packaging/thumbnails/final-1.art.png' };
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        });
        send(res, 200, JSON.stringify({ reply: 'Rendered the final thumbnail (text-free art on Gemini 3 Pro + headline overlay).', files, artPrompt, hook }));
      } catch (e) { send(res, 200, JSON.stringify({ reply: 'Thumbnail generation failed: ' + String(e && e.message || e), isError: true })); }
      finally { generatingThumbs.delete(ik); }
    });
    return;
  }

  // --- Cheap headline RE-OVERLAY: re-run JUST layer 2 (render/thumb.mjs) over the SAVED text-free art,
  //     no Gemini call. Lets the operator re-word the hook / change accent / side / font for free. ---
  if (pathname === '/api/thumbnail-overlay' && req.method === 'POST') {
    const sp = studioPath(query.channel, query.id);
    if (!sp || !fs.existsSync(sp)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const ik = query.channel + '|' + query.id;
      if (overlayingThumbs.has(ik)) return send(res, 200, JSON.stringify({ error: 'A headline overlay is already running — hang tight.', busy: true }));
      overlayingThumbs.add(ik);
      try {
        const opts = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
        const doc = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const meta = ((((doc.stages || {}).packaging || {}).candidates || {}).finalThumbMeta) || {};
        const outDir = path.join(path.dirname(sp), '00-packaging', 'thumbnails');
        const artAbs = path.join(outDir, 'final-1.art.png');
        if (!fs.existsSync(artAbs)) { send(res, 400, JSON.stringify({ error: 'No thumbnail art yet — generate the final art first.' })); return; }
        const finalAbs = path.join(outDir, 'final-1.png');
        // Resolve fields: POST body wins, else fall back to the stored finalThumbMeta.
        const hookCapped = THUMB.capHook(opts.hook != null ? opts.hook : meta.hook);
        const hook = String(hookCapped.text || '').toUpperCase().trim();
        let accent = String(opts.accent || meta.accent || '').trim();
        if (!/^#?[0-9a-f]{6}$/i.test(accent)) accent = THUMB.BOGY.orange;
        const sideIn = opts.side || meta.side;
        const side = (sideIn === 'left' || sideIn === 'right') ? sideIn : 'right';
        const fontIn = opts.font || meta.font;
        const font = ['anton', 'archivo', 'bebas'].includes(fontIn) ? fontIn : 'anton';   // Anton = heavy-condensed default
        // Re-run ONLY layer 2 — mirror the generate-thumbnail spawn exactly.
        await new Promise((resolve, reject) => {
          const args = [
            path.join(RENDER_DIR, 'thumb.mjs'),
            '--art', artAbs,
            '--hook', hook,
            '--accent', accent,
            '--side', side,
            '--font', font,
            '--out', finalAbs,
          ];
          const child = spawn(process.execPath, args, { cwd: RENDER_DIR, windowsHide: true, env: renderEnv() });
          let err = '';
          child.stderr.on('data', (d) => { err += d; });
          child.stdout.on('data', () => {});
          child.on('error', (e) => reject(e));
          child.on('close', (code) => {
            if (code === 0 && fs.existsSync(finalAbs)) resolve();
            else reject(new Error('thumb.mjs overlay failed (exit ' + code + '): ' + (err.slice(-500).trim() || 'no output')));
          });
        });
        const files = ['00-packaging/thumbnails/final-1.png'];
        await withFileLock(sp, () => {
          const live = JSON.parse(fs.readFileSync(sp, 'utf8'));
          live.stages.packaging = live.stages.packaging || {};
          live.stages.packaging.candidates = live.stages.packaging.candidates || {};
          live.stages.packaging.candidates.finalThumbs = files;
          live.stages.packaging.candidates.finalThumbMeta = { hook, accent, side, font, artFile: '00-packaging/thumbnails/final-1.art.png' };
          live.updatedAt = new Date().toISOString();
          fs.writeFileSync(sp, JSON.stringify(live, null, 2));
        });
        send(res, 200, JSON.stringify({ ok: true, files, hook }));
      } catch (e) { send(res, 200, JSON.stringify({ error: 'Headline overlay failed: ' + String(e && e.message || e) })); }
      finally { overlayingThumbs.delete(ik); }
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
      const L = lengthPlan(query.channel, query.id, doc);
      const checks = [];
      const add = (id, level, detail) => checks.push({ id, level, detail });
      if (!scenes.length) { add('scenes', 'fail', 'No storyboard yet.'); return send(res, 200, JSON.stringify({ checks })); }
      const secOf = (s) => s.audioSeconds || s.seconds || 0;
      const words = scenes.reduce((a, s) => a + (s.narration || '').trim().split(/\s+/).filter(Boolean).length, 0);
      const totalSec = scenes.reduce((a, s) => a + secOf(s), 0);
      // the SHIPPED video = narration + the branded end card (12s default; doc.endCard:false opts out) — this is the length YouTube measures for mid-roll eligibility
      const endCardSec = (doc.endCard === false) ? 0 : ((doc.endCard && doc.endCard.seconds) || 12);
      const videoSec = totalSec + endCardSec;
      // word count, calibrated to THIS voice's measured WPM (not the old 135 assumption)
      add('word-count', words >= L.floorWords ? (words >= Math.round(L.targetWords * 0.92) ? 'pass' : 'warn') : 'fail',
        words + ' narration words → ~' + (totalSec / 60).toFixed(1) + ' min at ' + Math.round(L.wpm) + ' WPM' + (L.measured ? '' : ' (est)') + '. Target ' + L.targetMinutes + ' min ≈ ' + L.targetWords + ' words; floor ' + L.floorWords + '.');
      // mid-roll cliff: 8:00 unlocks mid-roll ads; keep a buffer so a fast voice never silently forfeits them
      const mmss = Math.floor(videoSec / 60) + ':' + String(Math.floor(videoSec % 60)).padStart(2, '0');
      add('mid-roll-length', videoSec >= 490 ? 'pass' : (videoSec >= 480 ? 'warn' : 'fail'),
        'Video runtime ' + mmss + ' (narration + ' + endCardSec + 's end card). Mid-roll ads need ≥8:00 — keep ≥8:10 of buffer' + (videoSec < 490 ? ' (extend the script or add beats — at ' + Math.round(L.wpm) + ' WPM you need ~' + Math.max(0, Math.ceil((490 - videoSec) / 60 * L.wpm)) + ' more narration words).' : '.'));
      // on-length vs the chosen target ("reasonably close to the intended length")
      const tgtSec = L.targetMinutes * 60, shortBy = tgtSec - videoSec;
      add('target-length', videoSec >= tgtSec - 30 ? 'pass' : (videoSec >= 490 ? 'warn' : 'fail'),
        shortBy > 30 ? mmss + ' is ' + Math.round(shortBy) + 's under your ' + L.targetMinutes + '-min target — add ~' + Math.ceil(shortBy / 60 * L.wpm) + ' narration words to hit it.' : mmss + ' meets your ' + L.targetMinutes + '-min target.');
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
      // --- early-retention opening checks (text-based; module-driven) ---
      const openingText = scenes.map((s) => s.narration || '').join(' ');
      const pkDec = ((doc.stages || {}).packaging || {}).decision || {};
      const titleObj = (((doc.stages || {}).packaging || {}).candidates || {}).titles || [];
      const qcTitle = (titleObj.find((t) => t.id === pkDec.primaryTitle) || {}).text || doc.workingTitle || '';
      const myArch = (((doc.stages || {}).script || {}).candidates || {}).opening || {};
      for (const oc of ER.runOpeningChecks({
        openingText,
        title: qcTitle,
        archetype: myArch.archetype || null,
        prevArchetype: prevArchetypeOf(query.channel, query.id),
        wpm: L.wpm,
      })) add(oc.id, oc.level, oc.detail);
      // captions: short and punchy; map beats must not duplicate the map's own labels.
      // Modern beats carry captions in cues[] (onScreenText stays empty for them) — check both.
      const longCaps = scenes.filter((s) => CAPTIONS.captionTexts(s).some((t) => t.split(/\s+/).filter(Boolean).length > 6)).map((s) => s.n);
      add('caption-length', longCaps.length ? 'warn' : 'pass', longCaps.length ? 'Captions over 6 words on beats: ' + longCaps.join(', ') : 'All captions ≤ 6 words.');
      const dupCaps = scenes.filter((s) => s.kind === 'map' && s.map && (s.map.labels || []).some((l) => l.text && CAPTIONS.captionTexts(s).some((t) => t.toUpperCase().includes(l.text.toUpperCase())))).map((s) => s.n);
      add('map-captions', dupCaps.length ? 'warn' : 'pass', dupCaps.length ? 'Map beats whose overlay caption duplicates a map label: ' + dupCaps.join(', ') : 'No map-label duplication.');
      // kinetic-caption anchor resolution: cues[].anchor must name a word present in that beat's
      // wordTimings, or render/cues.mjs's resolveCues() silently falls back to proportional placement
      // (no error, no on-screen sign). norm()/findWord() reimplemented here verbatim (server.js is
      // CommonJS, cues.mjs is ESM) — detection only, never touches cues.mjs or auto-fixes an anchor.
      const anchorNorm = (s) => String(s || '').toLowerCase().replace(/^[^a-z0-9%]+|[^a-z0-9%]+$/gi, '');
      const anchorFind = (wt, anchor, fromIdx) => {
        const a = anchorNorm(anchor);
        if (!a) return -1;
        for (let i = Math.max(0, fromIdx); i < wt.length; i++) if (wt[i].w === a) return i;
        return -1;
      };
      const anchorMisses = [];
      for (const s of scenes) {
        const cues = Array.isArray(s.cues) ? s.cues : [];
        if (!cues.length) continue;
        const wt = s.wordTimings || [];
        let lastIdx = -1;
        for (const c of cues) {
          const idx = anchorFind(wt, c.anchor, lastIdx + 1);
          if (idx >= 0) lastIdx = idx;
          else anchorMisses.push('beat ' + s.n + ' ("' + (c.text || '') + '": anchor "' + (c.anchor || '') + '")');
        }
      }
      add('caption-anchor-resolve', anchorMisses.length ? 'warn' : 'pass', anchorMisses.length
        ? anchorMisses.length + ' cue anchor(s) don\'t match a word in their beat\'s wordTimings (falls back to proportional placement): ' + anchorMisses.join('; ')
        : 'All caption cue anchors resolve to a real spoken word.');
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
        // A beat "breaks the visual monotony" if ANYTHING changes on screen — and this must track the
        // CURRENT pipeline, not the legacy one. Modern captions live in cues[] (onScreenText stays empty
        // for them), real-artifact cutaways set realPhoto while keeping kind:'illustration', ambientFx
        // starts a particle layer, and multi-still beats use images[] (frames is a dead field). Omitting
        // these made the check score every cued / real-photo / infographic-adjacent beat as a dead stretch,
        // producing chronic false pattern-interrupt warnings (e.g. 009 reported 11 gaps where only 7 are real).
        const cueCount = Array.isArray(s.cues) ? s.cues.length : ((s.cues || '').toString().trim() ? 1 : 0);
        const interrupt = (s.onScreenText || '').trim() || cueCount || (s.sfx || []).length || s.musicCue
          || s.realPhoto || s.ambientFx || (s.images || s.frames || []).length > 1 || s.kind !== 'illustration';
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
      add('music-bed', hasMusic ? 'pass' : 'warn', hasMusic ? 'Music bed found — the assembler will mix it under narration.' : 'No music bed. Drop a YouTube Audio Library track at <channel>/_assets/music/bed.mp3 (one per channel works).');
      // sources on disk for the description
      const srcFile = path.join(folder, '01-research', 'sources.md');
      add('sources', fs.existsSync(srcFile) ? 'pass' : 'fail', fs.existsSync(srcFile) ? '01-research/sources.md exists.' : '01-research/sources.md missing — fact-check gate (and the description source list) needs it.');
      // --- packaging quality (advisory; lexical/structural only — semantic redundancy is prevented at generation) ---
      const pk = (doc.stages || {}).packaging || {};
      const pdec = pk.decision || {};
      const pcand = pk.candidates || {};
      const ptitles = (pcand.titles || []).concat(pdec.customTitles || []);
      const primaryT = (ptitles.find((t) => t.id === pdec.primaryTitle) || {}).text || '';
      if (primaryT) {
        add('pkg-title-length', (primaryT.length >= 42 && primaryT.length <= 66) ? 'pass' : 'warn',
          'Primary title is ' + primaryT.length + ' chars (aim ~45-62, hook + keyword in the first ~40): "' + primaryT + '".');
        const firstWords = primaryT.split(/\s+/).slice(0, 5).join(' ');
        add('pkg-title-keyword', PACKAGING.contentTokens(firstWords).length ? 'pass' : 'warn',
          PACKAGING.contentTokens(firstWords).length ? 'Title front-loads a content keyword.' : 'No content keyword in the first ~5 words — front-load the search term.');
        const naHit = PACKAGING.nonAnswerHit(primaryT);
        add('pkg-non-answer', naHit ? 'warn' : 'pass',
          naHit ? 'Primary title promises a NON-answer ("' + naHit + '") — the curiosity gap reads as "this won\'t be resolved", which under-sells a video that DOES pay off. Tease the reveal instead.'
                : 'Title promises a payoff, not a dead-end.');
        const ab = (ptitles.find((t) => t.id === (pdec.abTitles || [])[0]) || {}).text || '';
        if (ab && PACKAGING.contentTokens(primaryT).length >= 3 && PACKAGING.contentTokens(ab).length >= 3) {
          const ov = PACKAGING.tokenOverlap(primaryT, ab);
          add('pkg-ab-distinct', ov <= 0.6 ? 'pass' : 'warn',
            ov <= 0.6 ? 'A/B title is lexically distinct.' : 'A/B reuses ' + Math.round(ov * 100) + '% of the primary\'s words — test a structurally different bet.');
        }
      }
      const chosenTh = (pcand.thumbnails || []).find((t) => t.id === pdec.chosenThumbnail);
      if (chosenTh && chosenTh.layout) {
        const head = PACKAGING.layoutHeadline(chosenTh.layout);
        if (primaryT && PACKAGING.contentTokens(head).length) {
          const ov = PACKAGING.tokenOverlap(head, primaryT);
          add('pkg-pair-redundant', ov <= 0.6 ? 'pass' : 'warn',
            ov <= 0.6 ? 'Thumbnail headline adds beyond the title.' : 'Thumbnail headline re-uses ' + Math.round(ov * 100) + '% of the title\'s words — make it add emotion/stakes the title can\'t say.');
        }
        const ec = PACKAGING.layoutElementCount(chosenTh.layout);
        add('pkg-thumb-elements', ec <= 3 ? 'pass' : 'warn',
          ec <= 3 ? 'Thumbnail has ' + ec + ' elements.' : 'Thumbnail spec has ' + ec + ' elements (>3) — too busy at 120x68; cut to a hero + ≤2 supports.');
        const sub = chosenTh.layout.subject || {};
        if (sub.scale === 'hero') add('pkg-thumb-subject', sub.zone === 'left' ? 'pass' : 'warn',
          sub.zone === 'left' ? 'Hero subject in the left zone.' : 'Hero subject is in the ' + (sub.zone || '?') + ' zone — put it in the left ~60%.');
        // Eye contact: a hero face looking INTO the lens converts ~20% better (research-backed). Advisory.
        const tgaze = (chosenTh.subject || {}).gaze;
        if (sub.scale === 'hero' && sub.who && sub.who !== 'none')
          add('pkg-thumb-eyecontact', tgaze === 'at-camera' ? 'pass' : 'warn',
            tgaze === 'at-camera' ? 'Hero makes direct eye contact (the strongest CTR lever).'
              : 'Hero face uses ' + (tgaze || 'side') + '-gaze — faces with direct eye contact (gaze "at-camera") convert ~20% better; consider an at-camera variant.');
      }
      const hasFinal = fs.existsSync(path.join(folder, '00-packaging', 'thumbnails', 'final-1.png'));
      const hasManual = fs.existsSync(path.join(folder, '00-packaging', 'thumbnail.png'));
      add('pkg-thumb-art', (hasFinal || hasManual) ? 'pass' : 'warn',
        !(hasFinal || hasManual) ? 'No final thumbnail art yet — generate it on the Packaging tab.'
          : (hasManual && !hasFinal) ? 'Thumbnail is a manual drop-in (00-packaging/thumbnail.png) — the recorded concept may differ from the shipped art.'
          : 'Final thumbnail art present.');
      // drift guard: studio.json is the source of truth for the human's packaging decision, but
      // 00-packaging/titles.md is a separate file that has to be synced from it by hand — nothing
      // previously caught it silently sitting as the unfilled blank template after a decision was made.
      if (pdec.primaryTitle) {
        let titlesMdText = null;
        try { titlesMdText = fs.readFileSync(path.join(folder, '00-packaging', 'titles.md'), 'utf8'); } catch (_) {}
        const blank = PACKAGING.titlesMdTitleBlank(titlesMdText);
        add('pkg-titles-md-synced', blank ? 'warn' : 'pass',
          blank ? 'Packaging decision made but titles.md still has the blank template — sync it (00-packaging/titles.md, "Chosen pair" section).'
            : 'titles.md "Chosen pair" reflects the packaging decision.');
      }
      const vid = doc.youtube && doc.youtube.videoId;
      if (vid) {
        let ctr = null; try { ctr = JSON.parse(fs.readFileSync(path.join(ROOT, query.channel, '_analytics', 'cache', vid + '.json'), 'utf8')).ctr; } catch (_) {}
        add('pkg-ctr', (ctr != null) ? 'pass' : 'warn',
          (ctr != null) ? ('CTR on file: ' + ctr + '%.') : 'No CTR entered for this published video — enter it from YouTube Studio to unlock the Coach packaging-vs-hook diagnosis.');
      }
      const stats = { words, minutes: +(totalSec / 60).toFixed(1), beats: scenes.length, wpm: Math.round(L.wpm), targetMinutes: L.targetMinutes, runtime: mmss };
      // QC feedback loop: persist this run (07-publish/qc-log.json) + roll into the channel trend
      // (<channel>/_analytics/qc-trends.json) so recurring failures become fixable at the generator level.
      // Best-effort, and only when the OUTCOME changed (the tab may re-request /api/qc repeatedly).
      let recurring = [];
      try {
        const ts = new Date().toISOString();
        const sig = QCT.signature(checks);
        const logPath = path.join(folder, '07-publish', 'qc-log.json');
        let prevSig = null; try { prevSig = JSON.parse(fs.readFileSync(logPath, 'utf8')).signature; } catch (_) {}
        const trPath = path.join(ROOT, query.channel, '_analytics', 'qc-trends.json');
        let trends = {}; try { trends = JSON.parse(fs.readFileSync(trPath, 'utf8')); } catch (_) {}
        if (sig !== prevSig) {
          const snapshot = { ts, signature: sig, stats, summary: QCT.summarize(checks), checks };
          fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, JSON.stringify(snapshot, null, 2));
          trends = QCT.updateTrends(trends, query.id, snapshot, ts);
          fs.mkdirSync(path.dirname(trPath), { recursive: true }); fs.writeFileSync(trPath, JSON.stringify(trends, null, 2));
        }
        recurring = QCT.recurringIssues(trends, 2);
      } catch (_) {}
      // channel-wide drift check: CONTEXT/40_STATE.md's QC column vs every episode's persisted
      // qc-log.json (see lib/state-drift.js). Surfaced on EVERY QC-tab load regardless of which
      // video is open — a per-video check would only ever alert when the stale episode itself is
      // the one being viewed, which is exactly the "caught by luck" gap this exists to close.
      let stateDrift = [];
      try { stateDrift = STATEDRIFT.scanChannelDrift(ROOT, query.channel); } catch (_) {}
      return send(res, 200, JSON.stringify({ checks, stats, recurring, stateDrift }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }
  // --- QC trends rollup for this channel (the cross-video recurring-issue record Claude reads) ---
  if (pathname === '/api/qc-trends' && req.method === 'GET') {
    const trPath = path.join(ROOT, safeSeg(query.channel) ? query.channel : '', '_analytics', 'qc-trends.json');
    let trends = {}; try { trends = JSON.parse(fs.readFileSync(trPath, 'utf8')); } catch (_) {}
    return send(res, 200, JSON.stringify({ trends, recurring: QCT.recurringIssues(trends, 2), videos: Object.keys(trends.videos || {}).length }));
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
      const opener = titleClean + (isQ ? '?' : '.') + ' The real, evidence-based story of how it actually happened.';
      const credit = musicCredit(query.channel);   // CC-BY bed → required attribution; auto-omitted otherwise
      const description = [
        opener, '',
        'CHAPTERS', ...(chapters.length >= 3 ? chapters : ['0:00 ' + title]), '',
        'SOURCES', ...(sources.length ? sources : ['(paste the source list from 01-research/sources.md)']), '',
        ...(credit ? ['MUSIC', credit, ''] : []),
        channelBlurb(query.channel),
        ...channelHashtags(query.channel),
      ].join('\n');
      const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'how', 'why', 'what', 'did', 'was', 'were', 'are', 'is', 'it', 'its', 'their', 'them', 'this', 'that', 'every', 'humans', 'human']);
      const titleWords = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));
      const tags = [...new Set([...titleWords.slice(0, 4).map((w) => w), ...channelTags(query.channel)])].slice(0, 10);
      const pinned = 'Which part surprised you the most? Tell me below — and drop any topic you want fact-checked in a future video. Full source list is in the description.';
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
      // Transcript: the clean spoken narration, in order, with a paragraph break at each segment.
      let transcript = '', tseg = null;
      for (const s of scenes) {
        const n = (s.narration || '').trim(); if (!n) continue;
        if (s.segment && s.segment !== tseg) { transcript += transcript ? '\n\n' : ''; tseg = s.segment; }
        transcript += (transcript && !transcript.endsWith('\n') ? ' ' : '') + n;
      }
      const outDir = path.join(folder, '07-publish'); fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'publish-kit.md'), kit);
      fs.writeFileSync(path.join(outDir, 'description.txt'), description);
      fs.writeFileSync(path.join(outDir, 'transcript.txt'), transcript + '\n');
      return send(res, 200, JSON.stringify({ ok: true, files: ['07-publish/publish-kit.md', '07-publish/description.txt', '07-publish/transcript.txt'], chapters: chapters.length, sources: sources.length, description, tags, pinned, transcript }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: String(e && e.message || e) })); }
  }

  // --- Serve a publish-stage text file for the in-Studio viewer (whitelisted; no need to open files) ---
  if (pathname === '/api/publish-file' && req.method === 'GET') {
    const sp = studioPath(query.channel, query.id);
    if (!sp) return send(res, 400, 'bad', 'text/plain');
    const allow = { 'publish-kit.md': 1, 'description.txt': 1, 'transcript.txt': 1, 'definition-of-done.md': 1, 'shorts-plan.md': 1 };
    if (!allow[query.name]) return send(res, 400, 'not allowed', 'text/plain');
    const f = path.join(path.dirname(sp), '07-publish', query.name);
    if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
  }

  // --- Cost tracker: per-video + total spend estimates ---
  if (pathname === '/api/costs' && req.method === 'GET') {
    // Prefer the itemized event ledger (shows re-render/re-voice spend); fall back to the running totals in
    // usage.json for videos produced before the ledger existed (so historical spend still appears).
    const { perVideo } = COSTS.aggregate(readEvents());
    const u = readUsage();
    const legacy = (v) => { const imagesUsd = COSTS.round2((v.images || 0) * PRICE_PER_IMAGE + (v.imagesPro || 0) * PRICE_PER_IMAGE_PRO), ttsUsd = COSTS.round2(COSTS.ttsUsd(v.ttsChars || 0));
      return { flashImages: v.images || 0, proImages: v.imagesPro || 0, ttsChars: v.ttsChars || 0, ttsCredits: COSTS.round2((v.ttsChars || 0) * COSTS.RATES.ttsCreditsPerChar),
        imagesUsd, ttsUsd, totalUsd: COSTS.round2(imagesUsd + ttsUsd), redoUsd: 0, redoImages: 0, redoChars: 0, events: 0, legacy: true }; };
    // merge: ledger wins; legacy fills in keys the ledger has never seen
    const all = Object.assign({}, perVideo);
    for (const [k, v] of Object.entries(u)) { if (k === 'updatedAt') continue; if (!all[k]) all[k] = legacy(v); }
    // total spans ALL videos (ledger + legacy), so the grand total isn't $0 while the ledger is still filling
    const total = COSTS.blank();
    for (const b of Object.values(all)) {
      total.flashImages += b.flashImages || 0; total.proImages += b.proImages || 0; total.ttsChars += b.ttsChars || 0;
      total.ttsCredits = COSTS.round2(total.ttsCredits + (b.ttsCredits || 0)); total.imagesUsd = COSTS.round2(total.imagesUsd + (b.imagesUsd || 0));
      total.ttsUsd = COSTS.round2(total.ttsUsd + (b.ttsUsd || 0)); total.redoUsd = COSTS.round2(total.redoUsd + (b.redoUsd || 0));
      total.redoImages += b.redoImages || 0; total.redoChars += b.redoChars || 0; total.events += b.events || 0;
    }
    total.totalUsd = COSTS.round2(total.imagesUsd + total.ttsUsd);
    const key = query.channel && query.id ? query.channel + '/' + query.id : null;
    return send(res, 200, JSON.stringify({ video: key ? (all[key] || null) : null, total, perVideo: all, ttsPlan: { usdPerCredit: COSTS.RATES.ttsUsdPerCredit } }));
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
