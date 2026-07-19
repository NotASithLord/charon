// Debug visualization (§8), high-fidelity pass: real-meter floor plan with a
// pan/zoom camera, rooms drawn at their authored footprints, bodies lying
// where they fell, tracer fire and grab/convert progress inside rooms,
// influence heatmap, traversal overlays, distress rings, stats panel.

import { FACTION, FLAG } from '../shared/agentBuffer.js';
import { fmtTime } from './sim.js';
import { STATE } from './init.js';
import { TASK } from './hive.js';

const FACTION_COLOR = {
  [FACTION.CIVILIAN]: '#f2f2f2',
  [FACTION.ARMED]: '#e8c840',
  [FACTION.MARINE]: '#4d8ef0',
  [FACTION.INFECTION]: '#51ff6a',
  [FACTION.COMBAT]: '#c0392b',
  [FACTION.CARRIER]: '#b15fd9',
  [FACTION.CORPSE]: '#777777',
};

export class Viz {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.deckFilter = 0; // 0 = all decks
    this.overlays = { influence: true, shafts: true, vents: true, calls: true, tracker: false, beliefs: false, labels: true, conns: false, fire: true };
    this.callRings = []; // {node, t0}
    this.lastCallCount = 0;
    // camera in world METERS: center + zoom on top of the fit-to-canvas scale
    this.cam = { x: sim.graph.width / 2, y: sim.graph.height / 2, zoom: 1 };
    this.s = 1; // current total px-per-meter, set each frame
    this.focusBreach();
    // per-agent render position keyed by AGENT ID, not buffer slot. The sim
    // repacks the buffer as agents die/spawn, so slot i holds different agents
    // over time — interpolating by slot made every agent "fly into position"
    // whenever the roster changed. Smoothing per id fixes that stutter.
    this.rpos = new Map();
  }

  setSim(sim) {
    this.sim = sim;
    this.callRings = [];
    this.lastCallCount = 0;
    this.rpos = new Map();
    this.focusBreach();
  }

  // start CLOSE on the action (user note: much bigger view) — the camera
  // opens over the breach; scroll to zoom, drag to pan, double-click to fit
  focusBreach() {
    const n = this.sim.graph.node(this.sim.graph.breachNode);
    this.cam = { x: n.x, y: n.y, zoom: 2.6 };
  }
  fitShip() {
    this.cam = { x: this.sim.graph.width / 2, y: this.sim.graph.height / 2, zoom: 1 };
  }
  zoomAt(px, py, factor) {
    const W = this.canvas.width, H = this.canvas.height;
    const wx = this.cam.x + (px - W / 2) / this.s;
    const wy = this.cam.y + (py - H / 2) / this.s;
    this.cam.zoom = Math.min(16, Math.max(0.85, this.cam.zoom * factor));
    const fit = Math.min(W / this.sim.graph.width, H / this.sim.graph.height);
    const s2 = fit * this.cam.zoom;
    this.cam.x = wx - (px - W / 2) / s2;
    this.cam.y = wy - (py - H / 2) / s2;
  }
  pan(dxPx, dyPx) {
    this.cam.x -= dxPx / this.s;
    this.cam.y -= dyPx / this.s;
  }

  draw(dt = 0.016) {
    const { ctx, sim } = this;
    const g = sim.graph;
    const W = this.canvas.width, H = this.canvas.height;
    const fit = Math.min(W / g.width, H / g.height);
    const s = fit * this.cam.zoom;
    this.s = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07090c';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, W / 2 - this.cam.x * s, H / 2 - this.cam.y * s);

    // pick up new distress calls for ring animation
    while (this.lastCallCount < sim.calls.length) {
      const c = sim.calls[this.lastCallCount];
      this.callRings.push({ node: c.node, t0: sim.t, byId: c.byId, faction: c.faction });
      this.lastCallCount++;
    }

    this._deckBands(g);
    if (this.overlays.vents) this._vents(g);
    this._edges(g);
    if (this.overlays.shafts) this._shafts(g);
    this._rooms(g);
    this._edgeMarkers(g);
    if (this.overlays.calls) this._callRings(g);
    if (this.overlays.tracker) this._tracker(g);
    if (this.overlays.beliefs) this._beliefs(g);
    this._agents(dt);
    this._combatFx(g);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _lw(px) { return px / this.s; }  // constant on-screen line width
  // constant on-screen font size: scale by the canvas's device-pixel ratio,
  // or hidpi screens render text at half the intended size (user note:
  // room names were unreadable)
  _font(px) {
    const dpr = this.canvas.clientWidth ? this.canvas.width / this.canvas.clientWidth : 1;
    return `${(px * dpr) / this.s}px monospace`;
  }

  _visible(nodeIdx) {
    return this.deckFilter === 0 || this.sim.graph.node(nodeIdx).deck === this.deckFilter;
  }

  _deckBands(g) {
    const { ctx } = this;
    ctx.font = this._font(11);
    for (let d = 1; d <= 5; d++) {
      const band = g.deckBands[d - 1];
      ctx.fillStyle = this.deckFilter && this.deckFilter !== d ? '#0b0e12' : (d % 2 ? '#11151c' : '#0e1218');
      ctx.fillRect(0, band.y0, g.width, band.y1 - band.y0);
      // the hull: everything between compartments is ship structure, not void
      const deckNodes = g.nodes.filter((n) => n.deck === d);
      if (deckNodes.length && (!this.deckFilter || this.deckFilter === d)) {
        const x0 = Math.min(...deckNodes.map((n) => n.x - n.w / 2)) - 1.6;
        const x1 = Math.max(...deckNodes.map((n) => n.x + n.w / 2)) + 1.6;
        const yy0 = Math.min(...deckNodes.map((n) => n.y - n.d / 2)) - 1.6;
        const yy1 = Math.max(...deckNodes.map((n) => n.y + n.d / 2)) + 1.6;
        ctx.fillStyle = '#151b26';
        ctx.strokeStyle = '#28324a';
        ctx.lineWidth = this._lw(1.6);
        ctx.beginPath();
        ctx.roundRect(x0, yy0, x1 - x0, yy1 - yy0, 3);
        ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = '#3a4556';
      ctx.fillText(`DECK ${d}${d === 1 ? ' — COMMAND' : d === 5 ? ' — ENGINEERING' : ''}`, 3, band.y0 + 14 / this.s);
    }
    ctx.fillStyle = '#232b38';
    ctx.fillText('BOW ◄', 3, g.deckBands[0].y0 - 4 / this.s);
    ctx.fillText('► STERN', g.width - 60 / this.s, g.deckBands[0].y0 - 4 / this.s);
  }

  // Connector throats for the few spaces that don't share a wall: drawn as
  // small filled passages (walkable floor), UNDER the rooms
  _edges(g) {
    const { ctx } = this;
    for (const e of g.edges) {
      if (!this._visible(e.a) && !this._visible(e.b)) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck || e.shared || !e.doorA) continue;
      const dx = e.doorB.x - e.doorA.x, dy = e.doorB.y - e.doorA.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.1) continue;
      ctx.save();
      ctx.translate((e.doorA.x + e.doorB.x) / 2, (e.doorA.y + e.doorB.y) / 2);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = '#1c2330';
      ctx.strokeStyle = '#3a4a61';
      ctx.lineWidth = this._lw(1);
      ctx.fillRect(-len / 2 - 0.3, -0.9, len + 0.6, 1.8);
      ctx.strokeRect(-len / 2 - 0.3, -0.9, len + 0.6, 1.8);
      ctx.restore();
    }
  }

  // DOORS (user note: a real plan, no abstract lines): every same-deck
  // connection is an opening drawn on the actual shared wall — a light slot
  // when open, glowing red when locked. Cross-deck lifts/ladders are round
  // pads inside the rooms they serve, matching the 3D world.
  _edgeMarkers(g) {
    const { ctx } = this;
    const DOOR_W = 1.7;
    for (const e of g.edges) {
      if (!this._visible(e.a) && !this._visible(e.b)) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck === b.deck && e.door) {
        // orientation: slot lies ALONG the wall (perpendicular to a->b axis)
        const horizWall = Math.abs(a.y - b.y) >= Math.abs(a.x - b.x);
        const wl = DOOR_W / 2, wt = 0.55;
        ctx.fillStyle = e.locked ? '#c0392b' : '#9fb4d4';
        if (horizWall) ctx.fillRect(e.door.x - wl, e.door.y - wt / 2, DOOR_W, wt);
        else ctx.fillRect(e.door.x - wt / 2, e.door.y - wl, wt, DOOR_W);
        if (e.type === 'blastdoor') {
          ctx.strokeStyle = e.locked ? '#ff8877' : '#5a708f';
          ctx.lineWidth = this._lw(1.6);
          if (horizWall) ctx.strokeRect(e.door.x - wl - 0.3, e.door.y - wt / 2 - 0.25, DOOR_W + 0.6, wt + 0.5);
          else ctx.strokeRect(e.door.x - wt / 2 - 0.25, e.door.y - wl - 0.3, wt + 0.5, DOOR_W + 0.6);
        }
        if (this.overlays.conns) this._connLabel(e.door.x, e.door.y, e.label, e.locked ? '#e06a5a' : '#5a708f');
      } else if (a.deck !== b.deck) {
        // lift/ladder pads at both ends (same placement rule as the 3D world)
        for (const [n, other] of [[a, b], [b, a]]) {
          if (!this._visible(n.idx)) continue;
          const px = Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x));
          const lift = e.type === 'lift';
          ctx.fillStyle = lift ? '#173a42' : '#3d3117';
          ctx.strokeStyle = lift ? '#2fd7f0' : '#f0a52f';
          ctx.lineWidth = this._lw(1.4);
          ctx.beginPath(); ctx.arc(px, n.y, 1.05, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = lift ? '#7fe3f2' : '#f0c264';
          ctx.font = this._font(9);
          ctx.textAlign = 'center';
          ctx.fillText(lift ? 'L' : 'K', px, n.y + this._lw(3));
          ctx.textAlign = 'left';
          if (this.overlays.conns) this._connLabel(px, n.y - 2, e.label, '#5a708f');
        }
      }
    }
    for (const s of g.shafts) {
      if (!this._visible(s.a) && !this._visible(s.b)) continue;
      const a = g.node(s.a), b = g.node(s.b);
      if (this.overlays.conns) this._connLabel((a.x + b.x) / 2, (a.y + b.y) / 2, s.label, '#b39a4a');
    }
    for (const v of g.vents) {
      if (!this._visible(v.a) && !this._visible(v.b)) continue;
      const a = g.node(v.a), b = g.node(v.b);
      if (this.overlays.conns) this._connLabel((a.x + b.x) / 2, (a.y + b.y) / 2, v.label, v.blocked ? '#39424c' : '#3f8a5e');
    }
  }

  // strict connection designation drawn at the edge midpoint (user note)
  _connLabel(mx, my, text, color) {
    if (!text) return;
    const { ctx } = this;
    ctx.font = this._font(8);
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(7,9,12,0.82)';
    ctx.fillRect(mx - w / 2 - this._lw(2), my - this._lw(5.5), w + this._lw(4), this._lw(10));
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, mx, my + this._lw(2.5));
    ctx.textAlign = 'left';
  }

  _shafts(g) {
    const { ctx } = this;
    for (const s of g.shafts) {
      if (!this._visible(s.a) && !this._visible(s.b)) continue;
      const a = g.node(s.a), b = g.node(s.b);
      ctx.strokeStyle = '#7a6a2f';
      ctx.lineWidth = this._lw(3.5);
      ctx.setLineDash([this._lw(7), this._lw(5)]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      // ambush corner diamonds, lit when someone lies in wait (§8)
      const occupied = s.ambushers && s.ambushers.size > 0;
      for (const k of [0.25, 0.75]) {
        const mx = a.x + (b.x - a.x) * k, my = a.y + (b.y - a.y) * k;
        const r = this._lw(4);
        ctx.fillStyle = occupied ? '#ffd23f' : '#4d4526';
        ctx.beginPath();
        ctx.moveTo(mx, my - r); ctx.lineTo(mx + r, my); ctx.lineTo(mx, my + r); ctx.lineTo(mx - r, my);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  _vents(g) {
    const { ctx } = this;
    for (const v of g.vents) {
      if (!this._visible(v.a) && !this._visible(v.b)) continue;
      const a = g.node(v.a), b = g.node(v.b);
      ctx.strokeStyle = v.blocked ? '#2a2f36' : '#2f6b46';
      ctx.lineWidth = this._lw(1);
      ctx.setLineDash([this._lw(2), this._lw(4)]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // rooms at their real footprint: rect w × d meters, heat-filled
  _rooms(g) {
    const { ctx, sim } = this;
    for (const n of g.nodes) {
      if (!this._visible(n.idx)) continue;
      const flood = sim.influence.floodStr[n.idx];
      const human = sim.influence.humanStr[n.idx];
      let fill = n.type === 'corridor' ? '#141920' : '#161b23';
      if (this.overlays.influence && (flood > 0.05 || human > 0.05)) {
        const total = flood + human;
        const k = flood / total;
        const alpha = Math.min(0.55, total * 0.12 + 0.12);
        fill = `rgba(${Math.round(30 + k * 40)}, ${Math.round(70 + k * 140)}, ${Math.round(170 - k * 110)}, ${alpha})`;
      }
      const x0 = n.x - n.w / 2, y0 = n.y - n.d / 2;
      ctx.fillStyle = fill;
      ctx.strokeStyle = sim.graph.burningUntil[n.idx] > sim.t ? '#ff7733'
        : g.unpowered[n.idx] ? '#3d3d4d' : '#3a4a61';
      ctx.lineWidth = n.idx === g.breachNode ? this._lw(2.5) : this._lw(1.2);
      if (n.idx === g.breachNode) ctx.strokeStyle = '#ff5533';
      ctx.fillRect(x0, y0, n.w, n.d);
      ctx.strokeRect(x0, y0, n.w, n.d);
      if (g.unpowered[n.idx]) {
        ctx.fillStyle = 'rgba(20,20,30,0.45)';
        ctx.fillRect(x0, y0, n.w, n.d);
      }
      // labels: at far zoom only the big spaces are named (the fit view was
      // a pile of overlapping text); zoom in and every room is labeled
      if (this.overlays.labels && (this.s >= 2.4 || n.w >= 22)) {
        ctx.fillStyle = '#7e90aa';
        ctx.font = this._font(12);
        ctx.textAlign = 'center';
        const above = n.type === 'corridor' ? n.y + this._lw(3) : y0 - this._lw(3);
        ctx.fillText(n.name, n.x, above);
        ctx.textAlign = 'left';
      }
    }
  }

  _callRings(g) {
    const { ctx, sim } = this;
    this.callRings = this.callRings.filter((r) => sim.t - r.t0 < 6);
    for (const r of this.callRings) {
      // anchor the ring on the CALLER, not just the node, so it's never a
      // ring "from no one" — most callers spotted the Flood through a doorway
      // and are standing one room away from it (user note). A marine's report
      // reads blue, a civilian/armed scream reads amber.
      const caller = r.byId ? sim.byId.get(r.byId) : null;
      let cx, cy, node;
      if (caller && !caller.dead) { cx = caller.x; cy = caller.y; node = caller.node; }
      else { node = r.node; const n = g.node(node); cx = n.x; cy = n.y; }
      if (!this._visible(node)) continue;
      const age = sim.t - r.t0;
      const rad = 2 + age * 5;
      const marine = r.faction === FACTION.MARINE;
      const a = Math.max(0, 0.8 - age * 0.13);
      ctx.strokeStyle = marine ? `rgba(90, 150, 240, ${a})` : `rgba(240, 150, 60, ${a})`;
      ctx.lineWidth = this._lw(1.6);
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
      // solid pip on the caller so you can see exactly who is calling
      if (age < 3) {
        ctx.fillStyle = marine ? '#5a96f0' : '#f0963c';
        ctx.beginPath(); ctx.arc(cx, cy, this._lw(3.4), 0, Math.PI * 2); ctx.fill();
      }
    }
    // marine convergence vectors toward active distress objectives
    for (const squad of sim.squads) {
      if (squad.broken || squad.objective?.kind !== 'distress') continue;
      const leader = sim.byId.get(squad.members[0]);
      if (!leader || leader.dead) continue;
      const t = g.node(squad.objective.node);
      if (!this._visible(leader.node) && !this._visible(squad.objective.node)) continue;
      ctx.strokeStyle = 'rgba(77, 142, 240, 0.35)';
      ctx.lineWidth = this._lw(1);
      ctx.setLineDash([this._lw(4), this._lw(4)]);
      ctx.beginPath(); ctx.moveTo(leader.x, leader.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _tracker(g) {
    const { ctx, sim } = this;
    const buf = sim.buffer;
    for (let i = 0; i < buf.count; i++) {
      if (buf.faction[i] !== FACTION.MARINE || buf.integrity[i] <= 0) continue;
      const node = buf.nodeId[i];
      if (!this._visible(node)) continue;
      ctx.strokeStyle = 'rgba(80, 160, 255, 0.18)';
      ctx.lineWidth = this._lw(1);
      ctx.beginPath(); ctx.arc(buf.posX[i], buf.posY[i], 16, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _beliefs(g) {
    const { ctx, sim } = this;
    const bel = sim.hive.believedHumanStr;
    for (const n of g.nodes) {
      if (!this._visible(n.idx) || bel[n.idx] < 0.05) continue;
      ctx.strokeStyle = `rgba(255, 120, 200, ${Math.min(0.8, bel[n.idx] * 0.5)})`;
      ctx.lineWidth = this._lw(1.5);
      ctx.setLineDash([this._lw(3), this._lw(3)]);
      ctx.strokeRect(n.x - n.w / 2 - 1, n.y - n.d / 2 - 1, n.w + 2, n.d + 2);
      ctx.setLineDash([]);
    }
  }

  _agents(dt) {
    const { ctx, sim } = this;
    const buf = sim.buffer;
    // ease each agent's rendered position toward its current sim position,
    // matched BY ID so buffer repacking never causes a fly-across. New agents
    // snap into place (no glide from a stale slot / the origin).
    const k = Math.min(1, dt * 16);
    const seen = new Set();
    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      seen.add(id);
      const tx = buf.posX[i], ty = buf.posY[i];
      let rp = this.rpos.get(id);
      if (!rp) { rp = { x: tx, y: ty }; this.rpos.set(id, rp); }
      else { rp.x += (tx - rp.x) * k; rp.y += (ty - rp.y) * k; }
    }
    if (this.rpos.size > buf.count * 2) { // occasional prune of dead ids
      for (const id of this.rpos.keys()) if (!seen.has(id)) this.rpos.delete(id);
    }
    // glyphs stay readable at any zoom: real meters near, min screen px far
    const rr = (m, px) => Math.max(m, px / this.s);
    // corpses first (they lie under the living)
    for (let i = 0; i < buf.count; i++) {
      if (buf.faction[i] !== FACTION.CORPSE) continue;
      if (!this._visible(buf.nodeId[i])) continue;
      const rp = this.rpos.get(buf.id[i]);
      const burned = buf.flags[i] & FLAG.BURNED;
      this._corpseGlyph(rp.x, rp.y, buf.id[i], burned ? '#181818' : '#6d6d6d');
    }
    for (let i = 0; i < buf.count; i++) {
      const node = buf.nodeId[i];
      const f = buf.faction[i];
      if (f === FACTION.CORPSE || !this._visible(node)) continue;
      const rp = this.rpos.get(buf.id[i]);
      const x = rp.x, y = rp.y;
      const flags = buf.flags[i];
      const burned = flags & FLAG.BURNED;
      const downed = flags & FLAG.DOWNED;
      const color = FACTION_COLOR[f];

      const heading = buf.headingR[i];
      // lore-styled icons read at close zoom; below ~5 px/m they collapse to
      // simple marks so the far view stays legible
      const detailed = this.s >= 5;
      if (burned) {
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.arc(x, y, rr(0.5, 2), 0, Math.PI * 2); ctx.fill();
      } else if (downed) {
        // hollow — a downed combat form waiting on revive/execution
        ctx.strokeStyle = color; ctx.lineWidth = this._lw(1.2);
        ctx.beginPath(); ctx.arc(x, y, rr(0.55, 3), 0, Math.PI * 2); ctx.stroke();
      } else if (f === FACTION.MARINE) {
        this._marineGlyph(x, y, heading, rr(0.55, 2.8), detailed);
      } else if (f === FACTION.ARMED) {
        this._armedGlyph(x, y, heading, rr(0.45, 2.3), detailed);
      } else if (f === FACTION.CIVILIAN) {
        const r = rr(0.42, 2.2);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        if (detailed) { // head + shoulder hint so they read as people
          ctx.fillStyle = '#b9bec6';
          ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
        }
      } else if (f === FACTION.INFECTION) {
        this._infectionGlyph(x, y, rr(0.3, 1.8), buf.id[i], detailed);
      } else if (f === FACTION.COMBAT) {
        this._combatGlyph(x, y, heading, rr(0.65, 3.2), flags, detailed);
      } else if (f === FACTION.CARRIER) {
        // the belly swells with what it carries (user note: game-accurate —
        // it accumulates inside and only ruptures under fire or at the limit)
        const held = sim.byId.get(buf.id[i])?.held ?? 0;
        this._carrierGlyph(x, y, rr(0.85, 4), held / sim.P.carrier.maxInfectionForms, detailed);
      }

      // exposed infection form in a vent flashes (§8: shows the shot window)
      if (flags & FLAG.EXPOSED && Math.floor(sim.t * 6) % 2 === 0) {
        ctx.strokeStyle = '#aaffbb';
        ctx.lineWidth = this._lw(1.4);
        ctx.beginPath(); ctx.arc(x, y, rr(0.6, 4), 0, Math.PI * 2); ctx.stroke();
      }
      if (flags & FLAG.AMBUSH) {
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = this._lw(1);
        ctx.beginPath(); ctx.arc(x, y, rr(0.7, 4.5), 0, Math.PI * 2); ctx.stroke();
      }
      if (flags & FLAG.FLAMER) {
        ctx.fillStyle = '#ff7733';
        const r = this._lw(1.4);
        ctx.fillRect(x - r, y - rr(0.9, 5) - r * 2, r * 2, r * 2);
      }
      if (flags & FLAG.PANICKED) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        const r = this._lw(0.9);
        ctx.fillRect(x - r, y - rr(0.8, 5), r * 2, r * 2);
      }
    }
  }

  // ---- lore-styled NPC glyphs (user note: icons, not just colored dots) ----

  // marine: armored shoulders + helmet with a visor slit + rifle, facing
  // their heading — reads instantly as a soldier
  _marineGlyph(x, y, h, r, detailed) {
    const { ctx } = this;
    if (!detailed) {
      ctx.fillStyle = FACTION_COLOR[FACTION.MARINE];
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      return;
    }
    ctx.save();
    ctx.translate(x, y); ctx.rotate(h);
    // shoulders (armor block, wider than deep)
    ctx.fillStyle = '#33619f';
    ctx.fillRect(-r * 0.5, -r, r * 1.0, r * 2);
    // rifle along the facing, offset to the right hand
    ctx.strokeStyle = '#c9d4e2';
    ctx.lineWidth = r * 0.28;
    ctx.beginPath(); ctx.moveTo(r * 0.1, r * 0.45); ctx.lineTo(r * 1.9, r * 0.45); ctx.stroke();
    // helmet + visor slit
    ctx.fillStyle = '#4d8ef0';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0c1a30';
    ctx.lineWidth = r * 0.22;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.40, -0.7, 0.7); ctx.stroke(); // visor faces heading
    ctx.restore();
  }

  // armed crew: a person with a sidearm out — circle body, short pistol line
  _armedGlyph(x, y, h, r, detailed) {
    const { ctx } = this;
    ctx.fillStyle = FACTION_COLOR[FACTION.ARMED];
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (!detailed) return;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(h);
    ctx.strokeStyle = '#c9d4e2';
    ctx.lineWidth = r * 0.3;
    ctx.beginPath(); ctx.moveTo(r * 0.3, r * 0.35); ctx.lineTo(r * 1.5, r * 0.35); ctx.stroke();
    ctx.fillStyle = '#8a7726';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2); ctx.fill(); // head
    ctx.restore();
  }

  // infection form: a taut pod on wriggling tentacles (they writhe in place)
  _infectionGlyph(x, y, r, id, detailed) {
    const { ctx, sim } = this;
    if (detailed) {
      ctx.strokeStyle = '#2e9946';
      ctx.lineWidth = r * 0.35;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + id;
        const wig = Math.sin(sim.t * 6 + id + k * 1.7) * 0.35;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6);
        ctx.lineTo(x + Math.cos(a + wig) * r * 1.7, y + Math.sin(a + wig) * r * 1.7);
        ctx.stroke();
      }
    }
    ctx.fillStyle = FACTION_COLOR[FACTION.INFECTION];
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (detailed) { // the sensory stalk cluster
      ctx.fillStyle = '#bfffcb';
      ctx.beginPath(); ctx.arc(x, y - r * 0.3, r * 0.35, 0, Math.PI * 2); ctx.fill();
    }
  }

  // combat form: hunched, spined mass with a whip arm — and the host's gun
  // if it died holding one. Charging forms trail a motion streak.
  _combatGlyph(x, y, h, r, flags, detailed) {
    const { ctx } = this;
    if (flags & FLAG.CHARGING) {
      ctx.strokeStyle = 'rgba(192,57,43,0.4)';
      ctx.lineWidth = this._lw(2);
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(h) * r * 3.2, y - Math.sin(h) * r * 3.2);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    if (!detailed) {
      ctx.fillStyle = FACTION_COLOR[FACTION.COMBAT];
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.9, y + r * 0.8); ctx.lineTo(x - r * 0.9, y + r * 0.8);
      ctx.closePath(); ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(x, y); ctx.rotate(h);
    // hunched body: lumpy closed blob with dorsal spines aft
    ctx.fillStyle = '#8f2c22';
    ctx.beginPath();
    ctx.moveTo(r * 0.9, 0);
    ctx.lineTo(r * 0.2, -r * 0.75);
    ctx.lineTo(-r * 0.45, -r * 0.95); // spine
    ctx.lineTo(-r * 0.35, -r * 0.4);
    ctx.lineTo(-r * 1.0, -r * 0.35);  // spine
    ctx.lineTo(-r * 0.6, 0);
    ctx.lineTo(-r * 1.0, r * 0.5);    // spine
    ctx.lineTo(-r * 0.3, r * 0.55);
    ctx.lineTo(r * 0.3, r * 0.8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = FACTION_COLOR[FACTION.COMBAT];
    ctx.beginPath(); ctx.arc(r * 0.1, 0, r * 0.55, 0, Math.PI * 2); ctx.fill();
    // whip arm forward-left
    ctx.strokeStyle = '#d8654f';
    ctx.lineWidth = r * 0.22;
    ctx.beginPath();
    ctx.moveTo(r * 0.4, -r * 0.3);
    ctx.quadraticCurveTo(r * 1.3, -r * 0.8, r * 1.8, -r * 0.25);
    ctx.stroke();
    // host's weapon forward-right (lore: combat forms keep their guns)
    if (flags & FLAG.ARMED_HOST) {
      ctx.strokeStyle = '#c9d4e2';
      ctx.lineWidth = r * 0.24;
      ctx.beginPath(); ctx.moveTo(r * 0.2, r * 0.45); ctx.lineTo(r * 1.7, r * 0.45); ctx.stroke();
    }
    ctx.restore();
  }

  // carrier: bulbous two-lobed sack on stubby legs; the belly lobe swells
  // with the payload and strains as it nears the rupture point
  _carrierGlyph(x, y, r, fill01, detailed) {
    const { ctx, sim } = this;
    const swell = r * (0.75 + fill01 * 0.9);
    if (detailed) { // stubby legs
      ctx.strokeStyle = '#6d4a7e';
      ctx.lineWidth = r * 0.3;
      for (const k of [-0.8, -0.3, 0.3, 0.8]) {
        ctx.beginPath(); ctx.moveTo(x + k * r * 0.7, y + r * 0.4); ctx.lineTo(x + k * r, y + r * 1.05); ctx.stroke();
      }
    }
    // belly sack (swells with held forms; throbs when close to full)
    const throb = fill01 > 0.6 ? 1 + Math.sin(sim.t * 5) * 0.05 : 1;
    ctx.fillStyle = '#9a68b8';
    ctx.beginPath(); ctx.arc(x, y - swell * 0.35, swell * throb, 0, Math.PI * 2); ctx.fill();
    // body lobe
    ctx.fillStyle = FACTION_COLOR[FACTION.CARRIER];
    ctx.beginPath(); ctx.arc(x, y + r * 0.25, r * 0.7, 0, Math.PI * 2); ctx.fill();
    if (detailed && fill01 > 0) { // strain lines on the sack
      ctx.strokeStyle = 'rgba(230, 200, 255, 0.55)';
      ctx.lineWidth = r * 0.12;
      ctx.beginPath(); ctx.arc(x, y - swell * 0.35, swell * 0.6, -2.2, -0.9); ctx.stroke();
    }
  }

  // a body lying where it fell: short slab + head dot, angle fixed per id
  _corpseGlyph(x, y, id, color) {
    const { ctx } = this;
    const ang = (id * 2.399963) % (Math.PI * 2);
    const len = Math.max(0.9, 3 / this.s);
    const dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.32, 1.6 / this.s);
    ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x + dx * 1.25, y + dy * 1.25, Math.max(0.18, 0.9 / this.s), 0, Math.PI * 2); ctx.fill();
  }

  // the fight INSIDE the room (user note): tracers + muzzle flashes while a
  // node exchanges fire, grab tethers while a form takes someone, progress
  // arcs over bodies being converted and combat forms rooting into carriers
  _combatFx(g) {
    const { ctx, sim } = this;
    // gunfire: nodes that fired within the last couple of ticks — every
    // marine and armed civilian shooting shows it (user note): strobing
    // tracer + a bright star-shaped muzzle flash at the barrel
    if (this.overlays.fire) for (let n = 0; n < g.n; n++) {
      if (sim.tickCount - sim.gunfireTick[n] > 2 || !this._visible(n)) continue;
      const occ = sim.occupants(n);
      const shooters = occ.filter((a) => a.hp > 0 && !a.dead &&
        (a.faction === FACTION.MARINE || (a.faction === FACTION.ARMED && a.state === STATE.FIGHT)));
      const targets = occ.filter((a) => !a.dead && a.hp > 0 && !a.downed &&
        (a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER || a.faction === FACTION.INFECTION));
      if (!shooters.length || !targets.length) continue;
      for (const sh of shooters) {
        const t = targets[(sh.id + (sim.tickCount >> 1)) % targets.length];
        const sp = this.rpos.get(sh.id) ?? sh, tp = this.rpos.get(t.id) ?? t;
        const flick = (sh.id + sim.tickCount) % 3;
        if (flick === 0) continue; // strobing, not a solid beam
        const dx = tp.x - sp.x, dy = tp.y - sp.y, dl = Math.hypot(dx, dy) || 1;
        const mx = sp.x + dx / dl * 0.8, my = sp.y + dy / dl * 0.8;
        ctx.strokeStyle = `rgba(255, 224, 140, ${flick === 1 ? 0.55 : 0.3})`;
        ctx.lineWidth = Math.max(0.08, 1 / this.s);
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(tp.x, tp.y); ctx.stroke();
        this._muzzleFlash(mx, my, Math.atan2(dy, dx), flick === 1);
      }
    }
    // grabs, conversions, rooting — read straight from the sim agents
    for (const a of sim.agents) {
      if (a.dead || !this._visible(a.node)) continue;
      const ap = this.rpos.get(a.id) ?? a;
      if (a.state === STATE.GRABBING && a.task?.targetId !== undefined) {
        const v = sim.byId.get(a.task.targetId);
        if (v && !v.dead) {
          const vp = this.rpos.get(v.id) ?? v;
          const pulse = 0.45 + 0.3 * Math.sin(sim.t * 9);
          ctx.strokeStyle = `rgba(90, 255, 120, ${pulse})`;
          ctx.lineWidth = Math.max(0.14, 1.4 / this.s);
          ctx.beginPath(); ctx.moveTo(ap.x, ap.y); ctx.lineTo(vp.x, vp.y); ctx.stroke();
          const need = v.faction === FACTION.CIVILIAN ? sim.P.combat.civilianGrabSec : sim.P.combat.infectionGrabSec;
          this._progressArc(vp.x, vp.y, (a.grabTimer ?? 0) / need, '#51ff6a');
        }
      } else if (a.task?.kind === TASK.CONVERT && a.taskProgress > 0) {
        const body = sim.byId.get(a.task.corpseId);
        if (body && !body.dead) {
          const bp = this.rpos.get(body.id) ?? body;
          this._progressArc(bp.x, bp.y, a.taskProgress / sim.P.combat.corpseConvertSec, '#51ff6a');
        }
      } else if (a.task?.kind === TASK.TRANSFORM && a.taskProgress > 0) {
        this._progressArc(ap.x, ap.y, a.taskProgress / sim.P.carrier.transformSec, '#b15fd9');
      }
    }
  }

  // four-point star + hot core + faint glow, oriented along the shot
  _muzzleFlash(x, y, ang, bright) {
    const { ctx } = this;
    const r = Math.max(0.45, 3.2 / this.s) * (bright ? 1 : 0.7);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = `rgba(255, 190, 90, ${bright ? 0.28 : 0.16})`;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.8, 0, Math.PI * 2); ctx.fill(); // glow
    ctx.strokeStyle = `rgba(255, 240, 190, ${bright ? 0.95 : 0.7})`;
    ctx.lineWidth = Math.max(0.1, 1.2 / this.s);
    ctx.beginPath();
    ctx.moveTo(-r, 0); ctx.lineTo(r * 1.5, 0); // long spike down-range
    ctx.moveTo(0, -r * 0.7); ctx.lineTo(0, r * 0.7);
    ctx.stroke();
    ctx.fillStyle = '#fff6dc';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2); ctx.fill(); // core
    ctx.restore();
  }

  _progressArc(x, y, frac, color) {
    const { ctx } = this;
    const r = Math.max(0.9, 5 / this.s);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.16, 1.6 / this.s);
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frac) * Math.PI * 2);
    ctx.stroke();
  }
}

export function renderStats(sim, el) {
  const s = sim.getStats();
  const rows = [
    ['time', fmtTime(s.t) + (s.outcome ? ` — ${s.outcome.toUpperCase()}` : '')],
    ['phase', s.opening ? 'OPENING (racing first sweep)' : 'steady state'],
    ['scarcity', s.scarcity.toFixed(2) + (s.scarcity > 2 ? ' (hoarding)' : s.scarcity <= 0.75 ? ' (spending freely)' : '')],
    ['—', '—'],
    ['civilians', s.civ], ['armed crew', s.armed], ['marines', s.marine],
    ['—', '—'],
    ['infection pool', s.infection],
    ['combat forms', `${s.combat} (+${s.combatDowned} downed)`],
    ['carriers', s.carrier],
    ['gestating inside', s.gestating],
    ['—', '—'],
    ['bodies left', s.corpses], ['bodies burned', s.corpsesBurned],
    ['flood-held nodes', s.floodControlled],
    ['conversions', s.conversions + (s.conversionsRound ? ` (+${s.conversionsRound} this round)` : '')],
    ['carriers seated', s.carriersSeated],
    ['forms released', s.formsMinted],
    ['distress calls', s.distressCalls],
    ['vent kills', s.formsShotInVents],
  ];
  el.innerHTML = rows.map(([k, v]) => k === '—'
    ? '<div class="sep"></div>'
    : `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
}

export function renderLog(sim, el, maxLines = 300) {
  // only rebuild when something new arrived — rewriting every frame made the
  // log impossible to scroll
  const stamp = sim.events.length + ':' + (sim.events[sim.events.length - 1]?.t ?? 0);
  if (el._stamp === stamp) return;
  el._stamp = stamp;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const prevTop = el.scrollTop;
  const events = sim.events.slice(-maxLines);
  el.innerHTML = events.map((e) =>
    `<div class="ev ev-${e.type}"><span class="t">${fmtTime(e.t)}</span> ${escapeHtml(e.msg)}</div>`
  ).join('');
  // follow the tail only if the user was already at the tail; otherwise
  // leave their scroll position alone so they can read history
  el.scrollTop = atBottom ? el.scrollHeight : prevTop;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
