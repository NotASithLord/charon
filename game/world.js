// 3D world extruded from the meter-true ship plan (docs/ROADMAP-3D.md §1).
// The sim graph stays authoritative: rooms are their authored w × d rects,
// doors are the sim's computed door points as REAL SLIDING PANELS, and
// cross-deck links are REAL SHAFTS — where two rooms overlap in plan the
// shaft is a true vertical well with hatch holes cut through the deck
// (climb it, look up/down it, shoot through it); offset pairs become
// enclosed stairwell trunks. No teleport pads.

import * as THREE from './vendor/three.module.js';
import { DOORS } from './fps-data.js';

export const DECK_H = 4.2;      // deck-to-deck (matches ship data)
export const CLEAR_H = 3.0;     // floor-to-ceiling clear height
export const DOOR_W = 1.7;      // doorway opening width
const WALL_T = 0.16;
const HATCH = 1.8;              // hatch hole side

export function elevOf(deck) { return (5 - deck) * DECK_H; }

function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2));
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

// axis-aligned rect minus square holes -> list of rects (for hatched floors)
function rectMinusHoles(x0, z0, x1, z1, holes) {
  let rects = [[x0, z0, x1, z1]];
  for (const h of holes) {
    const out = [];
    for (const [a0, b0, a1, b1] of rects) {
      const hx0 = Math.max(a0, h.x - HATCH / 2), hx1 = Math.min(a1, h.x + HATCH / 2);
      const hz0 = Math.max(b0, h.z - HATCH / 2), hz1 = Math.min(b1, h.z + HATCH / 2);
      if (hx0 >= hx1 || hz0 >= hz1) { out.push([a0, b0, a1, b1]); continue; }
      if (a0 < hx0) out.push([a0, b0, hx0, b1]);
      if (hx1 < a1) out.push([hx1, b0, a1, b1]);
      if (b0 < hz0) out.push([hx0, b0, hx1, hz0]);
      if (hz1 < b1) out.push([hx0, hz1, hx1, b1]);
    }
    rects = out;
  }
  return rects;
}

export class World {
  constructor(scene, graph) {
    this.graph = graph;
    this.scene = scene;
    this.trunks = []; // vertical circulation, see _buildTrunks
    this.doors = [];  // sliding door panels, see _buildDoors
    this.wallMeshes = []; // solid vertical geometry — raycast target for "real physics" shots (user note)
    this._bandC = graph.deckBands.map((b) => (b.y0 + b.y1) / 2);
    this._build();
  }

  bandCenter(deck) { return this._bandC[deck - 1]; }
  simToWorld(sx, sy, deck) { return [sx, sy - this.bandCenter(deck)]; }
  worldToSim(wx, wz, deck) { return [wx, wz + this.bandCenter(deck)]; }

  _panelTex(base, line, cell = 64) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = base; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = line; x.lineWidth = 2;
    for (let i = 0; i <= 256; i += cell) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke();
      x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke();
    }
    x.fillStyle = line;
    for (let i = cell / 2; i < 256; i += cell) for (let j = cell / 2; j < 256; j += cell) {
      x.beginPath(); x.arc(i, j, 2.4, 0, Math.PI * 2); x.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _label(text) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(8, 12, 18, 0.85)'; x.fillRect(0, 0, 512, 96);
    x.strokeStyle = '#31435f'; x.lineWidth = 4; x.strokeRect(2, 2, 508, 92);
    x.fillStyle = '#9fc3ef'; x.font = '600 44px monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text.toUpperCase(), 256, 50);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.95 }));
    spr.scale.set(4.6, 0.86, 1);
    return spr;
  }

  _build() {
    const g = this.graph;
    const floorTexBase = this._panelTex('#242c3a', '#181f2b');
    const wallTexBase = this._panelTex('#3a465c', '#2a3446', 128);
    const mkFloorMat = (w, d, tint) => {
      const tex = floorTexBase.clone();
      tex.needsUpdate = true;
      tex.repeat.set(Math.max(1, w / 4), Math.max(1, d / 4));
      return new THREE.MeshStandardMaterial({ map: tex, color: tint, roughness: 0.85, metalness: 0.35 });
    };
    this._matWall = new THREE.MeshStandardMaterial({ map: wallTexBase, color: 0xaebdd8, roughness: 0.7, metalness: 0.5 });
    const matWall = this._matWall;
    const matCeil = new THREE.MeshStandardMaterial({ color: 0x141a26, emissive: 0x2a3a58, emissiveIntensity: 0.35, roughness: 1, side: THREE.DoubleSide });

    // ---- vertical circulation first (its hatches cut the decks) ----
    this._buildTrunks();
    const floorHoles = new Map(); // nodeIdx -> holes in its FLOOR
    const ceilHoles = new Map();  // nodeIdx -> holes in its CEILING
    for (const t of this.trunks) {
      if (!t.vertical) continue;
      (floorHoles.get(t.upperNode) ?? floorHoles.set(t.upperNode, []).get(t.upperNode)).push({ x: t.x, z: t.z });
      (ceilHoles.get(t.lowerNode) ?? ceilHoles.set(t.lowerNode, []).get(t.lowerNode)).push({ x: t.x, z: t.z });
    }

    for (const n of g.nodes) {
      const deck = n.deck, elev = elevOf(deck);
      const [wx, wz] = this.simToWorld(n.x, n.y, deck);
      const isBreach = n.idx === g.breachNode;
      const tint = isBreach ? 0xff8866 : g.unpowered[n.idx] ? 0x4a5261 : (n.type === 'corridor' ? 0xbccbe4 : 0x9daabf);
      const fmat = mkFloorMat(n.w, n.d, tint);

      // floor + ceiling with hatch holes where shafts pierce them
      const fh = floorHoles.get(n.idx) ?? [];
      for (const [a0, b0, a1, b1] of rectMinusHoles(wx - n.w / 2, wz - n.d / 2, wx + n.w / 2, wz + n.d / 2, fh)) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, 0.12, b1 - b0), fmat);
        slab.position.set((a0 + a1) / 2, elev - 0.06, (b0 + b1) / 2);
        this.scene.add(slab);
      }
      const ch = ceilHoles.get(n.idx) ?? [];
      for (const [a0, b0, a1, b1] of rectMinusHoles(wx - n.w / 2, wz - n.d / 2, wx + n.w / 2, wz + n.d / 2, ch)) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, 0.1, b1 - b0), matCeil);
        slab.position.set((a0 + a1) / 2, elev + CLEAR_H, (b0 + b1) / 2);
        this.scene.add(slab);
      }
      const sign = this._label(n.name);
      sign.position.set(wx, elev + CLEAR_H - 0.45, wz);
      this.scene.add(sign);

      // walls with door openings, inset half a thickness (no z-fighting)
      const sides = { N: [], S: [], W: [], E: [] };
      for (const e of g.edges) {
        if (!e.door) continue;
        if (e.a !== n.idx && e.b !== n.idx) continue;
        const other = g.node(e.a === n.idx ? e.b : e.a);
        if (other.deck !== deck) continue;
        const [dx, dz] = this.simToWorld(e.door.x, e.door.y, deck);
        const dN = Math.abs((wz - n.d / 2) - dz), dS = Math.abs((wz + n.d / 2) - dz);
        const dW = Math.abs((wx - n.w / 2) - dx), dE = Math.abs((wx + n.w / 2) - dx);
        const m = Math.min(dN, dS, dW, dE);
        if (m === dN) sides.N.push({ at: dx, edge: e });
        else if (m === dS) sides.S.push({ at: dx, edge: e });
        else if (m === dW) sides.W.push({ at: dz, edge: e });
        else sides.E.push({ at: dz, edge: e });
      }
      const wi = WALL_T / 2;
      const wallRuns = [
        { key: 'N', horiz: true, fixed: wz - n.d / 2 + wi, from: wx - n.w / 2, to: wx + n.w / 2 },
        { key: 'S', horiz: true, fixed: wz + n.d / 2 - wi, from: wx - n.w / 2, to: wx + n.w / 2 },
        { key: 'W', horiz: false, fixed: wx - n.w / 2 + wi, from: wz - n.d / 2, to: wz + n.d / 2 },
        { key: 'E', horiz: false, fixed: wx + n.w / 2 - wi, from: wz - n.d / 2, to: wz + n.d / 2 },
      ];
      for (const run of wallRuns) {
        const cuts = sides[run.key]
          .map((c) => ({ ...c, at: Math.max(run.from + DOOR_W / 2 + 0.2, Math.min(run.to - DOOR_W / 2 - 0.2, c.at)) }))
          .sort((a, b) => a.at - b.at);
        let cursor = run.from;
        const spans = [];
        for (const c of cuts) {
          const a = c.at - DOOR_W / 2;
          if (a > cursor + 0.05) spans.push([cursor, a]);
          cursor = Math.max(cursor, c.at + DOOR_W / 2);
        }
        if (run.to > cursor + 0.05) spans.push([cursor, run.to]);
        for (const [a, b] of spans) {
          const len = b - a;
          const wall = new THREE.Mesh(
            run.horiz ? new THREE.BoxGeometry(len, CLEAR_H, WALL_T) : new THREE.BoxGeometry(WALL_T, CLEAR_H, len),
            matWall);
          if (run.horiz) wall.position.set((a + b) / 2, elev + CLEAR_H / 2, run.fixed);
          else wall.position.set(run.fixed, elev + CLEAR_H / 2, (a + b) / 2);
          this.scene.add(wall);
          this.wallMeshes.push(wall);
        }
      }
    }

    // doorway throats between non-flush spaces
    for (const e of g.edges) {
      if (!e.door || !e.doorA || e.shared) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck) continue;
      const deck = a.deck, elev = elevOf(deck);
      const [ax, az] = this.simToWorld(e.doorA.x, e.doorA.y, deck);
      const [bx, bz] = this.simToWorld(e.doorB.x, e.doorB.y, deck);
      const dx = bx - ax, dz = bz - az;
      const len = Math.max(0.6, Math.hypot(dx, dz)) + 0.5;
      const cx = (ax + bx) / 2, cz = (az + bz) / 2;
      const ang = -Math.atan2(dz, dx);
      const hl = Math.max(0.001, Math.hypot(dx, dz));
      const px = -dz / hl, pz = dx / hl;
      const mk = (geo, mat, ox, oy, oz, solid) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(cx + ox, elev + oy, cz + oz);
        m.rotation.y = ang;
        this.scene.add(m);
        if (solid) this.wallMeshes.push(m);
      };
      mk(new THREE.BoxGeometry(len, 0.12, DOOR_W), matWall, 0, -0.06, 0, false);
      mk(new THREE.BoxGeometry(len, 0.12, DOOR_W), matCeil, 0, CLEAR_H - 0.25, 0, false);
      mk(new THREE.BoxGeometry(len, CLEAR_H, 0.12), matWall, px * DOOR_W / 2, CLEAR_H / 2, pz * DOOR_W / 2, true);
      mk(new THREE.BoxGeometry(len, CLEAR_H, 0.12), matWall, -px * DOOR_W / 2, CLEAR_H / 2, -pz * DOOR_W / 2, true);
    }

    this._buildDoors();
  }

  // ---- REAL SHAFTS (user note: the portal mechanisms end here) ----
  // A cross-deck link whose two rooms overlap in plan gets ONE true vertical
  // well: hatch through the deck, ladder rungs, open line of sight/fire.
  // Offset rooms get an enclosed stairwell trunk at each end instead.
  _buildTrunks() {
    const g = this.graph;
    // KEEP CLEAR OF THE DOORWAYS (user note): a ladder well parked right in
    // front of a door makes no sense. Candidate spots are scored by clearance
    // from every door opening of the rooms the trunk pierces, and the best
    // clear spot wins (with a mild pull toward the natural position).
    const doorPts = (roomIdx, deck) => {
      const pts = [];
      for (const l of g.edges) {
        if (l.a !== roomIdx && l.b !== roomIdx) continue;
        if (g.node(l.a).deck !== g.node(l.b).deck) continue;
        const d = (l.a === roomIdx ? l.doorA : l.doorB) ?? l.door;
        if (!d) continue;
        const [dx, dz] = this.simToWorld(d.x, d.y, deck);
        pts.push([dx, dz]);
      }
      return pts;
    };
    const pickSpot = (x0, x1, z0, z1, pts, prefX, prefZ, prefW = 0.1) => {
      let bx = (x0 + x1) / 2, bz = (z0 + z1) / 2, bestScore = -Infinity;
      const N = 6;
      for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
        const cx = x0 + (x1 - x0) * i / N, cz = z0 + (z1 - z0) * j / N;
        let dMin = Infinity;
        for (const [qx, qz] of pts) dMin = Math.min(dMin, Math.hypot(cx - qx, cz - qz));
        const score = Math.min(dMin, 6) - Math.hypot(cx - prefX, cz - prefZ) * prefW;
        if (score > bestScore + 1e-9) { bestScore = score; bx = cx; bz = cz; }
      }
      return [bx, bz];
    };
    const matLadder = new THREE.MeshStandardMaterial({ color: 0x8a97a8, roughness: 0.5, metalness: 0.7 });
    const matCollar = (lift) => new THREE.MeshStandardMaterial({
      color: lift ? 0x1e4b56 : 0x54401e,
      emissive: lift ? 0x2fd7f0 : 0xf0a52f, emissiveIntensity: 0.55,
    });
    for (const e of g.edges) {
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck === b.deck) continue;
      const upper = a.deck < b.deck ? a : b; // smaller deck number = higher elevation
      const lower = a.deck < b.deck ? b : a;
      const [uax, uaz] = this.simToWorld(upper.x, upper.y, upper.deck);
      const [lbx, lbz] = this.simToWorld(lower.x, lower.y, lower.deck);
      const ox0 = Math.max(uax - upper.w / 2, lbx - lower.w / 2) + 1.1;
      const ox1 = Math.min(uax + upper.w / 2, lbx + lower.w / 2) - 1.1;
      const oz0 = Math.max(uaz - upper.d / 2, lbz - lower.d / 2) + 1.1;
      const oz1 = Math.min(uaz + upper.d / 2, lbz + lower.d / 2) - 1.1;
      const vertical = ox1 - ox0 >= 0.2 && oz1 - oz0 >= 0.2;
      const lift = e.type === 'lift';
      if (vertical) {
        const [x, z] = pickSpot(ox0, ox1, oz0, oz1,
          [...doorPts(lower.idx, lower.deck), ...doorPts(upper.idx, upper.deck)],
          (ox0 + ox1) / 2, (oz0 + oz1) / 2);
        const lowElev = elevOf(lower.deck), highElev = elevOf(upper.deck);
        this.trunks.push({
          vertical: true, kind: e.type, edge: e, x, z,
          lowerDeck: lower.deck, upperDeck: upper.deck,
          lowerNode: lower.idx, upperNode: upper.idx,
          lowElev, highElev,
        });
        // hatch collars top and bottom + ladder rungs up one side
        for (const [elev, ny] of [[lowElev, lowElev + 0.02], [highElev, highElev + 0.02]]) {
          const collar = new THREE.Mesh(new THREE.BoxGeometry(HATCH + 0.5, 0.08, HATCH + 0.5), matCollar(lift));
          collar.position.set(x, ny, z);
          this.scene.add(collar);
        }
        const runN = Math.floor((highElev - lowElev) / 0.38);
        for (let i = 0; i <= runN; i++) {
          const rung = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.07), matLadder);
          rung.position.set(x, lowElev + 0.3 + i * 0.38, z - HATCH / 2 + 0.1);
          this.scene.add(rung);
        }
        // shaft lining between decks (four thin walls through the structure)
        const linH = highElev - lowElev - CLEAR_H;
        if (linH > 0.05) {
          for (const [ox, oz, w, d] of [
            [0, -HATCH / 2, HATCH, 0.08], [0, HATCH / 2, HATCH, 0.08],
            [-HATCH / 2, 0, 0.08, HATCH], [HATCH / 2, 0, 0.08, HATCH]]) {
            const lin = new THREE.Mesh(new THREE.BoxGeometry(w, linH, d), this._matWall ?? matLadder);
            lin.position.set(x + ox, lowElev + CLEAR_H + linH / 2, z + oz);
            this.scene.add(lin);
          }
        }
      } else {
        // enclosed stairwell: a trunk at each end; climbing one delivers you
        // to the other (a switchback landing you can't see through)
        const mk = (n, other, deck) => {
          const [nx, nz] = this.simToWorld(n.x, n.y, n.deck);
          const [ox2] = this.simToWorld(other.x, other.y, other.deck);
          const px = Math.max(nx - n.w / 2 + 1.2, Math.min(nx + n.w / 2 - 1.2, ox2));
          const [sx, sz] = pickSpot(
            nx - n.w / 2 + 1.2, nx + n.w / 2 - 1.2,
            nz - n.d / 2 + 1.2, nz + n.d / 2 - 1.2,
            doorPts(n.idx, n.deck), px, nz, 0.08);
          return { x: sx, z: sz, deck: n.deck, node: n.idx };
        };
        const pu = mk(upper, lower), pl = mk(lower, upper);
        const rec = {
          vertical: false, kind: e.type, edge: e,
          lowerDeck: lower.deck, upperDeck: upper.deck,
          lowerNode: lower.idx, upperNode: upper.idx,
          lowElev: elevOf(lower.deck), highElev: elevOf(upper.deck),
          low: pl, high: pu,
        };
        this.trunks.push(rec);
        for (const p of [pl, pu]) {
          const well = new THREE.Mesh(
            new THREE.CylinderGeometry(0.95, 0.95, CLEAR_H, 14, 1, true),
            new THREE.MeshStandardMaterial({
              color: lift ? 0x2fd7f0 : 0xf0a52f,
              emissive: lift ? 0x1a7b8a : 0x8a5c1a, emissiveIntensity: 0.5,
              transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
            }));
          well.position.set(p.x, elevOf(p.deck) + CLEAR_H / 2, p.z);
          this.scene.add(well);
          const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.07, 16), matCollar(lift));
          collar.position.set(p.x, elevOf(p.deck) + 0.035, p.z);
          this.scene.add(collar);
        }
      }
    }
  }

  // ---- sliding doors (user note): panels that open for ANY movement near
  // them and close behind it; locked doors stay shut and read red ----
  _buildDoors() {
    const g = this.graph;
    for (const e of g.edges) {
      if (!e.door) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck) continue;
      const deck = a.deck, elev = elevOf(deck);
      const [dx, dz] = this.simToWorld(e.door.x, e.door.y, deck);
      const horizWall = Math.abs(a.y - b.y) >= Math.abs(a.x - b.x);
      const mat = new THREE.MeshStandardMaterial({
        color: e.locked ? 0x7a2723 : 0x55637d,
        emissive: e.locked ? 0xa03020 : 0x101820,
        emissiveIntensity: e.locked ? 0.7 : 0.4,
        roughness: 0.5, metalness: 0.6,
      });
      const panel = new THREE.Mesh(
        horizWall ? new THREE.BoxGeometry(DOOR_W + 0.1, CLEAR_H - 0.15, 0.14)
          : new THREE.BoxGeometry(0.14, CLEAR_H - 0.15, DOOR_W + 0.1),
        mat);
      panel.position.set(dx, elev + (CLEAR_H - 0.15) / 2, dz);
      this.scene.add(panel);
      this.doors.push({
        edge: e, mesh: panel, deck,
        x: dx, z: dz,
        closedY: elev + (CLEAR_H - 0.15) / 2,
        open01: 0, // slides UP into the frame
      });
    }
  }

  // called by main each frame with positions of things that move
  updateDoors(dt, movers) {
    const r2 = DOORS.openRadius * DOORS.openRadius;
    for (const d of this.doors) {
      let want = 0;
      if (!d.edge.locked) {
        for (const m of movers) {
          if (m.deck !== d.deck) continue;
          const ddx = m.x - d.x, ddz = m.z - d.z;
          if (ddx * ddx + ddz * ddz < r2) { want = 1; break; }
        }
      }
      const rate = DOORS.slideSpeed / (CLEAR_H - 0.3);
      d.open01 += Math.sign(want - d.open01) * Math.min(Math.abs(want - d.open01), rate * dt);
      d.mesh.position.y = d.closedY + d.open01 * (CLEAR_H - 0.35);
      d.mesh.visible = d.open01 < 0.97;
    }
  }

  // --- walkability, in sim coords per deck (doors handled by their panels;
  // the throat is passable — a closed unlocked door opens as you reach it) ---
  isWalkable(deck, sx, sy) {
    const g = this.graph;
    for (const n of g.nodes) {
      if (n.deck !== deck) continue;
      const m = 0.35;
      if (sx > n.x - n.w / 2 + m && sx < n.x + n.w / 2 - m
        && sy > n.y - n.d / 2 + m && sy < n.y + n.d / 2 - m) return true;
    }
    for (const e of g.edges) {
      if (!e.door || e.locked) continue;
      const a = g.node(e.a);
      if (a.deck !== deck) continue;
      if (segDist2(sx, sy, e.doorA.x, e.doorA.y, e.doorB.x, e.doorB.y) < 0.85 * 0.85) return true;
    }
    return false;
  }

  roomAt(deck, sx, sy, fallback = -1) {
    const g = this.graph;
    let best = fallback, bestD = Infinity;
    for (const n of g.nodes) {
      if (n.deck !== deck) continue;
      const inX = sx > n.x - n.w / 2 - 0.6 && sx < n.x + n.w / 2 + 0.6;
      const inY = sy > n.y - n.d / 2 - 0.6 && sy < n.y + n.d / 2 + 0.6;
      if (inX && inY) return n.idx;
      const d = (sx - n.x) * (sx - n.x) + (sy - n.y) * (sy - n.y);
      if (d < bestD) { bestD = d; best = n.idx; }
    }
    return best;
  }

  // the trunk (if any) whose column contains this world position on `deck`
  trunkAt(deck, wx, wz) {
    for (const t of this.trunks) {
      if (t.vertical) {
        if (deck !== t.lowerDeck && deck !== t.upperDeck) continue;
        const dx = wx - t.x, dz = wz - t.z;
        if (dx * dx + dz * dz < 1.3 * 1.3) return t;
      } else {
        const p = deck === t.lowerDeck ? t.low : deck === t.upperDeck ? t.high : null;
        if (!p) continue;
        const dx = wx - p.x, dz = wz - p.z;
        if (dx * dx + dz * dz < 1.15 * 1.15) return t;
      }
    }
    return null;
  }
}
