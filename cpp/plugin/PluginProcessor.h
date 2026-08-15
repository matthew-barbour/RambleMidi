// cpp/plugin/PluginProcessor.h — the JUCE adapter (SPEC §10, M7b).
//
// Thin by design: everything musical lives in cpp/engine/, everything
// host-shaped lives in Scheduler.h. This class only
//   - owns the APVTS (automation + state save/restore for free),
//   - translates the playhead into Scheduler::TimingInfo,
//   - translates Scheduler events into sample-offset MIDI messages,
//   - handles Transport/Latch passthrough and the Reseed button.
//
// Bus config mirrors JUCE's Arpeggiator demo: no audio buses at all. The AU
// wrapper synthesizes one silent output bus to establish the sample rate
// (juce_AU_Shared.h) — nothing is written to it.

#pragma once

#include <juce_audio_utils/juce_audio_utils.h>

#include "Params.h"
#include "Scheduler.h"

class RambleAudioProcessor : public juce::AudioProcessor,
                             private juce::AudioProcessorValueTreeState::Listener,
                             private juce::AsyncUpdater {
public:
    RambleAudioProcessor();
    ~RambleAudioProcessor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock; // un-hide the double-precision overload

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return true; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

private:
    // APVTS listener — only Reseed needs one; engine params are change-detected
    // by the Scheduler's snapshot comparison every block.
    void parameterChanged(const juce::String& parameterID, float newValue) override;
    // Reseed lands here on the message thread (setValueNotifyingHost is not
    // audio-thread-safe).
    void handleAsyncUpdate() override;

    juce::AudioProcessorValueTreeState apvts;
    ramble::params::Refs refs;
    ramble::sched::Scheduler scheduler;
    std::vector<ramble::sched::OutEvent> outEvents; // reused across blocks
    int lastTriggerMode = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RambleAudioProcessor)
};
