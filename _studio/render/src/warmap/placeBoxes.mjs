// Generic greedy non-overlapping box placement (correction C8 — the reusable core behind both map
// labels and unit tokens). Each item: { anchor:[x,y], w, h, ...passthrough }. Returns the items in
// ORIGINAL order, each with { cx, cy, nudged } — non-overlapping within `safe`, avoiding `obstacles`
// (boxes {x0,y0,x1,y1}) and each other, preferring to sit on its anchor. Pure + deterministic.
export function placeBoxes(items, opts = {}) {
  const safe = opts.safe || { x0: 60, y0: 60, x1: 1860, y1: 1020 };
  const placed = [...(opts.obstacles || [])];
  const result = new Array(items.length);
  const order = items.map((_, i) => i).sort((a, b) => (items[b].w * items[b].h) - (items[a].w * items[a].h)); // biggest first
  const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const RING = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  for (const i of order) {
    const it = items[i], ax = it.anchor[0], ay = it.anchor[1], w = it.w, h = it.h, R = Math.max(w, h);
    const cands = [[0, 0]];
    for (const d of [0.62, 1.05, 1.55, 2.1]) for (const [dx, dy] of RING) cands.push([dx * R * d, dy * h * d]);
    let best = null, bestScore = Infinity;
    for (const [dx, dy] of cands) {
      const cx = Math.max(safe.x0 + w / 2, Math.min(safe.x1 - w / 2, ax + dx));
      const cy = Math.max(safe.y0 + h / 2, Math.min(safe.y1 - h / 2, ay + dy));
      const box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
      let score = Math.hypot(cx - ax, cy - ay) * 0.03;              // prefer near the anchor
      for (const q of placed) score += overlap(box, q);
      if (score < bestScore) { bestScore = score; best = { cx, cy, box }; if (score < 0.1) break; }
    }
    placed.push(best.box);
    result[i] = Object.assign({}, it, { cx: best.cx, cy: best.cy, nudged: Math.hypot(best.cx - ax, best.cy - ay) > h * 0.55 });
  }
  return result;
}
