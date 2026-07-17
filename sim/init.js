// Run initialization (§4) — seeded, in order:
// 1 load graph, 2 lock doors, 3 block vents, 5 power, 6 populate NPCs,
// 7 scatter corpses, 8 seed the outbreak.

import { ShipGraph, humanPass } from './graph.js';
import { SHIP } from './data/ship.js';
import { FACTION } from '../shared/agentBuffer.js';

export const STATE = {
  // shared across factions where meaningful
  IDLE: 0, ALERT: 1, FLEE: 2, HIDE: 3, COWER: 4, FIGHT: 5,
  MOVE: 6, DEAD: 7, DOWNED: 8, GRABBING: 9, AMBUSHING: 10, INCUBATING: 11,
};

let NEXT_ID = 1;

export function makeAgent(kind, node, graph) {
  const nd = graph.node(node);
  return {
    id: NEXT_ID++,
    faction: kind,
    state: STATE.IDLE,
    node,
    x: nd.x, y: nd.y, deck: nd.deck,
    heading: 0,
    // movement along an edge: null when parked in a node
    move: null, // { to, link, layer, t (0..1), travelSec }
    path: [],   // remaining [{to, link, layer}]
    hp: 1, maxHp: 1, damage: 0,
    hasRadio: false, helpless: false, panicked: false, stayPut: false, garrison: false,
    downed: false, reviveAt: -1, // self-revive schedule (sim seconds)
    squad: -1,
    flamer: false, fuel: 0,
    task: null,      // hive task for flood forms
    hideTimer: 0, alertTimer: 0, grabTimer: 0, calledOut: false,
    minted: 0,       // carrier production count
    mintTimer: 0,
    lastMovedAt: 0,  // for ambush "stationary" checks
    animTime: 0,
    dragging: -1,    // corpse id being dragged
  };
}

export function resetIds() { NEXT_ID = 1; }

export function initRun(seed, rng, P) {
  resetIds();
  const graph = new ShipGraph(SHIP);

  // --- 2. lock doors, keep the human graph connected ---
  for (const e of graph.edges) {
    if (e.lockable && rng.chance(P.door.lockedFraction)) e.locked = true;
  }
  repairHumanConnectivity(graph);

  // --- 3. block vents; never isolate a corpse_cache from every flood route ---
  for (const v of graph.vents) {
    if (rng.chance(P.vent.blockedFraction)) v.blocked = true;
  }
  for (const cacheIdx of graph.nodesWithRole('corpse_cache')) {
    const reachable = [...graph.neighbors(cacheIdx, ['std', 'vent'],
      (l) => (l.kind === 'std' ? !l.locked : !l.blocked))];
    if (reachable.length === 0) {
      const vents = graph.adj.vent[cacheIdx];
      if (vents.length) vents[0].link.blocked = false;
      else { const es = graph.adj.std[cacheIdx]; if (es.length) es[0].link.locked = false; }
    }
  }

  // --- 5. power ---
  for (const n of graph.nodes) {
    if (rng.chance(P.power.unstableFraction)) graph.unpowered[n.idx] = 1;
  }

  // --- 6. populate NPCs ---
  const agents = [];
  const marineCount = Math.round(P.npc.count * P.npc.marineFraction);
  const armedCount = Math.round(P.npc.count * P.npc.armedFraction);
  const civCount = P.npc.count - marineCount - armedCount;

  // marine squads of 3-5; 1-2 squads guaranteed in the barracks
  const squads = [];
  {
    const barracks = graph.byId.get('barracks');
    const sizes = [];
    let left = marineCount;
    while (left > 0) { const s = Math.min(left, 3 + rng.int(3)); sizes.push(s); left -= s; }
    const eligible = graph.nodes
      .filter((n) => !n.roles.includes('command') && n.type !== 'corridor'
        && !n.roles.includes('crash_candidate')) // squads berth in crew spaces, not cargo holds
      .map((n) => n.idx);
    const barracksSquads = Math.min(sizes.length, 1 + (rng.chance(0.5) ? 1 : 0));
    sizes.forEach((size, si) => {
      const node = si < barracksSquads ? barracks : rng.pick(eligible);
      const squad = { id: si, members: [], objective: null, morale: 1, respondingTo: null, phase1: false };
      for (let m = 0; m < size; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = rng.chance(P.npc.radio.marine);
        a.squad = si;
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    });
    // the ship's ONE flamethrower goes to a member of the first barracks squad
    const flamerSquad = squads[0];
    if (flamerSquad) {
      const holder = agents.find((a) => a.id === flamerSquad.members[0]);
      holder.flamer = true;
      holder.fuel = P.flamethrower.fuelUnits;
    }
  }

  // permanent command-deck garrison (user note): a fixed marine detail on the
  // bridge/CIC that never sweeps, never answers calls, never takes orders —
  // it just holds. Not part of any squad, so it's exempt from all squad logic.
  {
    const posts = [graph.byId.get('bridge'), graph.byId.get('cic')];
    for (let i = 0; i < P.marineDoctrine.commandGarrison; i++) {
      const a = makeAgent(FACTION.MARINE, posts[i % posts.length], graph);
      a.hp = a.maxHp = P.combat.marine.hp;
      a.hasRadio = true;
      a.squad = -1;
      a.garrison = true;
      agents.push(a);
    }
  }

  // armed humans: armory + corridors
  {
    const armory = graph.byId.get('armory');
    const corridors = graph.nodes.filter((n) => n.type === 'corridor').map((n) => n.idx);
    const softRooms = graph.nodes.filter((n) => n.roles.includes('soft')).map((n) => n.idx);
    for (let i = 0; i < armedCount; i++) {
      const node = i < Math.ceil(armedCount * 0.4) ? armory
        : i < Math.ceil(armedCount * 0.7) ? rng.pick(corridors) : rng.pick(softRooms);
      const a = makeAgent(FACTION.ARMED, node, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.hasRadio = rng.chance(P.npc.radio.armed);
      agents.push(a);
    }
  }

  // civilians: quarters/soft/mess; helpless in brig + medbay
  {
    const soft = graph.nodes
      .filter((n) => n.roles.includes('soft') || n.roles.includes('quarters'))
      .map((n) => n.idx);
    const brig = graph.byId.get('brig');
    const medbay = graph.byId.get('medbay');
    const officerPost = graph.byId.get('officer');
    for (let i = 0; i < civCount; i++) {
      let node, helpless = false, stayPut = false;
      if (i < P.npc.brigPrisoners) { node = brig; helpless = true; }
      else if (i < P.npc.brigPrisoners + P.npc.medbayWounded) { node = medbay; helpless = true; }
      else if (i < P.npc.brigPrisoners + P.npc.medbayWounded + P.marineDoctrine.officers) {
        // officers hold Officer Country and do not evacuate (user note)
        node = officerPost; stayPut = true;
      } else node = rng.pick(soft);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = helpless;
      a.stayPut = stayPut;
      a.hasRadio = stayPut || (!helpless && rng.chance(P.npc.radio.civilian));
      agents.push(a);
    }
  }

  // --- 7. scatter corpses, weighted into corpse caches ---
  const corpses = [];
  {
    const caches = graph.nodesWithRole('corpse_cache');
    const all = graph.nodes.map((n) => n.idx);
    for (let i = 0; i < P.npc.corpsesFromEvent; i++) {
      const node = rng.chance(0.45) ? rng.pick(caches) : rng.pick(all);
      const c = makeAgent(FACTION.CORPSE, node, graph);
      c.state = STATE.DEAD;
      c.hp = 0; c.damage = 0; // fully convertible
      corpses.push(c);
    }
  }

  // --- 8. seed the outbreak at a crash candidate ---
  const candidates = graph.nodesWithRole('crash_candidate');
  const breach = rng.pick(candidates);
  graph.breachNode = breach;
  graph.unpowered[breach] = 1;
  const flood = [];
  for (let i = 0; i < P.flood.initialInfectionForms; i++) {
    const a = makeAgent(FACTION.INFECTION, breach, graph);
    a.hp = a.maxHp = 1;
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCombatForms; i++) {
    const a = makeAgent(FACTION.COMBAT, breach, graph);
    a.hp = a.maxHp = P.combat.combatForm.hp * (1 + rng.range(-P.combat.combatForm.hpJitter, P.combat.combatForm.hpJitter));
    flood.push(a);
  }
  for (let i = 0; i < P.flood.breachCorpses; i++) {
    const c = makeAgent(FACTION.CORPSE, breach, graph);
    c.state = STATE.DEAD; c.hp = 0; c.damage = 0;
    corpses.push(c);
  }

  return { graph, agents: [...agents, ...corpses, ...flood], squads, breach };
}

// Unlock a minimal set of locked doors so every node stays human-reachable
// from the bridge (the "path spine" guarantee in §4.2).
function repairHumanConnectivity(graph) {
  const start = graph.byId.get('bridge');
  for (let guard = 0; guard < 64; guard++) {
    const ff = graph.flowField([start], ['std'], humanPass);
    const stranded = [];
    for (let i = 0; i < graph.n; i++) if (ff.dist[i] === -1) stranded.push(i);
    if (!stranded.length) return;
    // unlock one locked edge that bridges reached <-> stranded
    let fixed = false;
    for (const e of graph.edges) {
      if (!e.locked) continue;
      const aIn = ff.dist[e.a] !== -1, bIn = ff.dist[e.b] !== -1;
      if (aIn !== bIn) { e.locked = false; fixed = true; break; }
    }
    if (!fixed) return; // graph itself is disconnected (shouldn't happen)
  }
}
