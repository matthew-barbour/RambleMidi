// cpp/engine/prng.h — deterministic randomness (SPEC §3).
//
// Line-for-line port of engine/prng.js. Position-deterministic generation
// hinges on this file matching the JS exactly: every phrase draws from
// mulberry32(hash32(globalSeed, phraseIndex)) and nothing else.
//
// All arithmetic is uint32_t, which wraps mod 2^32 the same way JS's
// `| 0` / `>>> 0` coercions do — Math.imul is just a 32-bit unsigned
// multiply once truncated to uint32_t, so no imul-equivalent is needed.

#pragma once

#include <cstdint>
#include <functional>
#include <vector>

namespace ramble {

using RngFn = std::function<double()>;

namespace prng {

inline RngFn mulberry32(uint32_t seed) {
    return [seed]() mutable {
        seed += 0x6D2B79F5u;
        uint32_t t = seed;
        t = (t ^ (t >> 15)) * (1u | t);
        t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    };
}

inline uint32_t hash32(uint32_t a, uint32_t b) {
    uint32_t h = 0x9E3779B9u ^ a;
    h = (h ^ (h >> 16)) * 0x85EBCA6Bu;
    h = h ^ b;
    h = (h ^ (h >> 13)) * 0xC2B2AE35u;
    h = h ^ (h >> 16);
    return h;
}

inline double rangeFloat(const RngFn& rng, double lo, double hi) {
    return lo + rng() * (hi - lo);
}

// Uniform float in [-halfWidth, +halfWidth) — the spec's prng_range(±x).
inline double centered(const RngFn& rng, double halfWidth) {
    return (rng() * 2.0 - 1.0) * halfWidth;
}

inline bool chance(const RngFn& rng, double p) {
    return rng() < p;
}

template <typename T>
inline const T& pick(const RngFn& rng, const std::vector<T>& arr) {
    auto i = static_cast<size_t>(rng() * static_cast<double>(arr.size()));
    if (i >= arr.size()) i = arr.size() - 1; // guard rng() == 0.9999…
    return arr[i];
}

} // namespace prng
} // namespace ramble
