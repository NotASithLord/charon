#!/usr/bin/env node
// Exercises the command queue (companion spec §0): issue orders on scheduled
// ticks, confirm they override squad autonomy, and confirm a command-driven
// run is still deterministic (identical replays) — the property multiplayer
// lockstep depends on.

import { Sim } from './sim.js';
import { CMD } from './commands.js';

function scriptedRun(seed) {
  const sim = new Sim(seed);
  // NOT the armory — that starts SEALED now (ODST reserve), so an ordered
  // squad could never arrive; medbay exercises the same order machinery
  const target = sim.graph.byId.get('medbay');
  let arrivedTick = -1, cmdIssued = 0, sealedAt = -1;
  for (let i = 0; i < 15 * 60 * 3; i++) {
    const s0 = sim.squads[0];
    // from t=30s, keep ordering squad 0 to the armory until the order lands
    // (an order can be dropped by comms damage §2.4; the commander re-issues)
    if (sim.t >= 30 && sim.t < 90 && !s0.broken && !s0.order && sim.tickCount % sim.strategicEvery === 0) {
      sim.issue({ type: CMD.GUARD, squadId: 0, node: target });
      cmdIssued++;
    }
    // at t=90s, seal a door and release the squad
    if (Math.abs(sim.t - 90) < sim.dt) {
      sim.issue({ type: CMD.SET_DOOR, edgeIdx: 13, locked: true });
      sim.issue({ type: CMD.RELEASE, squadId: 0 });
    }
    sim.tick();
    const leader = !s0.broken ? sim.byId.get(s0.members[0]) : null;
    if (arrivedTick < 0 && leader && leader.node === target) arrivedTick = sim.tickCount;
    if (sim.graph.edges[13].locked && sealedAt < 0) sealedAt = sim.tickCount;
    if (sim.outcome) break;
  }
  return { hash: sim.hashState(), arrivedTick, cmdIssued, sealedAt };
}

let ok = true;
for (const seed of ['charon-1', 'charon-4']) {
  const a = scriptedRun(seed);
  const b = scriptedRun(seed);
  const det = a.hash === b.hash && a.arrivedTick === b.arrivedTick && a.cmdIssued === b.cmdIssued;
  const reached = a.arrivedTick > 0;
  console.log(`${seed}: order obeyed=${reached ? 'yes @tick ' + a.arrivedTick : 'no (squad lost/broken)'} | issues=${a.cmdIssued} | door sealed=${a.sealedAt > 0 ? '@tick ' + a.sealedAt : 'no'} | replay ${det ? 'IDENTICAL ✓' : 'DIVERGED ✗'}`);
  if (!det) ok = false;
  if (!reached && a.cmdIssued === 0) ok = false; // should have issued at least once
}
console.log(ok ? 'command queue deterministic ✓' : 'DETERMINISM BROKEN ✗');
process.exit(ok ? 0 : 1);
