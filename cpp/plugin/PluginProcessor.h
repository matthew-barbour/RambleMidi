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

    // Programs = factory presets (M8). The AU wrapper publishes these as AU
    // factory presets, so the recipes appear in Logic's own preset menu.
    int getNumPrograms() override;
    int getCurrentProgram() override { return currentProgram; }
    void setCurrentProgram(int index) override;
    const juce::String getProgramName(int index) override;
    void changeProgramName(int, const juce::String&) override {} // factory presets are fixed

    // GUI path: setCurrentProgram + tell the host its preset display is stale
    // (the AU wrapper only re-reads the program on that notification).
    void applyFactoryPreset(int index);

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState& state() { return apvts; }

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
    int currentProgram = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RambleAudioProcessor)
};
