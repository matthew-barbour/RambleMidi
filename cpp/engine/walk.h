// cpp/engine/walk.h — weighted pitch selection (SPEC §5).
//
// Port of engine/walk.js. For each note: score every ladder index with five
// multiplied factors (proximity, direction, tonal gravity, repetition,
// register focus), apply the Variability temperature, sample with the phrase
// PRNG. Scores are combined in log space so low temperatures (exponent ~6.7)
// never underflow — this is the actual implementation, not the naive
// multiply-then-power form in SPEC §5.6; ported as coded so behavior matches.
//
// std::exp/std::pow are not guaranteed bit-identical to V8's — this is the
// one module where cross-language parity is defined as "same sampled index",
// not "same float bits" (see the port plan's float-parity note).

#pragma once

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

#include "prng.h"
#include "scales.h"

namespace ramble {
namespace walk {

struct WalkParams {
    double leapAmount;
    double directionHold;
    double tonalGravity;
    double variability;
    double registerFocus;
};

struct State {
    int prev;        // ladder index of the previous note
    int lastDir = 0;  // -1 | 0 | +1
    int consecutive = 1; // how many times `prev` has sounded in a row
};

inline State createState(int startIndex) {
    return {startIndex, 0, 1};
}

// Edge reflection (§5.2): within 2 steps of a ladder end, momentum is
// flipped inward *before* weighing, so lines turn around instead of
// stuttering against the ceiling. Mutates state.lastDir.
inline void reflectAtEdges(State& state, int ladderLength) {
    bool nearBottom = state.prev <= 2;
    bool nearTop = state.prev >= ladderLength - 3;
    if (nearBottom && nearTop) {
        double mid = (ladderLength - 1) / 2.0;
        if (state.prev < mid) state.lastDir = 1;
        else if (state.prev > mid) state.lastDir = -1;
    } else if (nearBottom) {
        state.lastDir = 1;
    } else if (nearTop) {
        state.lastDir = -1;
    }
}

// Normalized selection probabilities for every ladder index. Pure.
inline std::vector<double> distribution(const scales::Ladder& ladder, const WalkParams& wparams,
                                         const State& state, double m, double center) {
    auto n = static_cast<int>(ladder.pitches.size());
    double leap = wparams.leapAmount / 100.0;
    double hold = wparams.directionHold / 100.0;
    double g = wparams.tonalGravity / 100.0;
    double focus = wparams.registerFocus / 100.0;
    double T = 0.15 + (wparams.variability / 100.0) * 1.85;

    double proximityScale = 0.8 + 2.2 * leap;
    double spread = std::max(1.0, n * (0.60 - 0.50 * focus));
    double gravExp = g * (0.5 + 1.5 * m);
    int prev = state.prev;
    int lastDir = state.lastDir;

    std::vector<double> logs(n);
    double maxLog = -std::numeric_limits<double>::infinity();
    for (int i = 0; i < n; i++) {
        double d = std::abs(i - prev);
        double logProx = -d / proximityScale;

        int sgn = (i == prev) ? 0 : (i > prev ? 1 : -1);
        double dir = 1.0;
        if (sgn != 0 && lastDir != 0) {
            dir = (sgn == lastDir) ? 1.0 + 2.0 * hold : std::max(0.1, 1.0 - 0.8 * hold);
        }

        double tier = ladder.tierWeights[i];
        if (ladder.isBlue[i] && m == 1.0) tier *= 0.1; // §4: b5 penalized on strongest positions
        double logGravity = gravExp * std::log(tier);

        double repeat = 1.0;
        if (i == prev) repeat = state.consecutive >= 2 ? 0.05 : 0.15;

        double z = (i - center) / spread;
        double logRegister = -0.5 * z * z;

        logs[i] = (logProx + std::log(dir) + logGravity + std::log(repeat) + logRegister) / T;
        if (logs[i] > maxLog) maxLog = logs[i];
    }

    std::vector<double> p(n);
    double sum = 0;
    for (int i = 0; i < n; i++) {
        p[i] = std::exp(logs[i] - maxLog);
        sum += p[i];
    }
    for (int i = 0; i < n; i++) p[i] /= sum;
    return p;
}

inline int sampleIndex(const std::vector<double>& p, const RngFn& rng) {
    double r = rng();
    double acc = 0;
    for (size_t i = 0; i < p.size(); i++) {
        acc += p[i];
        if (r < acc) return static_cast<int>(i);
    }
    return static_cast<int>(p.size()) - 1; // float round-off tail
}

// Pick the next note. Mutates state. Exactly one rng draw.
inline int step(const scales::Ladder& ladder, const WalkParams& wparams, State& state,
                 double m, double center, const RngFn& rng) {
    reflectAtEdges(state, static_cast<int>(ladder.pitches.size()));
    auto p = distribution(ladder, wparams, state, m, center);
    int i = sampleIndex(p, rng);
    if (i == state.prev) {
        state.consecutive += 1;
    } else {
        state.lastDir = i > state.prev ? 1 : -1;
        state.consecutive = 1;
    }
    state.prev = i;
    return i;
}

} // namespace walk
} // namespace ramble
