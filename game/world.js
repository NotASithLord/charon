// 3D world extruded from the meter-true ship plan (docs/ROADMAP-3D.md §1).
// The sim graph stays authoritative: rooms are their authored w × d rects,
// doors are the sim's computed door points as REAL SLIDING PANELS, and
// cross-deck links are REAL SHAFTS — where two rooms overlap in plan the
// shaft is a true vertical well with hatch holes cut through the deck
// (climb it, look up/down it, shoot through it); offset pairs become
// enclosed stairwell trunks. No teleport pads.

import * as THREE from '../engine/vendor/three.webgpu.module.js';
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
    // duct/shaft/ladder openings per room, sim coords — the agent renderer
    // snaps deck-transit arrivals onto these so bodies surface AT a marked
    // opening instead of teleporting into the middle of a hallway (user)
    this.mouths = new Map();
    this._bandC = graph.deckBands.map((b) => (b.y0 + b.y1) / 2);
    this._build();
  }

  bandCenter(deck) { return this._bandC[deck - 1]; }

  _addMouth(nodeIdx, sx, sy) {
    (this.mouths.get(nodeIdx) ?? this.mouths.set(nodeIdx, []).get(nodeIdx)).push({ x: sx, y: sy });
  }

  // nearest registered opening in a room to a sim-space point (null if none)
  mouthNear(nodeIdx, sx, sy) {
    const list = this.mouths.get(nodeIdx);
    if (!list || !list.length) return null;
    let best = list[0], bd = Infinity;
    for (const m of list) {
      const d = (m.x - sx) ** 2 + (m.y - sy) ** 2;
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
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
    // boxes were cached from the pristine per-mesh geometry BEFORE the
    // static merge collapsed it (the merged buffers have no box params)
    // locked-door boxes are NOT here anymore — doors jam and unjam
    // mid-session now, so their colliders are dynamic (doorBoxes below,
    // toggled through PhysicsWorld.setDoorClosed)
    return [...(this._collBoxCache ?? [])];
  }

  // one collider box per door, spanning the closed opening; `closed` follows
  // the sim's lock state and the physics layer parks open doors far below
  doorBoxes() {
    return this.doors.map((d) => ({
      cx: d.x, cy: d.elev + this._doorPH / 2, cz: d.z,
      hx: DOOR_W / 2 + 0.06, hy: this._doorPH / 2, hz: 0.08,
      ry: -d.phi, closed: !!d.edge.locked,
    }));
  }

  // STATIC MERGE (perf): group every plain static Mesh in the scene by
  // material; any material carried by >= 8 meshes gets its meshes baked
  // (world transform applied) into ONE BufferGeometry and ONE draw call.
  // Auto-excluded by construction: door panels (they move), per-room
  // materials like floors/strips/lamps/veils (each material has < 8 meshes
  // or is skipped explicitly), and all Instanced/Points/Sprite objects.
  // wallMeshes members that merge are replaced by their merged mesh so the
  // bullet raycast still hits everything.
  _mergeStaticPass() {
    const moving = new Set(this.doors.map((d) => d.mesh));
    const byMat = new Map();
    // DECK-SCOPED GROUPS (user: don't render the whole ship): meshes merge
    // per material AND per deck, so whole decks can be hidden when the
    // player can't possibly see them (decks are opaque; only hatches and
    // the stairwell pierce ADJACENT decks — ±1 is always kept visible).
    // FLOOR-BAND attribution (bugfix: user saw straight through tall rooms'
    // ceilings): Math.round sent a ceiling at elev + tallRoomH TWO decks up,
    // where the ±1 rule culled it. Attribute by which deck's floor band the
    // object sits above instead — a tall ceiling lands at most one deck up,
    // which ±1 always keeps.
    const deckOf = (y) => Math.max(1, Math.min(5, 5 - Math.floor((y + 0.15) / DECK_H)));
    // FORE/AFT THIRDS (fog-exact culling): scene.fog.far never exceeds 60m
    // and three's fog is FULLY opaque at far — geometry beyond ~70m is
    // pixel-for-pixel invisible. The ship is ~220m long, so each deck merges
    // into three fore/aft chunks and far chunks are dropped losslessly.
    let minX = Infinity, maxX = -Infinity;
    for (const n of this.graph.nodes) {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
    }
    this._thirdEdges = [minX, minX + (maxX - minX) / 3, minX + (maxX - minX) * 2 / 3, maxX];
    const thirdOf = (x) => x < this._thirdEdges[1] ? 0 : x < this._thirdEdges[2] ? 1 : 2;
    for (const o of this.scene.children) {
      if (!o.isMesh || o.isInstancedMesh || moving.has(o)) continue;
      if (!o.geometry?.attributes?.position || !o.geometry.attributes.normal) continue;
      if (o.geometry.attributes.position.count > 5000) continue; // already big
      const key = o.material.uuid + ':' + deckOf(o.position.y) + ':' + thirdOf(o.position.x);
      const e = byMat.get(key) ?? byMat.set(key, { mat: o.material, list: [] }).get(key);
      e.list.push(o);
    }
    this._deckOf = deckOf;
    this._thirdOf = thirdOf;
    this._volBins = new Map(); // 'deck:third' -> [static objects], toggled by setActiveVolume
    const wallSet = new Set(this.wallMeshes);
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    const binVol = (deck, third, obj) => {
      const k = deck + ':' + third;
      (this._volBins.get(k) ?? this._volBins.set(k, []).get(k)).push(obj);
    };
    for (const [, { mat, list }] of byMat) {
      if (list.length < 8) continue;
      let vtot = 0, itot = 0;
      for (const m of list) {
        m.updateMatrixWorld(true);
        const g2 = m.geometry;
        vtot += g2.attributes.position.count;
        itot += g2.index ? g2.index.count : g2.attributes.position.count;
      }
      const pos = new Float32Array(vtot * 3);
      const nrm = new Float32Array(vtot * 3);
      const uv = new Float32Array(vtot * 2);
      const idx = new Uint32Array(itot);
      let vo = 0, io = 0, anyWall = false, anyShadow = false;
      for (const m of list) {
        const g2 = m.geometry;
        const p = g2.attributes.position, n2 = g2.attributes.normal, u = g2.attributes.uv;
        nm.getNormalMatrix(m.matrixWorld);
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
          v.fromBufferAttribute(n2, i).applyMatrix3(nm).normalize();
          nrm[(vo + i) * 3] = v.x; nrm[(vo + i) * 3 + 1] = v.y; nrm[(vo + i) * 3 + 2] = v.z;
          if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
        }
        if (g2.index) {
          for (let i = 0; i < g2.index.count; i++) idx[io + i] = g2.index.array[i] + vo;
          io += g2.index.count;
        } else {
          for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
          io += p.count;
        }
        vo += p.count;
        if (wallSet.has(m)) { anyWall = true; wallSet.delete(m); }
        if (m.castShadow) anyShadow = true;
        this.scene.remove(m);
      }
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      merged.setIndex(new THREE.BufferAttribute(idx, 1));
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = anyShadow;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      if (anyWall) wallSet.add(mesh);
      binVol(deckOf(merged.boundingSphere.center.y), thirdOf(merged.boundingSphere.center.x), mesh);
    }
    this.wallMeshes = [...wallSet];
    // bin the surviving per-room statics too (floors, strips, lamps —
    // NOT doors/veils/signs, whose visibility/opacity is animated per frame)
    const binned = new Set();
    for (const list of this._volBins.values()) for (const o of list) binned.add(o);
    const skip = new Set([...moving, ...this.darkVeils.filter(Boolean), ...(this.roomSigns ?? []).filter(Boolean)]);
    for (const o of this.scene.children) {
      if (!o.isMesh || o.isInstancedMesh || skip.has(o) || binned.has(o)) continue;
      binVol(deckOf(o.position.y), thirdOf(o.position.x), o);
    }
  }

  // hide every volume the player cannot possibly see: decks beyond +/-1
  // (opaque decks; hatches/stairwell pierce one), and fore/aft thirds whose
  // NEAREST edge is beyond full fog (pixel-exact — fog is opaque at far)
  setActiveVolume(playerDeck, playerX) {
    const key = playerDeck + ':' + Math.round(playerX / 8);
    if (this._activeKey === key) return; // re-evaluate only on real movement
    this._activeKey = key;
    const E = this._thirdEdges;
    for (const [k, list] of this._volBins ?? []) {
      const [deck, third] = k.split(':').map(Number);
      const nearEdge = Math.max(E[third] - playerX, playerX - E[third + 1], 0);
      const vis = Math.abs(deck - playerDeck) <= 1 && nearEdge < 70;
      // SHADOW CASTER CURATION (swarm finding): the torch's shadow camera
      // only reaches 32m and never crosses an opaque deck — statics on other
      // decks or in a third whose near edge is beyond the cone stay VISIBLE
      // but drop out of the depth-only shadow pass (3-5x fewer shadow verts).
      // ?nosc=1 disables it (A/B lever while the real-WebGPU incident is live).
      const cast = deck === playerDeck && nearEdge < 40;
      for (const o of list) {
        o.visible = vis;
        if (this.shadowCull === false) continue;
        if (o._castBase === undefined) o._castBase = o.castShadow === true;
        o.castShadow = o._castBase && cast;
      }
    }
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
    // MICRO-RELIEF (fidelity pass): the same plate/panel textures double as
    // bump maps, so plate seams, rivets and conduits catch the flashlight as
    // real raised detail sweeping past — the cheapest normal-mapping there is.
    // One material per TINT, all sharing the one deck-plate texture (swarm
    // finding: cloning the 512² CanvasTexture per room uploaded ~63 copies —
    // ~90MB of GPU memory — and the unique materials blocked floor batching).
    // Tiling that repeat.set() used to provide is baked into each slab's UVs.
    const floorMats = new Map();
    const mkFloorMat = (tint) => {
      let m = floorMats.get(tint);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          map: floorTexBase, color: tint, roughness: 0.85, metalness: 0.35,
          bumpMap: floorTexBase, bumpScale: 0.6,
        });
        floorMats.set(tint, m);
      }
      return m;
    };
    const scaleFloorUV = (geo, w, d) => {
      const su = Math.max(1, w / 4), sv = Math.max(1, d / 4);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
      return geo;
    };
    this._scaleFloorUV = scaleFloorUV;
    this._matWall = new THREE.MeshStandardMaterial({
      map: wallTexBase, color: 0xaebdd8, roughness: 0.7, metalness: 0.5,
      bumpMap: wallTexBase, bumpScale: 0.5,
    });
    const matWall = this._matWall;
    // NO self-glow (user: a bright visible ceiling ruins the darkness) — the
    // overhead plating is pitch dark unless an actual light source hits it
    const matCeil = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 1 }); // closed boxes — FrontSide is pixel-identical
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
      const fmat = mkFloorMat(tint);
      const roomH = clearHeightOf(n); // taller in the big holds — leap room
      // GRAND STAIRWELL room: normal deck-3 room, but the floor is built with a
      // central well + switchback by _buildStairRoom (skip the flat floor).
      const isStair = n.roles.includes('stairwell');
      if (isStair) this._buildStairRoom(n);

      // floor + ceiling with hatch holes where shafts pierce them
      const fh = floorHoles.get(n.idx) ?? [];
      if (!isStair) for (const [a0, b0, a1, b1] of rectMinusHoles(wx - n.w / 2, wz - n.d / 2, wx + n.w / 2, wz + n.d / 2, fh)) {
        const slab = new THREE.Mesh(scaleFloorUV(new THREE.BoxGeometry(a1 - a0, 0.12, b1 - b0), a1 - a0, b1 - b0), fmat);
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

      // ceiling light strip — fixture state comes from the SIM now (graph
      // lightMode, rolled in init): what dims your view is exactly what
      // costs the marines their aim (combat.js fixture-state penalties)
      {
        const mode = ['steady', 'soft', 'harsh', 'dead'][g.lightMode[n.idx]];
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
        // EMERGENCY LUMINAIRES (user rule: it's a DEAD SHIP on secondary
        // power — every room carries discrete emergency fixtures, not an
        // atmospheric wash). Small red battery lamps hang ABOVE EACH HATCH
        // in EVERY room — in a lit room they're the accents of a ship on
        // emergency power; in a dead room they're the only thing burning.
        // They die with the room if the flood takes it (updateDarkness).
        {
          const emMat = new THREE.MeshStandardMaterial({
            color: 0x2a0e0a, emissive: 0xff3018, emissiveIntensity: 2.4, roughness: 0.6,
          });
          let anchor = null;
          for (const e of g.edges) {
            if (!e.door || (e.a !== n.idx && e.b !== n.idx)) continue;
            const other = g.node(e.a === n.idx ? e.b : e.a);
            if (other.deck !== deck) continue;
            const [dx2, dz2] = this.simToWorld(e.door.x, e.door.y, deck);
            // ON THE CEILING over the door (user rule) — mounted flush to
            // the overhead, just inside the room so it clears the doorframe
            const ox = wx - dx2, oz = wz - dz2, ol = Math.hypot(ox, oz) || 1;
            const px = dx2 + (ox / ol) * 0.35, pz = dz2 + (oz / ol) * 0.35;
            const lampM = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.12), emMat);
            lampM.position.set(px, elev + roomH - 0.06, pz);
            this.scene.add(lampM);
            if (!anchor) anchor = { x: px, y: elev + roomH - 0.35, z: pz };
          }
          const L = this.roomLights[n.idx];
          L.emergency = mode === 'dead'; // pool throws red light only where the mains are out
          L.emMat = emMat;
          L.em = anchor ?? { x: wx, y: elev + roomH - 0.5, z: wz };
        }
      }

      // walls with door openings, inset half a thickness (no z-fighting)
      const sides = { N: [], S: [], W: [], E: [] };
      for (const e of g.edges) {
        if (!e.door) continue;
        if (e.a !== n.idx && e.b !== n.idx) continue;
        const other = g.node(e.a === n.idx ? e.b : e.a);
        if (other.deck !== deck) continue;
        // THE SEALED-ROOM BUG (user: galley entrance completely closed off):
        // for a non-flush link, e.door is the throat tube's MIDPOINT — out in
        // the void between the rooms — so long diagonal tubes had their wall
        // gap clamped to the wrong place (or the wrong side) while the tube
        // actually meets this room at doorA/doorB. Cut the gap at the true
        // crossing point for THIS room.
        const dpt = (e.a === n.idx ? e.doorA : e.doorB) ?? e.door;
        const [dx, dz] = this.simToWorld(dpt.x, dpt.y, deck);
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
        // HEADER over every doorway (user: doors in tall hangar rooms were
        // just open at the top): the wall used to be cut floor-to-ceiling
        // around a door, leaving a full-height slot above the CLEAR_H panel.
        // Fill the slot from the door head to this room's ceiling.
        if (roomH > CLEAR_H + 0.1) {
          for (const c of cuts) {
            const hh = roomH - CLEAR_H;
            const header = new THREE.Mesh(
              run.horiz ? new THREE.BoxGeometry(DOOR_W, hh, WALL_T) : new THREE.BoxGeometry(WALL_T, hh, DOOR_W),
              matWall);
            if (run.horiz) header.position.set(c.at, elev + CLEAR_H + hh / 2, run.fixed);
            else header.position.set(run.fixed, elev + CLEAR_H + hh / 2, c.at);
            this.scene.add(header);
            this.wallMeshes.push(header);
          }
        }
        for (const [a, b] of spans) {
          const len = b - a;
          const wall = new THREE.Mesh(
            run.horiz ? new THREE.BoxGeometry(len, roomH, WALL_T) : new THREE.BoxGeometry(WALL_T, roomH, len),
            matWall);
          if (run.horiz) wall.position.set((a + b) / 2, elev + roomH / 2, run.fixed);
          else wall.position.set(run.fixed, elev + roomH / 2, (a + b) / 2);
          this.scene.add(wall);
          this.wallMeshes.push(wall);
          // CONTACT SHADOW SKIRT (fidelity pass): a soft dark gradient along
          // the wall base grounds the geometry — the poor man's ambient
          // occlusion, and it reads shockingly close to the baked thing.
          const skirt = new THREE.Mesh(
            run.horiz ? new THREE.PlaneGeometry(len, 0.55) : new THREE.PlaneGeometry(0.55, len),
            this._skirtMat ?? (this._skirtMat = (() => {
              const c = document.createElement('canvas'); c.width = 4; c.height = 32;
              const x = c.getContext('2d');
              const gr = x.createLinearGradient(0, 0, 0, 32);
              gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
              x.fillStyle = gr; x.fillRect(0, 0, 4, 32);
              const t = new THREE.CanvasTexture(c);
              return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
            })()));
          skirt.rotation.x = -Math.PI / 2;
          if (run.horiz) {
            skirt.rotation.z = run.fixed < wz ? Math.PI : 0;
            skirt.position.set((a + b) / 2, elev + 0.015, run.fixed + (run.fixed < wz ? 0.28 : -0.28));
          } else {
            skirt.rotation.z = run.fixed < wx ? Math.PI / 2 : -Math.PI / 2;
            skirt.position.set(run.fixed + (run.fixed < wx ? 0.28 : -0.28), elev + 0.015, (a + b) / 2);
          }
          skirt.renderOrder = 1;
          this.scene.add(skirt);
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
    // PERF (user: unusable frame rate — cut nothing): the ship was ~2000
    // individual meshes, each a draw call in the main pass AND AGAIN in the
    // flashlight's shadow pass. Cache the physics boxes from the pristine
    // meshes, then merge everything static that shares a material into a
    // handful of big buffers. Same pixels, ~10x fewer draw calls.
    this._collBoxCache = this.wallMeshes.map((m) => {
      const p = m.geometry.parameters;
      return {
        cx: m.position.x, cy: m.position.y, cz: m.position.z,
        hx: (p.width ?? (p.radiusTop ? p.radiusTop * 2 : 1)) / 2,
        hy: (p.height ?? 1) / 2,
        hz: (p.depth ?? (p.radiusTop ? p.radiusTop * 2 : 1)) / 2,
        ry: m.rotation.y || 0,
      };
    });
    this._mergeStaticPass();
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
    // SUBTLE MARKERS (user: the glowing color blocks were the last jarring
    // low-res read) — collars are worn steel with only a faint status tint;
    // the red battery lamps above each hatch already carry the wayfinding
    const matCollar = (lift) => new THREE.MeshStandardMaterial({
      color: 0x59626f, roughness: 0.55, metalness: 0.6,
      emissive: lift ? 0x1a4a55 : 0x4a3a16, emissiveIntensity: 0.18,
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
        // both ends are emerge points for cross-deck arrivals
        {
          const [lsx, lsy] = this.worldToSim(x, z, lower.deck);
          this._addMouth(lower.idx, lsx, lsy);
          const [usx, usy] = this.worldToSim(x, z, upper.deck);
          this._addMouth(upper.idx, usx, usy);
        }
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
          const [msx, msy] = this.worldToSim(p.x, p.z, p.deck);
          this._addMouth(p.node, msx, msy);
          // STAIR KIOSK (user: the glowing cylinder was an egregious low-res
          // marker): a real steel enclosure with an open dark doorway facing
          // the room — reads as the head of an enclosed stairwell, built from
          // the same wall material as everything else. Top-level meshes with
          // world transforms (Y-rotation only) so the physics box cache and
          // the static merge see them exactly like every other wall.
          const nd = g.node(p.node);
          const [ncx, ncz] = this.simToWorld(nd.x, nd.y, nd.deck);
          const face = Math.atan2(ncx - p.x, ncz - p.z); // doorway toward room centre
          const kw = 2.0, kd = 2.0, kh = CLEAR_H - 0.25, dw = 1.0, dh = 2.15;
          const cf = Math.cos(face), sf = Math.sin(face);
          const base = elevOf(p.deck);
          const addK = (w, h, d, lx, ly, lz, solid = true) => {
            const wx2 = p.x + lx * cf + lz * sf;
            const wz2 = p.z - lx * sf + lz * cf;
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._matWall);
            m.position.set(wx2, base + ly, wz2);
            m.rotation.y = face;
            this.scene.add(m);
            if (solid) this.wallMeshes.push(m);
          };
          addK(kw, kh, 0.12, 0, kh / 2, -kd / 2);                                   // back
          addK(0.12, kh, kd, -kw / 2, kh / 2, 0);                                   // left
          addK(0.12, kh, kd, kw / 2, kh / 2, 0);                                    // right
          addK((kw - dw) / 2, kh, 0.12, -(dw / 2 + (kw - dw) / 4), kh / 2, kd / 2); // door jambs
          addK((kw - dw) / 2, kh, 0.12, dw / 2 + (kw - dw) / 4, kh / 2, kd / 2);
          addK(kw, kh - dh, 0.12, 0, dh + (kh - dh) / 2, kd / 2, false);            // header (walk under)
          addK(kw, 0.1, kd, 0, kh + 0.05, 0, false);                               // cap
          // the dark descent inside the doorway — an unlit void you step into
          const voidM = new THREE.Mesh(new THREE.PlaneGeometry(dw + 0.7, dh - 0.05),
            new THREE.MeshBasicMaterial({ color: 0x04060a }));
          voidM.position.set(p.x, base + dh / 2, p.z);
          voidM.rotation.y = face;
          this.scene.add(voidM);
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
  // feetY matters in the stair room: a body that bailed over a railing and
  // is BELOW the entry ring must not be given the ring as its floor (that
  // was the clip-back-to-the-upper-deck bug) — the surface under it is the
  // deck below.
  groundHeightAt(deck, wx, wz, feetY = Infinity) {
    for (const g of (this.stairRooms ?? [])) {
      if (g.deck !== deck) continue;
      if (wx < g.cx - g.hx || wx > g.cx + g.hx || wz < g.cz - g.hz || wz > g.cz + g.hz) continue;
      const sy = this._switchbackY(g, wx, wz);
      if (sy !== null) return sy;           // on the switchback
      return feetY >= g.hiElev - 0.4 ? g.hiElev : g.loElev; // ring, or fallen past it
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
    // REAL TEXTURES, CHEAPLY (user: the staircase read as untextured flats):
    // treads/landing/spine share the deck-plate material (tinted), with the
    // plate texture scaled onto each box via the same UV helper the floors
    // use — zero new textures, batches with the floors.
    const matStep = this._mkFloorMat(0x9aa6ba);
    const matRail = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, roughness: 0.45, metalness: 0.7 });
    const fmat = this._mkFloorMat(0x93a1b8);
    // entry floor at deck level, with the well cut out (walk all the way round)
    const hole = { x: wellCx, z: wellCz, hw: wellHx, hd: wellHz };
    for (const [a0, b0, a1, b1] of rectMinusHoles(cx - hx, cz - hz, cx + hx, cz + hz, [hole])) {
      const slab = new THREE.Mesh(this._scaleFloorUV(new THREE.BoxGeometry(a1 - a0, 0.14, b1 - b0), a1 - a0, b1 - b0), fmat);
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
        const tread = new THREE.Mesh(
          this._scaleFloorUV(new THREE.BoxGeometry(xHi - xLo, 0.13, dz + 0.03), xHi - xLo, dz + 0.03), matStep);
        tread.position.set((xLo + xHi) / 2, yc, zc);
        this.scene.add(tread);
      }
    };
    mkFlight(wellCx - wellHx, wellCx, hiElev, midElev, true);   // flight A (left)
    mkFlight(wellCx, wellCx + wellHx, midElev, loElev, false);  // flight B (right)
    // mid landing (at the back, both halves)
    const land = new THREE.Mesh(
      this._scaleFloorUV(new THREE.BoxGeometry(2 * wellHx, 0.14, 2.0), 2 * wellHx, 2.0), matStep);
    land.position.set(wellCx, midElev - 0.07, wellCz + wellHz - 1.0);
    this.scene.add(land);
    // switchback spine wall between the two flights, with a bright cap rail —
    // the spine is a WALL: it wears the wall plating like every other wall
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.14, hiElev - loElev, 2 * wellHz - 2.2), this._matWall);
    spine.position.set(wellCx, (hiElev + loElev) / 2, wellCz - 1.0);
    this.scene.add(spine); this.wallMeshes.push(spine);
    const spineCap = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 2 * wellHz - 2.2), matRail);
    spineCap.position.set(wellCx, hiElev + 0.04, wellCz - 1.0);
    this.scene.add(spineCap);

    // GUARD SYSTEM (user: the old railings floated and looked like crap).
    // Solid balustrade panels with a bright cap rail, all REAL collision —
    // you take the stairs because the panels physically stop everything else.
    // balustrade panels wear the wall plating (tinted darker) instead of a
    // flat color — same texture, zero extra cost
    const matPanel = new THREE.MeshStandardMaterial({
      map: this._matWall.map, bumpMap: this._matWall.bumpMap, bumpScale: 0.4,
      color: 0x6d7889, roughness: 0.55, metalness: 0.65,
    });
    const matHazard = new THREE.MeshStandardMaterial({ color: 0xc79a1f, roughness: 0.6, metalness: 0.3 });
    const guard = (px, py, pz, w, h, d, solid = true) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matPanel);
      m.position.set(px, py, pz);
      this.scene.add(m);
      if (solid) this.wallMeshes.push(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.2), 0.07, Math.max(d, 0.2)), matRail);
      cap.position.set(px, py + h / 2 + 0.035, pz);
      this.scene.add(cap);
      return m;
    };
    const RAIL_H = 1.02, T = 0.08;
    // entry-ring guards: back edge, both side edges, and the FRONT-RIGHT half
    // (over flight B's bottom — a 5m open drop the old build left unguarded).
    // Front-left stays open: that's the stair mouth onto flight A.
    guard(wellCx, hiElev + RAIL_H / 2, wellCz + wellHz + T / 2, 2 * wellHx + 2 * T, RAIL_H, T);
    guard(wellCx - wellHx - T / 2, hiElev + RAIL_H / 2, wellCz, T, RAIL_H, 2 * wellHz + 2 * T);
    guard(wellCx + wellHx + T / 2, hiElev + RAIL_H / 2, wellCz, T, RAIL_H, 2 * wellHz + 2 * T);
    guard(wellCx + wellHx / 2, hiElev + RAIL_H / 2, wellCz - wellHz - T / 2, wellHx, RAIL_H, T);
    // newel posts framing the stair mouth
    for (const nx of [wellCx - wellHx + 0.09, wellCx - 0.09]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, RAIL_H + 0.12, 0.16), matRail);
      post.position.set(nx, hiElev + (RAIL_H + 0.12) / 2, wellCz - wellHz - 0.08);
      this.scene.add(post); this.wallMeshes.push(post);
    }
    // hazard nosing where the ring floor meets the well
    for (const [px, pz, w, d] of [
      [wellCx, wellCz + wellHz - 0.09, 2 * wellHx, 0.18],
      [wellCx - wellHx + 0.09, wellCz, 0.18, 2 * wellHz],
      [wellCx + wellHx - 0.09, wellCz, 0.18, 2 * wellHz]]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), matHazard);
      strip.position.set(px, hiElev + 0.011, pz);
      this.scene.add(strip);
    }
    // stepped balustrades down the OUTER edge of each flight: three panel
    // segments per flight that follow the descent, collision-true (the old
    // build had a floating bar and invisible posts — and let you bail off
    // the side into a clip-back)
    const SEGS = 3;
    const stepGuard = (xEdge, yAt) => {
      for (let s = 0; s < SEGS; s++) {
        const z0 = (wellCz - wellHz) + (s / SEGS) * 2 * wellHz;
        const z1 = (wellCz - wellHz) + ((s + 1) / SEGS) * 2 * wellHz;
        const yLo = Math.min(yAt(z0), yAt(z1));
        const yHi = Math.max(yAt(z0), yAt(z1)) + RAIL_H;
        guard(xEdge, (yLo + yHi) / 2, (z0 + z1) / 2, T, yHi - yLo, z1 - z0);
      }
    };
    const tOf = (z) => (z - (wellCz - wellHz)) / (2 * wellHz);
    stepGuard(wellCx - wellHx + T / 2, (z) => hiElev - (hiElev - midElev) * tOf(z)); // flight A outer
    stepGuard(wellCx + wellHx - T / 2, (z) => loElev + (midElev - loElev) * tOf(z)); // flight B outer
    // sloped soffit closing the underside of each flight (visual — from the
    // hangar the stairs read as a solid structure, not floating treads)
    const run = 2 * wellHz, rise = hiElev - midElev;
    const soffitLen = Math.hypot(run, rise);
    const mkSoffit = (xLo, xHi, yMid, slopeSign) => {
      const s = new THREE.Mesh(new THREE.BoxGeometry(xHi - xLo, 0.1, soffitLen), matStep);
      s.position.set((xLo + xHi) / 2, yMid - 0.28, wellCz);
      s.rotation.x = Math.atan2(rise, run) * slopeSign;
      this.scene.add(s);
    };
    mkSoffit(wellCx - wellHx, wellCx, (hiElev + midElev) / 2, 1);   // under flight A
    mkSoffit(wellCx, wellCx + wellHx, (midElev + loElev) / 2, -1);  // under flight B
    // fascia beam under the landing's leading edge
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(2 * wellHx, 0.34, 0.1), matStep);
    fascia.position.set(wellCx, midElev - 0.24, wellCz + wellHz - 2.0);
    this.scene.add(fascia);
    // landing back guard: past the well's rear edge at mid height is open
    // hangar airspace under the entry ring — wall it off (also gives the
    // switchback a proper backdrop instead of a void)
    guard(wellCx, midElev + RAIL_H / 2, wellCz + wellHz - T / 2, 2 * wellHx, RAIL_H, T);

    // STAIR TOWER ENCLOSURE (user: from the hangar the mid-landing read as
    // a mysterious raised deck "a level up", unreachable, with NPCs
    // clipping through its walls). The hangar-level volume under the
    // stairs is now a proper enclosed stair housing: solid panel walls on
    // all faces except the stair mouth at flight B's foot (front-right),
    // which is the legitimate way in and out. Collision-true, so nothing
    // walks through the sides anymore.
    const TW = 0.12;
    const wallV = (px, pz, w, h, d, yBase = loElev) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matPanel);
      m.position.set(px, yBase + h / 2, pz);
      this.scene.add(m);
      this.wallMeshes.push(m);
    };
    // front-left face: under flight A's high end — full height to the ring
    wallV(wellCx - wellHx / 2, wellCz - wellHz - TW / 2, wellHx, hiElev - loElev, TW);
    // back face: under the landing, floor to the landing slab
    wallV(wellCx, wellCz + wellHz + TW / 2, 2 * wellHx + 2 * TW, midElev - loElev, TW);
    // left face: closes under flight A completely
    wallV(wellCx - wellHx - TW / 2, wellCz, TW, hiElev - loElev, 2 * wellHz + 2 * TW);
    // right face: stepped under flight B's soffit line (tall at the back,
    // vanishing at the stair foot — the mouth stays open)
    for (let s = 0; s < 3; s++) {
      const z0 = (wellCz - wellHz) + (s / 3) * 2 * wellHz;
      const z1 = (wellCz - wellHz) + ((s + 1) / 3) * 2 * wellHz;
      const zc = (z0 + z1) / 2;
      const top = loElev + (midElev - loElev) * ((zc - (wellCz - wellHz)) / (2 * wellHz)) - 0.12;
      if (top - loElev < 0.4) continue;
      wallV(wellCx + wellHx + TW / 2, zc, TW, top - loElev, z1 - z0);
    }
    // mouth header: a beam over the stair foot so the opening reads framed
    {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(wellHx + 0.3, 0.3, 0.16), matStep);
      beam.position.set(wellCx + wellHx / 2, loElev + CLEAR_H - 0.2, wellCz - wellHz - 0.08);
      this.scene.add(beam);
    }
  }

  // Render-side dodge for bodies whose SIM position crosses the enclosed
  // stair-tower footprint at hangar level (the sim's straight-line transit
  // knows nothing about the housing): slide the visible body out through
  // the nearest face; the mouth strip at the stair foot stays legal.
  clampStairTower(deck, wx, wz) {
    for (const g of (this.stairRooms ?? [])) {
      if (deck !== g.deck + 1) continue;
      const m = 0.25;
      if (wx < g.wellCx - g.wellHx - m || wx > g.wellCx + g.wellHx + m
        || wz < g.wellCz - g.wellHz - m || wz > g.wellCz + g.wellHz + m) continue;
      if (wx > g.wellCx - 0.2 && wz < g.wellCz - g.wellHz + 1.8) continue; // the mouth
      const dW = wx - (g.wellCx - g.wellHx), dE = (g.wellCx + g.wellHx) - wx;
      const dN = wz - (g.wellCz - g.wellHz), dS = (g.wellCz + g.wellHz) - wz;
      const min = Math.min(dW, dE, dN, dS);
      if (min === dN) wz = g.wellCz - g.wellHz - 0.45;
      else if (min === dS) wz = g.wellCz + g.wellHz + 0.45;
      else if (min === dW) wx = g.wellCx - g.wellHx - 0.45;
      else wx = g.wellCx + g.wellHx + 0.45;
    }
    return [wx, wz];
  }

  // Same dodge for the GRAND STAIR WELL at entry level (user: NPCs clop
  // straight through the balustrade panels and pop onto the flights): a
  // body in the stair ROOM whose sim position crosses the well rect — park
  // slots, combat repositioning, straight-line room transits — slides out
  // through the nearest rail line. Bodies genuinely DESCENDING (their move
  // is the stairwell edge, following _stairWaypoints) are exempt — the
  // caller checks that and skips the clamp.
  clampStairWell(deck, wx, wz) {
    for (const g of (this.stairRooms ?? [])) {
      if (deck !== g.deck) continue;
      const m = 0.3;
      if (wx < g.wellCx - g.wellHx - m || wx > g.wellCx + g.wellHx + m
        || wz < g.wellCz - g.wellHz - m || wz > g.wellCz + g.wellHz + m) continue;
      const dW = wx - (g.wellCx - g.wellHx), dE = (g.wellCx + g.wellHx) - wx;
      const dN = wz - (g.wellCz - g.wellHz), dS = (g.wellCz + g.wellHz) - wz;
      const min = Math.min(dW, dE, dN, dS);
      if (min === dN) wz = g.wellCz - g.wellHz - 0.5;
      else if (min === dS) wz = g.wellCz + g.wellHz + 0.5;
      else if (min === dW) wx = g.wellCx - g.wellHx - 0.5;
      else wx = g.wellCx + g.wellHx + 0.5;
    }
    return [wx, wz];
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

  // HALO-STYLE DOOR TEXTURE (user: doors need to look like legit Halo
  // doors): brushed gunmetal, recessed panel grooves, a hazard-chevron
  // band, corner bolts. The damaged variant carries scorch blotches and
  // gouges for the jammed/broken doors that used to just glow red.
  _doorTexture(damaged) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const x = c.getContext('2d');
    const g0 = x.createLinearGradient(0, 0, 0, 256);
    g0.addColorStop(0, '#3d4550'); g0.addColorStop(0.5, '#49525e'); g0.addColorStop(1, '#39414c');
    x.fillStyle = g0; x.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 90; i++) {
      x.fillStyle = `rgba(${(i * 29) % 2 ? '255,255,255' : '0,0,0'},0.035)`;
      x.fillRect((i * 37) % 128, 0, 1, 256);
    }
    for (const gy of [38, 120, 206]) {
      x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(6, gy, 116, 3);
      x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(6, gy + 3, 116, 1);
    }
    x.save();
    x.beginPath(); x.rect(6, 138, 116, 26); x.clip();
    for (let i = -2; i < 10; i++) {
      x.fillStyle = i % 2 ? '#151517' : '#c7952c';
      x.beginPath();
      x.moveTo(i * 24, 164); x.lineTo(i * 24 + 24, 138);
      x.lineTo(i * 24 + 36, 138); x.lineTo(i * 24 + 12, 164);
      x.closePath(); x.fill();
    }
    x.restore();
    x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(0, 0, 5, 256); x.fillRect(123, 0, 5, 256);
    x.fillStyle = 'rgba(255,255,255,0.18)';
    for (const [bx, by] of [[12, 14], [116, 14], [12, 242], [116, 242], [12, 128], [116, 128]]) {
      x.beginPath(); x.arc(bx, by, 2.5, 0, 7); x.fill();
    }
    if (damaged) {
      for (let i = 0; i < 7; i++) {
        const cx2 = 20 + (i * 53) % 90, cy2 = 20 + (i * 89) % 216, r = 14 + (i * 31) % 26;
        const gr = x.createRadialGradient(cx2, cy2, 2, cx2, cy2, r);
        gr.addColorStop(0, 'rgba(8,6,4,0.85)');
        gr.addColorStop(0.6, 'rgba(15,10,6,0.5)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = gr;
        x.beginPath(); x.arc(cx2, cy2, r, 0, 7); x.fill();
      }
      x.strokeStyle = 'rgba(10,8,6,0.7)'; x.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        x.beginPath();
        x.moveTo(10 + i * 30, 40 + (i * 61) % 170);
        x.lineTo(40 + i * 22, 80 + (i * 97) % 150);
        x.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // SPLIT SLIDING DOORS (user: opening down the middle and sliding to the
  // side, with actual texture). Two half-panels per door meet at a center
  // seam and slide apart into the walls. ALL panels live in two
  // InstancedMeshes (clean + scorched) — door draw calls went DOWN versus
  // the old one-mesh-per-door build. Frames (jambs + lintel) are static
  // world-space meshes, so the merge pass batches them per deck. A status
  // lamp above each face burns green (open track), red (sealed) or
  // guttering amber (jammed/burning).
  _buildDoors() {
    const g = this.graph;
    const entries = [];
    for (const e of g.edges) {
      if (!e.door) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck) continue;
      const deck = a.deck, elev = elevOf(deck);
      const [dx, dz] = this.simToWorld(e.door.x, e.door.y, deck);
      // PANEL LIES ALONG ITS WALL (user report: doors turned 90°) — same
      // orientation logic as the old build. Throat doors face the throat.
      let phi;
      if (e.doorA && e.doorB && !e.shared) {
        phi = Math.atan2(e.doorB.y - e.doorA.y, e.doorB.x - e.doorA.x) + Math.PI / 2;
      } else {
        const xov = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const yov = Math.min(a.y + a.d / 2, b.y + b.d / 2) - Math.max(a.y - a.d / 2, b.y - b.d / 2);
        phi = xov >= yov ? 0 : Math.PI / 2;
      }
      entries.push({ e, deck, elev, dx, dz, phi });
    }
    const PW = DOOR_W / 2 + 0.06;   // each half overlaps the seam slightly
    const PH = CLEAR_H - 0.12;
    this._doorPW = PW; this._doorPH = PH;
    const geo = new THREE.BoxGeometry(PW, PH, 0.15);
    const matOk = new THREE.MeshStandardMaterial({
      map: this._doorTexture(false), roughness: 0.52, metalness: 0.55,
    });
    const matBad = new THREE.MeshStandardMaterial({
      map: this._doorTexture(true), color: 0x9a9a9a, roughness: 0.7, metalness: 0.45,
    });
    const nBad = entries.filter((d) => d.e.burning).length;
    this.doorPanels = new THREE.InstancedMesh(geo, matOk, Math.max(1, (entries.length - nBad) * 2));
    this.doorPanelsBad = new THREE.InstancedMesh(geo, matBad, Math.max(1, nBad * 2));
    this.doorPanels.count = (entries.length - nBad) * 2;
    this.doorPanelsBad.count = nBad * 2;
    this.doorPanels.frustumCulled = false;
    this.doorPanelsBad.frustumCulled = false;
    this.scene.add(this.doorPanels, this.doorPanelsBad);
    this.doorPanelMeshes = [this.doorPanels, this.doorPanelsBad];
    // frames — static, auto-merged (shared material, world-space meshes)
    const matFrame = new THREE.MeshStandardMaterial({ color: 0x272d36, roughness: 0.6, metalness: 0.5 });
    // status lamps — unlit so they read at full brightness in the dark;
    // per-instance color carries the door state
    const lampGeo = new THREE.BoxGeometry(0.34, 0.07, 0.07);
    this.doorLamps = new THREE.InstancedMesh(lampGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, entries.length * 2));
    this.doorLamps.count = entries.length * 2;
    this.doorLamps.frustumCulled = false;
    this.scene.add(this.doorLamps);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3();
    const S = new THREE.Vector3(1, 1, 1), E = new THREE.Euler();
    let okSlot = 0, badSlot = 0, lampSlot = 0;
    for (const d of entries) {
      const { e, elev, dx, dz, phi } = d;
      const ux = Math.cos(phi), uz = Math.sin(phi);    // along the doorway
      const px = -Math.sin(phi), pz = Math.cos(phi);   // through the doorway
      // jambs + lintel
      for (const s of [-1, 1]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.26, CLEAR_H + 0.2, 0.34), matFrame);
        jamb.position.set(dx + ux * s * (DOOR_W / 2 + 0.14), elev + (CLEAR_H + 0.2) / 2, dz + uz * s * (DOOR_W / 2 + 0.14));
        jamb.rotation.y = -phi;
        this.scene.add(jamb);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + 0.78, 0.26, 0.34), matFrame);
      lintel.position.set(dx, elev + CLEAR_H + 0.08, dz);
      lintel.rotation.y = -phi;
      this.scene.add(lintel);
      // status lamps on both faces of the lintel
      const lampSlots = [];
      for (const s of [-1, 1]) {
        E.set(0, -phi, 0); Q.setFromEuler(E);
        P.set(dx + px * s * 0.21, elev + CLEAR_H - 0.06, dz + pz * s * 0.21);
        M.compose(P, Q, S);
        this.doorLamps.setMatrixAt(lampSlot, M);
        lampSlots.push(lampSlot++);
      }
      const bad = !!e.burning;
      const rec = {
        edge: e, deck: d.deck, x: dx, z: dz, phi, elev,
        bad, slots: bad ? [badSlot++, badSlot++] : [okSlot++, okSlot++],
        lampSlots, open01: 0,
        // deterministic buckle for the jammed doors (user: broken doors
        // being just red is unrealistic) — a slight ajar gap and tilt
        buckle: bad ? {
          gap: 0.10 + ((e.i * 2654435761 >>> 8) % 100) / 100 * 0.14,
          tilt: (((e.i * 40503 >>> 4) % 7) - 3) * 0.014,
        } : null,
      };
      this.doors.push(rec);
      this._stampDoor(rec);
      this._setLamp(rec);
    }
    this.doorPanels.instanceMatrix.needsUpdate = true;
    this.doorPanelsBad.instanceMatrix.needsUpdate = true;
    this.doorLamps.instanceColor.needsUpdate = true;
  }

  _stampDoor(d) {
    const mesh = d.bad ? this.doorPanelsBad : this.doorPanels;
    const PW = this._doorPW, PH = this._doorPH;
    const M = (this._dm ??= new THREE.Matrix4());
    const Q = (this._dq ??= new THREE.Quaternion());
    const P = (this._dp ??= new THREE.Vector3());
    const S = (this._ds ??= new THREE.Vector3());
    const E = (this._de ??= new THREE.Euler());
    const ux = Math.cos(d.phi), uz = Math.sin(d.phi);
    const slide = d.open01 * (DOOR_W / 2 + 0.22);
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      let off = side * (PW / 2 - 0.03 + slide);
      let tilt = 0;
      if (d.buckle) { off += side * d.buckle.gap / 2; tilt = side * d.buckle.tilt; }
      E.set(0, -d.phi, tilt);
      Q.setFromEuler(E);
      P.set(d.x + ux * off, d.elev + PH / 2, d.z + uz * off);
      M.compose(P, Q, S.set(1, 1, 1));
      mesh.setMatrixAt(d.slots[k], M);
    }
  }

  _setLamp(d) {
    const c = (this._dc ??= new THREE.Color());
    // muted status colors (user: the bright red sealed doors were too
    // obvious — the buckle/scorch and a dim ember lamp carry it now)
    if (d.bad) c.setHex(0xd77a1c);                    // jammed: amber gutter
    else if (d.edge.locked) c.setHex(0x7d1d12);       // sealed: dim ember
    else c.setHex(0x38d06a);                          // powered track: green
    for (const s of d.lampSlots) this.doorLamps.setColorAt(s, c);
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
        this._addMouth(n.idx, px, py);
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
    // every vent opening is an emerge point — including ones that parallel a
    // doorway (the door IS the opening there; no grate mesh, but a crawler
    // still surfaces at that spot)
    for (const v of g.vents) {
      const a0 = g.node(v.a), b0 = g.node(v.b);
      for (const [n, pt] of [[a0, v.doorA], [b0, v.doorB]]) {
        const d = pt ?? v.door;
        if (d) this._addMouth(n.idx, d.x, d.y);
      }
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
      // unlit rooms are veiled from OUTSIDE too — but NOT flat black (user:
      // light transfers between rooms). A dead-fixture room's veil is thin
      // enough that the doorway spill light pooling inside it reads through;
      // flood-held murk stays near-opaque (the growth eats the light).
      const fixtureDead = (this.roomLights[n]?.lvl ?? 1) <= 0.1;
      const target = n === playerNode ? 0
        : sim.darkAt(n) ? (fog ? 0.96 : 0.88)
        : fixtureDead ? 0.5 : 0;
      const m = veil.material;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 2.5);
      veil.visible = m.opacity > 0.03;
      // spore fog reads green-brown, plain darkness reads black
      m.color.setHex(fog ? 0x18200c : 0x000000);
      // an overgrown room's fixture dies with it — and its sign fades into
      // the dark instead of glowing through the murk
      const L = this.roomLights[n];
      if (L && sim.darkAt(n)) { L.lvl = 0.02; L.mat.emissiveIntensity = 0.02; }
      // even the battery lamps die when the growth takes the room
      if (L?.emMat) L.emMat.emissiveIntensity = sim.darkAt(n) ? 0.04 : 2.4;
      const sign = this.roomSigns?.[n];
      if (sign) sign.material.opacity = sim.darkAt(n) ? 0.06 : 0.95;
    }
  }

  updateDoors(dt, movers, nMovers = movers.length) {
    const r2 = DOORS.openRadius * DOORS.openRadius;
    let anyStamp = false;
    // bucket movers by deck once (perf pass 2): the per-door scan only
    // walks its own deck's movers instead of all ~200 every time
    const byDeck = (this._moversByDeck ??= [[], [], [], [], [], []]);
    for (const b of byDeck) b.length = 0;
    for (let i = 0; i < nMovers; i++) {
      const m = movers[i];
      (byDeck[m.deck] ?? (byDeck[m.deck] = [])).push(m);
    }
    const flick = Math.sin(performance.now() * 0.013) * Math.sin(performance.now() * 0.0037);
    for (const d of this.doors) {
      // doors change lock state MID-GAME now (armory seal release, and the
      // sim's jam/unjam rotation) — flip the status lamp both ways
      if (!d.edge.locked && d._lampLocked !== false) {
        d._lampLocked = false;
        this._setLamp(d);
        this.doorLamps.instanceColor.needsUpdate = true;
      } else if (d.edge.locked && d._lampLocked !== true) {
        d._lampLocked = true;
        this._setLamp(d);
        this.doorLamps.instanceColor.needsUpdate = true;
      }
      // jammed doors gutter — the amber lamp flickers with the damage
      if (d.bad && (performance.now() & 63) < 16) {
        const c = (this._dc ??= new THREE.Color());
        c.setHex(0xd77a1c).multiplyScalar(0.55 + 0.45 * Math.abs(flick));
        for (const s of d.lampSlots) this.doorLamps.setColorAt(s, c);
        this.doorLamps.instanceColor.needsUpdate = true;
      }
      let want = 0;
      if (!d.edge.locked) {
        const list = byDeck[d.deck] ?? [];
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          const ddx = m.x - d.x, ddz = m.z - d.z;
          if (ddx * ddx + ddz * ddz < r2) { want = 1; break; }
        }
      }
      const rate = DOORS.slideSpeed / (CLEAR_H - 0.3);
      const was = d.open01;
      d.open01 += Math.sign(want - d.open01) * Math.min(Math.abs(want - d.open01), rate * dt);
      // report open/close starts so the game can voice the hiss
      if (was <= 0.03 && d.open01 > 0.03) this.doorEvents.push({ x: d.x, z: d.z, deck: d.deck });
      if (d.open01 !== was) { this._stampDoor(d); anyStamp = true; }
    }
    if (anyStamp) {
      this.doorPanels.instanceMatrix.needsUpdate = true;
      this.doorPanelsBad.instanceMatrix.needsUpdate = true;
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
