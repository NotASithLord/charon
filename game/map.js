// MARINE TACNET (user request): a map view like the sim view's deck plan,
// but it only shows what the marine teams actually SEE. The ship schematic
// itself is always drawn — every marine has the blueprints — but room
// CONTENTS (flood contacts, bodies, lights-out) only appear where a living
// marine (or you) currently has eyes. When the last observer leaves a room,
// its intel goes stale: it stays on the map as a last-seen report that
// fades with age. Friendlies broadcast position and vitals over the squad
// net, so every marine shows live with health and squad tag, plus a roster
// panel. Read-only over the sim — it never touches state or the RNG.

import { FACTION } from '../shared/agentBuffer.js';
import { fmtTime } from '../sim/sim.js';

const STALE_FADE_SEC = 180;   // last-seen reports fade to minimum over 3 min
const CONTACT_FRESH_SEC = 5;  // under this age a report still reads "just now"

export class MarineMap {
  constructor(canvas, sideEl, sim, fireteamId, playerAgentId) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sideEl = sideEl;
    this.sim = sim;
    this.fireteamId = fireteamId;
    this.playerAgentId = playerAgentId;
    const n = sim.graph.n;
    this.lastSeenT = new Float64Array(n).fill(-1); // -1 = never observed
    this.seenFlood = new Float32Array(n);          // flood strength at last look
    this.seenCorpses = new Uint16Array(n);
    this.seenDark = new Uint8Array(n);             // 0 clear, 1 dark, 2 spore fog
    this.liveObs = new Uint8Array(n);
    this._corpseScratch = new Uint16Array(n);
    this._floodScratch = new Float32Array(n); // VISIBLE forms only — vent transit excluded
    this._panelAt = 0;
    this.marines0 = sim.agents.filter((a) => a.faction === FACTION.MARINE).length;
    this.s = 1;
    this.dpr = 1;
  }

  // Run every frame, cheap — intel accumulates even while the map is closed,
  // exactly like a real ops board someone else is keeping up to date.
  observe() {
    const { sim } = this;
    this.liveObs.fill(0);
    this._corpseScratch.fill(0);
    this._floodScratch.fill(0);
    for (const a of sim.agents) {
      if (a.dead) continue;
      if (a.faction === FACTION.CORPSE) { this._corpseScratch[a.node]++; continue; }
      if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
        // a form transiting a vent is out of everyone's sight — it counts
        // toward nothing on this board (same rule as the player's eyes)
        if (!(a.move && (a.move.layer === 'vent' || a.move.layer === 'shaft'))) {
          this._floodScratch[a.node] += a.faction === FACTION.CARRIER ? 2 : 1;
        }
        continue;
      }
      // eyes on the net: living marines, and the player (armed or not — the
      // ODST rig reports either way)
      if ((a.faction === FACTION.MARINE && a.hp > 0) || a.id === this.playerAgentId) {
        this.liveObs[a.node] = 1;
      }
    }
    for (let n = 0; n < sim.graph.n; n++) {
      if (!this.liveObs[n]) continue;
      this.lastSeenT[n] = sim.t;
      this.seenFlood[n] = this._floodScratch[n];
      this.seenCorpses[n] = this._corpseScratch[n];
      this.seenDark[n] = sim.fogAt(n) ? 2 : sim.darkAt(n) ? 1 : 0;
    }
  }

  // --- drawing helpers (meter-space transform, constant on-screen sizes) ---
  _lw(px) { return (px * this.dpr) / this.s; }
  _font(px) { return `${(px * this.dpr) / this.s}px monospace`; }
  _rr(m, px) { return Math.max(m, (px * this.dpr) / this.s); }

  draw(playerAgent, playerDead) {
    const { canvas, ctx, sim } = this;
    const g = sim.graph;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
    if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
    const W = canvas.width, H = canvas.height;
    // the roster panel owns a left gutter — the plan centers in what's left
    const gutter = 280 * dpr;
    const s = Math.min((W - gutter) / (g.width + 6), H / (g.height + 6)) * 0.98;
    this.s = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, gutter + (W - gutter) / 2 - (g.width / 2) * s, H / 2 - (g.height / 2) * s);

    this._deckBands(g);
    this._rooms(g);
    this._doorsAndPads(g);
    this._staleIntel(g);
    this._contacts(g);
    this._callRings(g);
    this._agents(g, playerAgent, playerDead);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._panel();
  }

  _deckBands(g) {
    const { ctx } = this;
    ctx.font = this._font(11);
    for (let d = 1; d <= 5; d++) {
      const band = g.deckBands[d - 1];
      ctx.fillStyle = d % 2 ? '#0d1117' : '#0b0e14';
      ctx.fillRect(0, band.y0, g.width, band.y1 - band.y0);
      const deckNodes = g.nodes.filter((n) => n.deck === d);
      if (deckNodes.length) {
        const x0 = Math.min(...deckNodes.map((n) => n.x - n.w / 2)) - 1.6;
        const x1 = Math.max(...deckNodes.map((n) => n.x + n.w / 2)) + 1.6;
        const y0 = Math.min(...deckNodes.map((n) => n.y - n.d / 2)) - 1.6;
        const y1 = Math.max(...deckNodes.map((n) => n.y + n.d / 2)) + 1.6;
        ctx.fillStyle = '#11161f';
        ctx.strokeStyle = '#232d40';
        ctx.lineWidth = this._lw(1.4);
        ctx.beginPath();
        ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 3);
        ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = '#38445a';
      ctx.fillText(`DECK ${d} — ${['COMMAND', 'HABITATION', 'OPERATIONS', 'ENGINEERING', 'FLIGHT'][d - 1]}`, 3, band.y0 + this._lw(13));
    }
    ctx.fillStyle = '#232b38';
    ctx.fillText('BOW ◄', 3, g.deckBands[0].y0 - this._lw(4));
    ctx.fillText('► STERN', g.width - this._lw(58), g.deckBands[0].y0 - this._lw(4));
  }

  _rooms(g) {
    const { ctx, sim } = this;
    for (const n of g.nodes) {
      const seen = this.lastSeenT[n.idx] >= 0;
      const live = this.liveObs[n.idx] === 1;
      const age = seen ? sim.t - this.lastSeenT[n.idx] : Infinity;
      const conf = live ? 1 : Math.max(0.3, 1 - age / STALE_FADE_SEC);
      const x0 = n.x - n.w / 2, y0 = n.y - n.d / 2;
      // schematic base: unexplored rooms are just blueprint outlines
      ctx.fillStyle = !seen ? '#0a0d12' : live ? '#1a2231' : '#12161f';
      ctx.fillRect(x0, y0, n.w, n.d);
      if (seen) {
        // lights-out / spore state at last observation (live rooms read the
        // sim directly so the tint is current)
        const darkState = live ? (sim.fogAt(n.idx) ? 2 : sim.darkAt(n.idx) ? 1 : 0) : this.seenDark[n.idx];
        if (darkState === 1) {
          ctx.fillStyle = `rgba(16, 28, 12, ${0.62 * conf})`;
          ctx.fillRect(x0, y0, n.w, n.d);
        } else if (darkState === 2) {
          ctx.fillStyle = `rgba(58, 72, 22, ${0.5 * conf})`;
          ctx.fillRect(x0, y0, n.w, n.d);
        }
        const flood = live ? this._floodScratch[n.idx] : this.seenFlood[n.idx];
        if (flood > 0.05) {
          ctx.fillStyle = `rgba(255, 62, 42, ${Math.min(0.5, 0.12 + flood * 0.09) * conf})`;
          ctx.fillRect(x0, y0, n.w, n.d);
        }
      }
      ctx.strokeStyle = live ? '#4d6f9f' : seen ? '#2a3547' : '#1b2330';
      ctx.lineWidth = this._lw(live ? 1.6 : 1);
      ctx.strokeRect(x0, y0, n.w, n.d);
      // labels: big spaces always (it's the ship's plan); small rooms once
      // there's anything worth reading there
      if (n.w >= 15 || live || (seen && (this.seenFlood[n.idx] > 0.05 || this.seenDark[n.idx]))) {
        ctx.fillStyle = seen ? '#7e90aa' : '#3a4557';
        ctx.font = this._font(10);
        ctx.textAlign = 'center';
        const above = n.type === 'corridor' ? n.y + this._lw(3) : y0 - this._lw(3);
        ctx.fillText(n.name, n.x, above);
        ctx.textAlign = 'left';
      }
      // bodies reported in the room
      const corpses = live ? this._corpseScratch[n.idx] : seen ? this.seenCorpses[n.idx] : 0;
      if (corpses > 0) {
        ctx.fillStyle = `rgba(150, 150, 150, ${0.85 * conf})`;
        ctx.font = this._font(9);
        ctx.fillText(`✕${corpses}`, x0 + this._lw(3), y0 + n.d - this._lw(3));
      }
    }
  }

  // the schematic knows every door and lift — and the ship net reports locks
  _doorsAndPads(g) {
    const { ctx } = this;
    const DOOR_W = 1.7;
    for (const e of g.edges) {
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck === b.deck && e.door) {
        const horizWall = Math.abs(a.y - b.y) >= Math.abs(a.x - b.x);
        const wl = DOOR_W / 2, wt = 0.55;
        ctx.fillStyle = e.locked ? '#a33a2e' : '#556a85';
        if (horizWall) ctx.fillRect(e.door.x - wl, e.door.y - wt / 2, DOOR_W, wt);
        else ctx.fillRect(e.door.x - wt / 2, e.door.y - wl, wt, DOOR_W);
      } else if (a.deck !== b.deck) {
        for (const [n, other] of [[a, b], [b, a]]) {
          const px = Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x));
          const lift = e.type === 'lift';
          ctx.strokeStyle = lift ? '#1f5560' : '#5c4a20';
          ctx.lineWidth = this._lw(1.2);
          ctx.beginPath(); ctx.arc(px, n.y, 0.9, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
  }

  // stale flood reports: a hollow diamond + how old the sighting is
  _staleIntel(g) {
    const { ctx, sim } = this;
    for (const n of g.nodes) {
      if (this.liveObs[n.idx] || this.lastSeenT[n.idx] < 0 || this.seenFlood[n.idx] <= 0.05) continue;
      const age = sim.t - this.lastSeenT[n.idx];
      const conf = Math.max(0.3, 1 - age / STALE_FADE_SEC);
      const r = this._rr(1.1, 5);
      ctx.strokeStyle = `rgba(255, 90, 70, ${0.9 * conf})`;
      ctx.lineWidth = this._lw(1.4);
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - r); ctx.lineTo(n.x + r, n.y); ctx.lineTo(n.x, n.y + r); ctx.lineTo(n.x - r, n.y);
      ctx.closePath(); ctx.stroke();
      if (age > CONTACT_FRESH_SEC) {
        ctx.fillStyle = `rgba(255, 130, 110, ${0.85 * conf})`;
        ctx.font = this._font(8.5);
        ctx.textAlign = 'center';
        ctx.fillText(`${fmtTime(age)} ago`, n.x, n.y + r + this._lw(9));
        ctx.textAlign = 'left';
      }
    }
  }

  // fresh squad contact reports called over the radio
  _contacts(g) {
    const { ctx, sim } = this;
    for (const squad of sim.squads) {
      if (squad.contactNode === undefined || sim.tickCount - squad.contactTick > 15 * 10) continue;
      const n = g.node(squad.contactNode);
      const r = this._rr(1.4, 7);
      const pulse = 0.55 + 0.35 * Math.sin(sim.t * 6);
      ctx.strokeStyle = `rgba(255, 70, 50, ${pulse})`;
      ctx.lineWidth = this._lw(1.8);
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - r); ctx.lineTo(n.x + r, n.y + r * 0.85); ctx.lineTo(n.x - r, n.y + r * 0.85);
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = `rgba(255, 110, 90, ${pulse})`;
      ctx.font = this._font(8.5);
      ctx.textAlign = 'center';
      ctx.fillText('CONTACT', n.x, n.y - r - this._lw(3));
      ctx.textAlign = 'left';
    }
  }

  _callRings(g) {
    const { ctx, sim } = this;
    for (const c of sim.calls) {
      const age = sim.t - c.t;
      if (age > 8) continue;
      const n = g.node(c.node);
      const alpha = Math.max(0, 0.8 - age * 0.1);
      ctx.strokeStyle = c.faction === FACTION.MARINE
        ? `rgba(90, 150, 240, ${alpha})` : `rgba(240, 150, 60, ${alpha})`;
      ctx.lineWidth = this._lw(1.6);
      ctx.beginPath(); ctx.arc(n.x, n.y, 2 + age * 4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _squadTag(a) {
    if (a.garrison) return 'G';
    const squad = this.sim.squads[a.squad];
    if (!squad) return '';
    if (squad.id === this.fireteamId) return 'FT';
    if (squad.patrol) return `P${squad.patrolNo}`;
    return `S${squad.id + 1}`;
  }

  _agents(g, playerAgent, playerDead) {
    const { ctx, sim } = this;
    // hostiles and civilians — only where a marine has eyes right now
    for (const a of sim.agents) {
      if (a.dead || !this.liveObs[a.node]) continue;
      if (a.move && (a.move.layer === 'vent' || a.move.layer === 'shaft')) continue; // in the ducts — unseen
      const f = a.faction;
      if (f === FACTION.INFECTION || f === FACTION.COMBAT || f === FACTION.CARRIER) {
        const r = f === FACTION.INFECTION ? this._rr(0.35, 2) : f === FACTION.CARRIER ? this._rr(0.85, 4) : this._rr(0.6, 3);
        ctx.fillStyle = f === FACTION.INFECTION ? '#51ff6a' : f === FACTION.CARRIER ? '#b15fd9' : '#e04434';
        ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2); ctx.fill();
      } else if (f === FACTION.CIVILIAN || f === FACTION.ARMED) {
        if (a.id === this.playerAgentId) continue; // drawn as the player marker
        ctx.fillStyle = f === FACTION.ARMED ? 'rgba(232,200,64,0.8)' : 'rgba(220,224,230,0.65)';
        ctx.beginPath(); ctx.arc(a.x, a.y, this._rr(0.4, 2), 0, Math.PI * 2); ctx.fill();
      }
    }
    // marines: live over the squad net everywhere — tag + health bar each
    ctx.font = this._font(8.5);
    for (const a of sim.agents) {
      if (a.dead || a.hp <= 0 || a.faction !== FACTION.MARINE) continue;
      const r = this._rr(0.6, 3.2);
      const mine = a.squad === this.fireteamId;
      ctx.fillStyle = mine ? '#7fd1a0' : '#4d8ef0';
      ctx.save();
      ctx.translate(a.x, a.y); ctx.rotate(a.heading);
      ctx.fillRect(-r * 0.7, -r, r * 1.4, r * 2);
      ctx.restore();
      // squad tag above
      ctx.fillStyle = mine ? '#a8e8c4' : '#8fb5e8';
      ctx.textAlign = 'center';
      ctx.fillText(this._squadTag(a), a.x, a.y - r - this._lw(3));
      ctx.textAlign = 'left';
      // health bar below
      const hw = this._rr(1.8, 9), hh = this._lw(2);
      const frac = Math.max(0, Math.min(1, a.hp / a.maxHp));
      ctx.fillStyle = 'rgba(10,14,20,0.8)';
      ctx.fillRect(a.x - hw / 2, a.y + r + this._lw(2), hw, hh);
      ctx.fillStyle = frac > 0.66 ? '#5fd88a' : frac > 0.33 ? '#e8c840' : '#ff5a48';
      ctx.fillRect(a.x - hw / 2, a.y + r + this._lw(2), hw * frac, hh);
    }
    // you: a white chevron pointing your heading
    if (playerAgent && !playerDead) {
      const r = this._rr(0.8, 4.5);
      ctx.save();
      ctx.translate(playerAgent.x, playerAgent.y);
      ctx.rotate(playerAgent.heading + Math.PI / 2);
      ctx.fillStyle = '#f2f6ff';
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(-r * 0.75, r * 0.8); ctx.lineTo(0, r * 0.35); ctx.lineTo(r * 0.75, r * 0.8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // --- squad roster panel (HTML, rebuilt at 4 Hz) ---
  _panel() {
    const now = performance.now();
    if (now - this._panelAt < 250) return;
    this._panelAt = now;
    const { sim } = this;
    const alive = (ids) => ids.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    const pips = (members) => members.map((m) => {
      const f = m.hp / m.maxHp;
      const c = f > 0.66 ? '#5fd88a' : f > 0.33 ? '#e8c840' : '#ff5a48';
      return `<i style="background:${c}"></i>`;
    }).join('');
    const marinesAlive = sim.agents.filter((a) => !a.dead && a.hp > 0 && a.faction === FACTION.MARINE).length;
    let contactRooms = 0;
    for (let n = 0; n < sim.graph.n; n++) {
      if ((this.liveObs[n] ? this._floodScratch[n] : this.seenFlood[n]) > 0.05 && this.lastSeenT[n] >= 0) contactRooms++;
    }
    const rows = [];
    rows.push(`<div class="mrow mhead"><span>MARINES</span><b>${marinesAlive}/${this.marines0}</b></div>`);
    rows.push(`<div class="mrow mhead"><span>ROOMS W/ CONTACT</span><b>${contactRooms}</b></div>`);
    for (const squad of sim.squads) {
      const members = alive(squad.members);
      const name = squad.id === this.fireteamId ? 'FIRETEAM (YOURS)'
        : squad.patrol ? `PATROL ${squad.patrolNo}` : `SQUAD ${squad.id + 1}`;
      const status = squad.broken ? '<em>BROKEN — scattered</em>'
        : members.length === 0 ? '<em>wiped out</em>' : this._objText(squad);
      rows.push(`<div class="mrow"><span>${name} <b>${members.length}/${squad.size0}</b></span>`
        + `<span class="pips">${pips(members)}</span><div class="obj">${status}</div></div>`);
    }
    const garrison = sim.agents.filter((a) => !a.dead && a.garrison);
    const garrisonAlive = garrison.filter((a) => a.hp > 0);
    if (garrison.length || garrisonAlive.length) {
      rows.push(`<div class="mrow"><span>GARRISON <b>${garrisonAlive.length}</b></span>`
        + `<span class="pips">${pips(garrisonAlive)}</span><div class="obj">holding Command Corridor</div></div>`);
    }
    this.sideEl.innerHTML = rows.join('');
  }

  _objText(squad) {
    const { sim } = this;
    if (squad.pendingSweep) return 'mustering';
    if (squad.order?.kind === 'order:escort') return 'escorting you';
    if (squad.order?.kind === 'order:guard') return `holding ${sim.graph.node(squad.order.node)?.name ?? ''}`;
    const o = squad.objective;
    if (!o) return 'holding position';
    const room = sim.graph.node(o.node)?.name ?? '?';
    const verb = {
      breach: 'sweeping to', distress: 'answering distress —', pursuit: 'pursuing contact —',
      hold: 'holding', order: 'moving —', sweep: 'sweeping —',
    }[o.kind] ?? `${o.kind} —`;
    return `${verb} ${room}`;
  }
}
