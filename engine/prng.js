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
