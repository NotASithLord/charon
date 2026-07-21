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
    worker: false, captain: false, fleeSteps: 0,
    downed: false, reviveAt: -1, // self-revive schedule (sim seconds)
    squad: -1,
    flamer: false, fuel: 0,
    task: null,      // hive task for flood forms
    hideTimer: 0, alertTimer: 0, grabTimer: 0, calledOut: false,
    held: 0,         // infection forms gestating INSIDE a carrier
    mintTimer: 0,
    lastMovedAt: 0,  // for ambush "stationary" checks
    animTime: 0,
    dragging: -1,    // corpse id being dragged
    hoverY: 0, leaping: false, leapDist0: 0, leapTX: 0, leapTY: 0, // Flood leap arc (sim.js _spatialSteer)
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
  assertDeckConnectivity(graph);

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

  // --- 6. populate NPCs. EXPLICIT COUNTS (user note): squads, squad sizes,
  // civilians and bodies are exactly what the inputs say — the only thing
  // that rolls fresh each run is WHERE everyone starts. ---
  const agents = [];
  const M = P.marines;

  // marine line squads: M.squads squads of M.squadSize each; the first one
  // or two berth in the barracks, the rest wake up in random crew spaces
  const squads = [];
  {
    const barracks = graph.byId.get('barracks');
    const eligible = graph.nodes
      .filter((n) => !n.roles.includes('command') && n.type !== 'corridor'
        && !n.roles.includes('crash_candidate')) // squads berth in crew spaces, not cargo holds
      .map((n) => n.idx);
    const barracksSquads = Math.min(M.squads, 1 + (rng.chance(0.5) ? 1 : 0));
    for (let si = 0; si < M.squads; si++) {
      const node = si < barracksSquads ? barracks : rng.pick(eligible);
      const squad = { id: si, members: [], objective: null, morale: 1, respondingTo: null, phase1: false };
      for (let m = 0; m < M.squadSize; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = rng.chance(P.crew.radio.marine);
        a.squad = si;
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    }
    // the ship's ONE flamethrower goes to a member of the first barracks squad
    const flamerSquad = squads[0];
    if (flamerSquad) {
      const holder = agents.find((a) => a.id === flamerSquad.members[0]);
      holder.flamer = true;
      holder.fuel = P.flamethrower.fuelUnits;
    }
  }

  // permanent top-deck garrison (user note): marines standing guard on the
  // Command Corridor — the one way into the command deck — at all times.
  // They never sweep, never answer calls, never take orders; they just hold
  // the chokepoint. Not part of any squad, exempt from all squad logic.
  {
    const post = graph.byId.get('d1corr');
    for (let i = 0; i < M.garrison; i++) {
      const a = makeAgent(FACTION.MARINE, post, graph);
      a.hp = a.maxHp = P.combat.marine.hp;
      a.hasRadio = true;
      a.squad = -1;
      a.garrison = true;
      agents.push(a);
    }
  }

  // roaming pair patrols (user note): marine details, in ADDITION to the
  // squads, walking a fixed circuit of the whole ship. They answer distress
  // calls like any squad, then pick the round back up. Staggered around the
  // loop so the ship always has coverage somewhere.
  {
    // ship-wide circuit down the new deck stack (command -> hangar) and back
    const route = ['d1corr', 'd2corrF', 'mess', 'd2corrA', 'corrM', 'corrF', 'corrA',
      'engCorrF', 'eng', 'engCorrA', 'hangarA', 'hangar', 'vehicle', 'cargo1',
      'hangarA', 'engCorrA', 'corrM'].map((id) => graph.byId.get(id));
    for (let p = 0; p < M.patrols; p++) {
      const leg = Math.floor((p * route.length) / Math.max(1, M.patrols));
      const node = route[leg];
      const squad = {
        id: squads.length, members: [], objective: null, morale: 1,
        respondingTo: null, phase1: false, patrol: true, patrolNo: p + 1, route, leg,
      };
      for (let m = 0; m < M.patrolSize; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = true;
        a.squad = squad.id;
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    }
  }

  // armed crew: armory + the flank gun batteries + corridors + living spaces
  {
    const armory = graph.byId.get('armory');
    const corridors = graph.nodes.filter((n) => n.type === 'corridor').map((n) => n.idx);
    const softRooms = graph.nodes.filter((n) => n.roles.includes('soft')).map((n) => n.idx);
    // the flank weapon stations are manned (user: side areas shouldn't read
    // empty) — the 50mm batteries and fire control hold a watch of armed crew
    const battleStations = graph.nodes.filter((n) =>
      n.roles.includes('battery') || (n.roles.includes('marines') && n.roles.includes('systems')))
      .map((n) => n.idx);
    const armedCount = P.crew.armedCrew;
    for (let i = 0; i < armedCount; i++) {
      const r = i / armedCount;
      const node = r < 0.3 ? armory
        : (r < 0.55 && battleStations.length) ? rng.pick(battleStations)
        : r < 0.75 ? rng.pick(corridors) : rng.pick(softRooms);
      const a = makeAgent(FACTION.ARMED, node, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.hasRadio = rng.chance(P.crew.radio.armed);
      scatterInRoom(a, graph.node(node), rng); // spread within the room, not stacked
      agents.push(a);
    }
  }

  // civilians: quarters/soft/mess; prisoners and wounded are explicit counts
  // on top, as are the stay-put officers
  {
    // EVEN SPREAD (user note: crew shouldn't clump in a few rooms) — the
    // sheltering crew fills living spaces first but overflows across the
    // whole habitable ship (any room that isn't command/hazard/hangar or the
    // crash site), weighted by each room's capacity so big spaces hold more.
    const softIdx = graph.nodes
      .filter((n) => n.roles.includes('soft') || n.roles.includes('quarters'))
      .map((n) => n.idx);
    const habitable = graph.nodes.filter((n) =>
      n.type !== 'corridor' && n.idx !== graph.breachNode
      && !n.roles.includes('command') && !n.roles.includes('hazard')
      && !n.roles.includes('power') && !n.roles.includes('hangar')
      && !n.roles.includes('vehicles'));
    // capacity-weighted pool, BIASED OUTBOARD (user: spread bodies into the
    // side areas off the main corridors, not clumped on the spine). A room's
    // weight is its capacity scaled by how far off the centreline it sits —
    // the outboard flank halls (|row| >= 2) pull ~2x their share, the spine
    // rooms about half — so the crew reads as manning the whole beam.
    const spreadPool = [];
    for (const n of habitable) {
      const off = Math.abs(n.row ?? 0);
      const bias = off >= 2 ? 2.2 : off === 1 ? 1.2 : 0.55;
      const copies = Math.max(1, Math.round(n.capacity * bias));
      for (let k = 0; k < copies; k++) spreadPool.push(n.idx);
    }
    const soft = softIdx;
    const brig = graph.byId.get('brig');
    const medbay = graph.byId.get('medbay');
    const officerPost = graph.byId.get('officer');
    for (let i = 0; i < P.crew.brigPrisoners; i++) {
      const a = makeAgent(FACTION.CIVILIAN, brig, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = true;
      agents.push(a);
    }
    for (let i = 0; i < P.crew.medbayWounded; i++) {
      const a = makeAgent(FACTION.CIVILIAN, medbay, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = true;
      agents.push(a);
    }
    // officers hold Officer Country, armed, and do not evacuate (user note)
    for (let i = 0; i < P.marineDoctrine.officers; i++) {
      const a = makeAgent(FACTION.ARMED, officerPost, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.stayPut = true;
      a.hasRadio = true;
      agents.push(a);
    }
    for (let i = 0; i < P.crew.civilians; i++) {
      // 55% shelter in the living spaces, 45% are spread across the wider
      // ship (so the crew reads as a whole complement at stations, not a
      // pile in the mess) — then scattered within whatever room they land in
      const node = rng.chance(0.55) ? rng.pick(soft) : rng.pick(spreadPool);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      // ~20% are still working the ship (engineers, medics, techs) and move
      // with purpose; the rest shelter in place (user note)
      a.worker = rng.chance(P.civilian.workerFraction);
      a.hasRadio = a.worker || rng.chance(P.crew.radio.civilian);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }

    // the captain and a few officers command from the bridge and never leave
    // it (user note). All of them are armed and fight in place if reached.
    const bridge = graph.byId.get('bridge');
    for (let i = 0; i < P.marineDoctrine.bridgeOfficers; i++) {
      const a = makeAgent(FACTION.ARMED, bridge, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.stayPut = true;
      a.captain = i === 0;
      a.hasRadio = true;
      agents.push(a);
    }

    // unarmed maintenance crew working the LOWER decks (user note): they roam
    // decks 4-5 fixing systems — moving bodies right where the outbreak lives
    // REPAIR DETAILS (user rule): the lower-deck crew spawn ALIVE and AT
    // WORK — distributed across the machinery spaces they're trying to keep
    // running (engineering, reactor, life support, workshops), not scattered
    // through random compartments. worker=true keeps them making purposeful
    // trips between systems until the outbreak reaches them.
    const repairRooms = graph.nodes.filter((n) => n.deck >= 4
      && ['power', 'engineering', 'systems', 'maintenance'].some((r) => n.roles.includes(r)))
      .map((n) => n.idx);
    const lowerNodes = graph.nodes.filter((n) => n.deck >= 4).map((n) => n.idx);
    for (let i = 0; i < P.crew.lowerMaintenance; i++) {
      const node = repairRooms.length ? repairRooms[i % repairRooms.length] : rng.pick(lowerNodes);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.worker = true;
      a.lowerDecks = true; // their work orders keep them on decks 4-5
      a.hasRadio = rng.chance(P.crew.radio.civilian);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }
  }

  // --- 7. scatter corpses: EVERY room gets its own randomly-rolled share,
  // every run (user note) — each node's weight is its size times a fresh
  // per-run roll, so where the portal event's dead ended up is never the
  // same twice. Corpse caches (medbay/cryo) still lean heavy.
  const corpses = [];
  {
    const weights = graph.nodes.map((n) => {
      let w = (n.capacity * 0.5 + 2) * rng.range(0.15, 1.85);
      if (n.roles.includes('corpse_cache')) w *= 2.5;
      if (n.type === 'corridor') w *= 0.5;
      // the dead lie where the crew was — out in the side compartments, not
      // piled in the corridors (user: spread bodies into the side areas)
      if (Math.abs(n.row ?? 0) >= 2) w *= 1.8;
      else if ((n.row ?? 0) === 0 && n.type !== 'corridor') w *= 0.7;
      return w;
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < P.bodies.eventCorpses; i++) {
      let r = rng.next() * totalW, node = graph.n - 1;
      for (let k = 0; k < weights.length; k++) { r -= weights[k]; if (r <= 0) { node = k; break; } }
      const c = makeAgent(FACTION.CORPSE, node, graph);
      c.state = STATE.DEAD;
      c.hp = 0; c.damage = 0; // fully convertible
      c.wasArmed = rng.chance(P.bodies.armedFraction); // the vast majority died unarmed (user rule)
      scatterInRoom(c, graph.node(node), rng);
      corpses.push(c);
    }
  }

  // --- 8. seed the outbreak at a crash candidate ---
  const candidates = graph.nodesWithRole('crash_candidate');
  const breach = rng.pick(candidates);
  graph.breachNode = breach;
  graph.unpowered[breach] = 1;
  // every form spills out of the crash at its OWN spot (user rule: solid
  // bodies, no stacking on the room's center point)
  const flood = [];
  for (let i = 0; i < P.flood.initialInfectionForms; i++) {
    const a = makeAgent(FACTION.INFECTION, breach, graph);
    a.hp = a.maxHp = 1;
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCarriers; i++) {
    const a = makeAgent(FACTION.CARRIER, breach, graph);
    a.hp = a.maxHp = P.combat.carrierHp;
    a.state = STATE.INCUBATING;
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCombatForms; i++) {
    const a = makeAgent(FACTION.COMBAT, breach, graph);
    a.hp = a.maxHp = P.combat.combatForm.hp * (1 + rng.range(-P.combat.combatForm.hpJitter, P.combat.combatForm.hpJitter));
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  // the crash site's fresh dead are random too (user note): ~50%-160% of the
  // configured baseline, so the opening larder varies run to run
  const freshDead = Math.max(2, Math.round(P.bodies.breachCorpses * rng.range(0.5, 1.6)));
  for (let i = 0; i < freshDead; i++) {
    const c = makeAgent(FACTION.CORPSE, breach, graph);
    c.state = STATE.DEAD; c.hp = 0; c.damage = 0;
    c.wasArmed = rng.chance(P.bodies.armedFraction);
    scatterInRoom(c, graph.node(breach), rng);
    corpses.push(c);
  }

  return { graph, agents: [...agents, ...corpses, ...flood], squads, breach };
}

// bodies lie where they fell — a fixed, seeded spot inside the room's real
// footprint, not a stack on the room's center point
function scatterInRoom(a, nd, rng) {
  a.x = nd.x + rng.range(-0.5, 0.5) * Math.max(2, nd.w - 2.5);
  a.y = nd.y + rng.range(-0.5, 0.5) * Math.max(2, nd.d - 2.5);
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

// NO BLOCKAGE EVER between any two decks (user rule): every cross-deck
// connection is a lift or ladder, and lift/ladder edges are authored
// lockable:false in ship.js — the door-lock roll and the SET_DOOR command
// both refuse to touch a non-lockable edge, and the graph's maintenance-
// shaft layer has no lock flag at all. This assertion is the enforced
// guarantee, not just an accident of the current data: it fails loudly in
// dev if a future edit ever adds a lockable cross-deck edge that could
// seal every path between two decks.
function assertDeckConnectivity(graph) {
  const start = graph.byId.get('bridge');
  const ff = graph.flowField([start], ['std'], humanPass);
  const decksSeen = new Set();
  for (let i = 0; i < graph.n; i++) if (ff.dist[i] !== -1) decksSeen.add(graph.node(i).deck);
  if (decksSeen.size < 5) {
    console.warn(`[charon] deck connectivity broken: only decks {${[...decksSeen].sort().join(',')}} reachable from the bridge — check for a lockable cross-deck edge`);
  }
}
