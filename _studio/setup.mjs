#!/usr/bin/env node
/*
 * Studio setup doctor — checks prerequisites + config and prints a checklist. Safe to re-run anytime.
 * Usage:  node _studio/setup.mjs
 * Designed to be read by a human OR by Claude Code while configuring the Studio on a new machine.
 * It NEVER prints secret values — only whether each key is present.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const STUDIO = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(STUDIO, '..');
const tick = (b) => (b ? '✅' : '❌');
const has = (cmd, args = ['--version']) => { try { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return !r.error; } catch (_) { return false; } };

const lines = [];

// Node ≥ 18 (the server relies on global fetch)
const major = parseInt(process.versions.node.split('.')[0], 10);
lines.push(`${tick(major >= 18)} Node ${process.versions.node}` + (major >= 18 ? '' : '  → need ≥18 (brew install node)'));

// Render dependencies (Remotion etc.)
const renderDeps = fs.existsSync(path.join(STUDIO, 'render', 'node_modules', 'remotion'));
lines.push(`${tick(renderDeps)} Render dependencies` + (renderDeps ? '' : '  → run: cd _studio/render && npm install'));

// ffmpeg (system or bundled with Remotion) — only needed to resample odd-rate music beds
const sysFf = has('ffmpeg', ['-version']);
let bundledFf = false;
try { bundledFf = fs.readdirSync(path.join(STUDIO, 'render', 'node_modules', '@remotion')).some((d) => d.startsWith('compositor-')); } catch (_) {}
lines.push(`${tick(sysFf || bundledFf)} ffmpeg ` + (sysFf ? '(system)' : bundledFf ? '(bundled with Remotion)' : '— optional; brew install ffmpeg'));

// Claude Code CLI on PATH (powers idea/script/scene/packaging generation + in-Studio chat)
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const claudeOk = has(claudeBin) || (process.platform === 'win32' && has('claude.cmd'));
lines.push(`${tick(claudeOk)} Claude Code CLI` + (claudeOk ? '' : '  → not on PATH; set CLAUDE_BIN to its full path'));

// Secrets
const sf = path.join(STUDIO, '.secrets.json');
let secrets = {}; try { secrets = JSON.parse(fs.readFileSync(sf, 'utf8').replace(/^﻿/, '')); } catch (_) {}
const hasSecrets = fs.existsSync(sf);
lines.push(`${tick(hasSecrets)} _studio/.secrets.json` + (hasSecrets ? '' : '  → copy .secrets.example.json → .secrets.json and fill in'));
const keyset = (k) => !!(secrets[k] && String(secrets[k]).trim());
lines.push(`   ${tick(keyset('geminiKey') || process.env.GEMINI_API_KEY)} Gemini key (scene images + thumbnails)`);
lines.push(`   ${tick(keyset('elevenKey') || process.env.ELEVENLABS_API_KEY)} ElevenLabs key (narration)`);
lines.push(`   ${(keyset('youtubeClientId') && keyset('youtubeClientSecret')) ? '✅' : '➖'} YouTube OAuth app (optional — in-Studio upload; see CONNECT-YOUTUBE.md)`);

// Channels
let channels = [];
try {
  channels = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !['node_modules', '.git'].includes(d.name) && fs.existsSync(path.join(ROOT, d.name, 'channel.md')))
    .map((d) => d.name);
} catch (_) {}
lines.push(`${tick(channels.length > 0)} Channels: ` + (channels.length ? channels.join(', ') : 'none yet → copy _templates/new-channel-blueprint.md into a new folder as channel.md'));

console.log('\n  🎬  YouTube Studio — setup check\n  ' + '-'.repeat(46));
console.log(lines.map((l) => '  ' + l).join('\n'));
const ready = major >= 18 && renderDeps && claudeOk && hasSecrets && (keyset('geminiKey') || process.env.GEMINI_API_KEY);
console.log('\n  ' + (ready
  ? '✅ Ready.  Launch:  cd _studio && npm start   →  http://localhost:4317'
  : '❌ Not ready — resolve the ❌ items above, then re-run:  node _studio/setup.mjs') + '\n');
