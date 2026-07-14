// engine/planner.js — phrase planning (SPEC §6). The pure core.
//
// plan(params, derived, phraseIndex[, cache]) is a pure function of
// (params.seed, phraseIndex): no host, no MIDI, no timers, no Math.random().
// All beats here are 0-based musical beats from song start; the Scripter
// wrapper subtracts 1 from Logic's 1-based beats at the boundary.
//
// PRNG draw order per phrase is FIXED and load-bearing:
//   fresh:  1 wants-repeat roll · 2 octave-shift roll (span > 1 only)
//           · 3 shift-direction roll (only if #2 fired)
//           · one rhythm roll per grid slot (breath slots draw and discard)
//           · per sounding note: pitch, velocity, duration, jitter
//   repeat: 1 wants-repeat roll · 2 transpose pick
//           · per copied note: velocity, jitter        (rhythm/contour copied)
// Draw #1 always being the wants-repeat roll is what lets wantsRepeatFlag(k)
// be answered in O(1) without planning phrase k — the motif chain cap (§6.3)
// depends on it.

var Planner = (function () {
  'use strict';

  // Under Node (module system present) always require; in Scripter the
  // concatenated bundle has already defined these as top-level vars. Checking
  // `module` first keeps Node behavior independent of any global bindings.
  var Prng_ = (typeof module !== 'undefined') ? require('./prng.js') : Prng;
  var Scales_ = (typeof module !== 'undefined') ? require('./scales.js') : Scales;
  var Walk_ = (typeof module !== 'undefined') ? require('./walk.js') : Walk;

  var EPS = 1e-9;

  // §6.1 grids, in §7 menu order.
  var GRIDS = [
    { id: '1/4',   beats: 1.0,     triplet: false },
    { id: '1/8',   beats: 0.5,     triplet: false },
    { id: '1/8T',  beats: 1 / 3,   triplet: true },
    { id: '1/16',  beats: 0.25,    triplet: false },
    { id: '1/16T', beats: 1 / 6,   triplet: true },
    { id: '1/32',  beats: 0.125,   triplet: false }
  ];

  var PHRASE_BARS = [1, 2, 4, 8]; // §7 menu order

  function gridById(id) {
    for (var i = 0; i < GRIDS.length; i++) {
      if (GRIDS[i].id === id) return GRIDS[i];
    }
    return null;
  }

  // §7 defaults. TriggerMode lives in the wrapper only.
  function defaultParams() {
    return {
      root: 0,                      // C
      scaleId: 'minor-pentatonic',
      lowOctave: 3,                 // C3
      octaveSpan: 2,                // C3..C5
      registerFocus: 40,
      octaveShift: 20,
      gridId: '1/8',
      density: 70,
      noteLength: 50,
      lengthVariation: 15,
      swing: 50,
      humanizeMs: 6,
      leapAmount: 25,
      directionHold: 70,
      tonalGravity: 60,
      variability: 50,
      phraseBars: 2,
      breath: 25,
      motifRepeat: 40,
      velocity: 90,
      velocityRange: 20,
      accent: 12,
      seed: 1,
      meterNumerator: 4,
      meterDenominator: 4,
      tempo: 120
    };
  }

  // Everything the engine consumes, computed once per parameter set.
  function derive(params) {
    var scale = Scales_.byId(params.scaleId);
    if (!scale) throw new Error('unknown scale: ' + params.scaleId);
    var grid = gridById(params.gridId);
    if (!grid) throw new Error('unknown grid: ' + params.gridId);
    var reg = Scales_.registerFromOctaves(params.lowOctave, params.octaveSpan);
    var ladder = Scales_.buildLadder(params.root, scale, reg.lowNote, reg.highNote);
    var beatsPerBar = params.meterNumerator * (4 / params.meterDenominator);
    var beatsPerPhrase = params.phraseBars * beatsPerBar;
    return {
      scale: scale,
      grid: grid,
      lowNote: reg.lowNote,
      highNote: reg.highNote,
      ladder: ladder,
      beatsPerBar: beatsPerBar,
      beatsPerPhrase: beatsPerPhrase,
      slotsPerPhrase: Math.round(beatsPerPhrase / grid.beats),
      humanizeBeats: (params.humanizeMs / 1000) * (params.tempo / 60)
    };
  }

  function phraseRng(params, phraseIndex) {
    return Prng_.mulberry32(Prng_.hash32(params.seed, phraseIndex));
  }

  // §5.3 metric strength. beatInPhrase is 0-based, pre-swing.
  function metricStrength(beatInPhrase, beatsPerBar) {
    var b = beatInPhrase % beatsPerBar;
    if (b < -EPS) b += beatsPerBar;
    if (Math.abs(b - Math.round(b)) < 1e-6) {
      return Math.round(b) % beatsPerBar === 0 ? 1.0 : 0.7;
    }
    var doubled = b * 2;
    if (Math.abs(doubled - Math.round(doubled)) < 1e-6) return 0.4;
    return 0.2;
  }

  // §6.1 swing: odd slots, non-triplet grids only.
  function swingOffset(slot, grid, swing) {
    if (grid.triplet || slot % 2 === 0) return 0;
    return (2 * (swing / 100) - 1) * grid.beats;
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  // Would phrase k *like* to repeat? Draw #1 of its PRNG — O(1), no planning.
  function wantsRepeatFlag(params, k) {
    return phraseRng(params, k)() < params.motifRepeat / 100;
  }

  // §6.3 chain cap: 0 = fresh, 1..2 = repeat depth. A repeat may not repeat a
  // repeat more than 2 deep; depth 3 forces fresh. Within a run of
  // consecutive wants-repeat phrases the depths therefore cycle with period 3.
  // Phrase 0 is always fresh (nothing to repeat).
  function repeatDepth(params, k) {
    if (k <= 0) return 0;
    if (!wantsRepeatFlag(params, k)) return 0;
    var s = k;
    while (s > 0 && wantsRepeatFlag(params, s - 1)) s--;
    var j = (k - s) % 3;
    if (s === 0) return j;                // run starts at forced-fresh phrase 0: 0,1,2,0,…
    return j === 2 ? 0 : j + 1;           // run starts after a fresh phrase:    1,2,0,1,…
  }

  // §6.3 transpose candidates, in spec order. Only offsets that keep the whole
  // contour inside the ladder qualify; 0 always does.
  function fittingTransposes(ladderIndices, ladderLength, degreesPerOctave) {
    var candidates = [0, -2, -1, 1, 2, -degreesPerOctave, degreesPerOctave];
    var fits = [];
    for (var c = 0; c < candidates.length; c++) {
      var t = candidates[c];
      var ok = true;
      for (var n = 0; n < ladderIndices.length; n++) {
        var moved = ladderIndices[n] + t;
        if (moved < 0 || moved >= ladderLength) { ok = false; break; }
      }
      if (ok) fits.push(t);
    }
    return fits;
  }

  // Pass 2 shared machinery: velocity, duration floor, swing + jitter timing.
  function velocityFor(params, m, rng) {
    return clamp(
      Math.round(params.velocity + params.accent * m + Prng_.centered(rng, params.velocityRange / 2)),
      1, 127
    );
  }

  function timingFor(params, derived, slot, rng) {
    var slotBeat = slot * derived.grid.beats;
    var jitter = Prng_.centered(rng, derived.humanizeBeats);
    // never before the phrase start (§6.2) — Logic drops events in the past
    return Math.max(0, slotBeat + swingOffset(slot, derived.grid, params.swing) + jitter);
  }

  function finishPlan(params, derived, k, depth, shiftSteps, slots, ladderIndices, durations, velocities, relBeats) {
    var startBeat = k * derived.beatsPerPhrase;
    var events = [];
    for (var n = 0; n < slots.length; n++) {
      events.push({
        beat: startBeat + relBeats[n],
        pitch: derived.ladder.pitches[ladderIndices[n]],
        velocity: velocities[n],
        durBeats: durations[n]
      });
    }
    events.sort(function (a, b) { return a.beat - b.beat; }); // jitter can swap neighbours
    return {
      phraseIndex: k,
      startBeat: startBeat,
      endBeat: startBeat + derived.beatsPerPhrase,
      repeatDepth: depth,
      shiftSteps: shiftSteps,    // fresh: §6.4 center shift · repeat: §6.3 transpose
      slots: slots,
      ladderIndices: ladderIndices,
      durations: durations,
      events: events
    };
  }

  function planFresh(params, derived, k) {
    var ladder = derived.ladder;
    var rng = phraseRng(params, k);
    rng(); // draw #1: wants-repeat roll (its verdict came via repeatDepth)

    // §6.4 octave shift — relocate the register center, decided before any notes
    var shiftSteps = 0;
    if (params.octaveSpan > 1) {
      if (rng() < params.octaveShift / 100) {
        shiftSteps = (rng() < 0.5 ? -1 : 1) * ladder.degreesPerOctave;
      }
    }
    var center = clamp(ladder.center + shiftSteps, 0, ladder.pitches.length - 1);

    // Pass 1 — rhythm. One draw per slot, always, so pass-2 draws start at a
    // fixed stream position regardless of density/breath settings.
    var slots = [];
    var breathStart = derived.beatsPerPhrase - (params.breath / 100) * derived.beatsPerBar;
    for (var s = 0; s < derived.slotsPerPhrase; s++) {
      var roll = rng();
      var slotBeat = s * derived.grid.beats;
      if (slotBeat >= breathStart - EPS) continue; // breath zone: forced rest
      if (roll < params.density / 100) slots.push(s);
    }

    // Pass 2 — pitch, velocity, duration, timing.
    var wparams = {
      leapAmount: params.leapAmount,
      directionHold: params.directionHold,
      tonalGravity: params.tonalGravity,
      variability: params.variability,
      registerFocus: params.registerFocus
    };
    var state = Walk_.createState(clamp(Math.round(center), 0, ladder.pitches.length - 1));
    var ladderIndices = [];
    var durations = [];
    var velocities = [];
    var relBeats = [];
    for (var n = 0; n < slots.length; n++) {
      var m = n === slots.length - 1
        ? 1.0 // final note of a phrase: maximum gravity, forced (§5.3)
        : metricStrength(slots[n] * derived.grid.beats, derived.beatsPerBar);
      ladderIndices.push(Walk_.step(ladder, wparams, state, m, center, rng));
      velocities.push(velocityFor(params, m, rng));
      durations.push(Math.max(0.02,
        derived.grid.beats * (params.noteLength / 100) * (1 + Prng_.centered(rng, params.lengthVariation / 200))));
      relBeats.push(timingFor(params, derived, slots[n], rng));
    }
    return finishPlan(params, derived, k, 0, shiftSteps, slots, ladderIndices, durations, velocities, relBeats);
  }

  // §6.3: reuse the previous phrase's rhythm and contour, transposed, with
  // velocities and micro-timing re-drawn — a restatement, not a clone.
  function planRepeat(params, derived, k, depth, cache) {
    var base = plan(params, derived, k - 1, cache);
    var ladder = derived.ladder;
    var rng = phraseRng(params, k);
    rng(); // draw #1: wants-repeat roll (true — that is why we are here)

    var fits = fittingTransposes(base.ladderIndices, ladder.pitches.length, ladder.degreesPerOctave);
    var transpose = Prng_.pick(rng, fits); // draw #2

    var slots = base.slots.slice();
    var durations = base.durations.slice();
    var ladderIndices = [];
    var velocities = [];
    var relBeats = [];
    for (var n = 0; n < slots.length; n++) {
      ladderIndices.push(base.ladderIndices[n] + transpose);
      var m = n === slots.length - 1
        ? 1.0
        : metricStrength(slots[n] * derived.grid.beats, derived.beatsPerBar);
      velocities.push(velocityFor(params, m, rng));
      relBeats.push(timingFor(params, derived, slots[n], rng));
    }
    return finishPlan(params, derived, k, depth, transpose, slots, ladderIndices, durations, velocities, relBeats);
  }

  // The entry point. `cache` is a plain object (Scripter-safe Map substitute)
  // owned by the caller; planning phrase k fills it with at most 3 entries
  // even from a cold start (§6.3 chain cap).
  function plan(params, derived, phraseIndex, cache) {
    if (cache && Object.prototype.hasOwnProperty.call(cache, phraseIndex)) {
      return cache[phraseIndex];
    }
    var depth = repeatDepth(params, phraseIndex);
    var p = depth > 0
      ? planRepeat(params, derived, phraseIndex, depth, cache)
      : planFresh(params, derived, phraseIndex);
    if (cache) cache[phraseIndex] = p;
    return p;
  }

  function phraseIndexForBeat(beat, beatsPerPhrase) {
    return Math.floor(beat / beatsPerPhrase);
  }

  return {
    GRIDS: GRIDS,
    PHRASE_BARS: PHRASE_BARS,
    gridById: gridById,
    defaultParams: defaultParams,
    derive: derive,
    phraseRng: phraseRng,
    metricStrength: metricStrength,
    swingOffset: swingOffset,
    wantsRepeatFlag: wantsRepeatFlag,
    repeatDepth: repeatDepth,
    fittingTransposes: fittingTransposes,
    plan: plan,
    phraseIndexForBeat: phraseIndexForBeat
  };
})();

if (typeof module !== 'undefined') module.exports = Planner;
