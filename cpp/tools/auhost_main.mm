// cpp/tools/auhost_main.mm — ramble-auhost: a fake Logic for the REAL plugin.
//
// Loads the INSTALLED Ramble.component through the actual AU plumbing
// (AudioComponent instantiation, HostCallbacks for beat/tempo/transport,
// MIDI output via the legacy packet-list callback or the modern
// MIDIEventList path with MIDI 1.0/2.0 protocol negotiation) and drives it
// block by block, printing every MIDI event with block/sample position so
// note durations are measurable.
//
// This is a manual diagnostic, not part of the automated suites — it needs
// the component installed in ~/Library/Audio/Plug-Ins/Components. It exists
// because auval never drives a playing transport: the ghost-note bug (see
// Scheduler.h's PPQ jitter guard and test/scheduler-jitter.test.js) passed
// auval and both parity suites, and only reproduced under the `jitter`
// scenario's model of Logic's quantized beat clock.
//
// Usage:
//   ./build/ramble-auhost [blocks] [framesPerBlock] [sampleRate] [bpm] [scenario] [eventlist [midi2]]
//   scenario: play (default) | jitter | stopstart | prebuffer
//   e.g. the Logic ghost-note repro:  ./build/ramble-auhost 800 128 48000 110 jitter

#include <AudioToolbox/AudioToolbox.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

struct Transport {
    double ppq = 0.0;
    double bpm = 120.0;
    double sampleRate = 44100.0;
    bool playing = false;
    bool cycling = false;
    double cycleStart = 0.0, cycleEnd = 0.0;
    double sampleInTimeline = 0.0;
};

static Transport gT;
static long gBlockIndex = 0;
static long gAbsSample = 0;
static long gEventCount = 0;

static OSStatus getBeatAndTempo(void*, Float64* outBeat, Float64* outTempo) {
    if (outBeat) *outBeat = gT.ppq;
    if (outTempo) *outTempo = gT.bpm;
    return noErr;
}

static OSStatus getMusicalTime(void*, UInt32* outDeltaToNextBeat, Float32* outNum,
                               UInt32* outDen, Float64* outMeasureDownBeat) {
    if (outDeltaToNextBeat) *outDeltaToNextBeat = 0;
    if (outNum) *outNum = 4.0f;
    if (outDen) *outDen = 4;
    if (outMeasureDownBeat) *outMeasureDownBeat = std::floor(gT.ppq / 4.0) * 4.0;
    return noErr;
}

static OSStatus getTransportState(void*, Boolean* outIsPlaying, Boolean* outChanged,
                                  Float64* outSampleInTimeline, Boolean* outIsCycling,
                                  Float64* outCycleStart, Float64* outCycleEnd) {
    if (outIsPlaying) *outIsPlaying = gT.playing;
    if (outChanged) *outChanged = false;
    if (outSampleInTimeline) *outSampleInTimeline = gT.sampleInTimeline;
    if (outIsCycling) *outIsCycling = gT.cycling;
    if (outCycleStart) *outCycleStart = gT.cycleStart;
    if (outCycleEnd) *outCycleEnd = gT.cycleEnd;
    return noErr;
}

static OSStatus midiOut(void*, const AudioTimeStamp*, UInt32,
                        const struct MIDIPacketList* pktlist) {
    const MIDIPacket* pkt = &pktlist->packet[0];
    for (UInt32 i = 0; i < pktlist->numPackets; i++) {
        for (UInt16 b = 0; b + 2 < pkt->length + 1; ) {
            UInt8 status = pkt->data[b];
            UInt8 kind = status & 0xF0;
            if (kind == 0x90 || kind == 0x80) {
                UInt8 pitch = pkt->data[b + 1], vel = pkt->data[b + 2];
                const char* label = (kind == 0x80 || vel == 0) ? "OFF" : "ON ";
                std::printf("evt blk=%-5ld off=%-4d abs=%-8ld ppq=%.5f  %s %3d vel %3d\n",
                            gBlockIndex, (int)pkt->timeStamp,
                            gAbsSample + (long)pkt->timeStamp,
                            gT.ppq + (double)pkt->timeStamp * gT.bpm / 60.0 / gT.sampleRate,
                            label, pitch, vel);
                gEventCount++;
                b += 3;
            } else if (kind == 0xB0) {
                std::printf("evt blk=%-5ld off=%-4d CC %d val %d\n", gBlockIndex,
                            (int)pkt->timeStamp, pkt->data[b + 1], pkt->data[b + 2]);
                gEventCount++;
                b += 3;
            } else {
                b += 1; // skip unknown byte
            }
        }
        pkt = MIDIPacketNext(pkt);
    }
    return noErr;
}

int main(int argc, char** argv) {
    long numBlocks = argc > 1 ? std::atol(argv[1]) : 700;
    UInt32 frames = argc > 2 ? (UInt32)std::atoi(argv[2]) : 512;
    gT.sampleRate = argc > 3 ? std::atof(argv[3]) : 44100.0;
    gT.bpm = argc > 4 ? std::atof(argv[4]) : 120.0;
    std::string scenario = argc > 5 ? argv[5] : "play";

    AudioComponentDescription desc{};
    desc.componentType = kAudioUnitType_MIDIProcessor; // 'aumi'
    desc.componentSubType = 'Solo';
    desc.componentManufacturer = 'Rmbl';

    AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
    if (!comp) { std::fprintf(stderr, "Ramble aumi component not found\n"); return 1; }

    AudioUnit unit;
    OSStatus err = AudioComponentInstanceNew(comp, &unit);
    if (err != noErr) { std::fprintf(stderr, "instantiate failed: %d\n", (int)err); return 1; }

    // Output stream format (the wrapper's forced sample-rate bus): stereo float.
    AudioStreamBasicDescription fmt{};
    fmt.mSampleRate = gT.sampleRate;
    fmt.mFormatID = kAudioFormatLinearPCM;
    fmt.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
    fmt.mFramesPerPacket = 1;
    fmt.mChannelsPerFrame = 2;
    fmt.mBitsPerChannel = 32;
    fmt.mBytesPerFrame = 4;
    fmt.mBytesPerPacket = 4;
    err = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                               kAudioUnitScope_Output, 0, &fmt, sizeof(fmt));
    if (err != noErr) std::fprintf(stderr, "warn: set format: %d\n", (int)err);

    HostCallbackInfo host{};
    host.beatAndTempoProc = getBeatAndTempo;
    host.musicalTimeLocationProc = getMusicalTime;
    host.transportStateProc = getTransportState;
    err = AudioUnitSetProperty(unit, kAudioUnitProperty_HostCallbacks,
                               kAudioUnitScope_Global, 0, &host, sizeof(host));
    if (err != noErr) { std::fprintf(stderr, "host callbacks failed: %d\n", (int)err); return 1; }

    const bool useEventList = (argc > 6 && std::string(argv[6]) == "eventlist");
    if (useEventList) {
        // Register the modern MIDIEventList block — what Logic on macOS 12+
        // actually uses. Packets carry UMP words (MIDI 1.0 protocol).
        AUMIDIEventListBlock block = ^(AUEventSampleTime eventSampleTime, uint8_t cable,
                                       const struct MIDIEventList* evtList) {
            (void)cable;
            const MIDIEventPacket* pkt = &evtList->packet[0];
            std::printf("# list protocol=%d numPackets=%u\n",
                        (int)evtList->protocol, (unsigned)evtList->numPackets);
            for (UInt32 i = 0; i < evtList->numPackets; i++) {
                for (UInt32 w = 0; w < pkt->wordCount; w++) {
                    UInt32 word = pkt->words[w];
                    UInt32 mt = word >> 28;
                    if (mt == 2) { // UMP MIDI 1.0 channel voice, 1 word
                        UInt8 status = (word >> 16) & 0xFF;
                        UInt8 d1 = (word >> 8) & 0x7F, d2 = word & 0x7F;
                        UInt8 kind = status & 0xF0;
                        if (kind == 0x90 || kind == 0x80) {
                            const char* label = (kind == 0x80 || d2 == 0) ? "OFF" : "ON ";
                            std::printf("evt blk=%-5ld base=%-9lld ts=%-6u  m1 %s %3d vel %3d\n",
                                        gBlockIndex, (long long)eventSampleTime,
                                        (unsigned)pkt->timeStamp, label, d1, d2);
                            gEventCount++;
                        } else if (kind == 0xB0) {
                            std::printf("evt blk=%-5ld base=%-9lld ts=%-6u  m1 CC %d val %d\n",
                                        gBlockIndex, (long long)eventSampleTime,
                                        (unsigned)pkt->timeStamp, d1, d2);
                            gEventCount++;
                        }
                    } else if (mt == 4) { // UMP MIDI 2.0 channel voice, 2 words
                        UInt32 word2 = (w + 1 < pkt->wordCount) ? pkt->words[w + 1] : 0;
                        UInt8 status = (word >> 16) & 0xFF;
                        UInt8 kind = status & 0xF0;
                        UInt8 d1 = (word >> 8) & 0x7F;
                        UInt16 vel16 = (UInt16)(word2 >> 16);
                        if (kind == 0x90 || kind == 0x80) {
                            const char* label = kind == 0x80 ? "OFF" : "ON ";
                            std::printf("evt blk=%-5ld base=%-9lld ts=%-6u  m2 %s %3d vel16 %5u (~%d)\n",
                                        gBlockIndex, (long long)eventSampleTime,
                                        (unsigned)pkt->timeStamp, label, d1, vel16, vel16 >> 9);
                            gEventCount++;
                        }
                        w += 1;
                    }
                }
                pkt = MIDIEventPacketNext(pkt);
            }
            return (OSStatus)noErr;
        };
        // Per AudioUnitProperties.h: the host must set HostMIDIProtocol
        // BEFORE the event-list callback (and before initialize).
        SInt32 protocol = (argc > 7 && std::string(argv[7]) == "midi2")
                              ? kMIDIProtocol_2_0 : kMIDIProtocol_1_0;
        std::printf("# negotiating host protocol: MIDI %s\n", protocol == kMIDIProtocol_2_0 ? "2.0" : "1.0");
        err = AudioUnitSetProperty(unit, kAudioUnitProperty_HostMIDIProtocol,
                                   kAudioUnitScope_Global, 0, &protocol, sizeof(protocol));
        std::fprintf(stderr, "# set HostMIDIProtocol: %d\n", (int)err);
        err = AudioUnitSetProperty(unit, kAudioUnitProperty_MIDIOutputEventListCallback,
                                   kAudioUnitScope_Global, 0, &block, sizeof(block));
        if (err != noErr) { std::fprintf(stderr, "event list callback failed: %d\n", (int)err); return 1; }
        std::printf("# output path: MIDIEventList (modern, Logic-style)\n");
    } else {
        AUMIDIOutputCallbackStruct midiCb{};
        midiCb.midiOutputCallback = midiOut;
        err = AudioUnitSetProperty(unit, kAudioUnitProperty_MIDIOutputCallback,
                                   kAudioUnitScope_Global, 0, &midiCb, sizeof(midiCb));
        if (err != noErr) { std::fprintf(stderr, "midi out callback failed: %d\n", (int)err); return 1; }
        std::printf("# output path: legacy MIDIPacketList\n");
    }

    err = AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice,
                               kAudioUnitScope_Global, 0, &frames, sizeof(frames));

    err = AudioUnitInitialize(unit);
    if (err != noErr) { std::fprintf(stderr, "initialize failed: %d\n", (int)err); return 1; }

    std::vector<float> left(frames), right(frames);
    AudioBufferList* abl = (AudioBufferList*)malloc(sizeof(AudioBufferList) + sizeof(AudioBuffer));
    abl->mNumberBuffers = 2;
    abl->mBuffers[0] = {1, (UInt32)(frames * sizeof(float)), left.data()};
    abl->mBuffers[1] = {1, (UInt32)(frames * sizeof(float)), right.data()};

    const double beatsPerBlock = (double)frames * gT.bpm / 60.0 / gT.sampleRate;
    std::printf("# scenario=%s blocks=%ld frames=%u sr=%.0f bpm=%.1f beats/block=%.5f\n",
                scenario.c_str(), numBlocks, frames, gT.sampleRate, gT.bpm, beatsPerBlock);

    gT.playing = false;
    gT.ppq = 0.0;

    for (gBlockIndex = 0; gBlockIndex < numBlocks; gBlockIndex++) {
        if (scenario == "play") {
            gT.playing = true;
        } else if (scenario == "jitter") {
            // Logic's quantized beat clock, as observed in a real session:
            // per-block increments rounded to 1/1024 beat (drifts ~-6e-6/blk
            // vs true), resyncing to the true position every 8 blocks.
            gT.playing = true;
            static double reported = 0.0;
            const double truePpq = (double)gBlockIndex * beatsPerBlock;
            const double incQ = std::round(beatsPerBlock * 1024.0) / 1024.0;
            if (gBlockIndex == 0 || gBlockIndex % 8 == 0) reported = truePpq;
            else reported += incQ;
            gT.ppq = reported;
        } else if (scenario == "stopstart") {
            // stopped for 20 blocks, play 200, stop 20, play again from bar 3
            if (gBlockIndex < 20) { gT.playing = false; gT.ppq = 0; }
            else if (gBlockIndex < 220) { gT.playing = true; }
            else if (gBlockIndex < 240) { gT.playing = false; }
            else if (gBlockIndex == 240) { gT.playing = true; gT.ppq = 8.0; }
            else { gT.playing = true; }
        } else if (scenario == "prebuffer") {
            // Logic-style: renders a few blocks at the same start position
            // (isPlaying already true) before the timeline actually advances.
            gT.playing = true;
            if (gBlockIndex < 4) gT.ppq = 0.0; // frozen position, 4 blocks
        }

        for (UInt32 i = 0; i < frames; i++) { left[i] = right[i] = 0; }
        abl->mBuffers[0].mData = left.data();
        abl->mBuffers[1].mData = right.data();
        abl->mBuffers[0].mDataByteSize = frames * sizeof(float);
        abl->mBuffers[1].mDataByteSize = frames * sizeof(float);

        AudioTimeStamp ts{};
        ts.mSampleTime = (double)gAbsSample;
        ts.mFlags = kAudioTimeStampSampleTimeValid;
        AudioUnitRenderActionFlags flags = 0;

        err = AudioUnitRender(unit, &flags, &ts, 0, frames, abl);
        if (err != noErr) { std::fprintf(stderr, "render %ld failed: %d\n", gBlockIndex, (int)err); return 1; }

        bool advance = gT.playing && scenario != "jitter"; // jitter sets ppq itself
        if (scenario == "prebuffer" && gBlockIndex < 3) advance = false; // frozen
        if (advance) {
            gT.ppq += beatsPerBlock;
            gT.sampleInTimeline += frames;
        }
        gAbsSample += frames;
    }

    std::printf("# total events: %ld\n", gEventCount);
    AudioUnitUninitialize(unit);
    AudioComponentInstanceDispose(unit);
    free(abl);
    return 0;
}
