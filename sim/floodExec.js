// Flood form actuation: executes hive tasks each movement tick, plus carrier
// production (§6.6) and the self-revive/reanimation timers (§7).

import { FACTION } from '../shared/agentBuffer.js';
import { STATE, makeAgent } from './init.js';
import { TASK } from './hive.js';

export function updateFloodTick(sim, dt) {
  const hive = sim.hive;
  for (const a of sim.agents) {
    if (a.dead) continue;
    if (a.faction === FACTION.CARRIER) { updateCarrier(sim, a, dt); continue; }
    if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT) continue;

    // self-revive (§7)
    if (a.downed) {
      if (a.reviveAt >= 0 && sim.t >= a.reviveAt && a.damage < 100) {
        a.downed = false; a.reviveAt = -1;
        a.hp = a.maxHp * sim.P.combatForm.reviveIntegrityFrac;
        a.state = STATE.IDLE;
        sim.log('revive', `a downed combat form drags itself back up in ${sim.graph.node(a.node).name}`);
      }
      continue;
    }
    if (a.hp <= 0) continue;

    // safety: GRABBING is only legal while a GRAB task is live
    if (a.state === STATE.GRABBING && a.task?.kind !== TASK.GRAB) { a.state = STATE.IDLE; a.grabTimer = 0; }

    // survival reflex: an infection form standing among shooters dives for
    // the safest opening NOW instead of waiting for the 2.5 s strategic
    // brain — the currency is too precious to stand in a fire lane
    if (a.faction === FACTION.INFECTION && !a.move && a.state !== STATE.GRABBING
      && (sim.hive.lastScarcity ?? 3) > 0.8) {
      const hot = sim.occupants(a.node).some((h) => h.hp > 0 && !h.dead &&
        (h.faction === FACTION.MARINE || (h.faction === FACTION.ARMED && h.state === STATE.FIGHT)));
      if (hot) {
        let best = null, bestDanger = Infinity;
        for (const { to, link } of sim.graph.neighbors(a.node, ['std', 'vent'],
          (l) => (l.kind === 'std' ? !l.locked : !l.blocked))) {
          if (sim.graph.burningUntil[to] > sim.t) continue;
          // a vent breaks pursuit outright — marines can't follow into it —
          // so it's the preferred bolt-hole unless the far grating is manned
          let danger = link.kind === 'vent' ? -0.5 : 0;
          for (const h of sim.occupants(to)) {
            if (h.hp > 0 && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)) danger += 2;
          }
          if (danger < bestDanger) { bestDanger = danger; best = { to, link }; }
        }
        if (best) {
          a.path = [];
          sim.setPath(a, [{ to: best.to, link: best.link, layer: best.link.kind }]);
          a.state = STATE.MOVE;
          continue;
        }
      }
    }

    // OPPORTUNISTIC INFECTION: a live human standing in a form's own node is
    // a free conversion and a silenced witness — take them immediately,
    // whatever the form was told to do. Guns normally make it a fight for
    // combat.js instead of a grab — BUT a big enough pack overwhelms the
    // guns (user note): when local flood strength outweighs the shooters
    // ~2:1, grabs work THROUGH the gunfire and even marines get taken. The
    // swarm eats stomp losses; that's the price of the pile-on.
    // (not mid-edge — yanking a form already in transit off a node back to a
    // corpse behind it created an eating carousel. A queued-but-not-departed
    // path does NOT block eating: standing in a corpse room beats walking.)
    if (a.faction === FACTION.INFECTION && !a.downed && a.hp > 0 && a.state !== STATE.GRABBING
      && !a.move
      && a.task?.kind !== TASK.CONVERT && a.task?.kind !== TASK.REANIMATE) {
      const here = sim.occupants(a.node);
      let gunsW = 0;
      for (const h of here) {
        if (h.hp <= 0 || h.dead) continue;
        if (h.faction === FACTION.MARINE) gunsW += 1;
        else if (h.faction === FACTION.ARMED && h.state === STATE.FIGHT) gunsW += 0.6;
      }
      const overwhelmed = gunsW > 0 && sim.floodStrengthAt(a.node) >= gunsW * sim.P.swarm.overwhelmRatio;
      if (gunsW === 0 || overwhelmed) {
        const prey = here.find((h) => h.hp > 0 && !h.dead &&
          (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED
            || (overwhelmed && h.faction === FACTION.MARINE)));
        if (prey && a.task?.targetId !== prey.id) {
          hive.assign(a, { kind: TASK.GRAB, targetId: prey.id });
        } else if (!prey) {
          // ALWAYS INFECT (user rule, no exceptions): bodies in the room get
          // burrowed into IMMEDIATELY and IN PARALLEL — each form claims its
          // own corpse, the 3s conversions all run at once, and every form
          // that can't claim a body flees. One fast wave, then gone. No
          // serial grazing window (that read as "sitting on the crash site").
          const corpse = here.find((c) => c.faction === FACTION.CORPSE && !c.dead && c.damage < 100 && !c.claimed);
          if (corpse) {
            corpse.claimed = true;
            hive.assign(a, { kind: TASK.CONVERT, corpseId: corpse.id });
          }
        }
      }
    }

    const t = a.task;
    if (!t) continue;
    switch (t.kind) {
      case TASK.MOVE:
      case TASK.SCOUT:
      case TASK.GUARD:
        moveToward(sim, a, t.node);
        if (a.node === t.node && !a.move && (t.kind === TASK.MOVE || t.kind === TASK.SCOUT)) a.task = null;
        break;

      case TASK.ATTACK:
        // no direct-route fallback on an assault: if the objective can't be
        // reached without crossing a DIFFERENT gun line, the attack is off
        moveToward(sim, a, t.node, (from, to) => hive.safeAssaultPath(from, to));
        // open aggression is a hunt, not a post: if the room is empty but
        // prey is visible next door, PRESS THE ATTACK into that room (this
        // is what left forms standing in a cleared room forever, staring at
        // survivors through a doorway); if nothing is visible, stand down
        if (a.node === t.node && !a.move) {
          let preyNode = -1;
          for (const n of sim.visibleNodes(a.node)) {
            if (sim.occupants(n).some((h) => h.hp > 0 && !h.dead &&
              (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE))) {
              preyNode = n; break;
            }
          }
          if (preyNode === -1) a.task = null;
          else if (preyNode !== a.node) {
            // muster rule (user): never press into defenders you don't
            // outnumber ~2:1 — hold at the doorway; reinforcements gather
            let def = 0;
            for (const h of sim.occupants(preyNode)) {
              if (h.hp <= 0 || h.dead) continue;
              if (h.faction === FACTION.MARINE) def += 1;
              else if (h.faction === FACTION.ARMED) def += 0.6;
            }
            const local = sim.floodStrengthAt(a.node) + sim.floodStrengthAt(preyNode);
            if (def === 0 || local >= def * sim.P.swarm.killRatio) t.node = preyNode; // go
            // else hold — the pack builds up here until the odds are right
          }
        }
        break;

      case TASK.GRAB: {
        const target = sim.byId.get(t.targetId);
        if (!target || target.dead || target.hp <= 0) {
          a.task = null;
          if (a.state === STATE.GRABBING) { a.state = STATE.IDLE; a.grabTimer = 0; }
          break;
        }
        const believed = hive.beliefs.get(t.targetId);
        const goal = sim.visibleNodes(a.node).includes(target.node) ? target.node : (believed?.node ?? target.node);
        if (a.node === target.node) {
          // it's latched on: pin the victim so they can't run, and take them.
          // An unarmed civilian is converted almost instantly (user note);
          // an armed target takes a little longer. Marines/armed-in-a-fight
          // are still resolved by combat.js (a grab there gets the form
          // stomped), so this only sticks against the overwhelmed.
          a.state = STATE.GRABBING;
          a.move = null; a.path = [];
          if (sim.P.combat.grabPins) target.held = sim.tickCount;
          a.grabTimer += dt;
          const need = target.faction === FACTION.CIVILIAN ? sim.P.combat.civilianGrabSec : sim.P.combat.infectionGrabSec;
          if (a.grabTimer >= need) convertHuman(sim, a, target);
        } else {
          a.state = STATE.MOVE; a.grabTimer = 0;
          moveToward(sim, a, goal, hive.safeInfectionPath.bind(hive));
          if (!a.move && !a.path.length && a.node !== goal) a.task = null; // unreachable
        }
        break;
      }

      case TASK.CONVERT: {
        const body = sim.byId.get(t.corpseId);
        if (!body || body.dead || body.damage >= 100) { a.task = null; break; }
        if (a.node === body.node && !a.move) {
          a.taskProgress += dt;
          if (a.taskProgress >= sim.P.combat.corpseConvertSec) {
            body.dead = true;
            spawnCombatForm(sim, a.node);
            sim.stats.conversions++; sim.stats.conversionsRound++;
            sim.removeAgent(a); // the infection form is spent (§6.6)
            sim.log('convert', `a corpse rises as a combat form in ${sim.graph.node(a.node).name}`);
          }
        } else moveToward(sim, a, body.node, hive.safeInfectionPath.bind(hive));
        break;
      }

      case TASK.TRANSFORM: {
        // a combat form roots itself into a carrier (user economy: carriers
        // are converted combat forms, and the hive picks the ratio). Do it in
        // place — the hive only assigns this to a form already in a safe den.
        if (a.faction !== FACTION.COMBAT || a.downed) { a.task = null; break; }
        if (a.move) break;
        a.taskProgress += dt;
        if (a.taskProgress >= sim.P.carrier.transformSec) {
          const carrier = makeAgent(FACTION.CARRIER, a.node, sim.graph);
          carrier.hp = carrier.maxHp = sim.P.combat.carrierHp;
          carrier.state = STATE.INCUBATING;
          // incubation began the moment the transformation started (user
          // note) — the rooting time counts toward the first mint
          carrier.mintTimer = a.taskProgress;
          sim.spawn(carrier);
          sim.removeAgent(a); // the combat form BECOMES the carrier
          sim.stats.carriersSeated++;
          sim.log('carrier', `a combat form roots into a carrier in ${sim.graph.node(a.node).name} — incubation begins`);
        }
        break;
      }

      case TASK.REANIMATE: {
        const target = sim.byId.get(t.targetId);
        if (!target || target.dead || !target.downed || target.damage >= 100) { a.task = null; break; }
        if (a.node === target.node && !a.move) {
          a.taskProgress += dt;
          if (a.taskProgress >= sim.P.combatForm.reanimateTimeSec) {
            target.downed = false; target.reviveAt = -1;
            target.hp = target.maxHp * sim.P.combatForm.reanimateIntegrityFrac;
            sim.removeAgent(a); // costs 1 infection form (§7)
            sim.log('reanimate', `the hive spends a form to reanimate a body in ${sim.graph.node(target.node).name}`);
          }
        } else moveToward(sim, a, target.node, hive.safeInfectionPath.bind(hive));
        break;
      }

      case TASK.DRAG: {
        const body = sim.byId.get(t.corpseId);
        if (!body || body.dead || body.damage >= 100) { a.task = null; a.dragging = -1; break; }
        if (a.dragging !== body.id && a.node === body.node && !a.move) a.dragging = body.id;
        if (a.dragging === body.id) {
          body.node = a.node; body.x = a.x; body.y = a.y - 4;
          if (a.node === t.node && !a.move) { a.dragging = -1; a.task = null; body.claimed = false; }
          else moveToward(sim, a, t.node);
        } else moveToward(sim, a, body.node);
        break;
      }

      case TASK.AMBUSH: {
        // park mid-shaft at the corner nearest t.end and hold (§7)
        const link = sim.graph.shafts[t.linkIdx];
        if (a.inShaftAmbush === t.linkIdx) break; // waiting
        if (a.node === t.end && !a.move) {
          a.inShaftAmbush = t.linkIdx;
          a.state = STATE.AMBUSHING;
          (link.ambushers ??= new Set()).add(a.id);
        } else moveToward(sim, a, t.end);
        break;
      }

      case TASK.DECOY: {
        // stage 0: run to the show node and be conspicuous until a human
        // sees us (their calls now point AWAY from the dens); stage 1: evade
        // to quiet ground — job done, time bought.
        if (t.stage === 0) {
          if (a.node !== t.show) moveToward(sim, a, t.show);
          else {
            const seen = sim.occupantsNear(a.node, 1).some((h) => !h.dead && h.hp > 0 &&
              (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED));
            if (seen) {
              t.stage = 1;
              const quiet = hive.quietNodeNear(a.node, 'big');
              t.hide = quiet !== -1 ? quiet : a.node;
              sim.log('bait', 'the decoy has been spotted — it melts away');
            }
          }
        } else {
          if (a.node !== t.hide) moveToward(sim, a, t.hide);
          else if (!a.move) a.task = null; // gone to ground; hive re-tasks
        }
        break;
      }

      case TASK.BAIT: {
        const squad = sim.squads[t.squadId];
        const shaft = sim.graph.shafts[t.shaftIdx];
        if (!squad || squad.broken) { a.task = null; break; }
        if (t.stage === 0) {
          // stand at the shaft mouth until a marine sees us
          if (a.node !== t.mouth) moveToward(sim, a, t.mouth);
          else {
            const seen = sim.occupantsNear(a.node, 1).some((h) => h.faction === FACTION.MARINE && h.hp > 0);
            if (seen) { t.stage = 1; sim.log('bait', 'the bait shows itself and slips into the shaft'); }
          }
        } else {
          // flee through the shaft past the ambush corners
          const far = a.node === shaft.a ? shaft.b : shaft.a;
          if (a.node === shaft.a || a.node === shaft.b) {
            if (!a.move) sim.setPath(a, [{ to: far, link: shaft, layer: 'shaft' }]);
          } else if (!a.move && !a.path.length) a.task = null; // escaped; done
        }
        break;
      }
    }
  }
}

function moveToward(sim, a, node, pathFn = null) {
  if (a.move || a.path.length || a.node === node) return;
  const hive = sim.hive;
  let path;
  if (pathFn) path = pathFn(a.node, node);
  else if (a.faction === FACTION.INFECTION) path = hive.safeInfectionPath(a.node, node);
  // combat forms route AROUND remembered gun lines — the plain shortest path
  // marched every form transiting near the last stand straight through it,
  // one at a time (fall back to the direct route only when there is none)
  else path = hive.safeAssaultPath(a.node, node)
    ?? sim.graph.path(a.node, node, ['std', 'shaft'], hive.bigPass);
  if (path && path.length) sim.setPath(a, path);
  else if (!path) a.task = null; // believed-unreachable; hive will reassign
}

export function spawnCombatForm(sim, node) {
  const f = makeAgent(FACTION.COMBAT, node, sim.graph);
  const cf = sim.P.combat.combatForm;
  // ±hpJitter so 2-marine fights are a genuine coin-flip, not a fixed result
  const j = 1 + sim.rng.range(-cf.hpJitter, cf.hpJitter);
  f.hp = f.maxHp = cf.hp * j;
  sim.spawn(f);
  return f;
}

function updateCarrier(sim, a, dt) {
  const P = sim.P;
  if (a.hp <= 0 || a.dead) return;
  // Minting runs the moment the carrier forms and is INDEPENDENT of whether
  // it's relocating/hiding (user note) — the timer always advances, so a
  // carrier being dragged to safety keeps gestating.
  a.mintTimer += dt;
  // production backpressure: a hive drowning in forms pauses incubating
  // (also keeps the agent buffer within its 512 capacity)
  if (sim.agents.reduce((n, x) => n + (!x.dead && x.faction === FACTION.INFECTION ? 1 : 0), 0) >= P.carrier.productionBackpressure) return;
  // §6.6: first form comes quickly, then ~1 per interval up to the cap
  const due = a.minted === 0 ? P.carrier.firstIncubationSec : P.carrier.incubationIntervalSec;
  if (a.mintTimer >= due) {
    a.mintTimer = 0;
    a.minted++;
    const f = makeAgent(FACTION.INFECTION, a.node, sim.graph);
    f.hp = f.maxHp = 1;
    sim.spawn(f);
    sim.stats.formsMinted++;
    if (a.minted === 1) sim.log('carrier', `first infection form minted in ${sim.graph.node(a.node).name}`);
    if (a.minted >= P.carrier.maxInfectionForms) {
      a.dead = true;
      const corpse = makeAgent(FACTION.CORPSE, a.node, sim.graph);
      corpse.state = STATE.DEAD; corpse.damage = 100; // spent husk
      sim.spawn(corpse);
      sim.log('carrier', `a spent carrier collapses in ${sim.graph.node(a.node).name} (${a.minted} forms produced)`);
    }
  }
  // near-full carrier seeks humans to detonate on (§6.6)
  if (a.minted >= P.carrier.maxInfectionForms * P.carrier.seekOrExplodeFraction) {
    const nearHumans = sim.occupantsNear(a.node, 1).filter((h) => h.hp > 0 &&
      (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE));
    if (nearHumans.length && !a.move && !a.path.length && nearHumans[0].node !== a.node) {
      const path = sim.graph.path(a.node, nearHumans[0].node, ['std'], sim.hive.bigPass);
      if (path) sim.setPath(a, path);
    }
    if (nearHumans.some((h) => h.node === a.node)) explodeCarrier(sim, a);
  }
}

export function explodeCarrier(sim, a) {
  if (a.dead) return;
  a.dead = true;
  const P = sim.P;
  for (const h of sim.occupants(a.node)) {
    if (h.hp > 0 && (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE)) {
      sim.hurtHuman(h, P.carrier.explodeDamage);
    }
  }
  for (let i = 0; i < P.carrier.explodeRelease; i++) {
    const f = makeAgent(FACTION.INFECTION, a.node, sim.graph);
    f.hp = f.maxHp = 1;
    sim.spawn(f);
  }
  sim.log('carrier', `a carrier detonates in ${sim.graph.node(a.node).name}`);
}

function convertHuman(sim, form, target) {
  // a grab that reaches a radio-haver may get a scream out (§6.5 penalty)
  if (target.hasRadio && !target.calledOut) {
    target.calledOut = true;
    if (sim.rng.chance(0.5)) sim.emitCall(target);
  }
  target.dead = true;
  spawnCombatForm(sim, target.node);
  sim.removeAgent(form); // 1 infection form spent on a living host (§6.6)
  sim.stats.conversions++; sim.stats.conversionsRound++;
  sim.stats.humansConverted++;
  sim.log('convert', `${factionName(target.faction)} taken in ${sim.graph.node(target.node).name} — a new combat form stands up`);
}

function factionName(f) {
  return f === FACTION.CIVILIAN ? 'a civilian' : f === FACTION.ARMED ? 'an armed crewman' : 'a marine';
}
