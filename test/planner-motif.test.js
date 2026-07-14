// M3 acceptance (SPEC §6.3–6.4): cold-planning phrase 200 touches <= 3
// phrases; repeats are audibly restatements, not clones; octave shift moves
// the register center and nothing else; and — the keystone — plan(n) is
// identical no matter where planning started.

const test = require('node:test');
const assert = require('node:assert/strict');
const Planner = require('../engine/planner.js');

function paramsWith(overrides) {
  return { ...Planner.defaultParams(), ...overrides };
}

test('chain cap: cold-planning phrase 200 plans at most 3 phrases (§6.3)', () => {
  for (const motifRepeat of [40, 100]) {
    for (const seed of [1, 7, 1138]) {
      const params = paramsWith({ seed, motifRepeat });
      const derived = Planner.derive(params);
      const cache = {}; // plan() fills it with every phrase it actually plans
      Planner.plan(params, derived, 200, cache);
      const planned = Object.keys(cache).length;
      assert.ok(planned <= 3, `planned ${planned} phrases (seed ${seed}, motif ${motifRepeat})`);
    }
  }
});

test('repeat depths follow the wants-repeat run structure', () => {
  // Reference implementation: depth(k) = wants(k) && depth(k-1) < 2
  //                                      ? depth(k-1) + 1 : 0, depth(0) = 0.
  for (const motifRepeat of [0, 40, 70, 100]) {
    const params = paramsWith({ seed: 42, motifRepeat });
    let refPrev = 0;
    for (let k = 0; k < 300; k++) {
      const ref = k === 0 ? 0
        : (Planner.wantsRepeatFlag(params, k) && refPrev < 2 ? refPrev + 1 : 0);
      assert.equal(Planner.repeatDepth(params, k), ref, `depth(${k}) at motif ${motifRepeat}`);
      refPrev = ref;
    }
  }
});

test('motifRepeat 0 never repeats; motifRepeat 100 repeats in 1-2-fresh cycles', () => {
  const never = paramsWith({ motifRepeat: 0 });
  for (let k = 0; k < 50; k++) assert.equal(Planner.repeatDepth(never, k), 0);
  const always = paramsWith({ motifRepeat: 100 });
  for (let k = 0; k < 50; k++) assert.equal(Planner.repeatDepth(always, k), k % 3);
});

test('a repeat is a restatement: same rhythm and contour, re-humanized delivery (§6.3)', () => {
  const params = paramsWith({ seed: 3, motifRepeat: 100, density: 80 });
  const derived = Planner.derive(params);
  const cache = {};
  let checked = 0;
  for (let k = 1; k < 30; k++) {
    if (Planner.repeatDepth(params, k) === 0) continue;
    const cur = Planner.plan(params, derived, k, cache);
    const base = Planner.plan(params, derived, k - 1, cache);
    if (base.slots.length === 0) continue;
    checked++;
    // identical rhythm skeleton and durations
    assert.deepEqual(cur.slots, base.slots);
    assert.deepEqual(cur.durations, base.durations);
    // identical interval contour, rigidly transposed
    const contour = (p) => p.ladderIndices.map((i) => i - p.ladderIndices[0]);
    assert.deepEqual(contour(cur), contour(base));
    assert.equal(cur.ladderIndices[0] - base.ladderIndices[0], cur.shiftSteps);
    // ...but not a bit-identical clone: velocities or micro-timing re-drawn
    if (cur.slots.length > 1) {
      const sameVel = JSON.stringify(cur.events.map((e) => e.velocity)) ===
        JSON.stringify(base.events.map((e) => e.velocity));
      const sameTiming = JSON.stringify(cur.events.map((e) => e.beat - cur.startBeat)) ===
        JSON.stringify(base.events.map((e) => e.beat - base.startBeat));
      assert.ok(!sameVel || !sameTiming, `phrase ${k} is a clone of ${k - 1}`);
    }
  }
  assert.ok(checked >= 5, `checked ${checked} repeat phrases`);
});

test('transposed contours always stay inside the ladder', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const params = paramsWith({ seed, motifRepeat: 100, octaveShift: 60, density: 90 });
    const derived = Planner.derive(params);
    const n = derived.ladder.pitches.length;
    const cache = {};
    for (let k = 0; k < 40; k++) {
      const p = Planner.plan(params, derived, k, cache);
      for (const i of p.ladderIndices) assert.ok(i >= 0 && i < n, `index ${i} in [0, ${n})`);
      for (const ev of p.events) {
        assert.ok(derived.ladder.pitches.includes(ev.pitch));
      }
    }
  }
});

test('octave restatements actually occur (the Garcia move)', () => {
  let found = false;
  outer: for (const seed of Array.from({ length: 30 }, (_, i) => i + 1)) {
    const params = paramsWith({ seed, motifRepeat: 100, density: 60 });
    const derived = Planner.derive(params);
    const dpo = derived.ladder.degreesPerOctave;
    const cache = {};
    for (let k = 1; k < 30; k++) {
      const p = Planner.plan(params, derived, k, cache);
      if (p.repeatDepth > 0 && Math.abs(p.shiftSteps) === dpo && p.slots.length > 0) {
        found = true;
        break outer;
      }
    }
  }
  assert.ok(found, 'no whole-octave motif restatement found across 30 seeds');
});

test('fittingTransposes: octave options only fire when the contour fits (§6.3)', () => {
  // Contour spanning almost the whole ladder: only 0 (and small shifts that
  // fit) remain; octave moves are excluded.
  assert.deepEqual(Planner.fittingTransposes([0, 10], 11, 5), [0]);
  assert.deepEqual(Planner.fittingTransposes([2, 3], 11, 5), [0, -2, -1, 1, 2, 5]);
  assert.deepEqual(Planner.fittingTransposes([5], 11, 5), [0, -2, -1, 1, 2, -5, 5]);
  assert.deepEqual(Planner.fittingTransposes([], 11, 5), [0, -2, -1, 1, 2, -5, 5]);
});

test('octave shift: span 1 never shifts; shift 100 always shifts fresh phrases (§6.4)', () => {
  const span1 = paramsWith({ octaveSpan: 1, octaveShift: 100, motifRepeat: 0 });
  const d1 = Planner.derive(span1);
  for (let k = 0; k < 20; k++) {
    assert.equal(Planner.plan(span1, d1, k, {}).shiftSteps, 0);
  }
  const always = paramsWith({ octaveSpan: 3, octaveShift: 100, motifRepeat: 0 });
  const d3 = Planner.derive(always);
  const dpo = d3.ladder.degreesPerOctave;
  let up = 0, down = 0;
  for (let k = 0; k < 40; k++) {
    const s = Planner.plan(always, d3, k, {}).shiftSteps;
    assert.equal(Math.abs(s), dpo);
    if (s > 0) up++; else down++;
  }
  assert.ok(up > 5 && down > 5, `both directions occur (up ${up}, down ${down})`);
  const never = paramsWith({ octaveShift: 0, motifRepeat: 0 });
  const dn = Planner.derive(never);
  for (let k = 0; k < 20; k++) {
    assert.equal(Planner.plan(never, dn, k, {}).shiftSteps, 0);
  }
});

test('KEYSTONE: plan(n) is bit-identical regardless of planning order (§3)', () => {
  const params = paramsWith({ seed: 1138, motifRepeat: 60, octaveShift: 30 });
  const derived = Planner.derive(params);

  // Warm path: plan 0..40 in order.
  const warm = {};
  for (let k = 0; k <= 40; k++) Planner.plan(params, derived, k, warm);

  // Cold path: drop into each phrase directly with an empty cache.
  for (let k = 0; k <= 40; k++) {
    const cold = Planner.plan(params, derived, k, {});
    assert.deepEqual(cold, warm[k], `phrase ${k} differs cold vs warm`);
  }

  // And planning backwards changes nothing either.
  const backward = {};
  for (let k = 40; k >= 0; k--) Planner.plan(params, derived, k, backward);
  for (let k = 0; k <= 40; k++) {
    assert.deepEqual(backward[k], warm[k], `phrase ${k} differs backward vs warm`);
  }
});
