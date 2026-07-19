// Combat and damage model (§7): node-local exchanges, integrity vs damage,
// downed/self-revive gating, shaft ambush first strikes, vent exposure kills,
// the flamethrower as an economy weapon.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE, makeAgent } from './init.js';
import { explodeCarrier } from './floodExec.js';

export function resolveCombat(sim, dt) {
  const P = sim.P;

  // --- group agents by PHYSICAL location (user note: real space logic) ---
  // A body is in the room its coordinates are in (a.pnode), the moment it's
  // through the door — not when its pathfinder finishes at the room center.
  // Vent crawlers and cross-deck shaft crawlers are inside the ship's
  // structure and resolve in their own duct/shaft groups; a same-deck shaft
  // crawl crosses open floor, so those movers count as physically present.
  const groups = new Map();
  for (const a of sim.agents) {
    if (a.dead) continue;
    let key;
    if (a.move && a.move.layer === 'vent') key = `Lvent${a.move.link.i}`;
    else if (a.move && a.move.layer === 'shaft'
      && sim.graph.node(a.move.link.a).deck !== sim.graph.node(a.move.link.b).deck) {
      key = `Lshaft${a.move.link.i}`;
    } else key = `N${a.pnode ?? a.node}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(a);
  }

  // --- vent exposure (§7): a moving form can only be seen/shot by someone
  // standing in ONE OF THE TWO ROOMS THE VENT ACTUALLY CONNECTS — not from
  // an adjacent compartment (user note). You have to be at the grating to
  // see through it. An infection form pops to a single round; a combat form
  // squeezed into the duct (user rule: they crawl vents too) is a big target
  // that soaks real fire instead.
  for (const a of sim.agents) {
    if (a.dead || !a.move || a.move.layer !== 'vent') continue;
    if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT) continue;
    const link = a.move.link;
    let watched = false;
    for (const end of [link.a, link.b]) {
      if (sim.occupants(end).some((h) => (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED) && h.hp > 0)) {
        watched = true; break;
      }
    }
    if (!watched) continue;
    if (a.faction === FACTION.INFECTION) {
      if (sim.rng.chance(P.hive.ventKillProbPerSec * dt)) {
        sim.removeAgent(a);
        sim.stats.formsShotInVents++;
        sim.log('vent', `an infection form is shot through a vent grating (${sim.graph.node(link.a).name} ↔ ${sim.graph.node(link.b).name})`);
      }
    } else {
      hurtFloodForm(sim, a, P.combat.marine.dps * dt, false);
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

    // --- PASSING COMBAT (user note): a shaft is a cramped crawlway, not a
    // "track" two hostiles can glide past each other on unnoticed — anyone
    // sharing the segment fights immediately, exactly like node combat,
    // even if neither side is a parked ambusher (that case, above, gets the
    // first-strike bonus instead; this is the general "we just met" case).
    const shooters = group.filter((a) => a.hp > 0 && !a.dead &&
      (a.faction === FACTION.MARINE || (a.faction === FACTION.ARMED && a.state === STATE.FIGHT)));
    const combatForms = group.filter((a) => a.faction === FACTION.COMBAT && !a.downed && a.hp > 0 && !a.dead);
    const carriers = group.filter((a) => a.faction === FACTION.CARRIER && a.hp > 0 && !a.dead);
    const humans = group.filter((a) => a.hp > 0 && !a.dead &&
      (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
    if (shooters.length && (combatForms.length || carriers.length)) {
      sim.gunfireAt(shaft.a); sim.gunfireAt(shaft.b);
      let pool = shooters.reduce((s, a) => s + (a.faction === FACTION.MARINE ? P.combat.marine.dps : P.combat.armed.dps), 0) * dt;
      for (const t of [...combatForms, ...carriers].sort((a, b) => a.id - b.id)) {
        if (pool <= 0) break;
        const d = Math.min(pool, t.hp);
        pool -= d;
        hurtFloodForm(sim, t, d, false);
      }
    }
    if (combatForms.length && humans.length) {
      let pool = combatForms.reduce((s, f) =>
        s + P.combat.combatForm.dps + (f.hostArmed ? P.combat.hostWeaponDps : 0), 0) * dt;
      for (const v of humans.sort((a, b) => (rank(a) - rank(b)) || (a.id - b.id))) {
        if (pool <= 0) break;
        const d = Math.min(pool, v.hp);
        pool -= d;
        sim.hurtHuman(v, d);
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
      // flamethrower: a continuous stream — kills are permanent, the node burns
      const flamer = shooters.find((s) => s.flamer && s.fuel > 0);
      const targets = [...combatForms, ...carriers].sort((a, b) => a.id - b.id);
      if (flamer && targets.length) {
        flamer.fuel = Math.max(0, flamer.fuel - P.flamethrower.fuelPerSec * dt);
        sim.graph.burningUntil[node] = sim.t + P.flamethrower.burnNodeSec;
        let flamePool = P.flamethrower.dps * dt;
        for (const t of targets) {
          if (flamePool <= 0) break;
          const d = Math.min(flamePool, t.hp);
          flamePool -= d;
          hurtFloodForm(sim, t, d, true);
        }
      }
      // HALO-STANDARD RIFLES (user note): each shooter fires DISCRETE aimed
      // shots on its own cadence and ROLLS to hit — accuracy drops past
      // rifleFalloffM (a sprinting form in a dark ship is a hard target).
      // Deterministic: cadence is sim-time, rolls come from the seeded RNG,
      // so lockstep multiplayer holds. Nearest combat form first; a carrier
      // only draws fire when no combat form is standing.
      for (const s of shooters) {
        if (s === flamer) continue;
        if (sim.t < (s.nextShotAt ?? 0)) continue;
        let best = null, bestD = Infinity;
        for (const t of targets) {
          if (t.hp <= 0 || t.dead) continue;
          const d = Math.hypot(t.x - s.x, t.y - s.y) + (t.faction === FACTION.CARRIER ? 1000 : 0);
          if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && t.id < (best?.id ?? Infinity))) { bestD = d; best = t; }
        }
        if (!best) break;
        const gun = s.faction === FACTION.MARINE ? P.combat.marine.gun : P.combat.armed.gun;
        s.nextShotAt = sim.t + 1 / gun.rof;
        const range = Math.hypot(best.x - s.x, best.y - s.y);
        const acc = range <= P.combat.rifleFalloffM ? gun.accNear : gun.accFar;
        if (sim.rng.chance(acc)) hurtFloodForm(sim, best, gun.dmg, false);
      }
      // stomp infection forms (they're fragile, §6.6) — but only the ones
      // that have actually closed with a shooter (real space: you boot or
      // point-fire what's at your feet, not a form skittering 30m away)
      // a shooter with a form LATCHED ON is wrestling it, not aiming — half
      // effectiveness (the point-blank risk is real for a lone marine; a
      // squadmate's boot is what saves you)
      let stomps = shooters.reduce((s, a) => s +
        (a.faction === FACTION.MARINE ? P.combat.marine.stompPerSec : P.combat.armed.stompPerSec)
        * (a.held === sim.tickCount ? 0.5 : 1), 0) * dt;
      for (const f of [...infForms].sort((a, b) => a.id - b.id)) {
        if (stomps <= 0) break;
        if (!shooters.some((s) => Math.hypot(s.x - f.x, s.y - f.y) <= P.combat.stompRangeM)) continue;
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

    // flood attacks — REAL REACH (user note): claws only land on a victim
    // the form has physically closed with (meleeRangeM); a hosted weapon
    // fires across the room. Each form fights the nearest body (shooters
    // preferred on near-ties), so a pack spreads across a line instead of
    // resolving as one abstract damage pool at the room's center.
    if (combatForms.length) {
      const victims = group.filter((a) => a.hp > 0 && !a.dead &&
        (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
      if (victims.length) {
        let fired = false;
        for (const f of [...combatForms].sort((a, b) => a.id - b.id)) {
          let best = null, bestScore = Infinity;
          for (const v of victims) {
            if (v.hp <= 0 || v.dead) continue;
            const d = Math.hypot(v.x - f.x, v.y - f.y);
            const score = d + rank(v) * 0.5 + v.id * 1e-6;
            if (score < bestScore) { bestScore = score; best = v; }
          }
          if (!best) break;
          const range = Math.hypot(best.x - f.x, best.y - f.y);
          // MELEE IS THE FLOOD'S WEAPON (user rule: >90% of hosts died
          // unarmed): sprint/leap to arm's reach, then a heavy SWIPE on a
          // cooldown — discrete hits that knock chunks off armor, with a
          // real recovery gap between swings to shoot it in
          if (range <= P.combat.meleeRangeM && sim.t >= (f.nextSwingAt ?? 0)) {
            f.nextSwingAt = sim.t + P.combat.combatForm.swing.cooldownSec;
            sim.hurtHuman(best, P.combat.combatForm.swing.dmg);
          }
          // the armed minority spray the host's weapon one-handed (lore) —
          // discrete wild shots, mostly missing
          if (f.hostArmed && sim.t >= (f.nextHostShotAt ?? 0)) {
            f.nextHostShotAt = sim.t + 1 / P.combat.hostGun.rof;
            fired = true;
            const acc = range <= P.combat.rifleFalloffM ? P.combat.hostGun.accNear : P.combat.hostGun.accFar;
            if (sim.rng.chance(acc)) sim.hurtHuman(best, P.combat.hostGun.dmg);
          }
        }
        // a hosted weapon firing is gunfire too — the ship hears it, and
        // renderers get a marked tick to show the flood visibly shooting
        if (fired) sim.gunfireAt(node);
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
