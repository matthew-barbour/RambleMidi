// M4 acceptance (SPEC §11): the rendered file contains exactly the notes the
// planner produced (round-trip through the SMF bytes), and the printed grid
// is stable for a fixed seed.

const test = require('node:test');
const assert = require('node:assert/strict');
const Planner = require('../engine/planner.js');
const Render = require('../tools/render.js');
const MidiFile = require('../tools/midifile.js');

const params1138 = { ...Planner.defaultParams(), seed: 1138, root: 9 }; // A minor pentatonic

test('golden grid: seed 1138, A minor pentatonic, 8 bars', () => {
  const { derived, plans } = Render.render(params1138, 8);
  assert.equal(
    Render.formatGrid(derived, plans, 8),
    'bar 1  |.  G3|E3 G3|A3 C4|A4 G4|\n' +
    'bar 2  |C4 . |.  . |A3 C3|.  . |\n' +
    'bar 3  |E3 D4|G4 . |E4 D4|C4 . |\n' +
    'bar 4  |C4 A3|.  E3|G3 . |.  . |\n' +
    'bar 5  |C3 A3|D4 . |C4 A3|G3 . |\n' +
    'bar 6  |G3 E3|.  C3|D3 . |.  . |\n' +
    'bar 7  |E3 D4|G4 . |E4 D4|C4 . |\n' +
    'bar 8  |C4 A3|.  E3|G3 . |.  . |'
  );
});

test('SMF round-trip: parsed file matches planner events exactly', () => {
  const { events } = Render.render(params1138, 16);
  assert.ok(events.length > 30);
  const buf = MidiFile.write(events, { tempo: 120, meterNumerator: 4, meterDenominator: 4 });
  const parsed = MidiFile.parse(buf);

  assert.equal(parsed.format, 0);
  assert.equal(parsed.ntrks, 1);
  assert.equal(parsed.division, 480);
  assert.equal(parsed.tempo, 120);
  assert.deepEqual(parsed.timeSig, { numerator: 4, denominator: 4 });

  const ons = parsed.notes.filter((n) => n.type === 'on');
  assert.equal(ons.length, events.length);
  events.forEach((ev, i) => {
    assert.equal(ons[i].pitch, ev.pitch, `note ${i} pitch`);
    assert.equal(ons[i].velocity, ev.velocity, `note ${i} velocity`);
    assert.equal(ons[i].tick, Math.round(ev.beat * 480), `note ${i} tick`);
  });
});

test('every note-on has a matching later note-off; nothing rings at the end', () => {
  for (const seed of [1, 7, 1138]) {
    const { events } = Render.render({ ...params1138, seed, noteLength: 150, lengthVariation: 100 }, 8);
    const parsed = MidiFile.parse(MidiFile.write(events, {}));
    const held = new Map(); // pitch -> count
    for (const n of parsed.notes) {
      const c = held.get(n.pitch) || 0;
      if (n.type === 'on') held.set(n.pitch, c + 1);
      else {
        assert.ok(c > 0, `note-off for silent pitch ${n.pitch} at tick ${n.tick}`);
        held.set(n.pitch, c - 1);
      }
    }
    for (const [pitch, c] of held) assert.equal(c, 0, `pitch ${pitch} left ringing`);
  }
});

test('.mid bytes are identical across runs (determinism at the file level)', () => {
  const a = MidiFile.write(Render.render(params1138, 8).events, { tempo: 100 });
  const b = MidiFile.write(Render.render(params1138, 8).events, { tempo: 100 });
  assert.ok(a.equals(b));
});

test('render truncates to the requested bar count', () => {
  // 3 bars with 2-bar phrases: second phrase is planned but clipped.
  const { events, totalBeats } = Render.render({ ...params1138, density: 100, breath: 0 }, 3);
  assert.equal(totalBeats, 12);
  assert.ok(events.length > 0);
  for (const ev of events) assert.ok(ev.beat < 12);
});

test('parseArgs maps flags onto engine params', () => {
  const { params, opts } = Render.parseArgs([
    '--seed', '7', '--bars', '4', '--root', 'F#', '--scale', 'blues',
    '--grid', '1/16', '--density', '85', '--note-length', '40',
    '--octave-span', '3', '--low-octave', '2', '--meter', '6/8',
    '--out', 'take.mid', '--print'
  ]);
  assert.equal(params.seed, 7);
  assert.equal(params.root, 6);
  assert.equal(params.scaleId, 'blues');
  assert.equal(params.gridId, '1/16');
  assert.equal(params.density, 85);
  assert.equal(params.noteLength, 40);
  assert.equal(params.octaveSpan, 3);
  assert.equal(params.lowOctave, 2);
  assert.equal(params.meterNumerator, 6);
  assert.equal(params.meterDenominator, 8);
  assert.equal(opts.bars, 4);
  assert.equal(opts.out, 'take.mid');
  assert.equal(opts.print, true);
});

test('parseArgs rejects garbage and enforces §7 menu constraints', () => {
  assert.throws(() => Render.parseArgs(['--scale', 'klingon']), /unknown scale/);
  assert.throws(() => Render.parseArgs(['--root', 'H']), /bad root/);
  assert.throws(() => Render.parseArgs(['--grid', '1/7']), /unknown grid/);
  assert.throws(() => Render.parseArgs(['--phrase-bars', '3']), /phrase-bars/);
  assert.throws(() => Render.parseArgs(['--meter', 'x']), /bad meter/);
  assert.throws(() => Render.parseArgs(['--bogus', '1']), /unknown option/);
  // Octave Span = 1 forces Octave Shift to 0 (§7)
  const { params } = Render.parseArgs(['--octave-span', '1', '--octave-shift', '90']);
  assert.equal(params.octaveShift, 0);
});

test('triplet grids print on a 6-cell-per-beat lattice without error', () => {
  const p = { ...params1138, gridId: '1/16T', density: 90 };
  const { derived, plans } = Render.render(p, 2);
  const grid = Render.formatGrid(derived, plans, 2);
  assert.equal(grid.split('\n').length, 2);
  // 6 slots per beat, 4 beats per bar → 24 cells + separators per line
  assert.ok(grid.split('\n')[0].split('|').length === 6); // label + 4 groups + tail
});
