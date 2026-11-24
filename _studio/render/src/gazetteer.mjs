// Curated coordinates [longitude, latitude] for places the channel actually talks about, so map
// labels/markers land in the RIGHT spot every time instead of being guessed. Author map specs by
// NAME (e.g. {place:'el sidron'}) and the engine resolves the coordinate. Add places as needed.
// Lng is east-positive / west-negative; Lat is north-positive.
export const PLACES = {
  // --- Neanderthal & early-human sites ---
  'el sidron': [-5.33, 43.39],          // Spain — 13-member family cave
  'gibraltar': [-5.34, 36.12],          // Gorham's Cave — late refuge
  'neander valley': [6.95, 51.23],      // Germany — the type site ("Neandertal")
  'vindija': [16.07, 46.30],            // Croatia
  'spy': [4.67, 50.48],                 // Belgium
  'la chapelle': [1.73, 45.04],         // France — "old man"
  'mandrin': [4.80, 44.28],             // France — Grotte Mandrin (very late N.)
  'saint-cesaire': [-0.49, 45.74],      // France
  'shanidar': [44.22, 36.83],           // Iraq
  'mezmaiskaya': [40.02, 44.16],        // Russia, Caucasus
  'denisova': [84.68, 51.40],           // Siberia — Denisovans
  'krapina': [15.87, 46.16],            // Croatia

  // --- regions / labels (centroids tuned for label placement) ---
  'europe': [11, 49],
  'western europe': [3, 47],
  'eastern europe': [24, 49],
  'iberia': [-4, 40],
  'spain': [-4, 40],
  'france': [2.5, 46.5],
  'britain': [-2, 53],
  'italy': [13, 42.5],
  'balkans': [21, 43.5],
  'caucasus': [43.5, 42.8],
  'siberia': [90, 60],
  'central asia': [65, 45],
  'asia': [95, 45],
  'africa': [20, 6],
  'levant': [36, 32],
  'arabia': [45, 23],
  'near east': [40, 35],

  // --- physical features ---
  'alps': [10.5, 46.4],
  'rhine': [7.6, 50.2],
  'danube': [19, 45],
  'pyrenees': [0.5, 42.7],
  'mediterranean': [16, 35],
  'atlantic': [-16, 44],
  'north sea': [3, 56],
  'black sea': [34, 43],

  // --- War maps: key war places + historical aliases (curated wins over the geocoder; add as videos need) ---
  'stalingrad': [44.42, 48.71], 'volgograd': [44.42, 48.71],
  'volga': [45.0, 48.5], 'don river': [42.0, 49.5], 'dnieper': [33.0, 49.0],
  'moscow': [37.62, 55.75], 'leningrad': [30.34, 59.93], 'st petersburg': [30.34, 59.93],
  'kursk': [36.19, 51.73], 'kharkov': [36.23, 49.99], 'kharkiv': [36.23, 49.99],
  'rostov': [39.72, 47.23], 'kyiv': [30.52, 50.45], 'kiev': [30.52, 50.45],
  'warsaw': [21.01, 52.23], 'berlin': [13.40, 52.52], 'stalingrad pocket': [44.6, 48.6],
  'normandy': [-0.37, 49.18], 'caen': [-0.37, 49.18], 'bastogne': [5.72, 50.00],
  'el alamein': [28.95, 30.83], 'constantinople': [28.98, 41.01], 'istanbul': [28.98, 41.01],
  'thermopylae': [22.54, 38.80], 'cannae': [16.13, 41.30], 'eastern front': [33, 52],
};

// Resolve a map-spec coordinate: accepts [lng,lat], {place:'name'}, {coord:[lng,lat]}, or a bare
// place-name string. Returns [lng,lat] or null (unknown place — logged so it can be added).
export function coordOf(x) {
  if (Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number') return [x[0], x[1]];
  if (x && Array.isArray(x.coord)) return [x.coord[0], x.coord[1]];
  const name = (typeof x === 'string') ? x : (x && x.place);
  if (name && PLACES[String(name).toLowerCase().trim()]) return PLACES[String(name).toLowerCase().trim()];
  return null;
}
