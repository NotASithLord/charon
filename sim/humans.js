// Human & marine AI (§5). Civilian FSM with panic contagion and unreliable
// radio; armed humans that fight only from strength or desperation; marine
// squads with a shared blackboard, the automatic first sweep, distress-call
// convergence, morale, and cautious shaft use.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE } from './init.js';
import { humanPass, marinePass } from './graph.js';

export function updateHumansTick(sim, dt) {
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0) continue;
    if (a.faction === FACTION.CIVILIAN) updateCivilian(sim, a, dt);
    else if (a.faction === FACTION.ARMED) updateArmed(sim, a, dt);
    else if (a.faction === FACTION.MARINE) updateMarineTick(sim, a, dt);
  }
}

function floodThreatVisible(sim, a) {
  // weighted active flood strength across LOS nodes (§5.1)
  let s = 0;
  for (const n of sim.visibleNodes(a.node)) s += sim.floodStrengthAt(n);
  return s;
}

function hearsTrouble(sim, a) {
  return sim.heardGunfire(a.node) || sim.heardScreams(a.node);
}

// Only trouble within a hop or two rattles an idle civilian into moving —
// distant commotion elsewhere on the ship shouldn't send everyone running
// (user note: crew running around too much before panicking).
function closeTrouble(sim, a) {
  for (const n of sim.nodesNear(a.node, sim.P.civilian.fleeHearingHops)) {
    if (sim.floodStrengthAt(n) > 0) return true;
    if (sim.tickCount - sim.gunfireTick[n] < 30) return true;
  }
  return false;
}

function maybeDistressCall(sim, a, reliability) {
  if (a.calledOut || !a.hasRadio) return;
  a.calledOut = true; // one attempt per agent
  if (sim.rng.chance(reliability)) sim.emitCall(a);
}

// --- civilians (§5.1) ---
function updateCivilian(sim, a, dt) {
  const P = sim.P;
  if (a.helpless) {
    // wounded/prisoners can scream for help but cannot move
    if (floodThreatVisible(sim, a) > 0) maybeDistressCall(sim, a, P.radio.civilianCallReliability);
    return;
  }
  const threat = floodThreatVisible(sim, a);

  // panic contagion: seeing/hearing a panicked neighbor forces a panic roll
  if (!a.panicked) {
    for (const n of sim.visibleNodes(a.node)) {
      if (sim.panickedAt(n) && sim.rng.chance(0.10 * dt * 15)) { a.panicked = true; break; }
    }
  }

  switch (a.state) {
    case STATE.IDLE:
    case STATE.HIDE:
      if (threat > 0) {
        a.state = STATE.ALERT; a.alertTimer = 0.4;
        if (sim.rng.chance(0.35)) a.panicked = true;
        maybeDistressCall(sim, a, P.radio.civilianCallReliability);
      } else if (a.state === STATE.IDLE && closeTrouble(sim, a) && sim.rng.chance(0.5 * dt)) {
        // spooked by nearby trouble: most people shelter in place, they
        // don't sprint down the corridor for no reason (user note)
        if (sim.rng.chance(P.civilian.shelterBias) || a.stayPut) a.state = STATE.HIDE;
        else { a.state = STATE.FLEE; a.hideTimer = 0; }
      }
      break;
    case STATE.ALERT:
      a.alertTimer -= dt;
      if (a.alertTimer <= 0) {
        // officers and other stay-put civilians hold their compartment; they
        // cower rather than run (user note: deck-1 officers who don't leave)
        a.state = a.stayPut ? STATE.COWER : STATE.FLEE;
        a.hideTimer = 0;
      }
      break;
    case STATE.FLEE: {
      if (!a.move && !a.path.length) {
        const next = fleeStep(sim, a);
        if (next === -1) { a.state = STATE.COWER; break; }
        if (next !== null) sim.setPath(a, [next]);
      }
      if (threat === 0 && !a.move) {
        a.hideTimer += dt;
        if (a.hideTimer > 8 && !a.panicked) {
          // duck into the nearest room and hide
          const room = nearestRoom(sim, a.node);
          if (room === a.node) a.state = STATE.HIDE;
          else if (room !== -1 && !a.path.length) sim.setPathTo(a, room, ['std'], humanPass);
        }
      } else a.hideTimer = 0;
      break;
    }
    case STATE.COWER:
      if (threat === 0) a.state = STATE.FLEE;
      break;
  }
}

// pick the neighbor that minimizes flood influence; unreliable when panicked
function fleeStep(sim, a) {
  const opts = [];
  for (const { to } of sim.graph.neighbors(a.node, ['std'], humanPass)) {
    if (sim.graph.node(to).deck !== undefined) opts.push(to);
  }
  if (!opts.length) return -1;
  if (a.panicked || sim.rng.chance(0.25)) return sim.rng.pick(opts); // §5.1 unreliable flight
  let best = null, bestScore = Infinity;
  for (const to of opts) {
    const score = sim.influence.floodStr[to] * 4 + sim.floodStrengthAt(to) * 10 + sim.rng.range(0, 0.3);
    if (score < bestScore) { bestScore = score; best = to; }
  }
  const here = sim.influence.floodStr[a.node] * 4 + sim.floodStrengthAt(a.node) * 10;
  if (bestScore >= here + 1) return -1; // everywhere is worse: cower
  return best;
}

function nearestRoom(sim, from) {
  const targets = sim.graph.nodes.filter((n) => n.type === 'room' && !sim.graph.hasRole(n.idx, 'command')).map((n) => n.idx);
  const ff = sim.graph.flowField(targets, ['std'], humanPass);
  if (ff.dist[from] === -1) return -1;
  let cur = from;
  while (ff.dist[cur] !== 0) cur = ff.next[cur];
  return cur;
}

// --- armed humans (§5.2) ---
function updateArmed(sim, a, dt) {
  const P = sim.P;
  const threatHere = sim.floodStrengthAt(a.node);
  const threat = floodThreatVisible(sim, a);
  const cornered = fleeStep(sim, a) === -1 && threat > 0;

  if (a.state === STATE.FIGHT) {
    if (threat === 0) a.state = STATE.FLEE;
    else if (threatHere > P.combat.armedBraveryStrength && !cornered) a.state = STATE.FLEE;
    return; // combat resolution handles the shooting
  }
  if (threat > 0) {
    maybeDistressCall(sim, a, P.radio.civilianCallReliability * 1.5);
    if (cornered || threatHere <= P.combat.armedBraveryStrength) {
      a.state = STATE.FIGHT; a.path = [];
      return;
    }
  }
  updateCivilian(sim, a, dt); // otherwise flees like a civilian
}

// --- marines (§5.3) ---
function updateMarineTick(sim, a, dt) {
  // command-deck garrison: a permanent detail that never leaves the bridge/
  // CIC (user note). It fights anything that reaches it but never sweeps,
  // answers calls, or takes orders — a fixed strongpoint.
  if (a.garrison) {
    a.state = sim.floodStrengthAt(a.node) > 0 ? STATE.FIGHT : STATE.IDLE;
    a.path = []; a.move = null;
    if (a.state === STATE.FIGHT && a.hasRadio && sim.tickCount % 60 === 0) sim.emitCall(a);
    return;
  }

  const squad = sim.squads[a.squad];
  if (!squad || squad.broken) { updateArmed(sim, a, dt); return; }

  const threat = floodThreatVisible(sim, a);
  if (sim.floodStrengthAt(a.node) > 0) {
    a.state = STATE.FIGHT; a.path = []; // stand and fight on contact
    return;
  }
  if (a.state === STATE.FIGHT) a.state = STATE.MOVE;

  // report contacts to the blackboard + shipwide alert
  if (threat > 0) {
    squad.contactNode = nearestThreatNode(sim, a);
    squad.contactTick = sim.tickCount;
    sim.floodKnown = true;
    if (a.hasRadio && !squad.calledContact) {
      squad.calledContact = true;
      if (sim.rng.chance(sim.P.radio.marineCallReliability)) sim.emitCall(a);
    }
  }

  // follow the squad objective
  if (!a.move && !a.path.length && squad.objective) {
    const target = squad.objective.node;
    if (a.node !== target) {
      // cautious doctrine: corridors first, shafts only when there is no
      // other way (or when in hot pursuit — squad.pursuing)
      let ok = sim.setPathTo(a, target, ['std'], humanPass);
      if (!ok) ok = sim.setPathTo(a, target, ['std', 'shaft'], marinePass);
      if (!ok) squad.objective = null; // truly unreachable
      else a.state = STATE.MOVE;
    }
  }

  // flamethrower economy denial (§7): burn corpse caches once the outbreak
  // is known and the node is quiet
  if (a.flamer && a.fuel > 0 && sim.floodKnown && sim.floodStrengthAt(a.node) === 0) {
    const nd = sim.graph.node(a.node);
    if (nd.roles.includes('corpse_cache') || a.node === sim.graph.breachNode || a.node === sim.burnOrderNode) {
      a.burnTimer = (a.burnTimer || 0) + dt;
      if (a.burnTimer >= 2) {
        a.burnTimer = 0;
        const corpse = sim.agents.find((c) => !c.dead && c.faction === FACTION.CORPSE && c.node === a.node && c.damage < 100);
        if (corpse) {
          corpse.damage = 100;
          a.fuel -= sim.P.flamethrower.fuelPerCorpse;
          sim.stats.corpsesBurned++;
          sim.graph.burningUntil[a.node] = sim.t + sim.P.flamethrower.burnNodeSec;
          if (sim.stats.corpsesBurned % 10 === 1) sim.log('burn', `flamethrower burning bodies in ${nd.name} (fuel ${a.fuel.toFixed(0)})`, a.node);
        }
      }
    }
  }
}

function nearestThreatNode(sim, a) {
  for (const n of sim.visibleNodes(a.node)) if (sim.floodStrengthAt(n) > 0) return n;
  return a.node;
}

// Translate a standing player order (companion spec §2.2/§2.3) into the
// squad objective the movement code already understands. Returns true if the
// order is holding the squad (skip autonomous re-planning this round).
function applySquadOrder(sim, squad, leader) {
  const o = squad.order;
  switch (o.kind) {
    case 'order:move':
      if (leader.node === o.node) {
        // arrived. RESPOND/FALL_BACK are one-shot; plain MOVE_TO holds.
        if (o.respond !== undefined || o.fallback) { squad.order = null; return false; }
        squad.objective = { kind: 'hold', node: o.node };
      } else {
        squad.objective = { kind: 'order', node: o.node };
      }
      return true;
    case 'order:guard':
      squad.objective = { kind: 'order', node: o.node };
      return true;
    case 'order:patrol': {
      const route = o.route;
      if (leader.node === route[o.leg]) o.leg = (o.leg + 1) % route.length;
      squad.objective = { kind: 'order', node: route[o.leg] };
      return true;
    }
    case 'order:escort': {
      const target = sim.byId.get(o.entityId);
      if (!target || target.dead) { squad.order = null; return false; }
      squad.objective = { kind: 'order', node: target.node };
      return true;
    }
    default:
      return false;
  }
}

// --- squad strategic re-planning (§5.3, runs each infection round) ---
export function strategicSquads(sim) {
  const P = sim.P;
  for (const squad of sim.squads) {
    const members = squad.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    // morale: heavy losses break the squad (§5.3)
    if (!squad.broken && members.length > 0 && members.length < Math.ceil(squad.size0 / 2)) {
      squad.broken = true;
      sim.log('morale', `squad ${squad.id + 1} broken — survivors fall back to individual behavior`);
      continue;
    }
    if (squad.broken || members.length === 0) continue;
    const leader = members[0];

    // engaged squads don't re-plan
    if (members.some((m) => m.state === STATE.FIGHT)) continue;

    // launch the mustered crash sweep once the delay elapses (user note)
    if (squad.pendingSweep && sim.t >= sim.P.marineDoctrine.firstSweepDelaySec) {
      squad.pendingSweep = false;
      squad.objective = { kind: 'breach', node: sim.graph.breachNode };
      squad.phase1 = true;
      sim.log('sweep', `squad ${squad.id + 1} moves out to the crash site`);
    }
    if (squad.pendingSweep) continue; // still mustering — hold

    // player command override (companion spec §2.3): a standing order sets
    // the squad's objective and suppresses autonomy until it completes or is
    // RELEASEd. Self-defense and morale still apply (handled per-tick).
    if (squad.order && applySquadOrder(sim, squad, leader)) continue;

    // a squad set to ignore calls (SET_CALL_POLICY) skips the call scan
    const callPolicy = squad.callPolicy ?? 'auto';

    // distress calls: roll reliability once per squad per call (§5.3);
    // this is the MASTER DIAL for coordination efficiency
    for (const call of (callPolicy === 'ignore' ? [] : sim.calls)) {
      if (sim.t - call.t > P.radio.callFadeSec) continue;
      if (call.rolled.has(squad.id)) continue;
      call.rolled.add(squad.id);
      if (!sim.rng.chance(P.radio.marineCallReliability)) {
        sim.log('radio', `squad ${squad.id + 1} missed a distress call (comms damage)`);
        continue;
      }
      if (squad.objective?.kind === 'breach') continue; // first sweep is not diverted
      // dispatch doctrine: the two nearest squads take a call, the rest
      // keep sweeping — otherwise every call empties the whole ship
      const responders = sim.squads.filter((s) => !s.broken && s.respondingTo === call.id).length;
      if (responders >= 2) continue;
      const cur = squad.objective?.kind === 'distress'
        ? sim.graph.hops(leader.node, squad.objective.node, ['std'], humanPass) : Infinity;
      const d = sim.graph.hops(leader.node, call.node, ['std', 'shaft'], marinePass);
      if (d !== -1 && d < cur) {
        squad.objective = { kind: 'distress', node: call.node, callId: call.id };
        squad.respondingTo = call.id;
        sim.log('radio', `squad ${squad.id + 1} responding to distress in ${sim.graph.node(call.node).name}`);
      }
    }

    // fresh contact on the blackboard -> pursue it (enables the hive's bait play)
    if (squad.contactNode !== undefined && sim.tickCount - squad.contactTick < 15 * 10
      && squad.objective?.kind !== 'breach' && sim.rng.chance(0.6)) {
      squad.objective = { kind: 'pursuit', node: squad.contactNode };
    }

    // objective reached & clear -> next objective
    const objNode = squad.objective?.node;
    const arrived = objNode !== undefined && members.every((m) => m.node === objNode || sim.graph.hops(m.node, objNode, ['std', 'shaft'], marinePass) <= 1);
    const clear = objNode !== undefined && sim.visibleNodes(objNode).every((n) => sim.floodStrengthAt(n) === 0);
    if (!squad.objective || (arrived && clear)) {
      if (squad.objective?.kind === 'breach' && !sim.firstSweepCleared) {
        sim.firstSweepCleared = true;
        sim.log('sweep', `first sweep cleared the breach region (${sim.graph.node(sim.graph.breachNode).name})`);
      }
      if (squad.objective?.kind === 'breach' || sim.firstSweepCleared || !squad.objective) {
        // phase 2: independent random sweeps (§5.3), with a dwell pause so
        // the ship isn't saturated with constant patrols
        if (sim.firstSweepCleared || squad.objective) {
          if (squad.holdUntil === undefined || sim.t >= squad.holdUntil) {
            const rooms = sim.graph.nodes.filter((n) => n.type !== 'corridor').map((n) => n.idx)
              .filter((n) => n !== leader.node);
            squad.objective = { kind: 'sweep', node: sim.rng.pick(rooms) };
            squad.holdUntil = sim.t + 25 + sim.rng.range(0, 15);
          }
        } else {
          // before phase 2, non-sweep squads hold near spawn
          squad.objective = { kind: 'hold', node: leader.node };
        }
      }
    }
  }
}

// Assign the automatic first sweep (§5.3 phase 1): the squad with the
// shortest human-traversable path to the breach moves at t=0.
export function assignFirstSweep(sim) {
  let best = null, bestD = Infinity;
  for (const squad of sim.squads) {
    const leader = sim.byId.get(squad.members[0]);
    squad.size0 = squad.members.length;
    const d = sim.graph.hops(leader.node, sim.graph.breachNode, ['std'], humanPass);
    if (d !== -1 && d < bestD) { bestD = d; best = squad; }
  }
  // The crash sweep does NOT launch instantly — the surviving crew is
  // scattered and stunned; the nearest squad musters for firstSweepDelaySec
  // before moving out (user note: initial response should be slower). This
  // widens the window the hive is racing (§6.7).
  if (best) {
    best.pendingSweep = true;
    best.objective = { kind: 'hold', node: sim.byId.get(best.members[0]).node };
    sim.firstSweepSquad = best.id;
    sim.log('sweep', `squad ${best.id + 1} mustering to investigate the crash (${sim.graph.node(sim.graph.breachNode).name}, ${bestD} hops) — moving out in ~${sim.P.marineDoctrine.firstSweepDelaySec}s`);
  }
  for (const squad of sim.squads) {
    if (squad !== best) squad.objective = { kind: 'hold', node: sim.byId.get(squad.members[0]).node };
    squad.size0 = squad.members.length;
  }
}
