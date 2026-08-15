// cpp/plugin/Presets.h — factory presets (M8).
//
// The Recipes from PARAMETERS.md, verbatim: each preset is a set of deltas
// from the §7 defaults ("Deltas from the defaults; everything else stays
// put"). Exposed through the AudioProcessor program API, which the AU wrapper
// automatically publishes as AU factory presets — they appear in Logic's own
// preset menu with no extra plumbing.
//
// Presets deliberately NEVER touch Seed, Reseed, or Trigger Mode. Seed is
// "which take", Trigger Mode is performance routing — a preset is a
// *character*, and yanking the user's audition seed back to 1 on every
// preset click would be hostile. (No recipe touches any of the three.)
//
// Application is gestureless setValueNotifyingHost: the AU wrapper calls
// setCurrentProgram synchronously on the property-setter's thread (main in
// practice, never audio), the whole notify chain is thread-hardened, and
// begin/endChangeGesture around a bulk preset load risks the nested-gesture
// assertion. Gestureless is the conventional preset-load idiom.

#pragma once

#include <vector>

#include "Params.h"

namespace ramble {
namespace presets {

namespace id = params::id;

struct Delta {
    const char* paramID;
    float plainValue; // plain (denormalized) value; choice params use the index
};

struct Preset {
    const char* name;
    std::vector<Delta> deltas;
};

// PARAMETERS.md "Recipes", in document order, preceded by the baseline.
// Choice indices: scale — Dorian 3, Blues 7 (§4 menu order); grid — 1/16 is
// index 3 (§6.1 menu order); phraseLength — {1,2,4,8} bars = index {0,1,2,3};
// octaveSpan — "3 octaves" = index 2.
inline const std::vector<Preset>& table() {
    static const std::vector<Preset> t = {
        {"Defaults", {}},
        {"Sparse Ballad Line", {
            {id::density, 45}, {id::noteLength, 95}, {id::breath, 40},
            {id::phraseLength, 2}, {id::leapAmount, 15}, {id::directionHold, 80},
            {id::tonalGravity, 75}, {id::variability, 35},
        }},
        {"Percussive Jam Comping", {
            {id::noteLength, 40}, {id::swing, 54}, {id::motifRepeat, 55},
            {id::octaveShift, 30}, {id::octaveSpan, 2}, {id::registerFocus, 70},
        }},
        {"Shuffle Blues", {
            {id::scale, 7}, {id::swing, 67}, {id::tonalGravity, 70},
            {id::density, 60}, {id::phraseLength, 0},
        }},
        {"Modal Wash", {
            {id::scale, 3}, {id::tonalGravity, 15}, {id::variability, 70},
            {id::registerFocus, 20}, {id::noteLength, 130}, {id::density, 40},
            {id::humanize, 15},
        }},
        {"Sixteenth-Note Machine", {
            {id::grid, 3}, {id::density, 85}, {id::variability, 10},
            {id::lengthVariation, 0}, {id::humanize, 0}, {id::breath, 10},
            {id::velocityRange, 6}, {id::accent, 20},
        }},
    };
    return t;
}

inline int count() { return static_cast<int>(table().size()); }

// The three parameters a preset must not manage (see header comment).
inline bool isPresetManaged(const juce::String& paramID) {
    return paramID != id::seed && paramID != id::reseed && paramID != id::triggerMode;
}

// Reset every managed parameter to its default, then overlay the deltas.
inline void apply(juce::AudioProcessorValueTreeState& apvts, int index) {
    if (index < 0 || index >= count()) return;

    for (auto* raw : apvts.processor.getParameters()) {
        if (auto* p = dynamic_cast<juce::RangedAudioParameter*>(raw)) {
            if (isPresetManaged(p->paramID)) {
                p->setValueNotifyingHost(p->getDefaultValue());
            }
        }
    }
    for (const auto& d : table()[static_cast<size_t>(index)].deltas) {
        if (auto* p = apvts.getParameter(d.paramID)) {
            p->setValueNotifyingHost(p->getNormalisableRange().convertTo0to1(d.plainValue));
        }
    }
}

} // namespace presets
} // namespace ramble
