// Combat and damage model (§7): node-local exchanges, integrity vs damage,
// downed/self-revive gating, shaft ambush first strikes, vent exposure kills,
// the flamethrower as an economy weapon.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE, makeAgent } from './init.js';
import { explodeCarrier } from './floodExec.js';

export function resolveCombat(sim, dt) {
  const P = sim.P;

  // --- group agents by location key (node, or mid-shaft/vent link) ---
  const groups = new Map();
  for (const a of sim.agents) {
    if (a.dead) continue;
    const key = a.move && a.move.layer !== 'std' ? `L${a.move.layer}${a.move.link.i}` : `N${a.node}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(a);
  }

  // --- vent exposure (§7): a moving infection form can only be seen/shot by
  // someone standing in ONE OF THE TWO ROOMS THE VENT ACTUALLY CONNECTS —
  // not from an adjacent compartment (user note). You have to be at the
  // grating to see through it.
  for (const a of sim.agents) {
    if (a.dead || a.faction !== FACTION.INFECTION || !a.move || a.move.layer !== 'vent') continue;
    const link = a.move.link;
    let watched = false;
    for (const end of [link.a, link.b]) {
      if (sim.occupants(end).some((h) => (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED) && h.hp > 0)) {
        watched = true; break;
      }
    }
    if (watched && sim.rng.chance(P.hive.ventKillProbPerSec * dt)) {
      sim.removeAgent(a);
      sim.stats.formsShotInVents++;
      sim.log('vent', `an infection form is shot through a vent grating (${sim.graph.node(link.a).name} ↔ ${sim.graph.node(link.b).name})`);
    }
  }

  // --- shaft ambush first strikes (§7): whoever moves loses the corner ---
  for (const [key, group] of groups) {
    if (!key.startsWith('Lshaft')) continue;
    const linkIdx = Number(key.slice(6));
    const shaft = sim.graph.shafts[linkIdx];
    const ambushers = [...(shaft.ambushers ?? [])].map((id) => sim.byId.get(id))
      .filter((x) => x && !x.dead && x.hp > 0);
    for (const mover of group) {
      if (mover.firstStruckIn === linkIdx) continue;
      for (const amb of ambushers) {
        if (amb.faction === mover.faction) continue;
        const hostile = isFlood(amb) !== isFlood(mover);
        if (!hostile) continue;
        mover.firstStruckIn = linkIdx;
        const dps = amb.faction === FACTION.COMBAT ? P.combat.combatForm.dps : P.combat.marine.dps;
        const strike = dps * P.ambush.firstStrikeMult;
        sim.log('ambush', `ambush sprung in the ${sim.graph.node(shaft.a).name} ↔ ${sim.graph.node(shaft.b).name} shaft`);
        if (isFlood(mover)) hurtFloodForm(sim, mover, strike, false);
        else sim.hurtHuman(mover, strike);
      }
    }
    // an ambusher fights anything that survived into its segment
    for (const amb of ambushers) {
      const foes = group.filter((m) => isFlood(m) !== isFlood(amb) && m.hp > 0 && !m.dead);
      for (const foe of foes) {
        const dps = amb.faction === FACTION.COMBAT ? P.combat.combatForm.dps : P.combat.marine.dps;
        if (isFlood(foe)) hurtFloodForm(sim, foe, dps * dt, false);
        else sim.hurtHuman(foe, dps * dt);
      }
    }
  }

  // --- node combat ---
  for (const [key, group] of groups) {
    if (!key.startsWith('N')) continue;
    const node = Number(key.slice(1));

    const shooters = group.filter((a) => a.hp > 0 && !a.dead &&
      ((a.faction === FACTION.MARINE && !sim.squads[a.squad]?.broken) ||
        (a.faction === FACTION.MARINE) ||
        (a.faction === FACTION.ARMED && a.state === STATE.FIGHT)));
    const combatForms = group.filter((a) => a.faction === FACTION.COMBAT && !a.downed && a.hp > 0 && !a.dead);
    const infForms = group.filter((a) => a.faction === FACTION.INFECTION && a.hp > 0 && !a.dead);
    const carriers = group.filter((a) => a.faction === FACTION.CARRIER && a.hp > 0 && !a.dead);
    const downedForms = group.filter((a) => a.faction === FACTION.COMBAT && a.downed && !a.dead && a.damage < 100);
    const anyFlood = combatForms.length + infForms.length + carriers.length > 0;
    if (!shooters.length && !anyFlood) continue;

    if (shooters.length && anyFlood) {
      sim.gunfireAt(node);
      // flamethrower: kills are permanent (damage -> 100) and the node burns
      const flamer = shooters.find((s) => s.flamer && s.fuel > 0);
      let flameDps = 0;
      if (flamer) {
        flameDps = P.flamethrower.dps;
        flamer.fuel = Math.max(0, flamer.fuel - P.flamethrower.fuelPerSec * dt);
        sim.graph.burningUntil[node] = sim.t + P.flamethrower.burnNodeSec;
      }
      const gunDps = shooters.reduce((s, a) => s + (a.faction === FACTION.MARINE ? P.combat.marine.dps : P.combat.armed.dps), 0)
        - (flamer ? P.combat.marine.dps : 0);

      // focus fire: combat forms, then carriers (deterministic by id)
      let pool = gunDps * dt;
      let flamePool = flameDps * dt;
      const targets = [...combatForms, ...carriers].sort((a, b) => a.id - b.id);
      for (const t of targets) {
        if (flamePool > 0) {
          const d = Math.min(flamePool, t.hp);
          flamePool -= d;
          hurtFloodForm(sim, t, d, true);
        }
        if (t.hp > 0 && pool > 0) {
          const d = Math.min(pool, t.hp);
          pool -= d;
          hurtFloodForm(sim, t, d, false);
        }
        if (pool <= 0 && flamePool <= 0) break;
      }
      // stomp infection forms (they're fragile, §6.6)
      let stomps = shooters.reduce((s, a) => s + (a.faction === FACTION.MARINE ? P.combat.marine.stompPerSec : P.combat.armed.stompPerSec), 0) * dt;
      for (const f of [...infForms].sort((a, b) => a.id - b.id)) {
        if (stomps <= 0) break;
        if (sim.rng.chance(Math.min(1, stomps))) { sim.removeAgent(f); sim.stats.infectionFormsKilled++; }
        stomps -= 1;
      }
    } else if (shooters.length && downedForms.length) {
      // no live threat: marines put confirming rounds into downed forms —
      // this is what removes bodies from the hive's economy without fire
      const marines = shooters.filter((s) => s.faction === FACTION.MARINE);
      if (marines.length) {
        const t = downedForms.sort((a, b) => a.id - b.id)[0];
        t.damage = Math.min(100, t.damage + 40 * dt * marines.length);
        if (t.damage >= 100) sim.log('combat', `marines make sure of a downed form in ${sim.graph.node(node).name}`);
      }
    }

    // flood attacks: combat forms focus armed targets first. A form whose
    // host carried a weapon fires it too (lore) — wildly, but it adds up.
    if (combatForms.length) {
      const victims = group.filter((a) => a.hp > 0 && !a.dead &&
        (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN))
        .sort((a, b) => (rank(a) - rank(b)) || (a.id - b.id));
      if (victims.length) {
        let pool = combatForms.reduce((s, f) =>
          s + P.combat.combatForm.dps + (f.hostArmed ? P.combat.hostWeaponDps : 0), 0) * dt;
        for (const v of victims) {
          if (pool <= 0) break;
          const d = Math.min(pool, v.hp);
          pool -= d;
          sim.hurtHuman(v, d);
        }
      }
    }
    // threatened carriers detonate early (§6.6)
    for (const c of carriers) {
      if (shooters.length && c.hp < c.maxHp * 0.5) explodeCarrier(sim, c);
    }
  }
}

function rank(a) {
  // combat forms hit shooters first
  return a.faction === FACTION.MARINE ? 0 : a.faction === FACTION.ARMED ? 1 : 2;
}

export function isFlood(a) {
  return a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER;
}

// integrity -> downed -> (self-revive | reanimate | permanent) per §7
export function hurtFloodForm(sim, a, dmg, isFlame) {
  const P = sim.P;
  if (a.faction === FACTION.INFECTION) {
    if (isFlame) a.damage = 100;
    sim.removeAgent(a);
    sim.stats.infectionFormsKilled++;
    return;
  }
  a.hp -= dmg;
  if (isFlame) a.damage = Math.min(100, a.damage + dmg * 2);
  else if (a.downed) a.damage = Math.min(100, a.damage + dmg);
  if (a.hp <= 0 && !a.downed) {
    if (isFlame) a.damage = 100;
    if (a.faction === FACTION.CARRIER) { explodeCarrier(sim, a); return; }
    a.hp = 0;
    a.downed = true;
    a.state = STATE.DOWNED;
    a.task = null; a.path = []; a.move = null;
    if (a.inShaftAmbush !== undefined) clearAmbush(sim, a);
    sim.stats.combatFormsDowned++;
    // §7: a downed form is not safely dead
    if (a.damage < 100 && sim.rng.chance(P.combatForm.selfReviveChance)) {
      a.reviveAt = sim.t + sim.rng.range(0, P.combatForm.selfReviveWindowSec);
    }
    if (a.damage >= 100) a.dead = false; // stays as a burned husk marker
  }
}

function clearAmbush(sim, a) {
  const shaft = sim.graph.shafts[a.inShaftAmbush];
  shaft?.ambushers?.delete(a.id);
  a.inShaftAmbush = undefined;
}

// humans dying leave convertible bodies behind
export function humanDeathToCorpse(sim, a) {
  a.dead = true;
  const corpse = makeAgent(FACTION.CORPSE, a.node, sim.graph);
  corpse.state = STATE.DEAD;
  corpse.damage = 15; // shot up a little, still carrier food
  corpse.x = a.x; corpse.y = a.y;
  // the host's weapon falls with the body — a combat form raised from it
  // picks the weapon back up (lore)
  corpse.wasArmed = a.faction === FACTION.ARMED || a.faction === FACTION.MARINE;
  sim.spawn(corpse);
}
