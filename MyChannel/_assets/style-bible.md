# Style Bible — <Your Channel>

**The single source of truth for visual consistency. Read before generating ANY image.**
Style drift accumulates over 60–120 images per video — the fix is to **re-attach the same
references on every single generation**, not to trust the model's memory.

Fill in §1–7 and §9 for your channel. §8 and §10 are the format rules the Studio's generators already
follow — keep them unless you're deliberately changing the format.

---

## 1. Art-style spec

| Attribute | Spec |
|---|---|
| Background | _<full colored scene that sets the mood? plain white? textured paper?>_ |
| Outlines | _<e.g. black, hand-drawn, thick, marker/doodle feel>_ |
| Characters | _<your recurring cast (§4) — body style, faces, how emotion reads>_ |
| Color | _<flat fills? light shading? mood palette per scene?>_ |
| Realism | **None** — no photorealism, no gradients, no 3D (keeps the channel clearly animated; see CLAUDE.md §1) |
| Aspect | 16:9 |

## 2. Master style prompt (paste into every generation, prepended to the scene)

```
<One paragraph describing the look: drawing style, cast (attach the cast sheet), environment,
outlines, color, "no photorealism", "hold proportions to the cast sheet", 16:9.>
SCENE: <scene-specific description, naming which cast members appear and their expression>
```

## 3. Color palette

- Base: _<e.g. black outlines on white>_
- Primary accent (pick ONE, reuse everywhere for brand recognition): `#______`
- Optional secondary (sparingly): `#______`

## 4. Recurring cast (canonical — see `character-sheet/cast-sheet.png`)

Until you make your own, the Studio uses a built-in default cast of four stick figures
(Max / Luna / Zed / Nova). To use your own: Studio → 🎭 Character sheets → generate or upload a cast
sheet, and list each character in `character-sheet/cast.json` (`[{ "name", "desc", "color": { "skin", "hair" } }]`).

| Character | Look | Personality | Role in videos |
|---|---|---|---|
| _<NAME>_ | _<look>_ | _<personality>_ | _<e.g. audience proxy who asks the question>_ |
| _<NAME>_ | _<look>_ | _<personality>_ | _<e.g. the skeptic who demands evidence>_ |
| _<NAME>_ | _<look>_ | _<personality>_ | _<e.g. the explainer who gives the grounded answer>_ |

**Use the cast as a narrative engine:** _<e.g. A wonders → B doubts → C explains → D marvels>_.

## 5. Image tool

The Studio generates images with Gemini automatically (Scenes → Generate all images), passing the
cast sheet + per-character refs + the previous frame for consistency. Record any tool settings or
manual-fallback notes (e.g. ChatGPT with the cast sheet attached) here.

## 6. Narrator voice (lock once, reuse forever)

Pick it in the Studio (Scenes tab → Browse & test voices); it's saved to `_assets/voice.json`.
Note the voice name, model and settings here so it never drifts: _<voice, model, stability, style>_

## 7. Per-image generation checklist (every single image)

- [ ] Cast sheet attached; only the named characters appear
- [ ] ONE single scene (no split panels / before-after diptychs)
- [ ] Matches §1 style and §3 accent; no photorealism
- [ ] Nothing that depicts a real person, brand, or known artist's style

## 8. On-screen text & infographics

**Critical text is an OVERLAY, never baked into the AI illustration.** AI models garble numbers and
phrases, and baked text is fixed-size and uneditable. So scene illustrations are generated CLEAN (no
caption drawn in), and the words are added as a **CapCut text layer** on top — where they can be big,
correctly spelled, animated to land on the spoken word, and fixed for free.

**⭐ Captions are CUES, not subtitles (the four-gates rule, 2026-06-18).** Default is **NO on-screen text**.
A beat earns a cue ONLY if it clears one gate: (a) an unfamiliar **NAME** on first mention (`label`);
(b) a **NUMBER/stat** (`stat`); (c) the **one turn / myth-bust / payoff** in the beat (`reveal`, max one);
(d) a scripted **hook / re-hook / [TEXT]** cue (`marker`). NEVER caption a paraphrase of the narration,
words the ear catches plainly, a second cue just because the beat is long, or ANYTHING on a map/infographic
beat (they carry their own labels). **Cues are transient** — each appears on its spoken word, holds ~1–1.5s,
then leaves; they are NOT held for the whole beat. **Case:** write text in Mixed Case and ALL-CAPS only the
ONE emphasis word (the `emph` token). Cues sync to the voice via the stored ElevenLabs word timings (even
spacing as a fallback). The generator emits these in the storyboard's `cues` column; the assembler renders
them — CapCut is only for hand-polish. (Restraint is the point: most beats get no text.)

- **Default placement: TOP-CENTER**, but assess per scene — a running place-name may sit lower-third;
  one big reveal may punch dead-center. The Studio shows each scene's caption positioned on the image
  so you can see and adjust it per shot.
- **Write kinetic captions like a short-form creator — AMPLIFY, don't transcribe.** A caption surfaces
  the single most arresting thing in the beat in **2–4 ALL-CAPS words**, readable in under a second — it
  never repeats the narration. Caption a beat when it has: **(a) a NAME/entity the moment it's introduced**
  — species, place, person — because viewers can't catch unfamiliar names by ear, so SHOW them
  (`NEANDERTHALS`, `DENISOVANS`, `THE HOBBIT`); **(b) a key NUMBER/stat** (`99% OF OUR HISTORY`,
  `2 MILLION YEARS`); **(c) a myth-bust/reversal/surprise as a punch word** (`NOT US`, `WRONG`,
  `BIGGER THAN OURS`); **(d) the hook, the re-hook, and every script `[TEXT:"…"]` cue.**
- **Be SPARSE — captions are accents, not subtitles.** Caption only the highest-impact beats (a key
  number, the single biggest reveal/turn, the hook, the mid-video CTA, at most a couple of hard-to-catch
  names); **most beats get no caption.** Aim for roughly **1 caption every 3-4 beats**, never wall-to-wall.
  Leave calm/transition beats and infographic beats (own labels) blank, and vary the type so they don't
  feel same-y.
- **The caption LOOK is set in the Studio → Scenes → "🎨 Caption style" panel** (per channel): font,
  color, size, case, legibility treatment. It's stored in `<channel>/_assets/caption-style.json` and both
  the Remotion render and the scene-card previews read it. Default = **Gloria Hallelujah** handwriting,
  cream, sentence-case, soft-shadow — playful, on-brand for the whiteboard look.
- **Style:** bold sans (match the thumbnail font), white or the ONE channel accent, thick dark stroke
  + drop shadow so it reads on any background, inside title-safe margins (~10% from edges).
- Generated illustrations should **leave headroom at the top-center** for the caption.

**Technical beats are rendered DETERMINISTICALLY, not by the image model.** Image models hallucinate
geography and garble numbers/labels, so anything that carries PRECISE INFORMATION is drawn by code:

- **Maps → the d3 map engine** (`render/src/Map.jsx` + `gazetteer.mjs`). Set `kind:"map"` and a
  `scene.map` spec: `{ rotateLng, focus:[[lng,lat]…], labelStyle:"serif", markers:[{place|coord,label,color}],
  blobs:[{place|coord,rx,ry,fill,opacity}], routes/arcs:[…] }`. Author places by NAME (e.g.
  `{place:"el sidron"}`) — the gazetteer resolves the correct coordinate, so El Sidrón, Gibraltar, the
  Neander Valley etc. always land in the right spot on REAL coastlines. Add new places to `gazetteer.mjs`.
  `markers` = labelled dots (dig sites, groups); `blobs` = translucent region shading (a species range);
  `routes`/`arcs` = animated migration arrows. Re-render via `node render/render-one-map.mjs <ch> <id> all --force`.
- **Timelines / comparisons / charts / trend curves → the infographic engine** (`render/src/Infographic.jsx`).
  Set a `scene.infographic` spec — `{type:"timeline", title, axis:{from,to}, bars:[{label,from,to,color,sublabel}],
  overlap:{from,to,label}, markers:[{at,label}], note}`, `{type:"compare", items:[{label,value,valueLabel,color}]}`,
  or `{type:"plot", smooth, title, xFrom, xTo, xFromLabel, xToLabel, xLabel, yLabel, yUnit, yMax,
  series:[{color, valueLabel, points:[[x,y] | [x,y,"callout"]]}], markers}` — the **plot** is the math-viz
  curve for a quantity over time (growth / decay / trend): it draws on left→right, supports `smooth` bezier,
  per-point callouts, and a **reversed "years-ago" axis** (set `xFrom`>`xTo`). The labels and proportions are
  CODE, so they're always correct. Set/clear via `POST /api/set-infographic {n, infographic}` (validated by
  `lib/infographic.js`) or `node render/render-one-infographic.mjs <ch> <id> all --force`. (Typeset LaTeX
  equations aren't supported — this channel doesn't need them; the curves/charts cover the real math-viz.)
- **Only a purely PICTORIAL diagram** (an icon montage, a family-tree shape, a DNA helix) stays a
  Gemini-drawn `kind:"infographic"` — and it must be **WORDLESS**. Never let the model draw text,
  numbers, axes, boards or "measurements"; those garble and the precise value belongs in the overlay.

When the scene list is generated, geographic beats are written as `image_prompt: "MAP: …"` and data
beats as `"TIMELINE: …"` / `"COMPARE: …"`; the producer then fills the structured `map`/`infographic`
spec (using the gazetteer for coordinates) before rendering.

## 9. Thumbnail style profile

Calibrate from 5–10 top thumbnails in your niche, then write the rules here: _<background treatment,
subject size/placement, headline font + color, accent use, what makes yours recognizable>_. The
Studio's thumbnail generator reads this section. Baseline rules (CLAUDE.md §3): max 2–3 elements, ONE
accent, ≤3 bold words, the hero subject in the left ~60%, legible at 120×68 in light AND dark mode.

## 10. Motion & audio vocabulary (the edit blueprint)

The scene list is an **edit-ready storyboard**: every beat carries motion, on-screen-text animation,
SFX, an ambient bed, and a music cue, plus a cast action. These controlled vocabularies are shared by
the scene generator, the Studio, and the auto-assembler — use these exact tokens.

**Cue archetypes (the `cues` column — transient, voice-synced on-screen text; see §8).** Each cue appears on
its spoken word, holds ~1–1.5s, then leaves: `label` (a name, lower-third), `stat` (pop on a number),
**`build`** (an enumeration — items pop in one-by-one on their word and **STACK**, earlier ones dimming, then
clear together; the flagship — use it whenever the narration lists things), `reveal` (the one payoff word, big
centered punch), `marker` (hook / re-hook overlay). The assembler resolves each cue's timing from the stored
ElevenLabs word timings (even spacing as a fallback) and renders the build stack automatically.

**The assembler applies this vocabulary automatically.** `Scenes → Assemble rough cut` (Remotion)
reads the storyboard from `studio.json` and produces `05-edit/rough-cut.mp4` with the Ken Burns
move per beat (origin/intensity varied so no two adjacent beats move alike), true crossfades (never
a flash-to-black), animated captions in the brand typography (Archivo Black + Permanent Marker,
cream/ink/accent palette), film grain + vignette to unify the AI stills, a ducked music bed from
`_assets/music/bed.mp3`, and the branded 12s end card. CapCut is final *polish* (SFX placement,
fine trims) — never build-from-scratch.

**Map beats are rendered, not drawn by Gemini.** Any beat whose content is geography (a route, a
land bridge, a coastline, "where X is") gets `kind: "map"` plus a `scene.map` spec (projection
`focus`, label list, `route` waypoints) in `studio.json`. The Studio renders an accurate d3-geo map
still for preview (`Render map` button / `render-one-map.mjs`), and the assembler animates the same
spec live — the route **draws itself across the map** during the beat. Never ask Gemini to invent
geography: hand-drawn-style continents with wrong shapes are exactly the credibility leak this
evidence-first channel can't afford. Map style: parchment-tint ocean, sage land, serif small-cap labels,
accent-orange route with arrowhead (see `map-LABELS-serif.png` reference in any video's `05-edit/`).
- **Routes must be accurate AND show the real complexity.** `scene.map.routes` is an ARRAY of polylines — use **multiple routes in different directions** when the science says so (a dispersal that fans out, two corridors, a back-migration), never a single token arrow. Trace `[lng,lat]` waypoints over real coastlines. **Label consensus vs. debate** per the brand — show the consensus route as the hero and don't crown a contested one. (001's out-of-Africa beats: scene 14 = southern exit, 16 = the earlier *failed* Levant attempt, 17 = the multi-branch fan-out to Europe/Siberia/E-Asia/Australia.)
- **Map beats use `motion: "static"` in a route sequence.** The route **draw-on is the motion** — a Ken Burns zoom on top makes consecutive map beats "zoom-bounce" and kills continuity. `MapBeat` honors `static` (dead-steady camera); reserve a gentle push for a single standalone map.

**Image prompts must describe ONE single scene.** Words like "then", "before/after", "on one side… on the other", "split" make Gemini render a **two-panel diptych with a white border/gutter** (it happened on 001's scenes 30 & 33). Write one cohesive moment; the global style suffix now also forbids panels/borders and demands full-bleed edge-to-edge art.

**Motion (Ken Burns — every illustration moves; static stills are the enemy of retention):**
`push-in` (default — slow zoom toward the subject) · `push-out` (reveal scale/context) ·
`pan-left` / `pan-right` (drift across a map or landscape) · `static` (default for infographics, or a
deliberate hard hold). Keep it subtle (~5–10% over the beat) and vary direction so it never feels
mechanical.

**Text animation (how the caption enters):** `punch` (scale-bounce in — for a hard stat/number) ·
`fade` · `type` (typewriter) · `none` (no caption this beat).

**SFX (0–2 per beat, content-motivated):** `whoosh` (cut/transition) · `pop` (element reveal) ·
`ding` (key stat lands) · `thud` · `riser` (building to a reveal) · `water` · `wind` · `fire` ·
`click` · `page` (chapter turn) · `boom`. Source **CC0 only** (Pixabay / Mixkit / freesound) — NOT
CapCut's built-in library.

**Ambient bed (low, sets the place):** `ocean` · `wind` · `cave` · `forest` · `savanna` · `ice` ·
`fire` · `crowd` · none.

**Ambient FX (`ambient_fx` — a VISUAL drifting-particle overlay, distinct from the audio bed above):**
`embers` (firelit / night) · `spores` or `pollen` (fungal / forest beats) · `dust` (ancient, dry
interiors) · `snow` (ice-age cold) · `rain` (storms) · blank for **most** beats. Use **sparingly** — it's
accent, not default. The renderer also gives every illustration a subtle continuous "breathing" drift and
counts `stat` cue numbers up to value automatically, so frames already feel alive without this; reach for
`ambient_fx` only where the scene genuinely calls for atmosphere.

**Real artifact cutaway (`real_photo` — a REAL Pexels photo of the ACTUAL thing):** a SHORT search phrase
ONLY for a beat about a specific, real, photographable artifact / fossil / mummy / site / object (e.g.
`Otzi the iceman mummy`, `Lascaux cave paintings`, `Stonehenge stones`); blank for everything else. It
renders as a **field-guide "specimen plate"** (the real photo under a cream frame + vignette + a
handwritten "the actual ___" tag) — a credibility cutaway that reads as REAL against the cartoon. Use it
**rarely (0–4 per video)** and **never** for generic concepts, living people, emotions, or abstract ideas
(those stay cartoon) — over-using real footage erodes the monetization-safe animated identity. Fetch it
per beat in the Studio (Scenes → 📷 Real photo; needs a free pexels.com/api key, stored once).

**Music cue (mark ONLY the beats where the bed should shift, to the act structure):** `act1` (after
the hook) · `rehook` (~4:00 re-engagement) · `act2` · `payoff` · `outro`. Music from the **YouTube
Audio Library** (Content-ID-safe). Energy lifts at the re-hook and the payoff.

**Cast action (the narrative engine, made visible):** a short stage direction per beat —
the §4 narrative engine played out beat by beat (e.g. *A wonders → B doubts → C explains → D marvels*).
The skeptic's beats are where a myth gets dismantled. This is the channel's retention/brand asset; the image prompt should depict the action,
not just a pose.
