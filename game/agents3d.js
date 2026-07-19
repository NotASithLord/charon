// Renders every sim agent in 3D straight from the AgentBuffer + sim state.
// Faction bodies are simple primitives for the slice — the shapes and cues
// (charge stretch, swelling carrier, hosted weapon, tracers, muzzle flashes)
// are all driven by sim flags, per the fidelity contract (ROADMAP-3D §4).

import * as THREE from './vendor/three.module.js';
import { FACTION, FLAG } from '../shared/agentBuffer.js';
import { elevOf } from './world.js';
import { carryGeometry } from './rifle-model.js';
import { characterParts } from './characters.js';

const CAP = 512;

function makeInstanced(scene, geo, color, emissive = 0x000000, emissiveIntensity = 0.4) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15, emissive, emissiveIntensity });
  const mesh = new THREE.InstancedMesh(geo, mat, CAP);
  mesh.count = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

export class Agents3D {
  constructor(scene, sim, world) {
    this.sim = sim;
    this.world = world;
    this.scene = scene;
    this.rpos = new Map(); // id -> smoothed {x, y(z-sim), deck}
    this.playerId = -1;

    // REAL SKINS (user note): converted Halo character meshes — H2 marines/
    // crew/infection form, H3 flood combat forms (civilian + ODST hosts) —
    // drawn as one InstancedMesh per texture group, feet at y=0. The
    // carrier keeps its procedural swelling body (no source mesh exists),
    // corpses stay simple boxes.
    const mkSet = (name) => characterParts(name).map((p) => {
      const mat = new THREE.MeshStandardMaterial({
        map: p.texture, roughness: 0.78, metalness: 0.06, side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(p.geometry, mat, CAP);
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
    this.civSet = mkSet('civilian');
    this.armedSet = mkSet('crew_armed');
    this.marineSet = mkSet('marine');
    this.infectionSet = mkSet('infection');
    this.combatCivSet = mkSet('combat_civ');
    this.combatOdstSet = mkSet('combat_odst');
    this.carrier = makeInstanced(scene, new THREE.SphereGeometry(0.72, 12, 10), 0x9a5cc0, 0x5b2a80, 0.7);
    this.corpse = makeInstanced(scene, new THREE.BoxGeometry(1.5, 0.28, 0.55), 0x5a5a5a);
    // real MA5 silhouette (first-strike asset), merged grip+gun, one draw
    // call for every carried rifle on the ship (marines, armed crew, armed
    // combat forms) — see game/rifle-model.js
    this.rifle = makeInstanced(scene, carryGeometry(), 0xc9d4e2);

    // combat FX: tracers + muzzle flashes. Flood fire (a hostArmed combat
    // form emptying its stolen rifle) gets its own sickly-green tracer so
    // it visibly reads as THEM shooting, not human gunfire.
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(256 * 6), 3));
    this.tracers = new THREE.LineSegments(tGeo,
      new THREE.LineBasicMaterial({ color: 0xffe08c, transparent: true, opacity: 0.85 }));
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 6), 3));
    this.floodTracers = new THREE.LineSegments(fGeo,
      new THREE.LineBasicMaterial({ color: 0x9dff6a, transparent: true, opacity: 0.85 }));
    this.floodTracers.frustumCulled = false;
    scene.add(this.floodTracers);
    this.flash = makeInstanced(scene, new THREE.SphereGeometry(0.14, 6, 5), 0xfff2c8, 0xffdf8a, 3.0);
    this.floodFlash = makeInstanced(scene, new THREE.SphereGeometry(0.13, 6, 5), 0xd8ffc0, 0x8fef5a, 3.0);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._playerShots = []; // {ax,ay,az,bx,by,bz,ttl}
  }

  // transient tracer for the player's own rifle
  playerShot(from, to) {
    this._playerShots.push({ ax: from.x, ay: from.y, az: from.z, bx: to.x, by: to.y, bz: to.z, ttl: 0.09 });
  }

  update(dt) {
    const { sim, world } = this;
    const buf = sim.buffer;
    const k = Math.min(1, dt * 14);
    const counts = { civ: 0, armed: 0, marine: 0, infection: 0, combatCiv: 0, combatOdst: 0, carrier: 0, corpse: 0, rifle: 0, flash: 0 };
    const stamp = (set, i) => { for (const mesh of set) mesh.setMatrixAt(i, this._m); };

    const seen = new Set();
    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      seen.add(id);
      const deck = buf.posZ[i]; // sim writes deck into posZ
      let rp = this.rpos.get(id);
      if (!rp || rp.deck !== deck) { rp = { x: buf.posX[i], y: buf.posY[i], deck }; this.rpos.set(id, rp); }
      else { rp.x += (buf.posX[i] - rp.x) * k; rp.y += (buf.posY[i] - rp.y) * k; }
    }
    if (this.rpos.size > buf.count * 2) {
      for (const id of this.rpos.keys()) if (!seen.has(id)) this.rpos.delete(id);
    }

    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      if (id === this.playerId) continue; // first person — don't draw your own body
      const f = buf.faction[i];
      const flags = buf.flags[i];
      const rp = this.rpos.get(id);
      const deck = rp.deck;
      const [wx, wz] = world.simToWorld(rp.x, rp.y, deck);
      const elev = elevOf(deck);
      const heading = -buf.headingR[i];

      if (f === FACTION.CORPSE) {
        this._e.set(0, (id * 2.399963) % (Math.PI * 2), 0);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(wx, elev + 0.15, wz), this._q, this._s.set(1, 1, 1));
        this.corpse.setMatrixAt(counts.corpse++, this._m);
        continue;
      }
      const downed = flags & FLAG.DOWNED;
      if (downed) { // downed combat forms lie flat
        this._e.set(-Math.PI / 2, heading, 0);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(wx, elev + 0.25, wz), this._q, this._s.set(1, 1, 1));
        if (flags & FLAG.ARMED_HOST) stamp(this.combatOdstSet, counts.combatOdst++);
        else stamp(this.combatCivSet, counts.combatCiv++);
        continue;
      }

      switch (f) {
        case FACTION.CIVILIAN: {
          this._pose(wx, elev, wz, heading, 1, 1, 1);
          stamp(this.civSet, counts.civ++);
          break;
        }
        case FACTION.ARMED: {
          this._pose(wx, elev, wz, heading, 1, 1, 1);
          stamp(this.armedSet, counts.armed++);
          this._rifleAt(wx, elev + 1.15, wz, heading);
          this.rifle.setMatrixAt(counts.rifle++, this._m);
          break;
        }
        case FACTION.MARINE: {
          this._pose(wx, elev, wz, heading, 1, 1, 1);
          stamp(this.marineSet, counts.marine++);
          this._rifleAt(wx, elev + 1.25, wz, heading);
          this.rifle.setMatrixAt(counts.rifle++, this._m);
          break;
        }
        case FACTION.INFECTION: {
          const pulse = 1 + Math.sin(this.sim.t * 7 + id) * 0.15;
          this._pose(wx, elev, wz, heading, pulse, pulse, pulse);
          stamp(this.infectionSet, counts.infection++);
          break;
        }
        case FACTION.COMBAT: {
          const charging = flags & FLAG.CHARGING;
          // charge: lean hard forward, stretched stride
          this._e.set(charging ? 0.55 : 0.18, heading, 0);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(wx, elev, wz), this._q,
            this._s.set(1, charging ? 1.1 : 1, charging ? 1.35 : 1));
          if (flags & FLAG.ARMED_HOST) {
            stamp(this.combatOdstSet, counts.combatOdst++);
            this._rifleAt(wx, elev + 1.1, wz, heading);
            this.rifle.setMatrixAt(counts.rifle++, this._m);
          } else {
            stamp(this.combatCivSet, counts.combatCiv++);
          }
          break;
        }
        case FACTION.CARRIER: {
          const held = sim.byId.get(id)?.held ?? 0;
          const cap = sim.P.carrier.maxInfectionForms;
          const s = 0.8 + (held / cap) * 0.7 + (held / cap > 0.6 ? Math.sin(sim.t * 5) * 0.04 : 0);
          this._pose(wx, elev + 0.72 * s, wz, heading, s, s, s);
          this.carrier.setMatrixAt(counts.carrier++, this._m);
          break;
        }
      }
    }

    // tracers + muzzle flashes from live fights
    const pos = this.tracers.geometry.attributes.position;
    let seg = 0;
    const g = sim.graph;
    for (let n = 0; n < g.n && seg < 250; n++) {
      if (sim.tickCount - sim.gunfireTick[n] > 2) continue;
      const occ = sim.occupants(n);
      const shooters = occ.filter((a) => a.hp > 0 && !a.dead && !a.isPlayer &&
        (a.faction === FACTION.MARINE || (a.faction === FACTION.ARMED && a.state === 5)));
      const targets = occ.filter((a) => !a.dead && a.hp > 0 && !a.downed &&
        (a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER || a.faction === FACTION.INFECTION));
      if (!shooters.length || !targets.length) continue;
      for (const sh of shooters) {
        if (seg >= 250) break;
        if ((sh.id + sim.tickCount) % 3 === 0) continue;
        const t = targets[(sh.id + (sim.tickCount >> 1)) % targets.length];
        const sr = this.rpos.get(sh.id), tr = this.rpos.get(t.id);
        if (!sr || !tr) continue;
        const [sx, sz] = this.world.simToWorld(sr.x, sr.y, sr.deck);
        const [tx, tz] = this.world.simToWorld(tr.x, tr.y, tr.deck);
        const ey = elevOf(sr.deck) + 1.3, ty = elevOf(tr.deck) + 0.7;
        pos.setXYZ(seg * 2, sx, ey, sz);
        pos.setXYZ(seg * 2 + 1, tx, ty, tz);
        seg++;
        if (counts.flash < CAP) {
          const dx = tx - sx, dz = tz - sz, dl = Math.hypot(dx, dz) || 1;
          const fs = 0.8 + ((sh.id + sim.tickCount) % 2) * 0.6;
          this._m.compose(this._p.set(sx + dx / dl * 0.6, ey, sz + dz / dl * 0.6),
            this._q.identity(), this._s.set(fs, fs, fs));
          this.flash.setMatrixAt(counts.flash++, this._m);
        }
      }
    }
    // the player's own shots (short-lived tracers from the muzzle)
    this._playerShots = this._playerShots.filter((s) => (s.ttl -= dt) > 0);
    for (const s of this._playerShots) {
      if (seg >= 255) break;
      pos.setXYZ(seg * 2, s.ax, s.ay, s.az);
      pos.setXYZ(seg * 2 + 1, s.bx, s.by, s.bz);
      seg++;
    }
    this.tracers.geometry.setDrawRange(0, seg * 2);
    pos.needsUpdate = true;

    // flood gunfire (user note: armed forms should be VISIBLY shooting) —
    // hostArmed combat forms firing their stolen rifles at humans in the room
    const fpos = this.floodTracers.geometry.attributes.position;
    let fseg = 0;
    counts.floodFlash = 0;
    for (let n = 0; n < g.n && fseg < 125; n++) {
      if (sim.tickCount - sim.gunfireTick[n] > 2) continue;
      const occ = sim.occupants(n);
      const shooters = occ.filter((a) => a.hp > 0 && !a.dead && !a.downed &&
        a.faction === FACTION.COMBAT && a.hostArmed);
      // the player is a legitimate target too — incoming fire should be
      // VISIBLE (tracers converging on you), not silent hp loss
      const targets = occ.filter((a) => !a.dead && a.hp > 0 &&
        (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
      if (!shooters.length || !targets.length) continue;
      for (const sh of shooters) {
        if (fseg >= 125) break;
        if ((sh.id + sim.tickCount) % 3 === 0) continue;
        const t = targets[(sh.id + (sim.tickCount >> 1)) % targets.length];
        const sr = this.rpos.get(sh.id), tr = this.rpos.get(t.id);
        if (!sr || !tr) continue;
        const [sx, sz] = this.world.simToWorld(sr.x, sr.y, sr.deck);
        const [tx, tz] = this.world.simToWorld(tr.x, tr.y, tr.deck);
        const ey = elevOf(sr.deck) + 1.05, ty = elevOf(tr.deck) + 0.9;
        fpos.setXYZ(fseg * 2, sx, ey, sz);
        fpos.setXYZ(fseg * 2 + 1, tx, ty, tz);
        fseg++;
        if (counts.floodFlash < CAP) {
          const dx = tx - sx, dz = tz - sz, dl = Math.hypot(dx, dz) || 1;
          const fs = 0.7 + ((sh.id + sim.tickCount) % 2) * 0.5;
          this._m.compose(this._p.set(sx + dx / dl * 0.6, ey, sz + dz / dl * 0.6),
            this._q.identity(), this._s.set(fs, fs, fs));
          this.floodFlash.setMatrixAt(counts.floodFlash++, this._m);
        }
      }
    }
    this.floodTracers.geometry.setDrawRange(0, fseg * 2);
    fpos.needsUpdate = true;
    this.floodFlash.count = counts.floodFlash;
    this.floodFlash.instanceMatrix.needsUpdate = true;

    for (const [set, c] of [[this.civSet, counts.civ], [this.armedSet, counts.armed],
    [this.marineSet, counts.marine], [this.infectionSet, counts.infection],
    [this.combatCivSet, counts.combatCiv], [this.combatOdstSet, counts.combatOdst]]) {
      for (const mesh of set) { mesh.count = c; mesh.instanceMatrix.needsUpdate = true; }
    }
    for (const [mesh, c] of [[this.carrier, counts.carrier],
    [this.corpse, counts.corpse], [this.rifle, counts.rifle], [this.flash, counts.flash]]) {
      mesh.count = c;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _pose(x, y, z, rotY, sx, sy, sz) {
    this._e.set(0, rotY, 0);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(sx, sy, sz));
  }

  _rifleAt(x, y, z, rotY) {
    this._e.set(0, rotY, 0);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(1, 1, 1));
  }
}
