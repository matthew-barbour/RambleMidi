// test/scheduler-jitter.test.js — regression for the Logic ghost-note bug.
//
// Logic's beat clock reports block-start PPQs quantized (increments rounded
// to 1/1024 beat, resynced every ~8 blocks), so consecutive reported starts
// land a few micro-beats away from the block end the JUCE adapter DERIVES
// from numSamples * bpm / sampleRate. The scheduler's backward-jump detector,
// ported from wrapper.js with a 1e-6 tolerance, read that jitter as a locate
// every block and flushed every note ~2ms after its onset — audibly, a solo
// of organ-key ghost clicks (found in a real Logic session, 2026-08-15).
//
// Scheduler.h now stitches micro-discontinuities (PPQ_STITCH_EPS). This test
// drives the C++ scheduler through hostsim's `playrange-jitter`, which
// replays the observed Logic clock model, and asserts the music survives:
// real durations, no lost notes vs the clean-clock run, no stuck notes.
// There is no Scripter side to compare against — Scripter receives
// host-consistent block ends and never had this failure mode.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOSTSIM = path.join(__dirname, '..', 'build', 'ramble-hostsim');

// 128-sample blocks at 48 kHz, 110 bpm — the exact shape of the real session.
const BLOCK_BEATS = (128 * 110) / 60 / 48000;

function runHostsim(ops) {
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

// Pair each ON with the next OFF of the same pitch; return durations in beats.
function noteDurations(events) {
  const open = new Map(); // pitch -> onBeat
  const durations = [];
  for (const e of events) {
    if (e.type === 'on') {
      open.set(e.pitch, e.beat);
    } else if (e.type === 'off' && open.has(e.pitch)) {
      durations.push(e.beat - open.get(e.pitch));
      open.delete(e.pitch);
    }
  }
  return { durations, stuck: [...open.keys()] };
}

const skip = !fs.existsSync(HOSTSIM) &&
  'build/ramble-hostsim not built — run: cmake -B build -G Ninja && cmake --build build';

test('host PPQ jitter does not truncate notes (Logic ghost-click regression)', { skip }, async () => {
  const events = await runHostsim([
    ['param', 'seed', 1],
    ['playrange-jitter', 0, 32, BLOCK_BEATS],
    ['stop'],
  ]);
  const ons = events.filter((e) => e.type === 'on');
  assert.ok(ons.length > 10, `expected a real solo, got ${ons.length} note-ons`);

  const { durations, stuck } = noteDurations(events);
  assert.equal(stuck.length, 0, `stuck notes after stop: ${stuck}`);
  const min = Math.min(...durations);
  // Planner duration floor is 0.02 beats; the broken scheduler produced
  // ~0.003-0.005 (one block). Assert with a little float headroom.
  assert.ok(min >= 0.019, `note truncated to ${min} beats — jitter flushed it`);
});

test('jittered clock plays the same notes as a clean clock', { skip }, async () => {
  const clean = await runHostsim([
    ['param', 'seed', 1],
    ['playrange', 0, 32, BLOCK_BEATS],
    ['stop'],
  ]);
  const jittered = await runHostsim([
    ['param', 'seed', 1],
    ['playrange-jitter', 0, 32, BLOCK_BEATS],
    ['stop'],
  ]);
  const onsOf = (evts) => evts.filter((e) => e.type === 'on');
  const a = onsOf(clean), b = onsOf(jittered);
  assert.equal(b.length, a.length,
    `jitter changed the note count: clean=${a.length} jittered=${b.length} (a gap swallowed a note?)`);
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].pitch, a[i].pitch, `note ${i} pitch`);
    assert.equal(b[i].velocity, a[i].velocity, `note ${i} velocity`);
    assert.ok(Math.abs(b[i].beat - a[i].beat) < 1e-3, `note ${i} beat drifted: ${a[i].beat} vs ${b[i].beat}`);
  }
});
