// Pexels real-artifact image search — pure URL/selection/attribution helpers. The HTTP call + download
// live in server.js; this is the testable logic. Used for occasional "here's the ACTUAL thing" cutaways
// (the real Ötzi mummy, real cave art, a real site) rendered as field-guide specimen plates against the
// cartoon — credibility without diluting the animated identity (artifacts-only, per the channel decision).
'use strict';

const API = 'https://api.pexels.com/v1/search';
const VIDEO_API = 'https://api.pexels.com/videos/search';

// Build a Pexels search URL. query is the artifact/site phrase; landscape suits our 16:9 plates.
function searchUrl(query, opts = {}) {
  const perPage = opts.perPage || 15;
  const orientation = opts.orientation || 'landscape';
  const q = new URLSearchParams({ query: String(query || '').trim().slice(0, 120), per_page: String(perPage), orientation });
  return API + '?' + q.toString();
}

// Tokenize a phrase to content words (drop the stop-words that pollute a match score). Used to
// score how well a Pexels result's alt/slug matches what we actually searched for.
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'real', 'actual', 'photo', 'image', 'picture', 'ancient', 'old', 'to', 'in', 'on', 'at', 'is', 'it']);
function terms(s) {
  // Fold diacritics to ASCII first (Ötzi → Otzi) so an accented artifact name matches the ASCII
  // spelling stock alts use, THEN drop punctuation/stop-words/short tokens.
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}
// How many of the QUERY's content words appear in a candidate's descriptive text (alt/url slug).
function relevanceScore(query, text) {
  const want = terms(query); if (!want.length) return 0;
  const hay = new Set(terms(text));
  let hit = 0; for (const w of want) if (hay.has(w)) hit++;
  return hit / want.length;                                   // 0..1 fraction of query terms matched
}

// Pick the best photo. Pexels ranks by relevance already, but for a SPECIFIC artifact/site we care
// that the alt text actually mentions the thing (stock searches drift off-topic fast). So among the
// wide-enough landscape results, prefer the one whose alt/url best matches the query; only fall back
// to raw Pexels order (then the first result) when nothing describes itself usefully. Returns null if empty.
function pickBest(photos, opts = {}) {
  const minWidth = opts.minWidth || 1200;
  const query = opts.query || '';
  const list = (photos || []).filter((p) => p && p.src);
  if (!list.length) return null;
  const wide = list.filter((p) => (p.width || 0) >= minWidth && (p.width || 0) >= (p.height || 0));
  const pool = wide.length ? wide : list;
  if (query) {
    let best = null, bestScore = -1;
    pool.forEach((p, i) => {
      const score = relevanceScore(query, (p.alt || '') + ' ' + (p.url || ''));
      // tie-break toward Pexels' own ranking (earlier = better) via a tiny position penalty
      const adj = score - i * 0.001;
      if (adj > bestScore) { bestScore = adj; best = p; }
    });
    if (best && relevanceScore(query, (best.alt || '') + ' ' + (best.url || '')) > 0) return best;
  }
  return pool[0];
}

// Choose a render-appropriate source URL (~1880w large2x preferred, down to medium).
function bestSrc(photo) {
  const s = (photo && photo.src) || {};
  return s.large2x || s.large || s.original || s.medium || '';
}

// Attribution to record (Pexels needs none, but we log it for the description + good practice).
function attribution(photo) {
  photo = photo || {};
  return {
    id: photo.id || null,
    photographer: photo.photographer || '',
    photographerUrl: photo.photographer_url || '',
    pexelsUrl: photo.url || '',
    alt: photo.alt || '',
  };
}

// ---- VIDEO search (the free real-footage half — used ONLY for the actual artifact/site, rendered
// inside the same field-guide specimen plate; a real fossil slowly panning beats a still, and it's
// free vs. Veo). Same key/Authorization header as the image API. ----
function videoSearchUrl(query, opts = {}) {
  const perPage = opts.perPage || 15;
  const orientation = opts.orientation || 'landscape';
  const q = new URLSearchParams({ query: String(query || '').trim().slice(0, 120), per_page: String(perPage), orientation });
  return VIDEO_API + '?' + q.toString();
}

// Choose the best VIDEO from a Pexels /videos/search response. We want: landscape, a SANE duration
// (long enough to hold/loop under a beat, not a half-second sting; not a 2-minute clip), a usable
// mp4 file, and — for a specific artifact — alt-ish relevance from the video's url slug. Returns the
// chosen video object or null.
function pickBestVideo(videos, opts = {}) {
  const query = opts.query || '';
  const minDur = opts.minDur || 3;            // seconds — shorter than this loops too obviously
  const maxDur = opts.maxDur || 40;           // seconds — beyond this it's a long clip, not a cutaway
  const list = (videos || []).filter((v) => v && Array.isArray(v.video_files) && v.video_files.some((f) => /mp4/i.test(f.file_type || '') && f.link));
  if (!list.length) return null;
  const landscape = list.filter((v) => (v.width || 0) >= (v.height || 0));
  const pool = landscape.length ? landscape : list;
  const durOk = pool.filter((v) => (v.duration || 0) >= minDur && (v.duration || 0) <= maxDur);
  const cand = durOk.length ? durOk : pool;
  if (query) {
    let best = null, bestScore = -1;
    cand.forEach((v, i) => {
      const score = relevanceScore(query, v.url || '') - i * 0.001;   // tie-break toward Pexels order
      if (score > bestScore) { bestScore = score; best = v; }
    });
    if (best && relevanceScore(query, best.url || '') > 0) return best;
  }
  return cand[0];
}

// Pick the render-appropriate mp4 FILE from a chosen video: closest to ~1080p WITHOUT grabbing the
// huge 4K "original" (bandwidth + render cost). Prefer mp4, landscape, height nearest 1080 but never
// wildly above; degrade to the largest available under a cap, then whatever mp4 exists.
function bestVideoFile(video, opts = {}) {
  const target = opts.targetHeight || 1080;
  const cap = opts.maxHeight || 1440;                          // don't pull 4K
  const files = ((video && video.video_files) || []).filter((f) => f && f.link && /mp4/i.test(f.file_type || ''));
  if (!files.length) return '';
  const land = files.filter((f) => (f.width || 0) >= (f.height || 0));
  const pool = land.length ? land : files;
  const under = pool.filter((f) => (f.height || 0) <= cap);
  const rank = (under.length ? under : pool).slice().sort((a, b) =>
    Math.abs((a.height || 0) - target) - Math.abs((b.height || 0) - target));
  return (rank[0] && rank[0].link) || '';
}

// Attribution for a video (Pexels credits the `user`, not a `photographer`).
function videoAttribution(video) {
  video = video || {};
  const u = video.user || {};
  return {
    id: video.id || null,
    photographer: u.name || '',
    photographerUrl: u.url || '',
    pexelsUrl: video.url || '',
    duration: video.duration || 0,
  };
}

module.exports = { API, VIDEO_API, searchUrl, pickBest, bestSrc, attribution, terms, relevanceScore, videoSearchUrl, pickBestVideo, bestVideoFile, videoAttribution };
