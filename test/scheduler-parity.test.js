// test/scheduler-parity.test.js — cross-language SCHEDULER parity (M7b).
//
// SPEC M7's acceptance line — "output matches Scripter for the same seed and
// params" — made mechanical. Each scenario is defined ONCE as a list of ops,
// then replayed through BOTH schedulers:
//
//   JS : the built Scripter bundle inside the mock host (scripter-host.js,
//        host beats 1-based — the runner adds 1 to every beat)
//   C++: cpp/plugin/Scheduler.h via build/ramble-hostsim (engine beats,
//        0-based — ops are fed verbatim)
//
// and the two MIDI logs are diffed event-for-event: type/pitch/velocity
// exact, beats within 1e-6. The tolerance absorbs two legitimate float
// artifacts: std::exp/pow vs V8 (as in parity.test.js) and the wrapper's
// (x+1)-1 host-beat round-trip, which can shift a block boundary by 1 ULP.
//
// Skips (does not fail) if build/ramble-hostsim hasn't been built.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const Build = require('../tools/build.js');
const Scales = require('../engine/scales.js');
const Planner = require('../engine/planner.js');
const { ScripterHost } = require('./scripter-host.js');

const HOSTSIM = path.join(__dirname, '..', 'build', 'ramble-hostsim');
const SOURCE = Build.build();
const FLOAT_TOL = 1e-6;

// ---------------------------------------------------------------- scenarios
//
// Ops (engine beats, 0-based): [op, ...args]
//   ['param', field, value]   ['tempo', bpm]        ['meter', num, den]
//   ['cycle', 'on', l, r]     ['cycle', 'off']      ['playrange', from, to, block]
//   ['stop']                  ['note', 'on'|'off', pitch, vel]   ['reset']

const SCENARIOS = {
  // PLUGIN == RENDER (§3): 8 bars straight through.
  straight: [
    ['param', 'seed', 1],
    ['playrange', 0, 32, 0.11],
    ['stop'],
  ],
  // Window-exact scheduling: same timeline, wildly different block sizes.
  blocksizes: [
    ['param', 'seed', 3],
    ['playrange', 0, 8, 0.37],
    ['playrange', 8, 16, 0.05],
    ['playrange', 16, 32, 1.0],
    ['stop'],
  ],
  // §8.2: stop mid-phrase mid-note flushes immediately.
  'stop-mid-note': [
    ['param', 'noteLength', 150],
    ['playrange', 0, 5.3, 0.11],
    ['stop'],
  ],
  // §8.2: three passes of a 2-bar loop, note-offs clipped at the boundary.
  cycle: [
    ['param', 'noteLength', 150],
    ['cycle', 'on', 0, 8],
    ['playrange', 0, 8, 0.11],
    ['playrange', 0, 8, 0.11],
    ['playrange', 0, 8, 0.11],
    ['stop'],
  ],
  // §3: dropping in at bar 17 plays the bar-17 notes.
  locate: [
    ['playrange', 0, 4, 0.11],
    ['playrange', 64, 80, 0.11],
    ['stop'],
  ],
  // Backward locate mid-note: flush + deterministic replay.
  'locate-back': [
    ['param', 'noteLength', 150],
    ['playrange', 0, 9.7, 0.11],
    ['playrange', 2, 11, 0.11],
    ['stop'],
  ],
  // §8.3 latch: silent until a key is held, silent again after release.
  latch: [
    ['param', 'triggerMode', 1],
    ['playrange', 0, 2, 0.11],
    ['note', 'on', 60, 100],
    ['playrange', 2, 6, 0.11],
    ['note', 'off', 60, 0],
    ['playrange', 6, 8, 0.11],
    ['stop'],
  ],
  // §8.2: mid-play parameter change keeps the sounding phrase, replans ahead.
  'param-change': [
    ['playrange', 0, 4, 0.11],
    ['param', 'density', 30],
    ['param', 'seed', 7],
    ['playrange', 4, 12, 0.11],
    ['stop'],
  ],
  // Reset mid-play: allNotesOff, cleared state, deterministic continuation.
  'reset-mid': [
    ['param', 'noteLength', 150],
    ['playrange', 0, 2.3, 0.11],
    ['reset'],
    ['playrange', 2.3, 4, 0.11],
    ['stop'],
  ],
  // Pre-roll: host beats below 1 (engine < 0) must not emit phantom notes.
  preroll: [
    ['playrange', -0.8, 0.5, 0.11],
    ['stop'],
  ],
  // Engine variety through the scheduler path: blues, 1/16 grid, swing.
  'blues-sixteenths': [
    ['param', 'seed', 42],
    ['param', 'scaleId', 'blues'],
    ['param', 'root', 9],
    ['param', 'gridId', '1/16'],
    ['param', 'swing', 65],
    ['param', 'octaveSpan', 3],
    ['playrange', 0, 16, 0.13],
    ['stop'],
  ],
  // Non-4/4 meter and non-default tempo (humanize beats depend on tempo).
  'six-eight': [
    ['tempo', 90],
    ['meter', 6, 8],
    ['param', 'seed', 11],
    ['playrange', 0, 12, 0.11],
    ['stop'],
  ],
};

// -------------------------------------------------- JS side: drive the mock

// Engine param field → Scripter panel name + value mapping.
const FIELD_TO_PANEL = {
  root: (v) => ['Root', v],
  scaleId: (v) => ['Scale', Scales.SCALES.findIndex((s) => s.id === v)],
  lowOctave: (v) => ['Low Octave', v - 1],
  octaveSpan: (v) => ['Octave Span', v - 1],
  registerFocus: (v) => ['Register Focus', v],
  octaveShift: (v) => ['Octave Shift', v],
  gridId: (v) => ['Grid', Planner.GRIDS.findIndex((g) => g.id === v)],
  density: (v) => ['Density', v],
  noteLength: (v) => ['Note Length', v],
  lengthVariation: (v) => ['Length Variation', v],
  swing: (v) => ['Swing', v],
  humanizeMs: (v) => ['Humanize', v],
  leapAmount: (v) => ['Leap Amount', v],
  directionHold: (v) => ['Direction Hold', v],
  tonalGravity: (v) => ['Tonal Gravity', v],
  variability: (v) => ['Variability', v],
  phraseBars: (v) => ['Phrase Length', Planner.PHRASE_BARS.indexOf(v)],
  breath: (v) => ['Breath', v],
  motifRepeat: (v) => ['Motif Repeat', v],
  velocity: (v) => ['Velocity', v],
  velocityRange: (v) => ['Velocity Range', v],
  accent: (v) => ['Accent', v],
  seed: (v) => ['Seed', v],
  triggerMode: (v) => ['Trigger Mode', v],
};

function runJs(ops) {
  const host = new ScripterHost(SOURCE);
  for (const [op, ...args] of ops) {
    if (op === 'param') {
      const [field, value] = args;
      const map = FIELD_TO_PANEL[field];
      if (!map) throw new Error(`unmapped field: ${field}`);
      host.setParameter(...map(value));
    } else if (op === 'tempo') {
      host.tempo = args[0];
    } else if (op === 'meter') {
      [host.meterNumerator, host.meterDenominator] = args;
    } else if (op === 'cycle') {
      if (args[0] === 'on') {
        host.cycling = true;
        host.leftCycleBeat = args[1] + 1;   // engine → host beats
        host.rightCycleBeat = args[2] + 1;
      } else {
        host.cycling = false;
      }
    } else if (op === 'playrange') {
      host.playRange(args[0] + 1, args[1] + 1, args[2]); // engine → host beats
    } else if (op === 'stop') {
      host.stop();
    } else if (op === 'note') {
      host.sendNote(args[1], args[0] === 'on', args[2]);
    } else if (op === 'reset') {
      host.reset();
    } else {
      throw new Error(`unknown op: ${op}`);
    }
  }
  // Generated stream only ('thru-*' passthrough is the adapter's concern),
  // host beats → engine beats.
  return host.notesOnly().map((s) => ({
    type: s.type,
    pitch: s.pitch ?? 0,
    velocity: s.velocity ?? 0,
    beat: s.beat - 1,
  }));
}

// ------------------------------------------------ C++ side: pipe to hostsim

function runCpp(ops) {
  const lines = ops.map((o) => o.join(' ')).join('\n') + '\n';
  return new Promise((resolve, reject) => {
    const child = spawn(HOSTSIM, []);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`hostsim exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout).events);
    });
    child.stdin.write(lines);
    child.stdin.end();
  });
}

// ------------------------------------------------------------------ compare

function diffStreams(js, cpp) {
  if (js.length !== cpp.length) {
    return `event count differs: js=${js.length} cpp=${cpp.length}`;
  }
  for (let i = 0; i < js.length; i++) {
    const a = js[i], b = cpp[i];
    if (a.type !== b.type) return `event ${i}: type js=${a.type} cpp=${b.type}`;
    if (a.type === 'alloff') continue; // immediate flush — timestamp is meaningless
    if (a.pitch !== b.pitch) return `event ${i}: pitch js=${a.pitch} cpp=${b.pitch}`;
    if (a.velocity !== b.velocity) return `event ${i}: velocity js=${a.velocity} cpp=${b.velocity}`;
    if (Math.abs(a.beat - b.beat) > FLOAT_TOL) return `event ${i}: beat js=${a.beat} cpp=${b.beat}`;
  }
  return null;
}

// --------------------------------------------------------------------- test

const skip = !fs.existsSync(HOSTSIM) &&
  'build/ramble-hostsim not built — run: cmake -B build -G Ninja && cmake --build build';

for (const [name, ops] of Object.entries(SCENARIOS)) {
  test(`scheduler parity: ${name}`, { skip }, async () => {
    const [js, cpp] = [runJs(ops), await runCpp(ops)];
    const diff = diffStreams(js, cpp);
    assert.equal(diff, null, diff || undefined);
    // A scenario that produced nothing proves nothing — guard against a
    // silently dead scheduler on both sides at once (preroll excepted:
    // silence is its correct output).
    if (name !== 'preroll') {
      assert.ok(cpp.some((e) => e.type === 'on'), 'scenario produced no notes at all');
    }
  });
}

// Latch-specific shape assertions (beyond parity): silence before the key,
// notes only while held. Runs on the C++ stream — the JS equivalent is
// already covered by wrapper.test.js.
test('latch scenario: notes only while the key is held (C++ side)', { skip }, async () => {
  const cpp = await runCpp(SCENARIOS.latch);
  const ons = cpp.filter((e) => e.type === 'on');
  assert.ok(ons.length > 0, 'held key must arm generation');
  assert.ok(ons.every((e) => e.beat >= 2 - FLOAT_TOL && e.beat < 6),
    'note-ons must fall inside the held-key window [2, 6)');
});
