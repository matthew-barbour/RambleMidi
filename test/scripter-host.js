// test/scripter-host.js — a mock Logic Scripter host.
//
// Runs the built dist/Ramble.scripter.js in a vm sandbox that emulates the
// Scripter API surface the wrapper uses: GetTimingInfo, Get/SetParameter,
// NoteOn/NoteOff with send()/sendAtBeat(), MIDI.allNotesOff(), and the
// callback protocol (ProcessMIDI, HandleMIDI, ParameterChanged, Reset).
// The sandbox deliberately has no `module`/`require`, exactly like Scripter —
// so these tests also prove the bundle survives a module-free environment.
//
// Host beats are 1-based, as in Logic.

'use strict';

const vm = require('vm');

class ScripterHost {
  constructor(source, opts = {}) {
    this.tempo = opts.tempo ?? 120;
    this.meterNumerator = opts.meterNumerator ?? 4;
    this.meterDenominator = opts.meterDenominator ?? 4;
    this.playing = false;
    this.cycling = false;
    this.leftCycleBeat = 1;
    this.rightCycleBeat = 1;
    this.blockStartBeat = 1;
    this.blockEndBeat = 1;
    this.sent = []; // { type: 'on'|'off'|'alloff'|'thru', pitch, velocity, beat }

    const host = this;

    class Event {
      constructor() {
        this.pitch = 0;
        this.velocity = 0;
        this.channel = 0;
        this.beatPos = 0;
      }
      send() { host._record(this, host.blockStartBeat); }
      sendAtBeat(beat) { host._record(this, beat); }
      sendAfterBeats(beats) { host._record(this, host.blockStartBeat + beats); }
    }
    class NoteOn extends Event {}
    class NoteOff extends Event {}
    class ControlChange extends Event {}
    class PitchBend extends Event {}
    this.classes = { NoteOn, NoteOff, ControlChange, PitchBend };

    this.sandbox = {
      NoteOn, NoteOff, ControlChange, PitchBend,
      GetTimingInfo: () => ({
        playing: this.playing,
        blockStartBeat: this.blockStartBeat,
        blockEndBeat: this.blockEndBeat,
        blockLength: this.blockEndBeat - this.blockStartBeat,
        tempo: this.tempo,
        meterNumerator: this.meterNumerator,
        meterDenominator: this.meterDenominator,
        cycling: this.cycling,
        leftCycleBeat: this.leftCycleBeat,
        rightCycleBeat: this.rightCycleBeat
      }),
      GetParameter: (ref) => this.getParameter(ref),
      SetParameter: (ref, value) => this.setParameter(ref, value),
      Trace: () => {},
      MIDI: { allNotesOff: () => this.sent.push({ type: 'alloff', beat: this.blockStartBeat }) },
      Date, Math, JSON, Object, Array, Number, String, Boolean, Infinity, NaN,
      console
    };
    vm.createContext(this.sandbox);
    vm.runInContext(source, this.sandbox, { filename: 'Ramble.scripter.js' });

    if (!Array.isArray(this.sandbox.PluginParameters)) {
      throw new Error('script defined no PluginParameters');
    }
    this.params = new Map(); // name -> value
    for (const def of this.sandbox.PluginParameters) {
      this.params.set(def.name, def.defaultValue ?? 0);
    }
  }

  _record(ev, beat) {
    const { NoteOn, NoteOff } = this.classes;
    let type = 'thru';
    if (ev instanceof NoteOn) type = ev.velocity > 0 ? 'on' : 'off';
    else if (ev instanceof NoteOff) type = 'off';
    if (ev.__external && type !== 'thru') type = 'thru-' + type; // passthrough of controller notes
    this.sent.push({ type, pitch: ev.pitch, velocity: ev.velocity, beat });
  }

  _paramIndex(ref) {
    if (typeof ref === 'number') return ref;
    return this.sandbox.PluginParameters.findIndex((d) => d.name === ref);
  }

  getParameter(ref) {
    const idx = this._paramIndex(ref);
    const def = this.sandbox.PluginParameters[idx];
    if (!def) throw new Error(`unknown parameter: ${ref}`);
    return this.params.get(def.name);
  }

  // Scripter fires ParameterChanged for SetParameter and for UI changes alike.
  setParameter(ref, value) {
    const idx = this._paramIndex(ref);
    const def = this.sandbox.PluginParameters[idx];
    if (!def) throw new Error(`unknown parameter: ${ref}`);
    this.params.set(def.name, value);
    if (typeof this.sandbox.ParameterChanged === 'function') {
      this.sandbox.ParameterChanged(idx, value);
    }
  }

  // Drive playback from host beat `from` to `to` in blocks of `blockBeats`.
  playRange(from, to, blockBeats = 0.11) {
    this.playing = true;
    let start = from;
    while (start < to - 1e-9) {
      const end = Math.min(start + blockBeats, to);
      this.blockStartBeat = start;
      this.blockEndBeat = end;
      this.sandbox.ProcessMIDI();
      start = end;
    }
  }

  // One stopped block, as Logic delivers after the transport halts.
  stop() {
    this.playing = false;
    this.sandbox.ProcessMIDI();
  }

  reset() {
    if (typeof this.sandbox.Reset === 'function') this.sandbox.Reset();
  }

  // Feed a controller note through HandleMIDI.
  sendNote(pitch, on, velocity = on ? 100 : 0) {
    const ev = on ? new this.classes.NoteOn() : new this.classes.NoteOff();
    ev.pitch = pitch;
    ev.velocity = velocity;
    ev.__external = true;
    if (typeof this.sandbox.HandleMIDI === 'function') this.sandbox.HandleMIDI(ev);
  }

  sendCC(number, value) {
    const ev = new this.classes.ControlChange();
    ev.number = number;
    ev.value = value;
    ev.__external = true;
    if (typeof this.sandbox.HandleMIDI === 'function') this.sandbox.HandleMIDI(ev);
  }

  notesOnly() {
    return this.sent.filter((s) => s.type === 'on' || s.type === 'off' || s.type === 'alloff');
  }

  // Replay the send log; return pitches still held at the end.
  // 'alloff' clears everything, like MIDI.allNotesOff().
  stuckNotes() {
    const held = new Map();
    for (const s of this.sent) {
      if (s.type === 'alloff') held.clear();
      else if (s.type === 'on') held.set(s.pitch, (held.get(s.pitch) || 0) + 1);
      else if (s.type === 'off') {
        const c = held.get(s.pitch) || 0;
        if (c <= 0) throw new Error(`note-off without matching note-on: pitch ${s.pitch} at beat ${s.beat}`);
        if (c === 1) held.delete(s.pitch);
        else held.set(s.pitch, c - 1);
      }
    }
    return [...held.keys()];
  }
}

module.exports = { ScripterHost };
