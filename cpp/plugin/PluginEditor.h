// cpp/plugin/PluginEditor.h — the four-section panel (SPEC §10 GUI, M8).
//
// Key & Register / Rhythm / Melody / Phrasing & Performance, exactly the §7
// grouping the Scripter panel renders as text dividers — here as real
// sections readable at a glance. Rotary sliders + combo boxes, every control
// bound through the standalone ParameterAttachment family (the
// AttachedSlider/AttachedCombo wrapper pattern from JUCE's
// DSPModulePluginDemo): no manual value plumbing anywhere.
//
// No custom look-and-feel in v1 — correctness and layout first (SPEC §10).
// The preset ComboBox is a COMMAND, not a state display: choosing an entry
// applies that factory preset and the box returns to its placeholder.
// Logic's own plugin header shows the current program.

#pragma once

#include <juce_audio_utils/juce_audio_utils.h>

#include "Params.h"

class RambleAudioProcessor;

class RambleEditor : public juce::AudioProcessorEditor {
public:
    explicit RambleEditor(RambleAudioProcessor&);

    void paint(juce::Graphics&) override;
    void resized() override;

private:
    // Rotary (or bar) slider with its parameter name above and value below.
    struct AttachedSlider : juce::Component {
        AttachedSlider(juce::RangedAudioParameter& param, bool asBar = false)
            : label({}, param.getName(32)), attachment(param, slider) {
            addAndMakeVisible(slider);
            addAndMakeVisible(label);
            if (asBar) {
                slider.setSliderStyle(juce::Slider::LinearBar);
            } else {
                slider.setSliderStyle(juce::Slider::RotaryVerticalDrag);
                slider.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 60, 16);
            }
            label.setJustificationType(juce::Justification::centred);
            label.setFont(juce::FontOptions(12.0f));
            label.setInterceptsMouseClicks(false, false);
        }
        void resized() override {
            auto r = getLocalBounds();
            label.setBounds(r.removeFromTop(14));
            if (slider.getSliderStyle() == juce::Slider::LinearBar) {
                slider.setBounds(r.withSizeKeepingCentre(r.getWidth(), 24));
            } else {
                slider.setBounds(r);
            }
        }
        juce::Slider slider;
        juce::Label label;
        juce::SliderParameterAttachment attachment;
    };

    // ComboBox with its parameter name above, vertically centered.
    struct AttachedCombo : juce::Component {
        explicit AttachedCombo(juce::RangedAudioParameter& param)
            : label({}, param.getName(32)) {
            addAndMakeVisible(combo);
            addAndMakeVisible(label);
            label.setJustificationType(juce::Justification::centred);
            label.setFont(juce::FontOptions(12.0f));
            label.setInterceptsMouseClicks(false, false);
            // Items must exist BEFORE the attachment is constructed, or the
            // attachment cannot map parameter values onto item IDs.
            if (auto* choice = dynamic_cast<juce::AudioParameterChoice*>(&param)) {
                combo.addItemList(choice->choices, 1);
            }
            attachment = std::make_unique<juce::ComboBoxParameterAttachment>(param, combo);
        }
        void resized() override {
            auto r = getLocalBounds();
            label.setBounds(r.removeFromTop(14));
            combo.setBounds(r.withSizeKeepingCentre(juce::jmin(r.getWidth(), 150), 24));
        }
        juce::ComboBox combo;
        juce::Label label;
        std::unique_ptr<juce::ComboBoxParameterAttachment> attachment;
    };

    RambleAudioProcessor& proc;

    juce::Label title;
    juce::ComboBox presetBox;
    juce::GroupComponent keyGroup, rhythmGroup, melodyGroup, perfGroup;

    // Key & Register
    std::unique_ptr<AttachedCombo> root, scale, lowOctave, octaveSpan;
    std::unique_ptr<AttachedSlider> registerFocus, octaveShift;
    // Rhythm
    std::unique_ptr<AttachedCombo> grid;
    std::unique_ptr<AttachedSlider> density, noteLength, lengthVariation, swing, humanize;
    // Melody
    std::unique_ptr<AttachedSlider> leapAmount, directionHold, tonalGravity, variability;
    // Phrasing & Performance
    std::unique_ptr<AttachedCombo> phraseLength, triggerMode;
    std::unique_ptr<AttachedSlider> breath, motifRepeat, velocity, velocityRange, accent, seed;
    juce::TextButton reseedButton{"Reseed"};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RambleEditor)
};
