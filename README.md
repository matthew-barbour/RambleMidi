# Ramble — Generative Solo Engine for Logic Pro

A MIDI FX plugin that generates keyboard solos — constrained to a key and scale, with
controls for rhythm, density, melodic motion, phrasing, and randomness — and feeds them
to any Logic Pro instrument. Blues-rock / jam-band phrasing sensibility: pentatonic-leaning,
percussive, phrases that breathe and restate ideas.

The full design brief lives in [spec/SPEC.md](spec/SPEC.md). Current state: **Phase 0
complete (M0–M5)** — the musical engine plus the Logic Scripter wrapper. The JUCE `aumi`
port (M7–M8) starts after the listening pass (M6).

## Layout

```
engine/     the musical core — pure, deterministic, host-free
  prng.js      mulberry32 + hash32 (position-deterministic seeding, SPEC §3)
  scales.js    scale tables, tier weights, the degree ladder (§4)
  walk.js      weighted pitch selection (§5)
  planner.js   phrase planning: rhythm, breath, motif repetition (§6)
scripter/   wrapper.js — parameters (§7) + real-time scheduler (§8)
tools/      build.js (concatenator) · render.js (CLI) · midifile.js (SMF writer)
test/       property tests incl. a mock Scripter host driving the built bundle
dist/       Ramble.scripter.js — the paste-into-Logic artifact
```

## Use it in Logic

```bash
npm run build:copy
```

Then: instrument track → **MIDI FX slot → Scripter → Open Script in Editor** →
⌘A ⌘V → **Run Script**. Load any instrument below it, press Play. Save as a
Scripter preset to keep it. Same seed + same parameters = the same solo on
playback, freeze, and bounce.

## Render takes without Logic

```bash
node tools/render.js --seed 1138 --bars 16 --root A --scale minor-pentatonic --print
```

Prints a note grid and writes `solo.mid` containing **exactly the notes the plugin
plays** for those settings — drag it onto a Logic track to audition or to commit a
take as an editable region. Any engine parameter can be overridden
(`--density 80 --note-length 40 --variability 70 ...`); `--help` lists them all.

## Develop

```bash
npm test          # the whole property-test suite, no DAW needed
npm run build     # dist/Ramble.scripter.js
```

Engine sources run unmodified under Node (tests, CLI) and inside Scripter
(concatenated by `tools/build.js` — no modules, no bundler). Never call
`Math.random` in `engine/`; every random draw flows from
`mulberry32(hash32(seed, phraseIndex))` so that bar 33 is the same notes no
matter where playback started.
