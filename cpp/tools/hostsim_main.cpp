// cpp/tools/hostsim_main.cpp — ramble-hostsim: drive Scheduler through a
// scripted host session and emit the MIDI log as JSON.
//
// The M7b acceptance harness (SPEC M7: "output matches Scripter for the same
// seed and params"). test/scheduler-parity.test.js defines each scenario ONCE
// as a list of ops, replays it against the Scripter bundle via the mock host
// (test/scripter-host.js), pipes the same ops here, and diffs the two logs.
//
// Ops, one per line on stdin (all beats are ENGINE beats, 0-based — the JS
// runner adds 1 when driving the 1-based mock Scripter host):
//
//   param <field> <value>      panel change; field = planner::Params member
//                              (scaleId/gridId take strings) or triggerMode
//   tempo <bpm>
//   meter <num> <den>
//   cycle on <left> <right> | cycle off
//   playrange <from> <to> <blockBeats>   mirror of ScripterHost.playRange
//   stop                       one stopped block, like Logic after halting
//   note <on|off> <pitch> <velocity>     controller input (latch triggers)
//   reset                      host Reset() — allNotesOff + state clear
//
// Output: {"events":[{"type":"on"|"off"|"alloff","pitch","velocity","beat"},…]}

#include <cstdint>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "../plugin/Scheduler.h"

using namespace ramble;

namespace {

struct HostState {
    planner::Params panel;   // tempo/meter fields here are the host's, applied per block
    int triggerMode = 0;     // 0 = Transport, 1 = Latch (wrapper-level param, not engine)
    bool cycling = false;
    double leftCycleBeat = 0;
    double rightCycleBeat = 0;
    double lastBlockStart = 0; // the mock host leaves these unchanged on stop()
    double lastBlockEnd = 0;
};

// wrapper.js readParams: the per-block panel snapshot, with the §7 rule that
// Octave Span 1 forces Octave Shift to 0 (nowhere to shift to).
planner::Params effectivePanel(const HostState& host) {
    planner::Params p = host.panel;
    if (p.octaveSpan == 1) p.octaveShift = 0;
    return p;
}

[[noreturn]] void fail(const std::string& msg) {
    std::cerr << "hostsim: " << msg << "\n";
    std::exit(1);
}

bool setParamField(planner::Params& p, const std::string& field, const std::string& value) {
    auto num = [&value]() { return std::atof(value.c_str()); };
    if (field == "root") p.root = static_cast<int>(num());
    else if (field == "scaleId") p.scaleId = value;
    else if (field == "gridId") p.gridId = value;
    else if (field == "lowOctave") p.lowOctave = static_cast<int>(num());
    else if (field == "octaveSpan") p.octaveSpan = static_cast<int>(num());
    else if (field == "registerFocus") p.registerFocus = num();
    else if (field == "octaveShift") p.octaveShift = num();
    else if (field == "density") p.density = num();
    else if (field == "noteLength") p.noteLength = num();
    else if (field == "lengthVariation") p.lengthVariation = num();
    else if (field == "swing") p.swing = num();
    else if (field == "humanizeMs") p.humanizeMs = num();
    else if (field == "leapAmount") p.leapAmount = num();
    else if (field == "directionHold") p.directionHold = num();
    else if (field == "tonalGravity") p.tonalGravity = num();
    else if (field == "variability") p.variability = num();
    else if (field == "phraseBars") p.phraseBars = static_cast<int>(num());
    else if (field == "breath") p.breath = num();
    else if (field == "motifRepeat") p.motifRepeat = num();
    else if (field == "velocity") p.velocity = num();
    else if (field == "velocityRange") p.velocityRange = num();
    else if (field == "accent") p.accent = num();
    else if (field == "seed") p.seed = static_cast<uint32_t>(std::atol(value.c_str()));
    else return false;
    return true;
}

sched::TimingInfo timingFor(const HostState& host, bool playing, double start, double end) {
    sched::TimingInfo info;
    info.playing = playing;
    info.blockStartBeat = start;
    info.blockEndBeat = end;
    info.cycling = host.cycling;
    info.leftCycleBeat = host.leftCycleBeat;
    info.rightCycleBeat = host.rightCycleBeat;
    return info;
}

} // namespace

int main() {
    HostState host;
    sched::Scheduler scheduler;
    std::vector<sched::OutEvent> out;

    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream tok(line);
        std::string op;
        if (!(tok >> op) || op.empty() || op[0] == '#') continue;

        if (op == "param") {
            std::string field, value;
            if (!(tok >> field >> value)) fail("param needs <field> <value>");
            if (field == "triggerMode") {
                host.triggerMode = std::atoi(value.c_str());
                scheduler.clearHeldKeys(); // wrapper.js ParameterChanged on Trigger Mode
            } else if (!setParamField(host.panel, field, value)) {
                fail("unknown param field: " + field);
            }
        } else if (op == "tempo") {
            if (!(tok >> host.panel.tempo)) fail("tempo needs <bpm>");
        } else if (op == "meter") {
            if (!(tok >> host.panel.meterNumerator >> host.panel.meterDenominator)) {
                fail("meter needs <num> <den>");
            }
        } else if (op == "cycle") {
            std::string mode;
            if (!(tok >> mode)) fail("cycle needs on|off");
            if (mode == "on") {
                if (!(tok >> host.leftCycleBeat >> host.rightCycleBeat)) {
                    fail("cycle on needs <left> <right>");
                }
                host.cycling = true;
            } else {
                host.cycling = false;
            }
        } else if (op == "playrange") {
            double from, to, blockBeats;
            if (!(tok >> from >> to >> blockBeats)) fail("playrange needs <from> <to> <blockBeats>");
            // Mirror of ScripterHost.playRange — identical loop arithmetic.
            double start = from;
            while (start < to - 1e-9) {
                double end = std::min(start + blockBeats, to);
                scheduler.processBlock(timingFor(host, true, start, end),
                                       effectivePanel(host), host.triggerMode == 1, out);
                host.lastBlockStart = start;
                host.lastBlockEnd = end;
                start = end;
            }
        } else if (op == "stop") {
            // One stopped block, block beats unchanged — as the mock host does.
            scheduler.processBlock(timingFor(host, false, host.lastBlockStart, host.lastBlockEnd),
                                   effectivePanel(host), host.triggerMode == 1, out);
        } else if (op == "note") {
            std::string kind;
            int pitch, velocity;
            if (!(tok >> kind >> pitch >> velocity)) fail("note needs <on|off> <pitch> <velocity>");
            bool isOn = kind == "on" && velocity > 0; // NoteOn vel 0 counts as off (wrapper.js)
            scheduler.handleNote(isOn, pitch, host.triggerMode == 1);
            // Transport-mode passthrough is the adapter's concern; the mock
            // host records it as 'thru-*', which the parity test filters out.
        } else if (op == "reset") {
            scheduler.reset(out);
        } else {
            fail("unknown op: " + op);
        }
    }

    std::ostringstream json;
    json << std::setprecision(17);
    json << "{\"events\":[";
    for (size_t i = 0; i < out.size(); i++) {
        if (i > 0) json << ",";
        const auto& e = out[i];
        const char* type = e.type == sched::OutEvent::Type::On ? "on"
                          : e.type == sched::OutEvent::Type::Off ? "off" : "alloff";
        json << "{\"type\":\"" << type << "\",\"pitch\":" << e.pitch
             << ",\"velocity\":" << e.velocity << ",\"beat\":" << e.beat << "}";
    }
    json << "]}";
    std::cout << json.str() << "\n";
    return 0;
}
