// M2 acceptance (SPEC §6.1–6.2): grid/swing math verified against
// hand-computed beat positions; note-offs never precede note-ons; breath
// zones actually breathe; velocity/duration formulas behave.

const test = require('node:test');
const assert = require('node:assert/strict');
const Planner = require('../engine/planner.js');

function paramsWith(overrides) {
  return { ...Planner.defaultParams(), ...overrides };
}

function planOne(overrides, phraseIndex = 0) {
  const params = paramsWith(overrides);
  const derived = Planner.derive(params);
  return { params, derived, plan: Planner.plan(params, derived, phraseIndex, {}) };
}

// Deterministic-timing overrides: no jitter, no swing, no motif surprises.
const straight = { humanizeMs: 0, swing: 50, lengthVariation: 0, motifRepeat: 0, octaveShift: 0 };

test('metric strength classifies beats per §5.3', () => {
  const m = (b) => Planner.metricStrength(b, 4);
  assert.equal(m(0), 1.0);      // bar downbeat
  assert.equal(m(4), 1.0);      // next bar downbeat
  assert.equal(m(1), 0.7);      // quarter beat
  assert.equal(m(3), 0.7);
  assert.equal(m(0.5), 0.4);    // eighth offbeat
  assert.equal(m(7.5), 0.4);
  assert.equal(m(0.25), 0.2);   // sixteenth
  assert.equal(m(1 / 3), 0.2);  // triplet subdivision
  assert.equal(m(5 / 6), 0.2);
});

test('swing lands odd slots at hand-computed positions (§6.1)', () => {
  const grid8 = Planner.gridById('1/8');
  // Swing 50 = straight
  assert.equal(Planner.swingOffset(1, grid8, 50), 0);
  // Swing 66.67 ≈ triplet feel: (2*0.6667 - 1) * 0.5 = 0.1667
  assert.ok(Math.abs(Planner.swingOffset(1, grid8, 66.67) - 0.1667) < 1e-3);
  // Swing 75: (1.5 - 1) * 0.5 = 0.25 — the offbeat lands on the last 16th
  assert.equal(Planner.swingOffset(3, grid8, 75), 0.25);
  // Even slots never swing
  assert.equal(Planner.swingOffset(2, grid8, 75), 0);
  // Triplet grids never swing
  assert.equal(Planner.swingOffset(1, Planner.gridById('1/8T'), 75), 0);
  assert.equal(Planner.swingOffset(1, Planner.gridById('1/16T'), 75), 0);

  // End-to-end: a dense straight phrase with swing 75 puts every odd slot
  // exactly 0.25 beats late.
  const { plan } = planOne({ ...straight, swing: 75, density: 100, breath: 0 });
  for (const [n, ev] of plan.events.entries()) {
    const expected = n * 0.5 + (n % 2 === 1 ? 0.25 : 0);
    assert.ok(Math.abs(ev.beat - expected) < 1e-9, `slot ${n}: ${ev.beat} == ${expected}`);
  }
});

test('triplet grid slots land on exact triplet positions, unswung', () => {
  const { plan, derived } = planOne({ ...straight, gridId: '1/8T', swing: 75, density: 100, breath: 0 });
  assert.equal(derived.slotsPerPhrase, 24); // 8 beats / (1/3)
  for (const ev of plan.events) {
    const slot = Math.round(ev.beat / (1 / 3));
    assert.ok(Math.abs(ev.beat - slot / 3) < 1e-9);
  }
});

test('density 0 is silence; density 100 sounds every non-breath slot', () => {
  assert.equal(planOne({ ...straight, density: 0 }).plan.events.length, 0);
  const full = planOne({ ...straight, density: 100, breath: 0 });
  assert.equal(full.plan.events.length, 16); // 2 bars * 8 eighths
  const noBreath = planOne({ ...straight, density: 100, breath: 25 });
  assert.equal(noBreath.plan.events.length, 14); // last quarter of bar 2 (2 slots) rests
});

test('breath zone: the trailing Breath% of the final bar contains no onsets (§6.2)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { plan, derived } = planOne({ ...straight, seed, density: 100, breath: 25 });
    const zoneStart = derived.beatsPerPhrase - 0.25 * derived.beatsPerBar; // beat 7 of 8
    for (const ev of plan.events) {
      assert.ok(ev.beat - plan.startBeat < zoneStart - 1e-9, `onset ${ev.beat} before breath zone`);
    }
  }
  // breath 100: the whole final bar is silent
  const { plan, derived } = planOne({ ...straight, density: 100, breath: 100 });
  for (const ev of plan.events) {
    assert.ok(ev.beat - plan.startBeat < derived.beatsPerPhrase - derived.beatsPerBar - 1e-9);
  }
});

test('note-offs never precede note-ons; durations respect the 0.02 floor', () => {
  for (const seed of [1, 7, 42, 99, 1138]) {
    for (const overrides of [
      {}, { noteLength: 5, gridId: '1/32' }, { noteLength: 150, lengthVariation: 100 },
      { gridId: '1/16T', density: 100 }
    ]) {
      const { plan } = planOne({ seed, ...overrides }, seed % 4);
      for (const ev of plan.events) {
        assert.ok(ev.durBeats >= 0.02 - 1e-12, `duration ${ev.durBeats} >= 0.02`);
        assert.ok(ev.beat + ev.durBeats > ev.beat);
      }
    }
  }
});

test('no event is ever scheduled before its phrase start, even at max humanize', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { plan } = planOne({ seed, humanizeMs: 30, swing: 50, motifRepeat: 0 }, 0);
    for (const ev of plan.events) {
      assert.ok(ev.beat >= plan.startBeat, `${ev.beat} >= ${plan.startBeat}`);
    }
  }
});

test('velocity = Velocity + Accent*m, exact when VelocityRange is 0 (§6.2)', () => {
  const { plan } = planOne({ ...straight, density: 100, breath: 0, velocityRange: 0, velocity: 90, accent: 12 });
  // 1/8 grid over 2 bars of 4/4: m = 1.0 on slots 0 and 8, 0.7 on other
  // quarters, 0.4 on offbeats; final slot forced to 1.0.
  const expected = [102, 95, 98, 95, 98, 95, 98, 95, 102, 95, 98, 95, 98, 95, 98, 102];
  assert.deepEqual(plan.events.map((e) => e.velocity), expected);
});

test('velocity clamps to [1, 127]', () => {
  const hot = planOne({ ...straight, density: 100, breath: 0, velocity: 127, accent: 40, velocityRange: 0 });
  assert.ok(hot.plan.events.every((e) => e.velocity === 127));
  const cold = planOne({ ...straight, density: 100, breath: 0, velocity: 1, accent: 0, velocityRange: 0 });
  assert.ok(cold.plan.events.every((e) => e.velocity === 1));
});

test('duration = gridBeats * NoteLength%, exact when variation is 0; >100% overlaps', () => {
  const half = planOne({ ...straight, density: 100, breath: 0, noteLength: 50 });
  assert.ok(half.plan.events.every((e) => Math.abs(e.durBeats - 0.25) < 1e-12));
  const legato = planOne({ ...straight, density: 100, breath: 0, noteLength: 150 });
  assert.ok(legato.plan.events.every((e) => Math.abs(e.durBeats - 0.75) < 1e-12)); // > grid step 0.5
  const floor = planOne({ ...straight, density: 100, breath: 0, noteLength: 5, gridId: '1/32' });
  assert.ok(floor.plan.events.every((e) => e.durBeats === 0.02)); // 0.00625 clamped up
});

test('plans are bit-identical across runs (M1/M2 determinism)', () => {
  const a = planOne({ seed: 1138 }, 5);
  const b = planOne({ seed: 1138 }, 5);
  assert.deepEqual(a.plan, b.plan);
  const c = planOne({ seed: 1139 }, 5);
  assert.notDeepEqual(a.plan.events, c.plan.events);
});

test('grid table matches §6.1', () => {
  assert.deepEqual(Planner.GRIDS.map((g) => g.id), ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32']);
  assert.deepEqual(Planner.GRIDS.map((g) => g.beats), [1.0, 0.5, 1 / 3, 0.25, 1 / 6, 0.125]);
  // 6/8 meter: beatsPerBar = 6 * 4/8 = 3
  const p = paramsWith({ meterNumerator: 6, meterDenominator: 8 });
  assert.equal(Planner.derive(p).beatsPerBar, 3);
});
