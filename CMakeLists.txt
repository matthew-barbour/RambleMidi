# Ramble — Phase 1 JUCE port (SPEC §10).
#
# M7a: engine + parity CLI only. juce_add_plugin(...) and the AU target land
# in M7b once cpp/engine is proven to match engine/*.js bit-for-bit on the
# integer fields (see spec/SPEC.md §10 CMake block for the eventual plugin
# target). JUCE is already added as a subdirectory so its build machinery is
# exercised now, even though nothing links against it yet.

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
