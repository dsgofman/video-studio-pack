// Drift guard: CONTEXT/40_STATE.md's "Video status" table is a hand-maintained snapshot (its own
// convention note says "disk-synced, not memory"). Two families of columns get checked here:
//   • QC (pass/warn/fail) — vs each episode's LAST-PERSISTED 07-publish/qc-log.json summary. Three
//     fresh-eyes sweeps in a row (2026-09-08 on 009, 2026-09-13 on 008, 2026-09-18 on 007) each
//     independently re-discovered the SAME drift on a DIFFERENT episode — the 2026-08-24
//     opening-subloops detector fix silently rewrote qc-log.json for all three, but nothing was
//     actually re-checking the table against it; a sweep only caught it when it happened to land on
//     that episode.
//   • Rough cut / Final thumb / Shorts — vs the FILES themselves (there is no persisted log for
//     these, so the filesystem is read directly): 05-edit/rough-cut.mp4 exists, the count of
//     00-packaging/thumbnails/final-*.png, and the count of 05-edit/shorts/*.mp4.
//   • YouTube — vs studio.json's .youtube.videoId, and ONLY two facts in that column: the backticked
//     11-char video ID, and uploaded-vs-not. The cells are free prose ("uploaded …", "**PUBLIC** …",
//     "PRIVATE, uploaded … — known defect …", "not uploaded — …") and .youtube.privacy is a snapshot
//     the operator flips on YouTube's side (001/003 never recorded one), so privacy, dates and titles
//     are never compared — that would cry wolf. studio.json is only ever READ here, never written.
// Pure + testable, like qctrends.js — server.js's /api/qc and the standalone check-state-drift.js
// both call scanChannelDrift() so the two can never disagree.
'use strict';

const fs = require('fs');
const path = require('path');

// The table tracks History/ episodes only ("regenerate it from the actual History/<NNN>/ folders").
// Another channel's 001 is a different episode that merely shares the number, so scanning it against
// these rows would report drift that isn't there.
const STATE_CHANNEL = 'History';

const QC_CELL_RX = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;
const ROW_RX = /^\|\s*(\d{3})\s*\|(.*)\|\s*$/;
const HEADER_RX = /^\|\s*#\s*\|(.*)\|\s*$/;
const DASH_RX = /^[—–-](?:\s|$)/;   // "—" = the episode hasn't reached that step (002's blank template)

// Left-to-right table order, for stable output. 'row' = the episode has no table row at all.
const COLUMN_ORDER = ['row', 'Rough cut', 'Final thumb', 'Shorts', 'QC', 'YouTube'];

// Parse 40_STATE.md's "Video status" table into { "007": {pass,warn,fail}, ... }. A row whose QC
// cell has no NN/NN/NN figure (e.g. "never run") is simply omitted, not recorded as zero.
function parseStateTable(md) {
  const out = {};
  for (const raw of String(md || '').split(/\r?\n/)) {
    const m = ROW_RX.exec(raw.trim());
    if (!m) continue;
    // cells (after the leading "|NNN|" already consumed above): Title, Rough cut, Final thumb, Shorts, QC, YouTube
    const cells = m[2].split('|').map((c) => c.trim());
    const qc = QC_CELL_RX.exec(cells[4] || '');
    if (qc) out[m[1]] = { pass: +qc[1], warn: +qc[2], fail: +qc[3] };
  }
  return out;
}

const plain = (s) => String(s || '').replace(/\*+/g, '').trim();   // **no** → no

// Each returns undefined for a cell it can't read — no claim to check beats a wrong guess.
function parseCutCell(raw) {
  const s = plain(raw);
  if (DASH_RX.test(s)) return false;
  const m = /^(yes|no)\b/i.exec(s);   // "yes, all 53 beats (8:52, …)" · "yes (9:57, ffprobe-measured …)" · "no"
  return m ? m[1].toLowerCase() === 'yes' : undefined;
}
function parseThumbCell(raw) {
  const s = plain(raw);
  if (DASH_RX.test(s)) return { has: false, count: 0 };
  const m = /^(yes|no)\b\s*(?:\((\d+)\))?/i.exec(s);   // "yes (2)" · "no (predates thumb-gen rebuild; …)" · bare "yes"
  if (!m) return undefined;
  if (m[1].toLowerCase() === 'no') return { has: false, count: 0 };
  return { has: true, count: m[2] ? +m[2] : null };   // null = "yes" with no count: presence only
}
function parseShortsCell(raw) {
  const s = plain(raw);
  if (DASH_RX.test(s) || /^(no|none)\b/i.test(s)) return 0;
  const m = /^(\d+)\s+rendered\b/i.exec(s);   // "6 rendered" · "8 rendered — startSec re-synced …"
  return m ? +m[1] : undefined;
}

// Where Rough cut / Final thumb / Shorts / YouTube sit among the cells after the "| # |" cell, found by
// header name so a reordered table still reads right (falls back to the current layout).
function columnIndexes(md) {
  for (const raw of String(md || '').split(/\r?\n/)) {
    const m = HEADER_RX.exec(raw.trim());
    if (!m) continue;
    const names = m[1].split('|').map((c) => c.trim().toLowerCase());
    const at = (rx, dflt) => { const i = names.findIndex((n) => rx.test(n)); return i >= 0 ? i : dflt; };
    return { cut: at(/^rough cut/, 1), thumb: at(/^final thumb/, 2), shorts: at(/^shorts/, 3), youtube: at(/^youtube/, 5) };
  }
  return { cut: 1, thumb: 2, shorts: 3, youtube: 5 };
}

// { "007": { cut: true|false|undefined, thumb: {has,count}|undefined, shorts: N|undefined }, ... }
// Every "NNN" row is recorded (even if all three cells are unreadable) so a folder with NO row can be
// told apart from a row whose cells we simply decline to judge.
function parseStateDiskCells(md) {
  const out = {};
  const idx = columnIndexes(md);
  for (const raw of String(md || '').split(/\r?\n/)) {
    const m = ROW_RX.exec(raw.trim());
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    out[m[1]] = { cut: parseCutCell(cells[idx.cut]), thumb: parseThumbCell(cells[idx.thumb]), shorts: parseShortsCell(cells[idx.shorts]) };
  }
  return out;
}

// A video ID is exactly 11 URL-safe chars, and the table always backticks it. The FIRST such token
// wins; other backticked prose in a cell (`startSec`, `final-1.png`, `___`) isn't 11 chars of [\w-].
const VIDEO_ID_RX = /`([A-Za-z0-9_-]{11})`/;
const NOT_UPLOADED_RX = /^(?:not uploaded|unstarted)\b/i;   // after plain(): "**unstarted** — …" → "unstarted — …"

// One YouTube cell → { id: "<11 chars>"|null, notUploaded: bool }, or undefined when it makes neither
// claim (a bare "uploaded", "PRIVATE", "TBD") — no claim to check beats a wrong guess.
function parseYoutubeCell(raw) {
  const id = VIDEO_ID_RX.exec(String(raw || ''));
  const notUploaded = NOT_UPLOADED_RX.test(plain(raw));
  if (!id && !notUploaded) return undefined;
  return { id: id ? id[1] : null, notUploaded };
}

// { "005": { id, notUploaded }, ... } — rows whose YouTube cell makes no checkable claim are omitted.
function parseStateYoutubeCells(md) {
  const out = {};
  const idx = columnIndexes(md);
  for (const raw of String(md || '').split(/\r?\n/)) {
    const m = ROW_RX.exec(raw.trim());
    if (!m) continue;
    const cell = parseYoutubeCell(m[2].split('|').map((c) => c.trim())[idx.youtube]);
    if (cell) out[m[1]] = cell;
  }
  return out;
}

function countFiles(dir, rx) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && rx.test(d.name)).length; } catch (_) { return 0; }
}

// The disk facts behind the three columns. hasCut reads the same path as listVideos()'s meta.hasCut in
// server.js (which can't be require()d from a test, so the path is repeated here). The other two need
// COUNTS, which listVideos doesn't compute: its meta.thumb is a final-1.png boolean, and its
// meta.shorts counts studio.json's clip CANDIDATES — not the rendered files "N rendered" refers to.
// final-*.png follows the table's own convention note, so final-1.art.png (the pre-overlay art
// layer) counts too — that is how 007 is "yes (4)".
function readDiskFacts(epDir) {
  return {
    hasCut: fs.existsSync(path.join(epDir, '05-edit', 'rough-cut.mp4')),
    finalThumbs: countFiles(path.join(epDir, '00-packaging', 'thumbnails'), /^final-.*\.png$/i),
    shortsRendered: countFiles(path.join(epDir, '05-edit', 'shorts'), /\.mp4$/i),
  };
}

// The one YouTube fact checked: studio.json's .youtube.videoId. READ-ONLY (JSON.parse, never written).
// Returns { videoId: string|null } — null when the file is readable but has no .youtube / no string
// videoId (that IS the "never uploaded" state) — or undefined when studio.json is missing or won't
// parse, i.e. we can't tell, so the check is skipped rather than reported.
function readYoutubeFact(epDir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(epDir, 'studio.json'), 'utf8')); } catch (_) { return undefined; }
  const id = j && j.youtube && typeof j.youtube === 'object' ? j.youtube.videoId : null;
  return { videoId: typeof id === 'string' && id ? id : null };
}

const sortDrift = (arr) => arr.sort((a, b) => a.ep.localeCompare(b.ep) || COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column));

// logsByEpisode: { "007": {pass,warn,fail}, ... } — only episodes with a REAL qc-log.json should be
// passed in; the caller owns that filesystem check. Returns mismatches, worst (missing) first then by id.
function diffAgainstState(stateTable, logsByEpisode) {
  const fmt = (s) => s.pass + '/' + s.warn + '/' + s.fail;
  const out = [];
  for (const [ep, log] of Object.entries(logsByEpisode || {})) {
    if (!log) continue;
    const st = (stateTable || {})[ep];
    if (!st) {
      out.push({ ep, column: 'QC', state: null, log, detail: '40_STATE.md has no pass/warn/fail figure for ' + ep + ', but 07-publish/qc-log.json shows ' + fmt(log) + '.' });
    } else if (st.pass !== log.pass || st.warn !== log.warn || st.fail !== log.fail) {
      out.push({ ep, column: 'QC', state: st, log, detail: '40_STATE.md says ' + fmt(st) + ' for ' + ep + ' but qc-log.json shows ' + fmt(log) + ' — the table is stale.' });
    }
  }
  return sortDrift(out);
}

// cellsByEp: parseStateDiskCells() output; diskByEp: { "007": readDiskFacts(...), ... }. Compares each
// readable cell to the disk fact; an unreadable cell is skipped. A folder with real files but no table
// row is reported too (how 008 "went missing for a month"); an empty folder with no row is not.
function diffDiskColumns(cellsByEp, diskByEp) {
  const out = [];
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  for (const [ep, d] of Object.entries(diskByEp || {})) {
    if (!d) continue;
    const row = (cellsByEp || {})[ep];
    if (!row) {
      const has = [];
      if (d.hasCut) has.push('a rough cut');
      if (d.finalThumbs) has.push(n(d.finalThumbs, 'final thumbnail', 'final thumbnails'));
      if (d.shortsRendered) has.push(n(d.shortsRendered, 'rendered Short', 'rendered Shorts'));
      if (has.length) out.push({ ep, column: 'row', state: null, disk: d, detail: '40_STATE.md has no row for ' + ep + ', but its folder has ' + has.join(', ') + '.' });
      continue;
    }
    if (row.cut !== undefined && row.cut !== d.hasCut) {
      out.push({ ep, column: 'Rough cut', state: row.cut, disk: d.hasCut, detail: row.cut
        ? '40_STATE.md says "yes" for ' + ep + '\'s Rough cut but there is no 05-edit/rough-cut.mp4 on disk — the table is stale.'
        : '40_STATE.md says "no" for ' + ep + '\'s Rough cut but 05-edit/rough-cut.mp4 exists — the table is stale.' });
    }
    const th = row.thumb;
    if (th !== undefined) {
      const off = th.has ? (d.finalThumbs === 0 || (th.count !== null && th.count !== d.finalThumbs)) : d.finalThumbs > 0;
      if (off) {
        const claim = th.has ? (th.count !== null ? 'yes (' + th.count + ')' : 'yes') : 'no';
        out.push({ ep, column: 'Final thumb', state: th, disk: d.finalThumbs, detail: '40_STATE.md says "' + claim + '" for ' + ep + '\'s Final thumb but 00-packaging/thumbnails has ' + (d.finalThumbs || 'no') + ' final-*.png — the table is stale.' });
      }
    }
    if (row.shorts !== undefined && row.shorts !== d.shortsRendered) {
      out.push({ ep, column: 'Shorts', state: row.shorts, disk: d.shortsRendered, detail: '40_STATE.md says "' + row.shorts + ' rendered" for ' + ep + '\'s Shorts but 05-edit/shorts has ' + (d.shortsRendered || 'no') + ' *.mp4 — the table is stale.' });
    }
  }
  return sortDrift(out);
}

// cellsByEp: parseStateYoutubeCells() output; factsByEp: { "005": readYoutubeFact(...), ... }. Three
// rules, nothing else (no privacy / dates / titles): (a) a cell ID must equal .youtube.videoId (exact,
// case-sensitive); (b) a "not uploaded" / "unstarted" cell while .youtube.videoId exists; (c) a cell ID
// while .youtube has no videoId. A cell that makes no claim, an episode with no table row, and an
// episode whose studio.json couldn't be read are all skipped. One entry per cell — (b) wins over (a)/(c).
function diffYoutubeColumn(cellsByEp, factsByEp) {
  const out = [];
  for (const [ep, fact] of Object.entries(factsByEp || {})) {
    const cell = (cellsByEp || {})[ep];
    if (!fact || !cell) continue;
    const rec = fact.videoId;
    let detail = null;
    if (cell.notUploaded && rec) {
      detail = '40_STATE.md marks ' + ep + '\'s YouTube as "not uploaded" / "unstarted" but studio.json records videoId ' + rec + ' — the table is stale.';
    } else if (cell.id && !rec) {
      detail = '40_STATE.md gives ' + ep + '\'s YouTube video ID as ' + cell.id + ' but studio.json has no .youtube.videoId — the table is stale.';
    } else if (cell.id && cell.id !== rec) {
      detail = '40_STATE.md gives ' + ep + '\'s YouTube video ID as ' + cell.id + ' but studio.json records ' + rec + ' — the table is stale.';
    }
    if (detail) out.push({ ep, column: 'YouTube', state: cell, disk: rec, detail });
  }
  return sortDrift(out);
}

// fs-touching convenience: read CONTEXT/40_STATE.md, then for every episode folder under
// <root>/<channel>/<NNN-*>/ read its persisted 07-publish/qc-log.json, its disk facts AND its
// studio.json .youtube.videoId, and diff.
// Returns [] (never throws) when the state file or channel folder can't be read, or when `channel`
// isn't the one the table tracks.
function scanChannelDrift(root, channel) {
  if (channel !== STATE_CHANNEL) return [];
  let stateMd = '';
  try { stateMd = fs.readFileSync(path.join(root, 'CONTEXT', '40_STATE.md'), 'utf8'); } catch (_) { return []; }
  const stateTable = parseStateTable(stateMd);
  const diskCells = parseStateDiskCells(stateMd);
  const youtubeCells = parseStateYoutubeCells(stateMd);
  const chDir = path.join(root, channel);
  let dirs = [];
  try { dirs = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { return []; }
  const logsByEpisode = {};
  const diskByEpisode = {};
  const youtubeByEpisode = {};
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const m = /^(\d{3})/.exec(d.name);
    if (!m) continue;
    diskByEpisode[m[1]] = readDiskFacts(path.join(chDir, d.name));
    youtubeByEpisode[m[1]] = readYoutubeFact(path.join(chDir, d.name));
    const logPath = path.join(chDir, d.name, '07-publish', 'qc-log.json');
    try {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      if (log && log.summary) logsByEpisode[m[1]] = log.summary;
    } catch (_) { /* no qc-log.json yet — nothing to compare */ }
  }
  return sortDrift([
    ...diffAgainstState(stateTable, logsByEpisode),
    ...diffDiskColumns(diskCells, diskByEpisode),
    ...diffYoutubeColumn(youtubeCells, youtubeByEpisode),
  ]);
}

module.exports = {
  parseStateTable, parseStateDiskCells, parseStateYoutubeCells, diffAgainstState, diffDiskColumns, diffYoutubeColumn,
  readDiskFacts, readYoutubeFact, scanChannelDrift,
  STATE_CHANNEL, QC_CELL_RX, ROW_RX,
};
