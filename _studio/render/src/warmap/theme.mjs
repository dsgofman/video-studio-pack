// One source of truth for map styling per theme. `atlas` reproduces the legacy Map.jsx look EXACTLY
// (so other channels are unaffected); `war` is the war-map parchment / war-room palette.
export const THEMES = {
  atlas: {
    sea: '#9cc3d8', seaGrad: ['#c4e1ee', '#93bccf'],
    land: '#aac487', landStroke: '#586c3a',
    accent: '#e07a3c', casing: '#fff7ec', ink: '#11161f',
    river: '#7fb2cf', border: 'none', lake: '#bfe0ee',
  },
  war: {
    sea: '#cdd8d0', seaGrad: ['#dfe6dc', '#c2ccc3'],
    land: '#e8dcc0', landStroke: '#8a7a55',
    accent: '#cf3a2e', casing: '#f4f1ea', ink: '#2c2114',
    river: '#6f93a8', border: '#9a875f', lake: '#bcd0d8',
  },
};
export const SIDE_FALLBACK = ['#c0392b', '#3f6f9f', '#5b8c5a', '#8a6d3b'];
export const themeOf = (name) => THEMES[name] || THEMES.atlas;
