// Render ONE 1920x1080 thumbnail still: composite a bold UPPERCASE headline (in a UI-safe zone,
// heavy font + thick outline + soft contrast scrim) onto a finished thumbnail ART image.
// Mirrors render.mjs's bundle/serve setup, but uses renderStill (single frame, frame 0).
//
// Usage:
//   node render/thumb.mjs --art <path> --hook "<TEXT>" --accent <#hex> --side left|right --out <path> [--font anton|archivo|bebas]
//
// staticFile() resolves against the bundle's publicDir. The art lives outside render/, so we point
// publicDir at the art's own directory and pass just its basename as the `art` inputProp.
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--art') out.art = argv[++i];
    else if (a === '--hook') out.hook = argv[++i];
    else if (a === '--accent') out.accent = argv[++i];
    else if (a === '--side') out.side = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--font') out.font = argv[++i];
    else if (a.startsWith('--art=')) out.art = a.slice(6);
    else if (a.startsWith('--hook=')) out.hook = a.slice(7);
    else if (a.startsWith('--accent=')) out.accent = a.slice(9);
    else if (a.startsWith('--side=')) out.side = a.slice(7);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--font=')) out.font = a.slice(7);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.art || !args.hook || !args.out) {
    throw new Error('usage: node thumb.mjs --art <path> --hook "<TEXT>" --accent <#hex> --side left|right --out <path> [--font anton|archivo|bebas]');
  }
  const artAbs = path.resolve(args.art);
  if (!fs.existsSync(artAbs)) throw new Error('art not found: ' + artAbs);

  const side = args.side === 'left' ? 'left' : 'right';
  const accent = args.accent || '#FF7A1A';
  const font = (args.font === 'bebas' || args.font === 'archivo') ? args.font : 'anton';
  const outAbs = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  // publicDir = the art's directory; pass the basename so staticFile(<basename>) resolves to it.
  const publicDir = path.dirname(artAbs);
  const artRel = path.basename(artAbs);
  const inputProps = { art: artRel, hook: args.hook, accent, side, font };

  const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'index.jsx'), publicDir });
  const composition = await selectComposition({ serveUrl, id: 'Thumbnail', inputProps });

  await renderStill({
    composition,
    serveUrl,
    output: outAbs,
    inputProps,
    imageFormat: 'png',
    frame: 0,
  });

  if (!fs.existsSync(outAbs)) throw new Error('renderStill produced no output at ' + outAbs);
  console.log(outAbs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
