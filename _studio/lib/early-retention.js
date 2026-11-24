// Early-retention generation guidance + deterministic opening checks. Pure logic (the check fn takes
// strings, no fs) so it is unit-testable. Required by server.js for generate-script and /api/qc.
const fs = require('fs');
const path = require('path');

const OPENING_ARCHETYPES = [
  { id: 'in-medias-res', name: 'In medias res', blurb: 'Drop into one vivid, present-tense moment mid-action.' },
  { id: 'impossible-object', name: 'The impossible object', blurb: "Open on a concrete artifact or find that shouldn't exist." },
  { id: 'contrarian-claim', name: 'Contrarian claim', blurb: 'State flatly that the common belief is wrong.' },
  { id: 'cold-open-question', name: 'Cold-open question', blurb: 'One sharp reframing question, asked cold.' },
  { id: 'open-loop', name: 'Open loop', blurb: 'Pose a mystery, promise the answer, withhold it.' },
  { id: 'body-anchor', name: 'Body anchor', blurb: "Tie deep time to the viewer's own body right now." },
];

const EARLY_RETENTION = [
  'EARLY RETENTION (the first ~45 seconds decide the video — treat it as the single most important writing in the script):',
  '- No greeting, channel name, logo sting, or "in this video". The first spoken word is part of the tension.',
  '- 0:00-0:15: a concrete cold open in the chosen opening archetype. CONFIRM THE CLICK — name the exact thing the title promised within the first ~30 seconds so the viewer instantly knows they are in the right place.',
  '- 0:15-0:45: ESCALATE, never decelerate. Open a hard loop and raise the stakes; keep the central question OPEN.',
  '- TOPIC CLARITY, fast and CONCRETE (the title already earned the click, so do NOT re-explain the topic — reconfirm it with a real thing): the first line names something specific — a place, a person, an object, a number — never a content-free tease ("you won\'t believe what they found", "the craziest thing about humans"). A tease that names nothing gives the viewer no reason to stay; a concrete image does. This is "speed to value": shortest path to a thing the viewer can grab onto.',
  '- CURIOSITY = CONTRAST: a hook grabs by opening the gap between what the viewer already assumes (A) and the reframe this video delivers (B) — the wider and more specific the gap, the stronger the pull. Our myth-to-evidence spine IS this contrast: the popular belief is A, the real story is B. State it outright ("everyone pictures X; the bone says Y") or imply it (assert B and let it collide with the X they already hold) — but the contrast must be there, concrete, by ~0:20. This is what actually drives the loop; vague suspense does not.',
  '- PLANT 2-3 GENUINE SUB-LOOPS IN THE OPENING (first ~150 words / ~0:55): explicit forward-references or escalation hooks that promise a payoff and withhold it, so the viewer has several reasons to stay. Each must point at a REAL payoff later in the script (never filler), and VARY the wording — never reuse the same loop phrase. Mix the kinds: an escalation loop ("but here\'s where it gets strange", "and it gets weirder", "the strange part is what came next"), a forward-reference ("we\'ll come back to that", "more on that in a minute", "keep that in mind"), or a withheld-answer loop ("the real question is...", "nobody knew why - yet", "the answer is stranger than the myth"). HOLD the real payoff for the climax; resolve the FIRST sub-loop around 2:00 to reward early stayers.',
  '- BANNED deceleration moves (instant rewrite) — these are exactly what bleed viewers between 0:15 and 1:00: "to answer that, you have to start at the beginning" / "let\'s start at the beginning" / "to understand X we need to go back" / "first, some background" / "let me back up"; a chronological date-march opening (marching through "X years ago ... then Y years ago"); dumping several dates or qualifiers in the first ~150 words; setup hedges like "fizzled out, left almost no trace"; premise-explaining lists; more than one rhetorical-question opener.',
  '- Micro-loop every ~30 seconds through Act I ("if it wasn\'t X, and it wasn\'t Y - then what?").',
  '- Optimize for ABSOLUTE watch time (AVD), not percentage viewed: never shorten or rush to lift a percentage — make every minute earn attention.',
].join('\n');

function spokenWords(text) {
  return String(text == null ? '' : text)
    .replace(/\[[^\]]*\]/g, ' ')   // [CUT TO: ...] directions
    .replace(/`[^`]*`/g, ' ')      // `[HOOK]` markers
    .replace(/<[^>]*>/g, ' ')      // <break/> stubs
    .replace(/[#*_>]/g, ' ')       // markdown
    .match(/[A-Za-z0-9][A-Za-z0-9''-]*/g) || [];
}

const STOPWORDS = new Set('the a an of to in on at and or but for with from how why what who when where did do does is are was were we us our you your they their it its this that these those as by'.split(/\s+/));
const GENERIC = new Set('humans human ancient history story explained really actually first last every all about into out up'.split(/\s+/));
function titleSalientWords(title) {
  return (String(title || '').match(/[A-Za-z][A-Za-z''-]{2,}/g) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w));
}

const DECEL_RX = /(to answer that|start at the beginning|let'?s start|to understand .{1,40}? we (need to )?go back|first,? some background|let me back up|before we (can )?(get|dive)|first,? let'?s go back)/i;
const GREET_RX = /^(hi|hello|hey|welcome|what'?s up|in this video|today (we|i)|guys)\b/i;
// Kallaway's "delay" mistake: a vague-suspense FIRST line that names no concrete subject ("you won't
// believe this") gives zero topic clarity, so the viewer can't decide to opt in. Only fires on the
// first sentence (later "here's where it gets strange" sub-loops are fine — they follow real content)
// and only when NO concrete anchor (a title noun, a proper noun, or a number) is present.
const VAGUE_TEASE_RX = /(you won'?t believe|wait (un)?til you (see|hear)|the (craziest|wildest|strangest|most insane|most shocking|most surprising) thing|blow your mind|this changed everything|what i'?m about to (show|tell)|you'?ve never seen anything|trust me[,.]|this is (insane|wild|crazy|unbelievable|nuts))/i;
// catches the date forms this channel actually uses: bare 4-digit years (1872), comma/large numbers before
// "years" (200,000 years), and word-form magnitudes ("sixty thousand years" → "thousand years").
const YEAR_RX = /\b\d{4}\b|\b[\d,]{3,}\s*years\b|\b(thousand|million|billion)\s*years\b/gi;
// Genuine open-loop / forward-reference / escalation / withheld-answer markers. Broadened 2026-06-21 from
// the original narrow list because strong scripts plant loops in VARIED language (006 opens with "here's
// the strange part", which the old list missed → a false warn on a script that DID have a loop). Each
// alternative is still a real loop marker, not generic prose, and the check needs TWO — so an incidental
// single match can't flip it. Pairing this with the generation guidance keeps openings non-formulaic
// (varied phrasing) instead of forcing one repeated stock phrase.
// Broadened again 2026-08-24 (recurring opening-subloops warn on 007/008/009 — see 99_DECISIONS.md):
// by-eye read of all 3 scripts found real forward-reference/withheld-answer loops the old list missed —
// "stick with me" (007/009, a "stay with me" variant), "nobody is sure" (009, a "nobody knows" variant),
// "we're also going to find out" (008, same family as "we'll find out"). 004 was NOT broadened for —
// it genuinely plants only one loop; see the 2026-08-24 decisions entry.
const SUBLOOP_RX = new RegExp([
  "we'?ll (get to|come back|get there|see|find out|explain)", 'come back to',
  'more on (that|this)', 'in a moment', '(stay|stick) with me', 'hold that thought',
  'keep (that|this) in mind', 'remember (this|that)\\b', "i'?ll (explain|get to|show you|come back)",
  'that comes later', 'first[^.]{0,30}\\bthen\\b',
  "here'?s where it gets", "here'?s the (strange|weird|wild|crazy|interesting|good|surprising|real|best) part",
  'the (strange|weird|wild|surprising|crazy) part', 'it gets (strange|weird|wild|crazy|worse|better|stranger|weirder|wilder|darker|more)',
  "but that'?s not", "that'?s not even the",
  'the (real|bigger|stranger|harder|actual) (question|answer|reason|twist|mystery|story|catch)',
  'the answer (is|will|would|comes)', "(nobody|no one) (knew|knows|('?s| is) sure)",
  'what (happened|they found|came) next', 'the catch (is|was)',
  "we'?re (also )?(going to|gonna) (find out|see|discover|learn)",
].join('|'), 'gi');

// Pure: takes the concatenated spoken narration + title + archetypes + measured wpm. Returns
// [{ id, level('pass'|'warn'|'fail'), detail }] in the same shape as the /api/qc lint.
function runOpeningChecks({ openingText, title, archetype, prevArchetype, wpm }) {
  const W = wpm > 0 ? wpm : 167;
  const words = spokenWords(openingText);
  const w = (sec) => Math.round(sec / 60 * W);
  const slice = (a, b) => words.slice(a, b).join(' ');
  // setup window reaches ~1:05 because 001's deceleration phrase lands at ~word 150 (~0:53)
  const decelText = slice(20, w(65));
  const dateText = slice(w(15), w(65));
  const first30 = slice(0, w(33)).toLowerCase();
  // Act I window for sub-loop detection, through ~4:00 (this channel's own Act I upper bound per
  // CLAUDE.md's retention architecture, and where the RE-HOOK lands) — EARLY_RETENTION explicitly
  // counts the RE-HOOK's escalation line ("here's where it gets strange") as one of the 2-3 loops, so
  // the window has to reach it. Was `w(150)`, which silently treated 150 as SECONDS (→ ~2:30) instead
  // of the ~150 WORDS the surrounding guidance text describes ("first ~150 words / ~0:55") — a mismatch
  // between intent and code that happened to be too narrow to catch a legitimate late-Act-I loop (found
  // 2026-08-24 diagnosing a recurring opening-subloops warn — see 99_DECISIONS.md).
  const act1 = slice(0, w(240));
  const firstSentence = String(openingText || '').replace(/\[[^\]]*\]/g, ' ').replace(/`[^`]*`/g, ' ').replace(/^[^A-Za-z0-9]+/, '').trim().split(/[.!?]/)[0] || '';

  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const greet = GREET_RX.exec(firstSentence) || GREET_RX.exec(slice(0, 8));
  add('opening-greeting', greet ? 'fail' : 'pass',
    greet ? ('Opens with a greeting ("' + greet[0].trim() + '") — cut it; the first word must be tension.') : 'No greeting in the opening.');

  const decel = DECEL_RX.exec(decelText);
  add('opening-deceleration', decel ? 'fail' : 'pass',
    decel ? ('Deceleration move in the 0:15-1:00 setup: "' + decel[0].trim() + '" — this is the pattern that bleeds viewers (it killed 001). Escalate instead and keep the loop open.')
          : 'No "back up and explain" deceleration in the setup.');

  const salient = titleSalientWords(title);
  const hit = salient.some((s) => first30.includes(s.slice(0, Math.max(4, s.length - 2))));
  add('opening-title-congruence', !salient.length ? 'pass' : (hit ? 'pass' : 'warn'),
    !salient.length ? 'Title has no specific noun to check.'
      : hit ? "The title's promise appears in the first ~30s."
            : "None of the title's key words (" + salient.join(', ') + ') appear in the first ~30s — confirm the click sooner.');

  // opening-vague-tease: first line is content-free suspense with nothing concrete to grab (Kallaway "delay").
  const teaseHit = VAGUE_TEASE_RX.exec(firstSentence);
  const fsLower = firstSentence.toLowerCase();
  const fsTokens = firstSentence.match(/[A-Za-z0-9][A-Za-z0-9''-]*/g) || [];
  const fsHasTitleNoun = salient.some((s) => fsLower.includes(s.slice(0, Math.max(4, s.length - 2))));
  const fsProperNoun = fsTokens.slice(1).some((wd) => /^[A-Z][a-z]{2,}$/.test(wd));   // a non-leading capitalized word
  const fsConcrete = fsHasTitleNoun || fsProperNoun || /\d/.test(firstSentence);
  add('opening-vague-tease', (teaseHit && !fsConcrete) ? 'warn' : 'pass',
    (teaseHit && !fsConcrete)
      ? ('First line is a vague tease ("' + teaseHit[0].trim() + '") that names no concrete subject — the viewer gets zero topic clarity and cannot decide to opt in (Kallaway\'s "delay"). Name the real thing in the first sentence.')
      : 'Opening names a concrete subject (no content-free tease).');

  const yrs = (dateText.match(YEAR_RX) || []).length;
  add('opening-datemarch', yrs > 3 ? 'warn' : 'pass',
    yrs > 3 ? (yrs + ' year/date mentions packed into the 0:15-1:00 window — reads as a chronological date-march; cut to one anchor date.')
            : 'No date-march in the setup.');

  const loops = (act1.match(SUBLOOP_RX) || []).length;
  add('opening-subloops', loops >= 2 ? 'pass' : 'warn',
    loops >= 2 ? (loops + ' forward-reference sub-loops planted in Act I.')
               : 'Fewer than 2 sub-loops detected in Act I — plant 2-3 "we\'ll get to X" loops to pull viewers forward.');

  if (archetype && prevArchetype) {
    add('opening-archetype', archetype !== prevArchetype ? 'pass' : 'warn',
      archetype !== prevArchetype ? ('Opening archetype "' + archetype + '" differs from the previous video.')
                                  : ('Same opening archetype as the previous video ("' + archetype + '") — vary it for freshness.'));
  }
  return checks;
}

function readOpeningArchetypes(ROOT, channel) {
  const list = OPENING_ARCHETYPES.slice();
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(ROOT, channel, '_assets', 'opening-archetypes.json'), 'utf8'));
    if (Array.isArray(extra)) for (const e of extra) if (e && e.id && !list.some((x) => x.id === e.id)) list.push(e);
  } catch (_) {}
  return list;
}

module.exports = { OPENING_ARCHETYPES, EARLY_RETENTION, spokenWords, titleSalientWords, runOpeningChecks, readOpeningArchetypes };
