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
