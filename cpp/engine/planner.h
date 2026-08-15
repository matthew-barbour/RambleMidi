// cpp/engine/planner.h — phrase planning (SPEC §6). The pure core.
//
// Port of engine/planner.js. plan(params, derived, phraseIndex, cache) is a
// pure function of (params.seed, phraseIndex): no host, no MIDI, no timers,
// nothing but this PRNG. All beats here are 0-based musical beats from song
// start — the JUCE wrapper is the boundary that converts to/from a host's
// transport convention, same as the Scripter wrapper subtracts 1 from
// Logic's 1-based beats.
//
// PRNG draw order per phrase is FIXED and load-bearing (see engine/planner.js
// header comment) — this port must not reorder any rng() call relative to
// the JS source, or cross-language parity breaks even with identical math.

#pragma once

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "prng.h"
#include "scales.h"
#include "walk.h"

namespace ramble {
namespace planner {

constexpr double EPS = 1e-9;

struct Grid {
    std::string id;
    double beats;
    bool triplet;
};

// §6.1 grids, in §7 menu order.
inline const std::vector<Grid>& GRIDS() {
    static const std::vector<Grid> table = {
        {"1/4",   1.0,       false},
        {"1/8",   0.5,       false},
        {"1/8T",  1.0 / 3.0, true},
        {"1/16",  0.25,      false},
        {"1/16T", 1.0 / 6.0, true},
        {"1/32",  0.125,     false},
    };
    return table;
}

inline const std::vector<int>& PHRASE_BARS() {
    static const std::vector<int> v = {1, 2, 4, 8};
    return v;
}

inline const Grid* gridById(const std::string& id) {
    for (const auto& g : GRIDS()) {
        if (g.id == id) return &g;
    }
    return nullptr;
}

// §7 defaults. TriggerMode lives in the JUCE wrapper only.
struct Params {
    int root = 0; // C
    std::string scaleId = "minor-pentatonic";
    int lowOctave = 3;   // C3
    int octaveSpan = 2;  // C3..C5
    double registerFocus = 40;
    double octaveShift = 20;
    std::string gridId = "1/8";
    double density = 70;
    double noteLength = 50;
    double lengthVariation = 15;
    double swing = 50;
    double humanizeMs = 6;
    double leapAmount = 25;
    double directionHold = 70;
    double tonalGravity = 60;
    double variability = 50;
    int phraseBars = 2;
    double breath = 25;
    double motifRepeat = 40;
    double velocity = 90;
    double velocityRange = 20;
    double accent = 12;
    uint32_t seed = 1;
    int meterNumerator = 4;
    int meterDenominator = 4;
    double tempo = 120;
};

inline Params defaultParams() { return Params{}; }

// Everything the engine consumes, computed once per parameter set.
struct Derived {
    scales::Scale scale;
    Grid grid;
    int lowNote;
    int highNote;
    scales::Ladder ladder;
    double beatsPerBar;
    double beatsPerPhrase;
    int slotsPerPhrase;
    double humanizeBeats;
};

inline Derived derive(const Params& params) {
    const scales::Scale* scale = scales::byId(params.scaleId);
    if (!scale) throw std::runtime_error("unknown scale: " + params.scaleId);
    const Grid* grid = gridById(params.gridId);
    if (!grid) throw std::runtime_error("unknown grid: " + params.gridId);
    auto reg = scales::registerFromOctaves(params.lowOctave, params.octaveSpan);
    auto ladder = scales::buildLadder(params.root, *scale, reg.lowNote, reg.highNote);
    double beatsPerBar = params.meterNumerator * (4.0 / params.meterDenominator);
    double beatsPerPhrase = params.phraseBars * beatsPerBar;
    return Derived{
        *scale, *grid, reg.lowNote, reg.highNote, ladder,
        beatsPerBar, beatsPerPhrase,
        static_cast<int>(std::round(beatsPerPhrase / grid->beats)),
        (params.humanizeMs / 1000.0) * (params.tempo / 60.0)
    };
}

inline RngFn phraseRng(const Params& params, int phraseIndex) {
    return prng::mulberry32(prng::hash32(params.seed, static_cast<uint32_t>(phraseIndex)));
}

// §5.3 metric strength. beatInPhrase is 0-based, pre-swing.
inline double metricStrength(double beatInPhrase, double beatsPerBar) {
    double b = std::fmod(beatInPhrase, beatsPerBar);
    if (b < -EPS) b += beatsPerBar;
    if (std::fabs(b - std::round(b)) < 1e-6) {
        return std::fmod(std::round(b), beatsPerBar) == 0.0 ? 1.0 : 0.7;
    }
    double doubled = b * 2;
    if (std::fabs(doubled - std::round(doubled)) < 1e-6) return 0.4;
    return 0.2;
}

// §6.1 swing: odd slots, non-triplet grids only.
inline double swingOffset(int slot, const Grid& grid, double swing) {
    if (grid.triplet || slot % 2 == 0) return 0;
    return (2 * (swing / 100.0) - 1) * grid.beats;
}

inline double clamp(double x, double lo, double hi) {
    return x < lo ? lo : x > hi ? hi : x;
}

// Would phrase k *like* to repeat? Draw #1 of its PRNG — O(1), no planning.
inline bool wantsRepeatFlag(const Params& params, int k) {
    auto rng = phraseRng(params, k);
    return rng() < params.motifRepeat / 100.0;
}

// §6.3 chain cap: 0 = fresh, 1..2 = repeat depth. A repeat may not repeat a
// repeat more than 2 deep; depth 3 forces fresh. Phrase 0 is always fresh.
inline int repeatDepth(const Params& params, int k) {
    if (k <= 0) return 0;
    if (!wantsRepeatFlag(params, k)) return 0;
    int s = k;
    while (s > 0 && wantsRepeatFlag(params, s - 1)) s--;
    int j = (k - s) % 3;
    if (s == 0) return j;
    return j == 2 ? 0 : j + 1;
}

// §6.3 transpose candidates, in spec order. Only offsets that keep the whole
// contour inside the ladder qualify; 0 always does.
inline std::vector<int> fittingTransposes(const std::vector<int>& ladderIndices, int ladderLength, int degreesPerOctave) {
    std::vector<int> candidates = {0, -2, -1, 1, 2, -degreesPerOctave, degreesPerOctave};
    std::vector<int> fits;
    for (int t : candidates) {
        bool ok = true;
        for (int idx : ladderIndices) {
            int moved = idx + t;
            if (moved < 0 || moved >= ladderLength) { ok = false; break; }
        }
        if (ok) fits.push_back(t);
    }
    return fits;
}

// Pass 2 shared machinery: velocity, duration floor, swing + jitter timing.
inline int velocityFor(const Params& params, double m, const RngFn& rng) {
    double raw = params.velocity + params.accent * m + prng::centered(rng, params.velocityRange / 2.0);
    return static_cast<int>(clamp(std::round(raw), 1.0, 127.0));
}

inline double timingFor(const Params& params, const Derived& derived, int slot, const RngFn& rng) {
    double slotBeat = slot * derived.grid.beats;
    double jitter = prng::centered(rng, derived.humanizeBeats);
    // never before the phrase start (§6.2) — Logic/JUCE hosts drop events in the past
    return std::max(0.0, slotBeat + swingOffset(slot, derived.grid, params.swing) + jitter);
}

struct Event {
    double beat;
    int pitch;
    int velocity;
    double durBeats;
};

struct Plan {
    int phraseIndex;
    double startBeat;
    double endBeat;
    int repeatDepth;
    int shiftSteps; // fresh: §6.4 center shift · repeat: §6.3 transpose
    std::vector<int> slots;
    std::vector<int> ladderIndices;
    std::vector<double> durations;
    std::vector<Event> events;
};

using PlanCache = std::unordered_map<int, Plan>;

inline Plan finishPlan(const Params& /*params*/, const Derived& derived, int k, int depth, int shiftSteps,
                        const std::vector<int>& slots, const std::vector<int>& ladderIndices,
                        const std::vector<double>& durations, const std::vector<int>& velocities,
                        const std::vector<double>& relBeats) {
    double startBeat = k * derived.beatsPerPhrase;
    std::vector<Event> events;
    events.reserve(slots.size());
    for (size_t n = 0; n < slots.size(); n++) {
        events.push_back(Event{
            startBeat + relBeats[n],
            derived.ladder.pitches[ladderIndices[n]],
            velocities[n],
            durations[n]
        });
    }
    std::sort(events.begin(), events.end(), [](const Event& a, const Event& b) { return a.beat < b.beat; });
    return Plan{k, startBeat, startBeat + derived.beatsPerPhrase, depth, shiftSteps,
                slots, ladderIndices, durations, events};
}

// Forward declaration — planRepeat recurses into plan() for the previous phrase.
inline Plan plan(const Params& params, const Derived& derived, int phraseIndex, PlanCache* cache);

inline Plan planFresh(const Params& params, const Derived& derived, int k) {
    const auto& ladder = derived.ladder;
    auto rng = phraseRng(params, k);
    rng(); // draw #1: wants-repeat roll (its verdict came via repeatDepth)

    // §6.4 octave shift — relocate the register center, decided before any notes
    int shiftSteps = 0;
    if (params.octaveSpan > 1) {
        if (rng() < params.octaveShift / 100.0) {
            shiftSteps = (rng() < 0.5 ? -1 : 1) * ladder.degreesPerOctave;
        }
    }
    double center = clamp(ladder.center + shiftSteps, 0.0, static_cast<double>(ladder.pitches.size()) - 1);

    // Pass 1 — rhythm. One draw per slot, always, so pass-2 draws start at a
    // fixed stream position regardless of density/breath settings.
    std::vector<int> slots;
    double breathStart = derived.beatsPerPhrase - (params.breath / 100.0) * derived.beatsPerBar;
    for (int s = 0; s < derived.slotsPerPhrase; s++) {
        double roll = rng();
        double slotBeat = s * derived.grid.beats;
        if (slotBeat >= breathStart - EPS) continue; // breath zone: forced rest
        if (roll < params.density / 100.0) slots.push_back(s);
    }

    // Pass 2 — pitch, velocity, duration, timing.
    walk::WalkParams wparams{params.leapAmount, params.directionHold, params.tonalGravity,
                              params.variability, params.registerFocus};
    auto state = walk::createState(static_cast<int>(clamp(std::round(center), 0.0, static_cast<double>(ladder.pitches.size()) - 1)));
    std::vector<int> ladderIndices;
    std::vector<double> durations;
    std::vector<int> velocities;
    std::vector<double> relBeats;
    for (size_t n = 0; n < slots.size(); n++) {
        double m = (n == slots.size() - 1)
            ? 1.0 // final note of a phrase: maximum gravity, forced (§5.3)
            : metricStrength(slots[n] * derived.grid.beats, derived.beatsPerBar);
        ladderIndices.push_back(walk::step(ladder, wparams, state, m, center, rng));
        velocities.push_back(velocityFor(params, m, rng));
        durations.push_back(std::max(0.02,
            derived.grid.beats * (params.noteLength / 100.0) * (1 + prng::centered(rng, params.lengthVariation / 200.0))));
        relBeats.push_back(timingFor(params, derived, slots[n], rng));
    }
    return finishPlan(params, derived, k, 0, shiftSteps, slots, ladderIndices, durations, velocities, relBeats);
}

// §6.3: reuse the previous phrase's rhythm and contour, transposed, with
// velocities and micro-timing re-drawn — a restatement, not a clone.
inline Plan planRepeat(const Params& params, const Derived& derived, int k, int depth, PlanCache* cache) {
    Plan base = plan(params, derived, k - 1, cache);
    const auto& ladder = derived.ladder;

    // A live parameter change can leave the previous phrase's cached plan
    // built against a different ladder. If its contour no longer fits this
    // ladder, restate nothing — generate fresh instead of emitting
    // out-of-ladder indices.
    for (int idx : base.ladderIndices) {
        if (idx < 0 || idx >= static_cast<int>(ladder.pitches.size())) {
            return planFresh(params, derived, k);
        }
    }

    auto rng = phraseRng(params, k);
    rng(); // draw #1: wants-repeat roll (true — that is why we are here)

    auto fits = fittingTransposes(base.ladderIndices, static_cast<int>(ladder.pitches.size()), ladder.degreesPerOctave);
    int transpose = prng::pick(rng, fits); // draw #2

    std::vector<int> slots = base.slots;
    std::vector<double> durations = base.durations;
    std::vector<int> ladderIndices;
    std::vector<int> velocities;
    std::vector<double> relBeats;
    for (size_t n = 0; n < slots.size(); n++) {
        ladderIndices.push_back(base.ladderIndices[n] + transpose);
        double m = (n == slots.size() - 1)
            ? 1.0
            : metricStrength(slots[n] * derived.grid.beats, derived.beatsPerBar);
        velocities.push_back(velocityFor(params, m, rng));
        relBeats.push_back(timingFor(params, derived, slots[n], rng));
    }
    return finishPlan(params, derived, k, depth, transpose, slots, ladderIndices, durations, velocities, relBeats);
}

// The entry point. `cache`, if non-null, is owned by the caller; planning
// phrase k fills it with at most 3 entries even from a cold start (§6.3
// chain cap).
inline Plan plan(const Params& params, const Derived& derived, int phraseIndex, PlanCache* cache) {
    if (cache) {
        auto it = cache->find(phraseIndex);
        if (it != cache->end()) return it->second;
    }
    int depth = repeatDepth(params, phraseIndex);
    Plan p = depth > 0
        ? planRepeat(params, derived, phraseIndex, depth, cache)
        : planFresh(params, derived, phraseIndex);
    if (cache) (*cache)[phraseIndex] = p;
    return p;
}

inline int phraseIndexForBeat(double beat, double beatsPerPhrase) {
    return static_cast<int>(std::floor(beat / beatsPerPhrase));
}

} // namespace planner
} // namespace ramble
