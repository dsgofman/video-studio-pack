# Setting up the YouTube Studio on a new machine

This is a **near-faceless YouTube production system** — a local web app ("the Studio") plus a set of
rules (`CLAUDE.md`) that let Claude research, write, storyboard, illustrate, voice, and assemble
8–12 minute explainer videos, while you stay the editor/publisher. It runs entirely on your own
machine with your own API keys. This guide gets it running from scratch.

It works on **macOS, Windows, and Linux**. Steps below are written **Mac-first** (with notes for others).

---

## ⚡ For Claude (the AI agent configuring this)

If you're Claude Code reading this to set the project up for the user, do this:

1. **Run the doctor first:** `node _studio/setup.mjs`. It prints a ✅/❌ checklist of everything below
   and never reveals secret values. Re-run it after each step to confirm progress.
2. **Resolve every ❌**, in order: Node ≥18 → render dependencies → Claude CLI on PATH → `.secrets.json`
   → at least the Gemini + ElevenLabs keys → one channel.
3. **You cannot create the user's API keys for them** — they're tied to the user's own accounts/billing.
   When a key is missing, walk the user through the "Get your API keys" section below, then have them
   paste the key into `_studio/.secrets.json` (or the Studio UI). Confirm with the doctor.
4. **Never** print, commit, or paste real keys into chat. `_studio/.secrets.json` and any
   `_assets/youtube.json` are **local only**.
5. When the doctor says **Ready**, start the server and tell the user to open http://localhost:4317.
6. If the user wants their **own** channel/topic (not the example "History" one), follow
   "Start your own channel" below — don't reuse the example channel's niche.

---

## 1. Prerequisites

| Need | macOS | Windows | What it's for |
|---|---|---|---|
| **Node.js 18+** | `brew install node` | [nodejs.org](https://nodejs.org) LTS | runs the Studio server + renderer |
| **Claude Code CLI** | you already have it if Claude is reading this; else [claude.com/claude-code](https://claude.com/claude-code) | same | powers idea/script/scene/packaging generation + the in-Studio chat |
| **ffmpeg** *(optional)* | `brew install ffmpeg` | bundled with Remotion | only used to fix odd-sample-rate music beds; render works without it |

> Don't have Homebrew on Mac? Install it from [brew.sh](https://brew.sh), then run the `brew` commands above.

If the `claude` command isn't on your PATH, set an environment variable pointing at it, e.g.
`export CLAUDE_BIN="/full/path/to/claude"` (add it to your `~/.zshrc` to make it stick).

---

## 2. Install

```bash
# from the project root (the folder that contains this SETUP.md)
cd _studio/render
npm install            # installs Remotion + the render engine (first run also downloads a headless Chromium)
cd ..                  # back to _studio
# the server itself has no dependencies — it's plain Node.
```

That's the only `npm install` needed.

---

## 3. Get your API keys

You only **need two** to make full videos: **Gemini** (images) and **ElevenLabs** (narration).
YouTube is optional (only for uploading from inside the Studio).

### Gemini — scene images & thumbnails (~$0.04/image, ~$3–4 per video)
1. Go to **https://aistudio.google.com/apikey**, sign in with a Google account.
2. Click **Create API key** and copy it.
3. Paste it into the Studio's **Scenes tab** key box, **or** put it in `_studio/.secrets.json` as
   `"geminiKey"`.

### ElevenLabs — narration voice ($5/mo Starter plan covers ~1 video/week)
1. Go to **https://elevenlabs.io**, create an account, pick a plan (Starter is enough to begin).
2. Open your profile menu → **API Keys** → **Create** → copy the key.
3. Put it in `_studio/.secrets.json` as `"elevenKey"`.
4. Pick a narrator voice inside the Studio later (Scenes tab → voice picker).

### YouTube *(optional — only if you want to upload from the Studio)*
Follow **`_studio/CONNECT-YOUTUBE.md`** — it walks through creating a free Google Cloud OAuth app and
connecting each channel. You can skip this entirely and just upload manually on youtube.com.

### Where keys live
Copy the template and fill it in:

```bash
cp _studio/.secrets.example.json _studio/.secrets.json
# then edit _studio/.secrets.json and paste your keys
```

`_studio/.secrets.json` is **local only — never commit or share it.** (Treat the keys like passwords.
If a key ever leaks, rotate it in that provider's dashboard.)

---

## 4. Launch

```bash
cd _studio
npm start            # → "🎬 YouTube Studio running → http://localhost:4317"
```

Open **http://localhost:4317** in your browser. Leave it running while you work; `Ctrl+C` to stop.

Run `node _studio/setup.mjs` anytime to re-check that everything's configured.

---

## 5. Start your own channel

The example channel in `History/` ("Before Lore") is one worked example — you can keep it as a
reference or delete it. To make **your own** channel for your own topic:

1. Copy the blueprint into a new top-level folder named after your channel:
   ```bash
   mkdir "MyChannel" && cp _templates/new-channel-blueprint.md "MyChannel/channel.md"
   ```
2. Fill in `MyChannel/channel.md` (niche, voice, audience, title formulas, visual identity). Ask Claude
   to help — it reads `CLAUDE.md` (the global rules) + your `channel.md` before producing anything.
3. In the Studio, pick your channel, hit **＋ New project**, and work the pipeline: idea → packaging
   (title + thumbnail) → script → scenes → assets → assemble → publish kit.
4. Set up your cast: the **🎭 Character sheets** button lets you generate or upload a cast sheet for
   your channel and pick one per video.

`CLAUDE.md` at the root is the operating system for every session — it explains the whole pipeline,
the monetization rules, and the production standards. Read it (or have Claude read it) first.

---

## 6. Sharing this with someone else (clean bundle)

To hand the system to another person **without** your keys or huge caches:

```bash
# from the project root — makes studio-bundle.zip excluding secrets, deps, caches, and example content
zip -r studio-bundle.zip . \
  -x "*/node_modules/*" "_studio/.secrets.json" "**/_assets/youtube.json" \
     "_studio/render/.tmp/*" "_studio/usage.json" "History/*" "*.DS_Store"
```

The recipient unzips it, then follows this SETUP.md from step 1 (they run their **own**
`npm install` and use their **own** keys). `.secrets.example.json` ships with the bundle as the template.

---

## Troubleshooting

- **"No Gemini API key set"** → add `geminiKey` to `.secrets.json` (or the Scenes-tab box), restart.
- **Generation/chat does nothing** → the `claude` CLI isn't being found. Run `claude --version`; if that
  fails, install Claude Code or set `CLAUDE_BIN`. Restart the server after changing env vars.
- **Render fails on first run** → Remotion is downloading its Chromium; give it a minute and retry.
- **Music bed sounds missing in the cut** → install `ffmpeg` (`brew install ffmpeg`) so odd-rate beds get
  resampled; or export your bed at 44.1 kHz.
- **Port 4317 in use** → `PORT=4400 npm start` (then open that port).
- **Server changes don't take effect** → restart `npm start`. (Edits to `studio.html` and the render
  files are picked up automatically; `server.js` changes need a restart.)
