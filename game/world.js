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
import { DECK_H, CLEAR_H, elevOf, clearHeightOf } from '../shared/geometry.js';

// Deck stacking + per-room clear height live in shared/geometry.js so the
// render and the deterministic sim (leap peak) read ONE source. Re-exported
// here because player.js / main.js / agents3d.js import them from world.js.
export { DECK_H, CLEAR_H, elevOf, clearHeightOf };

export const DOOR_W = 1.7;      // doorway opening width
const WALL_T = 0.16;
const HATCH = 1.8;              // hatch hole side

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

  // Oriented collision boxes for the Rapier physics world (physics/physics-
  // world.js). Every solid vertical surface the player must not cross — walls,
  // doorway throats, cover props, and the grand-stair spine/rails, all of
  // which the builder already collected in `wallMeshes` — plus LOCKED door
  // panels (unlocked panels slide open as you approach, so they never need to
  // collide). Boxes are axis-aligned cuboids rotated about Y only, which is
  // exactly how every one of these was built (no pitch/roll anywhere).
  // Floors/ceilings are deliberately NOT here: vertical motion stays analytic
  // (groundHeightAt + gravity), and full-height wall boxes are all a
  // horizontal swept-capsule needs. why: sourcing the colliders from the SAME
  // meshes the player sees means physics can never drift from the render.
  collisionBoxes() {
    const box = (m) => {
      const p = m.geometry.parameters;
      return {
        cx: m.position.x, cy: m.position.y, cz: m.position.z,
        hx: p.width / 2, hy: p.height / 2, hz: p.depth / 2,
        ry: m.rotation.y || 0,
      };
    };
    const out = this.wallMeshes.map(box);
    for (const d of this.doors) if (d.edge.locked) out.push(box(d.mesh));
    return out;
  }

  // DECK PLATING (texture pass): worn steel plates — per-plate value drift,
  // corner rivets, scuff scratches, grime pools, and the odd hazard-striped
  // plate edge. Seeded PRNG so every boot bakes the same ship.
  _deckTex(base, line, seed = 7) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const x = c.getContext('2d');
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    x.fillStyle = base; x.fillRect(0, 0, 512, 512);
    const cell = 128;
    for (let px = 0; px < 512; px += cell) for (let py = 0; py < 512; py += cell) {
      // plate value drift
      const v = (rnd() - 0.5) * 26;
      x.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
      x.fillRect(px + 2, py + 2, cell - 4, cell - 4);
      // rivets at the corners
      x.fillStyle = 'rgba(8,10,14,0.8)';
      for (const [ox, oy] of [[10, 10], [cell - 10, 10], [10, cell - 10], [cell - 10, cell - 10]]) {
        x.beginPath(); x.arc(px + ox, py + oy, 3, 0, Math.PI * 2); x.fill();
      }
      // occasional hazard edge stripe (a lift plate, a stow lane)
      if (rnd() < 0.12) {
        x.save();
        x.strokeStyle = 'rgba(180,150,40,0.28)'; x.lineWidth = 6;
        x.setLineDash([14, 12]);
        x.beginPath(); x.moveTo(px + 4, py + cell - 8); x.lineTo(px + cell - 4, py + cell - 8); x.stroke();
        x.restore();
      }
    }
    // plate seams
    x.strokeStyle = line; x.lineWidth = 3;
    for (let i = 0; i <= 512; i += cell) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke();
      x.beginPath(); x.moveTo(0, i); x.lineTo(512, i); x.stroke();
    }
    // scuffs: long faint scratches with traffic
    for (let i = 0; i < 46; i++) {
      const sx0 = rnd() * 512, sy0 = rnd() * 512, ang = rnd() * Math.PI, len = 30 + rnd() * 120;
      x.strokeStyle = `rgba(${rnd() < 0.5 ? '210,220,235' : '10,12,16'},${0.05 + rnd() * 0.1})`;
      x.lineWidth = 1 + rnd() * 1.5;
      x.beginPath(); x.moveTo(sx0, sy0);
      x.lineTo(sx0 + Math.cos(ang) * len, sy0 + Math.sin(ang) * len); x.stroke();
    }
    // grime pools
    for (let i = 0; i < 22; i++) {
      const gx = rnd() * 512, gy = rnd() * 512, r = 12 + rnd() * 42;
      const grad = x.createRadialGradient(gx, gy, 2, gx, gy, r);
      grad.addColorStop(0, `rgba(6,8,10,${0.1 + rnd() * 0.14})`);
      grad.addColorStop(1, 'rgba(6,8,10,0)');
      x.fillStyle = grad;
      x.beginPath(); x.arc(gx, gy, r, 0, Math.PI * 2); x.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // WALL PANELING (texture pass): staggered panel bands with seam shadows,
  // conduit runs, vent grilles, warning placards and rust weeps — the
  // corridor walls stop reading as flat grid wallpaper.
  _wallTex(base, line, seed = 13) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const x = c.getContext('2d');
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    x.fillStyle = base; x.fillRect(0, 0, 512, 512);
    // horizontal bands of staggered panels
    const bandH = 128;
    for (let by = 0, row = 0; by < 512; by += bandH, row++) {
      const off = (row % 2) * 96;
      for (let bx = -off; bx < 512; bx += 192) {
        const v = (rnd() - 0.5) * 20;
        x.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
        x.fillRect(bx + 2, by + 2, 188, bandH - 4);
        // panel bolts
        x.fillStyle = 'rgba(10,12,18,0.7)';
        for (const [ox, oy] of [[10, 12], [182, 12], [10, bandH - 12], [182, bandH - 12]]) {
          x.beginPath(); x.arc(bx + ox, by + oy, 2.4, 0, Math.PI * 2); x.fill();
        }
        const roll = rnd();
        if (roll < 0.16) { // vent grille
          x.fillStyle = 'rgba(8,10,14,0.55)';
          for (let k = 0; k < 5; k++) x.fillRect(bx + 60, by + 34 + k * 12, 70, 5);
        } else if (roll < 0.26) { // warning placard
          x.fillStyle = 'rgba(160,130,30,0.35)';
          x.fillRect(bx + 76, by + 44, 40, 26);
          x.strokeStyle = 'rgba(20,20,20,0.5)'; x.lineWidth = 2;
          x.strokeRect(bx + 76, by + 44, 40, 26);
        }
      }
      // band seam shadow
      x.fillStyle = 'rgba(5,7,10,0.5)';
      x.fillRect(0, by, 512, 3);
    }
    // conduit runs: two thin pipes across the sheet
    for (const cy of [88, 344]) {
      x.fillStyle = 'rgba(20,26,36,0.85)';
      x.fillRect(0, cy, 512, 7);
      x.fillStyle = 'rgba(120,135,160,0.35)';
      x.fillRect(0, cy, 512, 2);
      for (let bx2 = 24; bx2 < 512; bx2 += 96) { // pipe clamps
        x.fillStyle = 'rgba(50,58,72,0.9)';
        x.fillRect(bx2, cy - 2, 8, 11);
      }
    }
    // rust weeps from random bolt lines
    for (let i = 0; i < 12; i++) {
      const wx2 = rnd() * 512, wy2 = rnd() * 400, len = 24 + rnd() * 80;
      const grad = x.createLinearGradient(wx2, wy2, wx2, wy2 + len);
      grad.addColorStop(0, `rgba(96,58,30,${0.18 + rnd() * 0.15})`);
      grad.addColorStop(1, 'rgba(96,58,30,0)');
      x.fillStyle = grad;
      x.fillRect(wx2 - 1.5, wy2, 3 + rnd() * 2, len);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

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
    const floorTexBase = this._deckTex('#242c3a', '#161d28');
    const wallTexBase = this._wallTex('#3a465c', '#2a3446');
    const mkFloorMat = (w, d, tint) => {
      const tex = floorTexBase.clone();
      tex.needsUpdate = true;
      tex.repeat.set(Math.max(1, w / 4), Math.max(1, d / 4));
      return new THREE.MeshStandardMaterial({ map: tex, color: tint, roughness: 0.85, metalness: 0.35 });
    };
    this._matWall = new THREE.MeshStandardMaterial({ map: wallTexBase, color: 0xaebdd8, roughness: 0.7, metalness: 0.5 });
    const matWall = this._matWall;
    const matCeil = new THREE.MeshStandardMaterial({ color: 0x141a26, emissive: 0x2a3a58, emissiveIntensity: 0.35, roughness: 1, side: THREE.DoubleSide });
    this._matCeil = matCeil;
    this._mkFloorMat = mkFloorMat; // reused by _buildStairRoom (separate method)

    // ---- vertical circulation first (its hatches cut the decks) ----
    this._buildTrunks();
    this._propMat = new THREE.MeshStandardMaterial({ map: wallTexBase, color: 0x7d8aa5, roughness: 0.8, metalness: 0.45 });
    this._propMatB = new THREE.MeshStandardMaterial({ color: 0x4f5c46, roughness: 0.9, metalness: 0.2 });
    const floorHoles = new Map(); // nodeIdx -> holes in its FLOOR
    const ceilHoles = new Map();  // nodeIdx -> holes in its CEILING
    for (const t of this.trunks) {
      if (!t.vertical) continue;
      const hole = { x: t.x, z: t.z };
      (floorHoles.get(t.upperNode) ?? floorHoles.set(t.upperNode, []).get(t.upperNode)).push(hole);
      (ceilHoles.get(t.lowerNode) ?? ceilHoles.set(t.lowerNode, []).get(t.lowerNode)).push(hole);
    }
    // the grand stairwell's switchback descends through the hangar's ceiling
    // below it: cut a hole in the LOWER room's ceiling over the stair well so
    // the steps drop into it (grandStair's own floor is built with the well
    // cut out by _buildStairRoom).
    for (const s of g.stairwells) {
      const up = g.node(s.upper);
      const gm = this._stairGeom(up);
      (ceilHoles.get(s.lower) ?? ceilHoles.set(s.lower, []).get(s.lower))
        .push({ x: gm.wellCx, z: gm.wellCz, hw: gm.wellHx, hd: gm.wellHz });
    }

    for (const n of g.nodes) {
      const deck = n.deck, elev = elevOf(deck);
      const [wx, wz] = this.simToWorld(n.x, n.y, deck);
      const isBreach = n.idx === g.breachNode;
      const tint = isBreach ? 0xff8866 : g.unpowered[n.idx] ? 0x4a5261 : (n.type === 'corridor' ? 0xbccbe4 : 0x9daabf);
      const fmat = mkFloorMat(n.w, n.d, tint);
      const roomH = clearHeightOf(n); // taller in the big holds — leap room
      // GRAND STAIRWELL room: normal deck-3 room, but the floor is built with a
      // central well + switchback by _buildStairRoom (skip the flat floor).
      const isStair = n.roles.includes('stairwell');
      if (isStair) this._buildStairRoom(n);

      // floor + ceiling with hatch holes where shafts pierce them
      const fh = floorHoles.get(n.idx) ?? [];
      if (!isStair) for (const [a0, b0, a1, b1] of rectMinusHoles(wx - n.w / 2, wz - n.d / 2, wx + n.w / 2, wz + n.d / 2, fh)) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, 0.12, b1 - b0), fmat);
        slab.position.set((a0 + a1) / 2, elev - 0.06, (b0 + b1) / 2);
        this.scene.add(slab);
      }
      const ch = ceilHoles.get(n.idx) ?? [];
      for (const [a0, b0, a1, b1] of rectMinusHoles(wx - n.w / 2, wz - n.d / 2, wx + n.w / 2, wz + n.d / 2, ch)) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, 0.1, b1 - b0), matCeil);
        slab.position.set((a0 + a1) / 2, elev + roomH, (b0 + b1) / 2);
        this.scene.add(slab);
      }
      const sign = this._label(n.name);
      sign.position.set(wx, elev + roomH - 0.45, wz);
      this.scene.add(sign);
      (this.roomSigns ??= [])[n.idx] = sign;

      // flood-darkness veil: fills the room volume; invisible until the sim
      // says the flood has held the room long enough (updateDarkness)
      {
        const veil = new THREE.Mesh(
          new THREE.BoxGeometry(n.w - 0.1, roomH - 0.08, n.d - 0.1),
          new THREE.MeshBasicMaterial({
            color: 0x000000, transparent: true, opacity: 0,
            depthWrite: false, side: THREE.FrontSide,
          }));
        veil.position.set(wx, elev + roomH / 2, wz);
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
        strip.position.set(wx, elev + roomH - 0.06, wz);
        this.scene.add(strip);
        this.roomLights[n.idx] = {
          mat: lmat, mode, phase: this._fxRng.range(0, 20), lvl: mode === 'dead' ? 0.04 : 1,
          x: wx, y: elev + roomH - 0.06, z: wz, // fixture world position (light pool)
        };
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
            run.horiz ? new THREE.BoxGeometry(len, roomH, WALL_T) : new THREE.BoxGeometry(WALL_T, roomH, len),
            matWall);
          if (run.horiz) wall.position.set((a + b) / 2, elev + roomH / 2, run.fixed);
          else wall.position.set(run.fixed, elev + roomH / 2, (a + b) / 2);
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
    this._buildVentGrates();
    this._buildProps();
    this._buildArmoryInterior();
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
    // NO TWO PADS ON TOP OF EACH OTHER (user report: a lift collar and a
    // ladder collar landed practically overlapping in the same corridor,
    // because each trunk picked "the clearest centre" independently). Track
    // every placed pad per deck and feed the existing ones into pickSpot as
    // points to stay clear of — so a second trunk piercing the same room
    // slides off to its own spot.
    const trunkSpots = []; // { deck, x, z }
    const avoidPts = (deck) => trunkSpots.filter((s) => s.deck === deck).map((s) => [s.x, s.z]);
    const claimSpot = (deck, x, z) => trunkSpots.push({ deck, x, z });
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
      // the grand stairwell is a walkable ramp between the room and the deck
      // above (handled by _buildStairRoom on the room itself) — no trunk, so
      // no ladder/queue and no NPC pile-up on a single pad.
      if (e.type === 'stairwell') continue;
      if (vertical) {
        const [x, z] = pickSpot(ox0, ox1, oz0, oz1,
          [...doorPts(lower.idx, lower.deck), ...doorPts(upper.idx, upper.deck),
            ...avoidPts(lower.deck), ...avoidPts(upper.deck)],
          (ox0 + ox1) / 2, (oz0 + oz1) / 2);
        claimSpot(lower.deck, x, z); claimSpot(upper.deck, x, z);
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
            [...doorPts(n.idx, n.deck), ...avoidPts(n.deck)], px, nz, 0.08);
          claimSpot(n.deck, sx, sz);
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

  // GRAND STAIRWELL (user: big room off the corridor, central switchback
  // staircase you walk down). A deck-3 room you enter at floor level (hiElev)
  // from the corridor; a compact dog-leg well in the middle descends two
  // decks to the hangar floor (loElev), leaving floor to walk all around the
  // stairs. `_stairGeom` is a pure function of the room rect so the renderer,
  // the player collider and the agent renderer all agree.
  _stairGeom(n) {
    const [cx, cz] = this.simToWorld(n.x, n.y, n.deck);
    const hx = n.w / 2, hz = n.d / 2;
    const hiElev = elevOf(n.deck);       // entry floor (this deck)
    const loElev = elevOf(n.deck + 1);   // bottom = the deck below (hangar)
    const midElev = (hiElev + loElev) / 2;
    // the well sits a little AFT of centre so the fore corridor doorway stays
    // clear; two flights split left/right of wellCx (the switchback spine)
    const wellCx = cx + hx * 0.12, wellCz = cz;
    const wellHx = Math.min(6.5, hx * 0.42), wellHz = Math.min(6, hz * 0.34);
    return { cx, cz, hx, hz, hiElev, loElev, midElev, wellCx, wellCz, wellHx, wellHz };
  }

  // where in the switchback a well-point sits (or null if outside the well)
  _switchbackY(g, wx, wz) {
    if (wx < g.wellCx - g.wellHx || wx > g.wellCx + g.wellHx
      || wz < g.wellCz - g.wellHz || wz > g.wellCz + g.wellHz) return null;
    const t = (wz - (g.wellCz - g.wellHz)) / (2 * g.wellHz); // 0 at -Z front, 1 at +Z back
    if (wx < g.wellCx) return g.hiElev - (g.hiElev - g.midElev) * t;  // flight A: top->mid
    return g.loElev + (g.midElev - g.loElev) * t;                     // flight B: mid->bottom
  }

  // floor elevation under a world point — the deck floor normally; in a
  // stairwell room, the entry floor or the switchback where it descends.
  groundHeightAt(deck, wx, wz) {
    for (const g of (this.stairRooms ?? [])) {
      if (g.deck !== deck) continue;
      if (wx < g.cx - g.hx || wx > g.cx + g.hx || wz < g.cz - g.hz || wz > g.cz + g.hz) continue;
      const sy = this._switchbackY(g, wx, wz);
      return sy === null ? g.hiElev : sy;   // entry floor, or the stairs
    }
    return elevOf(deck);
  }

  // headroom is generous over the well (the volume is two decks tall)
  ceilHeightAt(deck, wx, wz) {
    const [sx, sy] = this.worldToSim(wx, wz, deck);
    const idx = this.roomAt(deck, sx, sy, -1);
    return idx >= 0 ? clearHeightOf(this.graph.node(idx)) : CLEAR_H;
  }

  // the stairwell room whose footprint contains this world point (any deck).
  stairRoomAt(wx, wz) {
    for (const g of (this.stairRooms ?? [])) {
      if (wx >= g.cx - g.hx && wx <= g.cx + g.hx && wz >= g.cz - g.hz && wz <= g.cz + g.hz) return g;
    }
    return null;
  }

  // the stairwell room this world point is INSIDE the well of (any deck).
  stairWellAt(wx, wz) {
    for (const g of (this.stairRooms ?? [])) {
      if (wx >= g.wellCx - g.wellHx && wx <= g.wellCx + g.wellHx
        && wz >= g.wellCz - g.wellHz && wz <= g.wellCz + g.wellHz) return g;
    }
    return null;
  }

  // Build the switchback + the entry floor with a central well cut out. The
  // room's walls/ceiling/doors are the NORMAL deck-3 ones (grandStair is a
  // regular room now), so the corridor doorway just works — only the floor is
  // special. The well descends through the hangar's ceiling (cut elsewhere).
  _buildStairRoom(n) {
    const g = this._stairGeom(n);
    (this.stairRooms ??= []).push({ deck: n.deck, node: n.idx, ...g });
    const { cx, cz, hx, hz, hiElev, loElev, midElev, wellCx, wellCz, wellHx, wellHz } = g;
    const matStep = new THREE.MeshStandardMaterial({ color: 0x6c7789, roughness: 0.75, metalness: 0.4 });
    const matRail = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, roughness: 0.45, metalness: 0.7 });
    const fmat = this._mkFloorMat(n.w, n.d, 0x93a1b8);
    // entry floor at deck level, with the well cut out (walk all the way round)
    const hole = { x: wellCx, z: wellCz, hw: wellHx, hd: wellHz };
    for (const [a0, b0, a1, b1] of rectMinusHoles(cx - hx, cz - hz, cx + hx, cz + hz, [hole])) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, 0.14, b1 - b0), fmat);
      slab.position.set((a0 + a1) / 2, hiElev - 0.07, (b0 + b1) / 2);
      this.scene.add(slab);
    }
    // two flights of the switchback (spine at wellCx). Flight A (left/-X) drops
    // top->mid front-to-back; a mid landing at the back; flight B (right/+X)
    // drops mid->bottom back-to-front, so you turn 180 on the landing.
    const steps = 9;
    const mkFlight = (xLo, xHi, yStart, yEnd, frontToBack) => {
      const dz = (2 * wellHz) / steps, dy = (yStart - yEnd) / steps;
      for (let i = 0; i < steps; i++) {
        const zc = frontToBack ? (wellCz - wellHz) + (i + 0.5) * dz : (wellCz + wellHz) - (i + 0.5) * dz;
        const yc = yStart - (i + 0.5) * dy;
        const tread = new THREE.Mesh(new THREE.BoxGeometry(xHi - xLo, 0.13, dz + 0.03), matStep);
        tread.position.set((xLo + xHi) / 2, yc, zc);
        this.scene.add(tread);
      }
    };
    mkFlight(wellCx - wellHx, wellCx, hiElev, midElev, true);   // flight A (left)
    mkFlight(wellCx, wellCx + wellHx, midElev, loElev, false);  // flight B (right)
    // mid landing (at the back, both halves)
    const land = new THREE.Mesh(new THREE.BoxGeometry(2 * wellHx, 0.14, 2.0), matStep);
    land.position.set(wellCx, midElev - 0.07, wellCz + wellHz - 1.0);
    this.scene.add(land);
    // switchback spine wall between the two flights
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.12, hiElev - loElev, 2 * wellHz - 2.2), matStep);
    spine.position.set(wellCx, (hiElev + loElev) / 2, wellCz - 1.0);
    this.scene.add(spine); this.wallMeshes.push(spine);
    // railings around the well opening on the entry floor (so you don't just
    // step off into it — you go down the stairs)
    for (const [px, pz, w, d] of [
      [wellCx, wellCz - wellHz, 2 * wellHx, 0.06], [wellCx, wellCz + wellHz, 2 * wellHx, 0.06],
      [wellCx - wellHx, wellCz, 0.06, 2 * wellHz], [wellCx + wellHx, wellCz, 0.06, 2 * wellHz]]) {
      // gap the fore rail where flight A meets the entry floor (top of stairs)
      if (pz === wellCz - wellHz) continue; // front edge is the stair mouth — open
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), matRail);
      r.position.set(px, hiElev + 1.0, pz);
      this.scene.add(r); this.wallMeshes.push(r);
      const rl = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.08), 1.0, Math.max(d, 0.08)), matRail);
      rl.visible = false; // (posts omitted for brevity; rail bar reads fine)
    }
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
      systems: { n: 2, w: 1.1, h: 1.2 }, // (armory has its own neat interior — _buildArmoryInterior)
      mess: { n: 3, w: 1.4, h: 0.85 }, quarters: { n: 3, w: 1.0, h: 0.6 },
      hangar: { n: 4, w: 1.7, h: 1.3 }, medbay: { n: 2, w: 1.1, h: 0.85 },
      vehicles: { n: 3, w: 1.6, h: 1.2 },
      // weapon halls (the flank batteries + magazines): gun mounts along the
      // outboard wall, ammo racks in the magazines
      battery: { n: 6, w: 1.5, h: 1.5 }, magazine: { n: 7, w: 1.3, h: 1.1 },
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

  // THE ARMORY (user rule: sealed reserve). Not hashed clutter — a proper
  // arms room: rifle racks in a neat rank along the walls, grenade crates
  // stacked square, ammo cans in rows, and ONE flamethrower on its stand.
  // All deterministic, all collidable.
  _buildArmoryInterior() {
    const g = this.graph;
    const idx = g.byId.get('armory');
    if (idx === undefined) return;
    const n = g.node(idx);
    const [cx, cz] = this.simToWorld(n.x, n.y, n.deck);
    const elev = elevOf(n.deck);
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x3a4149, roughness: 0.6, metalness: 0.7 });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x181c20, roughness: 0.5, metalness: 0.6 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x4a5240, roughness: 0.85, metalness: 0.15 });
    const ammoMat = new THREE.MeshStandardMaterial({ color: 0x5c5636, roughness: 0.7, metalness: 0.3 });
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x7a2a20, roughness: 0.45, metalness: 0.6 });
    const add = (mesh, sx, sy, hw, hd, solid = true) => {
      this.scene.add(mesh);
      if (solid) {
        this.wallMeshes.push(mesh);
        this.props.push({ deck: n.deck, x: sx, y: sy, hw, hd });
      }
    };
    // rifle racks: a rank of three along the aft (-Z) wall, rifles standing up
    for (let r = 0; r < 3; r++) {
      const rx = cx - n.w / 2 + 2.2 + r * 3.4;
      const rz = cz - n.d / 2 + 0.65;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.85, 0.4), rackMat);
      frame.position.set(rx, elev + 0.925, rz);
      const [sx, sy] = this.worldToSim(rx, rz, n.deck);
      add(frame, sx, sy, 1.4, 0.45);
      for (let k = 0; k < 6; k++) { // the racked rifles, muzzle-up in a row
        const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.0, 0.16), gunMat);
        gun.position.set(rx - 1.05 + k * 0.42, elev + 1.05, rz + 0.28);
        this.scene.add(gun);
      }
    }
    // grenade crates: a tight 2x2 block, one stacked — square and dressed
    for (let c = 0; c < 5; c++) {
      const bx = cx + n.w / 2 - 1.3 - (c % 2) * 0.95;
      const bz = cz - n.d / 2 + 0.85 + Math.floor((c % 4) / 2) * 0.75;
      const by = c === 4 ? elev + 0.78 : elev + 0.26;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.52, 0.6), crateMat);
      crate.position.set(bx, by, bz);
      const [sx, sy] = this.worldToSim(bx, bz, n.deck);
      add(crate, sx, sy, 0.55, 0.45, c < 4);
    }
    // ammo cans: two neat rows on a low shelf along the fore (+Z) wall
    const shelfZ = cz + n.d / 2 - 0.6;
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.5, 0.7), rackMat);
    shelf.position.set(cx - 1.0, elev + 0.25, shelfZ);
    { const [sx, sy] = this.worldToSim(cx - 1.0, shelfZ, n.deck); add(shelf, sx, sy, 2.9, 0.55); }
    for (let k = 0; k < 8; k++) {
      const can = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.3), ammoMat);
      can.position.set(cx - 3.4 + k * 0.68, elev + 0.65, shelfZ);
      this.scene.add(can);
    }
    // the flamethrower: red twin tanks on a stand, alone — you notice it
    const fx = cx + n.w / 2 - 1.1, fz = cz + n.d / 2 - 1.1;
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.85, 0.55), rackMat);
    stand.position.set(fx, elev + 0.425, fz);
    { const [sx, sy] = this.worldToSim(fx, fz, n.deck); add(stand, sx, sy, 0.5, 0.42); }
    for (const off of [-0.15, 0.15]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.75, 10), tankMat);
      tank.position.set(fx + off, elev + 1.25, fz);
      this.scene.add(tank);
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
      mat.userData.lockedLook = !!e.locked; // updateDoors clears the red look on unlock
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
    // SMALL, FLUSH, QUIET (user: the big glowing floor grates on the lower
    // deck are asinine). A shaft mouth is a modest recessed hatch, not a
    // glowing warning slab — shrunk to ~0.85 m and the amber rim dimmed to a
    // faint hazard line.
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 0.9, metalness: 0.35 });
    const slatMat = new THREE.MeshStandardMaterial({ color: 0x2f3742, roughness: 0.75, metalness: 0.5 });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x242017, emissive: 0x8a6a24, emissiveIntensity: 0.15, roughness: 0.7,
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
        const rim = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.035, 0.98), rimMat);
        rim.position.set(wx, elev + 0.015, wz);
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.06, 0.84), plateMat);
        plate.position.set(wx, elev + 0.035, wz);
        this.scene.add(rim, plate);
        for (let k = -1; k <= 1; k++) {
          const slat = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.025, 0.1), slatMat);
          slat.position.set(wx, elev + 0.07, wz + k * 0.26);
          this.scene.add(slat);
        }
      }
    }
  }

  // MARKED VENT OPENINGS (user report: crawlers snapped to the room centre
  // then teleported to nowhere). Every duct opening the flood uses gets a
  // small louvered grate on the floor by the wall — the crawlers now walk to
  // it, vanish into it, and climb out the far one. Deduped by position and
  // kept clear of the real doorways (a shared-wall vent reads as the door).
  _buildVentGrates() {
    const g = this.graph;
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x2a3340, emissive: 0x1a2b3a, emissiveIntensity: 0.3, roughness: 0.7, metalness: 0.5,
    });
    const slatMat = new THREE.MeshStandardMaterial({ color: 0x161c24, roughness: 0.85, metalness: 0.4 });
    const seen = new Set();
    // NO GRATE IN A DOORWAY (user: there are still vents in doorways). A vent
    // that parallels a real doorway shares the SAME two rooms as a std door —
    // the doorway itself is the crawler's opening, so it gets no grate. This
    // topological test is robust where the old distance check leaked. Door
    // positions are also kept as a backstop for the odd off-wall throat vent.
    const dooredPairs = new Set();
    const doorPts = [];
    for (const e of g.edges) {
      if (!e.door) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck) continue;
      dooredPairs.add(`${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`);
      const [dx, dz] = this.simToWorld(e.door.x, e.door.y, a.deck);
      doorPts.push({ deck: a.deck, x: dx, z: dz });
    }
    for (const v of g.vents) {
      if (dooredPairs.has(`${Math.min(v.a, v.b)}:${Math.max(v.a, v.b)}`)) continue; // the door IS the opening
      const a = g.node(v.a), b = g.node(v.b);
      for (const [n, pt] of [[a, v.doorA], [b, v.doorB]]) {
        const d = pt ?? v.door;
        if (!d) continue;
        const [wx, wz] = this.simToWorld(d.x, d.y, n.deck);
        const key = `${n.deck}:${Math.round(wx)}:${Math.round(wz)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // backstop: still skip any grate that lands on a real doorway
        if (doorPts.some((p) => p.deck === n.deck && Math.hypot(p.x - wx, p.z - wz) < 2.0)) continue;
        const elev = elevOf(n.deck);
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.05, 0.92), frameMat);
        frame.position.set(wx, elev + 0.03, wz);
        this.scene.add(frame);
        for (let k = -1; k <= 1; k++) {
          const slat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.04, 0.16), slatMat);
          slat.position.set(wx, elev + 0.06, wz + k * 0.26);
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
      // a door whose lock RELEASED mid-game (the armory seal) sheds its red
      // glow — the panel material was baked from e.locked at build time
      if (!d.edge.locked && d.mesh.material.userData.lockedLook) {
        d.mesh.material.userData.lockedLook = false;
        d.mesh.material.color.setHex(0x55637d);
        d.mesh.material.emissive.setHex(0x101820);
        d.mesh.material.emissiveIntensity = 0.4;
      }
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
