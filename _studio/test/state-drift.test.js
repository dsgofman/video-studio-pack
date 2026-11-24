const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SD = require('../lib/state-drift.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

function mkEpisode(root, name, { cut, finals = [], shorts = [], other = {} } = {}) {
  const ep = path.join(root, 'History', name);
  fs.mkdirSync(path.join(ep, '05-edit', 'shorts'), { recursive: true });
  fs.mkdirSync(path.join(ep, '00-packaging', 'thumbnails'), { recursive: true });
  if (cut) fs.writeFileSync(path.join(ep, '05-edit', 'rough-cut.mp4'), 'x');
  for (const n of finals) fs.writeFileSync(path.join(ep, '00-packaging', 'thumbnails', n), 'x');
  for (const n of shorts) fs.writeFileSync(path.join(ep, '05-edit', 'shorts', n), 'x');
  for (const [rel, body] of Object.entries(other)) fs.writeFileSync(path.join(ep, rel), body);
  return ep;
}
function mkRoot(stateMd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-drift-'));
  fs.mkdirSync(path.join(root, 'CONTEXT'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CONTEXT', '40_STATE.md'), stateMd);
  return root;
}

// disk state matching SAMPLE_TABLE's 007 row ("yes" / "yes (4)" / "7 rendered")
const SEVEN_DISK = {
  cut: true,
  finals: ['final-1.png', 'final-1.art.png', 'final-2.png', 'final-3.png'],
  shorts: ['1.mp4', '2.mp4', '3.mp4', '4.mp4', '5.mp4', '6.mp4', '7.mp4'],
};


const SAMPLE_TABLE = [
  '| # | Title | Rough cut | Final thumb | Shorts | QC (pass/warn/fail) | YouTube |',
  '|---|---|---|---|---|---|---|',
  '| 001 | How Did Humans End Up on Every Continent? | yes | yes (2) | 6 rendered | never run | uploaded |',
  '| 004 | Was Homo Erectus the Apex Human? | yes | no | 8 rendered | **25/6/0 (2026-08-21)** — all 3 length-related fails resolved | not uploaded |',
  '| 007 | Your Anxiety is Built for a World That\'s Long Gone | yes | yes (4) | 7 rendered | 32/3/0 (2026-08-24; reconfirmed live 2026-09-18 fresh-eyes sweep, no drift) | PRIVATE |',
].join('\n');

t('parseStateTable extracts pass/warn/fail from a plain cell', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  assert.deepStrictEqual(table['007'], { pass: 32, warn: 3, fail: 0 });
});
t('parseStateTable extracts the figure even when bold-wrapped with trailing prose', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  assert.deepStrictEqual(table['004'], { pass: 25, warn: 6, fail: 0 });
});
t('parseStateTable omits a row whose QC cell has no NN/NN/NN figure ("never run")', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  assert.strictEqual('001' in table, false);
});
t('parseStateTable ignores the header and separator rows', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  assert.strictEqual(Object.keys(table).length, 2);
});

t('diffAgainstState reports no mismatch when the figures match', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  const out = SD.diffAgainstState(table, { '007': { pass: 32, warn: 3, fail: 0 } });
  assert.deepStrictEqual(out, []);
});
t('diffAgainstState catches a deliberately staled STATE row', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  const out = SD.diffAgainstState(table, { '007': { pass: 29, warn: 4, fail: 0 } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ep, '007');
  assert.ok(/40_STATE\.md says 32\/3\/0 for 007 but qc-log\.json shows 29\/4\/0/.test(out[0].detail));
});
t('diffAgainstState flags a qc-log.json with no matching STATE figure at all', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  const out = SD.diffAgainstState(table, { '001': { pass: 5, warn: 0, fail: 0 } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].state, null);
});
t('diffAgainstState ignores episodes with no persisted log (nullish entries)', () => {
  const table = SD.parseStateTable(SAMPLE_TABLE);
  const out = SD.diffAgainstState(table, { '007': null });
  assert.deepStrictEqual(out, []);
});

t('scanChannelDrift is clean against a fixture channel that matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-drift-'));
  fs.mkdirSync(path.join(root, 'CONTEXT'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CONTEXT', '40_STATE.md'), SAMPLE_TABLE);
  mkEpisode(root, '007-anxiety', SEVEN_DISK);
  fs.mkdirSync(path.join(root, 'History', '007-anxiety', '07-publish'), { recursive: true });
  fs.writeFileSync(path.join(root, 'History', '007-anxiety', '07-publish', 'qc-log.json'), JSON.stringify({ summary: { pass: 32, warn: 3, fail: 0 } }));
  assert.deepStrictEqual(SD.scanChannelDrift(root, 'History'), []);
  fs.rmSync(root, { recursive: true, force: true });
});
t('scanChannelDrift catches a fixture channel whose qc-log.json disagrees with 40_STATE.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-drift-'));
  fs.mkdirSync(path.join(root, 'CONTEXT'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CONTEXT', '40_STATE.md'), SAMPLE_TABLE);
  mkEpisode(root, '007-anxiety', SEVEN_DISK);
  fs.mkdirSync(path.join(root, 'History', '007-anxiety', '07-publish'), { recursive: true });
  fs.writeFileSync(path.join(root, 'History', '007-anxiety', '07-publish', 'qc-log.json'), JSON.stringify({ summary: { pass: 1, warn: 1, fail: 1 } }));
  const out = SD.scanChannelDrift(root, 'History');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ep, '007');
  fs.rmSync(root, { recursive: true, force: true });
});
t('scanChannelDrift returns [] when 40_STATE.md is missing rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-drift-'));
  fs.mkdirSync(path.join(root, 'History'), { recursive: true });
  assert.deepStrictEqual(SD.scanChannelDrift(root, 'History'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── disk-fact columns: Rough cut / Final thumb / Shorts vs the actual files ──────────────────────
// Cell phrasings below are lifted from the real 40_STATE.md rows (they vary a lot per row).
const DISK_TABLE = [
  '| # | Title | Rough cut | Final thumb | Shorts | QC (pass/warn/fail) | YouTube |',
  '|---|---|---|---|---|---|---|',
  '| 001 | One | yes | yes (2) | 6 rendered | never run | uploaded |',
  '| 002 | Blank template | — | — | — | — | **unstarted** |',
  '| 004 | Four | yes, all 53 beats (8:52, re-assembled 2026-08-20 10:24 local) | **no** — title decided; awaiting final art | 8 rendered — `startSec` re-synced to the reassembled timeline | 25/6/0 | not uploaded |',
  '| 005 | Five | yes (9:57, ffprobe-measured 2026-09-08) | no (predates thumb-gen rebuild; custom art set at upload) | 0 rendered | 26/3/0 | PUBLIC |',
  '| 006 | Six | yes | yes | TBD | 27/3/0 | PUBLIC |',
].join('\n');

t('parseStateDiskCells reads Rough cut yes/no/— across the real phrasings', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  assert.strictEqual(c['001'].cut, true);
  assert.strictEqual(c['002'].cut, false);
  assert.strictEqual(c['004'].cut, true);   // "yes, all 53 beats (8:52, ...)"
  assert.strictEqual(c['005'].cut, true);   // "yes (9:57, ffprobe-measured ...)"
});
t('parseStateDiskCells reads Final thumb: "yes (N)", bold **no**, "no (…prose)", —, bare yes', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  assert.deepStrictEqual(c['001'].thumb, { has: true, count: 2 });
  assert.deepStrictEqual(c['002'].thumb, { has: false, count: 0 });
  assert.deepStrictEqual(c['004'].thumb, { has: false, count: 0 });
  assert.deepStrictEqual(c['005'].thumb, { has: false, count: 0 });
  assert.deepStrictEqual(c['006'].thumb, { has: true, count: null });   // "yes" with no count: presence only
});
t('parseStateDiskCells reads Shorts "N rendered" (trailing prose ok), — and 0 rendered', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  assert.strictEqual(c['001'].shorts, 6);
  assert.strictEqual(c['002'].shorts, 0);
  assert.strictEqual(c['004'].shorts, 8);
  assert.strictEqual(c['005'].shorts, 0);
});
t('parseStateDiskCells leaves a cell it cannot read undefined (no brittle guess)', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  assert.strictEqual(c['006'].shorts, undefined);   // "TBD"
});
t('parseStateDiskCells finds columns by header name, so a reordered table still parses', () => {
  const md = [
    '| # | Title | Shorts | Rough cut | QC | Final thumb | YouTube |',
    '|---|---|---|---|---|---|---|',
    '| 010 | X | 3 rendered | no | 1/2/3 | yes (5) | uploaded |',
  ].join('\n');
  const c = SD.parseStateDiskCells(md)['010'];
  assert.strictEqual(c.shorts, 3);
  assert.strictEqual(c.cut, false);
  assert.deepStrictEqual(c.thumb, { has: true, count: 5 });
});
t('parseStateDiskCells survives a short row and empty input without throwing', () => {
  assert.deepStrictEqual(SD.parseStateDiskCells(''), {});
  const c = SD.parseStateDiskCells('| 011 | Only a title |');
  assert.strictEqual(c['011'].cut, undefined);
});

const fx = (o) => Object.assign({ hasCut: false, finalThumbs: 0, shortsRendered: 0 }, o);
t('diffDiskColumns is clean when every disk fact matches the table', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  const out = SD.diffDiskColumns(c, {
    '001': fx({ hasCut: true, finalThumbs: 2, shortsRendered: 6 }),
    '002': fx({}),
    '004': fx({ hasCut: true, finalThumbs: 0, shortsRendered: 8 }),
    '005': fx({ hasCut: true }),
  });
  assert.deepStrictEqual(out, []);
});
t('diffDiskColumns catches a stale Rough cut (table yes, file missing) and the reverse', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  let out = SD.diffDiskColumns(c, { '001': fx({ hasCut: false, finalThumbs: 2, shortsRendered: 6 }) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].column, 'Rough cut');
  assert.ok(/says "yes".*001.*no 05-edit\/rough-cut\.mp4/.test(out[0].detail), out[0].detail);
  out = SD.diffDiskColumns(c, { '002': fx({ hasCut: true }) });   // table "—", file exists
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].column, 'Rough cut');
  assert.ok(/rough-cut\.mp4 exists/.test(out[0].detail), out[0].detail);
});
t('diffDiskColumns catches a stale Final thumb count, a missing-art "yes", and a surprise "no"', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  let out = SD.diffDiskColumns(c, { '001': fx({ hasCut: true, finalThumbs: 3, shortsRendered: 6 }) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].column, 'Final thumb');
  assert.ok(/yes \(2\)/.test(out[0].detail) && /3 final-\*\.png/.test(out[0].detail), out[0].detail);
  out = SD.diffDiskColumns(c, { '001': fx({ hasCut: true, finalThumbs: 0, shortsRendered: 6 }) });
  assert.strictEqual(out[0].column, 'Final thumb');
  out = SD.diffDiskColumns(c, { '004': fx({ hasCut: true, finalThumbs: 1, shortsRendered: 8 }) });   // table **no**
  assert.strictEqual(out.length, 1);
  assert.ok(/says "no"/.test(out[0].detail), out[0].detail);
});
t('diffDiskColumns treats a bare "yes" Final thumb as presence-only (any count passes, zero fails)', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  assert.deepStrictEqual(SD.diffDiskColumns(c, { '006': fx({ hasCut: true, finalThumbs: 4 }) }), []);
  const out = SD.diffDiskColumns(c, { '006': fx({ hasCut: true, finalThumbs: 0 }) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].column, 'Final thumb');
});
t('diffDiskColumns catches a stale Shorts count', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  const out = SD.diffDiskColumns(c, { '004': fx({ hasCut: true, shortsRendered: 7 }) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].column, 'Shorts');
  assert.ok(/8 rendered/.test(out[0].detail) && /7 \*\.mp4/.test(out[0].detail), out[0].detail);
});
t('diffDiskColumns reports several columns of one episode as separate entries, in table order', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  const out = SD.diffDiskColumns(c, { '001': fx({ hasCut: false, finalThumbs: 9, shortsRendered: 1 }) });
  assert.deepStrictEqual(out.map((m) => m.column), ['Rough cut', 'Final thumb', 'Shorts']);
});
t('diffDiskColumns skips an unreadable cell instead of guessing', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  assert.deepStrictEqual(SD.diffDiskColumns(c, { '006': fx({ hasCut: true, finalThumbs: 1, shortsRendered: 99 }) }), []);
});
t('diffDiskColumns flags an episode folder with real files but no table row; ignores an empty one', () => {
  const c = SD.parseStateDiskCells(DISK_TABLE);
  const out = SD.diffDiskColumns(c, {
    '008': fx({ hasCut: true, finalThumbs: 2, shortsRendered: 6 }),
    '009': fx({}),
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ep, '008');
  assert.strictEqual(out[0].column, 'row');
  assert.ok(/no row for 008/.test(out[0].detail) && /rough cut/.test(out[0].detail), out[0].detail);
});

t('readDiskFacts counts final-*.png (incl. final-N.art.png, per the table\'s own convention) and shorts *.mp4 only', () => {
  const root = mkRoot('');
  const ep = mkEpisode(root, '007-x', {
    cut: true,
    finals: ['final-1.png', 'final-1.art.png', 'final-2.png', 'still-watching.jpg', 'README.md', 'finished-thumbnail.png'],
    shorts: ['a.mp4', 'a.status.json', 'a.cover.png', 'a.en.srt', 'b.mp4', 'render.log'],
  });
  assert.deepStrictEqual(SD.readDiskFacts(ep), { hasCut: true, finalThumbs: 3, shortsRendered: 2 });
  fs.rmSync(root, { recursive: true, force: true });
});
t('readDiskFacts is all-empty (never throws) for a folder with none of the subdirs', () => {
  const root = mkRoot('');
  const ep = path.join(root, 'History', '002-blank');
  fs.mkdirSync(ep, { recursive: true });
  assert.deepStrictEqual(SD.readDiskFacts(ep), { hasCut: false, finalThumbs: 0, shortsRendered: 0 });
  fs.rmSync(root, { recursive: true, force: true });
});

const FIXTURE_STATE = [
  '| # | Title | Rough cut | Final thumb | Shorts | QC (pass/warn/fail) | YouTube |',
  '|---|---|---|---|---|---|---|',
  '| 001 | One | yes | yes (2) | 2 rendered | 4/0/0 | uploaded |',
  '| 002 | Blank | — | — | — | — | **unstarted** |',
].join('\n');
function fixtureChannel() {
  const root = mkRoot(FIXTURE_STATE);
  mkEpisode(root, '001-one', {
    cut: true, finals: ['final-1.png', 'final-2.png'], shorts: ['a.mp4', 'b.mp4', 'a.status.json'],
    other: {},
  });
  fs.mkdirSync(path.join(root, 'History', '001-one', '07-publish'), { recursive: true });
  fs.writeFileSync(path.join(root, 'History', '001-one', '07-publish', 'qc-log.json'), JSON.stringify({ summary: { pass: 4, warn: 0, fail: 0 } }));
  mkEpisode(root, '002-blank', {});
  return root;
}
t('scanChannelDrift is clean when the table matches the disk facts AND the qc-log', () => {
  const root = fixtureChannel();
  assert.deepStrictEqual(SD.scanChannelDrift(root, 'History'), []);
  fs.rmSync(root, { recursive: true, force: true });
});
t('scanChannelDrift catches a deliberately staled value in EACH of Rough cut / Final thumb / Shorts', () => {
  const cases = [
    ['| 001 | One | no | yes (2) | 2 rendered | 4/0/0 | uploaded |', 'Rough cut'],
    ['| 001 | One | yes | yes (3) | 2 rendered | 4/0/0 | uploaded |', 'Final thumb'],
    ['| 001 | One | yes | yes (2) | 5 rendered | 4/0/0 | uploaded |', 'Shorts'],
  ];
  for (const [row, column] of cases) {
    const root = fixtureChannel();
    fs.writeFileSync(path.join(root, 'CONTEXT', '40_STATE.md'), FIXTURE_STATE.replace(/^\| 001 .*$/m, row));
    const out = SD.scanChannelDrift(root, 'History');
    assert.strictEqual(out.length, 1, column + ': ' + JSON.stringify(out));
    assert.strictEqual(out[0].ep, '001');
    assert.strictEqual(out[0].column, column);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
t('scanChannelDrift reports QC-column and disk-column drift together, each tagged with its column', () => {
  const root = fixtureChannel();
  fs.writeFileSync(path.join(root, 'CONTEXT', '40_STATE.md'), FIXTURE_STATE.replace(/^\| 001 .*$/m, '| 001 | One | yes | yes (2) | 9 rendered | 1/1/1 | uploaded |'));
  const out = SD.scanChannelDrift(root, 'History');
  assert.deepStrictEqual(out.map((m) => m.column).sort(), ['QC', 'Shorts']);
  fs.rmSync(root, { recursive: true, force: true });
});
t('scanChannelDrift only checks the channel the table tracks (OtherChannel/001 is not History/001)', () => {
  const root = fixtureChannel();
  const war = path.join(root, 'OtherChannel', '001-war', '05-edit');
  fs.mkdirSync(war, { recursive: true });
  fs.writeFileSync(path.join(war, 'rough-cut.mp4'), 'x');   // would falsely disagree with History's 001 row
  fs.mkdirSync(path.join(root, 'OtherChannel', '001-war', '07-publish'), { recursive: true });
  fs.writeFileSync(path.join(root, 'OtherChannel', '001-war', '07-publish', 'qc-log.json'), JSON.stringify({ summary: { pass: 9, warn: 9, fail: 9 } }));
  assert.deepStrictEqual(SD.scanChannelDrift(root, 'OtherChannel'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── YouTube column: the backticked video ID + uploaded-vs-not, vs studio.json's .youtube.videoId ───
// Only those two facts are checked. Privacy / dates / titles are free prose the operator flips on
// YouTube's side, so they are never compared. IDs below are fabricated fixtures, not real videos.
const YT_TABLE = [
  '| # | Title | Rough cut | Final thumb | Shorts | QC (pass/warn/fail) | YouTube |',
  '|---|---|---|---|---|---|---|',
  '| 001 | One | yes | yes (2) | 6 rendered | never run | uploaded 2026-06-12 (`aaaaaaaaaaa`) — privacy not recorded (pre-connect, title-matched) |',
  '| 002 | Blank | — | — | — | — | **unstarted** — the blank per-video template (script.md still has `___` placeholders) |',
  '| 003 | Three | yes | yes (3) | 8 rendered | never run | uploaded (`bbbbbbbbbbb`) — date/privacy not recorded |',
  '| 004 | Four | yes | no | 8 rendered | 25/6/0 | not uploaded |',
  '| 005 | Five | yes | no | 7 rendered | 26/3/0 | **PUBLIC** 2026-06-16 (`c_c-cccccc1`) |',
  '| 007 | Seven | yes | yes (4) | 7 rendered | 32/3/0 | PRIVATE, uploaded 2026-06-19 (`ddddddddddd`) — **known defect** with `startSec` and `beat-073` in the prose |',
  '| 009 | Nine | yes | no | 0 rendered | 29/6/0 | not uploaded — awaiting final thumbnail art |',
  '| 010 | Ten | yes | no | 0 rendered | never run | uploaded (no id recorded) |',
].join('\n');
const yt = (videoId) => ({ videoId });

t('parseStateYoutubeCells reads the backticked ID out of every real phrasing', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.strictEqual(c['001'].id, 'aaaaaaaaaaa');   // "uploaded 2026-06-12 (`ID`) — …"
  assert.strictEqual(c['003'].id, 'bbbbbbbbbbb');   // "uploaded (`ID`) — …"
  assert.strictEqual(c['005'].id, 'c_c-cccccc1');   // "**PUBLIC** date (`ID`)", with _ and - in the ID
  assert.strictEqual(c['007'].id, 'ddddddddddd');   // "PRIVATE, uploaded … (`ID`) — **known defect** …"
});
t('parseStateYoutubeCells reads not-uploaded from "not uploaded" and bold "**unstarted**"', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.deepStrictEqual(c['004'], { id: null, notUploaded: true });
  assert.deepStrictEqual(c['009'], { id: null, notUploaded: true });   // trailing prose ok
  assert.deepStrictEqual(c['002'], { id: null, notUploaded: true });   // "**unstarted**"; `___` is not an 11-char ID
});
t('parseStateYoutubeCells omits a cell with neither an ID nor a not-uploaded claim (bare "uploaded")', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.strictEqual(c['010'], undefined);   // nothing to check, so no entry
});
t('parseStateYoutubeCells ignores backticked prose that is not exactly an 11-char ID', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.strictEqual(c['007'].id, 'ddddddddddd');   // `startSec` (8) and `beat-073` (8) are skipped
  const c2 = SD.parseStateYoutubeCells('| 011 | X | yes | no | 0 rendered | never run | PRIVATE — see `startSec` and `final-1.png` |');
  assert.strictEqual(c2['011'], undefined);
});
t('parseStateYoutubeCells finds the YouTube column by header name (reordered table) and survives bad input', () => {
  const md = [
    '| # | Title | YouTube | Rough cut | Final thumb | Shorts | QC |',
    '|---|---|---|---|---|---|---|',
    '| 012 | X | uploaded (`eeeeeeeeeee`) | yes | no | 0 rendered | never run |',
  ].join('\n');
  assert.strictEqual(SD.parseStateYoutubeCells(md)['012'].id, 'eeeeeeeeeee');
  assert.deepStrictEqual(SD.parseStateYoutubeCells(''), {});
  assert.deepStrictEqual(SD.parseStateYoutubeCells('| 013 | Only a title |'), {});
});

t('diffYoutubeColumn is clean when every ID and uploaded/not-uploaded claim matches studio.json', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.deepStrictEqual(SD.diffYoutubeColumn(c, {
    '001': yt('aaaaaaaaaaa'), '002': yt(null), '003': yt('bbbbbbbbbbb'), '004': yt(null),
    '005': yt('c_c-cccccc1'), '007': yt('ddddddddddd'), '009': yt(null),
  }), []);
});
t('diffYoutubeColumn (a): catches a table ID that differs from .youtube.videoId (IDs are case-sensitive)', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  let out = SD.diffYoutubeColumn(c, { '001': yt('zzzzzzzzzzz') });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ep, '001');
  assert.strictEqual(out[0].column, 'YouTube');
  assert.ok(/aaaaaaaaaaa/.test(out[0].detail) && /zzzzzzzzzzz/.test(out[0].detail) && /001/.test(out[0].detail), out[0].detail);
  out = SD.diffYoutubeColumn(c, { '001': yt('AAAAAAAAAAA') });
  assert.strictEqual(out.length, 1, 'a case-only difference is a different video ID');
});
t('diffYoutubeColumn (b): catches "not uploaded" / "**unstarted**" while studio.json records a videoId', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  let out = SD.diffYoutubeColumn(c, { '004': yt('fffffffffff') });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].column, 'YouTube');
  assert.ok(/not uploaded/.test(out[0].detail) && /fffffffffff/.test(out[0].detail), out[0].detail);
  out = SD.diffYoutubeColumn(c, { '002': yt('fffffffffff') });
  assert.strictEqual(out.length, 1);
  assert.ok(/unstarted/.test(out[0].detail), out[0].detail);
});
t('diffYoutubeColumn (c): catches a table ID when studio.json has no videoId (and no .youtube block at all)', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  for (const fact of [yt(null), { videoId: null }]) {
    const out = SD.diffYoutubeColumn(c, { '003': fact });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].column, 'YouTube');
    assert.ok(/bbbbbbbbbbb/.test(out[0].detail) && /no/.test(out[0].detail), out[0].detail);
  }
});
t('diffYoutubeColumn reports one entry (not two) for a cell that is both "not uploaded" and holds a wrong ID', () => {
  const c = SD.parseStateYoutubeCells('| 014 | X | yes | no | 0 rendered | never run | not uploaded — was `ggggggggggg` |');
  assert.strictEqual(SD.diffYoutubeColumn(c, { '014': yt('hhhhhhhhhhh') }).length, 1);
});
t('diffYoutubeColumn skips a bare "uploaded" (no ID) even when studio.json has one — no guessing', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.deepStrictEqual(SD.diffYoutubeColumn(c, { '010': yt('iiiiiiiiiii') }), []);
  assert.deepStrictEqual(SD.diffYoutubeColumn(c, { '010': yt(null) }), []);
});
t('diffYoutubeColumn skips an episode whose studio.json could not be read (undefined fact) or that has no table row', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  assert.deepStrictEqual(SD.diffYoutubeColumn(c, { '001': undefined, '004': null }), []);
  assert.deepStrictEqual(SD.diffYoutubeColumn(c, { '099': yt('jjjjjjjjjjj') }), []);
});
t('diffYoutubeColumn ignores privacy words and dates — only the ID and uploaded/not are compared', () => {
  const c = SD.parseStateYoutubeCells(YT_TABLE);
  // 005 says PUBLIC, 007 says PRIVATE; a facts object that carries a contradicting privacy must not matter.
  assert.deepStrictEqual(SD.diffYoutubeColumn(c, {
    '005': { videoId: 'c_c-cccccc1', privacy: 'private' },
    '007': { videoId: 'ddddddddddd', privacy: 'public' },
  }), []);
});

t('readYoutubeFact reads .youtube.videoId from studio.json (read-only) and never writes it', () => {
  const root = mkRoot('');
  const ep = mkEpisode(root, '005-x', { other: { 'studio.json': JSON.stringify({ youtube: { videoId: 'kkkkkkkkkkk', privacy: 'public' } }) } });
  const file = path.join(ep, 'studio.json');
  const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
  assert.deepStrictEqual(SD.readYoutubeFact(ep), { videoId: 'kkkkkkkkkkk' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  fs.rmSync(root, { recursive: true, force: true });
});
t('readYoutubeFact: no .youtube / no videoId / non-string videoId -> videoId null; missing or broken studio.json -> undefined', () => {
  const root = mkRoot('');
  const mk = (name, body) => mkEpisode(root, name, body === undefined ? {} : { other: { 'studio.json': body } });
  assert.deepStrictEqual(SD.readYoutubeFact(mk('002-a', JSON.stringify({ stages: {} }))), { videoId: null });
  assert.deepStrictEqual(SD.readYoutubeFact(mk('003-b', JSON.stringify({ youtube: {} }))), { videoId: null });
  assert.deepStrictEqual(SD.readYoutubeFact(mk('004-c', JSON.stringify({ youtube: { videoId: 12345 } }))), { videoId: null });
  assert.deepStrictEqual(SD.readYoutubeFact(mk('005-d', JSON.stringify({ youtube: 'oops' }))), { videoId: null });
  assert.strictEqual(SD.readYoutubeFact(mk('006-e')), undefined);              // no studio.json
  assert.strictEqual(SD.readYoutubeFact(mk('007-f', '{ not json')), undefined);  // unparseable
  fs.rmSync(root, { recursive: true, force: true });
});

const YT_FIXTURE_STATE = [
  '| # | Title | Rough cut | Final thumb | Shorts | QC (pass/warn/fail) | YouTube |',
  '|---|---|---|---|---|---|---|',
  '| 001 | One | yes | yes (2) | 2 rendered | 4/0/0 | uploaded 2026-06-12 (`lllllllllll`) — privacy not recorded |',
  '| 002 | Blank | — | — | — | — | **unstarted** — blank template |',
].join('\n');
function ytFixtureChannel(state) {
  const root = mkRoot(state || YT_FIXTURE_STATE);
  mkEpisode(root, '001-one', {
    cut: true, finals: ['final-1.png', 'final-2.png'], shorts: ['a.mp4', 'b.mp4'],
    other: { 'studio.json': JSON.stringify({ youtube: { videoId: 'lllllllllll', privacy: 'private' } }) },
  });
  fs.mkdirSync(path.join(root, 'History', '001-one', '07-publish'), { recursive: true });
  fs.writeFileSync(path.join(root, 'History', '001-one', '07-publish', 'qc-log.json'), JSON.stringify({ summary: { pass: 4, warn: 0, fail: 0 } }));
  mkEpisode(root, '002-blank', { other: { 'studio.json': JSON.stringify({ stages: {} }) } });
  return root;
}
t('scanChannelDrift is clean when the YouTube cells match studio.json (ID present / not uploaded, no .youtube)', () => {
  const root = ytFixtureChannel();
  assert.deepStrictEqual(SD.scanChannelDrift(root, 'History'), []);
  fs.rmSync(root, { recursive: true, force: true });
});
t('scanChannelDrift catches a deliberately staled YouTube cell for each of (a) wrong ID (b) not-uploaded-but-recorded (c) ID-but-no-.youtube', () => {
  const cases = [
    ['a', (r) => fs.writeFileSync(path.join(r, 'CONTEXT', '40_STATE.md'), YT_FIXTURE_STATE.replace('lllllllllll', 'mmmmmmmmmmm')), '001'],
    ['b', (r) => fs.writeFileSync(path.join(r, 'CONTEXT', '40_STATE.md'), YT_FIXTURE_STATE.replace(/uploaded 2026-06-12 \(`lllllllllll`\)/, 'not uploaded')), '001'],
    ['c', (r) => fs.writeFileSync(path.join(r, 'History', '001-one', 'studio.json'), JSON.stringify({ stages: {} })), '001'],
    ['b2', (r) => fs.writeFileSync(path.join(r, 'History', '002-blank', 'studio.json'), JSON.stringify({ youtube: { videoId: 'nnnnnnnnnnn' } })), '002'],
  ];
  for (const [label, stale, ep] of cases) {
    const root = ytFixtureChannel();
    stale(root);
    const out = SD.scanChannelDrift(root, 'History');
    assert.strictEqual(out.length, 1, label + ': ' + JSON.stringify(out));
    assert.strictEqual(out[0].ep, ep, label);
    assert.strictEqual(out[0].column, 'YouTube', label);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
t('scanChannelDrift orders YouTube drift after QC drift within one episode', () => {
  const root = ytFixtureChannel(YT_FIXTURE_STATE.replace('4/0/0', '1/1/1').replace('lllllllllll', 'mmmmmmmmmmm'));
  assert.deepStrictEqual(SD.scanChannelDrift(root, 'History').map((m) => m.column), ['QC', 'YouTube']);
  fs.rmSync(root, { recursive: true, force: true });
});
t('scanChannelDrift never writes studio.json while checking the YouTube column', () => {
  const root = ytFixtureChannel();
  const files = ['001-one', '002-blank'].map((d) => path.join(root, 'History', d, 'studio.json'));
  const before = files.map((x) => [fs.readFileSync(x, 'utf8'), fs.statSync(x).mtimeMs]);
  SD.scanChannelDrift(root, 'History');
  assert.deepStrictEqual(files.map((x) => [fs.readFileSync(x, 'utf8'), fs.statSync(x).mtimeMs]), before);
  fs.rmSync(root, { recursive: true, force: true });
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
