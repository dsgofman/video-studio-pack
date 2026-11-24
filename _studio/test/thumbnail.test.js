const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/thumbnail.js');

test('BOGY palette has the four pop colors', () => {
  assert.deepStrictEqual(Object.keys(T.BOGY).sort(), ['blue', 'green', 'orange', 'yellow']);
});
test('contrastRatio: black/white ~21, identical ~1', () => {
  assert.ok(Math.abs(T.contrastRatio('#000000', '#ffffff') - 21) < 0.2);
  assert.ok(Math.abs(T.contrastRatio('#777777', '#777777') - 1) < 0.01);
});
test('needsScrim true when text fails 4.5:1 on its background', () => {
  assert.strictEqual(T.needsScrim('#ffffff', '#cccccc'), true);   // white on light grey fails
  assert.strictEqual(T.needsScrim('#ffffff', '#111111'), false);  // white on near-black passes
});
test('safeTextRect(right) stays off corners, above progress bar, right of centre', () => {
  const r = T.safeTextRect(1920, 1080, 'right');
  assert.ok(r.x >= 1920 * 0.5);
  assert.ok(r.x + r.w <= 1920 * 0.95);   // right edge sits at the 6% side margin (1805px) — off the corner
  assert.ok(r.y >= 1080 * 0.10);
  assert.ok(r.y + r.h <= 1080 * 0.85);
});
test('capHook: 2 words ok, 6+ flagged', () => {
  assert.strictEqual(T.capHook('STILL WATCHING').ok, true);
  assert.strictEqual(T.capHook('one two three four five six').ok, false);
});
test('validateConcept: a fully-formed framework concept passes clean', () => {
  const c = { subject: { who: 'Max', emotion: 'dawning dread', gaze: 'right' },
    support: 'a looming shadow', hook: 'TOO LATE', accent: '#FF7A1A', textSide: 'right' };
  const r = T.validateConcept(c);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.issues, []);
});
test('validateConcept: generic "shocked" emotion is banned', () => {
  const c = { subject: { who: 'Max', emotion: 'shocked', gaze: 'right' },
    support: 'a looming shadow', hook: 'TOO LATE', accent: '#FF7A1A', textSide: 'right' };
  const r = T.validateConcept(c);
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.includes('missing/banned emotion'));
});
test('validateConcept: a 6-word hook is rejected', () => {
  const c = { subject: { who: 'Max', emotion: 'dawning dread', gaze: 'right' },
    support: 'a looming shadow', hook: 'one two three four five six', accent: '#FF7A1A', textSide: 'right' };
  const r = T.validateConcept(c);
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.includes('hook too long'));
});
test('resolveAccent: hex passes through, names map, garbage falls back to orange', () => {
  assert.strictEqual(T.resolveAccent('#FF7A1A'), '#FF7A1A');
  assert.strictEqual(T.resolveAccent('1aff1a'), '#1aff1a');
  assert.strictEqual(T.resolveAccent('blue'), T.BOGY.blue);
  assert.strictEqual(T.resolveAccent('RED').toLowerCase(), '#ff3b30');
  assert.strictEqual(T.resolveAccent('chartreuse'), T.BOGY.orange);
  assert.strictEqual(T.resolveAccent(''), T.BOGY.orange);
});
test('shortPunchWord: caps to 3 ALL-CAPS words, strips punctuation', () => {
  assert.strictEqual(T.shortPunchWord('the only animal'), 'THE ONLY ANIMAL');
  assert.strictEqual(T.shortPunchWord('Your chin is, actually, useless!'), 'YOUR CHIN IS');
  assert.strictEqual(T.shortPunchWord(''), '');
});
test('buildThumbArtPrompt: at-camera gaze yields direct eye contact, not side-gaze', () => {
  const p = T.buildThumbArtPrompt({ subject: { who: 'Luna', emotion: 'quiet awe', gaze: 'at-camera', zone: 'left' }, accent: T.BOGY.blue, textSide: 'right' }, 'x', '');
  assert.ok(/eye contact|into the lens|straight into/i.test(p), 'direct eye contact present');
  assert.ok(!/gaze point toward/i.test(p), 'should not force side-gaze when at-camera');
  assert.ok(/curiosity gap|wait, what/i.test(p), 'poses a visual curiosity gap');
});
test('buildThumbArtPrompt: side gaze still leads the eye to the text zone', () => {
  const p = T.buildThumbArtPrompt({ subject: { who: 'Zed', emotion: 'dawning dread', gaze: 'left', zone: 'right' }, accent: T.BOGY.orange, textSide: 'left' }, 'x', '');
  assert.ok(/gaze point toward the left/i.test(p));
});
test('buildShortThumbPrompt now defaults the face to direct eye contact', () => {
  const p = T.buildShortThumbPrompt({ who: 'Max', emotion: 'curiosity', accent: 'green' }, '');
  assert.ok(/straight at the viewer|eye contact/i.test(p));
});
test('buildShortThumbPrompt: vertical, text-free, subject + accent present, NO punch word baked in', () => {
  const p = T.buildShortThumbPrompt(
    { who: 'Zed the myth-buster', emotion: 'dawning realization', accent: 'blue', scene: 'a Neanderthal skull beside a modern one', punchWord: 'NEVER HAD ONE' },
    'comic reaction look');
  for (const tag of ['[STYLE]', '[SUBJECT]', '[MOOD]', '[COMPOSITION]', '[COLOR]', '[TECHNICAL]']) assert.ok(p.includes(tag), tag);
  assert.ok(/9:16/.test(p) && /vertical/i.test(p), 'is vertical 9:16');
  assert.ok(/dawning realization/i.test(p));
  assert.ok(p.includes(T.BOGY.blue), 'named accent resolved to hex');
  assert.ok(/zero text|completely text-free/i.test(p), 'text-free ban present');
  assert.ok(p.includes('comic reaction look'), 'channel style folded in');
  assert.ok(!/NEVER HAD ONE/.test(p), 'punch word must NOT be drawn into the art');
});
test('buildShortThumbPrompt: tolerates empty concept with sane defaults', () => {
  const p = T.buildShortThumbPrompt({}, '');
  assert.ok(p.includes('[TECHNICAL]') && /text-free/i.test(p));
  assert.ok(p.includes(T.BOGY.orange), 'defaults to orange accent');
  assert.ok(/the cast member/i.test(p), 'defaults the subject');
});
test('buildThumbArtPrompt emits the master sections, no title text, reserves the gaze side', () => {
  const concept = { subject: { who: 'Max', emotion: 'dawning dread', gaze: 'right', zone: 'left' },
    support: 'a looming shadow', accent: T.BOGY.orange, textSide: 'right' };
  const p = T.buildThumbArtPrompt(concept, "Your Anxiety Is Built for a World That's Long Gone", 'flat cartoon');
  for (const tag of ['[STYLE]', '[SUBJECT]', '[MOOD]', '[COMPOSITION]', '[COLOR]', '[TECHNICAL]']) assert.ok(p.includes(tag), tag);
  assert.ok(/dawning dread/i.test(p));
  assert.ok(p.includes(T.BOGY.orange));
  assert.ok(/zero text|no .* text|NO text/i.test(p));
  assert.ok(/right/i.test(p));
  assert.ok(!/Your Anxiety Is Built/i.test(p));
});
