# YouTube Studio — Starter

A local, near-faceless **YouTube production system**: a small web app ("the Studio") plus an operating
manual (`CLAUDE.md`) that let Claude research, write, storyboard, illustrate, voice, and assemble
8–12 minute explainer videos — while you stay the editor and publisher. It runs entirely on your own
machine with your own API keys (Gemini for images, ElevenLabs for narration). Nothing phones home.

## Get started

Open this folder in **Claude Code** and say:

> "Set this up for me — follow SETUP.md."

…and Claude will run the setup doctor and walk you through it. Or do it yourself — full instructions are
in **[SETUP.md](SETUP.md)** (about 5 minutes). The short version:

1. Install **Node 18+** (and optionally `ffmpeg`).
2. `cd _studio/render && npm install`
3. `cp _studio/.secrets.example.json _studio/.secrets.json`, then add your **Gemini** + **ElevenLabs** keys.
4. `cd _studio && npm start` → open **http://localhost:4317**
5. Check your config anytime: `node _studio/setup.mjs`

**No API keys or dependencies are bundled — you add your own.** See `SETUP.md` for how to get each key.

## What's in the box

| Path | What it is |
|---|---|
| `CLAUDE.md` | The operating manual Claude follows: monetization rules, the 13-step pipeline, production standards |
| `_studio/` | The Studio app (plain Node, no deps) + `render/` (Remotion auto-assembler: maps, infographics, captions, end card) |
| `_templates/` | The per-video folder skeleton and the new-channel blueprint |
| `MyChannel/` | A blank channel, ready to fill in. Rename it to your channel's name |

## Make it yours (first hour)

1. **Rename `MyChannel/`** to your channel and fill in its `channel.md`: niche, audience, voice, title
   formulas. Ask Claude to run the viability research the blueprint describes first.
2. **Fill in `MyChannel/_assets/style-bible.md`**: your art style, palette and cast. Until you make a
   cast sheet, the Studio uses a built-in cast of four stick figures.
3. **Edit `MyChannel/_assets/brand/brand.json`**: your @handle, end-card line, and default description
   blurb, hashtags and tags for uploads.
4. Drop a music bed at `MyChannel/_assets/music/bed.mp3` (YouTube Audio Library is free and safe).
5. In the Studio: **＋ New project** → work Idea → Packaging → Script → Scenes → QC.

Tests: `node _studio/test/<name>.test.js` (each file runs on its own).
