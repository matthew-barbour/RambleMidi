// test/parity.test.js — cross-language parity between engine/*.js and
// cpp/engine/*.h (Phase 1 M7a).
//
// Both engines must produce the same pitch/velocity sequence, and the same
// timing/duration to within float tolerance, for identical params. Floats
// are compared with a tolerance rather than bitwise: std::exp/std::pow are
// not guaranteed to match V8's to the last ULP, so "same sampled index" is
// the contract, not "same float bits" (see the M7a plan's float-parity note).
//
// Skips (does not fail) if build/ramble-render hasn't been built yet — this
// suite needs the CMake build from Phase 1 Part 2, not just Node.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(REPO_ROOT, 'tools', 'render.js');
const RENDER_CPP = path.join(REPO_ROOT, 'build', 'ramble-render');

const FLOAT_TOL = 1e-6;
const CONCURRENCY = 16;

async function runJs(args) {
  const { stdout } = await execFileAsync('node', [RENDER_JS, ...args, '--json', '--no-mid']);
  return JSON.parse(stdout).events;
}

async function runCpp(args) {
  const { stdout } = await execFileAsync(RENDER_CPP, args);
  return JSON.parse(stdout).events;
}

function diffEvents(jsEvents, cppEvents) {
  if (jsEvents.length !== cppEvents.length) {
    return `event count differs: js=${jsEvents.length} cpp=${cppEvents.length}`;
  }
  for (let i = 0; i < jsEvents.length; i++) {
    const a = jsEvents[i], b = cppEvents[i];
    if (a.pitch !== b.pitch) return `event ${i}: pitch js=${a.pitch} cpp=${b.pitch}`;
    if (a.velocity !== b.velocity) return `event ${i}: velocity js=${a.velocity} cpp=${b.velocity}`;
    if (Math.abs(a.beat - b.beat) > FLOAT_TOL) return `event ${i}: beat js=${a.beat} cpp=${b.beat}`;
    if (Math.abs(a.durBeats - b.durBeats) > FLOAT_TOL) return `event ${i}: durBeats js=${a.durBeats} cpp=${b.durBeats}`;
  }
  return null;
}

async function checkCombo(args) {
  const [jsEvents, cppEvents] = await Promise.all([runJs(args), runCpp(args)]);
  const diff = diffEvents(jsEvents, cppEvents);
  if (diff) throw new Error(`${args.join(' ')} — ${diff}`);
}

async function runPool(items, worker, concurrency) {
  const failures = [];
  let idx = 0;
  async function lane() {
    while (idx < items.length) {
      const item = items[idx++];
      try {
        await worker(item);
      } catch (err) {
        failures.push({ item, error: err });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return failures;
}

// §4 scale table, §7 chromatic roots.
const SCALES = ['major', 'natural-minor', 'harmonic-minor', 'dorian', 'mixolydian',
  'major-pentatonic', 'minor-pentatonic', 'blues'];
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BASE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

// §6.1 grids (incl. both triplet grids) crossed against the corners called
// out in the M7a plan: density 0/50/100, variability 0/50/100 (the
// boundary-sensitive extremes), motif 0/100 (chain-cap stress).
const GRIDS = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
const CORNER_DENSITY = [0, 50, 100];
const CORNER_VARIABILITY = [0, 50, 100];
const CORNER_MOTIF = [0, 100];
const CORNER_SEEDS = [11, 22, 33];

const DEEP_SEEDS = [101, 202, 303];

function buildCombos() {
  const combos = [];

  for (const scale of SCALES) {
    for (const root of ROOTS) {
      for (const seed of BASE_SEEDS) {
        combos.push(['--seed', String(seed), '--bars', '8', '--root', root, '--scale', scale]);
      }
    }
  }

  for (const grid of GRIDS) {
    for (const density of CORNER_DENSITY) {
      for (const variability of CORNER_VARIABILITY) {
        for (const motif of CORNER_MOTIF) {
          for (const seed of CORNER_SEEDS) {
            combos.push([
              '--seed', String(seed), '--bars', '16', '--root', 'A', '--scale', 'blues',
              '--grid', grid, '--density', String(density), '--variability', String(variability),
              '--motif-repeat', String(motif),
            ]);
          }
        }
      }
    }
  }

  // Deep cold-start: enough phrases to exercise the motif chain cap (§6.3)
  // and octave shift (§6.4) repeatedly across a long timeline.
  for (const seed of DEEP_SEEDS) {
    combos.push(['--seed', String(seed), '--bars', '128', '--root', 'D', '--scale', 'dorian', '--octave-span', '3']);
  }

  return combos;
}

test('cpp engine parity (M7a)', {
  skip: !fs.existsSync(RENDER_CPP) && 'build/ramble-render not built — run: cmake -B build -G Ninja && cmake --build build',
}, async () => {
  const combos = buildCombos();
  const failures = await runPool(combos, checkCombo, CONCURRENCY);
  if (failures.length > 0) {
    const summary = failures.slice(0, 10).map((f) => f.error.message).join('\n');
    assert.fail(`${failures.length}/${combos.length} combos mismatched:\n${summary}`);
  }
});
