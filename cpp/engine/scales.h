// cpp/engine/scales.h — scale tables, tier weights, ladder construction (SPEC §4).
//
// Port of engine/scales.js. The ladder is the engine's whole tonal universe:
// an ascending array of MIDI pitches inside [lowNote, highNote] that belong
// to the key. Melodic motion happens on ladder *indices*, so the walk is
// structurally incapable of leaving the key or the register.

#pragma once

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>
#include <vector>

namespace ramble {
namespace scales {

constexpr double TIER_STABLE = 1.0;
constexpr double TIER_COLOR = 0.6;
constexpr double TIER_PASSING = 0.25;

struct Scale {
    std::string id;
    std::string name;
    std::vector<int> offsets;
    std::vector<int> stable;
    std::vector<int> color;
    std::vector<int> passing;
    std::vector<int> blue; // offsets penalized ×0.1 as a phrase-final note
};

// §4 table, in menu order.
inline const std::vector<Scale>& SCALES() {
    static const std::vector<Scale> table = {
        {"major",            "Major",            {0, 2, 4, 5, 7, 9, 11}, {0, 4, 7}, {2, 9},  {5, 11}, {}},
        {"natural-minor",    "Natural Minor",    {0, 2, 3, 5, 7, 8, 10}, {0, 3, 7}, {2, 10}, {5, 8},  {}},
        {"harmonic-minor",   "Harmonic Minor",   {0, 2, 3, 5, 7, 8, 11}, {0, 3, 7}, {2, 11}, {5, 8},  {}},
        {"dorian",           "Dorian",           {0, 2, 3, 5, 7, 9, 10}, {0, 3, 7}, {9, 10}, {2, 5},  {}},
        {"mixolydian",       "Mixolydian",       {0, 2, 4, 5, 7, 9, 10}, {0, 4, 7}, {9, 10}, {2, 5},  {}},
        {"major-pentatonic", "Major Pentatonic", {0, 2, 4, 7, 9},        {0, 4, 7}, {2, 9},  {},      {}},
        {"minor-pentatonic", "Minor Pentatonic", {0, 3, 5, 7, 10},       {0, 3, 7}, {5, 10}, {},      {}},
        {"blues",            "Blues",            {0, 3, 5, 6, 7, 10},    {0, 3, 7}, {5, 10}, {6},     {6}},
    };
    return table;
}

inline const char* const NOTE_NAMES[12] = {
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
};

inline const Scale* byId(const std::string& id) {
    for (const auto& s : SCALES()) {
        if (s.id == id) return &s;
    }
    return nullptr;
}

inline double tierWeightFor(const Scale& scale, int offset) {
    if (std::find(scale.stable.begin(), scale.stable.end(), offset) != scale.stable.end()) return TIER_STABLE;
    if (std::find(scale.color.begin(), scale.color.end(), offset) != scale.color.end()) return TIER_COLOR;
    return TIER_PASSING; // passing, or unreachable for well-formed tables
}

struct Register {
    int lowNote;
    int highNote;
};

// §4: Logic convention C3 = MIDI 60, so octave N starts at 12*(N+2). Clamped at C7 = 108.
inline Register registerFromOctaves(int lowOctave, int octaveSpan) {
    int lowNote = 12 * (lowOctave + 2);
    int highNote = std::min(lowNote + 12 * octaveSpan, 108);
    return {lowNote, highNote};
}

struct Ladder {
    std::vector<int> pitches;
    std::vector<double> tierWeights;
    std::vector<bool> isBlue;
    int degreesPerOctave = 0;
    double center = 0.0;
};

inline Ladder buildLadder(int rootPc, const Scale& scale, int lowNote, int highNote) {
    Ladder ladder;
    for (int p = lowNote; p <= highNote; p++) {
        int off = ((p - rootPc) % 12 + 12) % 12;
        if (std::find(scale.offsets.begin(), scale.offsets.end(), off) == scale.offsets.end()) continue;
        ladder.pitches.push_back(p);
        ladder.tierWeights.push_back(tierWeightFor(scale, off));
        ladder.isBlue.push_back(std::find(scale.blue.begin(), scale.blue.end(), off) != scale.blue.end());
    }
    ladder.degreesPerOctave = static_cast<int>(scale.offsets.size());
    ladder.center = (static_cast<double>(ladder.pitches.size()) - 1) / 2.0;
    return ladder;
}

inline std::string noteName(int midi) {
    int pc = ((midi % 12) + 12) % 12;
    int octave = static_cast<int>(std::floor(midi / 12.0)) - 2;
    return std::string(NOTE_NAMES[pc]) + std::to_string(octave);
}

// 'C' -> 0, 'F#' -> 6, 'Bb' -> 10. -1 on garbage.
inline int parsePitchClass(const std::string& str) {
    if (str.empty()) return -1;
    char c = static_cast<char>(std::toupper(static_cast<unsigned char>(str[0])));
    int base;
    switch (c) {
        case 'C': base = 0; break;
        case 'D': base = 2; break;
        case 'E': base = 4; break;
        case 'F': base = 5; break;
        case 'G': base = 7; break;
        case 'A': base = 9; break;
        case 'B': base = 11; break;
        default: return -1;
    }
    std::string acc = str.substr(1);
    if (acc == "#" || acc == "s") base += 1;
    else if (acc == "b" || acc == "B") base -= 1;
    else if (!acc.empty()) return -1;
    return ((base % 12) + 12) % 12;
}

} // namespace scales
} // namespace ramble
