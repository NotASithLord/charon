// Debug visualization (§8): top-down schematic, decks stacked or isolated,
// influence heatmap, three traversal-layer overlays, agents as dots,
// distress rings, flow vectors, motion-tracker circles, stats panel.

import { FACTION, FLAG } from '../shared/agentBuffer.js';
import { fmtTime } from './sim.js';

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
    this.overlays = { influence: true, shafts: true, vents: true, calls: true, tracker: false, beliefs: false, labels: true, conns: false };
    this.callRings = []; // {node, t0}
    this.lastCallCount = 0;
    // per-agent render position keyed by AGENT ID, not buffer slot. The sim
    // repacks the buffer as agents die/spawn, so slot i holds different agents
    // over time — interpolating by slot made every agent "fly into position"
    // whenever the roster changed. Smoothing per id fixes that stutter.
    this.rpos = new Map();
  }

  setSim(sim) { this.sim = sim; this.callRings = []; this.lastCallCount = 0; this.rpos = new Map(); }

  draw(dt = 0.016) {
    const { ctx, sim } = this;
    const g = sim.graph;
    const W = this.canvas.width, H = this.canvas.height;
    const sx = W / g.width, sy = H / g.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.scale(sx, sy);

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
    this._nodes(g);
    if (this.overlays.calls) this._callRings(g);
    if (this.overlays.tracker) this._tracker(g);
    if (this.overlays.beliefs) this._beliefs(g);
    this._agents(dt);
    ctx.restore();
  }

  _visible(nodeIdx) {
    return this.deckFilter === 0 || this.sim.graph.node(nodeIdx).deck === this.deckFilter;
  }

  _deckBands(g) {
    const { ctx } = this;
    ctx.font = '11px monospace';
    for (let d = 1; d <= 5; d++) {
      const y0 = 46 + (d - 1) * 132;
      ctx.fillStyle = this.deckFilter && this.deckFilter !== d ? '#0b0e12' : (d % 2 ? '#11151c' : '#0e1218');
      ctx.fillRect(0, y0, g.width, 132);
      ctx.fillStyle = '#3a4556';
      ctx.fillText(`DECK ${d}${d === 1 ? ' — COMMAND' : d === 5 ? ' — ENGINEERING' : ''}`, 10, y0 + 14);
    }
    ctx.fillStyle = '#232b38';
    ctx.fillText('BOW ◄', 12, 40);
    ctx.fillText('► STERN', g.width - 64, 40);
  }

  _edgeColor(e) {
    if (e.locked) return '#7a2d2d';
    return '#2c3a4d';
  }

  _edges(g) {
    const { ctx } = this;
    for (const e of g.edges) {
      if (!this._visible(e.a) && !this._visible(e.b)) continue;
      const a = g.node(e.a), b = g.node(e.b);
      ctx.strokeStyle = this._edgeColor(e);
      ctx.lineWidth = e.type === 'blastdoor' ? 3 : 1.5;
      ctx.setLineDash(e.type === 'lift' || e.type === 'ladder' ? [2, 3] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (e.locked) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.fillStyle = '#c0392b';
        ctx.fillRect(mx - 2.5, my - 2.5, 5, 5);
      }
      if (this.overlays.conns) this._connLabel(a, b, e.label, e.locked ? '#e06a5a' : '#5a708f');
    }
  }

  // strict connection designation drawn at the edge midpoint (user note)
  _connLabel(a, b, text, color) {
    if (!text) return;
    const { ctx } = this;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.font = '8px monospace';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(7,9,12,0.82)';
    ctx.fillRect(mx - w / 2 - 2, my - 5.5, w + 4, 10);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, mx, my + 2.5);
    ctx.textAlign = 'left';
  }

  _shafts(g) {
    const { ctx, sim } = this;
    for (const s of g.shafts) {
      if (!this._visible(s.a) && !this._visible(s.b)) continue;
      const a = g.node(s.a), b = g.node(s.b);
      ctx.strokeStyle = '#7a6a2f';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      // ambush corner diamonds, lit when someone lies in wait (§8)
      const occupied = s.ambushers && s.ambushers.size > 0;
      for (const k of [0.25, 0.75]) {
        const mx = a.x + (b.x - a.x) * k, my = a.y + (b.y - a.y) * k;
        ctx.fillStyle = occupied ? '#ffd23f' : '#4d4526';
        ctx.beginPath();
        ctx.moveTo(mx, my - 4); ctx.lineTo(mx + 4, my); ctx.lineTo(mx, my + 4); ctx.lineTo(mx - 4, my);
        ctx.closePath(); ctx.fill();
      }
      if (this.overlays.conns) this._connLabel(a, b, s.label, '#b39a4a');
    }
  }

  _vents(g) {
    const { ctx, sim } = this;
    for (const v of g.vents) {
      if (!this._visible(v.a) && !this._visible(v.b)) continue;
      const a = g.node(v.a), b = g.node(v.b);
      ctx.strokeStyle = v.blocked ? '#2a2f36' : '#2f6b46';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      if (this.overlays.conns) this._connLabel(a, b, v.label, v.blocked ? '#39424c' : '#3f8a5e');
    }
  }

  _nodes(g) {
    const { ctx, sim } = this;
    for (const n of g.nodes) {
      if (!this._visible(n.idx)) continue;
      const flood = sim.influence.floodStr[n.idx];
      const human = sim.influence.humanStr[n.idx];
      // heatmap: human-blue through contested-dark to flood-green (§8)
      let fill = '#161b23';
      if (this.overlays.influence && (flood > 0.05 || human > 0.05)) {
        const total = flood + human;
        const k = flood / total;
        const alpha = Math.min(0.55, total * 0.12 + 0.12);
        fill = `rgba(${Math.round(30 + k * 40)}, ${Math.round(70 + k * 140)}, ${Math.round(170 - k * 110)}, ${alpha})`;
      }
      ctx.fillStyle = fill;
      ctx.strokeStyle = sim.graph.burningUntil[n.idx] > sim.t ? '#ff7733'
        : g.unpowered[n.idx] ? '#3d3d4d' : '#3a4a61';
      ctx.lineWidth = n.idx === g.breachNode ? 2.5 : 1.2;
      if (n.idx === g.breachNode) ctx.strokeStyle = '#ff5533';
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (g.unpowered[n.idx]) {
        ctx.fillStyle = 'rgba(20,20,30,0.45)';
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      }
      if (this.overlays.labels) {
        ctx.fillStyle = '#5b6b82';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.name, n.x, n.y + n.r + 9);
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
      const rad = 8 + age * 14;
      const marine = r.faction === FACTION.MARINE;
      const a = Math.max(0, 0.8 - age * 0.13);
      ctx.strokeStyle = marine ? `rgba(90, 150, 240, ${a})` : `rgba(240, 150, 60, ${a})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
      // solid pip on the caller so you can see exactly who is calling
      if (age < 3) {
        ctx.fillStyle = marine ? '#5a96f0' : '#f0963c';
        ctx.beginPath(); ctx.arc(cx, cy, 3.4, 0, Math.PI * 2); ctx.fill();
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
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
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
      ctx.beginPath(); ctx.arc(buf.posX[i], buf.posY[i], 55, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _beliefs(g) {
    const { ctx, sim } = this;
    const bel = sim.hive.believedHumanStr;
    for (const n of g.nodes) {
      if (!this._visible(n.idx) || bel[n.idx] < 0.05) continue;
      ctx.strokeStyle = `rgba(255, 120, 200, ${Math.min(0.8, bel[n.idx] * 0.5)})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2); ctx.stroke();
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
    for (let i = 0; i < buf.count; i++) {
      const node = buf.nodeId[i];
      if (!this._visible(node)) continue;
      const rp = this.rpos.get(buf.id[i]);
      const x = rp.x, y = rp.y;
      const f = buf.faction[i];
      const flags = buf.flags[i];
      const burned = flags & FLAG.BURNED;
      const downed = flags & FLAG.DOWNED;
      let r = f === FACTION.CARRIER ? 4.5 : f === FACTION.COMBAT ? 3.5 : f === FACTION.INFECTION ? 2 : 2.6;
      if (f === FACTION.CORPSE) r = 2;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (burned) { ctx.fillStyle = '#111'; ctx.fill(); ctx.strokeStyle = '#333'; ctx.lineWidth = 0.8; ctx.stroke(); }
      else if (downed) { ctx.strokeStyle = FACTION_COLOR[f]; ctx.lineWidth = 1.2; ctx.stroke(); } // hollow
      else { ctx.fillStyle = FACTION_COLOR[f]; ctx.fill(); }

      // exposed infection form in a vent flashes (§8: shows the shot window)
      if (flags & FLAG.EXPOSED && Math.floor(sim.t * 6) % 2 === 0) {
        ctx.strokeStyle = '#aaffbb';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
      }
      if (flags & FLAG.AMBUSH) {
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.stroke();
      }
      if (flags & FLAG.FLAMER) {
        ctx.fillStyle = '#ff7733';
        ctx.fillRect(x - 1.4, y - r - 4, 2.8, 2.8);
      }
      if (flags & FLAG.PANICKED) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(x - 0.8, y - r - 4, 1.6, 1.6);
      }
    }
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
    ['—', '—'],
    ['bodies left', s.corpses], ['bodies burned', s.corpsesBurned],
    ['flood-held nodes', s.floodControlled],
    ['conversions', s.conversions + (s.conversionsRound ? ` (+${s.conversionsRound} this round)` : '')],
    ['carriers seated', s.carriersSeated],
    ['forms minted', s.formsMinted],
    ['distress calls', s.distressCalls],
    ['vent kills', s.formsShotInVents],
  ];
  el.innerHTML = rows.map(([k, v]) => k === '—'
    ? '<div class="sep"></div>'
    : `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
}

export function renderLog(sim, el, maxLines = 26) {
  const events = sim.events.slice(-maxLines);
  el.innerHTML = events.map((e) =>
    `<div class="ev ev-${e.type}"><span class="t">${fmtTime(e.t)}</span> ${escapeHtml(e.msg)}</div>`
  ).join('');
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
