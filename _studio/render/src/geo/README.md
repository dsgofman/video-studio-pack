# render/src/geo — vendored geographic data

Committed data (not regenerated at build), used by the WarLore war-map engine (`../warmap/WarMap.jsx`)
and the geocoder (`geocode.mjs`).

| File | Source | Notes |
|---|---|---|
| `rivers-50m.json` | Natural Earth 50m `rivers_lake_centerlines` (GeoJSON via [martynafford/natural-earth-geojson](https://github.com/martynafford/natural-earth-geojson)) | 462 line features; pathed directly by d3 `geoPath` (bbox-clipped per frame) |
| `lakes-50m.json` | Natural Earth 50m `lakes` (same source) | 405 polygon features |
| `populated-places.json` | Natural Earth 10m `populated_places` (same source), compressed to `{ "<name>": [[lng,lat,pop], …≤5] }` | 8,624 names; 16MB raw → 324KB; the geocoder fallback |

**License:** Natural Earth is public domain. The intermediate repo is MIT.
**Borders + land** come from `world-atlas` (already a dependency: `countries-50m`, `land-50m/110m`) — not vendored here.
**To refresh:** re-fetch from the source repo (`<base>/50m/physical/…`, `<base>/10m/cultural/…`) and, for
places, re-run the name→`[lng,lat,pop]` compaction (drop the 16MB raw).
