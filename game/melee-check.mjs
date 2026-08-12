// Butt-stroke geometry check. The arc lives in game/melee.js precisely so this
// can run without a browser: main.js supplies world positions and the wall
// raycast, but WHETHER a body is in reach is pure arithmetic.
//
// What this pins, and why: the vertical band used to hang off the camera, so
// it rode up with the player through a jump while the target stayed on the
// deck. The jump tier of combatMeleeImpulse (jumpBonus/jumpUp/jumpSpin/
// jumpKick) was therefore unreachable in practice — every strike that landed
// was a grounded one. Nothing in sim/melee-check.mjs could see that: it checks
// the impulse function, which was always correct, not whether the game can
// deliver an airborne strike to it.

import assert from 'node:assert/strict';
import { meleeArcDistance, strikeAttacker, MELEE_RISE, MELEE_DROP } from './melee.js';
import { combatMeleeImpulse } from '../sim/combat.js';
import { PARAMS } from '../shared/params.js';
import { MA5, ODST } from './fps-data.js';

const swing = PARAMS.combat.combatForm.swing;
const REACH = MA5.meleeRange;
const R_INFECTION = 0.5, R_COMBAT = 0.7, R_CARRIER = 1.0;
const MID_LOW = 0.35;  // infection form / downed body centre above its deck
const MID_STAND = 0.9; // standing combat form

// facing +X, standing at the origin on deck plate y = 0
const hit = (feetY, tx, ty, r = R_COMBAT) =>
  meleeArcDistance(0, 0, feetY, 1, 0, tx, ty, 0, r, REACH);

// --- the jump arc ---------------------------------------------------------
// ODST.jumpVel 8.2 against gravity 24: apex v^2/2g, airtime 2v/g.
const apex = ODST.jumpVel ** 2 / (2 * ODST.gravity);
const airtime = 2 * ODST.jumpVel / ODST.gravity;
assert.ok(Math.abs(apex - 1.4) < 0.01 && Math.abs(airtime - 0.683) < 0.01);
let sampled = 0;
for (let h = 0; h <= apex + 1e-9; h += 0.05) {
  // a form 0.8 m ahead, on the deck you jumped off
  assert.ok(hit(h, 0.8, MID_LOW, R_INFECTION) >= 0,
    `infection form at 0.8 m must stay in the arc at h=${h.toFixed(2)}`);
  assert.ok(hit(h, 0.8, MID_STAND) >= 0,
    `combat form at 0.8 m must stay in the arc at h=${h.toFixed(2)}`);
  // ...and at the far edge of the reach, where the band is the only thing left
  assert.ok(hit(h, 2.5, MID_LOW, R_INFECTION) >= 0,
    `infection form at the reach limit must stay in the arc at h=${h.toFixed(2)}`);
  sampled++;
}
console.log(`jump arc: ${sampled} heights sampled from the deck to the ${apex.toFixed(2)} m apex, all in reach`);

// AND the airborne strike must actually be an airborne strike — the tier is
// what the fix exists to restore, so read the impulse back at the apex.
const target = { x: 0.8, y: 0 };
const ground = combatMeleeImpulse(
  strikeAttacker({ x: 0, y: 0, heading: 0 }, { vx: 0, vz: 0, onGround: true, h: 0 }, ODST.walkSpeed),
  target, swing);
const air = combatMeleeImpulse(
  strikeAttacker({ x: 0, y: 0, heading: 0 }, { vx: 0, vz: 0, onGround: false, h: apex }, ODST.walkSpeed),
  target, swing);
assert.equal(ground.jumping, false);
assert.equal(air.jumping, true, 'a strike thrown off the deck must read as airborne');
assert.equal(air.speed, swing.standSpeed + swing.jumpBonus);
assert.equal(air.up, swing.jumpUp);
assert.equal(air.spin, swing.jumpSpin);
assert.equal(air.kick, swing.jumpKick);
assert.ok(air.speed > ground.speed && air.up > ground.up && air.kick > ground.kick);
console.log('grounded impulse', JSON.stringify(ground));
console.log('airborne impulse', JSON.stringify(air));

// --- the deck below your boots --------------------------------------------
// world.js stacks decks 4.2 m apart, so a stair flight or a catwalk landing
// puts you metres above bodies that are well inside arm's reach horizontally.
assert.ok(hit(1.6, 1.2, MID_LOW, R_INFECTION) >= 0, 'a form on the deck below a stair tread is clubbable');
assert.ok(hit(MELEE_DROP + MID_LOW + 0.05, 1.2, MID_LOW, R_INFECTION) < 0, 'the drop is bounded');
assert.ok(hit(0, 1.2, MELEE_RISE - 0.05) >= 0, 'a form on a crate is clubbable');
assert.ok(hit(0, 1.2, MELEE_RISE + 0.05) < 0, 'the rise is bounded');

// --- reach is to the SURFACE, which is what the bullet path always used ----
// A carrier is a metre-wide bag; comparing its centre against the reach made
// you walk a metre closer to club it than to shoot it.
assert.ok(hit(0, REACH + R_CARRIER - 0.05, MID_STAND, R_CARRIER) >= 0);
assert.ok(hit(0, REACH + R_CARRIER + 0.05, MID_STAND, R_CARRIER) < 0);
assert.ok(hit(0, REACH + R_COMBAT - 0.05, MID_STAND) >= 0);
assert.ok(hit(0, REACH + R_COMBAT + 0.05, MID_STAND) < 0);
console.log(`reach: carrier ${(REACH + R_CARRIER).toFixed(2)} m, combat form ${(REACH + R_COMBAT).toFixed(2)} m, infection form ${(REACH + R_INFECTION).toFixed(2)} m (centre to centre)`);

// --- the cone still points where you do -----------------------------------
const off = (deg) => meleeArcDistance(0, 0, 0, 1, 0,
  Math.cos(deg * Math.PI / 180) * 1.2, MID_STAND, Math.sin(deg * Math.PI / 180) * 1.2, R_COMBAT, REACH);
assert.ok(off(0) >= 0 && off(39) >= 0, 'inside the 40 deg half-angle');
assert.ok(off(41) < 0 && off(90) < 0 && off(180) < 0, 'outside it, including behind you');

// the nearest SURFACE wins, not the nearest centroid: a carrier's bulk 0.4 m
// off your chest is what the stock meets, even though a smaller form's centre
// is closer to you than its own
assert.ok(hit(0, 1.4, MID_STAND, R_CARRIER) < hit(0, 1.0, MID_LOW, R_INFECTION));

console.log('melee arc ✓');
