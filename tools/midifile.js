// tools/midifile.js — minimal Standard MIDI File writer + reader.
// Format 0, one track, 480 ticks per quarter. Node-only (never concatenated
// into the Scripter build); the reader exists for round-trip tests.

'use strict';

const TPQ = 480;

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return bytes;
}

// events: [{ beat, pitch, velocity, durBeats }], beats 0-based quarters.
// opts: { tempo, meterNumerator, meterDenominator }
function write(events, opts = {}) {
  const tempo = opts.tempo || 120;
  const num = opts.meterNumerator || 4;
  const den = opts.meterDenominator || 4;

  const msgs = [];
  for (const ev of events) {
    const on = Math.max(0, Math.round(ev.beat * TPQ));
    const off = Math.max(on + 1, Math.round((ev.beat + ev.durBeats) * TPQ));
    msgs.push({ tick: on, order: 1, bytes: [0x90, ev.pitch & 0x7f, ev.velocity & 0x7f] });
    msgs.push({ tick: off, order: 0, bytes: [0x80, ev.pitch & 0x7f, 0x40] });
  }
  // note-offs before note-ons at the same tick, so same-pitch retriggers survive
  msgs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [];
  const uspq = Math.round(60000000 / tempo);
  track.push(...vlq(0), 0xff, 0x51, 0x03, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff);
  track.push(...vlq(0), 0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8);
  let last = 0;
  for (const m of msgs) {
    track.push(...vlq(m.tick - last), ...m.bytes);
    last = m.tick;
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);

  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd
    0, 0,                               // format 0
    0, 1,                               // one track
    (TPQ >> 8) & 0xff, TPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,             // MTrk
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track
  ];
  return Buffer.from(bytes);
}

// Reads back what write() produces (plus running status, for good measure).
function parse(buf) {
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const format = buf.readUInt16BE(8);
  const ntrks = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);

  let p = 14;
  if (buf.toString('latin1', p, p + 4) !== 'MTrk') throw new Error('missing MTrk');
  const trackLen = buf.readUInt32BE(p + 4);
  p += 8;
  const end = p + trackLen;

  const readVlq = () => {
    let v = 0, b;
    do {
      b = buf[p++];
      v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
  };

  const notes = [];
  let tempo = null;
  let timeSig = null;
  let tick = 0;
  let running = 0;
  while (p < end) {
    tick += readVlq();
    let status = buf[p];
    if (status & 0x80) p++;
    else status = running;

    if (status === 0xff) {
      const type = buf[p++];
      const len = readVlq();
      if (type === 0x51) tempo = Math.round(60000000 / ((buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]));
      if (type === 0x58) timeSig = { numerator: buf[p], denominator: 2 ** buf[p + 1] };
      p += len;
      continue; // meta events do not set running status
    }
    if (status === 0xf0 || status === 0xf7) {
      p += readVlq();
      continue;
    }
    running = status;
    const kind = status >> 4;
    if (kind === 0x9 || kind === 0x8) {
      const pitch = buf[p++];
      const velocity = buf[p++];
      const isOn = kind === 0x9 && velocity > 0;
      notes.push({ tick, type: isOn ? 'on' : 'off', pitch, velocity });
    } else if (kind === 0xc || kind === 0xd) {
      p += 1;
    } else {
      p += 2;
    }
  }
  return { format, ntrks, division, tempo, timeSig, notes };
}

module.exports = { TPQ, write, parse };
