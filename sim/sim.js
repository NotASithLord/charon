// Sim orchestrator (§2): fixed 15 Hz movement/sense tick, ~2.5 s strategic
// tick ("infection round"), deterministic from seed, writes the shared
// AgentBuffer every tick (§2.2).

import { RNG } from '../shared/rng.js';
import { cloneParams } from '../shared/params.js';
import { AgentBuffer, FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { initRun, STATE } from './init.js';
import { updateHumansTick, strategicSquads, assignFirstSweep } from './humans.js';
import { Hive, W_FLOOD, W_HUMAN, isActiveFloodForm, isLivingHuman } from './hive.js';
import { updateFloodTick } from './floodExec.js';
import { resolveCombat, humanDeathToCorpse } from './combat.js';
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
    this.outcome = null;

    this.stats = {
      conversions: 0, conversionsRound: 0, humansConverted: 0,
      carriersSeated: 0, formsMinted: 0, corpsesBurned: 0,
      infectionFormsKilled: 0, combatFormsDowned: 0, humansDead: 0,
      distressCalls: 0, formsShotInVents: 0,
    };

    this._precomputeSensing();
    this.influence = {
      floodStr: new Float32Array(graph.n),
      humanStr: new Float32Array(graph.n),
      hardness: new Float32Array(graph.n),
    };
    this._floodAt = new Float32Array(graph.n);
    this.gunfireTick = new Int32Array(graph.n).fill(-9999);
    this.screamTick = new Int32Array(graph.n).fill(-9999);
    this.sweptAt = new Float64Array(graph.n).fill(-9999); // last time a marine cleared a room
    this._panicked = new Uint8Array(graph.n);

    this.hive = new Hive(this);
    assignFirstSweep(this);
    this._refreshOccupancy();
    this._computeInfluence();
    this.log('init', `seed "${this.seed}" — breach at ${graph.node(graph.breachNode).name}, ${agents.filter(isLivingHuman).length} souls aboard · starting flood: ${this.P.flood.initialInfectionForms} inf / ${this.P.flood.initialCombatForms} cf / ${this.P.flood.initialCarriers} car`);
    this.writeBuffer();
  }

  // --- sensing precomputation: locks are fixed for the whole run ---
  _precomputeSensing() {
    const g = this.graph;
    this.visCache = [];
    this.hear2 = [];
    this.hear3 = [];
    this.near1 = [];
    for (let i = 0; i < g.n; i++) {
      const vis = [i];
      for (const { to, link } of g.neighbors(i, ['std'], () => true)) {
        if (!link.locked) vis.push(to); // an open/unlocked doorway you can see through
      }
      this.visCache.push(vis);
      this.hear2.push(g.nodesWithin(i, this.P.sensor.hearingHops, ['std'], () => true));
      this.hear3.push(g.nodesWithin(i, this.P.sensor.gunfireHops, ['std'], () => true));
      this.near1.push(g.nodesWithin(i, 1, ['std'], (l) => !l.locked));
    }
  }

  visibleNodes(node) { return this.visCache[node]; }
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

  emitCall(agent) {
    const call = { id: this.callSeq++, node: agent.node, t: this.t, faction: agent.faction, byId: agent.id, rolled: new Set() };
    this.calls.push(call);
    this.stats.distressCalls++;
    this.floodKnown = true;
    this.log('radio', `distress call from ${this.graph.node(agent.node).name}`, agent.node);
  }

  log(type, msg, node = -1) {
    this.events.push({ t: this.t, type, msg, node });
    if (this.events.length > 400) this.events.splice(0, 100);
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

  hurtHuman(a, dmg) {
    if (a.hp <= 0 || a.dead) return;
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
    this._refreshOccupancy();
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
    this.armoryStock = this.P.armory.stock;
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

  _refreshOccupancy() {
    const g = this.graph;
    this._occ = Array.from({ length: g.n }, () => []);
    this._floodAt.fill(0);
    this._panicked.fill(0);
    for (const a of this.agents) {
      if (a.dead) continue;
      this._occ[a.node].push(a);
      if (isActiveFloodForm(a) || (a.faction === FACTION.CARRIER && a.hp > 0)) {
        this._floodAt[a.node] += W_FLOOD[a.faction];
      }
      if (a.panicked && a.hp > 0) this._panicked[a.node] = 1;
    }
  }

  _computeInfluence() {
    const g = this.graph;
    const { floodStr, humanStr, hardness } = this.influence;
    floodStr.fill(0); humanStr.fill(0); hardness.fill(0);
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0) continue;
      if (isActiveFloodForm(a) || a.faction === FACTION.CARRIER) floodStr[a.node] += W_FLOOD[a.faction];
      else if (isLivingHuman(a)) {
        humanStr[a.node] += W_HUMAN[a.faction];
        if (a.faction === FACTION.MARINE) hardness[a.node] += 1;
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
    if (link.type === 'ladder') return link.horizM / mps + link.vertM / M.ladderClimbMps;
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
      if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) continue;
      // a human currently in a Flood form's grip can't move (§ grabPins)
      if (a.held === this.tickCount) { a.move = null; continue; }
      if (a.state === STATE.FIGHT || a.state === STATE.GRABBING || a.state === STATE.COWER || a.state === STATE.AMBUSHING) {
        if (!a.move) { this._parkDrift(a, dt); continue; }
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
          const flipT = fwd ? link.flipT : 1 - link.flipT;
          const d = link.door;
          if (k < flipT) {
            const kk = k / flipT;
            a.x = from.x + (d.x - from.x) * kk;
            a.y = from.y + (d.y - from.y) * kk;
            a.heading = Math.atan2(d.y - from.y, d.x - from.x);
          } else {
            const kk = (k - flipT) / Math.max(1e-6, 1 - flipT);
            a.x = d.x + (to.x - d.x) * kk;
            a.y = d.y + (to.y - d.y) * kk;
            a.heading = Math.atan2(to.y - d.y, to.x - d.x);
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
          }
        } else {
          a.x = from.x + (to.x - from.x) * k;
          a.y = from.y + (to.y - from.y) * k;
          a.heading = Math.atan2(to.y - from.y, to.x - from.x);
          // lifts/ladders hand over halfway up the trunk; shaft/vent crawlers
          // keep their special mid-link combat model and flip on arrival
          if (a.move.layer === 'std' && k >= (link.flipT ?? 0.5) && a.node !== a.move.to) {
            a.node = a.move.to; a.deck = to.deck;
          }
        }
        a.animTime += dt;
        if (a.move.t >= 1) {
          a.node = a.move.to;
          a.deck = to.deck;
          a.move = null;
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
        // an infection form can SEE shooters through the next doorway; while
        // the pool is precious it will not skitter into standing fire — but
        // a rich hive spends forms like water (§13.3 RiskAversion). After a
        // few refusals it dashes anyway: balking forever at the only exit
        // pinned whole swarms at the breach (user-reported regression).
        if (a.faction === FACTION.INFECTION && link.kind === 'std' &&
          (this.hive.lastScarcity ?? 3) > 0.8 &&
          (a.doorBalks = (a.doorBalks ?? 0) + 1) <= 12 &&
          this._occ[step.to].some((h) => h.hp > 0 && !h.dead &&
            (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED))) {
          a.path = [];
          continue;
        }
        a.doorBalks = 0;
        a.path.shift();
        a.move = { from: a.node, to: step.to, link, layer: link.kind, t: 0, travelSec: this.travelSec(link, this._speedMult(a)) };
        if (a.state === STATE.IDLE) a.state = STATE.MOVE;
      } else {
        this._parkDrift(a, dt);
      }
    }
  }

  // parked agents drift to a personal offset inside the room's real footprint
  _parkDrift(a, dt) {
    const nd = this.graph.node(a.node);
    const ang = (a.id * 2.399963) % (Math.PI * 2);
    const frac = ((a.id * 7919) % 100) / 100 * 0.85;
    const tx = nd.x + Math.cos(ang) * (nd.w / 2 - 1.2) * frac;
    const ty = nd.y + Math.sin(ang) * (nd.d / 2 - 1.2) * frac;
    a.x += (tx - a.x) * Math.min(1, dt * 3);
    a.y += (ty - a.y) * Math.min(1, dt * 3);
    a.animTime += dt;
  }

  _reap() {
    let changed = false;
    for (const a of this.agents) if (a.dead) { changed = true; this.byId.delete(a.id); }
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
      if (a.move && a.move.layer === 'vent') flags |= FLAG.EXPOSED;
      if (a.inShaftAmbush !== undefined) flags |= FLAG.AMBUSH;
      if (a.damage >= 100) flags |= FLAG.BURNED;
      if (a.flamer) flags |= FLAG.FLAMER;
      if (a.move && a.move.layer === 'shaft') flags |= FLAG.IN_SHAFT;
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
