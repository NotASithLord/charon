// 3D world extruded from the meter-true ship plan (docs/ROADMAP-3D.md §1).
// The sim graph stays authoritative: rooms are their authored w × d rects,
// doors are the sim's computed door points cut into the shared walls, and
// walkability is answered in SIM coordinates so the player and the sim agree
// about where anyone can stand.

import * as THREE from './vendor/three.module.js';

export const DECK_H = 4.2;      // deck-to-deck (matches ship data)
export const CLEAR_H = 3.0;     // floor-to-ceiling clear height
export const DOOR_W = 1.7;      // doorway opening width
const WALL_T = 0.16;

export function elevOf(deck) { return (5 - deck) * DECK_H; }

function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2));
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

export class World {
  constructor(scene, graph) {
    this.graph = graph;
    this.scene = scene;
    this.pads = []; // lift/ladder teleport pads {deck, x, z, node, toNode, toDeck, tx, tz, kind}
    this._bandC = graph.deckBands.map((b) => (b.y0 + b.y1) / 2);
    this._build();
  }

  bandCenter(deck) { return this._bandC[deck - 1]; }
  // sim schematic (x, y@deck) -> world (x, z)
  simToWorld(sx, sy, deck) { return [sx, sy - this.bandCenter(deck)]; }
  worldToSim(wx, wz, deck) { return [wx, wz + this.bandCenter(deck)]; }

  // procedural panel texture: deck plating / wall panels with seam lines so
  // motion and depth read even under flat lighting
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
    // rivets
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
    const matWall = new THREE.MeshStandardMaterial({ map: wallTexBase, color: 0xaebdd8, roughness: 0.7, metalness: 0.5 });
    const matCeil = new THREE.MeshStandardMaterial({ color: 0x141a26, emissive: 0x2a3a58, emissiveIntensity: 0.35, roughness: 1, side: THREE.DoubleSide });
    const matLocked = new THREE.MeshStandardMaterial({
      color: 0x7a1f1f, emissive: 0xa03020, emissiveIntensity: 0.7,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    });
    const matLift = new THREE.MeshStandardMaterial({ color: 0x1e4b56, emissive: 0x2fd7f0, emissiveIntensity: 0.8 });
    const matLadder = new THREE.MeshStandardMaterial({ color: 0x54401e, emissive: 0xf0a52f, emissiveIntensity: 0.6 });
    const matBreach = new THREE.MeshStandardMaterial({ color: 0x521c12, emissive: 0xff5533, emissiveIntensity: 0.5 });

    // per-node door openings, in sim coords, grouped by which wall side
    for (const n of g.nodes) {
      const deck = n.deck, elev = elevOf(deck);
      const [wx, wz] = this.simToWorld(n.x, n.y, deck);
      const isBreach = n.idx === g.breachNode;

      // floor + ceiling + signage
      const tint = isBreach ? 0xff8866 : g.unpowered[n.idx] ? 0x4a5261 : (n.type === 'corridor' ? 0xbccbe4 : 0x9daabf);
      const floor = new THREE.Mesh(new THREE.BoxGeometry(n.w, 0.12, n.d), mkFloorMat(n.w, n.d, tint));
      floor.position.set(wx, elev - 0.06, wz);
      this.scene.add(floor);
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(n.w, n.d), matCeil);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(wx, elev + CLEAR_H, wz);
      this.scene.add(ceil);
      const sign = this._label(n.name);
      sign.position.set(wx, elev + CLEAR_H - 0.45, wz);
      this.scene.add(sign);

      // openings on each side: project each same-deck door point onto the
      // nearest wall of this rect
      const sides = { N: [], S: [], W: [], E: [] }; // N = -z, S = +z, W = -x, E = +x
      for (const e of g.edges) {
        if (!e.door) continue;
        if (e.a !== n.idx && e.b !== n.idx) continue;
        const other = g.node(e.a === n.idx ? e.b : e.a);
        if (other.deck !== deck) continue;
        const [dx, dz] = this.simToWorld(e.door.x, e.door.y, deck);
        // distance to each wall
        const dN = Math.abs((wz - n.d / 2) - dz), dS = Math.abs((wz + n.d / 2) - dz);
        const dW = Math.abs((wx - n.w / 2) - dx), dE = Math.abs((wx + n.w / 2) - dx);
        const m = Math.min(dN, dS, dW, dE);
        if (m === dN) sides.N.push({ at: dx, edge: e });
        else if (m === dS) sides.S.push({ at: dx, edge: e });
        else if (m === dW) sides.W.push({ at: dz, edge: e });
        else sides.E.push({ at: dz, edge: e });
      }
      const wallRuns = [
        { key: 'N', horiz: true, fixed: wz - n.d / 2, from: wx - n.w / 2, to: wx + n.w / 2 },
        { key: 'S', horiz: true, fixed: wz + n.d / 2, from: wx - n.w / 2, to: wx + n.w / 2 },
        { key: 'W', horiz: false, fixed: wx - n.w / 2, from: wz - n.d / 2, to: wz + n.d / 2 },
        { key: 'E', horiz: false, fixed: wx + n.w / 2, from: wz - n.d / 2, to: wz + n.d / 2 },
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
          // locked doors get a glowing barrier pane in the opening
          if (c.edge.locked) {
            const pane = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, CLEAR_H - 0.2), matLocked);
            if (run.horiz) pane.position.set(c.at, elev + CLEAR_H / 2, run.fixed);
            else { pane.position.set(run.fixed, elev + CLEAR_H / 2, c.at); pane.rotation.y = Math.PI / 2; }
            pane.userData.edge = c.edge;
            this.scene.add(pane);
          }
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
        }
      }
    }

    // doorway throats: the span between two footprints is a real short
    // tunnel — floor, sides and lintel — so standing in a doorway is
    // standing somewhere, not floating in the void between boxes
    for (const e of g.edges) {
      if (!e.door || !e.doorA) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck) continue;
      const deck = a.deck, elev = elevOf(deck);
      const [ax, az] = this.simToWorld(e.doorA.x, e.doorA.y, deck);
      const [bx, bz] = this.simToWorld(e.doorB.x, e.doorB.y, deck);
      const dx = bx - ax, dz = bz - az;
      const len = Math.max(0.6, Math.hypot(dx, dz)) + 0.5;
      const cx = (ax + bx) / 2, cz = (az + bz) / 2;
      const ang = -Math.atan2(dz, dx);
      const px = -dz / (len - 0.5 || 1), pz = dx / (len - 0.5 || 1); // unit perpendicular
      const mk = (geo, mat, ox, oy, oz) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(cx + ox, elev + oy, cz + oz);
        m.rotation.y = ang;
        this.scene.add(m);
      };
      mk(new THREE.BoxGeometry(len, 0.12, DOOR_W), matWall, 0, -0.06, 0);            // sill floor
      mk(new THREE.BoxGeometry(len, 0.12, DOOR_W), matCeil, 0, CLEAR_H - 0.25, 0);   // lintel
      mk(new THREE.BoxGeometry(len, CLEAR_H, 0.12), matWall, px * DOOR_W / 2, CLEAR_H / 2, pz * DOOR_W / 2);
      mk(new THREE.BoxGeometry(len, CLEAR_H, 0.12), matWall, -px * DOOR_W / 2, CLEAR_H / 2, -pz * DOOR_W / 2);
    }

    // lift/ladder pads for every cross-deck standard edge
    for (const e of g.edges) {
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck === b.deck) continue;
      const mk = (from, to) => {
        const fromDeck = from.deck;
        const px = Math.max(from.x - from.w / 2 + 1.2, Math.min(from.x + from.w / 2 - 1.2, to.x));
        const [wx, wz] = this.simToWorld(px, from.y, fromDeck);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.1, 20),
          e.type === 'lift' ? matLift : matLadder);
        pad.position.set(wx, elevOf(fromDeck) + 0.05, wz);
        this.scene.add(pad);
        return { deck: fromDeck, x: wx, z: wz, node: from.idx };
      };
      const pa = mk(a, b), pb = mk(b, a);
      this.pads.push({ ...pa, toDeck: pb.deck, tx: pb.x, tz: pb.z, toNode: pb.node, kind: e.type, edge: e });
      this.pads.push({ ...pb, toDeck: pa.deck, tx: pa.x, tz: pa.z, toNode: pa.node, kind: e.type, edge: e });
    }
  }

  // --- walkability, answered in sim coords (x, schematic y) per deck ---
  isWalkable(deck, sx, sy) {
    const g = this.graph;
    for (const n of g.nodes) {
      if (n.deck !== deck) continue;
      const m = 0.35;
      if (sx > n.x - n.w / 2 + m && sx < n.x + n.w / 2 - m
        && sy > n.y - n.d / 2 + m && sy < n.y + n.d / 2 - m) return true;
    }
    // doorway throats (only through unlocked doors): a capsule along the
    // span from one room's wall to the other's
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

  padNear(deck, wx, wz) {
    for (const p of this.pads) {
      if (p.deck !== deck) continue;
      const dx = wx - p.x, dz = wz - p.z;
      if (dx * dx + dz * dz < 1.0) return p;
    }
    return null;
  }
}
