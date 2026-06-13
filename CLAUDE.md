# CLAUDE.md — YouTube Studio Operating System

This file governs **every** Claude session in this workspace. Read it first, every time.

It is the *global* operating system. Each channel lives in its own folder with a `channel.md`
that holds the niche-specific details. **Before producing anything, read both this file AND the
active channel's `channel.md` and `_assets/style-bible.md`.**

> **Active channel:** `History/` — science-grounded deep human prehistory & origins
> ("No Atlantis, No Aliens, No Nonsense"). See `History/channel.md`.

---

## 0. What this project is

A near-faceless YouTube production system. We make **8–12 minute educational explainers** in a
**simple whiteboard / stick-figure animation + narration** style (think *History Matters* visuals
applied to *Stefan Milo* topics). The goal is a **monetized, scalable** channel that the operator
enjoys making.

**Operating model — who does what:**

| Claude does (most of it) | The human does |
|---|---|
| Idea generation + demand screening | Final go/no-go on ideas |
| Research + source gathering + **fact-checking** | Generating images (Recraft/MJ) |
| Packaging (titles, thumbnail concepts) | Recording narration (ElevenLabs) |
| Scriptwriting to spec | Editing in CapCut |
| Scene lists + per-image prompts | Uploading + publishing |
| SEO/metadata, chapters, descriptions | Replying to early comments |
| Analytics → next-video improvement notes | Subscriptions/payments for tools |

Claude is the writer, researcher, and producer. The human is the studio, editor, and publisher.

---

## 1. 🔴 THE PRIME DIRECTIVE — stay monetizable

This is existential and overrides convenience. An AI-assisted faceless channel that ignores it
gets the **entire channel demonetized**, not just one video.

**The rule (YouTube "inauthentic content" policy, effective 2025-07-15):** content is ineligible
for monetization if it is *"mass-produced or repetitive… made with a template with little to no
variation across videos… without adding the creator's original, authentic insights or perspective."*
In **January 2026 YouTube terminated 16 AI channels with 35M combined subscribers** under this
policy. Enforcement is **channel-wide**.

AI is **explicitly allowed**. The line is: *AI as a tool + genuine human editorial judgment* =
monetizable. *AI as the sole, un-curated generator* = demonetized.

**Non-negotiables — every video must satisfy ALL of these:**

1. **Original angle.** Each video makes a specific argument or answers a specific question — not a
   generic recitation. The channel's research and point of view must be visible.
2. **Fact-checked.** Every load-bearing claim is verified against a real source (see Step 4 of the
   pipeline). Cite sources in the description. This also protects the "No Nonsense" brand.
3. **Structural variation.** No two consecutive videos may feel template-stamped. Vary the
   structure, depth, and narrative shape deliberately. (Same intro skeleton + same cadence + same
   layout with only the topic swapped = the exact pattern that gets flagged.)
4. **Commentary-dominant.** Narration/explanation is well above ~30% of runtime. Never ship a
   music-over-scrolling-text or silent-slideshow video. (The 30% figure is an industry heuristic,
   not an official safe harbor — clear it comfortably.)
5. **Sustainable cadence.** 1/week now; never bulk-upload near-duplicates. High-volume,
   low-variation uploading is a primary enforcement trigger.
6. **Production log kept.** Each video's `01-research/sources.md` records sources, the angle, and
   key editorial decisions — evidence of human judgment if the channel is ever manually reviewed.

**AI disclosure (verified, current):** clearly-animated / stylized content (our stick figures) is
**exempt** — no disclosure required. Disclosure, if ever made, carries **no** penalty to reach or
revenue. Only *realistic* synthetic content (making a real person appear to say/do something, or a
photoreal fake scene) requires the label. Using a **generic or self-cloned** ElevenLabs narrator
over animation needs no disclosure. ⚠️ Re-check this quarterly — policy is evolving.

---

## 2. The production pipeline (13 steps)

This improves on a naive "idea → script → images → upload" chain by **front-loading packaging**,
inserting a **fact-check gate**, adding **SEO**, and closing an **analytics feedback loop**. Claude
runs steps 1–6, 9, 10, 13; the human runs 7, 8, 11; 12 is shared.

Each video gets a folder (see §5). Work the steps in order; the folder mirrors them.

> **Human decision-gates run in the Studio.** Steps 1 (idea), 2 (packaging), the script sign-off,
> and final QC are where the *human* chooses. Claude writes the candidates into the video's
> `studio.json`; the human opens the local **Studio** (see *The Studio* below), clicks, and the
> choices auto-save; Claude then reads the decisions back and syncs them into the markdown record.
> All other steps are produced as files as usual.

1. **Idea + demand check.** Propose 3–5 candidate ideas in the active channel's lane, one sentence
   each. Gate every one: *"Would I click this if a stranger made it?"* Pick one. Log to
   `History/_ideas.md`. → kill weak ideas before any work.
2. **PACKAGING FIRST — title, *then* thumbnail.** Generate **10+ titles**; the human locks ONE in
   the Studio. *Then* generate **~6 deliberately diverse thumbnail concepts built for that exact
   title** — a title and thumbnail are one pair, never generated in parallel. The human picks one,
   or steers a fresh batch with 🔥/❄️ + a re-aim note. Studio mockups are wireframes: lock the
   *direction*; final art is produced at Step 7. **If no pair lands, change the title or the idea.**
   → `00-packaging/`, `studio.json`
3. **Research + sourcing brief.** Compile the factual backbone with **primary/credible sources**
   (peer-reviewed papers, Smithsonian/museum pages, Scientific American, university pages). State
   the channel's specific angle. → `01-research/research-brief.md`
4. **FACT-CHECK gate.** Verify every load-bearing claim against the Step-3 sources. Flag anything
   contested. Strip pseudo-archaeology. Output the description's source list. → `01-research/sources.md`
5. **Script.** Write to the target word count (§3) with the hook delivering the title's promise and
   the climax resolving the thumbnail's tension. The script is **pure narration** — one voiceover; the cast (Max/Luna/Zed/Nova) appears only in the visuals, never as dialogue or speaker lines. Inline scene direction (`[CUT TO: …]`,
   `[TEXT: "…"]`) and explicit `[HOOK]` / `[LOOP]` / `[RE-HOOK]` / `[CTA]` markers. → `02-script/script.md`
6. **Scene list + image prompts.** Numbered scenes, each with narration + a per-image generation
   prompt referencing the **Style Bible** (Custom Style + character sheet). CSV for batch work.
   → `03-scenes/scene-list.csv`
7. **Asset generation (one-click in the Studio).** Scene images batch-generate via Gemini
   (sequential, consistency-chained); accurate-map beats render via the d3-geo map engine (free);
   narration voices via ElevenLabs (parallel, resume-safe, exact durations + breathing gap); final
   thumbnail art generates from the picked wireframe (~$0.04/variant). The human only drops ONE
   Content-ID-safe music track per channel at `<Channel>/_assets/music/bed.mp3`. → `04-assets/`
8. **Assemble (one-click) + polish (human, CapCut).** The Remotion assembler builds the rough cut:
   eased Ken Burns with varied origins, true crossfades for reveal frames, animated map route
   draw-on, branded caption typography, auto-ducked music bed, paper grain + vignette, and the
   end-card composition (watch-next + subscribe zones). CapCut is final *polish* — audio sweetening,
   SFX, trims — not build-from-scratch. **Never** use CapCut's built-in music. → `05-edit/rough-cut.mp4`
9. **SEO / metadata (one-click).** The Studio's **QC tab → Publish kit** generates the description
   (keyword-first, source list lifted from the fact-check), timestamped **chapters from real
   narration timings**, 5–10 tags, and the **pinned question comment**. Claude reviews/refines it.
   → `07-publish/publish-kit.md` + `description.txt` (sync into `06-metadata/metadata.md`)
10. **Pre-publish QC (machine-checked).** The Studio's **QC tab** lints the Definition of Done (§4)
    deterministically: hook rules, re-hook position, interrupt cadence, pacing, mid-roll ≥8:10,
    commentary share, missing assets, music bed. Fix every ❌ before upload. Optional unlisted test
    upload to confirm no Content-ID claim. → `07-publish/definition-of-done.md`
11. **Publish + early engagement (human).** Reply to comments within ~2–3 hours (engagement
    velocity boosts reach). Add the video to a topic playlist.
12. **A/B test packaging.** Run YouTube **Test & Compare** (up to 3 title/thumbnail variants) once
    impressions allow. Winner is decided by **watch-time share**, not raw CTR. → `07-publish/post-publish.md`
13. **ANALYTICS → NEXT VIDEO.** After every 5 videos, audit retention graphs and apply **one**
    focused fix to the next script. → `History/_analytics/retention-log.md`

---

## The Studio — interactive validation (the human's cockpit)

The human's decision-gates are made in a local web app, not by reading markdown. Claude generates
the options; the human clicks; decisions auto-save to disk.

**Launch:** `node Z:\Youtube\_studio\server.js` (or `cd _studio && npm start`) → open
**http://localhost:4317**. Leave it running while you work; Ctrl+C to stop.

**How it works:**
- Each video has a `studio.json` — the contract between Claude and the Studio.
- Claude writes the **candidates** (idea write-up, 10+ titles, rendered SVG thumbnail mockups, …)
  into `studio.json` and sets the relevant stage to `awaiting-human`.
- The human reviews the tabs (Idea → Packaging → Script → Scenes → QC) and makes the calls: pick a
  primary title, tick A/B variants, add their own, pick a thumbnail (shown full-size **and** at
  120×68 for the mobile-legibility test), hit the would-I-click gates, leave notes.
- Production runs from the **Scenes** tab: generate all images (Gemini, resume-safe), voice all
  narration (parallel; **Re-voice ALL** after a voice change), render accurate-map stills, and
  assemble the rough cut (sample range or full). The **Packaging** tab generates final thumbnail
  art from the picked wireframe. The **QC** tab machine-checks the Definition of Done, builds the
  publish kit, and shows the per-video spend ledger (`_studio/usage.json`).
- The server **only ever writes the human's `decision` objects** — it never overwrites Claude's
  candidates. Every click auto-saves.
- Claude then **reads `studio.json` decisions** and syncs them into the markdown record
  (`00-packaging/titles.md`, `06-metadata/metadata.md`, …) before moving to the next step.

**Rule:** never hand the human a wall of markdown when the choice is visual or comparative — put it
in the Studio. `studio.json` is the source of truth for human decisions; the markdown files are the
durable record.

**In-Studio chat (💬 Ask Claude):** the Studio has a chat panel that drives Claude headless on the
operator's **Max plan** — the server spawns `claude -p --permission-mode acceptEdits`, one persistent
session per video, with this file + the Style Bible + cast sheet as context. The operator iterates
*inside* the Studio (add/regenerate a thumbnail, rework titles, brainstorm) and Claude edits
`studio.json` directly; the UI auto-refreshes. It can edit files but not run arbitrary shell.

## 3. Production standards

**Length:** 8–12 min (target 8–10). Mid-roll ads unlock at 8:00; this range balances retention,
ad revenue, and production feasibility.

**Narration math** (documentary pace **130–140 WPM**; measure the real voice and adjust ±20–30):

| Video length | Target narration words |
|---|---|
| 8 min | 950–1,100 |
| 10 min | 1,200–1,400 |
| 12 min | 1,400–1,650 |

Write to word count *before* recording. Subtract proportionally for any 30s+ silent animation beat.

**Hook (first 3–15s) — mandatory:**
- Never open with a greeting, channel name, subscribe plug, or logo sting. The first spoken word is
  part of the tension.
- ~20% of viewers leave in the first 10s. <50% retention at 0:15 = failed hook → rewrite.
- **0:00–0:05** grab with ONE structure: **Open Loop**, **Cold-Open Question**, **Bold/Contrarian
  Claim**, or **In-Medias-Res**.
- **0:05–0:15** clarify the promise. **0:15–0:30** set the stakes / start the story.

**Retention architecture (8–12 min):**
- 0:30–1:30 Setup — stakes + plant 2–3 sub-loops ("we'll get to X").
- 1:30–4:00 Act I — first beat; resolve one sub-loop ~2:00 to reward early stayers, then open a new one.
- ~4:00–4:30 **Mid-video re-hook** — an explicit re-engagement line ("But here's where it gets strange…").
- 4:30–7:00 Act II — core insight; **pattern interrupt every 20–30s** (new graphic, text, music
  shift, surprising stat), always content-motivated.
- 7:00–8:30 Payoff — resolve the main loop; deliver exactly what the title/thumbnail promised.
- 8:30–end Synthesis + CTA — ONE most-memorable point; end screen → ONE specific "watch next."
- **Primary CTA goes mid-video, right after the biggest insight** (end-only CTAs convert worst).
- Benchmarks: 40%+ average percentage viewed is top-quartile education; clear 45%+ of viewers past 0:60.

**Editorial spine (the "No Nonsense" brand).** Every video is built around ONE non-obvious,
load-bearing insight — a specific reframing the viewer leaves with — set up early and paid off at the
climax; never a flat survey. Every video also (a) names and dismantles at least one specific myth or
misconception (Zed is the on-screen enforcer), and (b) labels consensus vs. active debate explicitly —
contested dates/claims are never stated as settled. This is both the moat and the engagement engine.

**Scene/shot pacing — content-driven, NOT a fixed cadence.** One standalone image per content beat
(sub-segment), held while its narration plays, then a hard cut when the content moves on. Hold time =
that beat's spoken length, so it varies naturally: a punchy line is its own brief image; a list →
one quick image per item; a dense idea, map, or reveal → one image held longer. **Cut on a
sentence/clause break, never mid-phrase.** The image **count emerges from the script**, not a divisor.
**Every image moves** — a subtle, content-motivated camera move (Ken Burns: push-in by default, pan
across maps/landscapes, static only for a deliberate hold or an infographic). Static stills + narration
reads as a slideshow — low retention *and* a monetization-policy risk — so motion, element reveals, and
the cast **acting** (not just posing) are mandatory, not optional. Each beat's motion / SFX / ambient /
text-animation / cast-action lives in the storyboard (Style Bible §10) and is auto-applied by the
assembler; CapCut becomes final polish, not build-from-scratch.

**Packaging rules (title + thumbnail come BEFORE the script):**
- **Titles:** 40–60 chars; primary keyword in the first 3–5 words; honest curiosity gap (the video
  must pay it off). Exact numbers beat round ones. Avoid generic superlatives ("Unbelievable") —
  they read as low-quality to an educated audience. Channel-tuned formulas live in `channel.md`.
- **Thumbnails:** max 2–3 elements; thick bold outlines (3–5px @ 1280×720); white/near-white OR
  dark background (avoid mid-tone gray — no contrast in either UI theme); ≤3–5 words of bold 700+
  sans-serif with a 2–3px outline; ONE dominant accent color on the key element; key element in the
  left ~60%. Test legibility at 120×68px and in both light and dark mode.

---

## 4. Per-video Definition of Done

Ship only when every box is true (the filled copy lives in `07-publish/definition-of-done.md`):

- [ ] Title–thumbnail pair passes "would I click?"; thumbnail legible at 120×68px in light + dark mode.
- [ ] Script hits the word-count target; hook in first 5s with no greeting; 2–3 sub-loops planted
      and resolved in sequence; mid-video re-hook present; main loop resolved at payoff.
- [ ] Every factual claim fact-checked against a cited source; source list in the description; zero
      pseudo-archaeology.
- [ ] Video is **structurally different** from the previous upload (Prime Directive #3).
- [ ] Narration is the branded ElevenLabs voice; commentary well above ~30% of runtime.
- [ ] Images follow the Style Bible; Ken Burns motion varied; cuts land on breath breaks; pattern
      interrupt cadence ≤30s.
- [ ] Music from a Content-ID-safe source (NOT the CapCut library); images are public-domain / AI /
      licensed only.
- [ ] Metadata complete: description (keyword in first 2 sentences), chapters, 5–10 tags, end
      screen, pinned question comment.
- [ ] AI disclosure assessed (animated → exempt; confirm no realistic-person impersonation).
- [ ] Production log (`sources.md`) updated with sources, angle, and editorial decisions.
- [ ] A/B test queued; video added to a playlist.

---

## 5. Folder & naming conventions

```
Z:\Youtube\
├─ CLAUDE.md                     ← this file (global rules)
├─ _studio\                      ← interactive validation app: `node _studio/server.js` → localhost:4317
├─ _templates\
│  ├─ new-channel-blueprint.md   ← copy to <Channel>\channel.md to launch a new channel/category
│  └─ _video\                    ← per-video skeleton; COPY this to start every new video
├─ History\                      ← CHANNEL 1 (active): deep human prehistory
│  ├─ channel.md                 ← this channel's niche, positioning, voice, visual identity
│  ├─ _ideas.md                  ← idea bank + scoring
│  ├─ _assets\
│  │  ├─ style-bible.md          ← THE visual-consistency source of truth (read before generating)
│  │  ├─ character-sheet\        ← reference frames for recurring characters
│  │  ├─ brand\                  ← logo, banner, overlays (human-created, for IP ownership)
│  │  └─ music\                  ← downloaded Content-ID-safe tracks + attribution
│  ├─ _analytics\retention-log.md
│  └─ <NNN-slug>\                ← one folder per video; step subfolders + studio.json (e.g. 001-humans-every-continent)
```

**To start a new video:** copy `_templates\_video\` to `History\<NNN-slug>\` (zero-padded number +
kebab-case slug, e.g. `002-why-humans-different-colors`). Work the numbered subfolders in order.

**To start a new channel/category:** make a sibling folder of `History\`, copy
`_templates\new-channel-blueprint.md` into it as `channel.md`, and fill it in. Same global CLAUDE.md
rules apply. (The existing `History\Smjorg\` folder predates this system — fold it into the
`<NNN-slug>` convention when you resume it.)

---

## 6. Toolchain (lean — ~$10–25/mo, full commercial rights)

| Layer | Tool | Cost | Notes |
|---|---|---|---|
| Narration | **ElevenLabs** | $5–22/mo | Default model is **`eleven_turbo_v2_5` (½ credit/char)** — a full ~7.5k-char video ≈ 3.7k credits, so **Starter ($5/mo, 30k) covers 1/week with re-voices to spare**; upgrade to Creator only if output scales. Full commercial+monetization license. |
| Images | **Gemini 2.5 Flash Image (Nano Banana)** API | ~$0.039/img (~$3–4/video) | **Auto-batched in the Studio** (Scenes → Generate all images): each shot gets the cast sheet + per-character refs + previous frame for consistency, saved to `04-assets/images/`. Map beats are FREE (d3-geo engine, no API). Final thumbnail art ~$0.08 (2 variants). ChatGPT GPT-image is a manual fallback. |
| Assembly | **Remotion** (`_studio/render/`) | $0 | One-click rough cut: Ken Burns, crossfades, animated maps, captions (embedded Permanent Marker / Archivo Black), auto-ducked music, grain+vignette, end card. |
| Editing | **CapCut Free** | $0 | Final polish only. No watermark. ⚠️ Never use its built-in music (Content-ID). Fallback: **DaVinci Resolve** (free, zero ToS risk). |
| Music | **YouTube Audio Library** | $0 | Pre-cleared, monetizable, Content-ID-safe. Drop ONE track per channel at `<Channel>/_assets/music/bed.mp3` — the assembler finds and ducks it automatically. |

**Spend ledger:** every Gemini image and ElevenLabs character is logged to `_studio/usage.json`;
the QC tab shows per-video and total spend. Marginal cost ≈ **$4–5/video** all-in.

**Image generation & consistency:** the Studio auto-generates every scene image via the **Gemini
(Nano Banana) API**. On the Scenes page: *Lock the cast* once (creates per-character reference
portraits from `cast-sheet.png`), then *Generate all images* — each call passes the cast sheet + the
scene's character refs + the previous frame, with a "keep exactly consistent" instruction, saving
PNGs to the video's `04-assets/images/`. It resumes (skips images you already have) and shows
thumbnails as they finish. Manual fallback: paste prompts into ChatGPT with the cast sheet attached.
The Gemini key is stored locally in `_studio/.secrets.json` (or `GEMINI_API_KEY`). Do **not** use the
CapCut built-in music library (Content-ID).

---

## 7. Monetization map

- **Expanded YPP (fan-funding only)** at **500 subs + 3 uploads/90 days + (3,000 watch-hours/12mo OR
  3M Shorts-views/90 days)** — country-restricted; verify eligibility. Apply here first.
- **Standard YPP (ad revenue)** at **1,000 subs + (4,000 public watch-hours/12mo OR 10M Shorts-
  views/90 days)** + no strikes + 2FA + linked AdSense. Long-form hours and Shorts views **cannot
  be combined**; Shorts watch time does **not** count toward the 4,000 hours. Review takes ~1 month.
- **RPM reality:** ~$5–7 for this niche/Tier-1 audience. Severe seasonality (≈$4–6 Jan–Feb/Jul–Aug →
  up to ~$14 Nov–Dec) — budget on the low baseline, treat Q4 as bonus.
- **Real upside = sponsors** (CuriosityStream, MagellanTV, Brilliant, Audible): ~$1,500–5,000/video
  by 50–100K subs. Build an email list / Discord early as the audience asset sponsors want.

---

## 8. Watch list (revisit quarterly)

- Whether stylized/animated AI visuals ever start requiring disclosure (currently exempt).
- Whether a generic AI narrator voice is explicitly classed exempt (currently silent → likely exempt).
- ElevenLabs Creator price/credits and Recraft real per-image credit burn — verify before relying on them.
- CapCut's unresolved US-ownership situation (keep DaVinci Resolve as fallback).
- AI images are likely **not copyrightable** (public domain) — protect the brand via a trademarked
  name + human-made overlays; never depict real people / brands / known-artist styles.
