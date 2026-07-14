#!/usr/bin/env node
// tools/render.js — plan N bars, print a human-legible grid, write a .mid.
//
// Because generation is position-deterministic (SPEC §3), the file this
// writes contains exactly the notes the Scripter plugin plays for the same
// seed and parameters. Drag it onto a Logic track to audition or commit a take.
//
//   node tools/render.js --seed 1138 --bars 16 --root A --scale minor-pentatonic --print
//
// Any engine parameter can be overridden with its kebab-case name
// (--density 80, --note-length 40, --octave-span 3, --grid 1/16, ...).

'use strict';

const fs = require('fs');
const path = require('path');
const Scales = require('../engine/scales.js');
const Planner = require('../engine/planner.js');
const MidiFile = require('./midifile.js');

// kebab-case CLI flag → params key. Menu-ish flags get parsed specially.
const NUMERIC_FLAGS = {
  'seed': 'seed',
  'low-octave': 'lowOctave',
  'octave-span': 'octaveSpan',
  'register-focus': 'registerFocus',
  'octave-shift': 'octaveShift',
  'density': 'density',
  'note-length': 'noteLength',
  'length-variation': 'lengthVariation',
  'swing': 'swing',
  'humanize': 'humanizeMs',
  'leap-amount': 'leapAmount',
  'direction-hold': 'directionHold',
  'tonal-gravity': 'tonalGravity',
  'variability': 'variability',
  'phrase-bars': 'phraseBars',
  'breath': 'breath',
  'motif-repeat': 'motifRepeat',
  'velocity': 'velocity',
  'velocity-range': 'velocityRange',
  'accent': 'accent',
  'tempo': 'tempo'
};

const USAGE = `usage: node tools/render.js [options]

  --seed N            global seed (default 1)
  --bars N            bars to render (default 8)
  --root NOTE         key root: C, F#, Bb, ... (default C)
  --scale ID          ${Scales.SCALES.map((s) => s.id).join(' | ')}
  --grid ID           ${Planner.GRIDS.map((g) => g.id).join(' | ')}
  --meter N/D         time signature (default 4/4)
  --out FILE          .mid output path (default solo.mid)
  --print             print the note grid and note list
  --no-mid            skip writing the .mid file
  --tempo BPM         tempo written to the .mid (default 120)

  engine overrides (0-100 unless noted): --density --note-length(5-150)
  --length-variation --swing(50-75) --humanize(ms 0-30) --leap-amount
  --direction-hold --tonal-gravity --variability --register-focus
  --octave-shift --motif-repeat --breath --velocity(1-127)
  --velocity-range(0-64) --accent(0-40) --low-octave(1-5) --octave-span(1-4)
  --phrase-bars(1|2|4|8)
`;

function parseArgs(argv) {
  const params = Planner.defaultParams();
  const opts = { bars: 8, out: 'solo.mid', print: false, writeMid: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) throw new Error(`unexpected argument: ${tok}`);
    const name = tok.slice(2);
    if (name === 'help') { opts.help = true; continue; }
    if (name === 'print') { opts.print = true; continue; }
    if (name === 'no-mid') { opts.writeMid = false; continue; }

    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${name}`);
    if (name === 'bars') {
      opts.bars = parseInt(value, 10);
      if (!(opts.bars > 0)) throw new Error('--bars must be a positive integer');
    } else if (name === 'out') {
      opts.out = value;
    } else if (name === 'root') {
      const pc = Scales.parsePitchClass(value);
      if (pc < 0) throw new Error(`bad root: ${value}`);
      params.root = pc;
    } else if (name === 'scale') {
      if (!Scales.byId(value)) throw new Error(`unknown scale: ${value} (try ${Scales.SCALES.map((s) => s.id).join(', ')})`);
      params.scaleId = value;
    } else if (name === 'grid') {
      if (!Planner.gridById(value)) throw new Error(`unknown grid: ${value}`);
      params.gridId = value;
    } else if (name === 'meter') {
      const m = /^(\d+)\/(\d+)$/.exec(value);
      if (!m) throw new Error(`bad meter: ${value} (expected e.g. 4/4)`);
      params.meterNumerator = parseInt(m[1], 10);
      params.meterDenominator = parseInt(m[2], 10);
    } else if (NUMERIC_FLAGS[name]) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`bad number for --${name}: ${value}`);
      params[NUMERIC_FLAGS[name]] = n;
    } else {
      throw new Error(`unknown option: --${name}\n\n${USAGE}`);
    }
  }
  if (params.octaveSpan === 1) params.octaveShift = 0; // §7: nowhere to shift to
  if (!Planner.PHRASE_BARS.includes(params.phraseBars)) {
    throw new Error(`--phrase-bars must be one of ${Planner.PHRASE_BARS.join(', ')}`);
  }
  return { params, opts };
}

// Plan every phrase overlapping [0, bars), truncate events to the window.
function render(params, bars) {
  const derived = Planner.derive(params);
  const totalBeats = bars * derived.beatsPerBar;
  const phraseCount = Math.ceil(totalBeats / derived.beatsPerPhrase);
  const cache = {};
  const plans = [];
  for (let k = 0; k < phraseCount; k++) {
    plans.push(Planner.plan(params, derived, k, cache));
  }
  const events = [];
  for (const plan of plans) {
    for (const ev of plan.events) {
      if (ev.beat < totalBeats - 1e-9) events.push(ev);
    }
  }
  events.sort((a, b) => a.beat - b.beat);
  return { derived, plans, events, totalBeats };
}

// The §A.2 grid: one line per bar, one cell per grid slot, '|' at beats.
function formatGrid(derived, plans, bars) {
  const slotsPerBar = Math.round(derived.beatsPerBar / derived.grid.beats);
  const totalSlots = bars * slotsPerBar;
  const cells = new Array(totalSlots).fill(null);
  for (const plan of plans) {
    for (let n = 0; n < plan.slots.length; n++) {
      const abs = plan.phraseIndex * derived.slotsPerPhrase + plan.slots[n];
      if (abs < totalSlots) {
        cells[abs] = Scales.noteName(derived.ladder.pitches[plan.ladderIndices[n]]);
      }
    }
  }
  const width = Math.max(2, ...cells.map((c) => (c ? c.length : 0)));
  const labelW = String(bars).length;
  const lines = [];
  for (let bar = 0; bar < bars; bar++) {
    const groups = [];
    let current = [];
    for (let s = 0; s < slotsPerBar; s++) {
      const beatInBar = s * derived.grid.beats;
      if (s > 0 && Math.abs(beatInBar - Math.round(beatInBar)) < 1e-9) {
        groups.push(current);
        current = [];
      }
      current.push((cells[bar * slotsPerBar + s] || '.').padEnd(width));
    }
    groups.push(current);
    lines.push(
      'bar ' + String(bar + 1).padStart(labelW) + '  |' +
      groups.map((g) => g.join(' ')).join('|') + '|'
    );
  }
  return lines.join('\n');
}

function formatNoteList(derived, events) {
  const lines = ['  beat      bar     note  vel  dur(b)'];
  for (const ev of events) {
    const bar = Math.floor(ev.beat / derived.beatsPerBar) + 1;
    const beatInBar = ev.beat - (bar - 1) * derived.beatsPerBar + 1;
    lines.push(
      '  ' + ev.beat.toFixed(2).padStart(7) +
      '   ' + (bar + ':' + beatInBar.toFixed(2)).padEnd(8) +
      Scales.noteName(ev.pitch).padEnd(5) +
      String(ev.velocity).padStart(4) +
      '  ' + ev.durBeats.toFixed(3)
    );
  }
  return lines.join('\n');
}

function formatSummary(params, derived, plans, events, bars) {
  const scale = derived.scale;
  const histogram = {};
  for (const ev of events) {
    const name = Scales.noteName(ev.pitch);
    histogram[name] = (histogram[name] || 0) + 1;
  }
  const histLines = derived.ladder.pitches.slice().reverse().map((p) => {
    const name = Scales.noteName(p);
    const n = histogram[name] || 0;
    return '  ' + name.padEnd(4) + String(n).padStart(4) + '  ' + '#'.repeat(n);
  });
  const repeats = plans.filter((p) => p.repeatDepth > 0).length;
  const shifted = plans.filter((p) => p.repeatDepth === 0 && p.shiftSteps !== 0).length;
  return [
    `${bars} bars · ${plans.length} phrases (${repeats} motif repeats, ${shifted} octave-shifted) · ${events.length} notes`,
    `seed ${params.seed} · root ${Scales.NOTE_NAMES[params.root]} · ${scale.name} · ` +
    `${Scales.noteName(derived.lowNote)}-${Scales.noteName(derived.highNote)} · grid ${params.gridId} · ${params.tempo} bpm`,
    '',
    'register usage:',
    ...histLines
  ].join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { params, opts } = parsed;
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { derived, plans, events } = render(params, opts.bars);
  if (opts.print) {
    console.log(formatGrid(derived, plans, opts.bars));
    console.log('');
    console.log(formatNoteList(derived, events));
    console.log('');
  }
  console.log(formatSummary(params, derived, plans, events, opts.bars));
  if (opts.writeMid) {
    const buf = MidiFile.write(events, {
      tempo: params.tempo,
      meterNumerator: params.meterNumerator,
      meterDenominator: params.meterDenominator
    });
    fs.writeFileSync(opts.out, buf);
    console.log(`\nwrote ${path.resolve(opts.out)} (${buf.length} bytes, ${events.length} notes)`);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, render, formatGrid, formatNoteList, formatSummary };
