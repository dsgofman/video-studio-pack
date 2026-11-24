// Pure packaging helpers (CommonJS) for the QC lint: lexical token overlap + thumbnail-layout inspection.
const STOP = new Set('a an the of to in on at and or but for with from by as is are was were be been being do does did how why what who whom when where which that this these those it its we us our you your they them their he she his her i me my no not isnt arent dont your you re s t'.split(/\s+/));

function contentTokens(s) {
  return (String(s == null ? '' : s).toLowerCase().match(/[a-z0-9%]+/g) || [])
    .filter((w) => w.length > 1 && !STOP.has(w));
}
// fraction of the SMALLER token set that also appears in the other (0..1); 0 if either is empty
function tokenOverlap(a, b) {
  const A = new Set(contentTokens(a)), B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}
// "Non-answer" framings that PROMISE the curiosity gap will NOT be filled — the single most common way
// an educational title under-sells (e.g. "Science Doesn't Know", "Still No Answer", "remains a mystery").
// The video almost always DOES deliver a payoff, so the title should tease the reveal, not the dead-end.
// Advisory only (a nudge, not a block): returns the matched phrase, or null.
const NON_ANSWER_RX = /\b(science (still )?(doesn'?t|does not|can'?t|cannot) (know|say|agree|explain)|no[ -]?(one|body) (really |still )?knows|still no answer|we (may|might) never know|remains? an? (enduring |unsolved )?mystery|an? (enduring|unsolved|complete) mystery|stumped (scientists|experts|researchers)|can'?t be explained)\b/i;
function nonAnswerHit(title) {
  const m = NON_ANSWER_RX.exec(String(title == null ? '' : title));
  return m ? m[0] : null;
}

function layoutHeadline(layout) {
  const t = (layout && layout.text) || [];
  return t.map((x) => (typeof x === 'string' ? x : (x && x.line) || '')).join(' ').trim();
}
function layoutElementCount(layout) {
  if (!layout) return 0;
  const s = layout.subject || {};
  const subj = (s.who && s.who !== 'none') ? 1 : 0;
  return subj + ((layout.props || []).length) + ((layout.text || []).length);
}

// titles.md ships (00-packaging/titles.md, from _templates/_video) with a literal blank-template
// placeholder on the "Chosen pair" Title line. Once a human packaging decision lands in studio.json,
// that line should be filled in from it — this catches the drift when it hasn't been synced.
const BLANK_TITLE_LINE_RX = /^-\s*\*\*Title:\*\*.*____________________/m;
function titlesMdTitleBlank(text) {
  if (text == null) return true;
  return BLANK_TITLE_LINE_RX.test(text);
}

module.exports = { contentTokens, tokenOverlap, nonAnswerHit, NON_ANSWER_RX, layoutHeadline, layoutElementCount, titlesMdTitleBlank };
