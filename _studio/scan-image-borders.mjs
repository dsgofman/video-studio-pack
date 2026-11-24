#!/usr/bin/env node
// Read-only QC scanner: reuses the exact border/margin detector from server.js's renderScene
// auto-heal (pngHasBorder) to sweep ALREADY-GENERATED images without calling Gemini (free, no
// regeneration). Use when auditing a video's 04-assets/images/ folder before assembly/publish.
//   node _studio/scan-image-borders.mjs MyChannel/001-my-first-video/04-assets/images
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

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
  if (bitDepth !== 8 || interlace !== 0) return null;
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
function pngHasBorder(file) {
  let img; try { img = decodePng(file); } catch (_) { return false; }
  if (!img) return false;
  const { w, h, ch, px } = img;
  const at = (x, y, k) => px[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * ch + Math.min(k, ch - 1)];
  const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
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
    if ((agree + 1) >= flagged.length - 1) return true;
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
  const P = (x, y) => [at(x, y, 0), at(x, y, 1), at(x, y, 2)];
  const med = (a) => a.slice().sort((m, n) => m - n)[a.length >> 1];
  const ring = []; for (let i = 0; i < w; i += 8) ring.push(P(i, 0), P(i, h - 1)); for (let j = 0; j < h; j += 8) ring.push(P(0, j), P(w - 1, j));
  const rimC = [0, 1, 2].map((k) => med(ring.map((c) => c[k])));
  if (!(rimC.every((v) => v >= 198) && (Math.max(...rimC) - Math.min(...rimC)) < 36)) return false;
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

const dir = process.argv[2];
if (!dir) { console.error('usage: node scan-image-borders.mjs <images-dir>'); process.exit(1); }
const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
const flagged = [];
for (const f of files) {
  const p = path.join(dir, f);
  if (pngHasBorder(p)) flagged.push(f);
}
console.log(`Scanned ${files.length} images in ${dir}`);
console.log(`Flagged (border/margin): ${flagged.length ? flagged.join(', ') : 'none'}`);
