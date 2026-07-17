#!/usr/bin/env node
// §2.1 determinism gate: same seed + same inputs = identical run, tick for
// tick. Runs each seed twice and compares state fingerprints at checkpoints;
// also confirms different seeds diverge (§1: visibly different outbreaks).

import { Sim } from './sim.js';

const seeds = ['charon-1', 'charon-2', 'high-charity'];
const checkTicks = [50, 500, 2000, 6000];

function run(seed) {
  const sim = new Sim(seed);
  const hashes = [];
  const maxTick = checkTicks[checkTicks.length - 1];
  for (let i = 1; i <= maxTick; i++) {
    sim.tick();
    if (checkTicks.includes(i)) hashes.push(sim.hashState());
  }
  return { hashes, breach: sim.graph.breachNode, outcome: sim.outcome };
}

let ok = true;
const fingerprints = new Map();
for (const seed of seeds) {
  const a = run(seed);
  const b = run(seed);
  const same = a.hashes.every((h, i) => h === b.hashes[i]);
  console.log(`${seed}: replay ${same ? 'IDENTICAL ✓' : 'DIVERGED ✗'}  hashes=${a.hashes.map((h) => h.toString(16)).join(',')}`);
  if (!same) ok = false;
  fingerprints.set(seed, a.hashes.join(','));
}
const unique = new Set(fingerprints.values());
if (unique.size !== seeds.length) {
  console.log('WARNING: different seeds produced identical runs');
  ok = false;
} else {
  console.log('seeds diverge from each other ✓');
}
process.exit(ok ? 0 : 1);
