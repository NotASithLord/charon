// physics/physics-check.mjs — the verifiable gate for the Rapier layer.
//
// Companion to sim/determinism-check.js: that one proves the AI sim replays
// bit-identically; this proves the PHYSICS does too, and that the character
// controller actually blocks — no tunnelling through walls, no standing inside
// another body. Runs headless in Node (the vendored Rapier is the same wasm the
// browser loads), so it can run in CI and in an agent's edit→verify loop.
//
//   node physics/physics-check.mjs
//
// Exits non-zero on any failure.

import { PhysicsWorld, initRapier } from './physics-world.js';

// A synthetic test cell: a 12 x 6 m room (walls full height), so the outcome
// depends only on the controller, not on the ship's geometry. Determinism is a
// property of the engine + fixed step, independent of which level we load.
function room() {
  const boxes = [];
  const wall = (cx, cz, hx, hz) => boxes.push({ cx, cy: 1.5, cz, hx, hy: 1.5, hz, ry: 0 });
  wall(0, 0, 0.1, 3);    // west  x=0
  wall(12, 0, 0.1, 3);   // east  x=12
  wall(6, -3, 6, 0.1);   // north z=-3
  wall(6, 3, 6, 0.1);    // south z=+3
  return boxes;
}

// Drive a scripted walk and record a trace + the final snapshot hash. `bodies`
// optionally seeds a static obstacle the walker must not end up inside.
function drive({ bodies = [] } = {}) {
  const world = new PhysicsWorld({ staticBoxes: room() });
  world.spawnPlayer(2, 0, 0);

  const trace = [];
  let minBodyGap = Infinity;
  const STEP = 0.06; // ~3.6 m/s at 60 Hz

  for (let i = 0; i < 400; i++) {
    if (bodies.length) world.syncBodies(bodies);
    // walk +x, with a faint +z drift so sliding around an obstacle is exercised
    world.movePlayer(STEP, 0.006, 0);
    world.step();
    const c = world.playerCenter();
    if (i % 50 === 0) trace.push([+c.x.toFixed(5), +c.z.toFixed(5)]);
    for (const b of bodies) {
      const gap = Math.hypot(c.x - b.x, c.z - b.z);
      if (gap < minBodyGap) minBodyGap = gap;
    }
  }
  const c = world.playerCenter();
  return {
    final: [+c.x.toFixed(5), +c.z.toFixed(5)],
    trace,
    hash: world.snapshotHash(),
    minBodyGap,
  };
}

function assert(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

await initRapier();
let ok = true;

// 1) determinism — two identical runs must agree byte-for-byte
{
  const a = drive();
  const b = drive();
  const same = JSON.stringify(a.trace) === JSON.stringify(b.trace) && a.hash === b.hash;
  ok &= assert('deterministic (trace + snapshot hash identical across runs)', same,
    `hashA=${a.hash} hashB=${b.hash}`);
}

// 2) no wall tunnelling — walking hard into the east wall (x=12) must stop the
//    capsule short of it (wall face at 11.9, minus the ~0.34 capsule radius)
{
  const r = drive();
  ok &= assert('stopped before the east wall (no tunnelling)', r.final[0] < 11.6,
    `final x=${r.final[0]}`);
}

// 3) body blocking — a body straddling the path must never be stood inside
{
  const bodyR = 0.4, playerR = 0.34;
  const r = drive({ bodies: [{ id: 1, x: 6, y: 0.9, z: 0.2, radius: bodyR, half: 0.5 }] });
  // capsules of radius playerR and bodyR may not overlap (minus the controller
  // offset + a small numerical slack)
  ok &= assert('never overlaps the body it walks into', r.minBodyGap > (bodyR + playerR) - 0.12,
    `min gap=${r.minBodyGap.toFixed(3)} vs radii sum=${(bodyR + playerR).toFixed(3)}`);
}

console.log(ok ? '\nphysics-check OK' : '\nphysics-check FAILED');
process.exit(ok ? 0 : 1);
