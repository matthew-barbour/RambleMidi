// cpp/plugin/Params.h — APVTS parameter layout + panel → engine translation.
//
// The JUCE counterpart of the Scripter wrapper's PluginParameters array and
// readParams() (scripter/wrapper.js:35-110). Same §7 controls, same ranges,
// same defaults, same menu orders — the parameter surface is part of the
// "output matches Scripter" contract, because a mismatched default or a
// reordered menu silently changes the notes.
//
// TriggerMode and Reseed live here (wrapper-level), not in planner::Params —
// exactly as in Scripter ("TriggerMode lives in the wrapper only").

#pragma once

#include <atomic>

#include <juce_audio_processors/juce_audio_processors.h>

#include "../engine/planner.h"
#include "../engine/scales.h"

namespace ramble {
namespace params {

// Parameter IDs — stable across versions (APVTS state is keyed on these).
namespace id {
inline constexpr const char* root = "root";
inline constexpr const char* scale = "scale";
inline constexpr const char* lowOctave = "lowOctave";
inline constexpr const char* octaveSpan = "octaveSpan";
inline constexpr const char* registerFocus = "registerFocus";
inline constexpr const char* octaveShift = "octaveShift";
inline constexpr const char* grid = "grid";
inline constexpr const char* density = "density";
inline constexpr const char* noteLength = "noteLength";
inline constexpr const char* lengthVariation = "lengthVariation";
inline constexpr const char* swing = "swing";
inline constexpr const char* humanize = "humanize";
inline constexpr const char* leapAmount = "leapAmount";
inline constexpr const char* directionHold = "directionHold";
inline constexpr const char* tonalGravity = "tonalGravity";
inline constexpr const char* variability = "variability";
inline constexpr const char* phraseLength = "phraseLength";
inline constexpr const char* breath = "breath";
inline constexpr const char* motifRepeat = "motifRepeat";
inline constexpr const char* velocity = "velocity";
inline constexpr const char* velocityRange = "velocityRange";
inline constexpr const char* accent = "accent";
inline constexpr const char* seed = "seed";
inline constexpr const char* reseed = "reseed";
inline constexpr const char* triggerMode = "triggerMode";
} // namespace id

inline juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout() {
    using juce::AudioParameterBool;
    using juce::AudioParameterChoice;
    using juce::AudioParameterInt;
    using juce::ParameterID;
    using juce::StringArray;

    StringArray rootNames;
    for (const auto* name : scales::NOTE_NAMES) rootNames.add(name);

    StringArray scaleNames;
    for (const auto& s : scales::SCALES()) scaleNames.add(s.name);

    StringArray gridNames;
    for (const auto& g : planner::GRIDS()) gridNames.add(g.id);

    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    // KEY & REGISTER (§7 #1-6)
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::root, 1}, "Root", rootNames, 0));
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::scale, 1}, "Scale", scaleNames, 6)); // Minor Pentatonic
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::lowOctave, 1}, "Low Octave",
        StringArray{"C1", "C2", "C3", "C4", "C5"}, 2)); // C3
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::octaveSpan, 1}, "Octave Span",
        StringArray{"1 octave", "2 octaves", "3 octaves", "4 octaves"}, 1)); // 2 octaves
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::registerFocus, 1}, "Register Focus", 0, 100, 40));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::octaveShift, 1}, "Octave Shift", 0, 100, 20));

    // RHYTHM (§7 #7-12)
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::grid, 1}, "Grid", gridNames, 1)); // 1/8
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::density, 1}, "Density", 0, 100, 70));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::noteLength, 1}, "Note Length", 5, 150, 50));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::lengthVariation, 1}, "Length Variation", 0, 100, 15));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::swing, 1}, "Swing", 50, 75, 50));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::humanize, 1}, "Humanize", 0, 30, 6));

    // MELODY (§7 #13-16)
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::leapAmount, 1}, "Leap Amount", 0, 100, 25));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::directionHold, 1}, "Direction Hold", 0, 100, 70));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::tonalGravity, 1}, "Tonal Gravity", 0, 100, 60));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::variability, 1}, "Variability", 0, 100, 50));

    // PHRASING (§7 #17-19)
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::phraseLength, 1}, "Phrase Length",
        StringArray{"1 bar", "2 bars", "4 bars", "8 bars"}, 1)); // 2 bars
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::breath, 1}, "Breath", 0, 100, 25));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::motifRepeat, 1}, "Motif Repeat", 0, 100, 40));

    // PERFORMANCE (§7 #20-25)
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::velocity, 1}, "Velocity", 1, 127, 90));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::velocityRange, 1}, "Velocity Range", 0, 64, 20));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::accent, 1}, "Accent", 0, 40, 12));
    layout.add(std::make_unique<AudioParameterInt>(ParameterID{id::seed, 1}, "Seed", 0, 9999, 1));
    layout.add(std::make_unique<AudioParameterBool>(ParameterID{id::reseed, 1}, "Reseed", false));
    layout.add(std::make_unique<AudioParameterChoice>(ParameterID{id::triggerMode, 1}, "Trigger Mode",
        StringArray{"Transport", "Latch"}, 0));

    return layout;
}

// Raw atomic value pointers for lock-free reads on the audio thread.
struct Refs {
    std::atomic<float>* root;
    std::atomic<float>* scale;
    std::atomic<float>* lowOctave;
    std::atomic<float>* octaveSpan;
    std::atomic<float>* registerFocus;
    std::atomic<float>* octaveShift;
    std::atomic<float>* grid;
    std::atomic<float>* density;
    std::atomic<float>* noteLength;
    std::atomic<float>* lengthVariation;
    std::atomic<float>* swing;
    std::atomic<float>* humanize;
    std::atomic<float>* leapAmount;
    std::atomic<float>* directionHold;
    std::atomic<float>* tonalGravity;
    std::atomic<float>* variability;
    std::atomic<float>* phraseLength;
    std::atomic<float>* breath;
    std::atomic<float>* motifRepeat;
    std::atomic<float>* velocity;
    std::atomic<float>* velocityRange;
    std::atomic<float>* accent;
    std::atomic<float>* seed;
    std::atomic<float>* triggerMode;

    void attach(juce::AudioProcessorValueTreeState& apvts) {
        root = apvts.getRawParameterValue(id::root);
        scale = apvts.getRawParameterValue(id::scale);
        lowOctave = apvts.getRawParameterValue(id::lowOctave);
        octaveSpan = apvts.getRawParameterValue(id::octaveSpan);
        registerFocus = apvts.getRawParameterValue(id::registerFocus);
        octaveShift = apvts.getRawParameterValue(id::octaveShift);
        grid = apvts.getRawParameterValue(id::grid);
        density = apvts.getRawParameterValue(id::density);
        noteLength = apvts.getRawParameterValue(id::noteLength);
        lengthVariation = apvts.getRawParameterValue(id::lengthVariation);
        swing = apvts.getRawParameterValue(id::swing);
        humanize = apvts.getRawParameterValue(id::humanize);
        leapAmount = apvts.getRawParameterValue(id::leapAmount);
        directionHold = apvts.getRawParameterValue(id::directionHold);
        tonalGravity = apvts.getRawParameterValue(id::tonalGravity);
        variability = apvts.getRawParameterValue(id::variability);
        phraseLength = apvts.getRawParameterValue(id::phraseLength);
        breath = apvts.getRawParameterValue(id::breath);
        motifRepeat = apvts.getRawParameterValue(id::motifRepeat);
        velocity = apvts.getRawParameterValue(id::velocity);
        velocityRange = apvts.getRawParameterValue(id::velocityRange);
        accent = apvts.getRawParameterValue(id::accent);
        seed = apvts.getRawParameterValue(id::seed);
        triggerMode = apvts.getRawParameterValue(id::triggerMode);
    }
};

// wrapper.js readParams (§7): panel → the planner's canonical params object.
// Tempo and meter come from the host's timing info, exactly as in Scripter.
inline planner::Params read(const Refs& r, double tempo, int meterNumerator, int meterDenominator) {
    planner::Params p;
    int span = static_cast<int>(r.octaveSpan->load()) + 1;
    p.root = static_cast<int>(r.root->load());
    p.scaleId = scales::SCALES()[static_cast<size_t>(r.scale->load())].id;
    p.lowOctave = static_cast<int>(r.lowOctave->load()) + 1;
    p.octaveSpan = span;
    p.registerFocus = r.registerFocus->load();
    p.octaveShift = span == 1 ? 0 : r.octaveShift->load(); // §7: nowhere to shift to
    p.gridId = planner::GRIDS()[static_cast<size_t>(r.grid->load())].id;
    p.density = r.density->load();
    p.noteLength = r.noteLength->load();
    p.lengthVariation = r.lengthVariation->load();
    p.swing = r.swing->load();
    p.humanizeMs = r.humanize->load();
    p.leapAmount = r.leapAmount->load();
    p.directionHold = r.directionHold->load();
    p.tonalGravity = r.tonalGravity->load();
    p.variability = r.variability->load();
    p.phraseBars = planner::PHRASE_BARS()[static_cast<size_t>(r.phraseLength->load())];
    p.breath = r.breath->load();
    p.motifRepeat = r.motifRepeat->load();
    p.velocity = r.velocity->load();
    p.velocityRange = r.velocityRange->load();
    p.accent = r.accent->load();
    p.seed = static_cast<uint32_t>(r.seed->load());
    p.meterNumerator = meterNumerator;
    p.meterDenominator = meterDenominator;
    p.tempo = tempo;
    return p;
}

} // namespace params
} // namespace ramble
