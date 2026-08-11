import assert from 'node:assert/strict';
import { combatMeleeImpulse, humanDeathToCorpse } from './combat.js';
import { PARAMS } from '../shared/params.js';
import { FACTION } from '../shared/agentBuffer.js';

const swing = PARAMS.combat.combatForm.swing;
const target = { x: 4, y: 3 };
const base = { x: 1, y: -1, heading: 0, charging: false, leaping: false, hoverY: 0 };
const standing = combatMeleeImpulse(base, target, swing);
const charging = combatMeleeImpulse({ ...base, charging: true }, target, swing);
const jumping = combatMeleeImpulse({ ...base, charging: true, leaping: true, hoverY: 0.8 }, target, swing);

assert.equal(standing.kind, 'melee');
assert.ok(Math.abs(Math.hypot(standing.dirX, standing.dirY) - 1) < 1e-9);
assert.ok(standing.speed < charging.speed && charging.speed < jumping.speed,
  'standing, charging, and jumping melee momentum must remain strictly ordered');
assert.ok(jumping.up > standing.up && jumping.spin > standing.spin && jumping.kick > standing.kick,
  'a jumping strike must loft and tumble a body harder than a standing strike');
assert.ok(standing.dirX > 0 && standing.dirY > 0, 'impact must point away from the attacker');

const graph = { node: () => ({ x: 0, y: 0, deck: 1 }) };
const spawned = [];
const human = {
  id: 7, faction: FACTION.MARINE, state: 0, node: 0, x: 4, y: 3, deck: 1,
  lastHurtBy: 3, lastHurtTick: 12, deathImpulse: jumping,
};
humanDeathToCorpse({ graph, spawn: (agent) => spawned.push(agent) }, human);
assert.equal(spawned.length, 1);
assert.deepEqual(spawned[0].deathImpulse, jumping,
  'the fatal strike impulse must survive human-to-corpse conversion for the ragdoll');

console.log('melee physics ✓');
