// Renders every sim agent in 3D straight from the AgentBuffer + sim state.
// Faction bodies are simple primitives for the slice — the shapes and cues
// (charge stretch, swelling carrier, hosted weapon, tracers, muzzle flashes)
// are all driven by sim flags, per the fidelity contract (ROADMAP-3D §4).

import * as THREE from './vendor/three.module.js';
import { FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { elevOf } from './world.js';
import { carryGeometry } from './rifle-model.js';
import { characterParts } from './characters.js';
import { RagdollSystem } from '../physics/ragdoll.js';
import { TASK } from '../sim/hive.js';

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
    this._q2 = new THREE.Quaternion(); // second temp for the ragdoll limb stamp

    // CLASSIC-HALO RAGDOLLS (cosmetic; physics/ragdoll.js). A dead body is
    // handed to physics: it goes limp, is thrown off the killing blow, tumbles,
    // and settles. When disabled — or a body is a burned husk, or the cap is
    // full — everything falls back to the legacy flat-corpse / rotate-flat
    // paths below, unchanged. Pure render-side: the sim never sees any of it.
    const rp = sim.P?.ragdoll;
    this.ragdolls = (rp?.enabled ?? false) ? new RagdollSystem(rp) : null;
    this._ragSeen = new Set(); // ids already handed to a ragdoll (never respawn one)
    this._ragRest = new Map(); // id -> [x,y,z] where its ragdoll last rested, so a
                               // handoff to the legacy render (burn, cap-evict, revive)
                               // anchors there instead of teleporting to the sim node
    this._ragPrimed = false;   // first frame: mark the pre-placed dead so they never flop
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
    // First frame: everything already dead is PRE-PLACED (the event/breach
    // corpses seeded at t=0) — mark it so it lies where it was authored instead
    // of every corpse on the ship flopping the instant the game loads. Only
    // deaths that happen DURING play ragdoll.
    if (this.ragdolls && !this._ragPrimed) {
      this._ragPrimed = true;
      for (let j = 0; j < buf.count; j++) {
        if (buf.faction[j] === FACTION.CORPSE || (buf.flags[j] & FLAG.DOWNED)) this._ragSeen.add(buf.id[j]);
      }
    }
    // advance the flops (fixed sub-step inside; asleep bodies are frozen)
    if (this.ragdolls) this.ragdolls.step(dt);
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
      if (!rp || rp.deck !== deck) { rp = { x: buf.posX[i], y: buf.posY[i], deck, hoverY: buf.hoverY[i] || 0 }; this.rpos.set(id, rp); }
      else {
        rp.x += (buf.posX[i] - rp.x) * k; rp.y += (buf.posY[i] - rp.y) * k;
        rp.hoverY = (rp.hoverY || 0) + ((buf.hoverY[i] || 0) - (rp.hoverY || 0)) * k;
      }
    }
    if (this.rpos.size > buf.count * 2) {
      for (const id of this.rpos.keys()) if (!seen.has(id)) this.rpos.delete(id);
    }
    // PIXEL-LOCK a seated burrower onto the body it's converting/raising (user:
    // form, corpse and the combat form that rises must be ONE spot). The sim
    // clamps them together; snap the render position past the ease-in lag so the
    // form never slides across or floats off the body while it burrows.
    for (const a of sim.agents) {
      if (a.dead || !a.task || a.taskProgress <= 0) continue;
      if (a.task.kind !== TASK.CONVERT && a.task.kind !== TASK.REANIMATE) continue;
      const body = sim.byId.get(a.task.corpseId ?? a.task.targetId);
      if (!body || body.dead) continue;
      const rp = this.rpos.get(a.id), bp = this.rpos.get(body.id);
      if (rp && rp.deck === body.deck) { rp.x = body.x; rp.y = body.y; }
      if (bp && bp.deck === body.deck) { bp.x = body.x; bp.y = body.y; }
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
      // feet on the ground surface — in a stairwell room that follows the
      // mezzanine/ramp/hall, so bodies walk the stairs instead of floating
      // at one deck level (user: navigable stairwell room)
      const elev = world.groundHeightAt(deck, wx, wz);
      const heading = -buf.headingR[i];

      if (f === FACTION.CORPSE) {
        // a fresh kill flops via physics (_ragdollBody handles the burned/capped
        // cases internally and returns false to hand back here).
        if (this._ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts)) continue;
        // Legacy static render. Anchor at the ragdoll's settled spot if it
        // flopped (burned/cap-evicted after settling), so it doesn't snap back
        // to the sim node; otherwise the sim position (ragdoll off, or a
        // dragged/relocated body the drift-guard handed back to follow the sim).
        const rest = this._ragRest.get(id);
        const bx = rest ? rest[0] : wx, bz = rest ? rest[2] : wz;
        const bElev = rest ? world.groundHeightAt(deck, bx, bz) : elev;
        const lieAng = (id * 2.399963) % (Math.PI * 2);
        if (flags & FLAG.BURNED) {
          // charred husk — a blackened low mass, no body left to speak of
          this._e.set(0, lieAng, 0);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(bx, bElev + 0.1, bz), this._q, this._s.set(1, 0.55, 1));
          this.corpse.setMatrixAt(counts.corpse++, this._m);
        } else {
          // a REAL body lying where it fell (user note: render bodies
          // appropriately, not grey boxes) — the character mesh laid flat,
          // same pose math as the downed-form fall. The armed dead keep
          // their rifle beside them, so the scavenge prompt points at
          // something you can see.
          this._e.set(-Math.PI / 2, lieAng, 0);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(bx, bElev + 0.25, bz), this._q, this._s.set(1, 1, 1));
          if (flags & FLAG.ARMED_HOST) {
            stamp(this.armedSet, counts.armed++);
            this._rifleAt(bx + Math.cos(lieAng + 1.2) * 0.55, bElev + 0.12,
              bz + Math.sin(lieAng + 1.2) * 0.55, lieAng * 1.7);
            this.rifle.setMatrixAt(counts.rifle++, this._m);
          } else {
            stamp(this.civSet, counts.civ++);
          }
        }
        continue;
      }
      const downed = flags & FLAG.DOWNED;
      if (downed) { // downed combat forms FALL, then lie flat (death blend)
        // a fresh down flops via physics (_ragdollBody handles burned/capped
        // internally and returns false to hand back here).
        if (this._ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts)) continue;
        // Legacy rotate-flat blend. If the body already flopped (it carries a
        // rest anchor or the _ragSeen mark), it is ALREADY lying flat — seed the
        // fall as long-complete so it renders flat at the settled spot instead
        // of snapping upright and re-falling. A genuinely fresh down (ragdoll
        // disabled) still falls from upright, unchanged.
        const rest = this._ragRest.get(id);
        const flopped = rest || this._ragSeen.has(id);
        let fell = this._downAt.get(id);
        if (fell === undefined) { fell = performance.now() - (flopped ? 380 : 0); this._downAt.set(id, fell); }
        const p = Math.min(1, (performance.now() - fell) / 380);
        const ease = 1 - (1 - p) * (1 - p);
        const bx = rest ? rest[0] : wx, bz = rest ? rest[2] : wz;
        const bElev = rest ? world.groundHeightAt(deck, bx, bz) : elev;
        this._e.set(-Math.PI / 2 * ease, heading, 0);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(bx, bElev + 0.25 * ease, bz), this._q, this._s.set(1, 1, 1));
        if (flags & FLAG.ARMED_HOST) stamp(this.combatOdstSet, counts.combatOdst++);
        else stamp(this.combatCivSet, counts.combatCiv++);
        continue;
      }
      // REVIVE TELEGRAPH (user note: forms "getting back up just happen
      // suddenly, seems like a bug"): a form that was down last frame RISES
      // through a reverse of its death fall, with a shudder — 0.85 s of
      // clearly-readable "it's getting back up"
      if (this._downAt.has(id) || this.ragdolls?.has(id)) {
        this._downAt.delete(id);
        // a form getting back up drops its ragdoll and plays the reverse-fall
        // telegraph. Capture WHERE it was lying (the ragdoll's settled spot, or
        // the last rest anchor) so the rise SLIDES back to the sim node over the
        // 0.85 s instead of teleporting to it on frame one. Clearing _ragSeen
        // lets it flop again if it re-dies.
        const rag = this.ragdolls?.get(id);
        const rest = rag ? [rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]] : this._ragRest.get(id);
        // also capture the settled ORIENTATION so the rise slerps out of the
        // exact pose the body was lying in (no face-up→prone flip on frame one)
        const fromQuat = rag ? [rag.rootQuat[0], rag.rootQuat[1], rag.rootQuat[2], rag.rootQuat[3]] : null;
        if (rag) this.ragdolls.remove(id);
        this._ragSeen.delete(id);
        this._ragRest.delete(id);
        (this._riseAt ??= new Map()).set(id, { t0: performance.now(), from: rest || null, fromQuat });
      }
      let rise = 0;
      const riseEntry = this._riseAt?.get(id);
      if (riseEntry !== undefined) {
        const p = Math.min(1, (performance.now() - riseEntry.t0) / 850);
        if (p >= 1) this._riseAt.delete(id);
        else {
          const ease = p * p * (3 - 2 * p);
          rise = -Math.PI / 2 * (1 - ease) + Math.sin(performance.now() * 0.05 + id) * 0.07 * (1 - p);
        }
      }
      // FLINCH (hit feedback): a freshly-hurt body jerks
      const flinch = (flags & FLAG.FLINCH ? Math.sin(performance.now() * 0.06 + id) * 0.09 - 0.14 : 0) + rise;

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
          const leaping = flags & FLAG.LEAPING;
          const hover = rp.hoverY || 0;
          // a reviving form slides from where its ragdoll settled back to the
          // sim node over the rise telegraph, so it reads continuous instead of
          // teleporting on frame one. (from is null for a normal combat form.)
          let bx = wx, by = elev + hover, bz = wz;
          if (riseEntry && riseEntry.from) {
            const e2 = Math.min(1, (performance.now() - riseEntry.t0) / 850);
            const es = e2 * e2 * (3 - 2 * e2);
            bx = riseEntry.from[0] + (wx - riseEntry.from[0]) * es;
            bz = riseEntry.from[2] + (wz - riseEntry.from[2]) * es;
            by = riseEntry.from[1] + ((elev + hover) - riseEntry.from[1]) * es;
          }
          // charge: lean hard forward, stretched stride; a leap tucks and
          // stretches further and rides the arc up off the floor
          this._e.set((leaping ? 0.85 : charging ? 0.55 : 0.18) + flinch, heading, 0);
          this._q.setFromEuler(this._e);
          // a reviving form slerps out of its settled ragdoll orientation into
          // the rising pose, so there is no orientation snap to pair with the
          // (already-continuous) position slide
          if (riseEntry && riseEntry.fromQuat) {
            const e2 = Math.min(1, (performance.now() - riseEntry.t0) / 850);
            const es = e2 * e2 * (3 - 2 * e2);
            this._q2.set(riseEntry.fromQuat[0], riseEntry.fromQuat[1], riseEntry.fromQuat[2], riseEntry.fromQuat[3]);
            this._q2.slerp(this._q, es);
            this._q.copy(this._q2);
          }
          this._m.compose(this._p.set(bx, by, bz), this._q,
            this._s.set(1, leaping ? 1.15 : charging ? 1.1 : 1, leaping ? 1.5 : charging ? 1.35 : 1));
          if (flags & FLAG.ARMED_HOST) {
            stamp(this.combatOdstSet, counts.combatOdst++);
            // bx/bz (not wx/wz) so the rifle rides with the body while a
            // reviving form slides in from its settled ragdoll spot; identical
            // to wx/wz for every non-reviving form
            this._rifleAt(bx, elev + 1.1, bz, heading);
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

    // drop ragdolls for bodies the sim has removed (burned to nothing,
    // converted, dragged off the buffer) — keeps the set and _ragSeen bounded
    // by the live roster.
    if (this.ragdolls) {
      for (const id of this._ragSeen) {
        if (!seen.has(id)) { this.ragdolls.remove(id); this._ragSeen.delete(id); this._ragRest.delete(id); }
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
    // HELD, not floating (user note: "not even holding a weapon correctly"):
    // offset to the grip point — forward and into the right hand — and
    // pitched to a two-hand low-ready instead of hovering level mid-chest
    const fx = Math.cos(rotY), fz = -Math.sin(rotY); // +X-forward after rotY
    const rx = -fz, rz = fx;                          // right-hand direction
    this._e.set(0, rotY, -0.16);
    this._q.setFromEuler(this._e);
    this._m.compose(
      this._p.set(x + fx * 0.26 + rx * 0.15, y - 0.06, z + fz * 0.26 + rz * 0.15),
      this._q, this._s.set(1, 1, 1));
  }

  // --- ragdolls ------------------------------------------------------------

  // Render a dead body — a fresh CORPSE or a just-DOWNED combat form — as a
  // physics ragdoll. Returns true if it drew it (the caller then `continue`s),
  // false to hand back to the legacy static/rotate-flat render. It returns
  // false (handing off) when: ragdolls are disabled; the body is an
  // already-incinerated husk (no flop to start); the sim has relocated the body
  // (drift → follow the sim); or the body just burned/was cap-evicted after
  // flopping — in which case _ragRest carries the settled spot so the legacy
  // render anchors there instead of teleporting to the sim node.
  _ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts) {
    const sys = this.ragdolls;
    if (!sys) return false;
    const burned = (flags & FLAG.BURNED) !== 0;
    let rag = sys.get(id);
    if (rag) {
      // drift guard: if the sim MOVED the body (a carrier dragging a corpse, a
      // reanimation relocation, any teleport), abandon the flop and follow the
      // sim. The ragdoll's OWN motion never trips this — it compares the sim's
      // position, not the flopped one. KEEP the _ragSeen mark (a relocated body
      // must never respawn a fresh flop) but DROP the rest anchor so the legacy
      // render tracks the sim position (the drag), not the old spot.
      const drift = this.sim.P.ragdoll.driftLimitM ?? 1.5;
      if (rag.deck !== deck || Math.hypot(wx - rag.originX, wz - rag.originZ) > drift) {
        sys.remove(id); this._ragRest.delete(id);
        return false;
      }
      // incinerated after flopping: hand to the legacy husk/slab, anchored at
      // the settled pose (recorded just below), and free the ragdoll slot.
      if (burned) { this._ragRest.set(id, [rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]]); sys.remove(id); return false; }
    } else {
      if (burned) return false;                // never START a flop for an already-incinerated body
      if (this._ragSeen.has(id)) return false; // already flopped once (evicted/settled) — legacy, anchored via _ragRest
      const elev = this.world.groundHeightAt(deck, wx, wz);
      const hoverY = rp.hoverY || 0; // a form that died mid-leap starts in the air
      const impulse = this._deathImpulse(id, f, flags, wx, wz, deck, heading);
      rag = sys.spawn(id,
        { x: wx, y: elev + hoverY, z: wz, heading, deck },
        impulse,
        (x, z) => this.world.groundHeightAt(deck, x, z));
      if (!rag) return false; // disabled at the system level
      this._ragSeen.add(id);
    }

    // record where the body currently rests, so any later handoff to the legacy
    // render (burn, cap-eviction, revive) anchors there instead of the sim node
    this._ragRest.set(id, [rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]]);

    // stamp the right model set + counter from the ragdoll pose (same sets the
    // legacy paths use, so no extra draw calls)
    let set, ci;
    if (f === FACTION.CORPSE) {
      if (flags & FLAG.ARMED_HOST) { set = this.armedSet; ci = counts.armed++; }
      else { set = this.civSet; ci = counts.civ++; }
    } else {
      if (flags & FLAG.ARMED_HOST) { set = this.combatOdstSet; ci = counts.combatOdst++; }
      else { set = this.combatCivSet; ci = counts.combatCiv++; }
    }
    this._stampRagdoll(set, ci, rag);

    // the armed dead keep a rifle on the deck beside them, so the "take mags off
    // the dead" prompt still points at something visible
    if (flags & FLAG.ARMED_HOST) {
      const gy = this.world.groundHeightAt(deck, rag.rootPos[0], rag.rootPos[2]);
      const lieAng = (id * 2.399963) % (Math.PI * 2);
      this._rifleAt(rag.rootPos[0] + Math.cos(lieAng) * 0.5, gy + 0.12,
        rag.rootPos[2] + Math.sin(lieAng) * 0.5, lieAng * 1.7);
      this.rifle.setMatrixAt(counts.rifle++, this._m);
    }
    return true;
  }

  // The launch off the killing blow (PLAN-ANIM-POLISH "hit-direction deaths").
  // Direction, in priority order: away from the recorded attacker (lastHurtBy);
  // for a human corpse with no attacker, away from the nearest live hostile;
  // else along the body's facing. All scatter is a deterministic hash of the id
  // — no Math.random — so the flop is reproducible (the headless gate pins it).
  _deathImpulse(id, f, flags, wx, wz, deck, heading) {
    const R = this.sim.P.ragdoll;
    const world = this.world;
    let dirX = 0, dirZ = 0, known = false, speed = R.launchSpeed;

    const agent = this.sim.byId.get(id);
    if (agent && agent.lastHurtBy != null && agent.lastHurtBy >= 0) {
      const src = this.sim.byId.get(agent.lastHurtBy);
      if (src && !src.dead && src.deck === deck && src.id !== id) {
        const [sxw, szw] = world.simToWorld(src.x, src.y, deck);
        dirX = wx - sxw; dirZ = wz - szw;
        if (Math.hypot(dirX, dirZ) > 0.05) known = true;
      }
    }
    if (!known && f === FACTION.CORPSE) {
      let bestD = R.corpseHostileRangeM, bx = 0, bz = 0, found = false;
      for (const a of this.sim.agents) {
        if (a.dead || a.deck !== deck) continue;
        if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT && a.faction !== FACTION.CARRIER) continue;
        const [axw, azw] = world.simToWorld(a.x, a.y, deck);
        const d = Math.hypot(wx - axw, wz - azw);
        if (d < bestD) { bestD = d; bx = axw; bz = azw; found = true; }
      }
      if (found) {
        dirX = wx - bx; dirZ = wz - bz;
        if (Math.hypot(dirX, dirZ) > 0.05) { known = true; speed = R.corpseKnockSpeed; }
      }
    }
    if (!known) {
      dirX = Math.cos(heading); dirZ = -Math.sin(heading); // world-forward at this render heading
      if (f === FACTION.CORPSE) speed = R.corpseKnockSpeed;
    }
    // deterministic scatter so a heap doesn't fan out identically
    let dl = Math.hypot(dirX, dirZ) || 1;
    dirX = dirX / dl + this._scatter(id, 1) * 0.35;
    dirZ = dirZ / dl + this._scatter(id, 2) * 0.35;
    dl = Math.hypot(dirX, dirZ) || 1;
    dirX /= dl; dirZ /= dl;

    const violent = flags & (FLAG.CHARGING | FLAG.LEAPING);
    if (violent) speed += R.chargeBonus; // it was sprinting — the momentum carries into the tumble
    return { dirX, dirZ, speed, up: R.launchUp, spin: R.spin, kick: R.limbKick + (violent ? 3 : 0) };
  }

  // deterministic per-body scatter in [-1, 1] (stands in for Math.random)
  _scatter(id, salt) {
    const h = Math.imul((id * 2654435761) ^ (salt * 40503), 2246822519) >>> 0;
    return (h / 0xffffffff) * 2 - 1;
  }

  // Write the ragdoll's root + per-limb transforms into the instanced part
  // meshes — the same pivot-anchored composition as _stampAnimated, but the
  // limb rotation is a full physics quaternion and the base is the tumbling
  // root instead of the upright pose.
  _stampRagdoll(set, i, rag) {
    this._q.set(rag.rootQuat[0], rag.rootQuat[1], rag.rootQuat[2], rag.rootQuat[3]);
    this._m.compose(this._p.set(rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]),
      this._q, this._s.set(1, 1, 1));
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      const lq = pivot ? rag.limbs[mesh.userData.part] : null;
      if (!lq) { mesh.setMatrixAt(i, this._m); continue; } // torso / pivotless → root only
      this._q2.set(lq[0], lq[1], lq[2], lq[3]);
      this._mRot.makeRotationFromQuaternion(this._q2);
      this._mPart.makeTranslation(pivot[0], pivot[1], pivot[2])
        .multiply(this._mRot)
        .multiply(this._mOut.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this._mOut.multiplyMatrices(this._m, this._mPart);
      mesh.setMatrixAt(i, this._mOut);
    }
  }
}
