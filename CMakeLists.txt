# Ramble — Phase 1 JUCE port (SPEC §10).
#
# Targets: ramble-render (M7a engine parity CLI), ramble-hostsim (M7b
# scheduler parity harness), Ramble (the aumi AU MIDI FX .component).

cmake_minimum_required(VERSION 3.22)
project(Ramble VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_subdirectory(JUCE)

add_library(ramble_engine INTERFACE)
target_include_directories(ramble_engine INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/cpp/engine)
target_compile_features(ramble_engine INTERFACE cxx_std_17)

add_executable(ramble-render cpp/tools/render_main.cpp)
target_link_libraries(ramble-render PRIVATE ramble_engine)

# M7b scheduler parity harness — drives cpp/plugin/Scheduler.h through scripted
# host sessions; test/scheduler-parity.test.js diffs it against the Scripter
# bundle running in the mock host.
add_executable(ramble-hostsim cpp/tools/hostsim_main.cpp)
target_link_libraries(ramble-hostsim PRIVATE ramble_engine)

# The plugin (SPEC §10). AU MIDI FX: type aumi, manufacturer Rmbl, code Solo.
# IS_MIDI_EFFECT alone implies kAudioUnitType_MIDIProcessor in JUCE 8; the
# explicit AU_MAIN_TYPE is belt + suspenders, because a wrong type is the #1
# way this build fails (plugin silently absent from Logic's MIDI FX menu).
juce_add_plugin(Ramble
    FORMATS AU
    IS_MIDI_EFFECT TRUE
    AU_MAIN_TYPE kAudioUnitType_MIDIProcessor
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    IS_SYNTH FALSE
    PLUGIN_MANUFACTURER_CODE Rmbl
    PLUGIN_CODE Solo
    COMPANY_NAME "Ramble"
    BUNDLE_ID com.ramble.ramble
    PRODUCT_NAME "Ramble"
    COPY_PLUGIN_AFTER_BUILD TRUE)  # → ~/Library/Audio/Plug-Ins/Components

target_sources(Ramble PRIVATE cpp/plugin/PluginProcessor.cpp)

# macOS stamps com.apple.FinderInfo/provenance xattrs onto the fresh bundle,
# which makes codesign refuse the ad-hoc re-sign ("resource fork, Finder
# information, or similar detritus not allowed") and would leave an invalidly
# signed component for Logic to reject at scan time. Strip and re-sign both
# the build artefact and the installed copy; this runs after JUCE's own
# post-build sign + copy steps because it is added later in the file.
add_custom_command(TARGET Ramble_AU POST_BUILD
    COMMAND xattr -cr "$<TARGET_BUNDLE_DIR:Ramble_AU>"
    COMMAND codesign -f -s - "$<TARGET_BUNDLE_DIR:Ramble_AU>"
    COMMAND xattr -cr "$ENV{HOME}/Library/Audio/Plug-Ins/Components/Ramble.component"
    COMMAND codesign -f -s - "$ENV{HOME}/Library/Audio/Plug-Ins/Components/Ramble.component"
    COMMENT "Ramble AU: stripping xattr detritus and re-applying ad-hoc signature"
    VERBATIM)
target_compile_definitions(Ramble PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0)
target_link_libraries(Ramble
    PRIVATE
        ramble_engine
        juce::juce_audio_utils
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)
