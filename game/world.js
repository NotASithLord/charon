// 3D world extruded from the meter-true ship plan (docs/ROADMAP-3D.md §1).
// The sim graph stays authoritative: rooms are their authored w × d rects,
// doors are the sim's computed door points as REAL SLIDING PANELS, and
// cross-deck links are REAL SHAFTS — where two rooms overlap in plan the
// shaft is a true vertical well with hatch holes cut through the deck
// (climb it, look up/down it, shoot through it); offset pairs become
// enclosed stairwell trunks. No teleport pads.

import * as THREE from './vendor/three.module.js';
import { DOORS } from './fps-data.js';
import { RNG } from '../shared/rng.js';

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

// axis-aligned rect minus square holes -> list of rects (for hatched floors).
// A hole may carry its own half-extents (hw, hd) — a grand stairwell cuts a
// much bigger opening than a ladder hatch.
function rectMinusHoles(x0, z0, x1, z1, holes) {
  let rects = [[x0, z0, x1, z1]];
  for (const h of holes) {
    const hw = h.hw ?? HATCH / 2, hd = h.hd ?? HATCH / 2;
    const out = [];
    for (const [a0, b0, a1, b1] of rects) {
      const hx0 = Math.max(a0, h.x - hw), hx1 = Math.min(a1, h.x + hw);
      const hz0 = Math.max(b0, h.z - hd), hz1 = Math.min(b1, h.z + hd);
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
  constructor(scene, graph, seed = 'fx') {
    this.graph = graph;
    this.scene = scene;
    // FLICKERING LIGHTS (user note): every room rolls its light fixture's
    // state ONCE per run from the game seed — steady, breathing, faulty
    // strobe, or dead — so each ship has its own broken places. Unpowered
    // rooms never roll steady. Render-only randomness (own RNG stream).
    this._fxRng = new RNG(String(seed) + ':lights');
    this.roomLights = []; // per node idx: {mat, mode, phase, lvl}
    this.darkVeils = [];  // per node idx: veil mesh (flood-held darkness)
    this.trunks = []; // vertical circulation, see _buildTrunks
    this.doors = [];  // sliding door panels, see _buildDoors
    this.doorEvents = []; // door open starts, drained by the game for audio
    this.props = [];  // cover geometry rects (sim coords) — block walking
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
    this._propMat = new THREE.MeshStandardMaterial({ map: wallTexBase, color: 0x7d8aa5, roughness: 0.8, metalness: 0.45 });
    this._propMatB = new THREE.MeshStandardMaterial({ color: 0x4f5c46, roughness: 0.9, metalness: 0.2 });
    const floorHoles = new Map(); // nodeIdx -> holes in its FLOOR
    const ceilHoles = new Map();  // nodeIdx -> holes in its CEILING
    for (const t of this.trunks) {
      if (!t.vertical) continue;
      const hole = t.stair ? { x: t.stair.holeX, z: t.stair.holeZ, hw: t.stair.hw, hd: t.stair.hd } : { x: t.x, z: t.z };
      (floorHoles.get(t.upperNode) ?? floorHoles.set(t.upperNode, []).get(t.upperNode)).push(hole);
      (ceilHoles.get(t.lowerNode) ?? ceilHoles.set(t.lowerNode, []).get(t.lowerNode)).push(hole);
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
      (this.roomSigns ??= [])[n.idx] = sign;

      // flood-darkness veil: fills the room volume; invisible until the sim
      // says the flood has held the room long enough (updateDarkness)
      {
        const veil = new THREE.Mesh(
          new THREE.BoxGeometry(n.w - 0.1, CLEAR_H - 0.08, n.d - 0.1),
          new THREE.MeshBasicMaterial({
            color: 0x000000, transparent: true, opacity: 0,
            depthWrite: false, side: THREE.FrontSide,
          }));
        veil.position.set(wx, elev + CLEAR_H / 2, wz);
        veil.visible = false;
        veil.renderOrder = 5;
        this.scene.add(veil);
        this.darkVeils[n.idx] = veil;
      }

      // ceiling light strip with a per-run seeded state
      {
        const roll = this._fxRng.next();
        const mode = g.unpowered[n.idx]
          ? (roll < 0.45 ? 'dead' : 'harsh')
          : roll < 0.6 ? 'steady' : roll < 0.78 ? 'soft' : roll < 0.9 ? 'harsh' : 'dead';
        const lmat = new THREE.MeshStandardMaterial({
          color: 0x8fa4c8, emissive: 0xbfd8ff,
          emissiveIntensity: mode === 'dead' ? 0.04 : 1.25, roughness: 0.4, metalness: 0.3,
        });
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(Math.min(3.4, n.w * 0.55), 0.07, 0.55), lmat);
        strip.position.set(wx, elev + CLEAR_H - 0.06, wz);
        this.scene.add(strip);
        this.roomLights[n.idx] = { mat: lmat, mode, phase: this._fxRng.range(0, 20), lvl: mode === 'dead' ? 0.04 : 1 };
      }

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
    this._buildShaftGrates();
    this._buildProps();
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
      if (e.type === 'stairwell' && vertical) {
        this._buildStairwell(e, upper, lower, ox0, ox1, oz0, oz1);
        continue;
      }
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

  // GRAND STAIRWELL (user: Pillar-of-Autumn style) — a two-storey open volume
  // between an upper catwalk and the room below. A straight run of steps
  // descends fore-aft down the overlap column; the upper floor is cut open
  // above it (big hole) with a railing, so you can stand on the catwalk and
  // fire down onto the stairs. Traversal reuses a vertical trunk (L to climb).
  _buildStairwell(e, upper, lower, ox0, ox1, oz0, oz1) {
    const lowElev = elevOf(lower.deck), highElev = elevOf(upper.deck);
    const rise = highElev - lowElev;              // one deck (~4.2 m)
    const wZ = Math.min(3.0, oz1 - oz0);          // athwartships width (the narrow axis)
    const cz = (oz0 + oz1) / 2;
    const runLen = Math.min(9, ox1 - ox0 - 0.5);  // fore-aft length of the flight
    // put the flight toward the fore end of the overlap, landing pad at top
    const x1 = ox1 - 0.5;                          // bottom of the stairs (aft-most)
    const x0 = x1 - runLen;                        // top of the stairs (fore)
    const steps = Math.max(6, Math.round(rise / 0.28));
    const stepRun = runLen / steps, stepRise = rise / steps;
    const matStep = new THREE.MeshStandardMaterial({ color: 0x6c7789, roughness: 0.75, metalness: 0.4 });
    const matRail = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, roughness: 0.5, metalness: 0.7 });
    // steps: from the bottom (lower floor, x1) climbing fore to the top
    for (let i = 0; i < steps; i++) {
      const sx = x1 - (i + 0.5) * stepRun;
      const sy = lowElev + (i + 0.5) * stepRise;
      const tread = new THREE.Mesh(new THREE.BoxGeometry(stepRun + 0.02, 0.14, wZ), matStep);
      tread.position.set(sx, sy, cz);
      this.scene.add(tread);
      // riser face
      const riser = new THREE.Mesh(new THREE.BoxGeometry(0.06, stepRise, wZ), matStep);
      riser.position.set(sx + stepRun / 2, sy - stepRise / 2 + 0.07, cz);
      this.scene.add(riser);
    }
    // side stringers (solid — also stops bodies falling off the sides)
    for (const zz of [cz - wZ / 2 - 0.05, cz + wZ / 2 + 0.05]) {
      const str = new THREE.Mesh(new THREE.BoxGeometry(runLen, 0.5, 0.1), matStep);
      str.position.set((x0 + x1) / 2, lowElev + rise / 2, zz);
      str.rotation.z = Math.atan2(rise, runLen);
      this.scene.add(str);
      this.wallMeshes.push(str);
    }
    // upper catwalk railing around the opening (fore edge + the two sides),
    // aft edge left open so you walk off the catwalk onto the top step
    const railH = 1.0;
    const post = (px, pz) => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, railH, 0.08), matRail);
      p.position.set(px, highElev + railH / 2, pz);
      this.scene.add(p);
    };
    const rail = (px, pz, len, horiz) => {
      const r = new THREE.Mesh(horiz
        ? new THREE.BoxGeometry(len, 0.06, 0.06) : new THREE.BoxGeometry(0.06, 0.06, len), matRail);
      r.position.set(px, highElev + railH, pz);
      this.scene.add(r);
      this.wallMeshes.push(r);
    };
    const oHw = runLen / 2 + 0.3, oHd = wZ / 2 + 0.3, ocx = (x0 + x1) / 2;
    for (const pz of [cz - oHd, cz + oHd]) {           // the two long sides
      rail(ocx, pz, runLen + 0.6, true);
      post(x0 - 0.3, pz); post(x1 + 0.3, pz);
    }
    rail(x0 - 0.3, cz, wZ + 0.6, false);               // fore end rail
    // trunk record: the climb PAD sits on solid floor at the top landing (a
    // little fore of the opening), so the player can reach it to press L; the
    // big floor hole is cut at its own centre (holeX/holeZ + hw/hd).
    const landX = x0 - 0.9;
    this.trunks.push({
      vertical: true, kind: 'stairwell', edge: e, x: landX, z: cz,
      lowerDeck: lower.deck, upperDeck: upper.deck,
      lowerNode: lower.idx, upperNode: upper.idx,
      lowElev, highElev, stair: { holeX: ocx, holeZ: cz, hw: oHw, hd: oHd },
    });
    // block the OPENING for walking on the upper deck (so you don't stroll
    // out onto thin air) — cross it by the stairs/L at the landing. Sim
    // coords: world z -> sim y adds the deck band centre.
    this.props.push({
      deck: upper.deck, x: ocx, y: cz + this.bandCenter(upper.deck),
      hw: oHw - 0.2, hd: oHd - 0.2,
    });
  }

  // ---- sliding doors (user note): panels that open for ANY movement near
  // them and close behind it; locked doors stay shut and read red ----
  // COVER & CLUTTER (review P1): crates, consoles and tables sized to the
  // room's role, hugging the walls so the sim's center-of-room traffic stays
  // clear. Each prop is REAL: it blocks bullets (wallMeshes) and blocks the
  // player's movement (isWalkable via this.props). Placement is a pure hash
  // of the room index — deterministic, no RNG drawn.
  _buildProps() {
    const g = this.graph;
    const KITS = {
      cargo: { n: 5, w: 1.5, h: 1.15 }, maintenance: { n: 3, w: 1.1, h: 1.0 },
      engineering: { n: 3, w: 1.2, h: 1.3 }, power: { n: 3, w: 1.2, h: 1.3 },
      systems: { n: 2, w: 1.1, h: 1.2 }, armory: { n: 2, w: 1.3, h: 1.0 },
      mess: { n: 3, w: 1.4, h: 0.85 }, quarters: { n: 3, w: 1.0, h: 0.6 },
      hangar: { n: 4, w: 1.7, h: 1.3 }, medbay: { n: 2, w: 1.1, h: 0.85 },
      vehicles: { n: 3, w: 1.6, h: 1.2 },
    };
    for (const n of g.nodes) {
      if (n.type === 'corridor') continue;
      const kit = Object.keys(KITS).find((k) => n.roles.includes(k));
      if (!kit) continue;
      const { n: count, w: pw, h: ph } = KITS[kit];
      const h0 = (n.idx * 2654435761) >>> 0;
      const [wx, wz] = this.simToWorld(n.x, n.y, n.deck);
      const elev = elevOf(n.deck);
      for (let i = 0; i < count; i++) {
        const hh = (h0 ^ (i * 40503)) >>> 0;
        // wall-hugging slots: walk the perimeter, skip spots near doors
        const side = (hh >>> 2) % 4;
        const t = 0.18 + ((hh >>> 6) % 100) / 156; // 0.18..0.82 along the wall
        const inset = pw / 2 + 0.3;
        let px, pz;
        if (side === 0) { px = wx - n.w / 2 + inset; pz = wz - n.d / 2 + n.d * t; }
        else if (side === 1) { px = wx + n.w / 2 - inset; pz = wz - n.d / 2 + n.d * t; }
        else if (side === 2) { px = wx - n.w / 2 + n.w * t; pz = wz - n.d / 2 + inset; }
        else { px = wx - n.w / 2 + n.w * t; pz = wz + n.d / 2 - inset; }
        // keep clear of door throats (sim coords test)
        const [sx, sy] = this.worldToSim(px, pz, n.deck);
        let nearDoor = false;
        for (const e of g.edges) {
          if (!e.door || (e.a !== n.idx && e.b !== n.idx)) continue;
          if (Math.hypot(e.door.x - sx, e.door.y - sy) < pw / 2 + 1.6) { nearDoor = true; break; }
        }
        if (nearDoor) continue;
        const depth = pw * (0.7 + ((hh >>> 9) % 40) / 100);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, depth),
          (hh & 1) ? this._propMat : this._propMatB);
        mesh.position.set(px, elev + ph / 2, pz);
        mesh.rotation.y = ((hh >>> 4) % 4) * 0.04 - 0.06; // slightly askew
        this.scene.add(mesh);
        this.wallMeshes.push(mesh); // bullets stop on cover
        this.props.push({ deck: n.deck, x: sx, y: sy, hw: pw / 2 + 0.18, hd: depth / 2 + 0.18 });
      }
    }
  }

  _buildDoors() {
    const g = this.graph;
    for (const e of g.edges) {
      if (!e.door) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck) continue;
      const deck = a.deck, elev = elevOf(deck);
      const [dx, dz] = this.simToWorld(e.door.x, e.door.y, deck);
      // PANEL LIES ALONG ITS WALL (user report: doors turned 90°). The old
      // room-center-delta guess breaks whenever a room sits offset along a
      // long corridor — the real answer is which axis the two footprints
      // actually overlap on (that's the axis the shared wall runs along).
      // Throat doors face down the throat instead.
      let phi; // long-axis direction of the panel, radians in sim space
      if (e.doorA && e.doorB && !e.shared) {
        phi = Math.atan2(e.doorB.y - e.doorA.y, e.doorB.x - e.doorA.x) + Math.PI / 2;
      } else {
        const xov = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const yov = Math.min(a.y + a.d / 2, b.y + b.d / 2) - Math.max(a.y - a.d / 2, b.y - b.d / 2);
        phi = xov >= yov ? 0 : Math.PI / 2;
      }
      const mat = new THREE.MeshStandardMaterial({
        color: e.locked ? 0x7a2723 : 0x55637d,
        emissive: e.locked ? 0xa03020 : 0x101820,
        emissiveIntensity: e.locked ? 0.7 : 0.4,
        roughness: 0.5, metalness: 0.6,
      });
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(DOOR_W + 0.1, CLEAR_H - 0.15, 0.14), mat);
      panel.rotation.y = -phi; // sim direction (cos phi, sin phi) -> world x/z
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

  // MAINTENANCE SHAFT ACCESS (user report: the shaft connections were
  // invisible — nothing in the world marked where the between-deck ducts
  // begin and end): every shaft mouth gets a floor grate with a warning
  // rim. The crawlers themselves are hidden while inside (agents3d).
  _buildShaftGrates() {
    const g = this.graph;
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 0.9, metalness: 0.35 });
    const slatMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.7, metalness: 0.5 });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x2a2416, emissive: 0xc09030, emissiveIntensity: 0.5, roughness: 0.6,
    });
    for (const s of g.shafts) {
      for (const [na, nb] of [[s.a, s.b], [s.b, s.a]]) {
        const n = g.node(na), other = g.node(nb);
        // toward the far end, clamped inside the room and off the walls
        const dx = other.x - n.x, dy = other.y - n.y;
        const L = Math.hypot(dx, dy) || 1;
        const px = Math.max(n.x - n.w / 2 + 1.1, Math.min(n.x + n.w / 2 - 1.1, n.x + (dx / L) * (n.w / 2 - 1.1)));
        const py = Math.max(n.y - n.d / 2 + 1.1, Math.min(n.y + n.d / 2 - 1.1, n.y + (dy / L) * (n.d / 2 - 1.1)));
        const [wx, wz] = this.simToWorld(px, py, n.deck);
        const elev = elevOf(n.deck);
        const rim = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 1.5), rimMat);
        rim.position.set(wx, elev + 0.02, wz);
        const plate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.07, 1.3), plateMat);
        plate.position.set(wx, elev + 0.045, wz);
        this.scene.add(rim, plate);
        for (let k = -2; k <= 2; k++) {
          const slat = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.03, 0.12), slatMat);
          slat.position.set(wx, elev + 0.09, wz + k * 0.24);
          this.scene.add(slat);
        }
      }
    }
  }

  // called by main each frame with positions of things that move
  // current light level of a room, 0..1 (drives its fixture AND the player's
  // lamp when standing in it)
  lightLevel(idx) {
    return this.roomLights[idx]?.lvl ?? 1;
  }

  updateLights(t) {
    for (const L of this.roomLights) {
      if (!L) continue;
      if (L.mode === 'steady') { L.lvl = 1; continue; }
      if (L.mode === 'dead') { L.lvl = 0.04; continue; }
      if (L.mode === 'soft') {
        L.lvl = 0.72 + 0.28 * Math.sin(t * 1.7 + L.phase) * Math.sin(t * 0.9 + L.phase * 2);
      } else { // harsh: strobing dropouts
        const s = Math.sin(t * 13 + L.phase) * Math.sin(t * 7.3 + L.phase * 1.7);
        L.lvl = s > -0.25 ? 0.55 + 0.45 * Math.abs(s) : 0.05;
      }
      L.mat.emissiveIntensity = 1.25 * L.lvl;
    }
  }

  // drive the veils + room fixtures from the sim's darkness clocks. The
  // player's own room is exempted from its veil (interior darkness is done
  // with real lights by the game) — you see INTO held rooms as black murk.
  updateDarkness(sim, playerNode, dt) {
    for (let n = 0; n < sim.graph.n; n++) {
      const veil = this.darkVeils[n];
      if (!veil) continue;
      const fog = sim.fogAt(n);
      const target = n === playerNode ? 0 : sim.darkAt(n) ? (fog ? 0.96 : 0.88) : 0;
      const m = veil.material;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 2.5);
      veil.visible = m.opacity > 0.03;
      // spore fog reads green-brown, plain darkness reads black
      m.color.setHex(fog ? 0x18200c : 0x000000);
      // an overgrown room's fixture dies with it — and its sign fades into
      // the dark instead of glowing through the murk
      const L = this.roomLights[n];
      if (L && sim.darkAt(n)) { L.lvl = 0.02; L.mat.emissiveIntensity = 0.02; }
      const sign = this.roomSigns?.[n];
      if (sign) sign.material.opacity = sim.darkAt(n) ? 0.06 : 0.95;
    }
  }

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
      const was = d.open01;
      d.open01 += Math.sign(want - d.open01) * Math.min(Math.abs(want - d.open01), rate * dt);
      // report open/close starts so the game can voice the hiss
      if (was <= 0.03 && d.open01 > 0.03) this.doorEvents.push({ x: d.x, z: d.z, deck: d.deck });
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

  // cover props block the player (checked separately so door throats above
  // can still grant passage through walls)
  propBlocked(deck, sx, sy) {
    for (const p of this.props) {
      if (p.deck !== deck) continue;
      if (Math.abs(sx - p.x) < p.hw && Math.abs(sy - p.y) < p.hd) return true;
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
