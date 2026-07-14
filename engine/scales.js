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
