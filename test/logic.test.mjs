import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCard, buildIndex, parseCollectorNumber, matchName, variantsForName, printedKey } from '../recognize.js';
import { MotionTracker } from '../motion.js';
import { toCsv, HEADER } from '../csv.js';

const data = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url)));
const index = buildIndex(data.cards.map(toCard));

test('printed keys', () => {
  assert.equal(printedKey('OGN-257-Release'), 'OGN-257');
  assert.equal(printedKey('UNL-229*'), 'UNL-229');
  assert.equal(printedKey('OGN-041a'), 'OGN-041a');
  assert.equal(printedKey('SFD-R01a'), 'SFD-R01a');
});

test('parses clean and noisy collector numbers', () => {
  const cases = [
    ['OGN • 002/298  Six More Vodka • ©2025RGI', 'OGN-002'],
    ['OGN - 041a/298 League Splash Team', 'OGN-041a'],
    ['0GN . 04la/298', 'OGN-041a'],
    ['UNL · 229/219', 'UNL-229'],
    ['OGS • O21/024', 'OGS-021'],
    ['junk text\nOGN * 1l9 / 298', 'OGN-119'],
    ['SFD • R01/', null],
  ];
  for (const [text, want] of cases) {
    assert.equal(parseCollectorNumber(text, index)?.key ?? null, want, text);
  }
});

test('plain variant comes first for a printed number', () => {
  const r = parseCollectorNumber('UNL • 229/219', index);
  assert.deepEqual(r.variants.map((v) => v.variantNumber), ['UNL-229', 'UNL-229*']);
});

test('matches names from title words, ignoring rules text', () => {
  const w = (text, height) => ({ text, height });
  // Standard card: title tall, rules text short and mentioning another card's name.
  assert.deepEqual(matchName([w('Brazen', 40), w('Buccaneer', 40), w('discard', 22), w('Charm', 22)], index), ['Brazen Buccaneer']);
  // Champion: "Volibear" big, "FURIOUS" subtitle smaller.
  assert.deepEqual(matchName([w('Volibear', 40), w('FURIOUS', 24), w('attack', 22)], index), ['Volibear, Furious']);
  // Legend: title is the subtitle part, champion name only in the type line.
  assert.deepEqual(matchName([w('LEGEND', 18), w('VI', 18), w('Piltover', 40), w('Enforcer', 40)], index), ['Vi, Piltover Enforcer']);
  // OCR typo in the title.
  assert.deepEqual(matchName([w('Brazen', 40), w('Buccanear', 40)], index), ['Brazen Buccaneer']);
  assert.deepEqual(matchName([w('asdf', 40)], index), []);
});

test('name match prefers the standard printing', () => {
  assert.equal(variantsForName('Volibear, Furious', index)[0].variantNumber, 'OGN-041');
});

function frame(value, pattern = 0) {
  const f = new Float32Array(48 * 64);
  for (let i = 0; i < f.length; i++) f[i] = value + (pattern ? ((i * pattern) % 97) : 0);
  return f;
}

function run(tracker, frames) {
  // frames: [[frame, holdMs]]; one update every 100 ms.
  const events = [];
  let t = 0;
  for (const [f, ms] of frames) {
    for (let e = 0; e < ms; e += 100) {
      const ev = tracker.update(f, (t += 100));
      if (ev === 'scan') {
        events.push(t);
        tracker.scanDone();
      }
    }
  }
  return events.length;
}

test('motion: card in, nudged, out, same card again, swap', () => {
  const empty = frame(100);
  const cardA = frame(100, 7);
  const cardA2 = frame(101, 7); // same card, slightly brighter
  const cardB = frame(100, 13);
  const tr = new MotionTracker();
  assert.equal(run(tr, [[empty, 1000]]), 0, 'calibrates, no scan');
  assert.equal(run(tr, [[cardA, 1000]]), 1, 'new card scans once');
  assert.equal(run(tr, [[empty, 100], [cardA2, 1000]]), 0, 'nudge without emptying does not rescan');
  assert.equal(run(tr, [[empty, 1000], [cardA, 1000]]), 1, 'same card after empty box counts again');
  assert.equal(run(tr, [[cardB, 1000]]), 1, 'swapping to a different card scans');
  assert.equal(run(tr, [[cardB, 3000]]), 0, 'holding still does not rescan');
});

test('motion: exposure shift alone is not a card', () => {
  const tr = new MotionTracker();
  run(tr, [[frame(100, 5), 1000]]);
  assert.equal(run(tr, [[frame(130, 5), 1000]]), 0);
});

test('csv matches the Piltover Archive export format', () => {
  assert.equal(HEADER, 'Variant Number,Card Name,Set,Set Prefix,Rarity,Variant Type,Variant Label,Foil,Quantity,Language,Condition,Grading Company,Grading Value,Grading Label,Notes');
  const rows = [
    { card: index.byNumber.get('OGN-119'), foil: true, qty: 3 },
    { card: index.byNumber.get('OGN-042'), foil: false, qty: 12 },
  ];
  assert.equal(
    toCsv(rows),
    [
      HEADER,
      'OGN-042,Calm Rune,Origins,OGN,Common,Standard,OGN Rune,false,12,English,,,,,',
      'OGN-119,"Ahri, Inquisitive",Origins,OGN,Epic,Standard,Standard,true,3,English,,,,,',
    ].join('\n') + '\n',
  );
});
