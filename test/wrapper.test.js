// M5 acceptance (SPEC §11): the built script parses standalone, exposes the
// §7 panel, plays exactly what the planner plans, and survives loop + stop +
// locate with zero stuck notes. Everything runs against dist-equivalent
// bytes inside a module-free sandbox — the same environment Scripter is.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const Build = require('../tools/build.js');
const Planner = require('../engine/planner.js');
const Render = require('../tools/render.js');
const { ScripterHost } = require('./scripter-host.js');

const SOURCE = Build.build();

function newHost(opts) {
  return new ScripterHost(SOURCE, opts);
}

function onsOf(host) {
  return host.sent
    .filter((s) => s.type === 'on')
    .map((s) => ({ beat: s.beat - 1, pitch: s.pitch, velocity: s.velocity })) // host 1-based → engine
    .sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
}

function renderedOns(params, bars) {
  return Render.render(params, bars).events
    .map((e) => ({ beat: e.beat, pitch: e.pitch, velocity: e.velocity }))
    .sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
}

function assertSameNotes(got, want) {
  assert.equal(got.length, want.length, `note count ${got.length} == ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    assert.equal(got[i].pitch, want[i].pitch, `note ${i} pitch`);
    assert.equal(got[i].velocity, want[i].velocity, `note ${i} velocity`);
    assert.ok(Math.abs(got[i].beat - want[i].beat) < 1e-9, `note ${i} beat ${got[i].beat} == ${want[i].beat}`);
  }
}

test('the bundle parses standalone and bans Math.random', () => {
  assert.doesNotThrow(() => new vm.Script(SOURCE)); // same check as node --check
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/Math\.random/.test(code), 'Math.random must not appear outside comments');
  assert.ok(/var NeedsTimingInfo = true/.test(code));
});

test('all 25 §7 parameters exist with spec names and defaults', () => {
  const host = newHost();
  // PluginParameters lives in the vm realm — copy into this realm before
  // deep-comparing, or prototype identity fails the assertion.
  const defs = Array.from(host.sandbox.PluginParameters);
  const real = defs.filter((d) => d.type !== 'text');
  assert.equal(real.length, 25);
  assert.deepEqual(Array.from(real, (d) => d.name), [
    'Root', 'Scale', 'Low Octave', 'Octave Span', 'Register Focus', 'Octave Shift',
    'Grid', 'Density', 'Note Length', 'Length Variation', 'Swing', 'Humanize',
    'Leap Amount', 'Direction Hold', 'Tonal Gravity', 'Variability',
    'Phrase Length', 'Breath', 'Motif Repeat',
    'Velocity', 'Velocity Range', 'Accent', 'Seed', 'Reseed', 'Trigger Mode'
  ]);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  assert.equal(byName['Scale'].defaultValue, 6);            // Minor Pentatonic
  assert.equal(byName['Low Octave'].defaultValue, 2);       // C3
  assert.equal(byName['Octave Span'].defaultValue, 1);      // 2 octaves
  assert.equal(byName['Grid'].defaultValue, 1);             // 1/8
  assert.equal(byName['Phrase Length'].defaultValue, 1);    // 2 bars
  assert.equal(byName['Note Length'].minValue, 5);
  assert.equal(byName['Swing'].minValue, 50);
  assert.equal(byName['Swing'].maxValue, 75);
  assert.equal(byName['Humanize'].maxValue, 30);
  assert.equal(byName['Seed'].maxValue, 9999);
  assert.equal(byName['Trigger Mode'].valueStrings.length, 2);
});

test('PLUGIN == RENDER: playback emits exactly the planned notes (§3)', () => {
  const host = newHost();
  host.playRange(1, 33); // 8 bars of 4/4, host beats
  host.stop();
  assertSameNotes(onsOf(host), renderedOns(Planner.defaultParams(), 8));
  assert.deepEqual(host.stuckNotes(), []);
});

test('block size does not change the notes (scheduling is window-exact)', () => {
  const a = newHost();
  a.playRange(1, 17, 0.11);
  const b = newHost();
  b.playRange(1, 17, 0.25);
  const c = newHost();
  c.playRange(1, 17, 1.0);
  assertSameNotes(onsOf(a), onsOf(b));
  assertSameNotes(onsOf(a), onsOf(c));
});

test('stop mid-note flushes immediately: zero stuck notes (§8.2)', () => {
  const host = newHost();
  host.setParameter('Note Length', 150); // legato — guarantees ringing notes
  host.playRange(1, 6.3);                // stop mid-phrase, mid-note
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
});

test('cycle: three loop passes, notes clipped at the boundary, zero stuck (§8.2)', () => {
  const host = newHost();
  host.setParameter('Note Length', 150);
  host.cycling = true;
  host.leftCycleBeat = 1;
  host.rightCycleBeat = 9; // 2-bar loop
  for (let pass = 0; pass < 3; pass++) host.playRange(1, 9);
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
  // no note-off scheduled beyond the cycle end
  for (const s of host.sent) {
    if (s.type === 'off') assert.ok(s.beat <= 9 + 1e-9, `off at ${s.beat} inside cycle`);
  }
  // and each pass plays the identical notes (position determinism)
  const ons = host.sent.filter((s) => s.type === 'on');
  const perPass = ons.length / 3;
  assert.ok(Number.isInteger(perPass) && perPass > 0, `even split: ${ons.length} / 3`);
  for (let i = 0; i < perPass; i++) {
    for (let pass = 1; pass < 3; pass++) {
      assert.equal(ons[i].pitch, ons[pass * perPass + i].pitch, `pass ${pass} note ${i}`);
      assert.equal(ons[i].velocity, ons[pass * perPass + i].velocity);
      assert.ok(Math.abs(ons[i].beat - ons[pass * perPass + i].beat) < 1e-9);
    }
  }
});

test('locate: dropping in at bar 17 plays the same notes as a cold render (§3)', () => {
  const host = newHost();
  host.playRange(1, 5);    // play a bit at the top
  host.playRange(65, 81);  // locate to bar 17, play 4 bars (host beats)
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
  const got = onsOf(host).filter((n) => n.beat >= 64);
  const want = renderedOns(Planner.defaultParams(), 20).filter((n) => n.beat >= 64 && n.beat < 80);
  assertSameNotes(got, want);
});

test('locate backward mid-note flushes and replays deterministically', () => {
  const host = newHost();
  host.setParameter('Note Length', 150);
  host.playRange(1, 10.7);
  host.playRange(3, 12);   // jump back to beat 3 mid-note
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
});

test('latch mode: keys arm generation, input notes are swallowed, CC passes (§8.3)', () => {
  const host = newHost();
  host.setParameter('Trigger Mode', 1);
  host.playRange(1, 3);
  assert.equal(host.sent.filter((s) => s.type === 'on').length, 0, 'silent with no keys held');

  host.sendNote(48, true);              // press a trigger key
  host.playRange(3, 7);
  const armedOns = host.sent.filter((s) => s.type === 'on');
  assert.ok(armedOns.length > 0, 'generates while a key is held');
  assert.equal(host.sent.filter((s) => s.type === 'thru-on').length, 0, 'trigger key does not sound');

  host.sendNote(48, false);             // release
  host.playRange(7, 11);
  host.stop();
  const lateOns = host.sent.filter((s) => s.type === 'on' && s.beat >= 7);
  assert.equal(lateOns.length, 0, 'generation stops on release');
  assert.deepEqual(host.stuckNotes(), []);

  host.sendCC(1, 64);                   // non-note input passes through
  assert.equal(host.sent.filter((s) => s.type === 'thru').length, 1);
});

test('transport mode passes controller notes through (§8.3)', () => {
  const host = newHost();
  host.sendNote(64, true);
  host.sendNote(64, false);
  assert.equal(host.sent.filter((s) => s.type === 'thru-on').length, 1);
  assert.equal(host.sent.filter((s) => s.type === 'thru-off').length, 1);
});

test('parameter changes while stopped fully re-plan: next play matches a fresh render', () => {
  const host = newHost();
  host.playRange(1, 9);
  host.stop();
  host.sent = [];
  host.setParameter('Seed', 7);
  host.setParameter('Density', 90);
  host.setParameter('Scale', 7); // Blues
  host.playRange(1, 17);
  host.stop();
  const want = renderedOns(
    { ...Planner.defaultParams(), seed: 7, density: 90, scaleId: 'blues' }, 4);
  assertSameNotes(onsOf(host), want);
  assert.deepEqual(host.stuckNotes(), []);
});

test('mid-play parameter change keeps the sounding phrase, replans the future (§8.2)', () => {
  const before = renderedOns(Planner.defaultParams(), 2); // phrase 0 under old params
  const host = newHost();
  host.playRange(1, 5);                  // halfway through phrase 0
  host.setParameter('Seed', 4242);       // change everything melodic
  host.playRange(5, 9);                  // finish phrase 0
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
  // phrase 0's remaining notes still come from the ORIGINAL plan
  const gotPhrase0Tail = onsOf(host).filter((n) => n.beat >= 4 && n.beat < 8);
  const wantTail = before.filter((n) => n.beat >= 4 && n.beat < 8);
  assertSameNotes(gotPhrase0Tail, wantTail);
});

test('drastic register shrink mid-play cannot emit out-of-ladder notes', () => {
  const host = newHost();
  host.setParameter('Motif Repeat', 100);
  host.setParameter('Octave Span', 2);   // 3 octaves → index 2
  host.playRange(1, 9);
  host.setParameter('Octave Span', 0);   // shrink to 1 octave mid-flight
  host.playRange(9, 25);
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
  for (const s of host.sent) {
    if (s.type === 'on' && s.beat >= 9) {
      assert.ok(s.pitch >= 60 && s.pitch <= 72, `pitch ${s.pitch} inside C3..C4 after shrink`);
    }
  }
});

test('Reseed randomizes the Seed parameter into 0..9999', () => {
  const host = newHost();
  host.setParameter('Reseed', 1);
  const seed = host.getParameter('Seed');
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 9999);
});

test('Reset sends allNotesOff and the script keeps working afterwards', () => {
  const host = newHost();
  host.playRange(1, 4.4);
  host.reset();
  assert.ok(host.sent.some((s) => s.type === 'alloff'));
  assert.deepEqual(host.stuckNotes(), []);
  host.playRange(4.4, 9);
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
});

test('pre-roll (host beats below 1) neither crashes nor emits phantom notes', () => {
  const host = newHost();
  host.playRange(0.25, 3); // Logic count-in style
  host.stop();
  assert.deepEqual(host.stuckNotes(), []);
  for (const s of host.sent) {
    if (s.type === 'on') assert.ok(s.beat >= 1 - 1e-9, 'no notes before bar 1');
  }
});
