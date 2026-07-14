# Ramble — Generative Solo Engine for Logic Pro

**An AU MIDI FX plugin (`aumi`) that generates keyboard solos in a chosen key and feeds them to any Logic Pro instrument.**

---

## 0. How to use this document

This is the project brief for Claude Code. Read Sections 1–3 before writing any code — they contain the two decisions that most implementations of this idea get wrong, and Section 5 exists specifically to prevent the "random notes in a scale" failure mode.

Work milestone by milestone (Section 11). Do not skip ahead to the plugin wrapper; the musical engine must be correct and testable *before* it touches Logic.

**Appendix A** covers prerequisites, cost, and the day-to-day development loop. Read it before setting up the repo — in particular, Phase 0 requires no Xcode, no CMake, and no JUCE.

---

## 1. Scope and non-goals

### What this is

A plugin that **generates MIDI notes** — a solo line — constrained to a selected key and scale, with controls for rhythm, density, note length, melodic motion, phrasing, and randomness. It sits in Logic Pro's **MIDI FX slot** and sends its notes downstream to whatever instrument is loaded on that channel strip (Vintage Electric Piano, Alchemy, Studio Piano, anything). Every Logic keyboard tone remains available exactly as on a normal instrument track.

### What this is explicitly **not**

| Not this | Why |
|---|---|
| **An ARA plugin** | ARA (Audio Random Access) is an open Celemony/PreSonus standard (Apache 2.0) that gives *audio effect* plugins random access to the host's audio timeline — Melodyne, SpectraLayers. In Logic it only loads into the first **Audio Effect** slot on an **audio** track. A note generator has no host audio to access. ARA is structurally inapplicable here. Do not pull in the ARA SDK. |
| **A software synthesizer** (`aumu`) | We are not writing DSP. We generate no audio. The sound comes from Logic's instruments. Writing oscillators and filters here would be building the wrong half of the product. |
| **A cross-DAW plugin** | AU MIDI FX (`aumi`) is a Logic / GarageBand / MainStage format. Most other DAWs ignore the type entirely. This is acceptable and intentional. Do not add VST3/CLAP targets in v1. |
| **A uniform random note picker** | See Section 5. Sampling uniformly from a scale produces noise, not a solo. The weighted model in Section 5 is the core of the product. |

### Target user

Solo developer/musician on Apple Silicon macOS, Logic Pro. Blues-rock / jam-band phrasing sensibility (think Garcia, Anastasio): pentatonic-leaning, percussive, staccato, phrases that breathe and repeat ideas rather than run continuously.

---

## 2. Format decision

**Audio Unit type `aumi` — `kAudioUnitType_MIDIProcessor`.**

- Loads into Logic's **MIDI FX** slot (top of the instrument channel strip, above the Instrument slot — same slot as Arpeggiator, Chord Trigger, Scripter).
- Receives MIDI in, sends MIDI out, processes no audio.
- Signal chain: `Ramble (MIDI FX) → Logic Instrument → audio`.

---

## 3. Architecture: the planner/scheduler split

This is the single most important structural decision in the project. **Follow it.**

```
                 ┌──────────────────────────────────┐
                 │  PhrasePlanner  (pure function)  │
                 │                                  │
   params  ────► │  plan(phraseIndex, params)       │ ────► [ {beat, pitch, vel, durBeats}, ... ]
   seed    ────► │                                  │
                 │  - no host, no MIDI, no timers   │
                 │  - deterministic                 │
                 └──────────────────────────────────┘
                                  │
                                  ▼
                 ┌──────────────────────────────────┐
                 │  Scheduler  (thin, host-facing)  │
                 │                                  │
                 │  - asks planner for the phrases  │
                 │    overlapping this block        │
                 │  - emits note-on/note-off        │
                 │  - handles transport, cycling,   │
                 │    stuck notes                    │
                 └──────────────────────────────────┘
```

### Why this split matters

1. **The planner is testable outside Logic.** Claude Code can develop and iterate on the entire musical engine in a Node harness — printing note grids, running property tests, rendering `.mid` files — with no DAW, no Xcode, no human clicking Play.
2. **The planner ports to C++ nearly line-for-line.** Phase 1 (JUCE) reuses the same algorithm; only the scheduler is rewritten.
3. **It makes generation position-deterministic** (see below), which is what makes the plugin usable rather than a toy.

### Position-deterministic generation (critical)

Each phrase's random number generator is seeded from the **global seed and the phrase's index in the timeline**:

```
phraseIndex = floor((beat - 1) / beatsPerPhrase)      // Scripter beats are 1-based
prng        = mulberry32( hash32(globalSeed, phraseIndex) )
```

Consequences, all of them desirable:

- **Bar 33 always generates the same notes**, whether you started playback from bar 1 or dropped in at bar 32.
- **Playback, freeze, and bounce all produce the identical solo.** Without this, you generate a take you love, bounce it, and get a different one. This is the difference between a usable tool and a novelty.
- Phrases can be planned lazily and cached; cold-starting mid-song requires planning at most 3 phrases (see motif chain cap, §6.3).

Use a seeded PRNG (`mulberry32` or `xorshift32`). **Never call `Math.random()` anywhere in the planner.**

### Bounce compatibility — no JUCE required

Both real-time and offline (faster-than-real-time) bounce work correctly with the **Phase 0 Scripter build**, for the same reason bounce works at all: a bounce plays the project transport start-to-finish and records whatever comes out the output bus. Ramble generates MIDI into a Logic instrument; the instrument produces audio; the bounce captures that audio like it would capture a human playing the keyboard live. The MIDI FX plugin's format — Scripter script vs. JUCE `.component` — is irrelevant to bouncing.

Offline bounce specifically relies on the plugin processing against the **DAW's internal transport position rather than the wall clock**, which is exactly how `GetTimingInfo()`/`ProcessMIDI()` already work (§8.1). Nothing in Phase 0 needs to change for this to work — it has been true since M5.

This means **capturing a finished take has never required Phase 1.** Bounce is a complete alternative to both the §9.5.2 Print Settings workaround and the §10 drag-to-DAW feature — slower to iterate with (no scrubbing back to "that one good phrase" without re-bouncing), but it needs nothing beyond what you already have running.

---

## 4. Musical model: key, scale, register

### Scales (semitone offsets from root)

| Scale | Offsets | Stable (weight 1.0) | Color (0.6) | Passing (0.25) |
|---|---|---|---|---|
| Major (Ionian) | 0 2 4 5 7 9 11 | 0, 4, 7 | 2, 9 | 5, 11 |
| Natural Minor (Aeolian) | 0 2 3 5 7 8 10 | 0, 3, 7 | 2, 10 | 5, 8 |
| Harmonic Minor | 0 2 3 5 7 8 11 | 0, 3, 7 | 2, 11 | 5, 8 |
| Dorian | 0 2 3 5 7 9 10 | 0, 3, 7 | 9, 10 | 2, 5 |
| Mixolydian | 0 2 4 5 7 9 10 | 0, 4, 7 | 9, 10 | 2, 5 |
| Major Pentatonic | 0 2 4 7 9 | 0, 4, 7 | 2, 9 | — |
| Minor Pentatonic | 0 3 5 7 10 | 0, 3, 7 | 5, 10 | — |
| Blues | 0 3 5 6 7 10 | 0, 3, 7 | 5, 10 | 6 |

The **♭5 in Blues (offset 6) is a passing tone by design.** It gets the lowest tier weight and must be additionally penalized as a phrase-final note (multiply its weight by 0.1 when `metricStrength == 1.0`). Landing a phrase on the blue note sounds like a mistake, because it is one.

### Register — how the octaves get chosen

Register is set by two menus, **Low Octave** and **Octave Span** (§7). They derive the two integers the engine actually consumes:

```
lowNote  = 12 * (lowOctave + 2)              // Logic convention: C3 = MIDI 60
highNote = min(lowNote + 12 * span, 108)     // clamp at C7
```

Octaves rather than raw note numbers, for two reasons. **Musically**, register is how a player thinks — "put the solo between C3 and C5," not "between 60 and 84." **Practically**, Scripter's `"lin"` sliders have no custom value formatter: a note-number slider displays `60`, and there is no way to make it read `C3`. Menu parameters take `valueStrings`, so octave menus render as real note names.

The planner's contract does not change: it still receives `lowNote` and `highNote` as plain integers. The octave menus merely *derive* them, in the wrapper. If semitone-precise trim is ever wanted, that's two extra parameters and zero changes to the engine.

### The degree ladder

Flatten the scale across the register into a single ascending array of MIDI pitches:

```
ladder          = [ p : lowNote ≤ p ≤ highNote  and  (p - root) mod 12 ∈ scaleOffsets ]
degreesPerOctave = scaleOffsets.length      // 5 pentatonic, 6 blues, 7 diatonic
```

Melodic motion operates on **indices into this ladder**, not on semitones. Moving ±1 in the ladder is one scale step regardless of whether that's a whole or half step. This is what makes leaps and steps musically meaningful.

Two consequences worth stating plainly: **the walk cannot leave the register, and it cannot leave the key.** It is structurally incapable of selecting a pitch that isn't in the ladder. Neither constraint is enforced by clamping after the fact — there is nothing to clamp.

`degreesPerOctave` is how many ladder steps make an octave. §5.5 and §6.4 both need it.

---

## 5. Melodic engine: weighted walk, not random choice

For each note, compute a weight for **every candidate pitch in the ladder**, then sample. Five factors multiply together, and a single temperature parameter controls how sharply the resulting distribution peaks.

Let `i` = candidate ladder index, `prev` = previous note's ladder index, `d = |i - prev|` (in scale steps).

### 5.1 Proximity — prefer stepwise motion

```
leap       = LeapAmount / 100            // 0..1
proximity  = exp( -d / (0.8 + 2.2 * leap) )
```

At `leap = 0` the walk is tightly stepwise. At `leap = 1`, intervals of a 4th or 5th become viable.

### 5.2 Direction — momentum creates runs

Track `lastDirection ∈ {-1, 0, +1}`.

```
hold = DirectionHold / 100
dir  = 1.0 + 2.0 * hold          if sign(i - prev) == lastDirection
     = max(0.1, 1.0 - 0.8*hold)  if it reverses
     = 1.0                       if i == prev
```

**Edge reflection:** if `prev` is within 2 steps of either end of the ladder, flip `lastDirection` inward *before* computing weights. Do not clamp — clamping causes the line to stutter against the ceiling.

### 5.3 Tonal gravity — where the line wants to land

Every ladder pitch has a tier weight from the table in §4. Metric position determines how strongly gravity applies:

```
metricStrength m:
  bar downbeat ............ 1.0
  other quarter-note beat .. 0.7
  eighth-note offbeat ...... 0.4
  finer subdivisions ....... 0.2
  final note of a phrase ... 1.0   (forced)

g       = TonalGravity / 100
gravity = tierWeight ^ ( g * (0.5 + 1.5 * m) )
```

When `g = 0` the exponent is 0, every gravity term is 1.0, and tonal pull vanishes entirely. When `g = 1` on a downbeat, the exponent is 2.0 and chord tones dominate hard. This is what makes the output sound like it's *in* a key rather than merely *using the notes of* a key.

### 5.4 Repetition penalty

```
repeat = 0.15   if pitch(i) == pitch(prev)
       = 0.05   if it would be the 3rd consecutive identical pitch
       = 1.0    otherwise
```

### 5.5 Register focus — where inside the range the line actually lives

Choosing a range is not the same as knowing what to do inside it. Hand the walk three octaves with no register weighting and it will wander across all three aimlessly. Real players have a home register and leave it on purpose.

A Gaussian pull toward the phrase's center index:

```
focus    = RegisterFocus / 100
center   = ladderCenter + phraseOctaveShift              // shift comes from §6.4
spread   = max(1, ladderLength * (0.60 - 0.50 * focus))
register = exp( -0.5 * ((i - center) / spread)^2 )
```

At `focus = 0` the curve is nearly flat and the whole range is fair game. At `focus = 100` the line hugs its center octave and reaches for the extremes only when the other weights insist. The default of 40 produces a line with a home that still moves.

### 5.6 Variability = softmax temperature

The "variability of notes" control is a **temperature over the combined weights** — one knob, one coherent meaning.

```
score = proximity * dir * gravity * repeat * register
T     = 0.15 + (Variability / 100) * 1.85      // 0.15 .. 2.00
p(i)  ∝ score ^ (1 / T)
```

- `Variability = 0` → exponent ≈ 6.7 → near-deterministic. Predictable, stepwise, resolves constantly. Almost a written line.
- `Variability = 50` → exponent = 1 → the model as designed.
- `Variability = 100` → exponent = 0.5 → weights flatten toward uniform. Chaotic, but still in key and still bounded by the register.

Normalize `p` and sample with the phrase PRNG.

---

## 6. Rhythm, phrasing, motif

### 6.1 Grid and swing

```
beatsPerBar = meterNumerator * (4 / meterDenominator)
gridBeats:  1/4 = 1.0   1/8 = 0.5   1/8T = 1/3
            1/16 = 0.25  1/16T = 1/6  1/32 = 0.125
```

Swing, applied to **odd-indexed slots only, and only on non-triplet grids**:

```
s      = Swing / 100                      // 0.50 = straight, 0.667 = triplet feel
offset = (2*s - 1) * gridBeats
```

### 6.2 Two-pass phrase construction

Plan rhythm **before** pitch. The pitch layer needs to know which slot is the phrase's last note so it can apply maximum gravity there.

**Pass 1 — rhythm.** For each grid slot in the phrase:

- Slots inside the **breath zone** (the trailing `Breath%` of the phrase's final bar) are forced rests. This is what makes phrases breathe instead of running on forever.
- Otherwise, the slot sounds if `prng() < Density/100`.
- Record the index of the last sounding slot.

**Pass 2 — pitch, velocity, duration.** Walk the sounding slots in order:

```
pitch    = weighted sample (§5), with m = 1.0 on the final slot
velocity = clamp( Velocity + Accent*m + prng_range(±VelocityRange/2), 1, 127 )
duration = gridBeats * (NoteLength/100) * (1 + prng_range(±LengthVariation/200))
           clamped to a minimum of 0.02 beats
timing   = slotBeat + swingOffset + humanizeJitter
```

`humanizeJitter` is `±Humanize` milliseconds converted to beats at the current tempo. **Guard it:** a note must never be scheduled before its phrase start, or before the current block start — a negative offset there means scheduling into the past, which Logic silently drops.

`NoteLength` above 100% deliberately allows overlapping notes (legato / pseudo-portamento). Below ~50% gives the percussive, staccato attack this project is aiming for. Default is 50.

### 6.3 Motif repetition

The largest single contributor to "this sounds intentional." With probability `MotifRepeat/100`, a phrase **reuses the previous phrase's rhythm and contour** instead of generating fresh:

- Copy the previous plan's `(slotOffset, ladderInterval, durationBeats)` sequence.
- Transpose the whole contour by an offset drawn from `{0, -2, -1, +1, +2, -degreesPerOctave, +degreesPerOctave}` — scale steps, or a whole octave. The octave options only fire if the transposed contour still fits inside the ladder.
- **Re-humanize velocities and micro-timing** — a bit-identical copy sounds like a loop, not a restatement.

**The octave restatement is the payoff.** A figure repeated an octave up is one of the most recognizable devices in improvised soloing — Garcia and Anastasio both live on it. Motif Repeat (§6.3) and Octave Shift (§6.4) were designed to compose: when both fire on the same phrase, you get exactly that gesture, for free.

**Chain cap:** a repeat may not repeat a repeat more than **2 deep**. At depth 3, force fresh generation. This bounds the recursion so cold-starting at bar 200 never plans more than 3 phrases.

### 6.4 Octave shift — relocating the phrase

Decided **once per phrase**, from the phrase PRNG, before any notes are planned:

```
if OctaveSpan == 1:
    phraseOctaveShift = 0                      // nowhere to go
else if prng() < OctaveShift/100:
    phraseOctaveShift = ±degreesPerOctave      // one octave, in ladder steps
    clamp(ladderCenter + phraseOctaveShift) into [0, ladderLength - 1]
else:
    phraseOctaveShift = 0
```

Note what this does *not* do: it does not transpose notes after the fact, and it does not clamp anything into range. It moves the **center that the §5.5 Gaussian pulls toward**, and the existing weights do the rest. The line simply decides to live somewhere else for a phrase. Note-level motion is untouched.

Default 20% — roughly one phrase in five relocates. Often enough to read as a device, rare enough to stay one.

---

## 7. Parameters

Manufacturer/plugin codes: 4 characters each, and the **manufacturer code must not be all-lowercase** (all-lowercase is reserved by Apple). Suggested: manufacturer `Rmbl`, plugin `Solo`.

| # | Name | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| **KEY & REGISTER** |
| 1 | Root | menu | C … B (12) | C | |
| 2 | Scale | menu | 8 scales (§4) | Minor Pentatonic | |
| 3 | Low Octave | menu | C1, C2, C3, C4, C5 | C3 | bottom of the register |
| 4 | Octave Span | menu | 1, 2, 3, 4 octaves | 2 | so the default range is C3–C5 |
| 5 | Register Focus | lin | 0–100 % | 40 | §5.5 — how tightly the line hugs its home octave |
| 6 | Octave Shift | lin | 0–100 % | 20 | §6.4 — chance a phrase relocates by an octave |
| **RHYTHM** |
| 7 | Grid | menu | 1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32 | 1/8 | |
| 8 | Density | lin | 0–100 % | 70 | probability a slot sounds — this is your "number of notes" |
| 9 | Note Length | lin | 5–150 % | 50 | gate as % of grid step |
| 10 | Length Variation | lin | 0–100 % | 15 | |
| 11 | Swing | lin | 50–75 % | 50 | |
| 12 | Humanize | lin | 0–30 ms | 6 | |
| **MELODY** |
| 13 | Leap Amount | lin | 0–100 % | 25 | §5.1 |
| 14 | Direction Hold | lin | 0–100 % | 70 | §5.2 |
| 15 | Tonal Gravity | lin | 0–100 % | 60 | §5.3 |
| 16 | Variability | lin | 0–100 % | 50 | §5.6 — softmax temperature |
| **PHRASING** |
| 17 | Phrase Length | menu | 1, 2, 4, 8 bars | 2 | |
| 18 | Breath | lin | 0–100 % | 25 | silent tail of the phrase's last bar |
| 19 | Motif Repeat | lin | 0–100 % | 40 | §6.3 |
| **PERFORMANCE** |
| 20 | Velocity | lin | 1–127 | 90 | |
| 21 | Velocity Range | lin | 0–64 | 20 | |
| 22 | Accent | lin | 0–40 | 12 | added on strong beats |
| 23 | Seed | lin | 0–9999 | 1 | |
| 24 | Reseed | momentary | — | — | randomizes Seed |
| 25 | Trigger Mode | menu | Transport, Latch | Transport | see §8.3 |
| 26 | Print Settings | momentary | — | — | §9.5.2 — Traces a ready-to-paste CLI line reproducing the current state |

**Octave Span = 1 forces Octave Shift to 0** — there is nowhere to shift to. Gray it out in the GUI if the framework allows; in Scripter, just ignore the value.

The three register controls are deliberately separable. **Low Octave + Span** say *where the notes may go*. **Register Focus** says *where they prefer to be*. **Octave Shift** says *how often that preference moves*. A 3-octave span with Focus at 80 and Shift at 30 gives a line that mostly sits in one octave and periodically jumps to another — which is what a soloist actually does. A 3-octave span with Focus at 0 gives an arpeggiator having a nervous breakdown.

---

## 8. Scheduler behavior

### 8.1 The block loop

```
ProcessMIDI():
  info = GetTimingInfo()
  if !info.playing:
      allNotesOff(); clear active notes; return

  detect discontinuity: if info.blockStartBeat < lastBlockEndBeat
      → cycle jump or locate. Flush all active notes. Reset walk state.

  for each phrase overlapping [blockStartBeat, blockEndBeat):
      plan = planCache.get(phraseIndex) or planner.plan(phraseIndex, params)
      for each event in plan where blockStartBeat ≤ event.beat < blockEndBeat:
          noteOn.sendAtBeat(event.beat)
          noteOff.sendAtBeat(event.beat + event.durBeats)
          track it in activeNotes

  lastBlockEndBeat = info.blockEndBeat
```

Only schedule events falling **inside the current block**. Do not try to schedule far into the future.

### 8.2 Safety rules — every one of these is a real bug you will otherwise ship

- `Reset()` must call `MIDI.allNotesOff()` and clear `activeNotes`. Without it, stopping mid-note leaves a note ringing forever.
- **Cycle boundaries:** when the transport loops, `blockStartBeat` jumps backward. Detect it, flush active notes, invalidate the walk state. Notes whose note-off would land past the cycle end must be force-released at the boundary.
- **Parameter changes** invalidate the plan cache. Clear cached plans for phrases that haven't started yet; snapshot the parameter set at plan time so a phrase is always planned from one consistent configuration.
- No allocation, no `Trace()`, no heavy work inside `ProcessMIDI()` — it's on the real-time thread. Log from `Idle()` only.

### 8.3 Trigger Mode and MIDI passthrough

| Mode | Generation runs when | Incoming MIDI |
|---|---|---|
| **Transport** | The host transport is playing | **Passed through** — you can play along on your controller |
| **Latch** | At least one key is held | **Swallowed** — held keys are triggers, they don't sound |

In Scripter, defining `HandleMIDI(event)` suppresses passthrough unless you explicitly call `event.send()`. So: in Transport mode, `event.send()`; in Latch mode, track held notes and do not send.

---

## 9. Phase 0 — Logic Scripter implementation

Scripter is already sitting in the MIDI FX slot. It's JavaScript, it hot-reloads on "Run Script," and its `PluginParameters` array auto-generates the knob panel for free. **The entire musical engine gets built and tuned here before any Xcode exists.**

### Repo layout

```
ramble/
  engine/
    prng.js          mulberry32, hash32
    scales.js        scale tables, ladder construction
    walk.js          weighted pitch selection (§5)
    planner.js       phrase planning (§6) — the pure core
  scripter/
    wrapper.js       PluginParameters, ProcessMIDI, HandleMIDI, Reset
  tools/
    build.js         concatenates engine/*.js + scripter/wrapper.js → dist/
    render.js        CLI: plan N bars, print grid, write .mid
    harness.js       property tests
  test/
  dist/
    Ramble.scripter.js
```

### Scripter constraints — read these before writing a line

- **No `require`, no `import`, no modules.** Scripter runs a single self-contained script. Hence `tools/build.js`: a ~10-line concatenator, no bundler. Each engine file wraps itself as `var Foo = (function(){ … return {…}; })();` with a Node-only tail:
  ```js
  if (typeof module !== 'undefined') module.exports = Foo;
  ```
  so the same source runs unmodified under both Node and Scripter.
- **`NeedsTimingInfo = true`** must be set at the top level, or `GetTimingInfo()` returns nothing.
- **Beats are 1-based.** Bar 1 beat 1 is `beat 1.0`, not 0.0. Every `phraseIndex` calculation must subtract 1 first.
- Callbacks available: `HandleMIDI(event)`, `ProcessMIDI()`, `ParameterChanged(index, value)`, `Reset()`, `Idle()`.
- Events: `new NoteOn()` / `new NoteOff()` with `.pitch`, `.velocity`, `.channel`; send with `.sendAtBeat(beat)`.
- `GetTimingInfo()` gives `playing`, `blockStartBeat`, `blockEndBeat`, `tempo`, `meterNumerator`, `meterDenominator`, `cycling`, `leftCycleBeat`, `rightCycleBeat`.
- Parameter types: `"lin"`, `"log"`, `"menu"` (+ `valueStrings`), `"checkbox"`, `"momentary"`, `"text"` (use as a section divider in the panel).

### Install

Instrument track → **MIDI FX slot → Scripter → Open Script in Editor** → paste `dist/Ramble.scripter.js` → **Run Script**. Save as a Scripter preset. Load any Logic instrument below it and press Play.

### The CLI is a first-class feature, not a test rig

`tools/render.js` writes a standard `.mid` file:

```
node tools/render.js --seed 1138 --bars 16 --scale minor-pentatonic --root A --out solo.mid
```

Because generation is position-deterministic, **the MIDI file contains exactly the notes the plugin plays.** Drag it onto a Logic track and you have the solo as an editable region — which is the clean answer to "I like this take, now let me commit and edit it." Logic has no direct way to print MIDI FX output to a region; this sidesteps that entirely.

---

## 9.5 Phase 0.5 — remove the friction without porting anything

Two cheap changes that eliminate most of the reasons people reach for the JUCE port. Do these **before** deciding whether Phase 1 is worth it.

### 9.5.1 Stop pasting the script

Pasting on every session is not the actual workflow — it's the *development* workflow leaking into the *playing* workflow. Once the script is stable:

- **Save it as a Scripter preset.** Scripter's own preset menu stores the script text along with the parameter values. Loading the preset restores both. No pasting.
- **Better: save the whole channel strip.** Ramble in the MIDI FX slot plus your instrument below it, saved as a channel strip setting (or a Logic patch / track template). Now "start a Ramble track" is one click, instrument and all.
- Scripter's script text and parameter values are stored in the plugin instance, so they save with the project too. Verify this once on your own machine: save, quit, reopen, hit play. Thirty seconds to confirm, and it changes how you think about the port.

You then only re-paste when you **change the engine** — which is a development event, not a musical one.

### 9.5.2 "Print Settings" — capture a solo you like, without the port

The one thing Scripter genuinely can't do is hand you a MIDI region. But the CLI already can — the only obstacle is that reproducing a Scripter take from the terminal means re-typing all 25 parameter values by hand.

So don't type them. Add parameter **#26, Print Settings** (momentary). On click, `Trace()` a ready-to-paste CLI invocation of the plugin's *current* state:

```
node tools/render.js --seed 4471 --bars 32 --root A --scale minor-pentatonic \
  --low-octave C3 --span 2 --focus 40 --octave-shift 20 --grid 1/8 --density 70 \
  --note-length 50 --swing 58 --leap 25 --dir-hold 70 --gravity 60 --variability 50 \
  --phrase-length 2 --breath 25 --motif 40 --out solo.mid
```

The workflow becomes: hear a solo you like → click **Print Settings** → copy the line out of Scripter's console → paste into the terminal → drag `solo.mid` onto a track. Call it twenty seconds.

`tools/render.js` must therefore accept **every** engine parameter as a flag, and the flag names must match the printed line exactly. This is a half-hour of work and it captures most of the value of the drag-to-DAW feature that would otherwise cost you a weekend of C++.

**Trace from `Idle()`, never from `ProcessMIDI()`** (§8.2). The momentary button sets a flag; `Idle()` notices it and prints.

---

## 10. Phase 1 — JUCE port

### 10.0 Is the port actually worth it?

Only start this once the engine sounds good in Scripter — and only once you can name the specific friction you're trying to remove. Several of the usual arguments **do not apply to this project**, because the architecture already solved them:

| Assumed reason to port | Reality |
|---|---|
| "JavaScript will be too slow" | The planner runs **once per phrase**, not per sample. This is a rounding error either way. The planner/scheduler split (§3) made the performance argument moot before it was ever raised. |
| "I need automation" | Scripter's `PluginParameters` are already automatable in Logic. |
| "It won't persist" | Script text and parameter values save with the project and with a Scripter preset (§9.5.1). |
| "I need presets" | Scripter has its own preset system. |
| "I need determinism" | Already in the engine (§3). Host-independent. |

What the port **actually** buys you:

| Real advantage | Why it matters |
|---|---|
| **Drag-to-DAW MIDI export** | The killer feature. Hear a solo, drag it from the plugin window straight onto a track, as a region. Scripter cannot do this at all — no UI, no file I/O. `DragAndDropContainer::performExternalDragDropOfFiles()` with a temp `.mid`. §9.5.2 gets you ~80% of this for ~1% of the effort, but it's still a copy-paste through a terminal. |
| **A real panel** | Scripter gives you 26 controls in one tall scrolling list, in declaration order, no knobs, no grouping. JUCE gives you four labeled sections you can read at a glance. This is the difference between a tool you reach for and one you tolerate. |
| **A phrase visualizer** | Draw the planned line — contour, density, register — so you can *see* what you're about to hear, and see what a knob did. Scripter cannot draw anything, ever. For a generative instrument this is a genuine capability, not a decoration. |
| **One update, every project** | A Scripter script is frozen into each project at save time. Fix a bug and old projects still carry the old script. A `.component` updates globally. |
| **Shareable** | Your drummer can install a `.component`. He is not going to paste a JavaScript file into Scripter. |

### 10.0.1 Triggers — port when one of these is true

- You keep hearing solos you want to keep, and the terminal round-trip has stopped being charming.
- You've scrolled past twenty sliders to find Density for the tenth time today.
- You want Ramble on four tracks in different keys, and you're tired of re-pasting after every engine fix.
- You want to hand it to someone.

**If none of these is true: don't port it. Go make music.** Phase 1 was always conditional. The good news is that the planner is pure and already tested, so the port is a translation job rather than a redesign — it will keep just fine until you actually want it.

### CMake

```cmake
juce_add_plugin(Ramble
    FORMATS                     AU
    IS_MIDI_EFFECT              TRUE
    NEEDS_MIDI_INPUT            TRUE
    NEEDS_MIDI_OUTPUT           TRUE
    IS_SYNTH                    FALSE
    PLUGIN_MANUFACTURER_CODE    Rmbl
    PLUGIN_CODE                 Solo
    PRODUCT_NAME                "Ramble")
```

**Verify the built bundle's `Info.plist` declares AU type `aumi`.** If `IS_MIDI_EFFECT` alone doesn't produce it, force `AU_MAIN_TYPE kAudioUnitType_MIDIProcessor`. If the type is wrong, Logic will not show the plugin in the MIDI FX slot at all — and this is the #1 thing that goes wrong with JUCE MIDI FX builds.

### Implementation notes

- Declare **no audio buses** (`BusesProperties()` with nothing added). `processBlock` receives a 0-channel buffer and a `MidiBuffer`.
- `isMidiEffect()` → true; `acceptsMidi()` / `producesMidi()` → true.
- Port `engine/` to a header-only C++ namespace. The algorithm transfers directly; keep the same function names so the two implementations stay comparable.
- Transport via `getPlayHead()->getPosition()` → `getPpqPosition()`, `getBpm()`, `getIsPlaying()`, `getTimeSignature()`.
- Beat → sample offset:
  ```
  offsetSamples = (eventBeat - blockStartBeat) * (60.0 / bpm) * sampleRate
  ```
- Parameters via `AudioProcessorValueTreeState` (gives automation + state save/restore for free).
- **PPQ is 0-based in JUCE, 1-based in Scripter.** Convert once, at the boundary, and comment it loudly.

### GUI (minimal knobs panel)

Four labeled sections matching §7 — Key & Register, Rhythm, Melody, Phrasing/Performance — as rows of `juce::Slider` rotaries with `ComboBox` for menus, plus the Reseed button. Bind everything through `SliderAttachment` / `ComboBoxAttachment`. No custom look-and-feel in v1; correctness and layout first.

### The two features that justify the port

**Drag-to-DAW MIDI export.** A drag handle in the plugin window that writes the upcoming N bars of planned phrases to a temp `.mid` and hands it to the OS drag session via `DragAndDropContainer::performExternalDragDropOfFiles()`. Drop it on a Logic track and it becomes a real, editable MIDI region — same mechanic as dragging a loop out of Logic's own Loop Browser. This is the whole reason to build a real plugin — it's the feature that turns Ramble from a live noisemaker into something you compose with, because it's the only way Ramble's output goes from "regenerated in real time, never persisted" to "a captured take." Reuse the same MIDI writer as `tools/render.js`; the notes are identical by construction.

*Concrete flow:* Ramble running live in the MIDI FX slot over a piano patch. A phrase comes out great. Click-drag from inside the plugin window onto the arrange page → Logic creates a region on the target track containing exactly what just played → quantize it, transpose it, edit notes, bounce it, whatever. No terminal, no separate render step, no round-trip — the plugin *is* the source of the region. This is strictly better than the §9.5.2 Print Settings workaround; it's also the single hardest UI feature in this project. Real OS-level drag sessions initiated from inside a plugin window are fiddly — budget real time for M9, not an afternoon.

**Phrase visualizer.** A small piano-roll strip drawing the current and next planned phrase — contour, density, register, where the octave shifts land. It makes the abstract knobs legible: turn Register Focus and *watch* the line tighten. Scripter cannot draw a single pixel, so this capability simply does not exist until Phase 1.

### Validate and install

```bash
auval -v aumi Solo Rmbl
cp -R Ramble.component ~/Library/Audio/Plug-Ins/Components/
```

Then Logic → **Plug-in Manager → Reset & Rescan Selection**. Ad-hoc signing is fine for personal use; notarization only matters if you distribute.

---

## 11. Milestones

| # | Deliverable | Done when |
|---|---|---|
| **M0** | Repo scaffold, `prng.js`, Node harness | `hash32(seed, n)` is stable; `mulberry32` reproduces a known sequence |
| **M1** | Scales + ladder + weighted walk (§4–5) | Property tests pass: every pitch ∈ scale, every pitch ∈ [Low, High], `plan(seed, n)` is bit-identical across runs |
| **M2** | Rhythm, breath, swing, velocity (§6.1–6.2) | Grid/swing math verified against hand-computed beat positions; note-offs never precede note-ons |
| **M3** | Motif repetition + chain cap (§6.3) | Cold-planning phrase 200 touches ≤ 3 phrases; repeats are audibly restatements, not clones |
| **M4** | `tools/render.js` → `.mid` export | A rendered file dragged into Logic plays the same notes the planner printed |
| **M5** | Scripter wrapper + build (§9) | Loads in the MIDI FX slot, plays through a Logic instrument, survives loop + stop + locate with **zero stuck notes** |
| **M6** | Musical tuning pass — human in the loop | Section 12 checklist passes |
| **M6.5** | Phase 0.5: Scripter preset + channel strip; Print Settings + full CLI flags (§9.5) | Clicking Print Settings yields a line that renders a `.mid` identical to what you just heard. **Stop here and decide (§10.0).** |
| **M7** | JUCE port (§10) | `auval -v aumi Solo Rmbl` passes; appears in Logic's MIDI FX slot; output matches Scripter for the same seed and params |
| **M8** | GUI + presets | All 26 parameters bound, automatable, and saved with the project |
| **M9** | Drag-to-DAW export + phrase visualizer | Dragging from the plugin window drops a region on a Logic track containing exactly the notes it just played |

M0–M4 require no DAW and no human. Run them to completion first. **M6.5 is a decision point, not a formality** — do it, live with the result for a couple of weeks, and only then decide whether M7 onward is worth your weekends.

---

## 12. Acceptance: the listening test

Property tests prove the engine is *correct*. They cannot prove it's *musical*. Ship M6 only when the answer to all six is yes:

1. **Does it breathe?** Are there rests you'd want to hear, or is it a continuous stream of notes?
2. **Does it resolve?** Do phrases end somewhere that feels like an ending — root, third, fifth — rather than stopping arbitrarily?
3. **Does it repeat ideas?** Can you hear a figure come back, recognizably, maybe moved?
4. **Does it have shape?** Do lines rise and fall in runs, or zigzag aimlessly?
5. **Does it use its register?** Does the line have a home octave it leaves on purpose — or does it either sit in one spot forever, or roam across three octaves for no reason?
6. **Does `Variability` do something coherent at every setting?** At 0 it should be almost written-out; at 100 it should be wild but never out of key and never out of register.
7. **Does the same seed give the same solo every single time** — on playback, on freeze, and on bounce?

If #7 fails, nothing else matters.

---

## 13. Roadmap (explicitly out of scope for v1)

- **Chord follow** — held notes (from a controller or a Logic chord track) bias the gravity tiers toward the current chord's tones. This is the natural next step and the biggest musical upgrade available; the tier-weight architecture in §5.3 was designed to accept it without restructuring.
- **Burst / flurry** — occasional runs at a faster subdivision, the thing that separates human phrasing from a metronomic grid.
- **Modal interchange** — brief excursions to a borrowed scale, weighted low.
- **Blue-note approach rules** — the ♭5 as a chromatic approach *into* the 5th specifically, rather than a free-floating passing tone.
- **VST3/CLAP targets** — only if the plugin needs to leave Logic.

---

## Appendix A — Toolchain, cost, and the development loop

### A.1 What you need, and when

| Tool | Needed for | Cost |
|---|---|---|
| Node.js (LTS) | Phase 0 — the entire musical engine | Free (MIT) · `brew install node` |
| Logic Pro | Listening; hosts Scripter | Already owned |
| Xcode | **Phase 1 only** | Free (Mac App Store) |
| CMake | Phase 1 | Free (BSD) · `brew install cmake` |
| JUCE 8 | Phase 1 | Free — see A.4 |
| Apple Developer Program | Nothing here | **Not needed.** Only required to notarize for public distribution |

**Total cost: $0.**

Phase 0 needs **no Xcode, no CMake, no JUCE** — just Node and Logic. Defer the Xcode download (~15 GB) until M7, when there's finally something to compile. Skip the iOS/watchOS/tvOS platform downloads; this is a macOS-only build.

### A.2 Loop A — the fast loop (Claude Code alone; no Logic, no human)

M0–M4 live entirely here, and this is roughly 90% of the work.

```bash
node tools/render.js --seed 7 --bars 8 --root A --scale minor-pentatonic --print
```

Prints a text grid and note list to stdout, and writes `solo.mid`. Claude Code runs this itself, reads its own output, runs the property tests, and iterates — never opening Logic.

`tools/render.js --print` must therefore emit a **human-legible grid**:

```
bar 1  |A3 .  .  C4|.  D4 .  . |E4 .  .  . |.  .  G4 A4|
bar 2  |A4 .  .  . |.  .  .  . |G4 E4 .  . |D4 .  .  . |
```

This is not decoration. It is the only way an agent that cannot hear can reason about contour, density, and phrasing.

### A.3 Loop B — the listening loop (you + Logic)

Two ways to hear it, and the first arrives long before the second.

**During M1–M4, before the Scripter wrapper even exists:** drag `solo.mid` onto any Logic instrument track and press Play. That's the whole loop. No Scripter, no pasting.

**From M5 on, the live plugin:**

```bash
npm run build:copy    # concat engine/*.js + wrapper.js → dist/Ramble.scripter.js → pbcopy
```

Then in Logic: instrument track → **MIDI FX → Scripter → Open Script in Editor** → ⌘A, ⌘V → **Run Script**. About a five-second turnaround with the window already open. Syntax errors and `Trace()` output land in the console below the editor.

Scripter has no file-watching and no `import`, so paste-and-run *is* the loop — hence `build:copy`. Save versions you like from Scripter's own preset menu, which stores the script text along with the preset.

### A.4 JUCE licensing (Phase 1 only)

JUCE 8 is dual-licensed: the JUCE EULA, or **AGPLv3**.

- **Starter tier is free**, with an annual revenue/funding limit of **$20,000**. (Indie is $40/user/month up to $300K; Pro is $175/user/month.)
- The **AGPLv3 path** is separately available. JUCE's own licensing FAQ notes that in-house tools and internal, pre-release development generally don't trigger AGPL's conveyance obligations.

For a personal plugin that never leaves your machine, **either path costs nothing and neither imposes a condition you'd notice.** The only trigger to revisit this is deciding to distribute Ramble as closed-source software.

**Zero-third-party fallback:** Phase 1 can instead be built as a native AUv3 app extension from Xcode's own templates — Apple frameworks only, no external licensing question of any kind. The trade-off is that MIDI-effect AUv3 is thinly documented with little prior art for an agent to lean on. JUCE stays the recommendation; this is the escape hatch if the licensing ever bothers you.

### A.5 Division of labor — Claude Code cannot hear

Claude Code owns **correctness**: every pitch in scale, every note-off paired with a note-on, bit-identical output across runs, zero stuck notes across a loop boundary. All of that is verifiable programmatically, and it should verify all of it.

It cannot evaluate **musicality**. It will cheerfully ship an engine that passes every property test and sounds like a fax machine. That is precisely why §12 exists, and it is the one part of this project that cannot be delegated.

Make the feedback musical and specific. Not "it sounds bad," but *"at Variability 80 the line jumps registers mid-phrase — the leaps read as random rather than intentional."* That maps directly onto the weight functions in §5, and an agent can act on it.
