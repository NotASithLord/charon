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
    if (a.isPlayer) continue; // the player thinks for themselves
    // last-stand fallback: survivors who heard the call make for the command
    // deck whenever they aren't actively fighting or fleeing something seen
    if (a.fallbackNode !== undefined && a.node !== a.fallbackNode
      && (a.faction !== FACTION.MARINE || (!a.garrison && sim.squads[a.squad]?.broken))
      && a.state !== STATE.FIGHT && !a.move && !a.path.length
      && floodThreatVisible(sim, a) === 0) {
      if (sim.setPathTo(a, a.fallbackNode, ['std'], humanPass)) a.state = STATE.MOVE;
    } else if (a.armingUp !== undefined && a.fallbackNode === undefined
      && a.faction === FACTION.CIVILIAN && a.state !== STATE.FIGHT
      && !a.move && !a.path.length && floodThreatVisible(sim, a) === 0) {
      // panic-driven armory run (user note): reach the rack, take a rifle
      if (a.node === a.armingUp) {
        const took = (sim.armoryStock ?? 0) > 0;
        a.armingUp = undefined;
        if (took) {
          sim.armoryStock--;
          a.faction = FACTION.ARMED;
          a.hp = a.maxHp = Math.max(a.hp, sim.P.combat.armed.hp);
          a.hasRadio = true;
          sim.log('combat', `a civilian arms up at the armory (${sim.armoryStock} rifles left)`);
        }
      } else if (sim.setPathTo(a, a.armingUp, ['std'], humanPass)) a.state = STATE.MOVE;
      else a.armingUp = undefined; // no safe route — give it up
    }
    if (a.faction === FACTION.CIVILIAN) updateCivilian(sim, a, dt);
    else if (a.faction === FACTION.ARMED) updateArmed(sim, a, dt);
    else if (a.faction === FACTION.MARINE) updateMarineTick(sim, a, dt);
  }
}

function floodThreatVisible(sim, a) {
  // weighted active flood strength across LOS nodes (§5.1), anchored on the
  // room the human is PHYSICALLY in (user note: real space logic)
  let s = 0;
  for (const n of sim.visibleNodes(a.pnode ?? a.node)) s += sim.floodStrengthAt(n);
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

  // Panic EXPIRES (user note: no more running back and forth forever). Being
  // panicked is a burst, not a permanent state — it lasts a few seconds past
  // the last thing that scared them, then they go to ground.
  if (threat > 0 && a.panicked) a.panicUntil = sim.t + 8;
  if (a.panicked && sim.t > (a.panicUntil ?? 0) && threat === 0) a.panicked = false;

  // panic contagion: SEEING a panicked neighbor can panic you — and it makes
  // you bolt ONCE, right now, not stand up and jog laps later
  if (!a.panicked && !a.stayPut) {
    for (const n of sim.visibleNodes(a.node)) {
      if (sim.panickedAt(n) && sim.rng.chance(0.06 * dt * 15)) {
        a.panicked = true;
        a.panicUntil = sim.t + 8;
        if (a.state === STATE.IDLE || a.state === STATE.HIDE) {
          a.state = STATE.FLEE; a.hideTimer = 0; a.fleeSteps = 0;
        }
        break;
      }
    }
  }

  // flood in the SAME node = immediate danger, react even from HIDE
  const floodHere = sim.floodStrengthAt(a.node) > 0;

  switch (a.state) {
    case STATE.IDLE:
    case STATE.HIDE:
      // A calm civilian stays put. They move only when they actually SEE the
      // Flood (or a fresh panic bolts them, handled above). No idle wandering,
      // and NO re-bolting from a hiding spot on stale panic.
      if (threat > 0) {
        a.state = STATE.ALERT; a.alertTimer = floodHere ? 0 : 0.3;
        if (sim.rng.chance(floodHere ? 0.9 : 0.4)) { a.panicked = true; a.panicUntil = sim.t + 8; }
        // point-blank contact you SCREAM (local noise), you don't calmly get
        // a coherent call out; a doorway sighting still radios normally
        maybeDistressCall(sim, a, P.radio.civilianCallReliability * (floodHere ? 0.25 : 1));
      } else if (a.worker && a.fallbackNode === undefined && !sim.lastStand
        && !a.move && !a.path.length
        && sim.rng.chance(P.civilian.workMoveChancePerSec * (sim.floodKnown ? 0.5 : 1) * dt)) {
        // the ~20% still working the ship move with purpose — occasionally,
        // not constantly; half as often once the outbreak is common knowledge,
        // and not at all once the fallback call has gone out
        workerRelocate(sim, a);
      }
      break;
    case STATE.ALERT:
      a.alertTimer -= dt;
      if (a.alertTimer <= 0) {
        // stay-put officers hold their compartment and cower; everyone else
        // runs from what they've seen
        a.state = a.stayPut ? STATE.COWER : STATE.FLEE;
        a.hideTimer = 0; a.fleeSteps = 0;
      }
      break;
    case STATE.FLEE: {
      if (!a.move && !a.path.length) {
        const next = fleeStep(sim, a);
        if (next === -1) { a.state = STATE.COWER; break; }
        if (next === null) { a.state = STATE.HIDE; a.panicked = false; break; } // safest spot is right here
        sim.setPath(a, [next]);
        a.lastFledFrom = a.node;
        a.fleeSteps = (a.fleeSteps || 0) + 1;
      }
      // once clear of any visible Flood, stop running and go to ground —
      // don't keep trotting around the ship (this is what made them wander
      // in and out of danger). A short settle, then a sticky HIDE.
      if (threat === 0 && !a.move && !a.path.length) {
        a.hideTimer += dt;
        // going to ground ENDS the episode: hide and calm down, so the same
        // scare can't keep them jogging laps (panic also expires on its own)
        if (a.hideTimer > 1.5 || a.fleeSteps >= 3) { a.state = STATE.HIDE; a.panicked = false; }
      } else a.hideTimer = 0;
      break;
    }
    case STATE.COWER:
      // pinned with no safe exit: keep screaming, bolt only if a way opens
      if (floodHere) maybeDistressCall(sim, a, P.radio.civilianCallReliability);
      if (threat === 0) a.state = STATE.HIDE;
      else if (!floodHere && fleeStep(sim, a) !== -1) { a.state = STATE.FLEE; a.fleeSteps = 0; }
      break;
    case STATE.MOVE:
      // a worker in transit still reacts the instant it sees the Flood
      if (threat > 0) {
        a.path = []; a.state = STATE.ALERT; a.alertTimer = floodHere ? 0 : 0.3;
        if (sim.rng.chance(floodHere ? 0.9 : 0.4)) a.panicked = true;
        maybeDistressCall(sim, a, P.radio.civilianCallReliability * (floodHere ? 0.25 : 1));
      } else if (!a.move && !a.path.length) a.state = STATE.IDLE; // arrived
      break;
  }
}

// A working civilian walks to a system that needs tending, or back to a
// habitable space, staying clear of anywhere it currently sees the Flood.
function workerRelocate(sim, a) {
  if (!a._workNodes) {
    a._workNodes = sim.graph.nodes
      .filter((n) => ['systems', 'power', 'engineering', 'medbay', 'armed', 'quarters', 'soft', 'command'].some((r) => n.roles.includes(r))
        || (a.lowerDecks && ['maintenance', 'cargo', 'vehicles', 'hangar'].some((r) => n.roles.includes(r))))
      .filter((n) => !a.lowerDecks || n.deck >= 4) // lower-deck crew stay below
      .map((n) => n.idx);
  }
  const dest = sim.rng.pick(a._workNodes);
  if (dest === a.node) return;
  if (sim.floodStrengthAt(dest) > 0) return; // don't stroll into a den
  const path = sim.graph.path(a.node, dest, ['std'], humanPass);
  // avoid routing through a compartment that currently holds the Flood
  if (path && !path.some((s) => sim.floodStrengthAt(s.to) > 0)) {
    a.path = path;
    a.state = STATE.MOVE;
  }
}

// Step to the safest neighbor, NEVER toward a node that has Flood in it.
// Returns -1 when every exit is into the Flood or blocked (→ cower), and
// null when staying put is at least as safe as any move — a civilian who can
// merely SEE the Flood through a doorway goes to ground where they are
// instead of ping-ponging between two rooms (user note).
function fleeStep(sim, a) {
  const floodHere = sim.floodStrengthAt(a.node) > 0;
  const safe = [];
  for (const { to } of sim.graph.neighbors(a.node, ['std'], humanPass)) {
    if (sim.floodStrengthAt(to) > 0) continue; // never flee into the Flood
    if (to === a.lastFledFrom && !floodHere) continue; // no backtracking laps
    safe.push(to);
  }
  if (!safe.length) return floodHere ? -1 : null; // trapped: cower / hide here
  if (a.panicked && sim.rng.chance(0.4)) return sim.rng.pick(safe); // blind panic
  let best = null, bestScore = Infinity;
  for (const to of safe) {
    const score = sim.influence.floodStr[to] * 4 + sim.rng.range(0, 0.3);
    if (score < bestScore) { bestScore = score; best = to; }
  }
  // the Flood isn't IN this room: only run if the move genuinely improves
  // things, otherwise hide right here
  if (!floodHere) {
    const here = sim.influence.floodStr[a.node] * 4;
    if (bestScore >= here - 0.4) return null;
  }
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
  const threatHere = sim.floodStrengthAt(a.pnode ?? a.node);
  const threat = floodThreatVisible(sim, a);
  const cornered = fleeStep(sim, a) === -1 && threat > 0;

  if (a.state === STATE.FIGHT) {
    if (threat === 0) a.state = a.stayPut ? STATE.IDLE : STATE.FLEE;
    // stay-put officers hold their post and fight to the end; they never rout
    else if (!a.stayPut && threatHere > P.combat.armedBraveryStrength && !cornered) a.state = STATE.FLEE;
    return; // combat resolution handles the shooting
  }
  if (threat > 0) {
    maybeDistressCall(sim, a, P.radio.civilianCallReliability * 1.5);
    // armed officers holding a post fight anything they see; mobile armed crew
    // fight only when cornered or the visible Flood looks weak (§5.2)
    if (a.stayPut || cornered || threatHere <= P.combat.armedBraveryStrength) {
      // stop and shoot WHERE YOU STAND (user note: real space logic) — no
      // finishing the stroll to the room's center first
      a.state = STATE.FIGHT; a.path = []; a.move = null;
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
    a.state = sim.floodStrengthAt(a.pnode ?? a.node) > 0 ? STATE.FIGHT : STATE.IDLE;
    a.path = []; a.move = null;
    if (a.state === STATE.FIGHT && a.hasRadio && sim.tickCount % 60 === 0) sim.emitCall(a);
    return;
  }

  // ODST reserve sealed in the armory (user rule): until the seal releases
  // they hold the room — posted at the racks, killing anything that crawls
  // in through the ducts, taking no orders and answering no calls.
  if (a.odst && sim.armoryLocked) {
    a.state = sim.floodStrengthAt(a.pnode ?? a.node) > 0 ? STATE.FIGHT : STATE.IDLE;
    a.path = []; a.move = null;
    return;
  }

  const squad = sim.squads[a.squad];
  if (!squad || squad.broken) { updateArmed(sim, a, dt); return; }

  const threat = floodThreatVisible(sim, a);
  if (sim.floodStrengthAt(a.pnode ?? a.node) > 0) {
    // stand and fight ON CONTACT, where you physically are — a marine does
    // not keep walking to the middle of the hangar with a form on the deck
    a.state = STATE.FIGHT; a.path = []; a.move = null;
    return;
  }
  if (a.state === STATE.FIGHT) a.state = STATE.MOVE;
  // a marine standing in a clear room has swept it — timestamp it so the
  // squad's sweep planner expands into unswept ground instead of doubling back
  if (sim.graph.node(a.node).type !== 'corridor' && threat === 0) sim.sweptAt[a.node] = sim.t;

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

  // FOLLOW THE PLAYER LIVE (user: fireteam bad at following + deck nav). For an
  // escort order, chase the player's CURRENT node and re-path the MOMENT they
  // move to a new room — don't wait ~2.5 s for the strategic tick or for a
  // stale path to drain. ['std'] already includes the lift/ladder/stairwell
  // edges, so this follows across decks too.
  if (squad.order?.kind === 'order:escort') {
    a.closeFollow = false;
    const lead = sim.byId.get(squad.order.entityId);
    if (lead && !lead.dead) {
      if (lead.node !== a.node && !a.move && lead.node !== a.followNode) {
        a.followNode = lead.node;
        a.path = [];
        if (sim.setPathTo(a, lead.node, ['std'], humanPass)) a.state = STATE.MOVE;
      } else if (lead.node === a.node && !a.move && sim.floodStrengthAt(a.node) === 0) {
        // CLOSE FOLLOW (user: fireteam terrible at following closely). In the
        // player's room and no flood to fight: hold a tight formation slot just
        // behind them and close the gap in REAL SPACE — sprinting when you've
        // fallen behind, easing in when near — instead of drifting to a room
        // parking slot away from them.
        const mi = Math.max(0, squad.members.indexOf(a.id));
        const ang = lead.heading + Math.PI + ((mi % 3) - 1) * 0.6; // fan behind
        const off = 1.5 + (mi >= 3 ? 1.0 : 0);
        const tx = lead.x + Math.cos(ang) * off, ty = lead.y + Math.sin(ang) * off;
        const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
        if (d > 0.5) {
          const mps = d > 7 ? 8 : d > 3 ? 6 : 2.6; // catch up hard, ease in close
          const step = Math.min(d, mps * dt);
          a.x += (dx / d) * step; a.y += (dy / d) * step;
          sim._clampToRoom(a, sim.graph.node(a.node));
        }
        a.heading = d > 0.8 ? Math.atan2(dy, dx) : lead.heading;
        a.animTime += dt;
        a.closeFollow = true; // _advanceMovement won't park-drift it off station
      }
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
  // phase 2 can't wait on a breach CLEAR that may never come — if the crash
  // site is known-hot and hasn't been secured within a couple of minutes,
  // the ship goes to general deck sweeps anyway (this is what left every
  // squad holding position forever while the lower decks rotted)
  if (!sim.firstSweepCleared && sim.floodKnown && sim.t > 120) {
    sim.firstSweepCleared = true;
    sim.log('sweep', 'crash site is hot and holding — squads begin general deck sweeps');
    for (const s of sim.squads) {
      if (s.objective?.kind === 'breach') s.objective = null; // stop besieging, start sweeping
    }
  }

  mergeThinSquads(sim);
  for (const squad of sim.squads) {
    const members = squad.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    // morale: heavy losses break the squad (§5.3)
    if (!squad.broken && members.length > 0 && members.length < Math.ceil(squad.size0 / 2)) {
      squad.broken = true;
      sim.log('morale', `squad ${squad.id + 1} broken — survivors fall back to individual behavior`);
      continue;
    }
    if (squad.broken || members.length === 0) continue;
    if (squad.odst && sim.armoryLocked) continue; // the sealed reserve takes no taskings
    const leader = members[0];

    // engaged squads don't re-plan
    if (members.some((m) => m.state === STATE.FIGHT)) continue;

    // roaming pair patrols run their own doctrine: circuit + distress response
    if (squad.patrol) { patrolPlan(sim, squad, leader); continue; }

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

    // last stand: a squad that heard the call binds to the corridor line and
    // stops sweeping/responding — it fights its way home and holds
    if (squad.lastStandBound) {
      squad.objective = { kind: 'order', node: sim.graph.byId.get('d1corr') };
      continue;
    }

    // a squad set to ignore calls (SET_CALL_POLICY) skips the call scan
    const callPolicy = squad.callPolicy ?? 'auto';

    // distress calls: roll reliability once per squad per call (§5.3);
    // this is the MASTER DIAL for coordination efficiency
    // during the initial muster the squads are still kitting up — no distress
    // dispatch until the ship's reflex response has actually stood up
    const mustering = sim.t < P.marineDoctrine.firstSweepDelaySec;
    for (const call of (mustering || callPolicy === 'ignore' ? [] : sim.calls)) {
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

    // make the crash-response convergence visible in the log
    if (squad.objective?.kind === 'breach' && !squad.reachedBreach && leader.node === sim.graph.breachNode) {
      squad.reachedBreach = true;
      sim.log('sweep', `squad ${squad.id + 1} reaches the crash site`);
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
      if (squad.objective?.kind === 'breach') {
        if (!sim.firstSweepCleared) {
          sim.firstSweepCleared = true;
          sim.log('sweep', `first sweep cleared the breach region (${sim.graph.node(sim.graph.breachNode).name})`);
        }
        // the crash squads spend ~30s working the site before fanning out
        // in different directions across the lower decks (user note)
        squad.objective = { kind: 'hold', node: leader.node };
        squad.holdUntil = sim.t + 30;
        continue;
      }
      if (squad.objective?.kind === 'breach' || sim.firstSweepCleared || !squad.objective) {
        // phase 2: METHODICAL sweep — push to the nearest room that hasn't
        // been cleared recently, expanding outward from where the squad is
        // (which starts at the breach on the lower decks). This stops squads
        // from clearing the crash site and then wandering back up to already-
        // safe upper decks (user note).
        if (sim.firstSweepCleared || squad.objective) {
          if (squad.holdUntil === undefined || sim.t >= squad.holdUntil) {
            const target = pickSweepTarget(sim, leader);
            squad.objective = target !== -1
              ? { kind: 'sweep', node: target }
              : { kind: 'hold', node: leader.node };
            // slow and methodical (user note): a real pause at each cleared
            // room before pushing to the next — the flood knows this rhythm,
            // which is why it spreads out and grabs what it can in the gaps
            squad.holdUntil = sim.t + P.marineDoctrine.sweepDwellSec + sim.rng.range(0, P.marineDoctrine.sweepDwellJitterSec);
          }
        } else {
          // before phase 2, non-sweep squads hold near spawn
          squad.objective = { kind: 'hold', node: leader.node };
        }
      }
    }
  }
}

// Roaming pair patrols (user note): walk the whole ship on a fixed circuit,
// peel off to distress calls like any squad (sharing the 2-responder cap),
// then pick the round back up where it left off. A commander order overrides
// the circuit; the last-stand call overrides everything.
function patrolPlan(sim, squad, leader) {
  const P = sim.P;
  if (squad.lastStandBound) {
    squad.objective = { kind: 'order', node: sim.graph.byId.get('d1corr') };
    return;
  }
  if (squad.order && applySquadOrder(sim, squad, leader)) return;

  const callPolicy = squad.callPolicy ?? 'auto';
  for (const call of (callPolicy === 'ignore' ? [] : sim.calls)) {
    if (sim.t - call.t > P.radio.callFadeSec) continue;
    if (call.rolled.has(squad.id)) continue;
    call.rolled.add(squad.id);
    if (!sim.rng.chance(P.radio.marineCallReliability)) continue;
    const responders = sim.squads.filter((s) => !s.broken && s.respondingTo === call.id).length;
    if (responders >= 2) continue;
    const cur = squad.objective?.kind === 'distress'
      ? sim.graph.hops(leader.node, squad.objective.node, ['std'], humanPass) : Infinity;
    const d = sim.graph.hops(leader.node, call.node, ['std', 'shaft'], marinePass);
    if (d !== -1 && d < cur) {
      squad.objective = { kind: 'distress', node: call.node, callId: call.id };
      squad.respondingTo = call.id;
      sim.log('radio', `patrol ${squad.patrolNo} responding to distress in ${sim.graph.node(call.node).name}`);
    }
  }
  if (squad.objective?.kind === 'distress') {
    const objNode = squad.objective.node;
    const clear = sim.visibleNodes(objNode).every((n) => sim.floodStrengthAt(n) === 0);
    if (leader.node === objNode && clear) { squad.objective = null; squad.respondingTo = null; }
    else return;
  }
  // walk the circuit
  if (leader.node === squad.route[squad.leg] && !leader.move && !leader.path.length) {
    squad.leg = (squad.leg + 1) % squad.route.length;
  }
  squad.objective = { kind: 'patrol', node: squad.route[squad.leg] };
}

// Thinned-out squads stick together (user note): survivors of a broken or
// 2-man squad who run into a healthier squad fold into it — one bigger squad
// instead of two dying ones. The receiving squad's morale baseline grows too.
function mergeThinSquads(sim) {
  for (const A of sim.squads) {
    const aliveA = A.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    if (!aliveA.length) continue;
    if (!A.broken && aliveA.length > 2) continue; // healthy enough on its own
    if (A.patrol && aliveA.length >= 2) continue; // a pair patrol is MEANT to be 2
    for (const B of sim.squads) {
      if (B === A || B.broken) continue;
      const aliveB = B.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (aliveB.length < 2) continue;
      const d = sim.graph.hops(aliveA[0].node, aliveB[0].node, ['std'], humanPass);
      if (d === -1 || d > 1) continue; // must actually run into each other
      for (const m of aliveA) { m.squad = B.id; B.members.push(m.id); }
      A.members = A.members.filter((id) => !aliveA.some((m) => m.id === id));
      B.size0 += aliveA.length;
      sim.log('morale', `survivors of squad ${A.id + 1} fold into squad ${B.id + 1} (${aliveB.length + aliveA.length} rifles)`);
      break;
    }
  }
}

// Nearest room the squad hasn't cleared recently, so sweeps expand outward
// instead of doubling back. Ties break toward the breach region — the known
// danger is down where the ship was holed, not up on the command decks.
function pickSweepTarget(sim, leader) {
  const g = sim.graph;
  // fan out: never pick a room another squad is already sweeping toward —
  // this is what splits the two crash squads in different directions
  const taken = new Set();
  for (const s of sim.squads) {
    if (!s.broken && (s.objective?.kind === 'sweep' || s.objective?.kind === 'order')) taken.add(s.objective.node);
  }
  let best = -1, bestScore = Infinity;
  for (const n of g.nodes) {
    if (n.type === 'corridor' || n.idx === leader.node || taken.has(n.idx)) continue;
    if (n.roles.includes('command')) continue; // the garrison holds the bridge
    const staleness = sim.t - sim.sweptAt[n.idx];
    if (staleness < 40) continue; // cleared very recently — leave it
    const d = g.hops(leader.node, n.idx, ['std', 'shaft'], marinePass);
    if (d === -1) continue;
    const breachDist = g.hops(n.idx, g.breachNode, ['std', 'shaft'], marinePass);
    // the danger is DOWN where the ship was holed: breach-proximity and the
    // lower decks dominate the pick, distance-from-squad only breaks ties —
    // otherwise nearest-first keeps squads grazing the upper decks forever
    const score = d * 0.5
      + (breachDist === -1 ? 8 : breachDist) * 0.9
      - (n.deck >= 4 ? 2.5 : 0)
      - Math.min(staleness, 300) * 0.01;
    if (score < bestScore) { bestScore = score; best = n.idx; }
  }
  return best;
}

// Assign the automatic first sweep (§5.3 phase 1): the TWO squads with the
// shortest human-traversable paths to the breach respond (user note). They
// muster ~18s, investigate, spend ~30s at the site, then fan out in
// different directions across the lower decks.
export function assignFirstSweep(sim) {
  const ranked = [];
  for (const squad of sim.squads) {
    const leader = sim.byId.get(squad.members[0]);
    squad.size0 = squad.members.length;
    if (squad.patrol) continue; // patrols keep walking their round
    squad.objective = { kind: 'hold', node: leader.node };
    const d = sim.graph.hops(leader.node, sim.graph.breachNode, ['std'], humanPass);
    if (d !== -1) ranked.push({ squad, d });
  }
  ranked.sort((a, b) => a.d - b.d);
  for (const { squad, d } of ranked.slice(0, 2)) {
    squad.pendingSweep = true;
    sim.log('sweep', `squad ${squad.id + 1} mustering to investigate the crash (${sim.graph.node(sim.graph.breachNode).name}, ${d} hops) — moving out in ~${sim.P.marineDoctrine.firstSweepDelaySec}s`);
  }
}
