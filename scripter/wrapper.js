// scripter/wrapper.js — Logic Pro Scripter wrapper (SPEC §7–§9).
//
// The thin, host-facing scheduler. All musical decisions live in engine/*;
// this file reads the knob panel, asks the planner for the phrases that
// overlap the current process block, and turns plan events into NoteOn /
// NoteOff pairs — while guaranteeing that no note ever sticks across stop,
// loop, or locate.
//
// BEAT CONVENTION, READ THIS FIRST: Scripter beats are 1-based (bar 1 beat 1
// is 1.0); the engine is 0-based. The conversion happens in exactly one
// place — ProcessMIDI subtracting 1 from the host's block beats. Everything
// below that line is engine time. (JUCE's PPQ is already 0-based, so the M7
// port deletes the subtraction and nothing else. SPEC §10.)

var NeedsTimingInfo = true;

// ---------------------------------------------------------------- parameters

var MENU_LOW_OCTAVES = ['C1', 'C2', 'C3', 'C4', 'C5'];
var MENU_SPANS = ['1 octave', '2 octaves', '3 octaves', '4 octaves'];
var MENU_PHRASE_BARS = ['1 bar', '2 bars', '4 bars', '8 bars'];

function scaleNames() {
  var names = [];
  for (var i = 0; i < Scales.SCALES.length; i++) names.push(Scales.SCALES[i].name);
  return names;
}

function gridNames() {
  var names = [];
  for (var i = 0; i < Planner.GRIDS.length; i++) names.push(Planner.GRIDS[i].id);
  return names;
}

var PluginParameters = [
  { name: '— KEY & REGISTER —', type: 'text' },
  { name: 'Root', type: 'menu', valueStrings: Scales.NOTE_NAMES, defaultValue: 0 },
  { name: 'Scale', type: 'menu', valueStrings: scaleNames(), defaultValue: 6 },
  { name: 'Low Octave', type: 'menu', valueStrings: MENU_LOW_OCTAVES, defaultValue: 2 },
  { name: 'Octave Span', type: 'menu', valueStrings: MENU_SPANS, defaultValue: 1 },
  { name: 'Register Focus', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 40, unit: '%' },
  { name: 'Octave Shift', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 20, unit: '%' },
  { name: '— RHYTHM —', type: 'text' },
  { name: 'Grid', type: 'menu', valueStrings: gridNames(), defaultValue: 1 },
  { name: 'Density', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 70, unit: '%' },
  { name: 'Note Length', type: 'lin', minValue: 5, maxValue: 150, numberOfSteps: 145, defaultValue: 50, unit: '%' },
  { name: 'Length Variation', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 15, unit: '%' },
  { name: 'Swing', type: 'lin', minValue: 50, maxValue: 75, numberOfSteps: 25, defaultValue: 50, unit: '%' },
  { name: 'Humanize', type: 'lin', minValue: 0, maxValue: 30, numberOfSteps: 30, defaultValue: 6, unit: 'ms' },
  { name: '— MELODY —', type: 'text' },
  { name: 'Leap Amount', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 25, unit: '%' },
  { name: 'Direction Hold', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 70, unit: '%' },
  { name: 'Tonal Gravity', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 60, unit: '%' },
  { name: 'Variability', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 50, unit: '%' },
  { name: '— PHRASING —', type: 'text' },
  { name: 'Phrase Length', type: 'menu', valueStrings: MENU_PHRASE_BARS, defaultValue: 1 },
  { name: 'Breath', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 25, unit: '%' },
  { name: 'Motif Repeat', type: 'lin', minValue: 0, maxValue: 100, numberOfSteps: 100, defaultValue: 40, unit: '%' },
  { name: '— PERFORMANCE —', type: 'text' },
  { name: 'Velocity', type: 'lin', minValue: 1, maxValue: 127, numberOfSteps: 126, defaultValue: 90 },
  { name: 'Velocity Range', type: 'lin', minValue: 0, maxValue: 64, numberOfSteps: 64, defaultValue: 20 },
  { name: 'Accent', type: 'lin', minValue: 0, maxValue: 40, numberOfSteps: 40, defaultValue: 12 },
  { name: 'Seed', type: 'lin', minValue: 0, maxValue: 9999, numberOfSteps: 9999, defaultValue: 1 },
  { name: 'Reseed', type: 'momentary' },
  { name: 'Trigger Mode', type: 'menu', valueStrings: ['Transport', 'Latch'], defaultValue: 0 }
];

// -------------------------------------------------------------------- state

var activeNotes = [];        // { pitch, offBeat } — engine beats
var heldKeys = [];           // latch-mode trigger pitches
var planCache = {};          // phraseIndex -> plan
var cachedParams = null;     // engine params snapshot (§8.2: one consistent config)
var cachedDerived = null;
var paramsDirty = true;
var lastBlockEnd = -1;       // engine beats; -1 = no block seen since stop
var wasPlaying = false;

// §7: read the panel into the planner's canonical params object.
function readParams(info) {
  var span = (GetParameter('Octave Span') | 0) + 1;
  return {
    root: GetParameter('Root') | 0,
    scaleId: Scales.SCALES[GetParameter('Scale') | 0].id,
    lowOctave: (GetParameter('Low Octave') | 0) + 1,
    octaveSpan: span,
    registerFocus: GetParameter('Register Focus'),
    octaveShift: span === 1 ? 0 : GetParameter('Octave Shift'), // §7: nowhere to shift to
    gridId: Planner.GRIDS[GetParameter('Grid') | 0].id,
    density: GetParameter('Density'),
    noteLength: GetParameter('Note Length'),
    lengthVariation: GetParameter('Length Variation'),
    swing: GetParameter('Swing'),
    humanizeMs: GetParameter('Humanize'),
    leapAmount: GetParameter('Leap Amount'),
    directionHold: GetParameter('Direction Hold'),
    tonalGravity: GetParameter('Tonal Gravity'),
    variability: GetParameter('Variability'),
    phraseBars: Planner.PHRASE_BARS[GetParameter('Phrase Length') | 0],
    breath: GetParameter('Breath'),
    motifRepeat: GetParameter('Motif Repeat'),
    velocity: GetParameter('Velocity'),
    velocityRange: GetParameter('Velocity Range'),
    accent: GetParameter('Accent'),
    seed: GetParameter('Seed') | 0,
    meterNumerator: info.meterNumerator,
    meterDenominator: info.meterDenominator,
    tempo: info.tempo
  };
}

// §8.2: parameter changes invalidate plans for phrases that haven't started;
// the phrase currently sounding keeps the plan it was started with.
function ensureParams(info) {
  if (!paramsDirty && cachedParams &&
      Math.abs(cachedParams.tempo - info.tempo) < 0.001 &&
      cachedParams.meterNumerator === info.meterNumerator &&
      cachedParams.meterDenominator === info.meterDenominator) {
    return;
  }
  cachedParams = readParams(info);
  cachedDerived = Planner.derive(cachedParams);
  // Keep only phrases that have already STARTED sounding; a phrase whose
  // first beat is still ahead (or exactly here) is replanned under the new
  // parameters. Stopped transport keeps nothing.
  var nowBeat = info.playing ? info.blockStartBeat - 1 : -1;
  var cutoff = nowBeat > 1e-9
    ? Math.floor((nowBeat - 1e-9) / cachedDerived.beatsPerPhrase)
    : -1;
  var kept = {};
  for (var key in planCache) {
    if (Object.prototype.hasOwnProperty.call(planCache, key) && Number(key) <= cutoff) {
      kept[key] = planCache[key];
    }
  }
  planCache = kept;
  paramsDirty = false;
}

// ---------------------------------------------------------------- note flow

// Immediate release of everything we started. Used on stop / cycle jump /
// locate / Reset — §8.2's stuck-note rules.
function flushAllNotes() {
  for (var i = 0; i < activeNotes.length; i++) {
    var off = new NoteOff();
    off.pitch = activeNotes[i].pitch;
    off.velocity = 64;
    off.send();
  }
  activeNotes = [];
}

// Send every pending note-off due inside this block. `clipBeat` pulls
// note-offs that would land past the cycle end back to the boundary (§8.2).
function sendDueNoteOffs(blockStart, blockEnd, clipBeat) {
  var remaining = [];
  for (var i = 0; i < activeNotes.length; i++) {
    var n = activeNotes[i];
    var offBeat = n.offBeat < clipBeat ? n.offBeat : clipBeat;
    if (offBeat < blockEnd) {
      var off = new NoteOff();
      off.pitch = n.pitch;
      off.velocity = 64;
      off.sendAtBeat(Math.max(offBeat, blockStart) + 1); // engine → host beats
    } else {
      remaining.push(n);
    }
  }
  activeNotes = remaining;
}

function scheduleNote(ev, blockStart) {
  // Last-on-wins: if this pitch is still sounding (legato NoteLength > 100%,
  // or a repeated pitch), release the old instance just before the new onset
  // so on/off pairs can never interleave into a stuck note.
  for (var i = 0; i < activeNotes.length; i++) {
    if (activeNotes[i].pitch === ev.pitch) {
      var oldOff = activeNotes[i].offBeat < ev.beat - 0.001 ? activeNotes[i].offBeat : ev.beat - 0.001;
      var off = new NoteOff();
      off.pitch = ev.pitch;
      off.velocity = 64;
      off.sendAtBeat(Math.max(oldOff, blockStart) + 1);
      activeNotes.splice(i, 1);
      break;
    }
  }
  var on = new NoteOn();
  on.pitch = ev.pitch;
  on.velocity = ev.velocity;
  on.sendAtBeat(ev.beat + 1);
  activeNotes.push({ pitch: ev.pitch, offBeat: ev.beat + ev.durBeats });
}

// ------------------------------------------------------------ host callbacks

function ProcessMIDI() {
  var info = GetTimingInfo();

  // Process pending parameter changes even while stopped — with the
  // transport halted there is no "current phrase" to protect, so the whole
  // plan cache goes (ensureParams sees nowBeat = -1).
  ensureParams(info);

  if (!info.playing) {
    if (wasPlaying) flushAllNotes();
    wasPlaying = false;
    lastBlockEnd = -1;
    return;
  }

  wasPlaying = true;

  // ── the single 1-based → 0-based conversion (see header) ──
  var blockStart = info.blockStartBeat - 1;
  var blockEnd = info.blockEndBeat - 1;

  // Cycle jump or locate backward: the timeline went backward under us.
  // Flush everything; plans are position-deterministic so replaying the
  // loop reproduces the identical notes (§3, §8.2).
  if (lastBlockEnd >= 0 && blockStart < lastBlockEnd - 1e-6) {
    flushAllNotes();
  }
  lastBlockEnd = blockEnd;

  var generating = (GetParameter('Trigger Mode') | 0) === 0 || heldKeys.length > 0;

  if (generating && blockEnd > 0) {
    var bpp = cachedDerived.beatsPerPhrase;
    var firstPhrase = Math.max(0, Math.floor(blockStart / bpp));
    var lastPhrase = Math.max(0, Math.floor((blockEnd - 1e-9) / bpp));
    for (var k = firstPhrase; k <= lastPhrase; k++) {
      var plan = Planner.plan(cachedParams, cachedDerived, k, planCache);
      for (var e = 0; e < plan.events.length; e++) {
        var ev = plan.events[e];
        if (ev.beat >= blockStart && ev.beat < blockEnd) {
          scheduleNote(ev, blockStart);
        }
      }
    }
  }

  // Note-offs go out after note-ons so a note starting and ending inside one
  // block is released here, not a block late.
  var clipBeat = info.cycling ? (info.rightCycleBeat - 1) - 0.01 : Infinity;
  sendDueNoteOffs(blockStart, blockEnd, clipBeat);
}

function HandleMIDI(event) {
  var latch = (GetParameter('Trigger Mode') | 0) === 1;
  var isOn = event instanceof NoteOn && event.velocity > 0;
  var isOff = event instanceof NoteOff || (event instanceof NoteOn && event.velocity === 0);

  if (latch && isOn) {
    if (heldKeys.indexOf(event.pitch) === -1) heldKeys.push(event.pitch);
    return; // §8.3: held keys are triggers, they don't sound
  }
  if (latch && isOff) {
    var at = heldKeys.indexOf(event.pitch);
    if (at !== -1) heldKeys.splice(at, 1);
    return;
  }
  event.send(); // Transport mode passthrough; non-note events always pass
}

function ParameterChanged(param, value) {
  var def = PluginParameters[param];
  if (!def) return;
  if (def.name === 'Reseed') {
    // Wrapper-side UI action. Not part of the engine, so the Math.random ban
    // stays absolute — wall-clock time is randomness enough for a button.
    if (value) SetParameter('Seed', Date.now() % 10000);
    return;
  }
  if (def.name === 'Trigger Mode') heldKeys = [];
  if (def.type === 'text') return;
  paramsDirty = true;
}

function Reset() {
  MIDI.allNotesOff();
  activeNotes = [];
  heldKeys = [];
  planCache = {};
  paramsDirty = true;
  lastBlockEnd = -1;
  wasPlaying = false;
}
