// Sim orchestrator (§2): fixed 15 Hz movement/sense tick, ~2.5 s strategic
// tick ("infection round"), deterministic from seed, writes the shared
// AgentBuffer every tick (§2.2).

import { RNG } from '../shared/rng.js';
import { cloneParams } from '../shared/params.js';
import { AgentBuffer, FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { clearHeightOf, CLEAR_H } from '../shared/geometry.js';
import { initRun, STATE, makeAgent } from './init.js';
import { updateHumansTick, strategicSquads, assignFirstSweep } from './humans.js';
import { Hive, TASK, W_FLOOD, W_HUMAN, isActiveFloodForm, isLivingHuman } from './hive.js';
import { updateFloodTick } from './floodExec.js';
import { resolveCombat, humanDeathToCorpse, hurtFloodForm } from './combat.js';
import { CommandQueue, CMD } from './commands.js';
import { applyCommand } from './commandApply.js';

const TINT = {
  [FACTION.CIVILIAN]: 0xf2f2f2, [FACTION.ARMED]: 0xe8c840, [FACTION.MARINE]: 0x4d8ef0,
  [FACTION.INFECTION]: 0x51ff6a, [FACTION.COMBAT]: 0xa8342a, [FACTION.CARRIER]: 0xb15fd9,
  [FACTION.CORPSE]: 0x8a8a8a,
};

export class Sim {
  constructor(seed, paramOverrides = null) {
    this.seed = String(seed);
    this.P = cloneParams();
    if (paramOverrides) deepMerge(this.P, paramOverrides);
    this.rng = new RNG(this.seed);
    this.t = 0;
    this.tickCount = 0;
    this.dt = 1 / this.P.sim.tickHz;
    this.strategicEvery = Math.round(this.P.sim.strategicTickSec * this.P.sim.tickHz);

    const { graph, agents, squads } = initRun(this.seed, this.rng, this.P);
    this.graph = graph;
    this.agents = agents;
    this.squads = squads;
    this.byId = new Map(agents.map((a) => [a.id, a]));
    // rooms indexed by deck, for the physical-room lookup (_pnodeOf)
    this._deckRooms = {};
    for (const n of graph.nodes) (this._deckRooms[n.deck] ??= []).push(n);

    this.buffer = new AgentBuffer(512);
    this.commands = new CommandQueue();
    this.events = [];
    this.calls = [];   // distress calls {id, node, t, faction, rolled:Set}
    this.callSeq = 0;
    this.floodKnown = false;
    this.firstSweepCleared = false;
    this.burnOrderNode = -1; // last DESIGNATE_BURN target (companion §2.2)
    this.lastStand = false;
    this.initialSquadMarines = agents.filter((a) => a.faction === FACTION.MARINE && !a.garrison).length;
    this.armoryStock = this.P.armory.stock; // rifles on the rack, first come first served
    this.outcome = null;

    this.stats = {
      conversions: 0, conversionsRound: 0, humansConverted: 0,
      carriersSeated: 0, formsMinted: 0, corpsesBurned: 0,
      infectionFormsKilled: 0, combatFormsDowned: 0, humansDead: 0,
      distressCalls: 0,
    };

    this._precomputeSensing();
    this.influence = {
      floodStr: new Float32Array(graph.n),
      humanStr: new Float32Array(graph.n),
      hardness: new Float32Array(graph.n),
    };
    this._floodAt = new Float32Array(graph.n);
    this._humanAt = new Uint16Array(graph.n);
    this.floodHoldSec = new Float64Array(graph.n); // solo-occupancy clock (darkness)
    this.gunfireTick = new Int32Array(graph.n).fill(-9999);
    this.screamTick = new Int32Array(graph.n).fill(-9999);
    this.sweptAt = new Float64Array(graph.n).fill(-9999); // last time a marine cleared a room
    this._panicked = new Uint8Array(graph.n);

    // FIRES (user rule): the breach burns, and the ship's BROKEN (jammed)
    // doors are the other fire sites — a broken door IS the damage showing.
    // Each fire is a real sim object: it hurts anyone standing in it, and
    // every NPC steers clear. Locked doors were already impassable, so the
    // door fires add area denial around the jam, not new blockage.
    this.fires = [];
    {
      const br = graph.node(graph.breachNode);
      this.fires.push({
        deck: br.deck, node: br.idx,
        x: br.x + this.rng.range(-br.w / 4, br.w / 4),
        y: br.y + this.rng.range(-br.d / 4, br.d / 4), scale: 1.7,
      });
      const brokenDoors = graph.edges.filter((e) => e.locked && e.door
        && graph.node(e.a).deck === graph.node(e.b).deck);
      const count = Math.min(brokenDoors.length, 2 + this.rng.int(3)); // 2-4 per seed
      for (let i = 0; i < count; i++) {
        const e = brokenDoors.splice(this.rng.int(brokenDoors.length), 1)[0];
        e.burning = true; // the renderer tints the panel; pathing already blocks it (locked)
        this.fires.push({ deck: graph.node(e.a).deck, node: e.a, x: e.door.x, y: e.door.y, scale: 0.9 });
      }
      // nobody SPAWNS inside a blaze (the initial swarm lands at the breach,
      // right where the biggest fire is): nudge the living out to the rim;
      // corpses caught inside it at the event are already charred husks
      for (const a of this.agents) {
        for (const f of this.fires) {
          if (a.deck !== f.deck) continue;
          const R = this.P.fire.radiusM * f.scale;
          const dx = a.x - f.x, dy = a.y - f.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R) continue;
          if (a.faction === FACTION.CORPSE) { a.damage = 100; continue; }
          const d = Math.sqrt(d2) || 0.001;
          const room = graph.node(a.node);
          const hw = Math.max(0.4, room.w / 2 - 0.3), hd = Math.max(0.4, room.d / 2 - 0.3);
          a.x = Math.max(room.x - hw, Math.min(room.x + hw, f.x + (dx / d) * (R + 0.6)));
          a.y = Math.max(room.y - hd, Math.min(room.y + hd, f.y + (dy / d) * (R + 0.6)));
        }
      }
    }

    this.hive = new Hive(this);
    assignFirstSweep(this);
    this._refreshOccupancy();
    this._computeInfluence();
    this.log('init', `seed "${this.seed}" — breach at ${graph.node(graph.breachNode).name}, ${agents.filter(isLivingHuman).length} souls aboard · flood ${this.P.flood.initialInfectionForms}i/${this.P.flood.initialCombatForms}c/${this.P.flood.initialCarriers}k · marines ${this.P.marines.squads}×${this.P.marines.squadSize} + ${this.P.marines.patrols} patrols + ${this.P.marines.garrison} garrison · ${this.P.crew.civilians} civ / ${this.P.crew.armedCrew} armed · ${this.P.bodies.eventCorpses} bodies`);
    this.writeBuffer();
  }

  // --- sensing precomputation: locks are fixed for the whole run ---
  _precomputeSensing() {
    const g = this.graph;
    this.visCache = [];
    this.senseCache = [];
    this.hear2 = [];
    this.hear3 = [];
    this.near1 = [];
    for (let i = 0; i < g.n; i++) {
      const vis = [i];
      // FLOOD LIFE-SENSE (user rule): the flood FEELS living bodies in every
      // adjacent compartment, through bulkheads and locked hatches alike —
      // it doesn't need a line of sight the way the crew's eyes do. senseCache
      // is self + EVERY std/vent neighbour regardless of lock/block; visCache
      // is the crew's honest sightline (unlocked doorways only). Same static
      // graph, so both are fixed for the whole run and fully deterministic.
      const sense = [i];
      for (const { to, link } of g.neighbors(i, ['std'], () => true)) {
        if (!link.locked) vis.push(to); // an open/unlocked doorway you can see through
        if (!sense.includes(to)) sense.push(to); // life-sense ignores the lock
      }
      for (const { to } of g.neighbors(i, ['vent'], () => true)) {
        if (!sense.includes(to)) sense.push(to); // and feels through the ducting
      }
      this.visCache.push(vis);
      this.senseCache.push(sense);
      this.hear2.push(g.nodesWithin(i, this.P.sensor.hearingHops, ['std'], () => true));
      this.hear3.push(g.nodesWithin(i, this.P.sensor.gunfireHops, ['std'], () => true));
      this.near1.push(g.nodesWithin(i, 1, ['std'], (l) => !l.locked));
    }
    // a grand stairwell is one open volume — the two levels see each other
    for (const s of g.stairwells) {
      if (!this.visCache[s.upper].includes(s.lower)) this.visCache[s.upper].push(s.lower);
      if (!this.visCache[s.lower].includes(s.upper)) this.visCache[s.lower].push(s.upper);
      if (!this.senseCache[s.upper].includes(s.lower)) this.senseCache[s.upper].push(s.lower);
      if (!this.senseCache[s.lower].includes(s.upper)) this.senseCache[s.lower].push(s.upper);
    }
  }

  visibleNodes(node) { return this.visCache[node]; }
  // the flood's life-sense reach (self + every adjacent room, lock or no lock).
  // Targeting/belief code uses this; the crew keep visibleNodes.
  floodSenses(node) { return this.senseCache[node]; }
  nodesNear(node, hops) { return hops <= 1 ? this.near1[node] : this.graph.nodesWithin(node, hops, ['std'], (l) => !l.locked); }

  occupants(node) { return this._occ[node]; }
  occupantsNear(node, hops) {
    const out = [];
    for (const n of this.nodesNear(node, hops)) out.push(...this._occ[n]);
    return out;
  }
  floodStrengthAt(node) { return this._floodAt[node]; }
  panickedAt(node) { return this._panicked[node] === 1; }
  heardGunfire(node) {
    return this.hear3[node].some((n) => this.tickCount - this.gunfireTick[n] < 30);
  }
  heardScreams(node) {
    return this.hear2[node].some((n) => this.tickCount - this.screamTick[n] < 30);
  }
  gunfireAt(node) { this.gunfireTick[node] = this.tickCount; }

  // Commander entry point (companion spec §0). Stamps the command
  // inputDelayTicks into the future so in multiplayer it reaches every peer
  // before its execution tick; in single-player that's ~1 tick, invisible.
  issue(cmd, peerId = 0) {
    this.commands.enqueue(cmd, this.tickCount + this.P.net.inputDelayTicks, peerId);
  }

  // THE PLAYER (3D slice): a real agent in the sim — the flood can see,
  // hunt, grab and convert them; marines and civilians treat them as crew.
  // Position is driven externally by the game each tick, so strict lockstep
  // determinism pauses while a live player is attached (their movement is an
  // input stream; the multiplayer path feeds it through the command queue).
  attachPlayer(nodeIdx, opts = {}) {
    const a = makeAgent(opts.odst ? FACTION.ARMED : FACTION.CIVILIAN, nodeIdx, this.graph);
    a.hp = a.maxHp = opts.odst ? 45 : this.P.combat.civilian.hp;
    a.isPlayer = true;
    a.hasRadio = true;
    this.spawn(a);
    this.log('radio', opts.odst
      ? 'an ODST hits the deck, MA5 hot (you)'
      : 'a lone survivor is moving through the ship (you)');
    return a;
  }

  // the ODST's squad (game rule): marines who form on the player and follow
  // via the standing escort order — they fight anything on contact, and the
  // usual morale rules apply
  attachPlayerSquad(playerAgent, size = 3) {
    const squad = {
      id: this.squads.length, members: [], objective: null, morale: 1,
      respondingTo: null, phase1: false,
      order: { kind: 'order:escort', entityId: playerAgent.id },
    };
    for (let i = 0; i < size; i++) {
      const m = makeAgent(FACTION.MARINE, playerAgent.node, this.graph);
      m.hp = m.maxHp = this.P.combat.marine.hp;
      m.hasRadio = true;
      m.squad = squad.id;
      squad.members.push(m.id);
      this.spawn(m);
    }
    squad.size0 = size;
    this.squads.push(squad);
    this.log('radio', `your fireteam forms up — ${size} marines on you`);
    return squad;
  }

  // the player takes up a rifle — from the armory rack or from a corpse
  // that died holding one (game rule: the survivor can fight back)
  playerArm(a, corpse = null) {
    if (corpse) corpse.wasArmed = false; // a form raised from it won't get the gun
    else this.armoryStock = Math.max(0, this.armoryStock - 1);
    a.faction = FACTION.ARMED;
    a.hp = a.maxHp = Math.max(a.hp, this.P.combat.armed.hp);
    this.log('combat', corpse
      ? 'the survivor takes a rifle from the dead (you)'
      : `the survivor arms up at the armory (you — ${this.armoryStock} rifles left)`);
  }

  emitCall(agent) {
    const call = { id: this.callSeq++, node: agent.node, t: this.t, faction: agent.faction, byId: agent.id, rolled: new Set() };
    this.calls.push(call);
    this.stats.distressCalls++;
    this.floodKnown = true;
    this.log('radio', `distress call from ${this.graph.node(agent.node).name}`, agent.node);
  }

  log(type, msg, node = -1) {
    this.events.push({ t: this.t, type, msg, node });
    if (this.events.length > 1600) this.events.splice(0, 200);
  }

  spawn(a) {
    this.agents.push(a);
    this.byId.set(a.id, a);
  }
  removeAgent(a) {
    a.dead = true;
    if (a.inShaftAmbush !== undefined) {
      this.graph.shafts[a.inShaftAmbush]?.ambushers?.delete(a.id);
    }
  }

  hurtHuman(a, dmg, by = -1) {
    if (a.hp <= 0 || a.dead) return;
    if (by >= 0 && dmg > 0) { a.lastHurtBy = by; a.lastHurtTick = this.tickCount; }
    a.hp -= dmg;
    if (a.hp <= 0) {
      this.stats.humansDead++;
      if (a.faction === FACTION.MARINE) {
        const squad = this.squads[a.squad];
        this.log('combat', `a marine falls in ${this.graph.node(a.node).name}`, a.node);
        if (squad) squad.calledContact = false; // survivors will call again
      }
      this.screamTick[a.node] = this.tickCount;
      humanDeathToCorpse(this, a);
    }
  }

  // --- pathing helpers used by all AI ---
  setPath(a, steps) {
    // steps: array of node indices or {to, link, layer} records
    const norm = [];
    let cur = a.node;
    for (const s of steps) {
      if (typeof s === 'number') {
        let found = null;
        for (const { to, link } of this.graph.neighbors(cur, ['std'], () => true)) {
          if (to === s) { found = { to, link, layer: 'std' }; break; }
        }
        if (!found) return false;
        norm.push(found); cur = s;
      } else { norm.push(s); cur = s.to; }
    }
    a.path = norm;
    return true;
  }
  setPathTo(a, target, layers, passFn) {
    const path = this.graph.path(a.node, target, layers, passFn);
    if (!path) return false;
    a.path = path;
    return true;
  }

  // ======================= main tick =======================
  tick() {
    const dt = this.dt;
    this.buffer.beginTick();
    this.tickCount++;
    this.t = this.tickCount * dt;

    this._refreshOccupancy();

    // apply commander commands scheduled for this tick, BEFORE any AI runs
    // (companion spec §0). Deterministic order; single producer in the POC.
    for (const entry of this.commands.collect(this.tickCount)) {
      applyCommand(this, entry);
    }

    // strategic tick ("infection round", §2.3)
    if (this.tickCount % this.strategicEvery === 0) {
      this._computeInfluence();
      this.hive.strategicTick();
      strategicSquads(this);
      this._checkSelfArming();
      this._checkLastStand();
      this._lastStandStragglers();
      this.stats.conversionsRound = 0;
      this._expireCalls();
    }

    updateHumansTick(this, dt);
    updateFloodTick(this, dt);
    this._advanceMovement(dt);
    this._separate(dt);
    this._fireAvoid(dt);
    this._fireDamage(dt);
    this._refreshOccupancy();
    this._advanceDarkness(dt);
    resolveCombat(this, dt);

    // scream noise from panic + grabs
    for (const a of this.agents) {
      if (a.dead) continue;
      if (a.panicked && a.hp > 0) this.screamTick[a.node] = this.tickCount;
      if (a.state === STATE.GRABBING) this.screamTick[a.node] = this.tickCount;
    }

    this._reap();
    this._checkOutcome();
    this.writeBuffer();
  }

  // LAST STAND (user note): once most of the squad marines are dead, the word
  // goes out — fall back behind the garrison line on the top deck. Officers
  // step out into the corridor to thicken the line. Radios are damaged and
  // people are scattered, so each survivor only HEARS the call on a roll.
  _checkLastStand() {
    if (this.lastStand || this.initialSquadMarines === 0) return;
    const alive = this.agents.reduce((n, a) => n +
      (!a.dead && a.hp > 0 && a.faction === FACTION.MARINE && !a.garrison ? 1 : 0), 0);
    if (alive > Math.ceil(this.initialSquadMarines * this.P.lastStand.marineFraction)) return;
    this.lastStand = true;
    this.lastStandAt = this.t;
    const g = this.graph;
    const line = g.byId.get('d1corr');
    const shelters = [g.byId.get('officer'), g.byId.get('cic'), g.byId.get('signal'), g.byId.get('bridge')];
    this.log('radio', `FALL BACK — all remaining hands to the command deck (${alive} marines left)`);
    // marine squads hear on the leader's radio roll and bind to the line;
    // broken/squadless marines roll alone
    for (const squad of this.squads) {
      const members = squad.members.map((id) => this.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (!members.length) continue;
      if (!squad.broken && this.rng.chance(this.P.lastStand.hearChance)) squad.lastStandBound = true;
      else if (squad.broken) {
        for (const m of members) if (this.rng.chance(this.P.lastStand.hearChance)) m.fallbackNode = line;
      }
    }
    let heard = 0, missed = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.helpless || a.garrison) continue;
      if (a.faction !== FACTION.CIVILIAN && a.faction !== FACTION.ARMED) continue;
      if (!this.rng.chance(this.P.lastStand.hearChance)) { missed++; continue; }
      heard++;
      if (a.stayPut) {
        // officers already on the top deck: some step out into the corridor
        // and join the marines' line (they keep holding once there)
        if (this.rng.chance(this.P.lastStand.officerJoinChance)) a.fallbackNode = line;
      } else if (a.faction === FACTION.ARMED) {
        // 80% of the armed crew STAND WITH THE MARINES on the line (user
        // note); the rest shepherd the civilians in the shelter rooms.
        // Line-holders lock in: they fight in place and never rout.
        if (this.rng.chance(this.P.lastStand.armedJoinFraction)) { a.fallbackNode = line; a.stayPut = true; }
        else a.fallbackNode = shelters[a.id % shelters.length];
      } else {
        a.fallbackNode = shelters[a.id % shelters.length];
      }
    }
    this.log('radio', `${heard} souls heard the call; ${missed} are still out there`);
  }

  // A minute after the call, whoever missed it works it out on their own —
  // the ship has gone quiet and everyone left alive heads for the line
  // (user note).
  _lastStandStragglers() {
    if (!this.lastStand || this._stragglersDone) return;
    if (this.t < this.lastStandAt + 60) return;
    this._stragglersDone = true;
    const g = this.graph;
    const line = g.byId.get('d1corr');
    const shelters = [g.byId.get('officer'), g.byId.get('cic'), g.byId.get('signal'), g.byId.get('bridge')];
    let n = 0;
    for (const squad of this.squads) {
      if (!squad.broken && !squad.lastStandBound
        && squad.members.some((id) => { const m = this.byId.get(id); return m && !m.dead && m.hp > 0; })) {
        squad.lastStandBound = true; n++;
      }
    }
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.helpless || a.garrison || a.fallbackNode !== undefined) continue;
      if (a.faction === FACTION.MARINE) {
        if (this.squads[a.squad]?.broken) { a.fallbackNode = line; n++; }
      } else if (a.faction === FACTION.ARMED && !a.stayPut) {
        a.fallbackNode = this.rng.chance(this.P.lastStand.armedJoinFraction) ? line : shelters[a.id % shelters.length];
        if (a.fallbackNode === line) a.stayPut = true;
        n++;
      } else if (a.faction === FACTION.CIVILIAN && !a.stayPut) {
        a.fallbackNode = shelters[a.id % shelters.length]; n++;
      }
    }
    if (n) this.log('radio', `the stragglers get the word — ${n} more fall back on their own`);
  }

  // Once panic breaks out shipwide (before any last stand), some unarmed
  // civilians make a run for the armory and arm themselves — first come,
  // first served on the remaining rifles (user note).
  _checkSelfArming() {
    if (this._armingRolled || !this.floodKnown) return;
    this._armingRolled = true;
    const armory = this.graph.byId.get('armory');
    let n = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.faction !== FACTION.CIVILIAN) continue;
      if (a.helpless || a.stayPut) continue;
      if (!this.rng.chance(this.P.armory.selfArmChance)) continue;
      a.armingUp = armory;
      n++;
    }
    if (n) this.log('radio', `word of the outbreak spreads — ${n} civilians make for the armory`);
  }

  _expireCalls() {
    this.calls = this.calls.filter((c) => this.t - c.t < this.P.radio.callFadeSec * 2);
  }

  // REAL SPACE LOGIC (user note): occupancy — who is IN a room for sensing,
  // reactions and combat — is decided by an agent's physical coordinates,
  // not by the node its pathfinder is bound to. A form ten meters into the
  // hangar IS in the hangar, even if its "move" hasn't completed yet.
  _refreshOccupancy() {
    const g = this.graph;
    this._occ = Array.from({ length: g.n }, () => []);
    this._floodAt.fill(0);
    this._humanAt.fill(0);
    this._panicked.fill(0);
    for (const a of this.agents) {
      if (a.dead) continue;
      a.pnode = this._pnodeOf(a);
      this._occ[a.pnode].push(a);
      if (isActiveFloodForm(a) || (a.faction === FACTION.CARRIER && a.hp > 0)) {
        this._floodAt[a.pnode] += W_FLOOD[a.faction];
      }
      if (a.hp > 0 && !a.dead && (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE)) {
        this._humanAt[a.pnode]++;
      }
      if (a.panicked && a.hp > 0) this._panicked[a.pnode] = 1;
    }
  }

  // A mover inside ducting or a cross-deck crawlway is physically inside the
  // ship's structure, not in any room — those keep their logical anchor (and
  // combat.js resolves them in their own shaft/vent groups).
  _physAnchored(a) {
    if (!a.move || a.move.layer === 'std') return true;
    if (a.move.layer === 'vent') return false;
    const l = a.move.link;
    return this.graph.node(l.a).deck === this.graph.node(l.b).deck; // same-deck crawl crosses open floor
  }

  // Which room rect actually contains this body. Prefers the current logical
  // node (cheap, and stable at shared-wall boundaries), then scans the deck.
  _pnodeOf(a) {
    if (!this._physAnchored(a)) return a.node;
    const inRect = (n) => n.deck === a.deck &&
      Math.abs(a.x - n.x) <= n.w / 2 + 0.4 && Math.abs(a.y - n.y) <= n.d / 2 + 0.4;
    if (inRect(this.graph.node(a.node))) return a.node;
    for (const n of this._deckRooms[a.deck] ?? []) if (inRect(n)) return n.idx;
    return a.node;
  }

  _computeInfluence() {
    const g = this.graph;
    const { floodStr, humanStr, hardness } = this.influence;
    floodStr.fill(0); humanStr.fill(0); hardness.fill(0);
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0) continue;
      const n = a.pnode ?? a.node;
      if (isActiveFloodForm(a) || a.faction === FACTION.CARRIER) floodStr[n] += W_FLOOD[a.faction];
      else if (isLivingHuman(a)) {
        humanStr[n] += W_HUMAN[a.faction];
        if (a.faction === FACTION.MARINE) hardness[n] += 1;
      }
    }
    // diffuse across every real connection (§6.2)
    const pass = (l) => (l.kind === 'std' ? !l.locked : l.kind === 'vent' ? !l.blocked : true);
    for (let pass_i = 0; pass_i < 2; pass_i++) {
      for (const arr of [floodStr, humanStr, hardness]) {
        const next = Float32Array.from(arr);
        for (let i = 0; i < g.n; i++) {
          for (const { to } of g.neighbors(i, ['std', 'shaft', 'vent'], pass)) {
            next[to] += arr[i] * 0.18;
          }
        }
        arr.set(next);
      }
    }
  }

  // REAL-DISTANCE travel (user note): seconds to cross a link = its measured
  // meters over the mover's speed, plus door/lift mechanics. Crawling through
  // shafts and ducting is pace-limited by the space, not the crawler.
  travelSec(link, mult) {
    const M = this.P.movement;
    const run = (link.horizM + link.vertM);
    if (link.kind === 'shaft') return run * M.crawlWindingFactor / M.shaftMps;
    if (link.kind === 'vent') return run * M.crawlWindingFactor / M.ventMps;
    const mps = M.baseMps * Math.max(0.2, mult);
    if (link.type === 'lift') return link.horizM / mps + M.liftSec;
    // a ladder transit is MOUNT + CLIMB — the walk to the pad already
    // happened in the room. Folding the link's fore-aft span into the hold
    // time made every one-at-a-time climb a ~12 s ladder monopoly and the
    // queues behind it jammed for minutes (user rule: queued, not jammed).
    if (link.type === 'ladder') return 1.0 + link.vertM / M.ladderClimbMps;
    return run / mps + (M.doorDelaySec[link.type] ?? 0);
  }

  _speedMult(a) {
    const S = this.P.speed;
    switch (a.faction) {
      case FACTION.CIVILIAN: return a.state === STATE.FLEE || a.panicked ? S.civilianFlee : S.civilian;
      case FACTION.ARMED: return a.state === STATE.FLEE ? S.civilianFlee : S.armed;
      case FACTION.MARINE: return S.marine;
      case FACTION.INFECTION: return S.infection;
      case FACTION.COMBAT: return a.dragging !== -1 ? S.drag : S.combatForm;
      case FACTION.CARRIER: return S.carrier;
      default: return 1;
    }
  }

  _advanceMovement(dt) {
    const g = this.graph;
    for (const a of this.agents) {
      a.hoverY = 0; // reset the leap arc each tick; _spatialSteer re-sets it
      if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) continue;
      // the player's body is moved by the game, not the pathfinder
      if (a.isPlayer) { a.animTime += dt; continue; }
      // a human with a form burrowing in (§ grabPins): the latch CANNOT be
      // broken — the host runs screaming in tight frantic circles until
      // someone physically shoots the thing off (user rule). The player's
      // own body stays game-driven (the pinned UX handles them).
      if (a.held === this.tickCount) {
        a.move = null;
        if (!a.isPlayer && (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE)) {
          a.panicked = true;
          a.heading += dt * 4.6; // tight spin — frantic circles
          const mps = this.P.movement.baseMps * 1.15;
          a.x += Math.cos(a.heading) * mps * dt;
          a.y += Math.sin(a.heading) * mps * dt;
          const room = this.graph.node(a.pnode ?? a.node);
          const hw = Math.max(0.4, room.w / 2 - 0.4), hd = Math.max(0.4, room.d / 2 - 0.4);
          a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x));
          a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y));
          a.animTime += dt;
          // and never stops screaming
          if ((this.tickCount + a.id) % 15 === 0) this.screamTick[a.node] = this.tickCount;
        }
        continue;
      }
      // LINE-OF-SIGHT ENGAGEMENT (user note): a form that physically shares
      // an open space with prey abandons its track and closes on the body
      // itself — see _spatialSteer
      if (this._spatialSteer(a, dt)) continue;
      if (a.state === STATE.FIGHT || a.state === STATE.GRABBING || a.state === STATE.COWER || a.state === STATE.AMBUSHING) {
        if (!a.move) {
          // fighters/grabbers/ambushers HOLD where they stand — sliding to a
          // parking slot at the room's center mid-fight is exactly the "it
          // all happens at the center" artifact this round removes
          if (a.state === STATE.COWER) this._parkDrift(a, dt);
          // marines/armed in a firefight fan out onto a line facing the room's
          // Flood instead of clumping at the doorway they came in through
          else if (a.state === STATE.FIGHT && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED)) this._firingDrift(a, dt);
          else a.animTime += dt;
          continue;
        }
      }
      if (a.move) {
        a.move.t += dt / a.move.travelSec;
        const from = g.node(a.move.from), to = g.node(a.move.to);
        const k = Math.min(1, a.move.t);
        const link = a.move.link;
        // HALLWAYS ARE SPACES, NOT LINKS (user note): a standard connection
        // is a doorway on the shared wall. The mover walks center → door →
        // center, and the moment it passes the door it IS in the next space —
        // it stands in that room's occupancy, sightlines and fire lanes for
        // the rest of the crossing. No more being "in" a room you left 15
        // seconds ago while halfway down the corridor.
        if (a.move.layer === 'std' && link.door && from.deck === to.deck) {
          const fwd = a.move.from === link.a;
          const flipT = a.move.flipT2 ?? (fwd ? link.flipT : 1 - link.flipT);
          const d = link.door;
          if (k < flipT) {
            const kk = k / flipT;
            const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
            a.x = sx + (d.x - sx) * kk;
            a.y = sy + (d.y - sy) * kk;
            a.heading = Math.atan2(d.y - sy, d.x - sx);
          } else {
            const kk = (k - flipT) / Math.max(1e-6, 1 - flipT);
            const tx = a.move.tx ?? to.x, ty = a.move.ty ?? to.y;
            a.x = d.x + (tx - d.x) * kk;
            a.y = d.y + (ty - d.y) * kk;
            a.heading = Math.atan2(ty - d.y, tx - d.x);
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
          }
        } else if (a.move.layer === 'std' && from.deck !== to.deck) {
          // VERTICAL TRANSIT (user note: no walking off the map): a body in
          // a lift or on a ladder is AT the trunk, not floating in the void
          // between deck plans. Stand on the origin pad until the handover,
          // then on the destination pad.
          const padX = (n, other) => Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x));
          const flipT = link.flipT ?? 0.5;
          // the leg = WALK to the pad at real speed (0..appT), ride/climb at
          // the origin pad (appT..handT), then stand on the far pad. appT is
          // sized from real meters at move start — the walk takes as long as
          // walking there normally would (user report: NPCs teleporting to
          // lifts and stairs)
          const appT = a.move.appT ?? 0.15;
          const handT = appT + (1 - appT) * flipT;
          if (k < appT) {
            const px = padX(from, to), py = from.y;
            const sx = a.move.sx ?? px, sy = a.move.sy ?? py;
            const kk = k / appT;
            a.x = sx + (px - sx) * kk;
            a.y = sy + (py - sy) * kk;
            a.heading = Math.atan2(py - sy, px - sx);
          } else if (k < handT) {
            a.x = padX(from, to); a.y = from.y;
          } else {
            a.x = padX(to, from); a.y = to.y;
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
          }
          a.heading = Math.atan2(to.y - from.y, to.x - from.x);
        } else {
          // VENT / SHAFT (user report: a crawler snapped to the room centre
          // then teleported to the opening). Three legs instead: WALK to the
          // marked duct opening (visible), CRAWL through the structure
          // (hidden), then CLIMB OUT the far opening to a parking slot
          // (visible). Only the middle leg is hidden, so you see them enter
          // and leave at the grates.
          const appT = a.move.appT ?? 0, exitT = a.move.exitT ?? 0;
          const eFromX = a.move.eFromX ?? from.x, eFromY = a.move.eFromY ?? from.y;
          const eToX = a.move.eToX ?? to.x, eToY = a.move.eToY ?? to.y;
          if (k < appT) {
            const kk = appT > 1e-6 ? k / appT : 1;
            const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
            a.x = sx + (eFromX - sx) * kk;
            a.y = sy + (eFromY - sy) * kk;
            a.heading = Math.atan2(eFromY - sy, eFromX - sx);
            a.move.hidden = false;
          } else if (k > 1 - exitT) {
            const kk = exitT > 1e-6 ? (k - (1 - exitT)) / exitT : 1;
            const tx = a.move.tx ?? to.x, ty = a.move.ty ?? to.y;
            a.x = eToX + (tx - eToX) * kk;
            a.y = eToY + (ty - eToY) * kk;
            a.heading = Math.atan2(ty - eToY, tx - eToX);
            a.move.hidden = false;
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
          } else {
            // inside the ductwork — hidden, sitting at the entry opening
            a.x = eFromX; a.y = eFromY;
            a.move.hidden = true;
          }
        }
        // formation lane (user note: no stacked dots): every mover holds a
        // personal lateral offset from the column line, so a squad on the
        // same route reads as a file of soldiers, not one dot
        if (a.move.layer === 'std' && from.deck === to.deck) {
          // SINGLE-FILE THROUGH DOORWAYS (user report: marines wedge shoulder
          // to shoulder in an opening). The lateral formation offset tapers to
          // zero as a body nears the door point, so a column funnels onto the
          // centreline to pass the ~1.7 m opening one at a time, then fans back
          // out into the room beyond. Full offset only in the open.
          const dr = a.move.link.door;
          const laneScale = dr ? Math.min(1, Math.hypot(a.x - dr.x, a.y - dr.y) / 2.2) : 1;
          if (a.faction === FACTION.INFECTION) {
            // pods don't march in file — they SKITTER, weaving side to side
            // as they cross (user note: point-to-point pod movement read as
            // robotic, nothing like the games)
            const w = Math.sin(this.t * 6 + a.id * 2.09) * 0.55 * laneScale;
            a.x += Math.cos(a.heading + Math.PI / 2) * w;
            a.y += Math.sin(a.heading + Math.PI / 2) * w;
          } else {
            const lane = (((a.id * 7919) % 100) / 100 - 0.5) * 1.5 * laneScale;
            a.x += Math.cos(a.heading + Math.PI / 2) * lane;
            a.y += Math.sin(a.heading + Math.PI / 2) * lane;
          }
          // the lane/weave offset must never push a body through the wall of
          // the room it's currently standing in (user report: hallway clip)
          this._clampToRoom(a, this.graph.node(a.node));
        }
        a.animTime += dt;
        if (a.move.t >= 1) {
          if (a.move.link.occupiedBy === a.id) a.move.link.occupiedBy = undefined; // ladder is free
          a.node = a.move.to;
          a.deck = to.deck;
          a.move = null;
          a.charging = false;
          a.firstStruckIn = undefined;
          if (a.state === STATE.MOVE) a.state = a.path.length ? STATE.MOVE : STATE.IDLE;
        }
        continue;
      }
      if (a.path.length) {
        const step = a.path[0];
        const link = step.link;
        // ground-truth passability check; the hive plans on a stale map (§6.1)
        let passable = true;
        if (link.kind === 'std' && link.locked) passable = false;
        if (link.kind === 'vent' && link.blocked) passable = false;
        const flood = a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER;
        if (flood && this.graph.burningUntil[step.to] > this.t) passable = false;
        if (!passable) {
          if (flood && (link.kind !== 'std' || link.locked)) this.hive.observeBlocked(link);
          a.path = [];
          continue;
        }
        // COMMITTED INFECTION (user rule: once a form commits to infecting a
        // body it must NEVER be interrupted). A form whose very next step
        // enters the room holding its own infect target — a corpse to burrow
        // (CONVERT), a downed form to raise (REANIMATE), or a live host to
        // latch (GRAB) — pushes straight through both "don't walk into guns"
        // reflexes below. Without this it balked → re-pathed → balked at the
        // threshold forever whenever humans stood in the target room next door
        // (user report: infection forms looping, never landing the infect).
        const committedInto = a.faction === FACTION.INFECTION
          && this._committedInfectNode(a) === step.to;
        // an infection form can SEE shooters through the next doorway; while
        // the pool is precious it will not skitter into standing fire — but
        // a rich hive spends forms like water (§13.3 RiskAversion). After a
        // few refusals it dashes anyway: balking forever at the only exit
        // pinned whole swarms at the breach (user-reported regression).
        if (a.faction === FACTION.INFECTION && !committedInto && link.kind === 'std' &&
          (this.hive.lastScarcity ?? 3) > 0.8 &&
          (a.doorBalks = (a.doorBalks ?? 0) + 1) <= 12 &&
          this._occ[step.to].some((h) => h.hp > 0 && !h.dead &&
            (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED))) {
          a.path = [];
          continue;
        }
        // POD MUSTER (user report: a single-file conga of infection forms
        // trickling into a defended room and dying one at a time, "infecting
        // nothing"): the FINAL hop into a room with live guns waits at the
        // threshold until the local pack outguns the defenders — then the
        // whole group pours in together and the overwhelm rule takes over.
        // A pod held too long gives the hunt up and goes back to breeding.
        if (a.faction === FACTION.INFECTION && !committedInto && link.kind === 'std' && a.path.length === 1) {
          let guns = 0;
          for (const h of this._occ[step.to]) {
            if (h.hp <= 0 || h.dead) continue;
            if (h.faction === FACTION.MARINE) guns += 1;
            else if (h.faction === FACTION.ARMED) guns += 0.6;
          }
          if (guns > 0 && !this.hive.allIn) {
            const pack = this._floodAt[a.node] + this._floodAt[step.to];
            if (pack < guns * this.P.swarm.killRatio) {
              a.doorHold = (a.doorHold ?? 0) + 1;
              if (a.doorHold > 45 * this.P.sim.tickHz) { // 45s of waiting — give it up
                a.doorHold = 0; a.path = []; a.task = null;
              }
              continue; // hold at the door; the pack is still building
            }
          }
          a.doorHold = 0;
        }
        // CLIMBING IS QUEUED (user rule): a LADDER takes one body at a time —
        // everyone else waits at the pad until the rungs are clear. Lifts are
        // cars: a whole fireteam rides together, no queue.
        const ladder = link.kind === 'std' && link.type === 'ladder'
          && this.graph.node(step.to).deck !== this.graph.node(a.node).deck;
        // hold at the pad while the rungs are taken — OR while the player has
        // called "next" on this ladder (a busy ladder queues the emergency,
        // it doesn't deny it; without the reservation NPCs re-claim the rungs
        // every tick and a human pressing a key can never win the race).
        // INFECTION FORMS ARE EXEMPT (user rule): they're small — a swarm
        // pours up the rungs and through lift wells all at once.
        const queues = ladder && a.faction !== FACTION.INFECTION;
        if (queues && (this.vertBusy(link, a.id) || this.vertReserved(link, a.id))) continue;
        a.doorBalks = 0;
        a.path.shift();
        let mult = this._speedMult(a);
        // lore: a combat form closing on prey doesn't walk — it CHARGES,
        // sprinting/leaping the last stretch (renderers get FLAG.CHARGING)
        a.charging = false;
        if (a.faction === FACTION.COMBAT && a.dragging === -1 && link.kind === 'std'
          && this._occ[step.to].some((h) => isLivingHuman(h))) {
          mult *= this.P.speed.chargeMult;
          a.charging = true;
        }
        // an infection form PURSUING a host keeps its skittering pace through
        // doorways too — at a walk it loses ground on every room the prey
        // flees through and the grab never lands (real-space pursuit)
        if (a.faction === FACTION.INFECTION && a.task?.kind === TASK.GRAB && link.kind === 'std') {
          mult *= this.P.speed.infectionLunge;
          a.charging = true;
        }
        // tiny per-agent pace variation staggers a column longitudinally so
        // simultaneous movers never sit on the exact same interpolation point
        const pace = 1 + ((a.id % 7) - 3) * 0.012;
        // sx/sy: the leg starts from where the body ACTUALLY stands (user
        // note: jerky movement) — interpolating from the room's center made
        // every parked/steered/separated agent snap onto the center line the
        // moment a move began
        a.move = { from: a.node, to: step.to, link, layer: link.kind, t: 0,
          sx: a.x, sy: a.y, travelSec: this.travelSec(link, mult) * pace };
        // DUCT NOISES (user: vents don't show on the map — the crew only
        // HEARS them): a form slipping into the ducting drops an ominous
        // log line, throttled per duct so it stays sparse.
        if ((link.kind === 'vent' || link.kind === 'shaft')
          && this.t - (link._ductLogAt ?? -99) > 12) {
          link._ductLogAt = this.t;
          const A = this.graph.node(link.a), B = this.graph.node(link.b);
          this.log('duct', A.deck === B.deck
            ? `something scuttles through the ducts near ${A.name}`
            : `noises in the ducts between decks ${Math.min(A.deck, B.deck)} and ${Math.max(A.deck, B.deck)}`,
            a.node);
        }
        // NO TELEPORTING TO LIFTS/STAIRS (user rule): a cross-deck leg pays
        // for the walk to the trunk pad at real walking speed BEFORE the
        // climb/ride time starts — appT marks where approach ends
        if (link.kind === 'std') {
          const fromN = this.graph.node(a.node), toN = this.graph.node(step.to);
          if (fromN.deck !== toN.deck) {
            const px = Math.max(fromN.x - fromN.w / 2 + 1.2, Math.min(fromN.x + fromN.w / 2 - 1.2, toN.x));
            const appSec = Math.hypot(px - a.x, fromN.y - a.y)
              / Math.max(0.5, this.P.movement.baseMps * mult);
            a.move.appT = appSec / (appSec + a.move.travelSec);
            a.move.travelSec += appSec;
          } else if (link.door) {
            // REAL METERS, REAL SPEED (user report: bodies "flying" faster
            // than they walk, and everyone converging on the room's center):
            // the leg is timed from the ACTUAL drawn path — start, through
            // the door, to this body's OWN parking slot in the next room —
            // and it LANDS on the slot, so nobody walks to the center point
            // just to drift back out of it.
            const [tx, ty] = this._parkSlot(a, toN);
            const d1 = Math.hypot(link.door.x - a.x, link.door.y - a.y);
            const d2 = Math.hypot(tx - link.door.x, ty - link.door.y);
            const mps = Math.max(0.5, this.P.movement.baseMps * mult);
            a.move.tx = tx; a.move.ty = ty;
            a.move.travelSec = Math.max(0.2, ((d1 + d2) / mps) * pace);
            a.move.flipT2 = d1 / Math.max(0.1, d1 + d2);
          }
        } else if (link.kind === 'vent' || link.kind === 'shaft') {
          // WALK TO THE DUCT OPENING (user report: crawler snaps to room
          // centre then teleports to the grate). The leg now pays real walk
          // time to the marked opening in this room, crawls hidden, then walks
          // out of the far opening to its own slot — visible at both grates.
          const fromN = this.graph.node(a.node), toN = this.graph.node(step.to);
          const eFrom = (a.node === link.a ? link.doorA : link.doorB) ?? link.door ?? { x: fromN.x, y: fromN.y };
          const eTo = (a.node === link.a ? link.doorB : link.doorA) ?? link.door ?? { x: toN.x, y: toN.y };
          const [tx, ty] = this._parkSlot(a, toN);
          const mps = Math.max(0.5, this.P.movement.baseMps * mult);
          const appSec = Math.hypot(eFrom.x - a.x, eFrom.y - a.y) / mps;
          const exitSec = Math.hypot(tx - eTo.x, ty - eTo.y) / mps;
          a.move.eFromX = eFrom.x; a.move.eFromY = eFrom.y;
          a.move.eToX = eTo.x; a.move.eToY = eTo.y;
          a.move.tx = tx; a.move.ty = ty;
          a.move.travelSec += appSec + exitSec;
          a.move.appT = appSec / a.move.travelSec;
          a.move.exitT = exitSec / a.move.travelSec;
        }
        if (queues) link.occupiedBy = a.id; // claim the ladder (pods never do)
        if (a.state === STATE.IDLE) a.state = STATE.MOVE;
      } else {
        this._parkDrift(a, dt);
      }
    }
  }

  // REAL SPACE COMBAT (user note): an enemy is engaged where it physically
  // IS, the moment both bodies share an open space — inside a room that's
  // immediate (rooms are convex; nothing blocks the sightline), not when a
  // pathfinding "move" happens to complete at the room's center. A combat
  // form abandons its track and runs straight AT its victim's live position;
  // an infection form with a grab order closes the last meters the same way.
  // combat.js gates claws/grabs on these same real distances.
  _spatialSteer(a, dt) {
    const P = this.P;
    if (a.isPlayer || a.state === STATE.GRABBING || a.state === STATE.AMBUSHING) return false;
    if (!this._physAnchored(a)) return false; // inside ducting/a cross-deck crawl
    const pn = a.pnode ?? a.node;
    let target = null, stopAt = 0, mps = 0;
    if (a.faction === FACTION.COMBAT) {
      if (a.downed || a.hp <= 0 || a.dragging !== -1) return false;
      const k = a.task?.kind;
      if (k === TASK.TRANSFORM || k === TASK.DECOY || k === TASK.BAIT) return false; // rooted / playing a role
      let best = null, bestD = Infinity, bestScore = Infinity;
      for (const h of this._occ[pn]) {
        if (h.dead || h.hp <= 0) continue;
        if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
        const d = Math.hypot(h.x - a.x, h.y - a.y);
        // shoot-back: a recent NEARBY attacker outranks nearer prey (hit
        // feedback) — but a form never abandons a kill to chase a distant
        // shooter through the room's focus fire
        const grudge = h.id === a.lastHurtBy && d < 8
          && this.tickCount - (a.lastHurtTick ?? -999) < 30 ? -6 : 0;
        const score = d + grudge;
        if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && h.id < (best?.id ?? Infinity))) {
          bestScore = score; bestD = d; best = h;
        }
      }
      if (!best) {
        // LINE OF SIGHT (user): a form already hunting doesn't lose its prey at
        // a doorway or ignore prey standing plainly in the next room. It SENSES
        // life in every adjacent compartment (floodSenses = self + every room
        // through a door OR vent, lock or no lock + the grand stairwell); if
        // prey is there, PATH to it — the graph handles the doorway — and keep
        // after it, instead of dropping to IDLE and drifting back into the room.
        const hunting = a.state === STATE.FIGHT || a.charging || a.task?.kind === TASK.ATTACK;
        if (hunting) {
          let pn2 = -1, pd = Infinity;
          for (const n of this.floodSenses(pn)) {
            if (n === pn) continue;
            for (const h of this._occ[n]) {
              if (h.dead || h.hp <= 0) continue;
              if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
              const d = Math.hypot(h.x - a.x, h.y - a.y) - (h.id === a.chargeTargetId ? 4 : 0);
              if (d < pd) { pd = d; pn2 = n; }
            }
          }
          // reach it through an unlocked doorway, else squeeze through the
          // ducting — a sensed body behind a locked hatch is still huntable
          if (pn2 >= 0 && (this.setPathTo(a, pn2, ['std'], (l) => !l.locked)
            || this.setPathTo(a, pn2, ['std', 'vent'], (l) => (l.kind === 'std' ? !l.locked : !l.blocked)))) {
            a.charging = true; a.state = STATE.MOVE;
            return false; // _advanceMovement walks the path through the doorway
          }
        }
        a.chargeTargetId = -1;
        if (a.state === STATE.FIGHT) { a.state = STATE.IDLE; a.charging = false; }
        return false;
      }
      target = best;
      a.chargeTargetId = best.id;
      stopAt = P.combat.meleeRangeM * 0.6;
      a.charging = bestD > P.combat.meleeRangeM; // the whole approach is a sprint (lore)
      // a leap crosses ~20% faster than a flat charge (user tuning) — a.leaping
      // persists from the prior tick's arc block
      mps = P.movement.baseMps * this._speedMult(a) * (a.charging ? P.speed.chargeMult : 1) * (a.leaping ? 1.2 : 1);
      a.state = STATE.FIGHT;
    } else if (a.faction === FACTION.INFECTION) {
      if (a.task?.kind !== TASK.GRAB || a.hp <= 0) return false;
      const t = this.byId.get(a.task.targetId);
      if (!t || t.dead || t.hp <= 0 || t.deck !== a.deck || (t.pnode ?? t.node) !== pn) return false;
      if (Math.hypot(t.x - a.x, t.y - a.y) <= P.combat.grabRangeM) return false; // latched — floodExec runs the grab
      target = t;
      stopAt = P.combat.grabRangeM * 0.6;
      mps = P.movement.baseMps * this._speedMult(a) * P.speed.infectionLunge; // skittering leap
      a.charging = true;
    } else return false;

    // engaged: the track is abandoned — the fight is HERE, in this room
    a.move = null;
    if (a.path.length) a.path = [];
    const room = this.graph.node(pn);
    if (a.node !== pn) { a.node = pn; a.deck = room.deck; }

    // LEAP decision — BEFORE the advance, so a leap COMMITS to a fixed landing
    // point and flies a ballistic arc to it (user: you can side-step and dodge
    // it) instead of curving through the air to track your live position. Only
    // a charging combat form, in a tall hold, over a long enough gap.
    const LEAP_MIN = 5, PEAK_FRAC = 0.25;
    const clearH = clearHeightOf(room);
    const canLeap = a.faction === FACTION.COMBAT && a.charging && clearH > CLEAR_H + 0.5;
    const gap = Math.hypot(target.x - a.x, target.y - a.y);
    if (canLeap && !a.leaping && gap > LEAP_MIN) {
      a.leaping = true; a.leapDist0 = gap;
      a.leapTX = target.x; a.leapTY = target.y; // committed landing spot at launch
    } else if (a.leaping && !canLeap) {
      a.leaping = false; a.leapDist0 = 0;
    }

    // aim at the committed landing spot while airborne, else the live target
    const aimX = a.leaping ? a.leapTX : target.x;
    const aimY = a.leaping ? a.leapTY : target.y;
    const hold = a.leaping ? 0 : stopAt;
    const dx = aimX - a.x, dy = aimY - a.y;
    const dist = Math.hypot(dx, dy);
    a.heading = Math.atan2(dy, dx);
    if (dist > hold) {
      const step = Math.min(dist - hold, mps * dt);
      a.x += (dx / dist) * step;
      a.y += (dy / dist) * step;
      this._clampToRoom(a, room); // stay inside the room's real footprint
    }

    // arc height from progress along the committed leap (0 at launch and land);
    // peak scales with the room's headroom, stays below the ceiling + body
    if (a.leaping) {
      const rem = Math.hypot(a.leapTX - a.x, a.leapTY - a.y);
      const p = Math.max(0, Math.min(1, 1 - rem / Math.max(0.5, a.leapDist0)));
      a.hoverY = Math.min(a.leapDist0 * PEAK_FRAC, clearH - 2.2) * 4 * p * (1 - p);
      if (rem <= 0.35) { a.leaping = false; a.leapDist0 = 0; } // landed — re-acquire next tick
    }
    a.animTime += dt;
    return true;
  }

  // PERSONAL SPACE (user rule): every body is SOLID — two agents can never
  // occupy the same patch of deck. A soft separation pass each tick pushes
  // apart any pair sharing a room that sit closer than their summed body
  // radii. Movers mid-link are excluded (formation lanes + pace jitter
  // already stagger them, and their position is re-derived from the link
  // next tick anyway); a latched grabber and its pinned victim stay put;
  // the player's body is game-driven, so it never gets shoved — everyone
  // else steps around it.
  _bodyRadius(a) {
    switch (a.faction) {
      case FACTION.CARRIER: return 0.75;
      case FACTION.COMBAT: return 0.48;
      case FACTION.INFECTION: return 0.32;
      default: return 0.4;
    }
  }

  // clamp a body so its whole RADIUS stays inside the room's walls (user
  // report: NPCs clipping through hallway walls when crowded — the old fixed
  // 0.3 m margin was smaller than a body radius, so a shoved body poked
  // through). In a corridor thinner than a body, at least pin to centerline.
  _clampToRoom(a, room) {
    const r = this._bodyRadius(a);
    const hw = Math.max(0, room.w / 2 - r), hd = Math.max(0, room.d / 2 - r);
    a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x));
    a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y));
  }

  _separate(dt) {
    const relax = Math.min(1, dt * 10);
    for (let n = 0; n < this.graph.n; n++) {
      const occ = this._occ[n];
      if (!occ || occ.length < 2) continue;
      const room = this.graph.node(n);
      // thin corridors can't absorb a sideways pile-up, so bias the push
      // ALONG the room's long axis when it's much longer than it is wide —
      // crowds spread down the hallway instead of squeezing into the walls
      const along = room.w >= room.d ? 0 : 1; // 0 = x is the long axis
      const narrow = Math.min(room.w, room.d) < 6;
      for (let i = 0; i < occ.length; i++) {
        const a = occ[i];
        if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.move) continue;
        for (let j = i + 1; j < occ.length; j++) {
          const b = occ[j];
          if (b.dead || b.faction === FACTION.CORPSE || b.downed || b.move) continue;
          const need = this._bodyRadius(a) + this._bodyRadius(b);
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= need * need) continue;
          const dist = Math.sqrt(d2);
          if (dist < 1e-6) { // exactly stacked: split along a deterministic axis
            const ang = ((a.id * 31 + b.id * 17) % 628) / 100;
            dx = Math.cos(ang); dy = Math.sin(ang);
          } else { dx /= dist; dy /= dist; }
          // in a narrow hallway, redirect a mostly-sideways shove into a
          // fore/aft one so nobody is driven into the bulkhead
          if (narrow) {
            if (along === 0 && Math.abs(dx) < 0.5) { dx = dx < 0 ? -1 : 1; dy = 0; }
            else if (along === 1 && Math.abs(dy) < 0.5) { dy = dy < 0 ? -1 : 1; dx = 0; }
          }
          const aMoves = !a.isPlayer && a.held !== this.tickCount;
          const bMoves = !b.isPlayer && b.held !== this.tickCount;
          if (!aMoves && !bMoves) continue;
          const push = (need - dist) * relax * (aMoves && bMoves ? 0.5 : 1);
          if (aMoves) { a.x -= dx * push; a.y -= dy * push; this._clampToRoom(a, room); }
          if (bMoves) { b.x += dx * push; b.y += dy * push; this._clampToRoom(b, room); }
        }
      }
    }
    // a latched grabber may have been shouldered aside — pull it back onto
    // its victim so the burrow never breaks from crowd pressure (two forms
    // fighting over one body now ring the body instead of stacking in it)
    for (const a of this.agents) {
      if (a.dead || a.state !== STATE.GRABBING || a.task?.kind !== TASK.GRAB) continue;
      const v = this.byId.get(a.task.targetId);
      if (!v || v.dead) continue;
      const d = Math.hypot(a.x - v.x, a.y - v.y);
      const max = this.P.combat.grabRangeM * 0.9;
      if (d > max && d > 1e-6) {
        const k = max / d;
        a.x = v.x + (a.x - v.x) * k;
        a.y = v.y + (a.y - v.y) * k;
      }
    }
  }

  // FLOOD DARKNESS (user rule): a room held by the flood ALONE accumulates
  // hold time — 60 s kills the lights (overgrown fixtures), 120 s fills it
  // with spore fog. Contested rooms hold their clock; rooms with no flood
  // recover at double speed (the crew's systems fight back). Deterministic:
  // a pure function of occupancy.
  _advanceDarkness(dt) {
    const D = this.P.darkness;
    for (let n = 0; n < this.graph.n; n++) {
      const was = this.floodHoldSec[n];
      if (this._floodAt[n] > 0 && this._humanAt[n] === 0) {
        this.floodHoldSec[n] = Math.min(D.maxHoldSec, was + dt);
      } else if (this._floodAt[n] === 0 && this._humanAt[n] > 0) {
        // humans holding the room WITHOUT flood beat the growth back
        this.floodHoldSec[n] = Math.max(0, was - dt * 2);
      } // empty or contested: the growth neither spreads nor dies
      const now = this.floodHoldSec[n];
      if (was < D.soloDarkSec && now >= D.soloDarkSec) {
        this.log('hive', `the lights die in ${this.graph.node(n).name} — the growth has taken the room`, n);
      } else if (was < D.fogSec && now >= D.fogSec) {
        this.log('hive', `spore fog thickens in ${this.graph.node(n).name}`, n);
      } else if (was >= D.soloDarkSec && now < D.soloDarkSec) {
        this.log('radio', `power flickers back on in ${this.graph.node(n).name}`, n);
      }
    }
  }

  darkAt(node) { return this.floodHoldSec[node] >= this.P.darkness.soloDarkSec; }
  fogAt(node) { return this.floodHoldSec[node] >= this.P.darkness.fogSec; }

  // GRENADES (game layer): a radial blast at a real point. Damage falls off
  // toward the edge, walls contain the burst (same physical room only), the
  // ship hears it, and corpses caught in it are shredded out of the hive's
  // economy. `by` feeds the hit-feedback/retargeting path.
  explodeAt(deck, x, y, radius, dmg, by = -1) {
    let node = -1;
    for (const n of this._deckRooms[deck] ?? []) {
      if (Math.abs(x - n.x) <= n.w / 2 + 0.4 && Math.abs(y - n.y) <= n.d / 2 + 0.4) { node = n.idx; break; }
    }
    if (node === -1) return 0;
    this.gunfireAt(node);
    let hits = 0;
    for (const a of this.agents) {
      if (a.dead || a.deck !== deck) continue;
      if ((a.pnode ?? a.node) !== node) continue; // walls contain the burst
      const d = Math.hypot(a.x - x, a.y - y);
      if (d > radius) continue;
      const k = dmg * (1 - (d / radius) * 0.7);
      if (a.faction === FACTION.CORPSE) { a.damage = Math.min(100, a.damage + k); continue; }
      if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
        hurtFloodForm(this, a, k, false, by);
        hits++;
      } else if (a.hp > 0 && !a.isPlayer) {
        this.hurtHuman(a, k, by);
        hits++;
      } else if (a.isPlayer && a.hp > 0) {
        this.hurtHuman(a, k * 0.5, by); // your own frag still bites through armor
        hits++;
      }
    }
    return hits;
  }

  // ONE BODY ON THE LADDER (user rule): is this cross-deck link held by a
  // live climber other than `selfId`? Stale claims (holder died, or was
  // yanked off the move by combat) self-heal — a claim only counts while
  // the holder is genuinely in transit on this link.
  vertBusy(link, selfId = -1) {
    const id = link.occupiedBy;
    if (id === undefined || id === selfId) return false;
    const h = this.byId.get(id);
    if (!h || h.dead) return false;
    if (h.isPlayer) return h.climbingLink === link;
    return !!(h.move && h.move.link === link);
  }

  // next-in-line reservation (player queueing): while the reserver lives,
  // NPCs yield the next slot on this ladder. Self-heals if they die.
  vertReserved(link, selfId = -1) {
    const id = link.reservedBy;
    if (id === undefined || id === selfId) return false;
    const h = this.byId.get(id);
    return !!(h && !h.dead);
  }

  // Parked agents each claim their OWN patch of floor (user note: no stacked
  // dots): a golden-angle spiral slot ranked by id among the room's living
  // occupants gives ~0.7 m spacing, clamped to the room's real footprint.
  _parkDrift(a, dt) {
    const nd = this.graph.node(a.node);
    const [tx, ty] = this._parkSlot(a, nd);
    a.x += (tx - a.x) * Math.min(1, dt * 3);
    a.y += (ty - a.y) * Math.min(1, dt * 3);
    a.animTime += dt;
  }

  // STABLE SLOTS (user note: jerky movement): each body's parking spot is
  // a pure hash of its OWN id — ranking against the room's other occupants
  // meant every arrival/death/departure reshuffled the whole room's
  // targets and everyone drifted to new points mid-fight. Collisions are
  // _separate's job. Move legs LAND here too, so arrivals never converge
  // on the room's center point.
  _parkSlot(a, nd) {
    const h1 = ((a.id * 2654435761) >>> 0) / 4294967296;
    const h2 = (((a.id + 7907) * 1597334677) >>> 0) / 4294967296;
    const hw = Math.max(0.7, nd.w / 2 - 1.0), hd = Math.max(0.7, nd.d / 2 - 1.0);
    const ang = h1 * Math.PI * 2 + nd.idx * 0.7;
    const u = Math.sqrt(h2);
    // full-footprint spread — a 6m cap clustered every big room's slots at
    // its center, so arrivals converged there and the separation pass then
    // shoved them apart (user report: marines "zipping to the middle of the
    // room then randomly deploying outward")
    return [nd.x + Math.cos(ang) * u * hw, nd.y + Math.sin(ang) * u * hd];
  }

  // COMMITTED INFECTION target (user rule): the physical node of the body a
  // form has committed to infect — a corpse it will burrow (CONVERT/DRAG), a
  // downed form it will raise (REANIMATE), or a live host it will latch
  // (GRAB) — or -1 if the form isn't on such an errand. Used to wave a
  // committed form through the doorway balk + pod muster so it can never be
  // turned back at the threshold of the room its target stands in.
  _committedInfectNode(a) {
    const t = a.task;
    if (!t) return -1;
    let id;
    if (t.kind === TASK.CONVERT || t.kind === TASK.DRAG) id = t.corpseId;
    else if (t.kind === TASK.GRAB || t.kind === TASK.REANIMATE) id = t.targetId;
    else return -1;
    const b = this.byId.get(id);
    if (!b || b.dead) return -1;
    return b.pnode ?? b.node;
  }

  // FIRING LINE (user note: marines clump in the doorway when a room goes hot —
  // spread out for wider lines of fire). A marine/armed in FIGHT holds a line
  // facing the room's Flood. Two stable per-id hashes place each shooter: one
  // LATERAL (across the line) and one in DEPTH (staggered ranks back from the
  // front). why: in a long thin artery the line runs athwartships across only
  // ~4 m, so lateral spread alone just re-made the clump at the junction (user
  // report: every game they pile at Main Corridor Fore). Staggering the squad
  // in depth down the corridor's long axis reads as a defensive LANE held back
  // from the threat, not a knot at the doorway. Both offsets are clamped to the
  // room's real reach along each axis; _separate resolves hash collisions.
  // Returns [x, y, fx, fy] (slot + unit facing toward the threat) or null when
  // there is no Flood in the room.
  _firingSlot(a, room) {
    const occ = this._occ[a.pnode ?? a.node];
    if (!occ) return null;
    let tx = 0, ty = 0, tn = 0, nShoot = 0;
    for (const o of occ) {
      const f = o.faction;
      if (f === FACTION.COMBAT || f === FACTION.CARRIER || f === FACTION.INFECTION) { tx += o.x; ty += o.y; tn++; }
      else if (f === FACTION.MARINE || f === FACTION.ARMED) nShoot++;
    }
    if (tn === 0) return null;
    tx /= tn; ty /= tn;
    const td = Math.hypot(tx - room.x, ty - room.y) || 1;
    const fx = (tx - room.x) / td, fy = (ty - room.y) / td; // toward the threat
    const px = -fy, py = fx;                                 // firing line runs across this
    const hw = Math.max(0.7, room.w / 2 - 1.0), hd = Math.max(0.7, room.d / 2 - 1.0);
    // how far the room reaches along the lateral (across) and depth (toward)
    // axes — small along a corridor's short axis, large down its length
    const latCap = Math.abs(px) * hw + Math.abs(py) * hd;
    const depCap = Math.abs(fx) * hw + Math.abs(fy) * hd;
    const h1 = ((a.id * 2654435761) >>> 0) / 4294967296;         // stable lateral slot
    const h2 = (((a.id + 7907) * 1597334677) >>> 0) / 4294967296; // stable depth rank
    // fan across the line (~0.9 m/shooter), but never past the walls
    const latSpread = Math.min(0.9 * Math.max(1, nShoot), Math.max(0, 2 * latCap - 0.4));
    const off = (h1 - 0.5) * latSpread;
    // stagger into ranks BEHIND the front, down whatever axis has the room to
    // give — this is what fills a corridor as a lane instead of a single knot
    const depth = h2 * Math.min(depCap * 0.85, 1.3 * Math.max(0, nShoot - 1));
    // hold the front rank a few meters short of the threat centroid (never step
    // onto it), then rank backward from there
    const standoff = Math.min(td - 1.2, Math.max(2.0, 0.5 * td));
    const ax = room.x + fx * standoff, ay = room.y + fy * standoff;
    return [ax + px * off - fx * depth, ay + py * off - fy * depth, fx, fy];
  }

  _firingDrift(a, dt) {
    const room = this.graph.node(a.pnode ?? a.node);
    const slot = this._firingSlot(a, room);
    if (!slot) { a.animTime += dt; return; }
    a.x += (slot[0] - a.x) * Math.min(1, dt * 2.2);
    a.y += (slot[1] - a.y) * Math.min(1, dt * 2.2);
    this._clampToRoom(a, room);
    a.heading = Math.atan2(slot[3], slot[2]); // face the threat
    a.animTime += dt;
  }

  // FIRE IS REAL (user rule): standing in a fire hurts — humans and flood
  // alike, the player included. Flame damage counts as fire for the flood
  // economy (burned husks don't convert).
  _fireDamage(dt) {
    const F = this.P.fire;
    for (const f of this.fires) {
      for (const a of this.agents) {
        if (a.dead || a.deck !== f.deck) continue;
        const dx = a.x - f.x, dy = a.y - f.y;
        const r = F.radiusM * f.scale;
        if (dx * dx + dy * dy > r * r) continue;
        if (a.faction === FACTION.CORPSE) {
          // a body in the flames chars — and a charred husk converts to nothing
          if (a.damage < 100) {
            a.damage = Math.min(100, a.damage + F.dps * dt * 2);
            if (a.damage >= 100) this.stats.corpsesBurned++;
          }
        } else if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
          hurtFloodForm(this, a, F.dps * dt, true);
        } else if (a.hp > 0) {
          this.hurtHuman(a, F.dps * dt);
        }
      }
    }
  }

  // ...and every NPC gives it a wide berth: a steady push out of the hot
  // zone that overrides parking and steering (movers passing near the
  // breach blaze take their lumps from _fireDamage instead)
  _fireAvoid(dt) {
    const F = this.P.fire;
    for (const f of this.fires) {
      const R = F.radiusM * f.scale + 1.0;
      for (const a of this.agents) {
        if (a.dead || a.isPlayer || a.deck !== f.deck || a.faction === FACTION.CORPSE) continue;
        if (a.held === this.tickCount) continue; // a frantic host isn't steering anything
        const dx = a.x - f.x, dy = a.y - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (R - d) * Math.min(1, dt * 6);
        const room = this.graph.node(a.pnode ?? a.node);
        const hw = Math.max(0.4, room.w / 2 - 0.3), hd = Math.max(0.4, room.d / 2 - 0.3);
        a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x + (dx / d) * push));
        a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y + (dy / d) * push));
      }
    }
  }

  _reap() {
    let changed = false;
    for (const a of this.agents) {
      if (!a.dead) continue;
      changed = true;
      // a dead claimant RELEASES its claims — leaked claims left whole rooms
      // of corpses "spoken for" forever, so later forms crossed to them and
      // doubled straight back with nothing to eat (user report)
      const t = a.task;
      if (t) {
        if (t.corpseId !== undefined) {
          const b = this.byId.get(t.corpseId);
          if (b && !b.dead) b.claimed = false;
        }
        if (t.targetId !== undefined) {
          const d = this.byId.get(t.targetId);
          if (d && !d.dead && d.claimed) d.claimed = false;
        }
      }
      this.byId.delete(a.id);
    }
    if (changed) this.agents = this.agents.filter((a) => !a.dead);
  }

  _checkOutcome() {
    if (this.outcome) return;
    const anyFlood = this.agents.some((a) => !a.dead &&
      (isActiveFloodForm(a) || a.faction === FACTION.CARRIER ||
        (a.faction === FACTION.COMBAT && a.downed && a.damage < 100)));
    const anyHuman = this.agents.some((a) => !a.dead && isLivingHuman(a));
    if (!anyFlood) {
      this.outcome = 'contained';
      this.log('end', `OUTBREAK CONTAINED at ${fmtTime(this.t)} — the ship survives`);
    } else if (!anyHuman) {
      this.outcome = 'lost';
      this.log('end', `SHIP LOST at ${fmtTime(this.t)} — the Flood owns the Charon`);
    }
  }

  // --- the one shared boundary (§2.2) ---
  writeBuffer() {
    const b = this.buffer;
    let i = 0;
    for (const a of this.agents) {
      if (a.dead || i >= b.capacity) continue;
      b.id[i] = a.id;
      b.faction[i] = a.faction;
      b.state[i] = a.state;
      b.nodeId[i] = a.node;
      b.posX[i] = a.x;
      b.posY[i] = a.y;
      b.posZ[i] = a.deck;
      b.hoverY[i] = a.hoverY || 0;
      b.headingR[i] = a.heading;
      b.animClip[i] = this._clipFor(a);
      b.animTime[i] = a.animTime;
      b.integrity[i] = a.hp;
      b.damage[i] = a.damage;
      b.tint[i] = TINT[a.faction];
      let flags = 0;
      if (a.hasRadio) flags |= FLAG.HAS_RADIO;
      if (a.helpless) flags |= FLAG.HELPLESS;
      if (a.downed && a.damage < 100) flags |= FLAG.REANIMATABLE;
      if (a.downed) flags |= FLAG.DOWNED;
      if (a.panicked) flags |= FLAG.PANICKED;
      // hidden ONLY during the mid-crawl through the structure — the body is
      // visible walking to the grate and climbing out the far one (user: no
      // snap-to-center-then-teleport; go to a marked opening and vanish there)
      if (a.move && a.move.layer === 'vent' && a.move.hidden) flags |= FLAG.EXPOSED;
      if (a.inShaftAmbush !== undefined) flags |= FLAG.AMBUSH;
      if (a.damage >= 100) flags |= FLAG.BURNED;
      if (a.flamer) flags |= FLAG.FLAMER;
      if (a.move && a.move.layer === 'shaft' && a.move.hidden) flags |= FLAG.IN_SHAFT;
      // armed corpses carry the flag too so the renderer can lay the right
      // body down (and drop a rifle beside it)
      if (a.hostArmed || (a.faction === FACTION.CORPSE && a.wasArmed && a.damage < 100)) flags |= FLAG.ARMED_HOST;
      if (a.charging) flags |= FLAG.CHARGING;
      if (a.hoverY > 0.05) flags |= FLAG.LEAPING;
      if (a.lastHurtTick !== undefined && this.tickCount - a.lastHurtTick < 4) flags |= FLAG.FLINCH;
      b.flags[i] = flags;
      i++;
    }
    b.count = i;
  }

  _clipFor(a) {
    if (a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) return CLIP.DEATH;
    if (a.state === STATE.GRABBING || a.state === STATE.FIGHT) return CLIP.ATTACK;
    if (a.faction === FACTION.INFECTION) return a.move ? CLIP.RUN : CLIP.WRITHE;
    if (a.move) return this._speedMult(a) > 1.2 ? CLIP.RUN : CLIP.WALK;
    return CLIP.IDLE;
  }

  getStats() {
    const alive = { civ: 0, armed: 0, marine: 0, infection: 0, combat: 0, combatDowned: 0, carrier: 0, corpses: 0, burnedHusks: 0 };
    for (const a of this.agents) {
      if (a.dead) continue;
      switch (a.faction) {
        case FACTION.CIVILIAN: if (a.hp > 0) alive.civ++; break;
        case FACTION.ARMED: if (a.hp > 0) alive.armed++; break;
        case FACTION.MARINE: if (a.hp > 0) alive.marine++; break;
        case FACTION.INFECTION: alive.infection++; break;
        case FACTION.COMBAT: a.downed ? alive.combatDowned++ : alive.combat++; break;
        case FACTION.CARRIER: alive.carrier++; break;
        case FACTION.CORPSE: a.damage >= 100 ? alive.burnedHusks++ : alive.corpses++; break;
      }
    }
    let floodNodes = 0;
    for (let n = 0; n < this.graph.n; n++) {
      if (this.influence.floodStr[n] > this.influence.humanStr[n] && this.influence.floodStr[n] > 0.5) floodNodes++;
    }
    const gestating = this.agents.reduce((s, a) =>
      s + (!a.dead && a.faction === FACTION.CARRIER ? (a.held ?? 0) : 0), 0);
    return {
      t: this.t, tick: this.tickCount, outcome: this.outcome,
      scarcity: this.hive.lastScarcity ?? this.hive.scarcity(this.P.flood.initialInfectionForms),
      opening: this.hive.opening,
      floodControlled: floodNodes,
      gestating,
      ...alive, ...this.stats,
    };
  }

  // deterministic fingerprint for the seed-replay check (§2.1)
  hashState() {
    let h = 2166136261 >>> 0;
    const mix = (v) => {
      h ^= v & 0xffff; h = Math.imul(h, 16777619);
      h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 16777619);
    };
    for (const a of this.agents) {
      mix(a.id); mix(a.faction); mix(a.node);
      mix(Math.round(a.x * 16)); mix(Math.round(a.y * 16));
      mix(Math.round(a.hp * 16)); mix(Math.round(a.damage * 16));
    }
    mix(this.tickCount);
    return h >>> 0;
  }
}

export function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k]) deepMerge(dst[k], src[k]);
    else dst[k] = src[k];
  }
}
