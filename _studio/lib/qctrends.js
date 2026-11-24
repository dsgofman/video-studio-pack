// QC feedback loop: turn each video's QC run into a durable record + a cross-video rollup, so recurring
// Definition-of-Done failures become visible and get fixed at the GENERATOR level instead of recurring.
// Pure + testable; server.js persists per-video snapshots (07-publish/qc-log.json) and a per-channel
// rollup (<channel>/_analytics/qc-trends.json), and Claude reads the rollup each session.
'use strict';

const LEVELS = ['fail', 'warn', 'pass'];

// {pass, warn, fail} counts for a checks array.
function summarize(checks) {
  const s = { pass: 0, warn: 0, fail: 0 };
  for (const c of (checks || [])) if (s[c.level] != null) s[c.level]++;
  return s;
}

// Stable map checkId -> level (used both for the rollup and for change-detection).
function levelsMap(checks) {
  const m = {};
  for (const c of (checks || [])) m[c.id] = c.level;
  return m;
}

// A short stable signature of an outcome, so we only re-persist when the QC RESULT actually changed
// (the tab may re-request /api/qc repeatedly; we don't want to rewrite files or inflate trends each time).
function signature(checks) {
  return (checks || []).map((c) => c.id + ':' + c.level).sort().join('|');
}

// Update the per-channel rollup with one video's latest snapshot. Keyed by videoId → idempotent (a
// re-run overwrites that video's entry, never double-counts). Recomputes the cross-video byCheck tally.
// snapshot = { ts, summary, checks:[{id,level,detail}] }. Returns a NEW trends object.
function updateTrends(prev, videoId, snapshot, nowIso) {
  const trends = { videos: Object.assign({}, (prev && prev.videos) || {}), byCheck: {}, updatedAt: nowIso || (snapshot && snapshot.ts) || '' };
  trends.videos[videoId] = {
    ts: snapshot.ts || trends.updatedAt,
    summary: snapshot.summary || summarize(snapshot.checks),
    levels: levelsMap(snapshot.checks),
    fails: (snapshot.checks || []).filter((c) => c.level === 'fail').map((c) => c.id),
    warns: (snapshot.checks || []).filter((c) => c.level === 'warn').map((c) => c.id),
  };
  // tally: for each check id, how many videos pass/warn/fail it + which videos warn/fail
  const byCheck = {};
  for (const [vid, v] of Object.entries(trends.videos)) {
    for (const [cid, lvl] of Object.entries(v.levels || {})) {
      const b = byCheck[cid] = byCheck[cid] || { fail: 0, warn: 0, pass: 0, failVideos: [], warnVideos: [] };
      if (b[lvl] != null) b[lvl]++;
      if (lvl === 'fail') b.failVideos.push(vid);
      else if (lvl === 'warn') b.warnVideos.push(vid);
    }
  }
  trends.byCheck = byCheck;
  return trends;
}

// The actionable list: checks that fail/warn across >= minVideos DISTINCT videos — i.e. systemic, not a
// one-off. Sorted worst-first (fails weigh more than warns, then by breadth). This is what Claude acts on:
// a check recurring here means fix the GENERATOR/guard, not the individual video.
function recurringIssues(trends, minVideos) {
  minVideos = minVideos || 2;
  const out = [];
  for (const [id, b] of Object.entries((trends && trends.byCheck) || {})) {
    const affected = new Set([...(b.failVideos || []), ...(b.warnVideos || [])]);
    if (affected.size >= minVideos) {
      out.push({ id, fail: b.fail || 0, warn: b.warn || 0, videos: affected.size, videoIds: [...affected] });
    }
  }
  out.sort((a, b) => (b.fail - a.fail) || (b.warn - a.warn) || (b.videos - a.videos) || a.id.localeCompare(b.id));
  return out;
}

module.exports = { LEVELS, summarize, levelsMap, signature, updateTrends, recurringIssues };
