// Applies commander commands drained from the queue (companion spec §0/§2).
// This is the ONE place a command mutates shared sim state. Multiplayer
// (§3.6) wires avatar-caused HIT/BURN commands into the same switch later.
//
// A player order sets an OVERRIDE objective on the squad's blackboard
// (companion spec §2.3); the squad pursues it until it completes, is
// RELEASEd, or can't be delivered. Autonomous behavior is the fallback.

import { CMD } from './commands.js';

export function applyCommand(sim, entry) {
  const { cmd, peerId } = entry;
  const g = sim.graph;
  const squad = cmd.squadId !== undefined ? sim.squads[cmd.squadId] : null;

  // command-comms gating (companion spec §2.4): an order only lands if the
  // squad's deck has a working link. The player's own ODSTs would be exempt
  // (hardened local channel) — not modeled until the avatar exists.
  const delivered = () => {
    if (!squad) return true;
    const leader = sim.byId.get(squad.members[0]);
    if (!leader || leader.dead) return false;
    const deckPowered = !g.unpowered[leader.node];
    const rel = sim.P.command.linkReliability * (deckPowered ? 1 : 0.4);
    if (!sim.rng.chance(rel)) {
      sim.log('command', `order to squad ${cmd.squadId + 1} lost (comms damage) — it stays autonomous`);
      return false;
    }
    return true;
  };

  switch (cmd.type) {
    case CMD.MOVE_TO:
      if (squad && delivered()) setOrder(sim, squad, { kind: 'order:move', node: cmd.node }, `move to ${g.node(cmd.node).name}`, peerId);
      break;
    case CMD.GUARD:
      if (squad && delivered()) setOrder(sim, squad, { kind: 'order:guard', node: cmd.node }, `guard ${g.node(cmd.node).name}`, peerId);
      break;
    case CMD.HOLD_CHOKE: {
      if (squad && delivered()) {
        const e = g.edges[cmd.edgeIdx];
        setOrder(sim, squad, { kind: 'order:guard', node: e.a, choke: cmd.edgeIdx }, `hold the ${g.node(e.a).name}↔${g.node(e.b).name} chokepoint`, peerId);
      }
      break;
    }
    case CMD.PATROL:
      if (squad && delivered()) setOrder(sim, squad, { kind: 'order:patrol', route: cmd.route.slice(), leg: 0 }, `patrol ${cmd.route.length} nodes`, peerId);
      break;
    case CMD.RESPOND: {
      if (squad && delivered()) {
        const call = sim.calls.find((c) => c.id === cmd.callId);
        if (call) setOrder(sim, squad, { kind: 'order:move', node: call.node, respond: cmd.callId }, `respond to ${g.node(call.node).name}`, peerId);
      }
      break;
    }
    case CMD.SET_CALL_POLICY:
      if (squad && delivered()) { squad.callPolicy = cmd.policy; sim.log('command', `squad ${cmd.squadId + 1} call policy → ${cmd.policy}`); }
      break;
    case CMD.ESCORT:
      if (squad && delivered()) setOrder(sim, squad, { kind: 'order:escort', entityId: cmd.entityId }, `escort #${cmd.entityId}`, peerId);
      break;
    case CMD.FALL_BACK:
      if (squad && delivered()) setOrder(sim, squad, { kind: 'order:move', node: cmd.node, fallback: true }, `fall back to ${g.node(cmd.node).name}`, peerId);
      break;
    case CMD.RELEASE:
      if (squad && delivered()) { squad.order = null; sim.log('command', `squad ${cmd.squadId + 1} released to autonomous behavior`); }
      break;

    case CMD.SET_DOOR: {
      const e = g.edges[cmd.edgeIdx];
      if (!e || !e.lockable) break;
      // can't actuate a blast door on an unpowered deck (core spec §4.5)
      if (cmd.locked && (g.unpowered[e.a] || g.unpowered[e.b])) {
        sim.log('command', `cannot seal ${g.node(e.a).name}↔${g.node(e.b).name} — no power`);
        break;
      }
      e.locked = !!cmd.locked;
      sim._precomputeSensing(); // locks change LOS/hearing topology
      sim.log('command', `${cmd.locked ? 'sealed' : 'opened'} ${g.node(e.a).name}↔${g.node(e.b).name}`);
      break;
    }
    case CMD.DESIGNATE_BURN:
      sim.burnOrderNode = cmd.node;
      sim.log('command', `flamethrower directed to ${g.node(cmd.node).name}`);
      break;
  }
}

function setOrder(sim, squad, order, desc, peerId) {
  squad.order = order;
  squad.orderBy = peerId;
  sim.log('command', `squad ${squad.id + 1}: ${desc}`);
}
