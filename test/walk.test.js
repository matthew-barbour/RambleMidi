// M1 acceptance, walk half (SPEC §5): every pitch in scale and register,
// bit-identical across runs, and each weight factor behaves as specified.

const test = require('node:test');
const assert = require('node:assert/strict');
const Prng = require('../engine/prng.js');
const Scales = require('../engine/scales.js');
const Walk = require('../engine/walk.js');

const defaults = {
  leapAmount: 25, directionHold: 70, tonalGravity: 60,
  variability: 50, registerFocus: 40
};

function ladderOf(id, root = 0, lowOct = 3, span = 2) {
  const { lowNote, highNote } = Scales.registerFromOctaves(lowOct, span);
  return Scales.buildLadder(root, Scales.byId(id), lowNote, highNote);
}

function entropy(p) {
  return p.reduce((h, x) => (x > 0 ? h - x * Math.log(x) : h), 0);
}

test('walk output always stays inside the ladder (in key, in register)', () => {
  for (const id of ['minor-pentatonic', 'blues', 'major', 'harmonic-minor']) {
    for (const seed of [1, 42, 1138]) {
      const ladder = ladderOf(id, 9, 2, 3); // A root, C2..C5
      const rng = Prng.mulberry32(Prng.hash32(seed, 0));
      const state = Walk.createState(Math.round(ladder.center));
      for (let n = 0; n < 500; n++) {
        const m = [1.0, 0.7, 0.4, 0.2][n % 4];
        const i = Walk.step(ladder, defaults, state, m, ladder.center, rng);
        assert.ok(i >= 0 && i < ladder.pitches.length);
        const pitch = ladder.pitches[i];
        assert.ok(pitch >= 48 && pitch <= 84);
        assert.ok(Scales.byId(id).offsets.includes((((pitch - 9) % 12) + 12) % 12));
      }
    }
  }
});

test('walk is bit-identical for the same seed, differs for different seeds', () => {
  const run = (seed) => {
    const ladder = ladderOf('minor-pentatonic');
    const rng = Prng.mulberry32(Prng.hash32(seed, 3));
    const state = Walk.createState(5);
    return Array.from({ length: 200 }, () => Walk.step(ladder, defaults, state, 0.7, ladder.center, rng));
  };
  assert.deepEqual(run(7), run(7));
  assert.notDeepEqual(run(7), run(8));
});

test('TonalGravity = 0 removes tonal pull entirely (§5.3)', () => {
  // C blues ladder from C3: index 2 = F (tier 0.6), 3 = F# (0.25), 4 = G (1.0).
  // With prev = center = 3 and lastDir = 0, candidates 2 and 4 differ only
  // in tier weight — so at g = 0 their probabilities must be identical.
  const ladder = ladderOf('blues');
  assert.equal(Scales.noteName(ladder.pitches[3]), 'F#3');
  const state = { prev: 3, lastDir: 0, consecutive: 1 };
  const pFlat = Walk.distribution(ladder, { ...defaults, tonalGravity: 0 }, state, 0.7, 3);
  assert.ok(Math.abs(pFlat[2] - pFlat[4]) < 1e-12, `${pFlat[2]} == ${pFlat[4]}`);
  // ... and at full gravity the stable G must beat the color F.
  const pFull = Walk.distribution(ladder, { ...defaults, tonalGravity: 100 }, state, 0.7, 3);
  assert.ok(pFull[4] > pFull[2]);
});

test('blues b5 is crushed as a phrase-final / downbeat note (§4)', () => {
  // prev = F (index 2); F# (3) is one step away, G (4) two steps away.
  const ladder = ladderOf('blues');
  const state = { prev: 2, lastDir: 0, consecutive: 1 };
  const pFinal = Walk.distribution(ladder, defaults, state, 1.0, 3);
  const pWeak = Walk.distribution(ladder, defaults, state, 0.4, 3);
  assert.ok(pFinal[4] > 10 * pFinal[3], `G (${pFinal[4]}) >> F# (${pFinal[3]}) at m=1.0`);
  assert.ok(pFinal[3] < pWeak[3], 'b5 far less likely at m=1.0 than at m=0.4');
});

test('Variability is a coherent temperature (§5.6)', () => {
  const ladder = ladderOf('minor-pentatonic');
  const state = { prev: 5, lastDir: 1, consecutive: 1 };
  const at = (variability) =>
    Walk.distribution(ladder, { ...defaults, variability }, state, 0.7, ladder.center);
  const p0 = at(0), p50 = at(50), p100 = at(100);
  // peakedness strictly decreases as variability rises
  assert.ok(Math.max(...p0) > Math.max(...p50));
  assert.ok(Math.max(...p50) > Math.max(...p100));
  assert.ok(entropy(p0) < entropy(p50));
  assert.ok(entropy(p50) < entropy(p100));
  // variability 0 is near-deterministic: sampling almost always picks argmax
  const argmax = p0.indexOf(Math.max(...p0));
  const rng = Prng.mulberry32(99);
  let hits = 0;
  for (let n = 0; n < 500; n++) {
    const s = { prev: 5, lastDir: 1, consecutive: 1 };
    if (Walk.step(ladder, { ...defaults, variability: 0 }, s, 0.7, ladder.center, rng) === argmax) hits++;
  }
  assert.ok(hits / 500 > 0.85, `argmax rate ${hits / 500}`);
});

test('edge reflection flips momentum inward instead of clamping (§5.2)', () => {
  const ladder = ladderOf('minor-pentatonic'); // 11 rungs
  const n = ladder.pitches.length;

  const topState = { prev: n - 2, lastDir: 1, consecutive: 1 };
  Walk.reflectAtEdges(topState, n);
  assert.equal(topState.lastDir, -1);

  const bottomState = { prev: 1, lastDir: -1, consecutive: 1 };
  Walk.reflectAtEdges(bottomState, n);
  assert.equal(bottomState.lastDir, 1);

  const midState = { prev: 5, lastDir: 1, consecutive: 1 };
  Walk.reflectAtEdges(midState, n);
  assert.equal(midState.lastDir, 1, 'mid-ladder momentum untouched');

  // After reflection at the top, downward candidates carry more mass.
  const p = Walk.distribution(ladder, { ...defaults, directionHold: 90 },
    { prev: n - 2, lastDir: -1, consecutive: 1 }, 0.7, ladder.center);
  const below = p.slice(0, n - 2).reduce((a, b) => a + b, 0);
  const above = p.slice(n - 1).reduce((a, b) => a + b, 0);
  assert.ok(below > above * 3, `mass below ${below} vs above ${above}`);
});

test('repetition penalty escalates on the 3rd consecutive pitch (§5.4)', () => {
  const ladder = ladderOf('minor-pentatonic');
  const once = Walk.distribution(ladder, defaults, { prev: 5, lastDir: 0, consecutive: 1 }, 0.7, 5);
  const twice = Walk.distribution(ladder, defaults, { prev: 5, lastDir: 0, consecutive: 2 }, 0.7, 5);
  assert.ok(twice[5] < once[5], 'third-in-a-row less likely than second');
});

test('register focus concentrates mass around the (possibly shifted) center (§5.5)', () => {
  const ladder = ladderOf('minor-pentatonic', 0, 2, 3); // 3 octaves, 16 rungs
  const n = ladder.pitches.length;
  const state = () => ({ prev: Math.round(ladder.center), lastDir: 0, consecutive: 1 });
  const massNear = (p, center, radius) => {
    let s = 0;
    for (let i = 0; i < p.length; i++) if (Math.abs(i - center) <= radius) s += p[i];
    return s;
  };
  const loose = Walk.distribution(ladder, { ...defaults, registerFocus: 0, variability: 100 }, state(), 0.7, ladder.center);
  const tight = Walk.distribution(ladder, { ...defaults, registerFocus: 100, variability: 100 }, state(), 0.7, ladder.center);
  assert.ok(massNear(tight, ladder.center, 2) > massNear(loose, ladder.center, 2));

  // Shifting the center (as §6.4 octave shift does) moves the mass with it.
  const d = ladder.degreesPerOctave;
  const shifted = Walk.distribution(ladder, { ...defaults, registerFocus: 80, variability: 100 },
    { prev: Math.round(ladder.center + d), lastDir: 0, consecutive: 1 }, 0.7, ladder.center + d);
  assert.ok(massNear(shifted, ladder.center + d, 2) > massNear(shifted, ladder.center - d, 2));
});
