#!/usr/bin/env node
// tools/build.js — concatenate the engine + wrapper into the single
// self-contained script Scripter needs (SPEC §9: no require, no modules).
//
// Order matters: each file's IIFE result is a top-level `var` that later
// files pick up as a global (module-free environment). The `module.exports`
// tails are dead code outside Node and stay in — they let the identical
// bytes run under both environments.
//
//   node tools/build.js          → dist/Ramble.scripter.js
//   node tools/build.js --copy   → …and pipe it to pbcopy for pasting

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ORDER = [
  'engine/prng.js',
  'engine/scales.js',
  'engine/walk.js',
  'engine/planner.js',
  'scripter/wrapper.js'
];
const OUT = path.join(ROOT, 'dist', 'Ramble.scripter.js');

const BANNER = `/*
 * Ramble — generative solo engine for Logic Pro.
 * Single-file build for the Scripter MIDI FX plug-in. Do not edit; generated
 * by tools/build.js from engine/ + scripter/ sources.
 *
 * Install: instrument track → MIDI FX → Scripter → Open Script in Editor →
 * paste this whole file → Run Script. Load any instrument below it, press
 * Play. Save it as a Scripter preset to keep it.
 */
`;

function build() {
  const parts = [BANNER];
  for (const rel of ORDER) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    parts.push(`// ═══ ${rel} ═══\n\n${source.trimEnd()}\n`);
  }
  return parts.join('\n');
}

function main() {
  const source = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, source);
  console.log(`wrote ${OUT} (${source.length} bytes)`);

  if (process.argv.includes('--copy')) {
    const res = spawnSync('pbcopy', [], { input: source });
    if (res.status === 0) console.log('copied to clipboard — paste into Scripter and Run Script');
    else console.error('pbcopy failed; copy dist/Ramble.scripter.js manually');
  }
}

if (require.main === module) main();

module.exports = { build, ORDER, OUT };
