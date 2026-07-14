// M1 acceptance, scale/ladder half (SPEC §4): tables match the spec exactly,
// the ladder never leaves the key or the register.

const test = require('node:test');
const assert = require('node:assert/strict');
const Scales = require('../engine/scales.js');

test('the 8 scales match the SPEC §4 table, in menu order', () => {
  const expected = [
    ['major',            [0, 2, 4, 5, 7, 9, 11], [0, 4, 7], [2, 9],  [5, 11]],
    ['natural-minor',    [0, 2, 3, 5, 7, 8, 10], [0, 3, 7], [2, 10], [5, 8]],
    ['harmonic-minor',   [0, 2, 3, 5, 7, 8, 11], [0, 3, 7], [2, 11], [5, 8]],
    ['dorian',           [0, 2, 3, 5, 7, 9, 10], [0, 3, 7], [9, 10], [2, 5]],
    ['mixolydian',       [0, 2, 4, 5, 7, 9, 10], [0, 4, 7], [9, 10], [2, 5]],
    ['major-pentatonic', [0, 2, 4, 7, 9],        [0, 4, 7], [2, 9],  []],
    ['minor-pentatonic', [0, 3, 5, 7, 10],       [0, 3, 7], [5, 10], []],
    ['blues',            [0, 3, 5, 6, 7, 10],    [0, 3, 7], [5, 10], [6]]
  ];
  assert.equal(Scales.SCALES.length, 8);
  expected.forEach(([id, offsets, stable, color, passing], i) => {
    const s = Scales.SCALES[i];
    assert.equal(s.id, id);
    assert.deepEqual(s.offsets, offsets);
    assert.deepEqual(s.stable, stable);
    assert.deepEqual(s.color, color);
    assert.deepEqual(s.passing, passing);
    // every offset is categorized in exactly one tier
    const tiers = [...stable, ...color, ...passing].sort((a, b) => a - b);
    assert.deepEqual(tiers, [...offsets].sort((a, b) => a - b));
  });
});

test('tier weights: stable 1.0, color 0.6, passing 0.25; blues b5 flagged blue', () => {
  const blues = Scales.byId('blues');
  assert.equal(Scales.tierWeightFor(blues, 0), 1.0);
  assert.equal(Scales.tierWeightFor(blues, 5), 0.6);
  assert.equal(Scales.tierWeightFor(blues, 6), 0.25);
  assert.deepEqual(blues.blue, [6]);
  const maj = Scales.byId('major');
  assert.equal(Scales.tierWeightFor(maj, 11), 0.25);
  assert.equal(Scales.tierWeightFor(maj, 9), 0.6);
});

test('registerFromOctaves follows the §4 derivation, clamped at C7', () => {
  assert.deepEqual(Scales.registerFromOctaves(3, 2), { lowNote: 60, highNote: 84 });  // C3..C5 default
  assert.deepEqual(Scales.registerFromOctaves(1, 1), { lowNote: 36, highNote: 48 });
  assert.deepEqual(Scales.registerFromOctaves(5, 4), { lowNote: 84, highNote: 108 }); // clamped
});

test('ladder: C minor pentatonic across C3–C5 is exactly the expected pitches', () => {
  const scale = Scales.byId('minor-pentatonic');
  const ladder = Scales.buildLadder(0, scale, 60, 84);
  assert.deepEqual(ladder.pitches, [60, 63, 65, 67, 70, 72, 75, 77, 79, 82, 84]);
  assert.equal(ladder.degreesPerOctave, 5);
  assert.equal(ladder.center, 5);
  assert.equal(ladder.tierWeights[0], 1.0);  // C root
  assert.equal(ladder.tierWeights[1], 1.0);  // Eb (offset 3, stable)
  assert.equal(ladder.tierWeights[2], 0.6);  // F  (offset 5, color)
});

test('every ladder pitch is in key and in register, for all scales and roots', () => {
  for (const scale of Scales.SCALES) {
    for (let root = 0; root < 12; root++) {
      for (const [lowOct, span] of [[1, 1], [3, 2], [2, 3], [5, 4]]) {
        const { lowNote, highNote } = Scales.registerFromOctaves(lowOct, span);
        const ladder = Scales.buildLadder(root, scale, lowNote, highNote);
        assert.ok(ladder.pitches.length > 0);
        let last = -1;
        for (const p of ladder.pitches) {
          assert.ok(p >= lowNote && p <= highNote, `${p} in [${lowNote}, ${highNote}]`);
          assert.ok(scale.offsets.includes((((p - root) % 12) + 12) % 12), `${p} in ${scale.id}`);
          assert.ok(p > last, 'strictly ascending');
          last = p;
        }
      }
    }
  }
});

test('note names use the Logic convention (C3 = 60)', () => {
  assert.equal(Scales.noteName(60), 'C3');
  assert.equal(Scales.noteName(69), 'A3');
  assert.equal(Scales.noteName(108), 'C7');
  assert.equal(Scales.noteName(36), 'C1');
  assert.equal(Scales.noteName(61), 'C#3');
});

test('parsePitchClass accepts naturals, sharps, flats', () => {
  assert.equal(Scales.parsePitchClass('C'), 0);
  assert.equal(Scales.parsePitchClass('A'), 9);
  assert.equal(Scales.parsePitchClass('F#'), 6);
  assert.equal(Scales.parsePitchClass('Bb'), 10);
  assert.equal(Scales.parsePitchClass('b'), 11);
  assert.equal(Scales.parsePitchClass('Cb'), 11);
  assert.equal(Scales.parsePitchClass('X'), -1);
  assert.equal(Scales.parsePitchClass(''), -1);
});
