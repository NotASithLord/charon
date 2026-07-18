// Flood hive AI (§6) driven by the decision math in §13. One brain; forms
// are dumb actuators executing tasks. No phase flags anywhere: hide/invest/
// snowball/rampage all fall out of the scarcity term.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE } from './init.js';
import { humanPass } from './graph.js';

export const TASK = {
  MOVE: 'move',            // {node}
  GRAB: 'grab',            // {targetId}
  CONVERT: 'convert',      // {corpseId} infection form + body -> combat form (form spent)
  TRANSFORM: 'transform',  // combat form roots into a carrier (the hive's ratio lever)
  GUARD: 'guard',          // {node} defend a carrier
  REANIMATE: 'reanimate',  // {targetId} downed combat form
  DRAG: 'drag',            // {corpseId, node} haul carrier food
  AMBUSH: 'ambush',        // {linkIdx, end} lie in wait mid-shaft
  BAIT: 'bait',            // {squadId, shaftIdx} get seen, retreat through shaft
  DECOY: 'decoy',          // {show, stage} get seen far from the dens, then evade
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
      if (a.faction === FACTION.CIVILIAN && (a.helpless || a.stayPut)) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.9, static: true });
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
          this.beliefs.set(h.id, { node: h.node, t: sim.t, conf: 1, static: old?.static && (h.helpless || h.stayPut) });
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
    // a vent is only watched from the two rooms it connects — a shooter has
    // to be at the grating to see through it (user note). No adjacency bleed.
    let w = 0;
    for (const end of [link.a, link.b]) {
      w += this.believedHardness[end] + this.believedHumanStr[end] * 0.5;
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
      // never interrupt a rooting carrier — losing the 4s transform to an
      // evade/rampage yank was why the hive stopped producing carriers
      if (f.task?.kind === TASK.AMBUSH || f.task?.kind === TASK.BAIT || f.task?.kind === TASK.ATTACK
        || f.task?.kind === TASK.TRANSFORM) continue;
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

  // Score every plausible den node near the breach (out of the sweep's
  // sightline, quiet, defensible, ideally sitting on carrier food).
  denCandidates(maxHops = 3) {
    const sim = this.sim, g = sim.graph;
    const bodies0 = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
    const bodyAt = new Set(bodies0.map((b) => b.node));
    const sweepLOS = new Set(sim.visibleNodes(g.breachNode));
    const out = [];
    for (const n of g.nodes) {
      const d = g.hops(g.breachNode, n.idx, ['std', 'shaft'], this.bigPass);
      if (d === -1 || d < 1 || d > maxHops || sweepLOS.has(n.idx)) continue;
      const route = this.stealthPath(g.breachNode, n.idx, 'big');
      if (!route) continue;
      let score = -this.localThreat(n.idx) * 3 - this.routeRisk(route) * 2.5;
      if (n.roles.includes('maintenance')) score += 1;
      if (n.roles.includes('cargo') || n.roles.includes('corpse_cache')) score += 1;
      if (bodyAt.has(n.idx)) score += 1.2; // carrier food already on site
      if (n.type === 'corridor' && !n.roles.includes('maintenance')) score -= 2;
      if (n.type === 'open') score -= 2;
      score -= this.trafficPenalty(n.idx);
      score += Math.min(this.garrisonDist[n.idx] === -1 ? 4 : this.garrisonDist[n.idx], 4) * 0.5;
      if (this.exitCount(n.idx) < 2) score -= 3;
      score -= d * 0.2;
      out.push({ node: n.idx, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // Pick up to `count` den sites that are spread apart (>=2 hops), so the
  // hive hedges its opening across several hiding spots instead of stacking
  // everything in one room (user note: it over-concentrates early).
  pickDenSites(count) {
    const g = this.sim.graph;
    const cand = this.denCandidates(3);
    const chosen = [];
    for (const c of cand) {
      if (chosen.length >= count) break;
      if (chosen.every((s) => g.hops(s, c.node, ['std', 'shaft'], this.bigPass) >= 2)) chosen.push(c.node);
    }
    if (!chosen.length && cand.length) chosen.push(cand[0].node);
    return chosen;
  }

  // --- §6.7/§13.5 the opening: a timed smash-and-grab ---
  openingMove(infection, combat, bodies) {
    const sim = this.sim, g = sim.graph;
    this.sweepEtaSec = this.estimateSweepEta();
    const margin = sim.P.hive.openingSweepMargin;
    const timeLeft = this.sweepEtaSec === Infinity ? 999 : this.sweepEtaSec;
    const mustRun = timeLeft < margin;

    if (!this.denSites) {
      this.denSites = this.pickDenSites(3);
      this.carrierSite = this.denSites[0] ?? -1;
      sim.log('hive', `hive splits toward ${this.denSites.map((n) => g.node(n).name).join(', ')} (est. sweep in ${timeLeft === 999 ? '?' : Math.round(timeLeft)}s)`);
    }
    const dens = this.denSites;
    const homeFor = (id) => dens[id % dens.length];
    const breachBodies = bodies.filter((b) => b.node === g.breachNode && !b.claimed);

    // combat forms: haul breach bodies out to the dens as carrier food (one
    // per den), the rest screen their assigned den
    let draggers = combat.filter((c) => c.task?.kind === TASK.DRAG).length;
    for (const c of combat) {
      if (c.task && c.task.kind !== TASK.GUARD) continue;
      const home = homeFor(c.id);
      const homeHasBody = bodies.some((b) => b.node === home);
      if (timeLeft > 20 && draggers < dens.length && !homeHasBody && breachBodies.length) {
        const body = breachBodies.shift();
        body.claimed = true;
        this.assign(c, { kind: TASK.DRAG, corpseId: body.id, node: home });
        draggers++;
      } else if (!c.task) {
        this.assign(c, { kind: TASK.GUARD, node: this.scatterNode(home, c.id, 'big') });
      }
    }

    // infection forms: opportunistic grabs if completable before the sweep
    // lands (§13.5); otherwise disperse to their assigned den
    for (const f of infection) {
      if (f.task && f.task.kind !== TASK.MOVE) continue;
      const home = homeFor(f.id);
      if (mustRun && !f.task?.evade) { this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(home, f.id, 'infection') }); continue; }
      if (!f.task) {
        const grab = this.bestGrab(f, 0.6, timeLeft);
        if (grab) this.assign(f, grab);
        else this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(home, f.id, 'infection') });
      }
    }

    // DECOY (user note): during the opening, one combat form runs AWAY from
    // the den sites to get itself seen — luring the sweep and triggering
    // radio calls somewhere the carriers aren't, then slipping into evade.
    // Buying time is worth one form's risk.
    if (!this.decoySent && combat.length >= 3) {
      this.decoySent = true;
      const decoy = combat.find((c) => !c.task || c.task.kind === TASK.GUARD);
      if (decoy) {
        // show node: reachable, far from every den, toward believed humans
        let show = -1, bestScore = -Infinity;
        for (const n of g.nodes) {
          if (this.staticGarrison(n.idx) > 0) continue; // show yourself NEAR them, never IN their room
          const d = g.hops(decoy.node, n.idx, ['std', 'shaft'], this.bigPass);
          if (d === -1 || d < 2 || d > 5) continue;
          let minDen = Infinity;
          for (const den of dens) {
            const dd = g.hops(n.idx, den, ['std', 'shaft'], this.bigPass);
            if (dd !== -1) minDen = Math.min(minDen, dd);
          }
          const score = Math.min(minDen, 6) * 1.0 + this.believedHumanStr[n.idx] * 1.5 - d * 0.2;
          if (score > bestScore) { bestScore = score; show = n.idx; }
        }
        if (show !== -1) {
          this.assign(decoy, { kind: TASK.DECOY, show, stage: 0 });
          sim.log('bait', `a combat form breaks cover toward ${g.node(show).name} — drawing the sweep off the dens`);
        }
      }
    }

    // START PRODUCTION: root a couple of the initial combat forms into
    // carriers at quiet dens (carriers are converted combat forms — user
    // economy). It's a carrier rush (§13.4), and a carrier mints its first
    // form within seconds, so this stands up production immediately while the
    // rest of the combat forms guard.
    const carriersNow = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER).length;
    let transforming = combat.filter((c) => c.task?.kind === TASK.TRANSFORM).length;
    const wantCarriers = Math.min(dens.length, 2);
    for (const den of dens) {
      if (carriersNow + transforming >= wantCarriers) break;
      if (this.localThreat(den) >= 0.6) continue;
      if (sim.agents.some((a) => !a.dead && a.faction === FACTION.CARRIER && a.node === den)) continue;
      const cf = combat.find((c) => c.node === den && !c.move && (!c.task || c.task.kind === TASK.GUARD || c.task.kind === TASK.DRAG));
      if (cf) { this.assign(cf, { kind: TASK.TRANSFORM }); transforming++; }
    }
    // and keep the military up: an infection form sitting on a den body turns
    // it into a fresh combat form to replace the ones that just rooted
    for (const den of dens) {
      if (this.localThreat(den) >= 0.6) continue;
      const feed = bodies.find((b) => b.node === den && !b.claimed);
      const former = infection.find((f) => f.node === den && (!f.task || f.task.kind === TASK.MOVE));
      if (feed && former && combat.length < 4) { feed.claimed = true; this.assign(former, { kind: TASK.CONVERT, corpseId: feed.id }); }
    }
  }

  // spread forms among a site and its quiet neighbors (no deathballs), but
  // never out onto an artery — the main corridors are where the forms were
  // getting mown down in transit
  scatterNode(site, salt, kind) {
    const g = this.sim.graph;
    const opts = [site];
    for (const { to } of g.neighbors(site,
      kind === 'infection' ? ['std', 'vent'] : ['std', 'shaft'],
      kind === 'infection' ? this.infectionPass : this.bigPass)) {
      if (this.localThreat(to) < 0.6 && !g.hasRole(to, 'artery') && g.node(to).type !== 'open') opts.push(to);
    }
    return opts[salt % opts.length];
  }

  // --- steady state: §13.3 utility over candidate actions ---
  steadyState(infection, combat, carriers, bodies, I, C, K, S) {
    const sim = this.sim, g = sim.graph, P = sim.P;
    const riskAversion = P.hive.riskBase * S;

    // 1. AGGRESSION IS LOCAL (user note): each region decides hide-vs-rampage
    //    on its OWN situation, independent of the global pool. A pocket of
    //    forms standing over undefended civilians goes loud even while the
    //    hive is scarce elsewhere; a pocket with marines in it hides even
    //    while the hive is rich. A region rampages iff it has local
    //    superiority over the humans there, enough local mass to matter, and
    //    no real marine presence to punish it (that's an evade zone instead).
    const rampaging = new Set();
    for (const n of g.nodes) {
      const region = g.nodesWithin(n.idx, 1, ['std'], () => true);
      let fs = 0, hs = 0, hard = 0;
      for (const r of region) {
        fs += sim.influence.floodStr[r];
        hs += this.believedHumanStr[r];
        hard += this.believedHardness[r];
      }
      if (fs >= P.rampage.threshold * Math.max(hs, 0.3)
        && fs >= P.rampage.localReserve
        && hard < P.rampage.marineCap) rampaging.add(n.idx);
    }
    if (rampaging.size > 0 && !this.rampageLogged) {
      this.rampageLogged = true;
      sim.log('rampage', `flood pockets go loud where the crew is undefended (${rampaging.size} region(s))`);
    }

    // 2. carrier production is the RATIO LEVER (user economy): a spare combat
    //    form roots into a carrier. Target enough carriers to snowball
    //    (§13.4 needs K>=2), scaling with the force; only spend a combat form
    //    on it when there's a genuine surplus (still >=1 combat per carrier),
    //    and only in a safe, defensible node spread from the other carriers.
    // REPRODUCTION IS THE FIRST INSTINCT (user note): with no carriers the
    // hive roots one NOW, whatever else is happening — production precedes
    // defense, hunting, everything.
    const wantK = Math.min(4, 2 + Math.floor((I + C) / 22));
    if (K < wantK && (C > K || K === 0)) {
      const target = this.bestCarrierNode();
      if (target !== -1) {
        const spares = combat.filter((c) => !c.task || c.task.kind === TASK.GUARD || c.task.kind === TASK.ATTACK);
        const c = this.nearest(spares, target, ['std', 'shaft'], this.bigPass);
        if (c) {
          if (c.node === target && !c.move && this.localThreat(target) < 0.5) this.assign(c, { kind: TASK.TRANSFORM });
          else this.assign(c, { kind: TASK.GUARD, node: target }); // stage it there; it roots next round
        }
      }
    }

    // 2b. DESPERATION (user note): reduced to a handful of combat forms with no
    //     carriers and no pool, a rational hive rebuilds — it does NOT just
    //     hide and wait to be shot. The safest-positioned form roots into a
    //     carrier to restart production; the rest pull back to the quietest
    //     ground they can reach. This is the last-ditch survival play.
    // When it's down to a few combat forms and nothing else, EVERY one of
    // them hides and roots into a carrier (user note) — the last soldiers
    // become the seed stock, full stop. No hunting, no guarding, no waiting.
    const desperate = K === 0 && I < 6 && combat.length <= 4;
    if (desperate) {
      for (const c of combat) {
        if (c.downed || c.task?.kind === TASK.TRANSFORM) continue;
        if (this.localThreat(c.node) < 0.9 && !c.move) {
          this.assign(c, { kind: TASK.TRANSFORM });
        } else {
          const quiet = this.quietNodeNear(c.node, 'big');
          if (quiet !== -1 && quiet !== c.node) this.assign(c, { kind: TASK.GUARD, node: quiet });
          else if (!c.move) this.assign(c, { kind: TASK.TRANSFORM }); // nowhere safer — root here
        }
      }
      if (!this._desperateLogged) {
        this._desperateLogged = true;
        this.sim.log('hive', 'the last combat forms go to ground to seed new carriers');
      }
    }
    this._desperate = desperate;

    // 3. guards on each carrier. Protecting the first carriers through
    //    incubation is the whole game (§13.4), so guard HARDER when the pool
    //    is thin — that's exactly when losing a carrier is fatal.
    const guardsWanted = S >= 1.5 ? 2 : 1;
    for (const carrier of carriers) {
      const guards = combat.filter((c) => c.task?.kind === TASK.GUARD && c.task.node === carrier.node);
      if (guards.length < guardsWanted) {
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
      if (f.task && (f.task.kind === TASK.ATTACK || f.task.kind === TASK.AMBUSH || f.task.kind === TASK.BAIT
        || f.task.kind === TASK.TRANSFORM)) continue; // a rooting carrier is not a soldier
      const target = this.nearestBelievedHuman(f.node);
      if (target !== -1) this.assign(f, { kind: TASK.ATTACK, node: target });
    }

    // 5. idle infection forms turn bodies into combat forms and hunt the crew
    //    (§6.5 priority). Building the combat force is what feeds BOTH defense
    //    and carrier production (a carrier is a rooted combat form), so the
    //    hive keeps making them up to a target that covers guards + hunters +
    //    the carriers it still wants to grow into.
    const wantC = Math.min(14, guardsWanted * K + 4 + Math.max(0, wantK - K));
    let convertsAssigned = 0;
    for (const f of infection) {
      if (f.task) continue;
      // GROW THE FORCE: an idle form near a body turns it into a combat form
      // (form + body -> combat form) while the force is below target. Uses the
      // crash corpses from the start, not late (user note).
      if (C + convertsAssigned < wantC && bodies.length > 2) {
        const body = this.nearestBody(f, bodies);
        if (body) { body.claimed = true; convertsAssigned++; this.assign(f, { kind: TASK.CONVERT, corpseId: body.id }); continue; }
      }
      const grab = this.bestGrab(f, riskAversion, null, S);
      if (grab) { this.assign(f, grab); continue; }
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
      // NO IDLING (user note): an infection form with nothing better to do is
      // wasted currency. It speeds toward the closest known corpse or believed
      // civilian and stages there as a pack — the swarm forms where the food is.
      const rally = this.nearestFoodNode(f);
      if (rally !== -1 && f.node !== rally) {
        this.assign(f, { kind: TASK.MOVE, node: rally, rally: true });
      } else if (rally === -1 && carriers.length) {
        this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(carriers[f.id % carriers.length].node, f.id, 'infection') });
      }
    }

    // 5b. pack escorts (user note): infection forms travel in packs, and a
    //     pack moving with combat forms converts more reliably. For every ~3
    //     forms rallying on a node, peel one spare combat form to escort it.
    {
      const rallyCounts = new Map();
      for (const f of infection) {
        if (f.task?.kind === TASK.MOVE && f.task.rally) {
          rallyCounts.set(f.task.node, (rallyCounts.get(f.task.node) || 0) + 1);
        }
      }
      for (const [node, count] of rallyCounts) {
        const want = Math.floor(count / P.swarm.escortPer);
        if (want < 1) continue;
        const escorts = combat.filter((c) => c.task?.kind === TASK.GUARD && c.task.node === node).length;
        if (escorts >= want) continue;
        const free = combat.filter((c) => !c.task);
        const e = this.nearest(free, node, ['std', 'shaft'], this.bigPass);
        if (e) this.assign(e, { kind: TASK.GUARD, node });
      }
    }

    // 6. bait (§6.4): healthy military + a tracked squad + a shaft on their
    //    predicted path. Gated on reserve health, with a cooldown.
    if (C >= 4 && S <= 1.3 && sim.t >= this.baitCooldownUntil) this.tryBait(combat);

    // 6b. squad-wipe (user note): an isolated squad the hive can hit 2:1
    //     gets hit NOW, losses accepted, while a reserve exists elsewhere.
    this.trySquadWipe(infection, combat, carriers, I);

    // 7. spare combat forms HUNT civilians for bodies while steering clear of
    //    marines (user note): they are the hive's body-harvesters. A combat
    //    form kills a spotted civilian in ~1s, so a civilian that radios is
    //    just a free corpse — the marines are coming anyway, rack up the body
    //    and slip away; an infection form converts it later. Static, known
    //    targets (the wounded, the officers who won't move) come first because
    //    the hive always knows exactly where they are.
    // This is a LOCAL decision, not a global one (user note): carriers get
    // their guards first (step 3), and every SPARE form then hunts whatever
    // safe, undefended prey is near it — nearestHuntNode already refuses to
    // walk into marines, so a form only goes loud where its own surroundings
    // are safe, whatever the global pool is doing elsewhere.
    for (const c of combat) {
      if (c.task) continue;
      // when desperate the survivors rebuild and hide (handled in 2b) — they
      // don't go hunting into the guns
      const prey = this._desperate ? -1 : this.nearestHuntNode(c.node);
      if (prey !== -1) { this.assign(c, { kind: TASK.ATTACK, node: prey }); continue; }
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
        // only weigh the distress cost if the alarm HASN'T been raised yet.
        // Once a target has already called, the sweep is coming regardless —
        // grabbing it is pure upside now, no penalty (user note).
        if (!h.calledOut) {
          if (this.believedHumanStr[b.node] > 0.4) value -= P.hive.values.distressPenalty * 0.5;
          if (h.hasRadio) value -= P.hive.values.distressPenalty * 0.3;
        }
      } else value = P.hive.values.armed - (this.believedHumanStr[b.node] > 0.6 ? 1.0 : 0);
      // static, always-known targets (the wounded, the officers) are the
      // surest conversions — the hive never loses their position (user note)
      if (h.helpless || h.stayPut) value += 1.0;
      const risk = this.routeRisk(path);
      // U = value·conf − scarcity·formCost − riskAversion·risk − timeCost (§13.3)
      const U = value * b.conf - S * 0.35 - riskAversion * 0.25 * risk - hops * 0.06;
      if (U > bestU) { bestU = U; best = { kind: TASK.GRAB, targetId: id } }
    }
    return best;
  }

  // Best node to root a new carrier: quiet, defensible, near our own mass,
  // and spread from existing carriers so production isn't one clearable cluster.
  bestCarrierNode() {
    const g = this.sim.graph;
    const carrierNodes = this.sim.agents
      .filter((a) => !a.dead && a.faction === FACTION.CARRIER).map((a) => a.node);
    let best = -1, bestScore = 0.2; // need a genuinely good spot
    for (const n of g.nodes) {
      const idx = n.idx;
      if (g.burningUntil[idx] > this.sim.t) continue;
      if (this.localThreat(idx) > 0.4) continue;
      if (this.exitCount(idx) < 2) continue;
      let score = this.sim.influence.floodStr[idx] * 0.6;   // near our own forms
      if (n.roles.includes('maintenance') || n.roles.includes('cargo') || n.roles.includes('corpse_cache')) score += 1;
      if (n.type === 'corridor' || n.type === 'open') score -= 1.5;
      score -= this.trafficPenalty(idx) * 0.5;
      score += Math.min(this.garrisonDist[idx] === -1 ? 4 : this.garrisonDist[idx], 4) * 0.25;
      if (carrierNodes.length) {
        let near = Infinity;
        for (const cn of carrierNodes) { const d = g.hops(idx, cn, ['std', 'shaft'], this.bigPass); if (d !== -1) near = Math.min(near, d); }
        if (near === 0) continue;                 // already a carrier here
        if (near !== Infinity) score += Math.min(near, 5) * 0.5;
      }
      if (score > bestScore) { bestScore = score; best = idx; }
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

  // Where a combat form goes to make bodies. Combines live belief with the
  // hive's standing knowledge of where the crew lives (absorbed crew memory):
  // quarters, mess, medbay and cryo are always worth checking even with no
  // current contact — that's how it "seeks out civilians as soon as able."
  // Marine-held nodes are avoided (hide from the guns, hunt the soft).
  nearestHuntNode(from) {
    const sim = this.sim, g = sim.graph;
    // population prior per node from live beliefs...
    const prior = new Float32Array(g.n);
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || h.faction === FACTION.MARINE) continue;
      let w = b.conf * (h.helpless || h.stayPut ? 3 : 1); // static = surest bodies
      prior[b.node] += w;
    }
    // ...plus a standing prior on crew spaces, so it hunts population centers
    // even when every contact has gone cold
    for (const n of g.nodes) {
      if (n.roles.includes('quarters') || n.roles.includes('soft')) prior[n.idx] += 0.6;
      if (n.roles.includes('helpless') || n.roles.includes('medbay') || n.roles.includes('brig')) prior[n.idx] += 1.2;
    }
    let best = -1, bestScore = 0.4; // need a real reason to move out
    for (const n of g.nodes) {
      if (prior[n.idx] <= 0) continue;
      if (this.believedHardness[n.idx] > 0.5) continue;   // marines here — skip
      if (this.localThreat(n.idx) > 1.0) continue;        // garrison/armory area
      const d = g.hops(from, n.idx, ['std', 'shaft'], this.bigPass);
      if (d === -1 || d > 7) continue;
      const score = prior[n.idx] - d * 0.3;
      if (score > bestScore) { bestScore = score; best = n.idx; }
    }
    return best;
  }

  // Closest thing an infection form can eat or convert: a corpse, or a
  // believed civilian position. Skips marine-held ground.
  nearestFoodNode(form) {
    const sim = this.sim;
    let best = -1, bestD = Infinity;
    for (const b of sim.agents) {
      if (b.dead || b.faction !== FACTION.CORPSE || b.damage >= 100) continue;
      if (this.believedHardness[b.node] > 0.5) continue;
      const d = sim.graph.hops(form.node, b.node, ['std', 'vent'], this.infectionPass);
      if (d !== -1 && d < bestD) { bestD = d; best = b.node; }
    }
    for (const [id, bel] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || h.faction === FACTION.MARINE || bel.conf < 0.3) continue;
      if (this.believedHardness[bel.node] > 0.5) continue;
      const d = sim.graph.hops(form.node, bel.node, ['std', 'vent'], this.infectionPass);
      if (d !== -1 && d < bestD) { bestD = d; best = bel.node; }
    }
    return best;
  }

  // §swarm-kill (user note): an ISOLATED squad the hive can muster 2:1 on
  // gets hit immediately, losses accepted, as long as the hive keeps a
  // reserve (forms or a carrier) elsewhere. Eliminating the main threat is
  // worth trading currency for.
  trySquadWipe(infection, combat, carriers, I) {
    const sim = this.sim, g = sim.graph, P = sim.P.swarm;
    if (sim.t < 60) return; // no set-piece attacks in the first minute (user rule)
    if (sim.t < (this.squadWipeCooldownUntil ?? 0)) return;
    for (const squad of sim.squads) {
      if (squad.broken) continue;
      const members = squad.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (!members.length) continue;
      const leader = members[0];
      const bel = this.beliefs.get(leader.id);
      if (!bel || bel.conf < 0.6) continue; // must have a solid fix
      // isolated: no OTHER squad believed within isolationHops
      let isolated = true;
      for (const other of sim.squads) {
        if (other === squad || other.broken) continue;
        const oLeader = sim.byId.get(other.members[0]);
        if (!oLeader || oLeader.dead) continue;
        const ob = this.beliefs.get(oLeader.id);
        if (!ob || ob.conf < 0.3) continue;
        const d = g.hops(bel.node, ob.node, ['std'], humanPass);
        if (d !== -1 && d <= P.isolationHops) { isolated = false; break; }
      }
      if (!isolated) continue;
      // muster: every form within musterHops
      const squadW = members.length;
      const muster = [];
      let musterW = 0;
      for (const f of [...combat, ...infection]) {
        if (f.task?.kind === TASK.TRANSFORM) continue;
        const d = g.hops(f.node, bel.node, ['std', 'shaft', 'vent'],
          f.faction === FACTION.INFECTION ? this.infectionPass : this.bigPass);
        if (d !== -1 && d <= P.musterHops) { muster.push(f); musterW += f.faction === FACTION.COMBAT ? 1 : 0.25; }
      }
      // reserve rule: only trade the swarm for marines if the hive keeps a
      // future (a carrier or a pool) somewhere else
      const reserveOk = carriers.length > 0 || I - muster.filter((m) => m.faction === FACTION.INFECTION).length >= 0
        ? (carriers.length > 0 || I >= P.reserveForms) : false;
      if (musterW >= squadW * P.killRatio && reserveOk && muster.length) {
        for (const f of muster) this.assign(f, { kind: TASK.ATTACK, node: bel.node });
        this.squadWipeCooldownUntil = sim.t + 45;
        sim.log('rampage', `the hive springs on isolated squad ${squad.id + 1} in ${g.node(bel.node).name} (${muster.length} forms, ${musterW.toFixed(1)}:${squadW} odds)`);
        return;
      }
    }
  }

  nearestBelievedHuman(from) {
    let best = -1, bestScore = -Infinity;
    for (let n = 0; n < this.sim.graph.n; n++) {
      if (this.believedHumanStr[n] <= 0.05) continue;
      // rushing the garrison rooms in the first minute is suicide (user rule)
      if (this.sim.t < 60 && this.staticGarrison(n) > 0) continue;
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
    // a form yanked out of a grab must not stay frozen in GRABBING — that
    // state parks movement AND blocks eating (the breach-freeze regression)
    if (form.state === STATE.GRABBING) { form.state = STATE.IDLE; form.grabTimer = 0; }
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
