// Renders every sim agent in 3D straight from the AgentBuffer + sim state.
// Faction bodies are simple primitives for the slice — the shapes and cues
// (charge stretch, swelling carrier, hosted weapon, tracers, muzzle flashes)
// are all driven by sim flags, per the fidelity contract (ROADMAP-3D §4).

import * as THREE from './vendor/three.module.js';
import { FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { elevOf } from './world.js';
import { carryGeometry } from './rifle-model.js';
import { characterParts } from './characters.js';

const CAP = 512;

// CARRIER FORM (user note: "not a blob"): no source mesh exists in the tag
// dump, so this is a sculpted procedural body — a lumpy two-lobed gas sack
// on stubby legs with dorsal feeler stalks, merged into ONE geometry so the
// instanced swell-scaling still works. Feet at y=0.
function carrierGeometry() {
  const parts = [];
  const lumpy = (geo, amp, squashY = 1) => {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = 1 + amp * Math.sin(x * 7.1 + 1.3) * Math.sin(y * 6.3 + 0.7) * Math.sin(z * 5.7 + 2.1);
      pos.setXYZ(i, x * n, y * n * squashY, z * n);
    }
    geo.computeVertexNormals();
    return geo;
  };
  const sack = lumpy(new THREE.SphereGeometry(0.72, 14, 11), 0.17, 0.94);
  sack.translate(0, 1.0, 0);
  parts.push(sack);
  const lobe = lumpy(new THREE.SphereGeometry(0.4, 10, 8), 0.2);
  lobe.translate(0.42, 1.42, 0.08);
  parts.push(lobe);
  const belly = lumpy(new THREE.SphereGeometry(0.34, 9, 7), 0.22);
  belly.translate(-0.35, 0.72, -0.18);
  parts.push(belly);
  for (const [lx, lz, tilt] of [[0.4, 0.32, 0.35], [0.42, -0.3, -0.3], [-0.38, 0.34, 0.3], [-0.4, -0.32, -0.35]]) {
    const leg = new THREE.ConeGeometry(0.15, 0.85, 6);
    leg.rotateX(Math.PI);           // taper to the deck
    leg.rotateZ(tilt * 0.5);
    leg.translate(lx, 0.42, lz);
    parts.push(leg);
  }
  for (let k = 0; k < 4; k++) {
    const st = new THREE.ConeGeometry(0.05, 0.45 + (k % 2) * 0.2, 5);
    st.rotateZ((k - 1.5) * 0.25);
    st.translate(-0.3 + k * 0.2, 1.85, k % 2 ? 0.17 : -0.14);
    parts.push(st);
  }
  let vCount = 0, iCount = 0;
  for (const g of parts) { vCount += g.attributes.position.count; iCount += g.index.count; }
  const pos = new Float32Array(vCount * 3), nrm = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  return merged;
}

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
    // carrier keeps its procedural swelling body (no source mesh exists);
    // corpses are the character meshes laid flat (burned husks stay slabs).
    const mkSet = (name) => characterParts(name).map((p) => {
      const mat = new THREE.MeshStandardMaterial({
        map: p.texture, roughness: 0.78, metalness: 0.06, side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(p.geometry, mat, CAP);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.userData.part = p.part;
      mesh.userData.pivot = p.pivot;
      scene.add(mesh);
      return mesh;
    });
    this.civSet = mkSet('civilian');
    this.armedSet = mkSet('crew_armed');
    this.marineSet = mkSet('marine');
    this.infectionSet = mkSet('infection');
    this.combatCivSet = mkSet('combat_civ');
    this.combatOdstSet = mkSet('combat_odst');
    this.carrier = makeInstanced(scene, carrierGeometry(), 0x8a9a58, 0x46521e, 0.55);
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
    // FLASHLIGHT BEAMS (user rule): marines and armed crew fighting in a
    // flood-darkened room sweep visible torch cones. Additive translucent
    // cone, +X-forward like the carry rifle, one instance per light-bearer
    // standing in a dark room.
    {
      const beamGeo = new THREE.ConeGeometry(0.55, 7, 10, 1, true);
      beamGeo.rotateZ(Math.PI / 2);      // point the cone along +X
      beamGeo.translate(3.5, 0, 0);      // apex at the carrier's hands
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xd8e8ff, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      this.beams = new THREE.InstancedMesh(beamGeo, beamMat, CAP);
      this.beams.count = 0;
      this.beams.frustumCulled = false;
      scene.add(this.beams);
    }
    this.floodFlash = makeInstanced(scene, new THREE.SphereGeometry(0.13, 6, 5), 0xd8ffc0, 0x8fef5a, 3.0);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._mPart = new THREE.Matrix4();
    this._mRot = new THREE.Matrix4();
    this._mOut = new THREE.Matrix4();
    this._downAt = new Map(); // id -> ms when first seen downed (death blend)
    this._playerShots = []; // {ax,ay,az,bx,by,bz,ttl}
  }

  // RUDIMENTARY SKELETAL ANIMATION (user note): each character is six rigid
  // parts cut along its real bone weights; limbs swing about their actual
  // joint pivots (shoulder/hip from the JMS skeleton) with a procedural
  // cycle picked by the sim's animation clip. Pure render-side — the sim's
  // deterministic state is untouched.
  _swingFor(part, clip, t, id) {
    const ph = t * (clip === CLIP.RUN ? 11 : clip === CLIP.ATTACK ? 9 : clip === CLIP.WRITHE ? 13 : 7.2)
      + (id % 7) * 0.9; // strangers walk out of step
    const s = Math.sin(ph);
    switch (clip) {
      case CLIP.WALK:
        if (part === 'legL') return s * 0.5;
        if (part === 'legR') return -s * 0.5;
        if (part === 'armL') return -s * 0.3;
        if (part === 'armR') return s * 0.3;
        if (part === 'head') return Math.sin(ph * 0.5) * 0.04;
        return 0;
      case CLIP.RUN:
        if (part === 'legL') return s * 0.85;
        if (part === 'legR') return -s * 0.85;
        if (part === 'armL') return -s * 0.6;
        if (part === 'armR') return s * 0.6;
        if (part === 'head') return 0.08;
        return 0;
      case CLIP.ATTACK:
        // raised, flailing swipes — claws up and hammering
        if (part === 'armL') return -1.0 + Math.sin(ph * 1.7) * 0.55;
        if (part === 'armR') return -1.0 + Math.sin(ph * 1.7 + 2.1) * 0.55;
        if (part === 'legL') return s * 0.25;
        if (part === 'legR') return -s * 0.25;
        if (part === 'head') return Math.sin(ph) * 0.1;
        return 0;
      case CLIP.WRITHE:
        // infection form: tripod legs skitter, sensory stalks quiver
        if (part === 'legL') return s * 0.35;
        if (part === 'legR') return -s * 0.35;
        if (part === 'head') return Math.sin(ph * 1.3) * 0.25;
        return 0;
      default: // IDLE — breathe
        if (part === 'armL' || part === 'armR') return Math.sin(ph * 0.35 + (part === 'armR' ? 1 : 0)) * 0.04;
        return 0;
    }
  }

  // write base × (pivot-anchored swing) into every part mesh of a set
  _stampAnimated(set, i, clip, animT, id) {
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      const ang = pivot && clip !== CLIP.DEATH ? this._swingFor(mesh.userData.part, clip, animT, id) : 0;
      if (!ang) { mesh.setMatrixAt(i, this._m); continue; }
      this._mRot.makeRotationZ(ang);
      this._mPart.makeTranslation(pivot[0], pivot[1], pivot[2])
        .multiply(this._mRot)
        .multiply(this._mOut.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this._mOut.multiplyMatrices(this._m, this._mPart);
      mesh.setMatrixAt(i, this._mOut);
    }
  }

  // transient tracer for the player's own rifle
  playerShot(from, to) {
    this._playerShots.push({ ax: from.x, ay: from.y, az: from.z, bx: to.x, by: to.y, bz: to.z, ttl: 0.09 });
  }

  update(dt) {
    const { sim, world } = this;
    const buf = sim.buffer;
    const k = Math.min(1, dt * 14);
    const counts = { civ: 0, armed: 0, marine: 0, infection: 0, combatCiv: 0, combatOdst: 0, carrier: 0, corpse: 0, rifle: 0, flash: 0, beam: 0 };
    let clip = 0, animT = 0, curId = 0;
    const stamp = (set, i) => this._stampAnimated(set, i, clip, animT, curId);

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
      // inside the ductwork: a form transiting a vent is genuinely out of
      // sight — don't render a body standing in the room it left
      // inside the ductwork — vent OR maintenance shaft — nobody can see it.
      // (Un-hidden shaft movers ghosted through walls at the wrong deck and
      // then teleported — user report at Maintenance Aft.)
      if (flags & (FLAG.EXPOSED | FLAG.IN_SHAFT)) continue;
      clip = buf.animClip[i];
      animT = buf.animTime[i];
      curId = id;
      const rp = this.rpos.get(id);
      const deck = rp.deck;
      const [wx, wz] = world.simToWorld(rp.x, rp.y, deck);
      const elev = elevOf(deck);
      const heading = -buf.headingR[i];

      if (f === FACTION.CORPSE) {
        const lieAng = (id * 2.399963) % (Math.PI * 2);
        if (flags & FLAG.BURNED) {
          // charred husk — a blackened low mass, no body left to speak of
          this._e.set(0, lieAng, 0);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(wx, elev + 0.1, wz), this._q, this._s.set(1, 0.55, 1));
          this.corpse.setMatrixAt(counts.corpse++, this._m);
        } else {
          // a REAL body lying where it fell (user note: render bodies
          // appropriately, not grey boxes) — the character mesh laid flat,
          // same pose math as the downed-form fall. The armed dead keep
          // their rifle beside them, so the scavenge prompt points at
          // something you can see.
          this._e.set(-Math.PI / 2, lieAng, 0);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(wx, elev + 0.25, wz), this._q, this._s.set(1, 1, 1));
          if (flags & FLAG.ARMED_HOST) {
            stamp(this.armedSet, counts.armed++);
            this._rifleAt(wx + Math.cos(lieAng + 1.2) * 0.55, elev + 0.12,
              wz + Math.sin(lieAng + 1.2) * 0.55, lieAng * 1.7);
            this.rifle.setMatrixAt(counts.rifle++, this._m);
          } else {
            stamp(this.civSet, counts.civ++);
          }
        }
        continue;
      }
      const downed = flags & FLAG.DOWNED;
      if (downed) { // downed combat forms FALL, then lie flat (death blend)
        let fell = this._downAt.get(id);
        if (fell === undefined) { fell = performance.now(); this._downAt.set(id, fell); }
        const p = Math.min(1, (performance.now() - fell) / 380);
        const ease = 1 - (1 - p) * (1 - p);
        this._e.set(-Math.PI / 2 * ease, heading, 0);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(wx, elev + 0.25 * ease, wz), this._q, this._s.set(1, 1, 1));
        if (flags & FLAG.ARMED_HOST) stamp(this.combatOdstSet, counts.combatOdst++);
        else stamp(this.combatCivSet, counts.combatCiv++);
        continue;
      }
      if (this._downAt.has(id)) this._downAt.delete(id); // revived — back on its feet
      // FLINCH (hit feedback): a freshly-hurt body jerks
      const flinch = flags & FLAG.FLINCH ? Math.sin(performance.now() * 0.06 + id) * 0.09 - 0.14 : 0;

      switch (f) {
        case FACTION.CIVILIAN: {
          this._pose(wx, elev, wz, heading, 1, 1, 1, flinch);
          stamp(this.civSet, counts.civ++);
          break;
        }
        case FACTION.ARMED: {
          this._pose(wx, elev, wz, heading, 1, 1, 1, flinch);
          stamp(this.armedSet, counts.armed++);
          this._rifleAt(wx, elev + 1.15, wz, heading);
          this.rifle.setMatrixAt(counts.rifle++, this._m);
          if (sim.darkAt(buf.nodeId[i])) {
            this._rifleAt(wx, elev + 1.2, wz, heading);
            this.beams.setMatrixAt(counts.beam++, this._m);
          }
          break;
        }
        case FACTION.MARINE: {
          this._pose(wx, elev, wz, heading, 1, 1, 1, flinch);
          stamp(this.marineSet, counts.marine++);
          this._rifleAt(wx, elev + 1.25, wz, heading);
          this.rifle.setMatrixAt(counts.rifle++, this._m);
          if (sim.darkAt(buf.nodeId[i])) {
            this._rifleAt(wx, elev + 1.3, wz, heading);
            this.beams.setMatrixAt(counts.beam++, this._m);
          }
          break;
        }
        case FACTION.INFECTION: {
          const pulse = 1 + Math.sin(this.sim.t * 7 + id) * 0.15;
          this._pose(wx, elev, wz, heading, pulse, pulse, pulse, flinch);
          stamp(this.infectionSet, counts.infection++);
          break;
        }
        case FACTION.COMBAT: {
          const charging = flags & FLAG.CHARGING;
          // charge: lean hard forward, stretched stride
          this._e.set((charging ? 0.55 : 0.18) + flinch, heading, 0);
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
          // the sculpted body has its feet at y=0 — swell grows it upward
          this._pose(wx, elev, wz, heading, s, s, s);
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
    [this.corpse, counts.corpse], [this.rifle, counts.rifle], [this.flash, counts.flash],
    [this.beams, counts.beam]]) {
      mesh.count = c;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _pose(x, y, z, rotY, sx, sy, sz, rx = 0) {
    this._e.set(rx, rotY, 0);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(sx, sy, sz));
  }

  _rifleAt(x, y, z, rotY) {
    this._e.set(0, rotY, 0);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(1, 1, 1));
  }
}
