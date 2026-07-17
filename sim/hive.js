// Flood hive AI (§6) driven by the decision math in §13. One brain; forms
// are dumb actuators executing tasks. No phase flags anywhere: hide/invest/
// snowball/rampage all fall out of the scarcity term.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE } from './init.js';
import { humanPass } from './graph.js';

export const TASK = {
  MOVE: 'move',            // {node}
  GRAB: 'grab',            // {targetId}
  CONVERT: 'convert',      // {corpseId} corpse -> combat form (costs the form)
  SEAT: 'seat',            // {corpseId} corpse -> carrier (costs the body only)
  GUARD: 'guard',          // {node} defend a carrier
  REANIMATE: 'reanimate',  // {targetId} downed combat form
  DRAG: 'drag',            // {corpseId, node} haul carrier food
  AMBUSH: 'ambush',        // {linkIdx, end} lie in wait mid-shaft
  BAIT: 'bait',            // {squadId, shaftIdx} get seen, retreat through shaft
  ATTACK: 'attack',        // {node} open aggression (rampage)
  SCOUT: 'scout',          // {node} refresh a lost belief — costs forms to look
};

const W_HUMAN = { [FACTION.CIVILIAN]: 0.1, [FACTION.ARMED]: 0.6, [FACTION.MARINE]: 1.0 };
const W_FLOOD = { [FACTION.INFECTION]: 0.25, [FACTION.COMBAT]: 1.0, [FACTION.CARRIER]: 0.5 };

export class Hive {
  constructor(sim) {
    this.sim = sim;
    // Stale map (§6.1): the hive knows the ship AS DESIGNED. Locks and vent
    // blockages are discovered only when a form runs into them.
    this.knownLocked = new Set();
    this.knownBlockedVents = new Set();
    // Belief per human (§6.1), seeded with absorbed-crew knowledge: it knows
    // the brig/medbay are stocked and where the barracks squads berth. It
    // does NOT know where detached squads happen to be — the sweep ETA it
    // races is a guess (§6.7).
    this.beliefs = new Map(); // humanId -> {node, t, conf, static}
    this.believedHumanStr = new Float32Array(sim.graph.n);
    this.believedHardness = new Float32Array(sim.graph.n);
    this.opening = true;
    this.carrierSite = -1;
    this.sweepEtaSec = Infinity;
    this.baitCooldownUntil = 0;
    // static distance-from-garrison field (absorbed map knowledge): dens and
    // carrier sites want to be far from where armed humans muster
    const garrison = [
      ...sim.graph.nodesWithRole('armory'),
      ...sim.graph.nodesWithRole('marines'),
      ...sim.graph.nodesWithRole('odst'),
    ];
    this.garrisonDist = sim.graph.flowField(garrison, ['std'], () => true).dist;
    const barracks = sim.graph.byId.get('barracks');
    for (const a of sim.agents) {
      if (a.dead) continue;
      if (a.faction === FACTION.CIVILIAN && a.helpless) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.9, static: true });
      else if (a.faction === FACTION.CIVILIAN) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.3 });
      else if (a.faction === FACTION.ARMED) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.25 });
      else if (a.faction === FACTION.MARINE) this.beliefs.set(a.id, { node: a.node, t: 0, conf: a.node === barracks ? 0.8 : 0.2 });
    }
  }

  // --- stale-map passability: believed, not actual ---
  infectionPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    if (link.kind === 'std') return !this.knownLocked.has(link.i) || !link.lockable;
    return link.kind === 'vent' && !this.knownBlockedVents.has(link.i);
  };
  bigPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    if (link.kind === 'std') return !this.knownLocked.has(link.i);
    return link.kind === 'shaft';
  };

  observeBlocked(link) {
    const g = this.sim.graph;
    if (link.kind === 'std' && !this.knownLocked.has(link.i)) {
      this.knownLocked.add(link.i);
      this.sim.log('hive', `hive discovers a locked ${link.type} (${g.node(link.a).name} ↔ ${g.node(link.b).name}) — re-planning`);
    } else if (link.kind === 'vent' && !this.knownBlockedVents.has(link.i)) {
      this.knownBlockedVents.add(link.i);
      this.sim.log('hive', `hive finds a collapsed vent (${g.node(link.a).name} ↔ ${g.node(link.b).name})`);
    }
  }

  // --- §13.2 scarcity: the engine of emergent phases ---
  scarcity(I) {
    const P = this.sim.P.hive;
    return Math.min(P.scarcityMax, Math.max(P.scarcityMin, Math.pow(P.I_ref / Math.max(I, 1), P.kS)));
  }

  // --- belief maintenance (§6.1, §13.6) ---
  updateBeliefs() {
    const sim = this.sim, dt = sim.P.sim.strategicTickSec;
    const lambda = sim.P.belief.decayRatePerSec;
    for (const b of this.beliefs.values()) {
      if (!b.static) b.conf *= Math.exp(-lambda * dt);
    }
    // any form with LOS resets the record
    const seen = new Set();
    for (const f of sim.agents) {
      if (f.dead || !isActiveFloodForm(f)) continue;
      for (const n of sim.visibleNodes(f.node)) {
        for (const h of sim.occupants(n)) {
          if (!isLivingHuman(h) || seen.has(h.id)) continue;
          seen.add(h.id);
          const old = this.beliefs.get(h.id);
          this.beliefs.set(h.id, { node: h.node, t: sim.t, conf: 1, static: old?.static && h.helpless });
        }
      }
    }
    // believed strength fields (§13.6): probability mass spreads over nodes
    // reachable since last seen; q (prediction quality) sharpens it toward
    // the hive's model of where humans run
    const P = sim.P;
    this.believedHumanStr.fill(0);
    this.believedHardness.fill(0);
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0) { this.beliefs.delete(id); continue; }
      if (b.conf < 0.05) continue;
      const w = W_HUMAN[h.faction] * b.conf;
      const dtSeen = sim.t - b.t;
      const spreadHops = b.static ? 0 : Math.min(4, Math.floor(P.belief.humanSpeedHops * dtSeen));
      const q = P.belief.predictionQuality;
      if (spreadHops === 0 || b.conf > 0.95) {
        this.believedHumanStr[b.node] += w;
        if (h.faction === FACTION.MARINE) this.believedHardness[b.node] += w;
      } else {
        const nodes = sim.graph.nodesWithin(b.node, spreadHops, ['std'], humanPass);
        let total = 0;
        const score = nodes.map((n) => {
          const model = 1 / (1 + sim.influence.floodStr[n] * 3);
          const s = (1 - q) + q * model;
          total += s;
          return s;
        });
        nodes.forEach((n, i) => {
          const p = score[i] / total;
          this.believedHumanStr[n] += w * p;
          if (h.faction === FACTION.MARINE) this.believedHardness[n] += w * p;
        });
      }
    }
  }

  // --- route risk (§13.8) ---
  routeRisk(path) {
    if (!path) return 1;
    const g = this.sim.graph;
    let risk = 0;
    for (const step of path) {
      if (step.layer === 'vent') risk += this.ventWatched(step.link) * 0.5;
      else if (step.layer === 'shaft') risk += Math.min(1, this.believedHardness[step.link.a] + this.believedHardness[step.link.b]) * 0.6;
      else {
        risk += Math.min(1.0, this.believedHumanStr[step.to] * 1.0);
        // absorbed doctrine: arteries and open bays carry patrol traffic
        // whether or not the hive has a current belief about them
        const nd = g.node(step.to);
        if (nd.roles.includes('artery') || nd.type === 'open') risk += 0.25;
      }
    }
    return Math.min(2.5, risk);
  }

  ventWatched(link) {
    let w = 0;
    for (const end of [link.a, link.b]) {
      w += this.believedHardness[end] + this.believedHumanStr[end] * 0.5;
      for (const { to } of this.sim.graph.neighbors(end, ['std'], () => true)) {
        w += this.believedHardness[to] * 0.5; // motion tracker range 1 hop
      }
    }
    return Math.min(1, w);
  }

  // Stealth pathing (§6.3): prefer routes around believed human presence and
  // watched vents; fall back to the direct route when there is no choice.
  stealthPath(from, to, kind) {
    const g = this.sim.graph;
    const layers = kind === 'infection' ? ['std', 'vent'] : ['std', 'shaft'];
    const base = kind === 'infection' ? this.infectionPass : this.bigPass;
    const quiet = (l, a, b) => {
      if (!base(l, a, b)) return false;
      if (b !== to && this.believedHumanStr[b] > 0.25) return false;
      if (l.kind === 'vent' && this.ventWatched(l) > 0.5) return false;
      return true;
    };
    return g.path(from, to, layers, quiet) ?? g.path(from, to, layers, base);
  }
  safeInfectionPath(from, to) { return this.stealthPath(from, to, 'infection'); }

  // --- sweep ETA (§6.7/§13.5): a belief, not ground truth ---
  estimateSweepEta() {
    const sim = this.sim;
    let bestHops = Infinity;
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.faction !== FACTION.MARINE || b.conf < 0.15) continue;
      const d = sim.graph.hops(b.node, sim.graph.breachNode, ['std'], humanPass);
      if (d !== -1 && d < bestHops) bestHops = d;
    }
    if (bestHops === Infinity) return Infinity;
    return bestHops * (4 / sim.P.speed.marine); // seconds from NOW
  }

  // arteries carry marine traffic; denning beside them is asking to be found
  trafficPenalty(node) {
    let p = 0;
    if (this.sim.graph.hasRole(node, 'artery')) p += 2;
    for (const { to } of this.sim.graph.neighbors(node, ['std'], () => true)) {
      if (this.sim.graph.hasRole(to, 'artery')) p += 0.4;
    }
    return p;
  }

  // escape options from a node across all layers the hive can use — a
  // carrier site or fallback point with one exit is a trap, not a refuge
  exitCount(node) {
    let n = 0;
    for (const _ of this.sim.graph.neighbors(node, ['std'], (l) => !this.knownLocked.has(l.i))) n++;
    for (const _ of this.sim.graph.neighbors(node, ['shaft'], () => true)) n++;
    for (const _ of this.sim.graph.neighbors(node, ['vent'], (l) => !this.knownBlockedVents.has(l.i))) n++;
    return n;
  }

  // absorbed map knowledge (§6.1): garrison compartments are dangerous
  // whether or not the hive currently sees anyone in them
  staticGarrison(node) {
    const roles = this.sim.graph.node(node).roles;
    if (roles.includes('marines') || roles.includes('odst')) return 1.2;
    if (roles.includes('armory') || roles.includes('armed')) return 0.8;
    return 0;
  }

  // hardness the hive believes is at/near a node (for evade + siting)
  localThreat(node) {
    let h = this.believedHardness[node] + this.believedHumanStr[node] * 0.4 + this.staticGarrison(node);
    for (const { to } of this.sim.graph.neighbors(node, ['std'], () => true)) {
      h += this.believedHardness[to] * 0.6 + this.staticGarrison(to) * 0.5;
    }
    return h;
  }

  // ======================= strategic tick =======================
  strategicTick() {
    const sim = this.sim;
    this.updateBeliefs();

    // release claims whose claiming task no longer exists (the claimer died
    // or was re-tasked) so bodies/downed forms return to the economy
    const claimedNow = new Set();
    for (const a of sim.agents) {
      if (a.dead || !a.task) continue;
      if (a.task.corpseId !== undefined) claimedNow.add(a.task.corpseId);
      if (a.task.targetId !== undefined) claimedNow.add(a.task.targetId);
    }
    for (const a of sim.agents) {
      if (a.claimed && !claimedNow.has(a.id)) a.claimed = false;
    }

    const forms = sim.agents.filter((a) => !a.dead && isActiveFloodForm(a));
    const infection = forms.filter((a) => a.faction === FACTION.INFECTION);
    const combat = forms.filter((a) => a.faction === FACTION.COMBAT);
    const carriers = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER && a.hp > 0);

    const bodies = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
    const I = infection.length;
    const C = combat.length;
    const K = carriers.length;
    const S = this.scarcity(I + K * 2); // carriers embody future forms
    this.lastScarcity = S;

    // re-validate queued paths against current beliefs: a route planned two
    // rounds ago may now run through a manned corridor
    for (const f of forms) {
      if (f.path.length && f.path.some((s) => this.believedHumanStr[s.to] > 0.5 || this.believedHardness[s.to] > 0.4)) {
        f.path = [];
      }
    }

    // §6.4 EVADE runs in every mode: pull forms out of nodes the marines own.
    this.evade(forms, carriers);

    if (this.opening) {
      this.openingMove(infection, combat, bodies);
      if (sim.firstSweepCleared) {
        this.opening = false;
        sim.log('hive', 'hive hands off to steady-state economy (first sweep has passed)');
      }
      return;
    }
    this.steadyState(infection, combat, carriers, bodies, I, C, K, S);
  }

  // §6.4 evade: any form standing where believed hardness beats local flood
  // strength runs for the quietest reachable node. Overrides economy tasks
  // (but not a sprung ambush — those forms are the trap).
  evade(forms, carriers) {
    const sim = this.sim;
    for (const f of forms) {
      if (f.task?.kind === TASK.AMBUSH || f.task?.kind === TASK.BAIT || f.task?.kind === TASK.ATTACK) continue;
      const threat = this.localThreat(f.node);
      const own = sim.influence.floodStr[f.node];
      if (threat > Math.max(own, 0.8)) {
        const safe = this.quietNodeNear(f.node, f.faction === FACTION.INFECTION ? 'infection' : 'big');
        if (safe !== -1 && safe !== f.node) {
          this.assign(f, { kind: TASK.MOVE, node: safe, evade: true });
        }
      }
    }
    for (const c of carriers) {
      const threat = this.localThreat(c.node);
      if (threat > 1.2 && !c.move && !c.path.length) {
        const safe = this.quietNodeNear(c.node, 'big');
        if (safe !== -1 && safe !== c.node) {
          const path = this.stealthPath(c.node, safe, 'big');
          if (path) { sim.setPath(c, path); sim.log('hive', `a carrier drags itself out of danger toward ${sim.graph.node(safe).name}`); }
        }
      }
    }
  }

  quietNodeNear(from, kind) {
    const g = this.sim.graph;
    const reach = g.nodesWithin(from, 4, kind === 'infection' ? ['std', 'vent'] : ['std', 'shaft'],
      kind === 'infection' ? this.infectionPass : this.bigPass);
    let best = -1, bestScore = -Infinity;
    for (const n of reach) {
      if (g.burningUntil[n] > this.sim.t) continue;
      let score = -this.localThreat(n) * 3 + this.sim.influence.floodStr[n] * 0.5;
      const nd = g.node(n);
      if (nd.roles.includes('maintenance') || nd.roles.includes('cargo')) score += 0.7;
      score -= this.trafficPenalty(n) * 0.4;
      if (this.exitCount(n) < 2) score -= 1.5;
      if (n === from) score -= 0.5;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // --- §6.7/§13.5 the opening: a timed smash-and-grab ---
  openingMove(infection, combat, bodies) {
    const sim = this.sim, g = sim.graph;
    this.sweepEtaSec = this.estimateSweepEta();
    const margin = sim.P.hive.openingSweepMargin;
    const timeLeft = this.sweepEtaSec === Infinity ? 999 : this.sweepEtaSec;
    const mustRun = timeLeft < margin;

    // pick the carrier site once: deep, quiet, away from believed marines
    if (this.carrierSite === -1) {
      let best = -1, bestScore = -Infinity;
      const bodies0 = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
      const sweepLOS = new Set(sim.visibleNodes(g.breachNode)); // what the sweep will clear
      for (const n of g.nodes) {
        const d = g.hops(g.breachNode, n.idx, ['std', 'shaft'], this.bigPass);
        // out of the sweep's sightline, but the pool cannot survive a march
        // across an inhabited ship either — den LOCAL
        if (d === -1 || d < 1 || d > 3 || sweepLOS.has(n.idx)) continue;
        const route = this.stealthPath(g.breachNode, n.idx, 'big');
        if (!route) continue;
        let score = -this.localThreat(n.idx) * 3;
        score -= this.routeRisk(route) * 2.5;      // getting there alive matters most
        if (n.roles.includes('maintenance')) score += 1;
        if (n.roles.includes('cargo') || n.roles.includes('corpse_cache')) score += 1;
        if (bodies0.some((b) => b.node === n.idx)) score += 1; // carrier food on site
        if (n.type === 'corridor' && !n.roles.includes('maintenance')) score -= 2;
        if (n.type === 'open') score -= 2;         // big open bays are patrol thoroughfares
        score -= this.trafficPenalty(n.idx);
        score += Math.min(this.garrisonDist[n.idx] === -1 ? 4 : this.garrisonDist[n.idx], 4) * 0.5;
        if (this.exitCount(n.idx) < 2) score -= 3; // dead ends are tombs
        score -= d * 0.2;
        if (score > bestScore) { bestScore = score; best = n.idx; }
      }
      this.carrierSite = best;
      sim.log('hive', `hive stages toward ${g.node(best).name} (est. sweep in ${timeLeft === 999 ? '?' : Math.round(timeLeft)}s)`);
    }
    const site = this.carrierSite;
    const siteBodies = bodies.filter((b) => b.node === site);
    const breachBodies = bodies.filter((b) => b.node === g.breachNode && !b.claimed);

    // combat forms: haul 2 bodies to the site as carrier food, rest screen
    let draggers = combat.filter((c) => c.task?.kind === TASK.DRAG).length;
    for (const c of combat) {
      if (c.task && c.task.kind !== TASK.GUARD) continue;
      if (timeLeft > 20 && draggers < 2 && siteBodies.length + draggers < 2 && breachBodies.length) {
        const body = breachBodies.shift();
        body.claimed = true;
        this.assign(c, { kind: TASK.DRAG, corpseId: body.id, node: site });
        draggers++;
      } else if (!c.task) {
        this.assign(c, { kind: TASK.GUARD, node: this.scatterNode(site, c.id, 'big') });
      }
    }

    // infection forms: opportunistic grabs only if completable before the
    // sweep lands (§13.5); everything else evacuates and disperses around
    // the site rather than piling into one room
    for (const f of infection) {
      if (f.task && f.task.kind !== TASK.MOVE) continue;
      if (mustRun && !f.task?.evade) { this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(site, f.id, 'infection') }); continue; }
      if (!f.task) {
        const grab = this.bestGrab(f, 0.6, timeLeft);
        if (grab) this.assign(f, grab);
        else this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(site, f.id, 'infection') });
      }
    }

    // seat the first carrier the moment a body is at the site with a form —
    // but only while the site is quiet
    const seated = sim.agents.some((a) => !a.dead && a.faction === FACTION.CARRIER);
    if (!seated && this.localThreat(site) < 0.6) {
      const feed = bodies.find((b) => b.node === site);
      const former = infection.find((f) => f.node === site && (!f.task || f.task.kind === TASK.MOVE));
      if (feed && former) this.assign(former, { kind: TASK.SEAT, corpseId: feed.id });
    }
  }

  // spread forms among a site and its passable neighbors (no deathballs)
  scatterNode(site, salt, kind) {
    const g = this.sim.graph;
    const opts = [site];
    for (const { to, link } of g.neighbors(site,
      kind === 'infection' ? ['std', 'vent'] : ['std', 'shaft'],
      kind === 'infection' ? this.infectionPass : this.bigPass)) {
      if (this.localThreat(to) < 0.6) opts.push(to);
    }
    return opts[salt % opts.length];
  }

  // --- steady state: §13.3 utility over candidate actions ---
  steadyState(infection, combat, carriers, bodies, I, C, K, S) {
    const sim = this.sim, g = sim.graph, P = sim.P;
    const riskAversion = P.hive.riskBase * S;

    // 1. rampage check per region (§13.9): local superiority AND a reserve
    const rampaging = new Set();
    if (S <= P.rampage.scarcityCap) {
      for (const n of g.nodes) {
        const region = g.nodesWithin(n.idx, 1, ['std'], () => true);
        let fs = 0, hs = 0;
        for (const r of region) { fs += sim.influence.floodStr[r]; hs += this.believedHumanStr[r]; }
        if (fs >= P.rampage.threshold * Math.max(hs, 0.3) && fs > 2) rampaging.add(n.idx);
      }
      if (rampaging.size > 0 && !this.rampageLogged) {
        this.rampageLogged = true;
        sim.log('rampage', `the hive stops hiding — open aggression begins (pool ${I}, scarcity ${S.toFixed(2)})`);
      }
    }

    // 2. carriers: seat more when bodies are cheap. FormCost 0 (§13.3) —
    //    the poor hive's growth move — but never in a hot zone. Bodies are
    //    abundant after the portal event; production is the whole game (§13.4).
    const wantK = Math.min(5, 1 + Math.floor(bodies.length / 50) + Math.floor((I + C) / 10));
    if (K < wantK && bodies.length > 0) {
      const site = this.pickCarrierSite(bodies);
      if (site) {
        const free = infection.filter((f) => !f.task);
        const former = this.nearest(free, site.corpse.node, ['std', 'vent'], this.infectionPass);
        if (former) { site.corpse.claimed = true; this.assign(former, { kind: TASK.SEAT, corpseId: site.corpse.id }); }
      }
    }

    // 3. guards on each carrier
    for (const carrier of carriers) {
      const guards = combat.filter((c) => c.task?.kind === TASK.GUARD && c.task.node === carrier.node);
      if (guards.length < 1 + (S < 1 ? 1 : 0)) {
        const free = combat.filter((c) => !c.task);
        const guard = this.nearest(free, carrier.node, ['std', 'shaft'], this.bigPass);
        if (guard) this.assign(guard, { kind: TASK.GUARD, node: carrier.node });
      }
    }

    // 4. rampage: combat forms in hot regions attack believed humans openly
    //    (infection forms swarm through the grab scoring below — rampage
    //    scarcity makes those grabs near-free)
    for (const f of combat) {
      if (!rampaging.has(f.node)) continue;
      if (f.task && (f.task.kind === TASK.ATTACK || f.task.kind === TASK.AMBUSH || f.task.kind === TASK.BAIT)) continue;
      const target = this.nearestBelievedHuman(f.node);
      if (target !== -1) this.assign(f, { kind: TASK.ATTACK, node: target });
    }

    // 5. grabs & conversions for idle infection forms (§6.5 priority order
    //    emerges from the value table, taxed by scarcity)
    const U_convert = P.hive.militaryValue - S * 1.0;
    let convertsAssigned = 0;
    for (const f of infection) {
      if (f.task) continue;
      // military first when the army is thin and currency is cheap —
      // grabs can't touch marines (§6.5), combat forms can
      if (C + convertsAssigned < 3 && U_convert > 0 && bodies.length > 3) {
        const body = this.nearestBody(f, bodies);
        if (body) { convertsAssigned++; this.assign(f, { kind: TASK.CONVERT, corpseId: body.id }); continue; }
      }
      const grab = this.bestGrab(f, riskAversion, null, S);
      if (grab) { this.assign(f, grab); continue; }
      // corpse -> combat form only when currency is cheap (scarcity tax)
      if (U_convert > 0 && bodies.length > 3) {
        const body = this.nearestBody(f, bodies);
        if (body) { this.assign(f, { kind: TASK.CONVERT, corpseId: body.id }); continue; }
      }
      // reanimate a downed form: cheaper than a fresh conversion (§13.3)
      const downed = sim.agents.find((d) => !d.dead && d.faction === FACTION.COMBAT && d.downed && d.damage < 100 && !d.claimed);
      if (downed && 2.0 - S * 1.0 > 0) {
        downed.claimed = true;
        this.assign(f, { kind: TASK.REANIMATE, targetId: downed.id });
        continue;
      }
      // search (§13.7): only a rich hive can afford to look
      if (I >= P.hive.searchMinPool && sim.rng.chance(0.3)) {
        // sweep everywhere, command deck included — the survivors hide in
        // rooms (§13.7: only a rich hive can afford to look)
        this.assign(f, { kind: TASK.SCOUT, node: sim.rng.int(g.n) });
        continue;
      }
      // default: hoard near a carrier (this reads as "hiding")
      const home = carriers.length ? carriers[f.id % carriers.length].node : this.carrierSite;
      if (home !== -1 && f.node !== home) {
        this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(home, f.id, 'infection') });
      }
    }

    // 6. bait (§6.4): healthy military + a tracked squad + a shaft on their
    //    predicted path. Gated on reserve health, with a cooldown.
    if (C >= 4 && S <= 1.3 && sim.t >= this.baitCooldownUntil) this.tryBait(combat);

    // idle combat forms drift home
    for (const c of combat) {
      if (c.task) continue;
      const home = carriers.length ? carriers[c.id % carriers.length].node : this.carrierSite;
      if (home !== -1 && c.node !== home) this.assign(c, { kind: TASK.GUARD, node: this.scatterNode(home, c.id, 'big') });
    }
  }

  // score grab candidates per §13.3; returns a task or null.
  // openingTimeLeft non-null => opening gate (§13.5). S taxes the form cost.
  bestGrab(form, riskAversion, openingTimeLeft = null, S = 1) {
    const sim = this.sim, P = sim.P;
    let best = null, bestU = 0;
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || b.conf < 0.25) continue;
      if (h.faction === FACTION.MARINE) continue; // only via bait/ambush (§6.5)
      const path = this.safeInfectionPath(form.node, b.node);
      if (!path) continue;
      const hops = path.length;
      if (openingTimeLeft !== null) {
        const eta = hops * (P.edgeTravelSec.hatch / P.speed.infection) + P.combat.infectionGrabSec;
        if (eta > openingTimeLeft - P.hive.openingSweepMargin) continue;
        if (hops > 3) continue;
      }
      let value;
      if (h.helpless) value = P.hive.values.helpless;
      else if (h.faction === FACTION.CIVILIAN) {
        value = h.hasRadio ? P.hive.values.civilianRadio : P.hive.values.civilianNoRadio;
        if (this.believedHumanStr[b.node] > 0.4) value -= P.hive.values.distressPenalty * 0.5;
        if (h.hasRadio && !h.calledOut) value -= P.hive.values.distressPenalty * 0.3;
      } else value = P.hive.values.armed - (this.believedHumanStr[b.node] > 0.6 ? 1.0 : 0);
      const risk = this.routeRisk(path);
      // U = value·conf − scarcity·formCost − riskAversion·risk − timeCost (§13.3)
      const U = value * b.conf - S * 0.35 - riskAversion * 0.25 * risk - hops * 0.06;
      if (U > bestU) { bestU = U; best = { kind: TASK.GRAB, targetId: id } }
    }
    return best;
  }

  pickCarrierSite(bodies) {
    let best = null, bestScore = -Infinity;
    for (const b of bodies) {
      if (b.claimed) continue;
      if (this.sim.graph.burningUntil[b.node] > this.sim.t) continue;
      const threat = this.localThreat(b.node);
      if (threat > 0.6) continue; // never seat a carrier in a hot zone
      let score = -threat * 3 + this.sim.influence.floodStr[b.node] * 0.8;
      if (this.sim.graph.hasRole(b.node, 'corpse_cache')) score += 1;
      if (this.exitCount(b.node) < 2) score -= 2;
      score += Math.min(this.garrisonDist[b.node] === -1 ? 4 : this.garrisonDist[b.node], 4) * 0.3;
      score -= this.trafficPenalty(b.node) * 0.4;
      if (score > bestScore) { bestScore = score; best = { corpse: b } }
    }
    return best;
  }

  tryBait(combat) {
    const sim = this.sim, g = sim.graph;
    for (const squad of sim.squads) {
      if (squad.broken) continue;
      const leader = sim.byId.get(squad.members[0]);
      if (!leader || leader.dead) continue;
      const b = this.beliefs.get(leader.id);
      if (!b || b.conf < 0.6) continue;
      for (const shaft of g.shafts) {
        const dA = g.hops(b.node, shaft.a, ['std'], humanPass);
        const dB = g.hops(b.node, shaft.b, ['std'], humanPass);
        const near = Math.min(dA === -1 ? 99 : dA, dB === -1 ? 99 : dB);
        if (near > 2) continue;
        const mouth = (dA !== -1 && (dB === -1 || dA <= dB)) ? shaft.a : shaft.b;
        const farEnd = mouth === shaft.a ? shaft.b : shaft.a;
        const free = combat.filter((c) => !c.task || c.task.kind === TASK.GUARD);
        if (free.length < 3) return;
        this.assign(free[0], { kind: TASK.AMBUSH, linkIdx: shaft.i, end: mouth });
        this.assign(free[1], { kind: TASK.AMBUSH, linkIdx: shaft.i, end: farEnd });
        this.assign(free[2], { kind: TASK.BAIT, squadId: squad.id, shaftIdx: shaft.i, mouth, stage: 0 });
        this.baitCooldownUntil = sim.t + 90;
        sim.log('bait', `hive baits squad ${squad.id + 1} toward the ${g.node(mouth).name} shaft`);
        return;
      }
    }
  }

  staleBeliefs() {
    for (const [id, b] of this.beliefs) {
      const h = this.sim.byId.get(id);
      if (h && h.faction === FACTION.MARINE && b.conf > 0.5) return false;
    }
    return true;
  }

  nearest(list, node, layers, pass) {
    let best = null, bestD = Infinity;
    for (const a of list) {
      const d = this.sim.graph.hops(a.node, node, layers, pass);
      if (d !== -1 && d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  nearestBody(form, bodies) {
    let best = null, bestD = Infinity;
    for (const b of bodies) {
      if (b.claimed) continue;
      const d = this.sim.graph.hops(form.node, b.node, ['std', 'vent'], this.infectionPass);
      if (d !== -1 && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  nearestBelievedHuman(from) {
    let best = -1, bestScore = -Infinity;
    for (let n = 0; n < this.sim.graph.n; n++) {
      if (this.believedHumanStr[n] <= 0.05) continue;
      const d = this.sim.graph.hops(from, n, ['std', 'shaft'], this.bigPass);
      if (d === -1) continue;
      const s = this.believedHumanStr[n] - d * 0.2;
      if (s > bestScore) { bestScore = s; best = n; }
    }
    return best;
  }

  assign(form, task) {
    form.task = task;
    form.path = [];
    form.taskProgress = 0;
    if (form.inShaftAmbush !== undefined && task.kind !== TASK.AMBUSH) {
      this.sim.graph.shafts[form.inShaftAmbush]?.ambushers?.delete(form.id);
      form.inShaftAmbush = undefined;
      if (form.state === STATE.AMBUSHING) form.state = STATE.IDLE;
    }
  }
}

export function isActiveFloodForm(a) {
  return (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT) && !a.downed && a.hp > 0;
}
export function isLivingHuman(a) {
  return (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE) && a.hp > 0 && !a.dead;
}
export { W_HUMAN, W_FLOOD };
