// One home for "what did this cost" — pricing rates + the append-only usage-event ledger aggregator.
// The old usage.json kept only running TOTALS per video ({images, imagesPro, ttsChars}); it could not
// show how much of a video's spend was RE-RENDERS / RE-VOICES. The event ledger (usage-events.jsonl,
// one JSON object per line) records every generation event with a context tag, so cost can be itemized:
//   { ts, key, type:'image'|'tts', model:'flash'|'pro'|'', units, usd, credits, ctx }
//   ctx ∈ 'initial' | 'rerender' | 'revoice' | 'thumbnail'   (anything not 'initial' is a re-do)
'use strict';

// USD/credit rates. ElevenLabs default = Starter ($5 / 30,000 credits); override via setTtsPlan() if the
// operator upgrades. eleven_turbo_v2_5 bills 0.5 credits per character.
const RATES = {
  imageFlash: 0.039,            // Gemini 2.5 Flash Image, USD/img
  imagePro: 0.134,             // Gemini 3 Pro Image, USD/img
  ttsCreditsPerChar: 0.5,       // eleven_turbo_v2_5
  ttsUsdPerCredit: 5 / 30000,   // Starter plan baseline
};
// Known ElevenLabs plans → USD per credit (monthly $ / included credits).
const TTS_PLANS = { starter: 5 / 30000, creator: 22 / 100000, pro: 99 / 500000 };
function setTtsPlan(plan) { if (TTS_PLANS[plan]) RATES.ttsUsdPerCredit = TTS_PLANS[plan]; return RATES.ttsUsdPerCredit; }

const imageModelKey = (m) => (m === 'pro' || m === 'imagesPro') ? 'pro' : 'flash';
function imageUsd(model, n = 1) { return (imageModelKey(model) === 'pro' ? RATES.imagePro : RATES.imageFlash) * n; }
function ttsCredits(chars) { return Math.max(0, chars || 0) * RATES.ttsCreditsPerChar; }
function ttsUsd(chars) { return ttsCredits(chars) * RATES.ttsUsdPerCredit; }

// Build a ledger event from a logUsage-style patch ({images|imagesPro|ttsChars} + optional ctx). Returns
// null if the patch carries no billable units. ts is injected by the caller (server stamps real time).
function eventFromPatch(patch, key, ts) {
  if (!patch) return null;
  const ctx = patch.ctx || 'initial';
  if (patch.imagesPro) return { ts, key, type: 'image', model: 'pro', units: patch.imagesPro, usd: round4(imageUsd('pro', patch.imagesPro)), ctx };
  if (patch.images) return { ts, key, type: 'image', model: 'flash', units: patch.images, usd: round4(imageUsd('flash', patch.images)), ctx };
  if (patch.ttsChars) return { ts, key, type: 'tts', model: '', units: patch.ttsChars, usd: round4(ttsUsd(patch.ttsChars)), credits: ttsCredits(patch.ttsChars), ctx };
  return null;
}
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Fresh per-video bucket.
function blank() {
  return {
    flashImages: 0, proImages: 0, ttsChars: 0, ttsCredits: 0,
    imagesUsd: 0, ttsUsd: 0, totalUsd: 0,
    redoUsd: 0,            // USD spent on anything that wasn't the first pass (rerenders/revoices/thumbnail)
    redoImages: 0, redoChars: 0,
    events: 0,
  };
}
function addEvent(b, e) {
  const isRedo = e.ctx && e.ctx !== 'initial';
  if (e.type === 'image') {
    if (e.model === 'pro') b.proImages += e.units; else b.flashImages += e.units;
    b.imagesUsd = round4(b.imagesUsd + e.usd);
    if (isRedo) { b.redoImages += e.units; b.redoUsd = round4(b.redoUsd + e.usd); }
  } else if (e.type === 'tts') {
    b.ttsChars += e.units; b.ttsCredits = round2(b.ttsCredits + (e.credits != null ? e.credits : ttsCredits(e.units)));
    b.ttsUsd = round4(b.ttsUsd + e.usd);
    if (isRedo) { b.redoChars += e.units; b.redoUsd = round4(b.redoUsd + e.usd); }
  }
  b.totalUsd = round4(b.imagesUsd + b.ttsUsd);
  b.events++;
  return b;
}

// Aggregate an array of events → { perVideo: {key:bucket}, total: bucket }. Pure (testable).
function aggregate(events) {
  const perVideo = {}; const total = blank();
  for (const e of (events || [])) {
    if (!e || !e.key) continue;
    addEvent(perVideo[e.key] = perVideo[e.key] || blank(), e);
    addEvent(total, e);
  }
  // round display fields
  for (const b of [...Object.values(perVideo), total]) { b.imagesUsd = round2(b.imagesUsd); b.ttsUsd = round2(b.ttsUsd); b.totalUsd = round2(b.totalUsd); b.redoUsd = round2(b.redoUsd); }
  return { perVideo, total };
}

// Parse a usage-events.jsonl blob into an array, tolerating blank/corrupt lines.
function parseLedger(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip a torn line */ }
  }
  return out;
}

module.exports = { RATES, TTS_PLANS, setTtsPlan, imageUsd, ttsCredits, ttsUsd, eventFromPatch, aggregate, parseLedger, blank, round2 };
