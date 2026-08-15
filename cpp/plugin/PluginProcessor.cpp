// cpp/plugin/PluginProcessor.cpp — see PluginProcessor.h.

#include "PluginProcessor.h"

RambleAudioProcessor::RambleAudioProcessor()
    : AudioProcessor(BusesProperties()), // a MIDI effect adds no audio buses at all
      apvts(*this, nullptr, "Ramble", ramble::params::createParameterLayout()) {
    refs.attach(apvts);
    apvts.addParameterListener(ramble::params::id::reseed, this);
}

RambleAudioProcessor::~RambleAudioProcessor() {
    apvts.removeParameterListener(ramble::params::id::reseed, this);
    cancelPendingUpdate();
}

void RambleAudioProcessor::prepareToPlay(double, int) {
    scheduler.clearState();
}

void RambleAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const double sampleRate = getSampleRate();
    if (numSamples <= 0 || sampleRate <= 0) return;

    // ── playhead → TimingInfo. auval probes with no transport at all; every
    // field falls back to a safe default (stopped, 120 bpm, 4/4).
    ramble::sched::TimingInfo info;
    double bpm = 120.0;
    int meterNum = 4, meterDen = 4;
    if (auto* playHead = getPlayHead()) {
        if (auto pos = playHead->getPosition()) {
            info.playing = pos->getIsPlaying();
            if (auto ppq = pos->getPpqPosition()) info.blockStartBeat = *ppq; // 0-based, no conversion (SPEC §10)
            if (auto hostBpm = pos->getBpm()) bpm = *hostBpm;
            if (auto sig = pos->getTimeSignature()) {
                meterNum = sig->numerator;
                meterDen = sig->denominator;
            }
            if (pos->getIsLooping()) {
                if (auto loop = pos->getLoopPoints()) {
                    info.cycling = true;
                    info.leftCycleBeat = loop->ppqStart;
                    info.rightCycleBeat = loop->ppqEnd;
                }
            }
        }
    }
    if (bpm <= 0) bpm = 120.0;
    const double beatsPerSample = bpm / 60.0 / sampleRate;
    info.blockEndBeat = info.blockStartBeat + numSamples * beatsPerSample;

    // ── Trigger Mode + incoming MIDI (§8.3). Latch: note on/offs are triggers
    // and are swallowed; Transport: everything passes through. Non-note events
    // always pass.
    const bool latch = refs.triggerMode->load() >= 0.5f;
    if ((latch ? 1 : 0) != lastTriggerMode) {
        scheduler.clearHeldKeys(); // wrapper.js ParameterChanged on Trigger Mode
        lastTriggerMode = latch ? 1 : 0;
    }

    juce::MidiBuffer passthrough;
    for (const auto metadata : midi) {
        const auto msg = metadata.getMessage();
        bool swallowed = false;
        // isNoteOn() is false for velocity-0 note-ons; isNoteOff(true) catches
        // them — the same NoteOn-velocity-0-is-off rule as the wrapper.
        if (msg.isNoteOn() || msg.isNoteOff()) {
            swallowed = scheduler.handleNote(msg.isNoteOn(), msg.getNoteNumber(), latch);
        }
        if (!swallowed) passthrough.addEvent(msg, metadata.samplePosition);
    }
    midi.swapWith(passthrough);

    // ── generate. Params snapshot every block; the scheduler's own comparison
    // decides whether anything actually changed (§8.2 invalidation).
    const ramble::planner::Params panel = ramble::params::read(refs, bpm, meterNum, meterDen);
    outEvents.clear();
    scheduler.processBlock(info, panel, latch, outEvents);

    // ── events → sample-offset MIDI. Offsets must land strictly inside the
    // block: the AU wrapper asserts isPositiveAndBelow(offset, numSamples).
    for (const auto& e : outEvents) {
        const int offset = juce::jlimit(0, numSamples - 1,
            static_cast<int>(std::llround((e.beat - info.blockStartBeat) / beatsPerSample)));
        switch (e.type) {
            case ramble::sched::OutEvent::Type::On:
                midi.addEvent(juce::MidiMessage::noteOn(1, e.pitch, static_cast<juce::uint8>(e.velocity)), offset);
                break;
            case ramble::sched::OutEvent::Type::Off:
                midi.addEvent(juce::MidiMessage::noteOff(1, e.pitch, static_cast<juce::uint8>(e.velocity)), offset);
                break;
            case ramble::sched::OutEvent::Type::AllOff:
                midi.addEvent(juce::MidiMessage::allNotesOff(1), offset);
                break;
        }
    }
    // The audio buffer has zero channels; nothing to write.
}

juce::AudioProcessorEditor* RambleAudioProcessor::createEditor() {
    return new juce::GenericAudioProcessorEditor(*this); // real panel is M8
}

void RambleAudioProcessor::getStateInformation(juce::MemoryBlock& destData) {
    if (auto xml = apvts.copyState().createXml()) copyXmlToBinary(*xml, destData);
}

void RambleAudioProcessor::setStateInformation(const void* data, int sizeInBytes) {
    if (auto xml = getXmlFromBinary(data, sizeInBytes)) {
        if (xml->hasTagName(apvts.state.getType())) {
            apvts.replaceState(juce::ValueTree::fromXml(*xml));
        }
    }
}

void RambleAudioProcessor::parameterChanged(const juce::String& parameterID, float newValue) {
    if (parameterID == ramble::params::id::reseed && newValue > 0.5f) {
        triggerAsyncUpdate(); // hop to the message thread
    }
}

void RambleAudioProcessor::handleAsyncUpdate() {
    // Wrapper-side UI action (wrapper.js Reseed). Not part of the engine, so
    // the engine's PRNG ban stays absolute — wall-clock time is randomness
    // enough for a button.
    const auto newSeed = static_cast<float>(juce::Time::getMillisecondCounter() % 10000);
    if (auto* seed = apvts.getParameter(ramble::params::id::seed)) {
        seed->beginChangeGesture();
        seed->setValueNotifyingHost(seed->getNormalisableRange().convertTo0to1(newSeed));
        seed->endChangeGesture();
    }
    if (auto* reseed = apvts.getParameter(ramble::params::id::reseed)) {
        reseed->beginChangeGesture();
        reseed->setValueNotifyingHost(0.0f); // release the momentary button
        reseed->endChangeGesture();
    }
}

// JUCE plugin entry point.
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new RambleAudioProcessor();
}
