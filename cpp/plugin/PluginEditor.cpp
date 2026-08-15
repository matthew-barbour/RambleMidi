// cpp/plugin/PluginEditor.cpp — see PluginEditor.h.

#include "PluginEditor.h"

#include "PluginProcessor.h"
#include "Presets.h"

namespace {
constexpr int kWidth = 940;
constexpr int kHeight = 670;
constexpr int kMargin = 10;
constexpr int kHeaderH = 36;
constexpr int kGroupGap = 8;
constexpr int kRowGroupH = 130;  // key / rhythm / melody
constexpr int kPerfGroupH = 196; // two rows

// Equal horizontal split of `area` across `items`, skipping nulls.
void layoutRow(juce::Rectangle<int> area, std::initializer_list<juce::Component*> items) {
    const int n = static_cast<int>(items.size());
    if (n == 0) return;
    const int cell = area.getWidth() / n;
    for (auto* c : items) {
        auto r = area.removeFromLeft(cell);
        if (c != nullptr) c->setBounds(r.reduced(4, 0));
    }
}
} // namespace

RambleEditor::RambleEditor(RambleAudioProcessor& p)
    : AudioProcessorEditor(p), proc(p) {
    auto& apvts = proc.state();
    auto param = [&apvts](const char* id) -> juce::RangedAudioParameter& {
        auto* pr = apvts.getParameter(id);
        jassert(pr != nullptr); // a missing ID here is a Params.h/editor mismatch
        return *pr;
    };
    namespace id = ramble::params::id;

    // Header
    title.setText("RAMBLE", juce::dontSendNotification);
    title.setFont(juce::FontOptions(22.0f, juce::Font::bold));
    addAndMakeVisible(title);

    presetBox.setTextWhenNothingSelected("Presets" + juce::String(juce::CharPointer_UTF8("\xe2\x80\xa6")));
    for (int i = 0; i < ramble::presets::count(); i++) {
        presetBox.addItem(ramble::presets::table()[static_cast<size_t>(i)].name, i + 1);
    }
    presetBox.onChange = [this] {
        const int index = presetBox.getSelectedId() - 1;
        if (index < 0) return;
        proc.applyFactoryPreset(index);
        // Command, not state: return to the placeholder so the box never
        // claims a preset the user has since edited away from.
        presetBox.setSelectedId(0, juce::dontSendNotification);
    };
    addAndMakeVisible(presetBox);

    // Key & Register
    keyGroup.setText("KEY & REGISTER");
    root = std::make_unique<AttachedCombo>(param(id::root));
    scale = std::make_unique<AttachedCombo>(param(id::scale));
    lowOctave = std::make_unique<AttachedCombo>(param(id::lowOctave));
    octaveSpan = std::make_unique<AttachedCombo>(param(id::octaveSpan));
    registerFocus = std::make_unique<AttachedSlider>(param(id::registerFocus));
    octaveShift = std::make_unique<AttachedSlider>(param(id::octaveShift));

    // Rhythm
    rhythmGroup.setText("RHYTHM");
    grid = std::make_unique<AttachedCombo>(param(id::grid));
    density = std::make_unique<AttachedSlider>(param(id::density));
    noteLength = std::make_unique<AttachedSlider>(param(id::noteLength));
    lengthVariation = std::make_unique<AttachedSlider>(param(id::lengthVariation));
    swing = std::make_unique<AttachedSlider>(param(id::swing));
    humanize = std::make_unique<AttachedSlider>(param(id::humanize));

    // Melody
    melodyGroup.setText("MELODY");
    leapAmount = std::make_unique<AttachedSlider>(param(id::leapAmount));
    directionHold = std::make_unique<AttachedSlider>(param(id::directionHold));
    tonalGravity = std::make_unique<AttachedSlider>(param(id::tonalGravity));
    variability = std::make_unique<AttachedSlider>(param(id::variability));

    // Phrasing & Performance
    perfGroup.setText("PHRASING & PERFORMANCE");
    phraseLength = std::make_unique<AttachedCombo>(param(id::phraseLength));
    breath = std::make_unique<AttachedSlider>(param(id::breath));
    motifRepeat = std::make_unique<AttachedSlider>(param(id::motifRepeat));
    velocity = std::make_unique<AttachedSlider>(param(id::velocity));
    velocityRange = std::make_unique<AttachedSlider>(param(id::velocityRange));
    accent = std::make_unique<AttachedSlider>(param(id::accent));
    seed = std::make_unique<AttachedSlider>(param(id::seed), /*asBar=*/true); // 0-9999 on a rotary is unusable
    triggerMode = std::make_unique<AttachedCombo>(param(id::triggerMode));

    reseedButton.onClick = [this] {
        // Momentary: set the bool param; the processor's AsyncUpdater rolls
        // the Seed and releases the button (unchanged M7b path).
        if (auto* pr = proc.state().getParameter(ramble::params::id::reseed)) {
            pr->setValueNotifyingHost(1.0f);
        }
    };

    for (auto* g : {&keyGroup, &rhythmGroup, &melodyGroup, &perfGroup}) addAndMakeVisible(*g);
    for (juce::Component* c : std::initializer_list<juce::Component*>{
             root.get(), scale.get(), lowOctave.get(), octaveSpan.get(),
             registerFocus.get(), octaveShift.get(),
             grid.get(), density.get(), noteLength.get(), lengthVariation.get(), swing.get(), humanize.get(),
             leapAmount.get(), directionHold.get(), tonalGravity.get(), variability.get(),
             phraseLength.get(), breath.get(), motifRepeat.get(), velocity.get(), velocityRange.get(),
             accent.get(), seed.get(), triggerMode.get(), &reseedButton}) {
        addAndMakeVisible(*c);
    }

    setSize(kWidth, kHeight);
}

void RambleEditor::paint(juce::Graphics& g) {
    g.fillAll(getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));
}

void RambleEditor::resized() {
    auto r = getLocalBounds().reduced(kMargin);

    // Header: title left, preset command-combo right.
    auto header = r.removeFromTop(kHeaderH);
    presetBox.setBounds(header.removeFromRight(210).withSizeKeepingCentre(210, 26));
    title.setBounds(header);

    auto section = [&r](juce::GroupComponent& group, int height) {
        r.removeFromTop(kGroupGap);
        auto area = r.removeFromTop(height);
        group.setBounds(area);
        return area.reduced(12, 0).withTrimmedTop(22).withTrimmedBottom(10); // inside the frame
    };

    layoutRow(section(keyGroup, kRowGroupH),
              {root.get(), scale.get(), lowOctave.get(), octaveSpan.get(),
               registerFocus.get(), octaveShift.get()});

    layoutRow(section(rhythmGroup, kRowGroupH),
              {grid.get(), density.get(), noteLength.get(), lengthVariation.get(),
               swing.get(), humanize.get()});

    layoutRow(section(melodyGroup, kRowGroupH),
              {leapAmount.get(), directionHold.get(), tonalGravity.get(), variability.get()});

    auto perf = section(perfGroup, kPerfGroupH);
    layoutRow(perf.removeFromTop(98),
              {phraseLength.get(), breath.get(), motifRepeat.get(), velocity.get(),
               velocityRange.get(), accent.get()});
    perf.removeFromTop(8);
    auto bottom = perf.removeFromTop(46);
    seed->setBounds(bottom.removeFromLeft(420).reduced(4, 0));
    reseedButton.setBounds(bottom.removeFromLeft(110).withSizeKeepingCentre(96, 26));
    triggerMode->setBounds(bottom.removeFromLeft(200).reduced(4, 0));
}
