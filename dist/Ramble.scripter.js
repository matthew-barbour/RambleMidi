/*
 * Ramble — generative solo engine for Logic Pro.
 * Single-file build for the Scripter MIDI FX plug-in. Do not edit; generated
 * by tools/build.js from engine/ + scripter/ sources.
 *
 * Install: instrument track → MIDI FX → Scripter → Open Script in Editor →
 * paste this whole file → Run Script. Load any instrument below it, press
 * Play. Save it as a Scripter preset to keep it.
 */

// ═══ engine/prng.js ═══

// engine/prng.js — deterministic randomness (SPEC §3).
//
// Position-deterministic generation hinges on this file: every phrase draws
// from mulberry32(hash32(globalSeed, phraseIndex)) and nothing else.
// Math.random() is banned from the engine.
//
// Runs unmodified in Node (module.exports tail) and in Logic Scripter,
// where tools/build.js concatenates it ahead of the files that use it.

var Prng = (function () {
  'use strict';

  // mulberry32: 32-bit state, returns floats in [0, 1).
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // hash32: mix two u32s (seed, phraseIndex) into one well-avalanched u32.
  // murmur3-style finalizer applied around each input. Ports to C++ as
  // plain uint32_t arithmetic (Math.imul == 32-bit multiply).
  function hash32(a, b) {
    var h = 0x9E3779B9 ^ (a >>> 0);
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
    h = (h ^ (b >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
  }

  // Uniform float in [min, max).
  function rangeFloat(rng, min, max) {
    return min + rng() * (max - min);
  }

  // Uniform float in [-halfWidth, +halfWidth) — the spec's prng_range(±x).
  function centered(rng, halfWidth) {
    return (rng() * 2 - 1) * halfWidth;
  }

  // True with probability p.
  function chance(rng, p) {
    return rng() < p;
  }

  // Uniform pick from a non-empty array.
  function pick(rng, arr) {
    var i = Math.floor(rng() * arr.length);
    if (i >= arr.length) i = arr.length - 1; // guard rng() == 0.9999…
    return arr[i];
  }

  return {
    mulberry32: mulberry32,
    hash32: hash32,
    rangeFloat: rangeFloat,
    centered: centered,
    chance: chance,
    pick: pick
  };
})();

if (typeof module !== 'undefined') module.exports = Prng;

// ═══ engine/scales.js ═══

// engine/scales.js — scale tables, tier weights, ladder construction (SPEC §4).
//
// The ladder is the engine's whole tonal universe: an ascending array of MIDI
// pitches inside [lowNote, highNote] that belong to the key. Melodic motion
// happens on ladder *indices*, so the walk is structurally incapable of
// leaving the key or the register — nothing is ever clamped after the fact.

var Scales = (function () {
  'use strict';

  var TIER_STABLE = 1.0;
  var TIER_COLOR = 0.6;
  var TIER_PASSING = 0.25;

  // §4 table, in menu order. `blue` marks offsets that get the additional
  // phrase-final penalty (blues b5): tier weight x0.1 when metricStrength == 1.0.
  var SCALES = [
    { id: 'major',            name: 'Major',            offsets: [0, 2, 4, 5, 7, 9, 11], stable: [0, 4, 7], color: [2, 9],  passing: [5, 11], blue: [] },
    { id: 'natural-minor',    name: 'Natural Minor',    offsets: [0, 2, 3, 5, 7, 8, 10], stable: [0, 3, 7], color: [2, 10], passing: [5, 8],  blue: [] },
    { id: 'harmonic-minor',   name: 'Harmonic Minor',   offsets: [0, 2, 3, 5, 7, 8, 11], stable: [0, 3, 7], color: [2, 11], passing: [5, 8],  blue: [] },
    { id: 'dorian',           name: 'Dorian',           offsets: [0, 2, 3, 5, 7, 9, 10], stable: [0, 3, 7], color: [9, 10], passing: [2, 5],  blue: [] },
    { id: 'mixolydian',       name: 'Mixolydian',       offsets: [0, 2, 4, 5, 7, 9, 10], stable: [0, 4, 7], color: [9, 10], passing: [2, 5],  blue: [] },
    { id: 'major-pentatonic', name: 'Major Pentatonic', offsets: [0, 2, 4, 7, 9],        stable: [0, 4, 7], color: [2, 9],  passing: [],      blue: [] },
    { id: 'minor-pentatonic', name: 'Minor Pentatonic', offsets: [0, 3, 5, 7, 10],       stable: [0, 3, 7], color: [5, 10], passing: [],      blue: [] },
    { id: 'blues',            name: 'Blues',            offsets: [0, 3, 5, 6, 7, 10],    stable: [0, 3, 7], color: [5, 10], passing: [6],     blue: [6] }
  ];

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function byId(id) {
    for (var i = 0; i < SCALES.length; i++) {
      if (SCALES[i].id === id) return SCALES[i];
    }
    return null;
  }

  function byIndex(i) {
    return SCALES[i] || null;
  }

  function tierWeightFor(scale, offset) {
    if (scale.stable.indexOf(offset) !== -1) return TIER_STABLE;
    if (scale.color.indexOf(offset) !== -1) return TIER_COLOR;
    if (scale.passing.indexOf(offset) !== -1) return TIER_PASSING;
    return TIER_PASSING; // unreachable for well-formed tables
  }

  // Register derivation (§4). Logic convention: C3 = MIDI 60, so octave N
  // starts at 12 * (N + 2). Top clamped at C7 = 108.
  function registerFromOctaves(lowOctave, octaveSpan) {
    var lowNote = 12 * (lowOctave + 2);
    var highNote = Math.min(lowNote + 12 * octaveSpan, 108);
    return { lowNote: lowNote, highNote: highNote };
  }

  function buildLadder(rootPc, scale, lowNote, highNote) {
    var pitches = [];
    var tierWeights = [];
    var isBlue = [];
    for (var p = lowNote; p <= highNote; p++) {
      var off = (((p - rootPc) % 12) + 12) % 12;
      if (scale.offsets.indexOf(off) === -1) continue;
      pitches.push(p);
      tierWeights.push(tierWeightFor(scale, off));
      isBlue.push(scale.blue.indexOf(off) !== -1);
    }
    return {
      pitches: pitches,
      tierWeights: tierWeights,
      isBlue: isBlue,
      degreesPerOctave: scale.offsets.length,
      center: (pitches.length - 1) / 2
    };
  }

  function noteName(midi) {
    return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 2);
  }

  // 'C' -> 0, 'F#' -> 6, 'Bb' -> 10, 'b' -> 11 (B natural). -1 on garbage.
  function parsePitchClass(str) {
    var s = String(str).trim();
    if (s.length === 0) return -1;
    var base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[s.charAt(0).toUpperCase()];
    if (base === undefined) return -1;
    var acc = s.slice(1);
    if (acc === '#' || acc === 's') base += 1;
    else if (acc === 'b' || acc === 'B') base -= 1;
    else if (acc !== '') return -1;
    return ((base % 12) + 12) % 12;
  }

  return {
    SCALES: SCALES,
    NOTE_NAMES: NOTE_NAMES,
    TIER_STABLE: TIER_STABLE,
    TIER_COLOR: TIER_COLOR,
    TIER_PASSING: TIER_PASSING,
    byId: byId,
    byIndex: byIndex,
    tierWeightFor: tierWeightFor,
    registerFromOctaves: registerFromOctaves,
    buildLadder: buildLadder,
    noteName: noteName,
    parsePitchClass: parsePitchClass
  };
})();

if (typeof module !== 'undefined') module.exports = Scales;

// ═══ engine/walk.js ═══

// engine/walk.js — weighted pitch selection (SPEC §5).
//
// For each note: score every ladder index with five multiplied factors
// (proximity, direction, tonal gravity, repetition, register focus), apply
// the Variability temperature, sample with the phrase PRNG. Scores are
// combined in log space so low temperatures (exponent ~6.7) never underflow.
//
// One rng draw per step — the planner relies on a fixed draw count.

var Walk = (function () {
  'use strict';

  function createState(startIndex) {
    return {
      prev: startIndex,     // ladder index of the previous note
      lastDir: 0,           // -1 | 0 | +1
      consecutive: 1        // how many times `prev` has sounded in a row
    };
  }

  // Edge reflection (§5.2): within 2 steps of a ladder end, momentum is
  // flipped inward *before* weighing, so lines turn around instead of
  // stuttering against the ceiling. Mutates state.lastDir.
  function reflectAtEdges(state, ladderLength) {
    var nearBottom = state.prev <= 2;
    var nearTop = state.prev >= ladderLength - 3;
    if (nearBottom && nearTop) {
      var mid = (ladderLength - 1) / 2;
      if (state.prev < mid) state.lastDir = 1;
      else if (state.prev > mid) state.lastDir = -1;
    } else if (nearBottom) {
      state.lastDir = 1;
    } else if (nearTop) {
      state.lastDir = -1;
    }
  }

  // Normalized selection probabilities for every ladder index. Pure.
  // wparams: { leapAmount, directionHold, tonalGravity, variability,
  //            registerFocus } — raw 0-100 values as in §7.
  // m: metric strength. center: register center (§5.5, already shifted §6.4).
  function distribution(ladder, wparams, state, m, center) {
    var n = ladder.pitches.length;
    var leap = wparams.leapAmount / 100;
    var hold = wparams.directionHold / 100;
    var g = wparams.tonalGravity / 100;
    var focus = wparams.registerFocus / 100;
    var T = 0.15 + (wparams.variability / 100) * 1.85;

    var proximityScale = 0.8 + 2.2 * leap;
    var spread = Math.max(1, n * (0.60 - 0.50 * focus));
    var gravExp = g * (0.5 + 1.5 * m);
    var prev = state.prev;
    var lastDir = state.lastDir;

    var logs = new Array(n);
    var maxLog = -Infinity;
    var i;
    for (i = 0; i < n; i++) {
      var d = Math.abs(i - prev);
      var logProx = -d / proximityScale;

      var sgn = i === prev ? 0 : (i > prev ? 1 : -1);
      var dir = 1.0;
      if (sgn !== 0 && lastDir !== 0) {
        dir = sgn === lastDir ? 1.0 + 2.0 * hold : Math.max(0.1, 1.0 - 0.8 * hold);
      }

      var tier = ladder.tierWeights[i];
      if (ladder.isBlue[i] && m === 1.0) tier *= 0.1; // §4: b5 penalized on strongest positions
      var logGravity = gravExp * Math.log(tier);

      var repeat = 1.0;
      if (i === prev) repeat = state.consecutive >= 2 ? 0.05 : 0.15;

      var z = (i - center) / spread;
      var logRegister = -0.5 * z * z;

      logs[i] = (logProx + Math.log(dir) + logGravity + Math.log(repeat) + logRegister) / T;
      if (logs[i] > maxLog) maxLog = logs[i];
    }

    var p = new Array(n);
    var sum = 0;
    for (i = 0; i < n; i++) {
      p[i] = Math.exp(logs[i] - maxLog);
      sum += p[i];
    }
    for (i = 0; i < n; i++) p[i] /= sum;
    return p;
  }

  function sampleIndex(p, rng) {
    var r = rng();
    var acc = 0;
    for (var i = 0; i < p.length; i++) {
      acc += p[i];
      if (r < acc) return i;
    }
    return p.length - 1; // float round-off tail
  }

  // Pick the next note. Mutates state. Exactly one rng draw.
  function step(ladder, wparams, state, m, center, rng) {
    reflectAtEdges(state, ladder.pitches.length);
    var p = distribution(ladder, wparams, state, m, center);
    var i = sampleIndex(p, rng);
    if (i === state.prev) {
      state.consecutive += 1;
    } else {
      state.lastDir = i > state.prev ? 1 : -1;
      state.consecutive = 1;
    }
    state.prev = i;
    return i;
  }

  return {
    createState: createState,
    reflectAtEdges: reflectAtEdges,
    distribution: distribution,
    step: step
  };
})();

if (typeof module !== 'undefined') module.exports = Walk;

// ═══ engine/planner.js ═══

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

    // A live parameter change can leave the previous phrase's cached plan
    // built against a different ladder (§8.2 keeps the sounding phrase's
    // plan). If its contour no longer fits this ladder, restate nothing —
    // generate fresh instead of emitting out-of-ladder indices.
    for (var b = 0; b < base.ladderIndices.length; b++) {
      if (base.ladderIndices[b] < 0 || base.ladderIndices[b] >= ladder.pitches.length) {
        return planFresh(params, derived, k);
      }
    }

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

// ═══ scripter/wrapper.js ═══

// scripter/wrapper.js — Logic Pro Scripter wrapper (SPEC §7–§9).
//
// The thin, host-facing scheduler. All musical decisions live in engine/*;
// this file reads the knob panel, asks the planner for the phrases that
// overlap the current process block, and turns plan events into NoteOn /
// NoteOff pairs — while guaranteeing that no note ever sticks across stop,
// loop, or locate.
//
// BEAT CONVENTION, READ THIS FIRST: Scripter beats are 1-based (bar 1 beat 1
// is 1.0); the engine is 0-based. The conversion happens in exactly one
// place — ProcessMIDI subtracting 1 from the host's block beats. Everything
// below that line is engine time. (JUCE's PPQ is already 0-based, so the M7
// port deletes the subtraction and nothing else. SPEC §10.)

var NeedsTimingInfo = true;

// ---------------------------------------------------------------- parameters

var MENU_LOW_OCTAVES = ['C1', 'C2', 'C3', 'C4', 'C5'];
var MENU_SPANS = ['1 octave', '2 octaves', '3 octaves', '4 octaves'];
var MENU_PHRASE_BARS = ['1 bar', '2 bars', '4 bars', '8 bars'];

function scaleNames() {
  var names = [];
  for (var i = 0; i < Scales.SCALES.length; i++) names.push(Scales.SCALES[i].name);
  return names;
}

function gridNames() {
  var names = [];
  for (var i = 0; i < Planner.GRIDS.length; i++) names.push(Planner.GRIDS[i].id);
  return names;
}

var PluginParameters = [
  { name: '— KEY & REGISTER —', type: 'text' },
  { name: 'Root', type: 'menu', valueStrings: Scales.NOTE_NAMES, defaultValue: 0 },
  { name: 'Scale', type: 'menu', valueStrings: scaleNames(), defaultValue: 6 },
  { name: 'Low Octave', type: 'menu', valueStrings: MENU_LOW_OCTAVES, defaultValue: 2 },
  { name: 'Octave Span', type: 'menu', valueStrings: MENU_SPANS, defaultValue: 1 },
  { name: 'Register Focus', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 40, unit: '%' },
  { name: 'Octave Shift', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 20, unit: '%' },
  { name: '— RHYTHM —', type: 'text' },
  { name: 'Grid', type: 'menu', valueStrings: gridNames(), defaultValue: 1 },
  { name: 'Density', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 70, unit: '%' },
  { name: 'Note Length', type: 'lin', minValue: 5, maxValue: 150, numberOfSteps: 145, defaultValue: 50, unit: '%' },
  { name: 'Length Variation', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 15, unit: '%' },
  { name: 'Swing', type: 'lin', minValue: 50, maxValue: 75, numberOfSteps: 25, defaultValue: 50, unit: '%' },
  { name: 'Humanize', type: 'lin', minValue: 0, maxValue: 30, numberOfSteps: 30, defaultValue: 6, unit: 'ms' },
  { name: '— MELODY —', type: 'text' },
  { name: 'Leap Amount', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 25, unit: '%' },
  { name: 'Direction Hold', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 70, unit: '%' },
  { name: 'Tonal Gravity', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 60, unit: '%' },
  { name: 'Variability', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 50, unit: '%' },
  { name: '— PHRASING —', type: 'text' },
  { name: 'Phrase Length', type: 'menu', valueStrings: MENU_PHRASE_BARS, defaultValue: 1 },
  { name: 'Breath', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 25, unit: '%' },
  { name: 'Motif Repeat', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 40, unit: '%' },
  { name: '— PERFORMANCE —', type: 'text' },
  { name: 'Velocity', type: 'lin', minValue: 1, maxValue: 127, numberOfSteps: 126, defaultValue: 90 },
  { name: 'Velocity Range', type: 'lin', minValue: 0, maxValue: 64, numberOfSteps: 64, defaultValue: 20 },
  { name: 'Accent', type: 'lin', minValue: 0, maxValue: 40, numberOfSteps: 40, defaultValue: 12 },
  { name: 'Seed', type: 'lin', minValue: 0, maxValue: 9999, numberOfSteps: 9999, defaultValue: 1 },
  { name: 'Reseed', type: 'momentary' },
  { name: 'Trigger Mode', type: 'menu', valueStrings: ['Transport', 'Latch'], defaultValue: 0 }
];

// -------------------------------------------------------------------- state

var activeNotes = [];        // { pitch, offBeat } — engine beats
var heldKeys = [];           // latch-mode trigger pitches
var planCache = {};          // phraseIndex -> plan
var cachedParams = null;     // engine params snapshot (§8.2: one consistent config)
var cachedDerived = null;
var paramsDirty = true;
var lastBlockEnd = -1;       // engine beats; -1 = no block seen since stop
var wasPlaying = false;

// §7: read the panel into the planner's canonical params object.
function readParams(info) {
  var span = (GetParameter('Octave Span') | 0) + 1;
  return {
    root: GetParameter('Root') | 0,
    scaleId: Scales.SCALES[GetParameter('Scale') | 0].id,
    lowOctave: (GetParameter('Low Octave') | 0) + 1,
    octaveSpan: span,
    registerFocus: GetParameter('Register Focus'),
    octaveShift: span === 1 ? 0 : GetParameter('Octave Shift'), // §7: nowhere to shift to
    gridId: Planner.GRIDS[GetParameter('Grid') | 0].id,
    density: GetParameter('Density'),
    noteLength: GetParameter('Note Length'),
    lengthVariation: GetParameter('Length Variation'),
    swing: GetParameter('Swing'),
    humanizeMs: GetParameter('Humanize'),
    leapAmount: GetParameter('Leap Amount'),
    directionHold: GetParameter('Direction Hold'),
    tonalGravity: GetParameter('Tonal Gravity'),
    variability: GetParameter('Variability'),
    phraseBars: Planner.PHRASE_BARS[GetParameter('Phrase Length') | 0],
    breath: GetParameter('Breath'),
    motifRepeat: GetParameter('Motif Repeat'),
    velocity: GetParameter('Velocity'),
    velocityRange: GetParameter('Velocity Range'),
    accent: GetParameter('Accent'),
    seed: GetParameter('Seed') | 0,
    meterNumerator: info.meterNumerator,
    meterDenominator: info.meterDenominator,
    tempo: info.tempo
  };
}

// §8.2: parameter changes invalidate plans for phrases that haven't started;
// the phrase currently sounding keeps the plan it was started with.
function ensureParams(info) {
  if (!paramsDirty && cachedParams &&
      Math.abs(cachedParams.tempo - info.tempo) < 0.001 &&
      cachedParams.meterNumerator === info.meterNumerator &&
      cachedParams.meterDenominator === info.meterDenominator) {
    return;
  }
  cachedParams = readParams(info);
  cachedDerived = Planner.derive(cachedParams);
  // Keep only phrases that have already STARTED sounding; a phrase whose
  // first beat is still ahead (or exactly here) is replanned under the new
  // parameters. Stopped transport keeps nothing.
  var nowBeat = info.playing ? info.blockStartBeat - 1 : -1;
  var cutoff = nowBeat > 1e-9
    ? Math.floor((nowBeat - 1e-9) / cachedDerived.beatsPerPhrase)
    : -1;
  var kept = {};
  for (var key in planCache) {
    if (Object.prototype.hasOwnProperty.call(planCache, key) && Number(key) <= cutoff) {
      kept[key] = planCache[key];
    }
  }
  planCache = kept;
  paramsDirty = false;
}

// ---------------------------------------------------------------- note flow

// Immediate release of everything we started. Used on stop / cycle jump /
// locate / Reset — §8.2's stuck-note rules.
function flushAllNotes() {
  for (var i = 0; i < activeNotes.length; i++) {
    var off = new NoteOff();
    off.pitch = activeNotes[i].pitch;
    off.velocity = 64;
    off.send();
  }
  activeNotes = [];
}

// Send every pending note-off due inside this block. `clipBeat` pulls
// note-offs that would land past the cycle end back to the boundary (§8.2).
function sendDueNoteOffs(blockStart, blockEnd, clipBeat) {
  var remaining = [];
  for (var i = 0; i < activeNotes.length; i++) {
    var n = activeNotes[i];
    var offBeat = n.offBeat < clipBeat ? n.offBeat : clipBeat;
    if (offBeat < blockEnd) {
      var off = new NoteOff();
      off.pitch = n.pitch;
      off.velocity = 64;
      off.sendAtBeat(Math.max(offBeat, blockStart) + 1); // engine → host beats
    } else {
      remaining.push(n);
    }
  }
  activeNotes = remaining;
}

function scheduleNote(ev, blockStart) {
  // Last-on-wins: if this pitch is still sounding (legato NoteLength > 100%,
  // or a repeated pitch), release the old instance just before the new onset
  // so on/off pairs can never interleave into a stuck note.
  for (var i = 0; i < activeNotes.length; i++) {
    if (activeNotes[i].pitch === ev.pitch) {
      var oldOff = activeNotes[i].offBeat < ev.beat - 0.001 ? activeNotes[i].offBeat : ev.beat - 0.001;
      var off = new NoteOff();
      off.pitch = ev.pitch;
      off.velocity = 64;
      off.sendAtBeat(Math.max(oldOff, blockStart) + 1);
      activeNotes.splice(i, 1);
      break;
    }
  }
  var on = new NoteOn();
  on.pitch = ev.pitch;
  on.velocity = ev.velocity;
  on.sendAtBeat(ev.beat + 1);
  activeNotes.push({ pitch: ev.pitch, offBeat: ev.beat + ev.durBeats });
}

// ------------------------------------------------------------ host callbacks

function ProcessMIDI() {
  var info = GetTimingInfo();

  // Process pending parameter changes even while stopped — with the
  // transport halted there is no "current phrase" to protect, so the whole
  // plan cache goes (ensureParams sees nowBeat = -1).
  ensureParams(info);

  if (!info.playing) {
    if (wasPlaying) flushAllNotes();
    wasPlaying = false;
    lastBlockEnd = -1;
    return;
  }

  wasPlaying = true;

  // ── the single 1-based → 0-based conversion (see header) ──
  var blockStart = info.blockStartBeat - 1;
  var blockEnd = info.blockEndBeat - 1;

  // Cycle jump or locate backward: the timeline went backward under us.
  // Flush everything; plans are position-deterministic so replaying the
  // loop reproduces the identical notes (§3, §8.2).
  if (lastBlockEnd >= 0 && blockStart < lastBlockEnd - 1e-6) {
    flushAllNotes();
  }
  lastBlockEnd = blockEnd;

  var generating = (GetParameter('Trigger Mode') | 0) === 0 || heldKeys.length > 0;

  if (generating && blockEnd > 0) {
    var bpp = cachedDerived.beatsPerPhrase;
    var firstPhrase = Math.max(0, Math.floor(blockStart / bpp));
    var lastPhrase = Math.max(0, Math.floor((blockEnd - 1e-9) / bpp));
    for (var k = firstPhrase; k <= lastPhrase; k++) {
      var plan = Planner.plan(cachedParams, cachedDerived, k, planCache);
      for (var e = 0; e < plan.events.length; e++) {
        var ev = plan.events[e];
        if (ev.beat >= blockStart && ev.beat < blockEnd) {
          scheduleNote(ev, blockStart);
        }
      }
    }
  }

  // Note-offs go out after note-ons so a note starting and ending inside one
  // block is released here, not a block late.
  var clipBeat = info.cycling ? (info.rightCycleBeat - 1) - 0.01 : Infinity;
  sendDueNoteOffs(blockStart, blockEnd, clipBeat);
}

function HandleMIDI(event) {
  var latch = (GetParameter('Trigger Mode') | 0) === 1;
  var isOn = event instanceof NoteOn && event.velocity > 0;
  var isOff = event instanceof NoteOff || (event instanceof NoteOn && event.velocity === 0);

  if (latch && isOn) {
    if (heldKeys.indexOf(event.pitch) === -1) heldKeys.push(event.pitch);
    return; // §8.3: held keys are triggers, they don't sound
  }
  if (latch && isOff) {
    var at = heldKeys.indexOf(event.pitch);
    if (at !== -1) heldKeys.splice(at, 1);
    return;
  }
  event.send(); // Transport mode passthrough; non-note events always pass
}

function ParameterChanged(param, value) {
  var def = PluginParameters[param];
  if (!def) return;
  if (def.name === 'Reseed') {
    // Wrapper-side UI action. Not part of the engine, so the Math.random ban
    // stays absolute — wall-clock time is randomness enough for a button.
    if (value) SetParameter('Seed', Date.now() % 10000);
    return;
  }
  if (def.name === 'Trigger Mode') heldKeys = [];
  if (def.type === 'text') return;
  paramsDirty = true;
}

function Reset() {
  MIDI.allNotesOff();
  activeNotes = [];
  heldKeys = [];
  planCache = {};
  paramsDirty = true;
  lastBlockEnd = -1;
  wasPlaying = false;
}
