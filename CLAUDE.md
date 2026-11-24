# CLAUDE.md — YouTube Studio Operating System

This file governs **every** Claude session in this workspace. Read it first, every time.

It is the *global* operating system. Each channel lives in its own folder with a `channel.md`
that holds the niche-specific details. **Before producing anything, read both this file AND the
active channel's `channel.md` and `_assets/style-bible.md`.**

> **Active channel:** `MyChannel/` — a blank starter channel. Rename the folder to your channel's name
> and fill in its `channel.md` before producing anything (see SETUP.md §5).

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
   pipeline). Cite sources in the description. This also protects the channel's credibility.
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
   `<channel>/_ideas.md`. → kill weak ideas before any work.
2. **PACKAGING FIRST — title, *then* thumbnail.** Generate **10+ titles**; the human locks ONE in
   the Studio. *Then* generate **~6 deliberately diverse thumbnail concepts built for that exact
   title** — a title and thumbnail are one pair, never generated in parallel. The human picks one,
   or steers a fresh batch with 🔥/❄️ + a re-aim note. Studio mockups are wireframes: lock the
   *direction*; final art is produced at Step 7. **If no pair lands, change the title or the idea.**
   → `00-packaging/`, `studio.json`
3. **Research + sourcing brief.** Compile the factual backbone with **primary/credible sources**
   (peer-reviewed papers, Smithsonian/museum pages, Scientific American, university pages). State
   the channel's specific angle. For a thorough, separately-sourced pass, the Studio's Script tab has
   **🔬 Deep research** (headless Claude + live web search → a dedicated brief the script then builds on).
   → `01-research/research-brief.md`
4. **FACT-CHECK gate.** Verify every load-bearing claim against the Step-3 sources. Flag anything
   contested. Strip pseudo-archaeology. Output the description's source list. → `01-research/sources.md`
5. **Script.** Write to the target word count (§3) with the hook delivering the title's promise and
   the climax resolving the thumbnail's tension. The script is **pure narration** — one voiceover; the cast (the channel's recurring characters) appears only in the visuals, never as dialogue or speaker lines. Inline scene direction (`[CUT TO: …]`,
   `[TEXT: "…"]`) and explicit `[HOOK]` / `[LOOP]` / `[RE-HOOK]` / `[CTA]` markers. → `02-script/script.md`
6. **Scene list + image prompts.** Numbered scenes, each with narration + a per-image generation
   prompt referencing the **Style Bible** (Custom Style + character sheet). CSV for batch work.
   → `03-scenes/scene-list.csv`
7. **Asset generation (one-click in the Studio).** Scene images batch-generate via Gemini
   (sequential, consistency-chained); accurate-map beats render via the d3-geo map engine (free) and
   data beats (durations/quantities/dates/trends) as deterministic **infographics + animated plot
   curves** (free, always-correct); narration voices via ElevenLabs (parallel, resume-safe, exact
   durations + breathing gap); final thumbnail art generates from the picked wireframe (~$0.04/variant).
   Optional per-beat: **real-artifact photo cutaways** via Pexels (📷, artifacts-only — the actual
   mummy/cave-art/site as a field-guide "specimen plate") and **Veo image→video** motion clips on hero
   beats (🎬, OFF by default — slow/pricey, needs Veo access). The human only drops ONE Content-ID-safe
   music track per channel at `<Channel>/_assets/music/bed.mp3`. → `04-assets/`
8. **Assemble (one-click) + polish (human, CapCut).** The Remotion assembler builds the rough cut:
   eased Ken Burns + a subtle continuous "breathing" drift so no frame is dead-still, true crossfades
   for reveal frames, animated map route draw-on, animated plot/curve infographics, stat-cue count-ups,
   transient voice-synced kinetic captions, opt-in content-motivated ambient particles (embers/snow/
   spores/dust), real-artifact specimen-plate frames + Veo motion-clip beats, branded caption typography,
   auto-ducked music bed, paper grain + vignette, and the end-card composition (watch-next + subscribe
   zones). CapCut is final *polish* — audio sweetening, SFX, trims — not build-from-scratch. **Never** use
   CapCut's built-in music. → `05-edit/rough-cut.mp4`
9. **SEO / metadata (one-click).** The Studio's **QC tab → Publish kit** generates the description
   (keyword-first, source list lifted from the fact-check), timestamped **chapters from real
   narration timings**, 5–10 tags, the **pinned question comment**, and timed **subtitles** (`.srt`/`.vtt`
   from the real narration timeline) — which can be **translated into other languages** (🌍, via Gemini)
   for extra reach. Claude reviews/refines it.
   → `07-publish/publish-kit.md` + `description.txt` + `subtitles.*.srt` (sync into `06-metadata/metadata.md`)
10. **Pre-publish QC (machine-checked).** The Studio's **QC tab** lints the Definition of Done (§4)
    deterministically: hook rules, re-hook position, interrupt cadence, pacing, mid-roll ≥8:10,
    commentary share, missing assets, music bed. Fix every ❌ before upload. Optional unlisted test
    upload to confirm no Content-ID claim. → `07-publish/definition-of-done.md`
11. **Publish + early engagement (human).** Reply to comments within ~2–3 hours (engagement
    velocity boosts reach). Add the video to a topic playlist.
    > **Shorts funnel:** once the long video is **public**, run the Studio's **🔗 Sync funnel** (Shorts tab).
    > It rewrites every published Short's description link to the correct live URL, flags any private/dead
    > destination, and writes `<channel>/_assets/shorts-funnel-checklist.md` for the Studio-only levers (set
    > each Short's **Related video** + pin the funnel comment). A Short must point at a PUBLIC long video or
    > the funnel is dead — Shorts are the discovery engine, the long video is the destination.
12. **A/B test packaging.** Run YouTube **Test & Compare** (up to 3 title/thumbnail variants) once
    impressions allow. Winner is decided by **watch-time share**, not raw CTR. → `07-publish/post-publish.md`
13. **ANALYTICS → NEXT VIDEO.** After every 5 videos, audit retention graphs and apply **one**
    focused fix to the next script. → `<channel>/_analytics/retention-log.md`

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

**Narration math — DON'T trust the old 130–140 WPM textbook number.** A typical branded ElevenLabs
narrator (`turbo_v2_5`) reads at a **measured ~167 WPM** — ~24% faster than the documentary
average. Writing to 135 WPM is exactly why early videos came in ~2 minutes short of their titles.
**The Studio now measures WPM from your real voiced audio and computes the word target for you** (the
🎯 Target-length control on the Script tab); always write to *that* number, not a guess. The table
below is the calibrated fallback at ~167 WPM (raise/lower it if you re-measure a different voice):

| Video length | Target narration words (@ ~167 WPM) |
|---|---|
| 8 min (floor) | 1,350–1,450 |
| 8.5 min | 1,420–1,520 |
| 9 min | 1,500–1,600 |
| 10 min | 1,650–1,750 |
| 12 min | 1,950–2,100 |

**Length is a hard floor, not a target you can undershoot:** the finished video (narration + ~12s end
card) must clear **8:00** or it forfeits mid-roll ads. Write to word count *before* recording, aim
slightly OVER (≈10% headroom, since storyboarding drops a few words), and never ship under the floor —
the QC tab's `mid-roll-length` and `target-length` checks enforce this deterministically. Subtract
proportionally for any 30s+ silent animation beat.

**Hook (first 3–15s) — mandatory:**
- Never open with a greeting, channel name, subscribe plug, or logo sting. The first spoken word is
  part of the tension.
- ~20% of viewers leave in the first 10s. <50% retention at 0:15 = failed hook → rewrite.
- **0:00–0:05** grab with ONE structure: **Open Loop**, **Cold-Open Question**, **Bold/Contrarian
  Claim**, or **In-Medias-Res**.
- **0:05–0:15** clarify the promise. **0:15–0:30** set the stakes / start the story.

**Hook craft — the two-job model (the single biggest retention lever; applies to long-form openings AND Shorts).**
A hook has ONE job: get the viewer to opt in and keep watching. It does that by delivering exactly two
things — **topic clarity** (they instantly know what this is about) and **on-target curiosity** (it's for
*them*, a payoff is coming, and they need to know what's next). Hooks fail by committing one of four
mistakes: **① Delay** — context comes too late, or a content-free tease ("you won't believe this", "the
craziest thing") names nothing the viewer can grab → cut to a concrete subject in the first line ("speed
to value"). **② Confusion** — comprehension loss; fix with plain ~6th-grade words, active voice, and one
unambiguous reading per sentence (read it cold: is there a second way to read this?). **③ Irrelevance** —
the viewer isn't sure it's for them; fix with "you/your" framing + agitating the exact curiosity/pain the
video resolves. **④ Disinterest** — clear and relevant but not gripping; fix by opening a **curiosity loop
through CONTRAST** — the gap between what the viewer assumes (A) and the reframe you deliver (B), stated
("everyone pictures X; the bone says Y") or implied. *Our myth→evidence spine IS this A-vs-B contrast.* A
hook is usually **2–3 lines**: topic clarity first, contrast next. **Long-form vs Shorts:** on a Short the
spoken hook carries everything in ~1.5s, so all four rules bind hard (enforced in the Shorts analyzer). On
long-form the **title + thumbnail already delivered topic clarity before the hook plays**, so the opening
shouldn't *re-explain* the topic — it reconfirms it *concretely* and leans on **contrast + relevance**.
(Machine-checked: `opening-vague-tease` flags a content-free tease opener; the other `opening-*` checks
cover greeting/deceleration/title-congruence/sub-loops. Source: Kallaway's four-hook-mistakes framework.)

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
- **Openings: escalate, never decelerate.** Pick ONE opening archetype (in-medias-res · impossible-object
  · contrarian-claim · cold-open-question · open-loop · body-anchor) and vary it from the previous video.
  Confirm the title's promise in the first ~30s. Through 0:15–1:00, raise stakes / open loops — never "back
  up to explain." HOLD the real payoff for the climax. **Banned:** "start at the beginning," chronological
  date-marches, date/qualifier dumps in the first ~150 words, setup hedges ("fizzled out…"). Optimize for
  absolute watch time (AVD), not % viewed. (Machine-checked at generation + in the QC tab's opening-* checks.)

**Editorial spine (the channel's credibility edge).** Every video is built around ONE non-obvious,
load-bearing insight — a specific reframing the viewer leaves with — set up early and paid off at the
climax; never a flat survey. Every video also (a) names and dismantles at least one specific myth or
misconception, and (b) labels consensus vs. active debate explicitly —
contested dates/claims are never stated as settled. This is both the moat and the engagement engine.

**Narration voice — sound like one real person, not a script-reader.** The script tab has a **🎭 persona
picker** (e.g. *The Skeptic Friend* — the evidence-first default — *The Storyteller*, *The Excitable
Nerd*); the chosen persona sets the *character*, and the craft rules below are the universal bar every
persona obeys. Add/override personas per channel via `<channel>/_assets/script-personas.json`. As a
baseline, write the way a sharp, curious person in their late twenties *talks* when they know the
subject cold and are explaining it to a smart friend who's new to it. It's read aloud over animation, so it must sound spoken: contractions
(required, not optional), varied sentence length, some lines short and punchy, every sentence sayable
in one breath. Have a point of view — a little opinionated, dryly funny, or genuinely excited.
Concrete images and specific named examples over abstract summary — show the idea, don't label it.
Open cold on the hook; one idea at a time with the occasional beat to land a point; end on the
strongest line, no tacked-on recap. **Banned AI tells** (instant rewrite): *delve, tapestry, realm,
testament, navigate the complexities, in today's world, it's worth noting, moreover, furthermore, in
conclusion*; hollow hedging ("some might argue", "it's important to consider"); the "it's not just X,
it's Y" construction; mechanical lists of exactly three; opening every section with a rhetorical
question. The script generator enforces this; hold any hand-written or chat-revised script to the same bar.

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
- [ ] Early-retention QC passes: no greeting opener and **no deceleration move in the 0:15–1:00 setup**
      (hard ❌); title promise lands in the first ~30s; no date-march; ≥2 Act-I sub-loops; opening archetype
      varied from the previous video. (Machine-checked in the QC tab via the opening-* checks.)
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
<project root>\
├─ CLAUDE.md                     ← this file (global rules)
├─ _studio\                      ← interactive validation app: `node _studio/server.js` → localhost:4317
├─ _templates\
│  ├─ new-channel-blueprint.md   ← copy to <Channel>\channel.md to launch a new channel/category
│  └─ _video\                    ← per-video skeleton; COPY this to start every new video
├─ MyChannel\                    ← CHANNEL 1 (active): rename to your channel
│  ├─ channel.md                 ← this channel's niche, positioning, voice, visual identity
│  ├─ _ideas.md                  ← idea bank + scoring
│  ├─ _assets\
│  │  ├─ style-bible.md          ← THE visual-consistency source of truth (read before generating)
│  │  ├─ character-sheet\        ← reference frames for recurring characters
│  │  ├─ brand\                  ← logo, banner, overlays (human-created, for IP ownership)
│  │  └─ music\                  ← downloaded Content-ID-safe tracks + attribution
│  ├─ _analytics\retention-log.md
│  └─ <NNN-slug>\                ← one folder per video; step subfolders + studio.json (e.g. 001-my-first-video)
```

**To start a new video:** copy `_templates\_video\` to `<Channel>\<NNN-slug>\` (zero-padded number +
kebab-case slug, e.g. `002-why-the-sky-is-blue`). The Studio's **＋ New project** button does this for you. Work the numbered subfolders in order.

**To start a new channel/category:** make a sibling folder of your first channel, copy
`_templates\new-channel-blueprint.md` into it as `channel.md`, and fill it in. Same global CLAUDE.md
rules apply.

---

## 6. Toolchain (lean — ~$10–25/mo, full commercial rights)

| Layer | Tool | Cost | Notes |
|---|---|---|---|
| Narration | **ElevenLabs** | $5–22/mo | Default model is **`eleven_turbo_v2_5` (½ credit/char)** — a full ~7.5k-char video ≈ 3.7k credits, so **Starter ($5/mo, 30k) covers 1/week with re-voices to spare**; upgrade to Creator only if output scales. Full commercial+monetization license. |
| Images | **Gemini 2.5 Flash Image (Nano Banana)** API, default; **Gemini 3 Pro Image** for HQ | ~$0.039/img std · ~$0.134/img HQ (~$3–4/video) | **Auto-batched in the Studio** (Scenes → Generate all images): each shot gets the cast sheet + per-character refs + previous frame for consistency, saved to `04-assets/images/`. **Two tiers:** scenes default to 2.5 Flash; **thumbnail art + any beat with the per-scene ✨HQ toggle render on Gemini 3 Pro** (crisper text/composition — use selectively on hero shots). Map beats are FREE (d3-geo engine, no API). ChatGPT GPT-image is a manual fallback. |
| Assembly | **Remotion** (`_studio/render/`) | $0 | One-click rough cut: Ken Burns + subtle continuous breathing, crossfades, animated maps, **animated plot/curve infographics**, **stat count-ups**, kinetic captions (embedded fonts), **opt-in ambient particles**, **real-artifact specimen plates**, **Veo motion-clip beats**, auto-ducked music, grain+vignette, end card. |
| Editing | **CapCut Free** | $0 | Final polish only. No watermark. ⚠️ Never use its built-in music (Content-ID). Fallback: **DaVinci Resolve** (free, zero ToS risk). |
| Music | **YouTube Audio Library** | $0 | Pre-cleared, monetizable, Content-ID-safe. Drop ONE track per channel at `<Channel>/_assets/music/bed.mp3` — the assembler finds and ducks it automatically. |
| Real footage *(optional)* | **Pexels** API | $0 (free key) | Real-artifact photo cutaways (📷 on a beat → field-guide "specimen plate"). Commercial-use, no attribution required. **Artifacts/sites only, sparingly** — broad stock B-roll erodes the animated-identity moat (§1). |
| Motion video *(optional, OFF by default)* | **Google Veo** via the Gemini API | pay-per-clip (pricey) | Image→video on hero beats (🎬). Uses the existing Gemini key but needs **Veo access**; slow. Off by default — toggle on in the Scenes tab only when wanted; re-confirm "clearly animated → exempt" before relying on it. |
| Captions/translation | **Gemini text** (existing key) | ~$0.0001/lang | Timed `.srt`/`.vtt` from real narration timings, **translated into other languages** (🌍) for reach — visuals are universal, only the captions change. |

**Spend ledger:** every Gemini image (Flash vs Pro split) and ElevenLabs character is logged to an
append-only event ledger (`_studio/usage-events.jsonl`) + `usage.json`; the QC tab's 💰 Spend panel shows
per-video and total cost **with re-renders/re-voices itemized**. Marginal cost ≈ **$4–5/video** all-in.

**QC feedback loop:** every QC run is recorded (`07-publish/qc-log.json` + a per-channel
`_analytics/qc-trends.json`); checks that fail/warn across multiple videos surface as **recurring issues**
(QC tab + `GET /api/qc-trends`) so repeated mistakes get fixed at the generator level, not one video at a time.

**Image generation & consistency:** the Studio auto-generates every scene image via the **Gemini
(Nano Banana) API**. On the Scenes page: *Lock the cast* once (creates per-character reference
portraits from `cast-sheet.png`), then *Generate all images* — each call passes the cast sheet + the
scene's character refs + the previous frame, with a "keep exactly consistent" instruction, saving
PNGs to the video's `04-assets/images/`. It resumes (skips images you already have) and shows
thumbnails as they finish. Manual fallback: paste prompts into ChatGPT with the cast sheet attached.
The Gemini key is stored locally in `_studio/.secrets.json` (or `GEMINI_API_KEY`) — as is the optional
`pexelsKey` (real-artifact cutaways) and the `veoEnabled` flag (Veo image→video, false by default). Do
**not** use the CapCut built-in music library (Content-ID).

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
