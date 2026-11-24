'use strict';

// Deterministic core for multi-platform Shorts distribution.
// Pure logic: safe-area geometry + per-platform caption building.

const fs = require('fs');
const path = require('path');

const PLATFORMS = ['youtube', 'tiktok', 'instagram'];

// Common safe box across all 3 apps, in px within a 1080x1920 frame.
// Big bottom band leaves room for captions/CTAs/handles overlaid by each app.
const UNIVERSAL_SAFE = { top: 110, bottom: 330, left: 60, right: 120 };

// Built-in per-platform hashtag defaults (generic; a channel overrides them in _assets/shorts-hashtags.json).
const DEFAULT_HASHTAGS = {
  youtube: ['#Shorts'],
  tiktok: ['#fyp', '#foryou', '#didyouknow', '#learnontiktok'],
  instagram: ['#didyouknow', '#learnoninstagram', '#explained'],
};

// Workspace root: this file is _studio/lib/, so root is two levels up (the project root).
const ROOT = path.join(__dirname, '..', '..');

// Remove any clickable link tokens from a string.
function stripUrls(s) {
  if (!s) return '';
  return String(s)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\byoutu\.be\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Horizontally-centered rect within the central square of a 9:16 frame.
function coverTextRect(W, H) {
  const w = Math.round(W * 0.86);
  const h = Math.round(W * 0.5);
  const x = Math.round((W - w) / 2);
  const y = Math.round(H / 2 - h / 2);
  return { x, y, w, h };
}

// Per-platform hashtag arrays; merges <ROOT>/<channel>/_assets/shorts-hashtags.json over defaults.
function defaultHashtags(channel) {
  const out = {
    youtube: DEFAULT_HASHTAGS.youtube.slice(),
    tiktok: DEFAULT_HASHTAGS.tiktok.slice(),
    instagram: DEFAULT_HASHTAGS.instagram.slice(),
  };
  if (channel) {
    try {
      const p = path.join(ROOT, channel, '_assets', 'shorts-hashtags.json');
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const k of PLATFORMS) {
          if (Array.isArray(j[k]) && j[k].length) out[k] = j[k].slice();
        }
      }
    } catch (_) { /* fall back to defaults */ }
  }
  return out;
}

function firstSentence(s) {
  if (!s) return '';
  const m = String(s).split(/[.!?]/)[0];
  return (m || '').trim();
}

function capitalize(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function buildCaption(platform, clip, ctx) {
  clip = clip || {};
  ctx = ctx || {};

  if (platform === 'youtube') {
    let c = String(clip.postCaption || '').trim();
    if (!/#Shorts/i.test(c)) c += ' #Shorts';
    if (ctx.longUrl && !c.includes(ctx.longUrl)) c += '\n\n' + ctx.longUrl;
    return c;
  }

  if (platform === 'tiktok' || platform === 'instagram') {
    let hook = clip.hook && String(clip.hook).trim() ? String(clip.hook).trim() : firstSentence(clip.postCaption);
    hook = stripUrls(hook);

    let c = hook;

    if (platform === 'instagram' && clip.bigLoop) {
      const bl = String(clip.bigLoop).trim();
      if (bl) c += '\n\n' + capitalize(bl) + (/[?]$/.test(bl) ? '' : '?');
    }

    c += '\n\nFull video on YouTube — link in bio 🔗';
    c += '\n\n' + defaultHashtags(ctx.channel)[platform].join(' ');

    // Guarantee no clickable link survives.
    return stripUrls(c);
  }

  throw new Error('Unknown platform: ' + platform);
}

module.exports = {
  PLATFORMS,
  UNIVERSAL_SAFE,
  coverTextRect,
  defaultHashtags,
  buildCaption,
  stripUrls,
};
