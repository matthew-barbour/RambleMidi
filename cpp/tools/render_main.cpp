// cpp/tools/render_main.cpp — M7a parity CLI.
//
// Mirrors tools/render.js's flag surface closely enough to drive the same
// invocation through both engines and diff the result. It has no --print
// grid, no .mid writer (that's midifile.js's job and stays JS-only for now,
// per the M7a plan) — its only output is the JSON event list used for
// cross-language parity checking:
//
//   node tools/render.js --seed 1138 --bars 16 --root A --scale minor-pentatonic --json --no-mid
//   ./build/ramble-render --seed 1138 --bars 16 --root A --scale minor-pentatonic
//
// --print, --no-mid, --out, --json, --tempo-as-int-etc. are accepted and
// ignored/no-op where render.js has them, so a line copied from render.js
// usage doesn't need hand-editing to run here.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../engine/planner.h"
#include "../engine/scales.h"

using namespace ramble;

namespace {

const std::map<std::string, std::function<void(planner::Params&, double)>>& numericFlags() {
    static const std::map<std::string, std::function<void(planner::Params&, double)>> table = {
        {"seed",              [](planner::Params& p, double v) { p.seed = static_cast<uint32_t>(v); }},
        {"low-octave",        [](planner::Params& p, double v) { p.lowOctave = static_cast<int>(v); }},
        {"octave-span",       [](planner::Params& p, double v) { p.octaveSpan = static_cast<int>(v); }},
        {"register-focus",    [](planner::Params& p, double v) { p.registerFocus = v; }},
        {"octave-shift",      [](planner::Params& p, double v) { p.octaveShift = v; }},
        {"density",           [](planner::Params& p, double v) { p.density = v; }},
        {"note-length",       [](planner::Params& p, double v) { p.noteLength = v; }},
        {"length-variation",  [](planner::Params& p, double v) { p.lengthVariation = v; }},
        {"swing",             [](planner::Params& p, double v) { p.swing = v; }},
        {"humanize",          [](planner::Params& p, double v) { p.humanizeMs = v; }},
        {"leap-amount",       [](planner::Params& p, double v) { p.leapAmount = v; }},
        {"direction-hold",    [](planner::Params& p, double v) { p.directionHold = v; }},
        {"tonal-gravity",     [](planner::Params& p, double v) { p.tonalGravity = v; }},
        {"variability",       [](planner::Params& p, double v) { p.variability = v; }},
        {"phrase-bars",       [](planner::Params& p, double v) { p.phraseBars = static_cast<int>(v); }},
        {"breath",            [](planner::Params& p, double v) { p.breath = v; }},
        {"motif-repeat",      [](planner::Params& p, double v) { p.motifRepeat = v; }},
        {"velocity",          [](planner::Params& p, double v) { p.velocity = v; }},
        {"velocity-range",    [](planner::Params& p, double v) { p.velocityRange = v; }},
        {"accent",            [](planner::Params& p, double v) { p.accent = v; }},
        {"tempo",             [](planner::Params& p, double v) { p.tempo = v; }},
    };
    return table;
}

[[noreturn]] void fail(const std::string& msg) {
    std::cerr << msg << "\n";
    std::exit(1);
}

// {js render.js's render(): plan every phrase overlapping [0, bars), truncate to the window}
struct RenderResult {
    planner::Derived derived;
    std::vector<planner::Event> events;
};

RenderResult render(const planner::Params& params, int bars) {
    auto derived = planner::derive(params);
    double totalBeats = bars * derived.beatsPerBar;
    int phraseCount = static_cast<int>(std::ceil(totalBeats / derived.beatsPerPhrase));
    planner::PlanCache cache;
    std::vector<planner::Event> events;
    for (int k = 0; k < phraseCount; k++) {
        auto p = planner::plan(params, derived, k, &cache);
        for (const auto& ev : p.events) {
            if (ev.beat < totalBeats - 1e-9) events.push_back(ev);
        }
    }
    std::sort(events.begin(), events.end(), [](const planner::Event& a, const planner::Event& b) {
        return a.beat < b.beat;
    });
    return {derived, events};
}

void printJson(const std::vector<planner::Event>& events) {
    std::ostringstream out;
    out << std::setprecision(17);
    out << "{\"events\":[";
    for (size_t i = 0; i < events.size(); i++) {
        if (i > 0) out << ",";
        const auto& e = events[i];
        out << "{\"beat\":" << e.beat
            << ",\"pitch\":" << e.pitch
            << ",\"velocity\":" << e.velocity
            << ",\"durBeats\":" << e.durBeats << "}";
    }
    out << "]}";
    std::cout << out.str() << "\n";
}

} // namespace

int main(int argc, char** argv) {
    planner::Params params = planner::defaultParams();
    int bars = 8;

    std::vector<std::string> args(argv + 1, argv + argc);
    for (size_t i = 0; i < args.size(); i++) {
        const std::string& tok = args[i];
        if (tok.rfind("--", 0) != 0) fail("unexpected argument: " + tok);
        std::string name = tok.substr(2);

        if (name == "help") {
            std::cout << "usage: ramble-render [options] (mirrors tools/render.js's flags; JSON to stdout)\n";
            return 0;
        }
        if (name == "print" || name == "no-mid" || name == "json") continue; // no-ops here

        if (i + 1 >= args.size()) fail("missing value for --" + name);
        const std::string& value = args[++i];

        if (name == "bars") {
            bars = std::atoi(value.c_str());
            if (bars <= 0) fail("--bars must be a positive integer");
        } else if (name == "out") {
            // no .mid writer in this CLI yet — accepted for flag-line compatibility
        } else if (name == "root") {
            int pc = scales::parsePitchClass(value);
            if (pc < 0) fail("bad root: " + value);
            params.root = pc;
        } else if (name == "scale") {
            if (!scales::byId(value)) fail("unknown scale: " + value);
            params.scaleId = value;
        } else if (name == "grid") {
            if (!planner::gridById(value)) fail("unknown grid: " + value);
            params.gridId = value;
        } else if (name == "meter") {
            auto slash = value.find('/');
            if (slash == std::string::npos) fail("bad meter: " + value + " (expected e.g. 4/4)");
            params.meterNumerator = std::atoi(value.substr(0, slash).c_str());
            params.meterDenominator = std::atoi(value.substr(slash + 1).c_str());
        } else {
            auto it = numericFlags().find(name);
            if (it == numericFlags().end()) fail("unknown option: --" + name);
            it->second(params, std::atof(value.c_str()));
        }
    }

    if (params.octaveSpan == 1) params.octaveShift = 0; // §7: nowhere to shift to
    const auto& phraseBars = planner::PHRASE_BARS();
    if (std::find(phraseBars.begin(), phraseBars.end(), params.phraseBars) == phraseBars.end()) {
        fail("--phrase-bars must be one of 1, 2, 4, 8");
    }

    auto result = render(params, bars);
    printJson(result.events);
    return 0;
}
