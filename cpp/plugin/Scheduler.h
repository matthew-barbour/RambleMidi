// cpp/plugin/Scheduler.h — the thin, host-facing scheduler (SPEC §8), JUCE-free.
//
// Port of scripter/wrapper.js lines 68–247, preserving structure and names
// (ensureParams, flushAllNotes, sendDueNoteOffs, scheduleNote) so the two
// implementations stay diffable. All musical decisions live in the engine;
// this class asks the planner for the phrases overlapping the current block
// and turns plan events into note-on/note-off pairs — while guaranteeing
// that no note ever sticks across stop, loop, or locate.
//
// BEAT CONVENTION, READ THIS FIRST: everything here is ENGINE BEATS — 0-based
// musical beats from song start. JUCE PPQ is already 0-based, so the Scripter
// wrapper's single `- 1` conversion (wrapper.js:214-216) is DELETED here, not
// moved (SPEC §10). If you are comparing this file against wrapper.js and a
// `+ 1` / `- 1` looks missing: that is the point.
//
// This class knows nothing about JUCE, MIDI buffers, or sample rates. It
// consumes TimingInfo + a params snapshot and emits events with beat
// timestamps; the caller (PluginProcessor, or hostsim in tests) converts
// beats to sample offsets. That split is what makes SPEC M7's acceptance —
// "output matches Scripter" — testable without opening Logic.

#pragma once

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

#include "../engine/planner.h"

namespace ramble {
namespace sched {

struct TimingInfo {
    bool playing = false;
    double blockStartBeat = 0.0; // engine beats (= JUCE PPQ, 0-based)
    double blockEndBeat = 0.0;
    bool cycling = false;
    double leftCycleBeat = 0.0;  // engine beats
    double rightCycleBeat = 0.0;
};

struct OutEvent {
    enum class Type { On, Off, AllOff };
    Type type;
    int pitch;    // 0 for AllOff
    int velocity; // note-offs use 64, matching the wrapper
    double beat;  // engine beats
};

class Scheduler {
public:
    // wrapper.js HandleMIDI's note branch (§8.3). Returns true if the event
    // must be swallowed (latch mode: held keys are triggers, they don't
    // sound). Transport-mode passthrough is the caller's job — it owns the
    // MIDI buffer; this class only owns the held-key state.
    bool handleNote(bool isNoteOn, int pitch, bool latchMode) {
        if (latchMode && isNoteOn) {
            if (std::find(heldKeys.begin(), heldKeys.end(), pitch) == heldKeys.end()) {
                heldKeys.push_back(pitch);
            }
            return true;
        }
        if (latchMode && !isNoteOn) {
            auto at = std::find(heldKeys.begin(), heldKeys.end(), pitch);
            if (at != heldKeys.end()) heldKeys.erase(at);
            return true;
        }
        return false;
    }

    // wrapper.js ParameterChanged: Trigger Mode flips drop all held keys.
    void clearHeldKeys() { heldKeys.clear(); }

    // wrapper.js ProcessMIDI. `panel` is the full engine params snapshot with
    // tempo/meter already filled in from the host (the readParams contract).
    // Events are appended to `out` in emission order; equal-beat events must
    // keep that order downstream (note-off before re-triggered note-on).
    void processBlock(const TimingInfo& info, const planner::Params& panel,
                      bool latchMode, std::vector<OutEvent>& out) {
        // Process parameter changes even while stopped — no current phrase to
        // protect, so the whole plan cache goes (cutoff = -1).
        ensureParams(info, panel);

        if (!info.playing) {
            if (wasPlaying) flushAllNotes(info.blockStartBeat, out);
            wasPlaying = false;
            lastBlockEnd = -1;
            return;
        }

        wasPlaying = true;

        // wrapper.js subtracted 1 from the host beats here. JUCE PPQ is
        // 0-based: no conversion, by design (see header).
        double blockStart = info.blockStartBeat;
        double blockEnd = info.blockEndBeat;

        // Cycle jump or locate backward: the timeline went backward under us.
        // Flush everything; plans are position-deterministic so replaying the
        // loop reproduces the identical notes (§3, §8.2).
        if (lastBlockEnd >= 0 && blockStart < lastBlockEnd - 1e-6) {
            flushAllNotes(blockStart, out);
        }
        lastBlockEnd = blockEnd;

        bool generating = !latchMode || !heldKeys.empty();

        if (generating && blockEnd > 0) {
            double bpp = cachedDerived.beatsPerPhrase;
            int firstPhrase = std::max(0, static_cast<int>(std::floor(blockStart / bpp)));
            int lastPhrase = std::max(0, static_cast<int>(std::floor((blockEnd - 1e-9) / bpp)));
            for (int k = firstPhrase; k <= lastPhrase; k++) {
                planner::Plan plan = planner::plan(cachedParams, cachedDerived, k, &planCache);
                for (const auto& ev : plan.events) {
                    if (ev.beat >= blockStart && ev.beat < blockEnd) {
                        scheduleNote(ev, blockStart, out);
                    }
                }
            }
        }

        // Note-offs go out after note-ons so a note starting and ending inside
        // one block is released here, not a block late.
        double clipBeat = info.cycling
            ? info.rightCycleBeat - 0.01
            : std::numeric_limits<double>::infinity();
        sendDueNoteOffs(blockStart, blockEnd, clipBeat, out);
    }

    // wrapper.js Reset(): allNotesOff + full state clear.
    void reset(std::vector<OutEvent>& out) {
        out.push_back({OutEvent::Type::AllOff, 0, 0, lastBlockEnd >= 0 ? lastBlockEnd : 0.0});
        clearState();
    }

    // State clear without emitting anything — for prepareToPlay, where the
    // host gives us no buffer to emit into.
    void clearState() {
        activeNotes.clear();
        heldKeys.clear();
        planCache.clear();
        hasParams = false;
        lastBlockEnd = -1;
        wasPlaying = false;
    }

private:
    struct ActiveNote {
        int pitch;
        double offBeat; // engine beats
    };

    std::vector<ActiveNote> activeNotes;
    std::vector<int> heldKeys;
    planner::PlanCache planCache;
    planner::Params cachedParams;
    planner::Derived cachedDerived;
    bool hasParams = false;
    double lastBlockEnd = -1; // engine beats; -1 = no block seen since stop
    bool wasPlaying = false;

    // The wrapper's paramsDirty flag is replaced by a straight snapshot
    // comparison — the caller hands us the current panel every block, so
    // "dirty" simply means "differs from what we cached". Tempo keeps the
    // wrapper's 0.001 tolerance; everything else compares exactly.
    static bool panelEquals(const planner::Params& a, const planner::Params& b) {
        return a.root == b.root && a.scaleId == b.scaleId &&
               a.lowOctave == b.lowOctave && a.octaveSpan == b.octaveSpan &&
               a.registerFocus == b.registerFocus && a.octaveShift == b.octaveShift &&
               a.gridId == b.gridId && a.density == b.density &&
               a.noteLength == b.noteLength && a.lengthVariation == b.lengthVariation &&
               a.swing == b.swing && a.humanizeMs == b.humanizeMs &&
               a.leapAmount == b.leapAmount && a.directionHold == b.directionHold &&
               a.tonalGravity == b.tonalGravity && a.variability == b.variability &&
               a.phraseBars == b.phraseBars && a.breath == b.breath &&
               a.motifRepeat == b.motifRepeat && a.velocity == b.velocity &&
               a.velocityRange == b.velocityRange && a.accent == b.accent &&
               a.seed == b.seed &&
               a.meterNumerator == b.meterNumerator &&
               a.meterDenominator == b.meterDenominator &&
               std::fabs(a.tempo - b.tempo) < 0.001;
    }

    // §8.2: parameter changes invalidate plans for phrases that haven't
    // started; the phrase currently sounding keeps the plan it was started
    // with. Stopped transport keeps nothing.
    void ensureParams(const TimingInfo& info, const planner::Params& panel) {
        if (hasParams && panelEquals(cachedParams, panel)) return;
        cachedParams = panel;
        cachedDerived = planner::derive(panel);
        hasParams = true;
        double nowBeat = info.playing ? info.blockStartBeat : -1;
        int cutoff = nowBeat > 1e-9
            ? static_cast<int>(std::floor((nowBeat - 1e-9) / cachedDerived.beatsPerPhrase))
            : -1;
        for (auto it = planCache.begin(); it != planCache.end();) {
            if (it->first <= cutoff) ++it;
            else it = planCache.erase(it);
        }
    }

    // Immediate release of everything we started. Used on stop / cycle jump /
    // locate — §8.2's stuck-note rules. wrapper.js used off.send(), which the
    // host stamps at the current block start; `atBeat` is that same stamp.
    void flushAllNotes(double atBeat, std::vector<OutEvent>& out) {
        for (const auto& n : activeNotes) {
            out.push_back({OutEvent::Type::Off, n.pitch, 64, atBeat});
        }
        activeNotes.clear();
    }

    // Send every pending note-off due inside this block. `clipBeat` pulls
    // note-offs that would land past the cycle end back to the boundary (§8.2).
    void sendDueNoteOffs(double blockStart, double blockEnd, double clipBeat,
                         std::vector<OutEvent>& out) {
        std::vector<ActiveNote> remaining;
        for (const auto& n : activeNotes) {
            double offBeat = std::min(n.offBeat, clipBeat);
            if (offBeat < blockEnd) {
                out.push_back({OutEvent::Type::Off, n.pitch, 64, std::max(offBeat, blockStart)});
            } else {
                remaining.push_back(n);
            }
        }
        activeNotes = remaining;
    }

    void scheduleNote(const planner::Event& ev, double blockStart, std::vector<OutEvent>& out) {
        // Last-on-wins: if this pitch is still sounding (legato NoteLength >
        // 100%, or a repeated pitch), release the old instance just before the
        // new onset so on/off pairs can never interleave into a stuck note.
        for (size_t i = 0; i < activeNotes.size(); i++) {
            if (activeNotes[i].pitch == ev.pitch) {
                double oldOff = std::min(activeNotes[i].offBeat, ev.beat - 0.001);
                out.push_back({OutEvent::Type::Off, ev.pitch, 64, std::max(oldOff, blockStart)});
                activeNotes.erase(activeNotes.begin() + static_cast<long>(i));
                break;
            }
        }
        out.push_back({OutEvent::Type::On, ev.pitch, ev.velocity, ev.beat});
        activeNotes.push_back({ev.pitch, ev.beat + ev.durBeats});
    }
};

} // namespace sched
} // namespace ramble
