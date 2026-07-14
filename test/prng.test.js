// M0 acceptance (SPEC §11): hash32(seed, n) is stable; mulberry32 reproduces
// a known sequence. These golden values are frozen — the JUCE port (M7) must
// reproduce them bit-for-bit.

const test = require('node:test');
const assert = require('node:assert/strict');
const Prng = require('../engine/prng.js');

test('mulberry32(1) reproduces the frozen golden sequence', () => {
  const rng = Prng.mulberry32(1);
  const got = Array.from({ length: 8 }, () => rng());
  assert.deepEqual(got, [
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    0.9810509674716741, 0.9683778982143849, 0.281103502959013,
    0.6128388606011868, 0.7207431411370635
  ]);
});

test('mulberry32(42) reproduces the frozen golden sequence', () => {
  const rng = Prng.mulberry32(42);
  const got = Array.from({ length: 4 }, () => rng());
  assert.deepEqual(got, [
    0.6011037519201636, 0.44829055899754167,
    0.8524657934904099, 0.6697340414393693
  ]);
});

test('hash32 golden vectors are stable', () => {
  assert.equal(Prng.hash32(0, 0), 2462723854);
  assert.equal(Prng.hash32(1, 0), 920564995);
  assert.equal(Prng.hash32(1, 1), 1949016451);
  assert.equal(Prng.hash32(1138, 7), 3431160129);
  assert.equal(Prng.hash32(9999, 200), 1307952015);
});

test('hash32 decorrelates seed and phraseIndex', () => {
  // Neighbouring inputs must not collide, and flipping one input should
  // flip a substantial number of output bits (loose avalanche check).
  const seen = new Set();
  for (let seed = 0; seed < 50; seed++) {
    for (let phrase = 0; phrase < 50; phrase++) {
      seen.add(Prng.hash32(seed, phrase));
    }
  }
  assert.equal(seen.size, 2500, 'no collisions across a 50x50 grid');

  const popcount = (x) => {
    let c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    return c;
  };
  for (let n = 0; n < 100; n++) {
    const flipped = popcount(Prng.hash32(7, n) ^ Prng.hash32(7, n + 1));
    assert.ok(flipped >= 6, `adjacent phrase hashes differ in >=6 bits (got ${flipped})`);
  }
});

test('streams from adjacent phrase seeds are independent-looking', () => {
  const a = Prng.mulberry32(Prng.hash32(1, 10));
  const b = Prng.mulberry32(Prng.hash32(1, 11));
  let equal = 0;
  for (let i = 0; i < 100; i++) if (a() === b()) equal++;
  assert.equal(equal, 0);
});

test('mulberry32 output is uniform-ish in [0, 1)', () => {
  const rng = Prng.mulberry32(1234);
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean} within 0.5 +/- 0.01`);
});

test('helpers are deterministic and in range', () => {
  const rng = Prng.mulberry32(5);
  for (let i = 0; i < 1000; i++) {
    const v = Prng.rangeFloat(rng, 3, 7);
    assert.ok(v >= 3 && v < 7);
  }
  for (let i = 0; i < 1000; i++) {
    const c = Prng.centered(rng, 0.25);
    assert.ok(c >= -0.25 && c < 0.25);
  }
  const arr = ['a', 'b', 'c'];
  for (let i = 0; i < 100; i++) {
    assert.ok(arr.includes(Prng.pick(rng, arr)));
  }
});
