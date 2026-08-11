// Renders every sim agent in 3D straight from the AgentBuffer + sim state.
// Faction bodies are simple primitives for the slice — the shapes and cues
// (charge stretch, swelling carrier, hosted weapon, tracers, muzzle flashes)
// are all driven by sim flags, per the fidelity contract (ROADMAP-3D §4).

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import * as TSL from '../engine/vendor/three.tsl.module.js';
import { FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { elevOf } from './world.js';
import { carryGeometry } from './rifle-model.js';
import { characterParts } from './characters.js';
import { buildCarrier, CarrierAnimator, SACK_BLOAT_M } from './carrier-model.js';
import { RagdollSystem } from '../engine/physics/ragdoll.js';
import { TASK } from '../sim/hive.js';
import { sightRangeAt } from '../sim/combat.js';

const CAP = 512;
// the carry yaw _rifleAt applies; the weapon light rides the same axis
const RIFLE_YAW = 0.28;
// deterministic per-(shooter, tick, salt) jitter in [-1, 1] for tracer spread
function shotJitter(id, tick, salt) {
  let h = (id * 374761393 + tick * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
}
// shadow-caster curation (swarm finding): the torch's shadow camera reaches
// 32m — an instance beyond ~34m of the eye can't cast into the beam, so a
// part-set with no stamped instance that close skips the depth pass entirely
const CAST_NEAR2 = 34 * 34;

// commit an instanced mesh's frame: draw `count` instances and upload ONLY
// that range of the matrix buffer (falls back to a full upload on builds
// without updateRanges)
function commitInstanced(mesh, count) {
  mesh.count = count;
  // EMPTY SETS LEAVE THE RENDER LIST (swarm finding: a count-0 InstancedMesh
  // still paid bindings processing and a full uniform upload per pass per
  // frame — and most of the 57 character part-meshes are empty most frames).
  // Firefox's wgpu pays the most per redundant binding; every backend wins.
  mesh.visible = count > 0;
  // FULL UPLOAD, DELIBERATELY. This used to declare a partial update range
  // (0 .. count*16) to avoid re-sending 512 unused slots every frame. That
  // saving is not worth it: bodies keep going invisible on WebGPU, the update
  // range is the one thing standing between "matrix written" and "matrix on
  // the GPU", and it is a documented soft spot in this backend — a range that
  // is mis-scaled, ignored, or applied against a stale version leaves those
  // instances reading whatever was in the buffer before, which for a slot that
  // has never been drawn is zeros. A zero matrix collapses the body to a point:
  // exactly "invisible flood". Correctness first; the copy is cheap next to
  // losing an enemy you are supposed to be fighting.
  if (count > 0) mesh.instanceMatrix.needsUpdate = true;
}

function makeInstanced(scene, geo, color, emissive = 0x000000, emissiveIntensity = 0.4) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15, emissive, emissiveIntensity });
  const mesh = new THREE.InstancedMesh(geo, mat, CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
      // FrontSide (swarm finding): DoubleSide on the densest textured meshes
      // in the game doubled raster work in the main AND shadow passes. The
      // humanoid parts are closed shells — verified by a 4-angle spin-around
      // pixel diff — but the infection form's feeler paddles and tentacles
      // are open single-sided fins that vanish from behind, so it keeps
      // DoubleSide.
      // FLOOD SETS STAY DoubleSide (user report on Chrome: some combat forms
      // lost their bodies but kept their SHADOW — a reverse-wound part is
      // culled by FrontSide in the main pass while the shadow pass draws
      // BackSide, leaving a black silhouette with no caster). The humanoid
      // crew/marine shells verified clean under FrontSide and keep the win.
      const flood = name === 'infection' || name === 'combat_civ' || name === 'combat_odst';
      const mat = new THREE.MeshStandardMaterial({
        map: p.texture, roughness: 0.78, metalness: 0.06,
        side: flood ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.InstancedMesh(p.geometry, mat, CAP);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    // ODST reserve: the marine mesh in blackout plate — the material tint
    // multiplies the texture, so green BDU armor reads as matte-black ODST
    // hardsuit with a darkened visor (user: armory ODSTs need their own skin)
    this.odstSet = mkSet('marine');
    for (const mesh of this.odstSet) mesh.material.color.setHex(0x3f434c);
    this.infectionSet = mkSet('infection');
    this.combatCivSet = mkSet('combat_civ');
    this.combatOdstSet = mkSet('combat_odst');
    // REAL CARRIER MESH: the Halo 3 carrier, GPU-skinned per instance from a
    // baked bone bank (game/carrier-model.js). Replaces the sculpted gas-sack
    // primitive — it has an actual skeleton, so its states are animation
    // rather than scale: rooted and breathing while it incubates, a lumbering
    // waddle, a strain cycle when the skin is nearly full, and a collapse it
    // ruptures out of.
    const carrier = buildCarrier(CAP);
    this.carrier = carrier.mesh;
    this.carrierAnim = carrier.anim;
    this._commitCarrierAnim = carrier.commitAnim;
    scene.add(this.carrier);
    this._carrierAnims = new Map();   // agent id -> CarrierAnimator
    this._carrierLast = new Map();    // agent id -> last drawn [x, y, z, heading, load]
    this._bursting = [];              // carriers mid-detonation, render-only
    this.corpse = makeInstanced(scene, new THREE.BoxGeometry(1.5, 0.28, 0.55), 0x5a5a5a);
    // real MA5 silhouette (first-strike asset), merged grip+gun, one draw
    // call for every carried rifle on the ship (marines, armed crew, armed
    // combat forms) — see game/rifle-model.js
    this.rifle = makeInstanced(scene, carryGeometry(), 0x23272e);
    this.rifle.material.roughness = 0.45;
    this.rifle.material.metalness = 0.65;

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
      const beamGeo = new THREE.ConeGeometry(0.8, 6, 20, 1, true);
      beamGeo.rotateZ(Math.PI / 2);      // point the cone along +X
      beamGeo.translate(3.0, 0, 0);      // apex at the carrier's hands
      // A LIGHT SHAFT, NOT A PIPE (user screenshot: an opaque white cylinder
      // sticking out of a marine's chest). The old material shaded the cone's
      // lateral surface with an axial gradient only, so the surface itself was
      // what you saw — hard silhouette, uniform density, solid-looking.
      //
      // The fix is view-dependent: fade by how face-on the surface is. Where
      // you look straight AT the cone wall the view ray passes through the
      // most air, so it is brightest; at the silhouette the wall is edge-on
      // and goes to zero, which is what kills the hard outline. DoubleSide
      // then makes the near and far walls both contribute, so the middle of
      // the shaft naturally reads denser than its edges — a cheap volumetric
      // that costs one instanced draw.
      const beamMat = new THREE.MeshBasicNodeMaterial({
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      beamMat.colorNode = TSL.vec3(0.66, 0.78, 1.0);
      beamMat.opacityNode = TSL.Fn(() => {
        const v = TSL.uv().y;                       // 1 at the apex (hands), 0 at the far mouth
        // hot at the lens, gone by the throw's end, with a touch off the very
        // apex so it doesn't start on a hard disc
        const axial = TSL.smoothstep(0.0, 0.55, v).mul(TSL.oneMinus(TSL.smoothstep(0.95, 1.0, v)));
        const facing = TSL.abs(TSL.dot(TSL.normalize(TSL.normalView), TSL.positionViewDirection));
        return axial.mul(TSL.pow(facing, 1.7)).mul(0.42);
      })();
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
    // weapon lights declared this frame; the host drains them into its light
    // pool (records recycle — no per-frame garbage)
    this.rifleLights = [];
    this.rifleLightN = 0;
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
    this._blasts = [];         // recent explosions (grenades): {deck, cx, cz, r, ttl} —
                               // deaths inside one get a big radial flailing launch, and a
                               // blast re-flings bodies already on the deck
    this._seen = new Set();
    this._counts = { civ: 0, armed: 0, marine: 0, odst: 0, infection: 0, combatCiv: 0, combatOdst: 0, carrier: 0, corpse: 0, rifle: 0, flash: 0, beam: 0 };
  }

  // The game calls this when a grenade detonates (game/main.js stepFrags). It
  // records the blast so deaths it causes launch dramatically, and immediately
  // re-flings any body already ragdolling within reach. Pure render-side.
  noteExplosion(deck, cx, cz, radius) {
    const R = this.sim.P?.ragdoll;
    if (!this.ragdolls || !R) return;
    this._blasts.push({ deck, cx, cz, r: radius, ttl: R.blastTtl ?? 0.5 });
    const reach = radius + (R.blastRadiusPad ?? 1.5);
    for (const id of this.ragdolls.ids()) {
      const rag = this.ragdolls.get(id);
      if (rag.deck !== deck) continue;
      const d = Math.hypot(rag.rootPos[0] - cx, rag.rootPos[2] - cz);
      if (d > reach) continue;
      this.ragdolls.reimpulse(id, this._blastImpulse(rag.rootPos[0], rag.rootPos[2], cx, cz, d, radius));
    }
  }

  // the blast the point sits inside (strongest = nearest to a centre), or null
  _blastAt(wx, wz, deck) {
    const R = this.sim.P.ragdoll;
    const pad = R.blastRadiusPad ?? 1.5;
    let best = null, bestD = Infinity;
    for (const b of this._blasts) {
      if (b.deck !== deck) continue;
      const d = Math.hypot(wx - b.cx, wz - b.cz);
      if (d <= b.r + pad && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  // a radial launch off a blast centre, scaled down toward the edge
  _blastImpulse(wx, wz, cx, cz, d, radius) {
    const R = this.sim.P.ragdoll;
    let dx = wx - cx, dz = wz - cz;
    const dl = Math.hypot(dx, dz);
    if (dl < 0.05) { dx = 1; dz = 0; } else { dx /= dl; dz /= dl; } // epicentre → any dir (solver scatters it)
    const prox = 1 - Math.min(1, d / Math.max(0.001, radius)) * (R.blastFalloff ?? 0.55);
    return {
      dirX: dx, dirZ: dz,
      speed: (R.blastSpeed ?? 13) * prox,
      up: (R.blastUp ?? 6) * prox,
      spin: R.blastSpin ?? 17,
      kick: R.blastKick ?? 14,
    };
  }

  // RUDIMENTARY SKELETAL ANIMATION (user note): each character is six rigid
  // parts cut along its real bone weights; limbs swing about their actual
  // joint pivots (shoulder/hip from the JMS skeleton) with a procedural
  // cycle picked by the sim's animation clip. Pure render-side — the sim's
  // deterministic state is untouched.
  _swingFor(part, clip, t, id, hold) {
    const ph = t * (clip === CLIP.RUN ? 11 : clip === CLIP.ATTACK ? 9 : clip === CLIP.WRITHE ? 13 : 7.2)
      + (id % 7) * 0.9; // strangers walk out of step
    const s = Math.sin(ph);
    // TWO HANDS ON THE WEAPON (user: marines should actually hold their guns).
    // A rifle carrier's arms never hang or swing free: right arm to the grip,
    // left arm crossed further to the fore-stock — matching _rifleAt's held
    // pose — raised toward level when fighting, with a soft bob when walking.
    if (hold && (part === 'armL' || part === 'armR')) {
      // POSITIVE swing = forward on this rig (the old negative bases pitched
      // the arms BACKWARD ~40° — the "awk stuff" in the user's screenshot;
      // verified by candidate-grid renders). Right hand to the grip, left
      // crossed further up the fore-stock — Halo low-ready.
      // TIGHTER CARRY (user: "both hands outstretched, still looks silly").
      // These arms are rigid single meshes with no elbow, so a big forward
      // swing from the A-pose bind can only ever read as a straight reach.
      // Keeping the swing small and leaning on adduction instead gives a
      // compact low-ready that a jointless arm can actually sell.
      const base = part === 'armR' ? 0.48 : 0.68;
      const aim = clip === CLIP.ATTACK ? 0.3 : clip === CLIP.RUN ? 0.12 : 0;
      const bob = clip === CLIP.WALK || clip === CLIP.RUN
        ? Math.sin(ph * 2) * 0.05
        : Math.sin(ph * 0.35 + (part === 'armR' ? 0.6 : 0)) * 0.03; // breathing
      return base + aim + bob;
    }
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
        // One authored-looking 580 ms whip: the right tentacle leads in a
        // huge overhand/cross-body lash and the left follows a beat later.
        // `animTime` resets on the actual damage event, so the visual contact
        // and the physical impulse share the same beat.
        {
          const u = Math.max(0, Math.min(1, t / 0.58));
          const lead = Math.sin(Math.min(1, u / 0.62) * Math.PI);
          const followU = Math.max(0, Math.min(1, (u - 0.16) / 0.72));
          const follow = Math.sin(followU * Math.PI);
          if (part === 'armR') return 0.18 + lead * 2.35;
          if (part === 'armL') return 0.12 + follow * 1.95;
          if (part === 'legL') return -lead * 0.22;
          if (part === 'legR') return lead * 0.32;
          if (part === 'head') return -lead * 0.18;
        }
        return 0;
      case CLIP.WRITHE:
        // infection form: tripod legs skitter, sensory stalks quiver
        if (part === 'legL') return s * 0.35;
        if (part === 'legR') return -s * 0.35;
        if (part === 'head') return Math.sin(ph * 1.3) * 0.25;
        return 0;
      default: {
        // IDLE — a body at rest is never rigid (user: standing all weird and
        // stiff): slow breath in the arms, an occasional unhurried look around,
        // and a static per-body stance offset so no two read as clones.
        const set2 = ((id * 1597334677) >>> 0) / 4294967296 - 0.5;
        if (part === 'armL' || part === 'armR') {
          return Math.sin(ph * 0.35 + (part === 'armR' ? 1 : 0)) * 0.05
            + set2 * (part === 'armR' ? 0.06 : -0.05); // asymmetric rest
        }
        if (part === 'head') return Math.sin(ph * 0.13 + id) * 0.1 + set2 * 0.08; // scanning
        if (part === 'legL') return set2 * 0.05;  // weight on one foot
        if (part === 'legR') return -set2 * 0.05;
        return 0;
      }
    }
  }

  // dead-sprawl stamp for bodies lying flat: limbs splayed at deterministic
  // per-body angles instead of the bind-pose T (user: corpses read as
  // cardboard cutouts half-sunk in the deck). The swing plane IS the lying
  // plane once the base matrix pitches the body flat, so no angle can dig a
  // limb into the floor. `ease` grows the sprawl in as a downed body falls.
  _stampSprawl(set, i, id, ease = 1) {
    if (this._curD2 < CAST_NEAR2) this._castNear.add(set);
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      if (!pivot) { mesh.setMatrixAt(i, this._m); continue; }
      const part = mesh.userData.part;
      const k = part === 'armL' ? 0 : part === 'armR' ? 1 : part === 'legL' ? 2 : part === 'legR' ? 3 : 4;
      // TWO INDEPENDENT HASHES so a body's left and right don't mirror each
      // other — one arm can end up tucked under the ribs while the other is
      // thrown wide.
      const u = (Math.sin(id * 17.3 + k * 3.1) + 1) / 2;
      const v = (Math.sin(id * 5.77 + k * 9.4) + 1) / 2;
      // ADDUCTION about model X. With the body laid on its BACK (see the base
      // matrix) that axis points at the ceiling, so this sweep runs ACROSS the
      // plating and can never dig a limb in — and it is the ONLY axis that
      // closes the bind-pose T. The old Z sweep rotated in a vertical plane:
      // it slid outstretched arms forward and back but never brought them
      // down to the body, so every corpse kept its arms straight out (user:
      // "T posing posture still a problem").
      const ang = (part === 'armR' ? 0.35 + u * 0.95
        : part === 'armL' ? -(0.35 + v * 0.95)
        : part === 'legR' ? 0.08 + u * 0.34
        : part === 'legL' ? -(0.08 + v * 0.34)
        : (u - 0.5) * 0.5) * ease;
      // a little sway in the perpendicular plane so limbs aren't all coplanar
      this._eSpr ??= new THREE.Euler();
      this._eSpr.set(ang, 0, (u - 0.5) * (part === 'head' ? 0.3 : 0.5) * ease);
      this._mRot.makeRotationFromEuler(this._eSpr);
      this._mPart.makeTranslation(pivot[0], pivot[1], pivot[2])
        .multiply(this._mRot)
        .multiply(this._mOut.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this._mOut.multiplyMatrices(this._m, this._mPart);
      mesh.setMatrixAt(i, this._mOut);
    }
  }

  // write base × (pivot-anchored swing) into every part mesh of a set
  _stampAnimated(set, i, clip, animT, id, hold = false) {
    if (this._curD2 < CAST_NEAR2) this._castNear.add(set);
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      const part = mesh.userData.part;
      const ang = pivot && clip !== CLIP.DEATH ? this._swingFor(part, clip, animT, id, hold) : 0;
      if (!ang) { mesh.setMatrixAt(i, this._m); continue; }
      // TWO-AXIS HOLD (user: the hold still read as splayed "awk stuff" from
      // behind): the H2 arms are modeled with an outward A-pose slope, so a
      // pure forward pitch keeps the elbows flared. Rifle carriers also
      // ADDUCT — the X-rotation pulls the hands in toward the weapon's
      // centerline, closing the silhouette.
      if (!hold && clip === CLIP.ATTACK && (part === 'armL' || part === 'armR')) {
        // The converted host's long arm meshes are tentacles in silhouette.
        // A second shoulder axis makes them slash across the victim instead
        // of merely windmilling forward like ordinary human arms.
        const u = Math.max(0, Math.min(1, animT / 0.58));
        const lash = Math.sin(u * Math.PI);
        this._eAttack ??= new THREE.Euler();
        this._eAttack.set((part === 'armR' ? -0.92 : 0.72) * lash, 0, ang);
        this._mRot.makeRotationFromEuler(this._eAttack);
      } else if (hold && clip !== CLIP.DEATH && (part === 'armL' || part === 'armR')) {
        this._eHold ??= new THREE.Euler();
        this._eHold.set(part === 'armR' ? 0.52 : -0.52, 0, ang);
        this._mRot.makeRotationFromEuler(this._eHold);
      } else this._mRot.makeRotationZ(ang);
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

  // RIFLE LIGHT (user: a weapon light that does REAL work, so a dark room is
  // genuinely brighter with your fireteam in it). The pool lives in main.js
  // and re-declares AFTER this runs, so collect into a recycled buffer here
  // and let the host drain it. Position is a couple of metres down the
  // barrel: a point source out in front throws like a torch without paying
  // for a second shadow-casting spot per marine.
  // WEAPON LIGHT THAT LANDS ON SOMETHING (user: "what is it reflecting off?
  // what is it illuminating? i dont see the direction of the wall hes looking
  // at illuminated. I want different illuminated spots coming from their
  // heading"). A point source floating 2.6 m off the muzzle lit the air in
  // front of the man and nothing else. Instead: march along his heading to
  // the first wall of the room he is standing in — pure rect maths against
  // the sim node, no raycast — and put the light just short of that surface.
  // That is the bright pool on the wall he is facing, and because every
  // marine faces somewhere different, a dark room fills with separate spots
  // that move as they cover their arcs.
  _addRifleLight(nodeIdx, sx, sy, deck, elev, hSim) {
    const [mwx, mwz] = this.world.simToWorld(sx, sy, deck);
    const ddx = mwx - (this.viewX ?? 0), ddz = mwz - (this.viewZ ?? 0);
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 > 1600) return;                       // 40 m — the pool scores the rest
    const nd = this.sim.graph.node(nodeIdx);
    // ALONG THE BARREL (user: "flashlights aligned with gun nozzles"). The
    // rifle is carried yawed across the body, so the body's heading points
    // somewhere the weapon does not.
    const gh = hSim - RIFLE_YAW;
    const hx = Math.cos(gh), hy = Math.sin(gh);
    const ox = sx + Math.cos(hSim) * 0.20 + hx * 0.55;   // muzzle
    const oy = sy + Math.sin(hSim) * 0.20 + hy * 0.55;
    // march to the first wall of the room he is standing in — rect maths, no
    // raycast — so the throw ends on a surface rather than in mid-air
    let t = 16;
    if (hx > 1e-4) t = Math.min(t, (nd.x + nd.w / 2 - ox) / hx);
    else if (hx < -1e-4) t = Math.min(t, (nd.x - nd.w / 2 - ox) / hx);
    if (hy > 1e-4) t = Math.min(t, (nd.y + nd.d / 2 - oy) / hy);
    else if (hy < -1e-4) t = Math.min(t, (nd.y - nd.d / 2 - oy) / hy);
    t = Math.max(1.4, t - 0.4);
    const [owx, owz] = this.world.simToWorld(ox, oy, deck);
    const [hwx, hwz] = this.world.simToWorld(ox + hx * t, oy + hy * t, deck);
    const r = this.rifleLights[this.rifleLightN]
      ?? (this.rifleLights[this.rifleLightN] = {});
    // origin + aim, so the host can drive a real SPOTLIGHT with it: a point
    // light at the wall is a round blob, and the user wants to see the beam's
    // footprint picking out what the man is actually looking at.
    r.ox = owx; r.oy = elev + 1.15; r.oz = owz;
    r.tx = hwx; r.ty = elev + 1.05; r.tz = hwz;
    r.throw = t; r.d2 = d2;
    this.rifleLightN++;
  }

  // is this room dark enough that an armed body would have its light on?
  // NOT just flood-darkness (user: "only the fireteam seems to have it") — a
  // room whose mains are dead is pitch black too, and every marine standing
  // in one was walking around with the lamp off.
  _needsLamp(nodeIdx) {
    return this.sim.darkAt(nodeIdx) || this.sim.graph.lightMode[nodeIdx] === 3;
  }

  update(dt) {
    const { sim, world } = this;
    const buf = sim.buffer;
    this.rifleLightN = 0;
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
    // age recent blasts (a death registers a frame or two after the boom)
    if (this._blasts.length) this._blasts = this._blasts.filter((b) => (b.ttl -= dt) > 0);
    const k = Math.min(1, dt * 14);
    const counts = this._counts;
    for (const key in counts) counts[key] = 0;
    let clip = 0, animT = 0, curId = 0;
    const stamp = (set, i) => this._stampAnimated(set, i, clip, animT, curId);
    const stampHold = (set, i) => this._stampAnimated(set, i, clip, animT, curId, true); // rifle carriers

    const seen = this._seen;
    seen.clear();
    // per-frame per-set "any instance near enough to cast into the torch cone"
    (this._castNear ??= new Set()).clear();
    this._curD2 = 0; // stays 0 (always cast) until the camera position is known
    this._emergeAt ??= new Map();
    this._hiddenPrev ??= new Set();
    const hiddenNow = (this._hiddenNow ??= new Set());
    hiddenNow.clear();
    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      seen.add(id);
      const deck = buf.posZ[i]; // sim writes deck into posZ
      const hidden = (buf.flags[i] & (FLAG.EXPOSED | FLAG.IN_SHAFT)) !== 0;
      if (hidden) hiddenNow.add(id);
      let rp = this.rpos.get(id);
      // EMERGE AT A MARKED OPENING (user: combat forms teleported into the
      // middle of the last-stand hallway). A body that arrives on a deck —
      // out of a hidden duct/shaft transit, or any cross-deck hop — surfaces
      // AT the nearest vent grate / shaft hatch / ladder in its room and
      // rises out of it, instead of popping in at its sim position.
      const emerged = !hidden && this._hiddenPrev.has(id);
      if (!rp || rp.deck !== deck || emerged) {
        let sx = buf.posX[i], sy = buf.posY[i];
        let snap = emerged;
        if (!snap && rp && rp.deck !== deck) {
          // a cross-deck hop with a world-space position JUMP is a ladder or
          // shaft arrival → snap to a mouth. A continuous crossing (walking
          // the grand stairwell — same footprint, deck label flips) is not.
          const [owx, owz] = this.world.simToWorld(rp.x, rp.y, rp.deck);
          const [nwx, nwz] = this.world.simToWorld(sx, sy, deck);
          snap = Math.hypot(nwx - owx, nwz - owz) > 3.5;
        }
        if (snap && buf.faction[i] !== FACTION.CORPSE) {
          const m = this.world.mouthNear(buf.nodeId[i], sx, sy);
          if (m) {
            sx = m.x; sy = m.y;
            // only a real OPENING gets the climb-out rise — a stairwell-kiosk
            // pad arrival steps out at floor level (user: marines sprang out
            // of solid deck at the stair pads)
            if (m.kind !== 'pad') this._emergeAt.set(id, performance.now());
          }
        }
        rp = { x: sx, y: sy, deck, hoverY: buf.hoverY[i] || 0 };
        this.rpos.set(id, rp);
      } else {
        rp.x += (buf.posX[i] - rp.x) * k; rp.y += (buf.posY[i] - rp.y) * k;
        rp.hoverY = (rp.hoverY || 0) + ((buf.hoverY[i] || 0) - (rp.hoverY || 0)) * k;
      }
    }
    // swap hidden sets (allocation-free)
    { const t = this._hiddenPrev; this._hiddenPrev = hiddenNow; this._hiddenNow = t; }
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

    // deck-scoped stamping (perf, user: don't render the whole ship): a body
    // two opaque decks away cannot be seen — don't animate or stamp it
    const playerDeck = sim.byId.get(this.playerId)?.deck ?? 3;
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
      if (Math.abs(deck - playerDeck) > 1) continue; // invisible through opaque decks
      // beyond scene.fog.far (max 60m) fog is FULLY opaque — a body 62m out
      // is pixel-for-pixel invisible; skip its pose math and stamping
      if (this.viewX !== undefined) {
        const [ax, az] = world.simToWorld(rp.x, rp.y, deck);
        const vdx = ax - this.viewX, vdz = az - this.viewZ;
        this._curD2 = vdx * vdx + vdz * vdz;
        if (this._curD2 > 62 * 62) continue;
      }
      let [wx, wz] = world.simToWorld(rp.x, rp.y, deck);
      // a body whose sim transit crosses the enclosed stair housing at
      // hangar level renders pushed out through the nearest face instead
      // of walking through its walls (user report)
      [wx, wz] = world.clampStairTower(deck, wx, wz);
      // and one crossing the GRAND stair well at entry level slides around
      // the balustrade instead of through it (user: NPCs clopped through the
      // railings onto the flights) — unless it is genuinely on the stairwell
      // edge descending, which is the one legal way into the well footprint
      const simAg = sim.byId.get(id);
      if (simAg?.move?.link?.type !== 'stairwell') {
        [wx, wz] = world.clampStairWell(deck, wx, wz);
      }
      // feet on the ground surface — in a stairwell room that follows the
      // mezzanine/ramp/hall, so bodies walk the stairs instead of floating
      // at one deck level (user: navigable stairwell room)
      let elev = world.groundHeightAt(deck, wx, wz);
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
          // appropriately, not grey boxes) — laid flat WITH a per-body limb
          // sprawl (user: the bind-pose T read as a cardboard cutout), resting
          // ON the plating instead of sunk into it. The armed dead keep
          // their rifle beside them, so the scavenge prompt points at
          // something you can see.
          // ON ITS BACK, not its side. Rx(-90) put the model's LATERAL axis
          // vertical, so a bind-pose T threw one arm at the ceiling and drove
          // the other through the deck. Rz(+90) stands the chest up instead:
          // the body lies face-up, both arms rest in the floor plane, and the
          // sprawl above can tuck them.
          this._e.set(0, lieAng, Math.PI / 2);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(bx, bElev + 0.16, bz), this._q, this._s.set(1, 1, 1));
          if (flags & FLAG.ARMED_HOST) {
            this._stampSprawl(this.armedSet, counts.armed++, id);
            this._rifleAt(bx + Math.cos(lieAng + 1.2) * 0.55, bElev + 0.12,
              bz + Math.sin(lieAng + 1.2) * 0.55, lieAng * 1.7);
            this.rifle.setMatrixAt(counts.rifle++, this._m);
          } else {
            this._stampSprawl(this.civSet, counts.civ++, id);
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
        // falls ONTO ITS BACK (same axis the settled corpse lies on, so the
        // blend lands exactly where the static render expects it)
        this._e.set(0, heading, (Math.PI / 2) * ease);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(bx, bElev + 0.16 * ease, bz), this._q, this._s.set(1, 1, 1));
        // sprawl grows in as it falls — flat is a settled sprawl, not a T
        if (flags & FLAG.ARMED_HOST) this._stampSprawl(this.combatOdstSet, counts.combatOdst++, id, ease);
        else this._stampSprawl(this.combatCivSet, counts.combatCiv++, id, ease);
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

      // CRAWL-OUT (user: deck arrivals must surface at the opening): a body
      // snapped to a grate/hatch mouth starts sunk into the deck and climbs
      // out over ~0.7s — the floor slab hides the sunk part, so it reads as
      // hauling itself out of the ductwork.
      {
        const em = this._emergeAt.get(id);
        if (em !== undefined) {
          const p = (performance.now() - em) / 700;
          if (p >= 1) this._emergeAt.delete(id);
          else {
            const es = p * p * (3 - 2 * p);
            elev -= (1 - es) * 1.35;
          }
        }
      }

      switch (f) {
        case FACTION.CIVILIAN: {
          this._pose(wx, elev, wz, heading, 1, 1, 1, flinch);
          stamp(this.civSet, counts.civ++);
          break;
        }
        case FACTION.ARMED: {
          this._pose(wx, elev, wz, heading, 1, 1, 1, flinch);
          stampHold(this.armedSet, counts.armed++);
          this._rifleAt(wx, elev + 1.05, wz, heading);
          this.rifle.setMatrixAt(counts.rifle++, this._m);
          if (this._needsLamp(buf.nodeId[i])) {
            if (sim.fogAt(buf.nodeId[i])) { // only fog gives the shaft something to scatter off
              this._beamAt(wx, elev + 1.08, wz, heading);
              this.beams.setMatrixAt(counts.beam++, this._m);
            }
            this._addRifleLight(buf.nodeId[i], buf.posX[i], buf.posY[i], deck, elev, -heading);
          }
          break;
        }
        case FACTION.MARINE: {
          this._pose(wx, elev, wz, heading, 1, 1, 1, flinch);
          if (flags & FLAG.ODST) stampHold(this.odstSet, counts.odst++);
          else stampHold(this.marineSet, counts.marine++);
          this._rifleAt(wx, elev + 1.15, wz, heading);
          this.rifle.setMatrixAt(counts.rifle++, this._m);
          if (this._needsLamp(buf.nodeId[i])) {
            if (sim.fogAt(buf.nodeId[i])) {
              this._beamAt(wx, elev + 1.14, wz, heading);
              this.beams.setMatrixAt(counts.beam++, this._m);
            }
            this._addRifleLight(buf.nodeId[i], buf.posX[i], buf.posY[i], deck, elev, -heading);
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
            // MODEST STRETCH (user: "body clipping still looks silly"): the old
            // 1.35-1.5x elongation threw limbs far outside the body radius the
            // sim clamps to, so charging forms speared through walls and each
            // other. Enough lean to read as a sprint, not enough to escape the
            // collision the sim actually enforces.
            this._s.set(1, leaping ? 1.08 : charging ? 1.05 : 1, leaping ? 1.18 : charging ? 1.12 : 1));
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
          const load = Math.min(1, held / sim.P.carrier.maxInfectionForms);
          let anim = this._carrierAnims.get(id);
          if (!anim) this._carrierAnims.set(id, anim = new CarrierAnimator(id));
          // CLIP FROM SIM STATE: a carrier past the seek threshold is fit to
          // burst, so it strains wherever it is — rooted it convulses in
          // place, moving it hurries. Below that it incubates and waddles.
          const ripe = load >= sim.P.carrier.seekOrExplodeFraction;
          const moving = clip === CLIP.WALK || clip === CLIP.RUN;
          anim.play(moving ? (ripe ? 'run' : 'walk') : (ripe ? 'strain' : 'idle'));
          anim.advance(dt);
          // the load reads as the SACK filling, not as a bigger animal — the
          // old primitive scaled the whole body 0.8x to 1.5x and grew its feet
          anim.write(this.carrierAnim, counts.carrier, load * SACK_BLOAT_M);
          const s = 0.94 + load * 0.1;
          this._pose(wx, elev, wz, heading, s, s, s, flinch);
          this._carrierLast.set(id, [wx, elev, wz, heading, load]);
          if (this._curD2 < CAST_NEAR2) this._castNear.add(this.carrier);
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

    // DETONATION, RENDER-ONLY. explodeCarrier() kills the agent and spawns the
    // spilled infection forms in the same tick, so a rupturing carrier is
    // simply gone from the buffer the next frame — there is no dying body to
    // animate. A carrier only ever leaves the buffer by rupturing (the sim has
    // no other exit for one), so a vanished id IS a detonation: keep drawing
    // it where it stood for the length of the collapse clip, with the sack
    // running away with itself into the burst.
    for (const [id, anim] of this._carrierAnims) {
      if (seen.has(id)) continue;
      const at = this._carrierLast.get(id);
      this._carrierAnims.delete(id);
      this._carrierLast.delete(id);
      if (!at) continue;
      anim.play('detonate', 0.1);
      this._bursting.push({ anim, at });
    }
    for (let b = this._bursting.length - 1; b >= 0; b--) {
      const burst = this._bursting[b];
      burst.anim.advance(dt);
      if (burst.anim.finished || counts.carrier >= CAP) { this._bursting.splice(b, 1); continue; }
      const [bx, by, bz, bh, load] = burst.at;
      // same visibility rules the live bodies get: fully-fogged at 62m, and
      // its OWN distance decides shadow casting (_curD2 still holds whatever
      // the last agent in the loop above measured)
      let d2 = 0;
      if (this.viewX !== undefined) {
        const vdx = bx - this.viewX, vdz = bz - this.viewZ;
        d2 = vdx * vdx + vdz * vdz;
        if (d2 > 62 * 62) continue;
      }
      const p = burst.anim.progress;
      burst.anim.write(this.carrierAnim, counts.carrier,
        SACK_BLOAT_M * (Math.max(load, 0.7) + p * p * 1.9));
      const s = 0.94 + load * 0.1 + p * 0.12;
      this._pose(bx, by, bz, bh, s, s, s);
      if (d2 < CAST_NEAR2) this._castNear.add(this.carrier);
      this.carrier.setMatrixAt(counts.carrier++, this._m);
    }

    // tracers + muzzle flashes from live fights
    this.flashPoints = []; // world positions of this frame's NPC muzzle flashes (pooled gunfire lights)
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
      const sight = sightRangeAt(sim, n);
      for (const sh of shooters) {
        if (seg >= 250) break;
        if ((sh.id + sim.tickCount) % 3 === 0) continue;
        const t = targets[(sh.id + (sim.tickCount >> 1)) % targets.length];
        const sr = this.rpos.get(sh.id), tr = this.rpos.get(t.id);
        if (!sr || !tr) continue;
        const [sx, sz] = this.world.simToWorld(sr.x, sr.y, sr.deck);
        let [tx, tz] = this.world.simToWorld(tr.x, tr.y, tr.deck);
        const ey = elevOf(sr.deck) + 1.3;
        let ty = elevOf(tr.deck) + 0.7;
        // the render honors the same sight limit as the sim (user: marines
        // visibly lasering a form they couldn't possibly see in the dark)
        const range = Math.hypot(tx - sx, tz - sz);
        if (range > sight) continue;
        // PER-SHOT SPREAD (user: every tracer from every marine converged on
        // the exact same point) — deterministic jitter around the target,
        // wider at range and for the squad's worse shots; misses visibly miss
        const sp = (0.22 + range * 0.05) * (0.7 + 0.7 * ((sh.id * 7) % 5) / 4);
        const inv = 1 / (range || 1);
        const px = -(tz - sz) * inv, pz = (tx - sx) * inv;
        const j1 = shotJitter(sh.id, sim.tickCount, 1) * sp;
        const j2 = shotJitter(sh.id, sim.tickCount, 2) * sp * 0.6;
        tx += px * j1; tz += pz * j1; ty += j2;
        pos.setXYZ(seg * 2, sx, ey, sz);
        pos.setXYZ(seg * 2 + 1, tx, ty, tz);
        seg++;
        if (counts.flash < CAP) {
          const dx = tx - sx, dz = tz - sz, dl = Math.hypot(dx, dz) || 1;
          const fs = 0.8 + ((sh.id + sim.tickCount) % 2) * 0.6;
          const fx2 = sx + dx / dl * 0.6, fz2 = sz + dz / dl * 0.6;
          this._m.compose(this._p.set(fx2, ey, fz2),
            this._q.identity(), this._s.set(fs, fs, fs));
          this.flash.setMatrixAt(counts.flash++, this._m);
          if (this.flashPoints.length < 3) this.flashPoints.push({ x: fx2, y: ey, z: fz2 });
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
    // upload only the live segments; zero segments = no upload, no draw
    // (swarm finding: both tracer buffers uploaded whole every frame even
    // with nothing firing anywhere on the ship)
    this.tracers.visible = seg > 0;
    if (pos.clearUpdateRanges) {
      pos.clearUpdateRanges();
      if (seg > 0) pos.addUpdateRange(0, seg * 2 * 3);
    }
    pos.needsUpdate = seg > 0;

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
        let [tx, tz] = this.world.simToWorld(tr.x, tr.y, tr.deck);
        const ey = elevOf(sr.deck) + 1.05;
        let ty = elevOf(tr.deck) + 0.9;
        // a host's weapon fired one-handed sprays WIDE (lore: suppressive
        // noise, not marksmanship) — big visible scatter
        const fdx = tx - sx, fdz = tz - sz;
        const frange = Math.hypot(fdx, fdz) || 1;
        const fsp = 0.5 + frange * 0.07;
        const finv = 1 / frange;
        const fj1 = shotJitter(sh.id, sim.tickCount, 3) * fsp;
        const fj2 = shotJitter(sh.id, sim.tickCount, 4) * fsp * 0.7;
        tx += -fdz * finv * fj1; tz += fdx * finv * fj1; ty += fj2;
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
    this.floodTracers.visible = fseg > 0;
    if (fpos.clearUpdateRanges) {
      fpos.clearUpdateRanges();
      if (fseg > 0) fpos.addUpdateRange(0, fseg * 2 * 3);
    }
    fpos.needsUpdate = fseg > 0;
    commitInstanced(this.floodFlash, counts.floodFlash);

    // PARTIAL UPLOADS (perf pass 2): ~35 instanced meshes used to re-upload
    // their FULL 512-slot matrix buffers every frame (~1MB/frame of copy
    // whether 3 or 300 instances were live). Only the used range goes to
    // the GPU now; slots past `count` are never drawn, so they never need
    // uploading.
    const cull = this.shadowCull !== false; // ?nosc=1 pins every set casting
    for (const [set, c] of [[this.civSet, counts.civ], [this.armedSet, counts.armed],
    [this.marineSet, counts.marine], [this.odstSet, counts.odst], [this.infectionSet, counts.infection],
    [this.combatCivSet, counts.combatCiv], [this.combatOdstSet, counts.combatOdst]]) {
      const cast = !cull || this._castNear.has(set);
      for (const mesh of set) { mesh.castShadow = cast; commitInstanced(mesh, c); }
    }
    // a carried rifle is only ever within torch reach when its carrier is
    this.rifle.castShadow = !cull || this._castNear.has(this.armedSet) || this._castNear.has(this.marineSet)
      || this._castNear.has(this.odstSet) || this._castNear.has(this.combatOdstSet);
    this.carrier.castShadow = !cull || this._castNear.has(this.carrier);
    for (const [mesh, c] of [[this.carrier, counts.carrier],
    [this.corpse, counts.corpse], [this.rifle, counts.rifle], [this.flash, counts.flash],
    [this.beams, counts.beam]]) {
      commitInstanced(mesh, c);
    }
    this._commitCarrierAnim(counts.carrier);   // per-instance clip/phase/swell
  }

  _pose(x, y, z, rotY, sx, sy, sz, rx = 0) {
    this._e.set(rx, rotY, 0);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(sx, sy, sz));
  }

  // The torch points WHERE HE IS LOOKING. Riding _rifleAt put the cone on the
  // low-ready rifle, which is held across the chest — so the beam came out of
  // the marine's sternum and threw off to one side (user screenshot).
  _beamAt(x, y, z, rotY) {
    rotY += RIFLE_YAW;                            // down the barrel, like the light
    const fx = Math.cos(rotY), fz = -Math.sin(rotY);
    this._e.set(0, rotY, 0);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x + fx * 0.35, y, z + fz * 0.35), this._q, this._s.set(1, 1, 1));
  }

  _rifleAt(x, y, z, rotY) {
    // HALO LOW-READY (user: "holding rifles in a pose similar to halo
    // games"): across the chest, muzzle angled down and slightly across the
    // body, sitting in the raised hands — candidate C of the pose grid
    const fx = Math.cos(rotY), fz = -Math.sin(rotY); // +X-forward after rotY
    const rx = -fz, rz = fx;                          // right-hand direction
    this._e.set(0, rotY + RIFLE_YAW, -0.26);
    this._q.setFromEuler(this._e);
    this._m.compose(
      this._p.set(x + fx * 0.20 + rx * 0.04, y - 0.09, z + fz * 0.20 + rz * 0.04),
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
      // a body only flops once — UNLESS a grenade goes off on it: a blast
      // re-flings even a settled or pre-placed corpse (the classic "toss a nade
      // into the pile and they scatter" moment).
      if (this._ragSeen.has(id) && !this._blastAt(wx, wz, deck)) return false;
      const elev = this.world.groundHeightAt(deck, wx, wz);
      const hoverY = rp.hoverY || 0; // a form that died mid-leap starts in the air
      const impulse = this._deathImpulse(id, f, flags, wx, wz, deck, heading);
      // the ceiling sampler is called for BOTH capsule ends every substep,
      // and ceilHeightAt is a linear all-rooms scan (swarm finding) — the
      // value only changes when the body crosses a room boundary. Two cache
      // slots (the ends are ~1m apart, so one slot would ping-pong and
      // re-resolve every call), re-resolved after >0.5m of lateral travel.
      const cc = [{ x: 1e9, z: 1e9, y: 0 }, { x: 1e9, z: 1e9, y: 0 }];
      rag = sys.spawn(id,
        { x: wx, y: elev + hoverY, z: wz, heading, deck },
        impulse,
        (x, z) => this.world.groundHeightAt(deck, x, z),
        (x, z) => {
          const da = (x - cc[0].x) ** 2 + (z - cc[0].z) ** 2;
          const db = (x - cc[1].x) ** 2 + (z - cc[1].z) ** 2;
          if (Math.min(da, db) <= 0.25) return (da <= db ? cc[0] : cc[1]).y;
          const s = da <= db ? cc[1] : cc[0]; // miss: evict the farther slot
          s.x = x; s.z = z;
          s.y = elevOf(deck) + this.world.ceilHeightAt(deck, x, z) - 0.15;
          return s.y;
        },
        (fromX, fromZ, toX, toZ, radius) => {
          if (!this.world.ragdollBlocked(deck, toX, toZ, radius)) return null;
          // Swept bisection prevents a fast pounce launch from tunnelling
          // through a thin door panel between fixed ragdoll substeps.
          let lo = 0, hi = 1;
          for (let step = 0; step < 8; step++) {
            const mid = (lo + hi) * 0.5;
            const x = fromX + (toX - fromX) * mid;
            const z = fromZ + (toZ - fromZ) * mid;
            if (this.world.ragdollBlocked(deck, x, z, radius)) hi = mid;
            else lo = mid;
          }
          const dx = toX - fromX, dz = toZ - fromZ;
          const dl = Math.hypot(dx, dz) || 1;
          return {
            x: fromX + dx * Math.max(0, lo - 0.01),
            z: fromZ + dz * Math.max(0, lo - 0.01),
            nx: -dx / dl, nz: -dz / dl,
          };
        });
      if (!rag) return false; // disabled at the system level
      this._ragSeen.add(id);
    }

    // NON-FINITE GUARD: a single NaN instance matrix can corrupt an entire
    // instanced draw on tile-based GPUs (Apple M-series) — every body sharing
    // the mesh vanishes, not just the bad one. If a flop ever goes non-finite,
    // drop the ragdoll and hand the body to the legacy flat render.
    let finite = Number.isFinite(rag.rootPos[0] + rag.rootPos[1] + rag.rootPos[2] + rag.rootQuat[3]);
    if (finite) for (const part in rag.limbs) {
      const q = rag.limbs[part];
      if (!Number.isFinite(q[0] + q[1] + q[2] + q[3])) { finite = false; break; }
    }
    if (!finite) {
      sys.remove(id);
      this._ragRest.delete(id);
      return false;
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

    // killed by a grenade → thrown off the blast, flailing (overrides the
    // hit-direction logic below)
    const blast = this._blastAt(wx, wz, deck);
    if (blast) return this._blastImpulse(wx, wz, blast.cx, blast.cz, Math.hypot(wx - blast.cx, wz - blast.cz), blast.r);

    let dirX = 0, dirZ = 0, known = false, speed = R.launchSpeed;

    const agent = this.sim.byId.get(id);
    if (agent?.deathImpulse?.kind === 'melee') {
      const hit = agent.deathImpulse;
      return {
        dirX: hit.dirX, dirZ: hit.dirY,
        speed: hit.speed, up: hit.up, spin: hit.spin, kick: hit.kick,
      };
    }
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
    if (this._curD2 < CAST_NEAR2) this._castNear.add(set);
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
