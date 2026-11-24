const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ER = require('../lib/early-retention.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + e.message); } }

t('exports constants', () => {
  assert.ok(Array.isArray(ER.OPENING_ARCHETYPES) && ER.OPENING_ARCHETYPES.length >= 5);
  assert.ok(typeof ER.EARLY_RETENTION === 'string' && /deceleration/i.test(ER.EARLY_RETENTION));
  assert.ok(/contrast/i.test(ER.EARLY_RETENTION), 'EARLY_RETENTION names the A-vs-B contrast mechanism');
});
t('spokenWords strips brackets, backtick markers, angle stubs, markdown', () => {
  const w = ER.spokenWords('[CUT TO: x] `[HOOK]` <break/> **Hello** there, world.');
  assert.deepStrictEqual(w, ['Hello', 'there', 'world']);
});
t('titleSalientWords drops stopwords/generic, keeps the noun', () => {
  const s = ER.titleSalientWords('How Did Humans End Up on Every Continent?');
  assert.ok(s.includes('continent'), 'expected "continent" in ' + JSON.stringify(s));
  assert.ok(!s.includes('the') && !s.includes('humans'), 'should drop stop/generic words');
});

function byId(checks) { return Object.fromEntries(checks.map((c) => [c.id, c.level])); }
const filler = 'word '.repeat(200);

t('clean escalating opening passes the hard checks', () => {
  const opening = 'In a Siberian cave, a chip of finger bone smaller than your fingernail held an entire kind of human nobody knew existed. We call them Denisovans, and what they left inside you should bother you. ' + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: "The Human Species That Wasn't Supposed to Exist", archetype: 'impossible-object', prevArchetype: 'contrarian-claim', wpm: 167 }));
  assert.strictEqual(c['opening-greeting'], 'pass');
  assert.strictEqual(c['opening-deceleration'], 'pass');
});
t('deceleration phrase at ~word 150 fails opening-deceleration', () => {
  const opening = 'Sixty-five thousand years ago someone paddled into open ocean. ' + 'word '.repeat(130) + ' To answer that, you have to start at the beginning. ' + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'How Did Humans End Up on Every Continent?', archetype: 'in-medias-res', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-deceleration'], 'fail');
});
t('greeting opener fails opening-greeting', () => {
  const c = byId(ER.runOpeningChecks({ openingText: 'Hey guys, welcome back to the channel. ' + filler, title: 'x', archetype: 'open-loop', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-greeting'], 'fail');
});
t('title noun absent early → title-congruence warns', () => {
  const c = byId(ER.runOpeningChecks({ openingText: filler, title: 'The Denisovans Explained', archetype: 'open-loop', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-title-congruence'], 'warn');
});
t('repeated archetype warns', () => {
  const c = byId(ER.runOpeningChecks({ openingText: 'Denisovan story here and more. ' + filler, title: 'Denisovans', archetype: 'open-loop', prevArchetype: 'open-loop', wpm: 167 }));
  assert.strictEqual(c['opening-archetype'], 'warn');
});
t('date-march cluster warns', () => {
  const opening = 'A vivid cold open line to start. ' + 'word '.repeat(40) + ' It was 200,000 years ago, then 100,000 years ago, then 60,000 years ago, then 12,000 years ago. ' + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'x', archetype: 'open-loop', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-datemarch'], 'warn');
});

t('two varied sub-loops pass opening-subloops', () => {
  const opening = "A chip of bone no bigger than your fingernail rewrites who you are. But here's where it gets strange - the people it belonged to vanished, and nobody knew why. The real question is what they left inside you. " + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'x', archetype: 'impossible-object', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-subloops'], 'pass');
});
t('fewer than two sub-loops warn opening-subloops', () => {
  const opening = 'A human barely a metre tall raises a spear at an elephant, and it is about to lose. This happened on one island sixty thousand years ago. ' + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'x', archetype: 'in-medias-res', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-subloops'], 'warn');
});
t('broadened detector recognizes varied loop phrasings (the 006-style false-warn fix)', () => {
  const opening = "Salt water runs down a face in a parked car. Here's the strange part: no other animal does this. The bigger mystery is why we ever started. " + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'x', archetype: 'in-medias-res', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-subloops'], 'pass');
});

t('vague content-free tease first line warns opening-vague-tease', () => {
  const opening = "You won't believe what this changes about being human. " + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'Why Do You Have a Chin?', archetype: 'open-loop', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-vague-tease'], 'warn');
});
t('a tease phrase WITH a concrete noun passes opening-vague-tease', () => {
  const opening = "You won't believe it, but no other animal on Earth has a chin. " + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: 'Why Do You Have a Chin?', archetype: 'open-loop', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-vague-tease'], 'pass');
});
t('a normal concrete cold open does not trip opening-vague-tease', () => {
  const opening = 'In a Siberian cave, a chip of finger bone held a kind of human nobody knew existed. ' + filler;
  const c = byId(ER.runOpeningChecks({ openingText: opening, title: "The Human Species That Wasn't Supposed to Exist", archetype: 'impossible-object', prevArchetype: null, wpm: 167 }));
  assert.strictEqual(c['opening-vague-tease'], 'pass');
});


t('readOpeningArchetypes returns defaults when no override file', () => {
  const list = ER.readOpeningArchetypes(path.join(__dirname, '..', '..'), '__nope__');
  assert.ok(Array.isArray(list) && list.length >= 6 && list[0].id);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
