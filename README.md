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

**No API keys, channels, or dependencies are bundled — you add your own.** See `SETUP.md` for how to get
each key and how to start your own channel.
