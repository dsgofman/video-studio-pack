// Offline geocoder over Natural Earth's ~8.6k populated places (name -> [[lng,lat,pop], ...]).
// COARSE fallback only: historical/renamed names (Stalingrad, Constantinople) live in the curated
// gazetteer (which wins), and precise war positions (villages, front vertices) come from the research
// brief's explicit [lng,lat] + the Studio drag-editor. Used by the authoring/editor layer (server-side),
// NOT inside the render bundle — so createRequire (Node-safe) avoids the JSON import-attribute split.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const places = require('./populated-places.json');

// Resolve a modern place name. With `near` ([lng,lat]) it picks the closest match (disambiguates
// same-named towns); without, the most populous. Returns [lng,lat] or null.
export function geocode(name, near) {
  const key = String(name || '').toLowerCase().trim();
  const hits = places[key];
  if (!hits || !hits.length) return null;
  if (near && Array.isArray(near) && near.length >= 2) {
    let best = hits[0], bd = Infinity;
    for (const h of hits) { const d = (h[0] - near[0]) ** 2 + (h[1] - near[1]) ** 2; if (d < bd) { bd = d; best = h; } }
    return [best[0], best[1]];
  }
  return [hits[0][0], hits[0][1]];   // entries are pre-sorted by population, desc
}
