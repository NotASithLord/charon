// physics/ragdoll.js — the classic-Halo cosmetic ragdoll solver.
//
// When a body dies, Halo hands it to physics: it goes limp, is thrown off the
// killing blow, tumbles, and settles into a heap. charon's dead used to snap
// flat (downed combat forms rotated to -90° over 380 ms; human corpses simply
// appeared prone) — REVIEW-PHYSICS-GAMEPLAY.md names this exact gap ("no
// ragdolls; corpses are grey boxes; downed forms rotate flat with zero
// transition"), and PLAN-ANIM-POLISH.md's P1 asks for "hit-direction deaths —
// fall away from the killing shot." This is that, done as real articulated
// physics rather than a canned pose.
//
// WHERE THIS SITS RELATIVE TO THE INVARIANT (docs/DESIGN-RAPIER-STACK.md):
// this is the "ragdoll flourish" the design doc explicitly puts OUTSIDE the
// authoritative, snapshot-hashable set. It is pure render-side cosmetics — it
// reads the AgentBuffer, it NEVER writes sim state, is never fingerprinted
// (sim.hashState / PhysicsWorld.snapshotHash never see it), and is never read
// back into the sim. So it cannot affect replay or P2P lockstep, and the sim
// stays byte-identical with this module present or absent.
//
// It is nonetheless DETERMINISTIC given identical inputs (fixed sub-step, no
// Math.random anywhere — per-body variety comes from a hash of the agent id),
// which is what makes the headless gate (physics/ragdoll-check.mjs) able to
// pin it. In the live game the step dt is a real frame delta, so cross-machine
// bit-equality is neither required nor claimed — it does not need to be, being
// cosmetic. why the fixed sub-step regardless: a physics integrator fed a
// variable frame dt is a stability hole; whole 1/120 s sub-steps keep the flop
// stable and frame-rate independent.
//
// No THREE, no DOM, no chrome.* — plain arrays for vec3 [x,y,z] and quat
// [x,y,z,w]. IO (the floor height under a point) is INJECTED as a function, so
// the solver is a pure functional core the shell (game/agents3d.js) drives and
// the Node gate exercises identically. why: same testability lever as
// physics-world.js — values in, values out, runs anywhere.

// The five limbs that hang off the torso root, matched to the six-part JMS rig
// (game/characters.js): torso is the root body itself, these swing about their
// joint pivots. `axis` is the limb's rest direction in model space (unit
// vector from the pivot toward the limb's far end) — legs and arms hang down,
// the head rides up — used to sag each limb toward gravity.
export const RAGDOLL_LIMBS = [
  { part: 'head', axis: [0, 1, 0] },
  { part: 'armL', axis: [0, -1, 0] },
  { part: 'armR', axis: [0, -1, 0] },
  { part: 'legL', axis: [0, -1, 0] },
  { part: 'legR', axis: [0, -1, 0] },
];

// --- tiny vec3 / quat kit (arrays; no allocation-heavy library) ------------

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.sqrt(dot3(a, a));
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Hamilton product a*b (apply b, then a).
function qmul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qnorm(q) {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  // a zero-length quat can only arise from a numeric blow-up; fall back to
  // identity rather than propagate a NaN (defensive — the clamps below make it
  // unreachable, but a cosmetic layer must never poison the render matrix).
  if (!(l > 1e-12)) return [0, 0, 0, 1];
  const k = 1 / l;
  return [q[0] * k, q[1] * k, q[2] * k, q[3] * k];
}

// unit-axis + angle -> quat
function qAxisAngle(axis, angle) {
  const l = len3(axis);
  if (!(l > 1e-12) || angle === 0) return [0, 0, 0, 1];
  const h = angle * 0.5, s = Math.sin(h) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

// rotate v by q (fast t = 2·(q.xyz × v) form)
function qrot(q, v) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];

// integrate a quaternion by an angular-velocity vector over dt (world frame if
// q maps model->world and omega is world; local if both are local). Rotation
// applied on the LEFT so a world omega rotates about world axes.
function qintegrate(q, omega, dt) {
  const a = len3(omega) * dt;
  if (a < 1e-9) return q;
  return qnorm(qmul(qAxisAngle(omega, a), q));
}

// the minimal rotation vector (axis·angle) of q, angle wrapped to [-π, π].
function qrotvec(q) {
  const v = [q[0], q[1], q[2]];
  const s = len3(v);
  if (s < 1e-9) return [0, 0, 0];
  let angle = 2 * Math.atan2(s, q[3]);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  const k = angle / s;
  return [v[0] * k, v[1] * k, v[2] * k];
}

// deterministic per-body scatter in [-1, 1] — stands in for Math.random so the
// solver stays reproducible (and headlessly checkable). Cheap integer hash.
function hash11(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 15), 0x119de1f5);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

// --- the solver ------------------------------------------------------------

// Sensible defaults; every value is overridable from shared/params.js
// (sim.P.ragdoll) so the feel is tunable without touching this file.
const DEFAULTS = {
  maxActive: 48,
  gravity: 22,
  bodyLen: 1.7, bodyRadius: 0.3, comY: 0.9,
  restitution: 0.18, groundFriction: 6.0, groundAngFriction: 5.0,
  linDamp: 0.1, angDamp: 1.0,
  maxLinSpeed: 24, maxAngSpeed: 28,
  sleepLin: 0.16, sleepAng: 0.4, sleepSec: 0.5,
  inertia: 1.2,
  limbGrav: 9, limbBind: 2.5, limbDamp: 3.0, limbLimit: 1.4, limbKick: 6.0,
  subDt: 1 / 120, maxSubSteps: 8, dtCap: 0.05,
};

export class RagdollSystem {
  constructor(params = {}) {
    this.p = { ...DEFAULTS, ...params };
    this._byId = new Map(); // agentId -> ragdoll
    this._acc = 0;          // shared fixed-step accumulator
    this._seq = 0;          // spawn order, for oldest-first eviction
  }

  get size() { return this._byId.size; }
  has(id) { return this._byId.has(id); }
  get(id) { return this._byId.get(id); }
  remove(id) { this._byId.delete(id); }
  clear() { this._byId.clear(); }

  // Spawn a ragdoll for a just-dead body.
  //   pose:    { x, y, z, heading, deck }  world-space feet position + facing
  //   impulse: { dirX, dirZ, speed, up, spin, kick }  the launch off the blow
  //   groundYAt: (x, z) => floorY   injected floor sampler (deck-bound closure)
  // Returns the ragdoll, or null if disabled. Enforces the concurrent cap by
  // evicting the oldest ASLEEP body first (already settled — least missed),
  // falling back to the oldest overall; the evicted id then renders as a plain
  // static corpse via the caller's fallback path.
  spawn(id, pose, impulse, groundYAt) {
    const p = this.p;
    if (p.maxActive <= 0) return null;
    if (!this._byId.has(id)) this._evictIfFull();

    // root orientation from the facing, so it starts exactly where the standing
    // pose stood — then physics tips it over (no pop-in).
    const rootQuat = qAxisAngle([0, 1, 0], pose.heading);
    const spin = impulse.spin ?? p.limbKick;
    // tumble about an axis perpendicular to the launch (a forward pitch),
    // scattered per body so no two flops read the same.
    const dl = Math.hypot(impulse.dirX, impulse.dirZ) || 1;
    const dx = impulse.dirX / dl, dz = impulse.dirZ / dl;
    const tumbleAxis = [-dz, hash11(id ^ 0x51) * 0.5, dx]; // mostly horizontal, ⟂ to travel
    const ta = len3(tumbleAxis) || 1;
    const omega = [
      (tumbleAxis[0] / ta) * spin,
      (tumbleAxis[1] / ta) * spin,
      (tumbleAxis[2] / ta) * spin,
    ];
    const vel = [
      dx * impulse.speed + hash11(id ^ 0x11) * 0.6,
      (impulse.up ?? 2.5) + hash11(id ^ 0x22) * 0.5,
      dz * impulse.speed + hash11(id ^ 0x33) * 0.6,
    ];

    // limbs: identity (bind) pose + a per-limb angular kick so they flail off
    // the hit, biggest for a violent (charging/leaping) death.
    const kick = impulse.kick ?? p.limbKick;
    const limbs = {};
    const limbState = {};
    for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
      const { part } = RAGDOLL_LIMBS[k];
      const salt = id * 7 + k * 131;
      const lo = [hash11(salt) * kick, hash11(salt ^ 0x5a) * kick, hash11(salt ^ 0xa5) * kick];
      limbs[part] = [0, 0, 0, 1];
      limbState[part] = { q: limbs[part], omega: lo };
    }

    const rag = {
      id,
      rootPos: [pose.x, pose.y, pose.z],
      rootQuat,
      vel, omega,
      limbs,               // part -> quat (the render reads this)
      limbState,           // part -> { q, omega }
      groundYAt,
      asleep: false,
      sleepT: 0,
      seq: this._seq++,
      // where the sim placed the body at spawn — if the sim later MOVES it far
      // (a carrier dragging a corpse, a reanimation relocation, any teleport),
      // the caller drops the ragdoll and hands rendering back to the sim.
      originX: pose.x, originZ: pose.z, deck: pose.deck,
    };
    this._byId.set(id, rag);
    return rag;
  }

  _evictIfFull() {
    if (this._byId.size < this.p.maxActive) return;
    let victim = null;
    for (const r of this._byId.values()) {
      if (!victim) { victim = r; continue; }
      // prefer an already-asleep body; among equals, the oldest.
      const better = (r.asleep && !victim.asleep)
        || (r.asleep === victim.asleep && r.seq < victim.seq);
      if (better) victim = r;
    }
    if (victim) this._byId.delete(victim.id);
  }

  // Advance every awake ragdoll by a real frame delta, in whole fixed sub-steps
  // (leftover carried in the accumulator). Capped sub-steps so a stalled frame
  // can't spiral. Asleep bodies are frozen — free to keep around as the resting
  // pose until the sim removes the corpse.
  step(dtReal) {
    const p = this.p;
    this._acc += Math.min(dtReal, p.dtCap);
    let n = 0;
    while (this._acc >= p.subDt && n < p.maxSubSteps) {
      for (const r of this._byId.values()) if (!r.asleep) this._sub(r, p.subDt);
      this._acc -= p.subDt;
      n++;
    }
    if (n >= p.maxSubSteps) this._acc = 0;
  }

  _sub(r, dt) {
    const p = this.p;

    // 1) gravity + semi-implicit integrate of the root
    r.vel[1] -= p.gravity * dt;
    r.rootPos[0] += r.vel[0] * dt;
    r.rootPos[1] += r.vel[1] * dt;
    r.rootPos[2] += r.vel[2] * dt;
    r.rootQuat = qintegrate(r.rootQuat, r.omega, dt);

    // 2) floor contact for the two capsule ends (feet-end + head-end). The
    // torso is a capsule from y=radius to y=bodyLen-radius in model space; two
    // contact spheres at its ends make it TUMBLE (a shoulder landing first flips
    // it) and settle flat (both ends resting is the only stable pose). Contacts
    // are resolved AFTER integration (post-stabilisation): impulse first, then
    // project the penetration straight out — simple and unconditionally stable.
    const rr = p.bodyRadius;
    // world centre of mass = rootPos + R·(0, comY, 0)
    const comOff = qrot(r.rootQuat, [0, p.comY, 0]);
    const com = [
      r.rootPos[0] + comOff[0],
      r.rootPos[1] + comOff[1],
      r.rootPos[2] + comOff[2],
    ];

    let grounded = false;
    let maxPen = 0;
    for (const localY of [rr, p.bodyLen - rr]) {
      const off = qrot(r.rootQuat, [0, localY, 0]);
      const P = [r.rootPos[0] + off[0], r.rootPos[1] + off[1], r.rootPos[2] + off[2]];
      const floorY = r.groundYAt(P[0], P[2]);
      const pen = (floorY + rr) - P[1];
      if (pen <= 0) continue;
      grounded = true;
      if (pen > maxPen) maxPen = pen;

      // velocity of this contact point: vel + omega × (P - com)
      const rVec = [P[0] - com[0], P[1] - com[1], P[2] - com[2]];
      const wxr = cross3(r.omega, rVec);
      const vn = r.vel[1] + wxr[1]; // n = +Y
      if (vn < 0) {
        // scalar-inertia normal impulse: j = -(1+e)·vn / (1/m + |r×n|²/I)
        const rxn = cross3(rVec, [0, 1, 0]);
        const denom = 1 + dot3(rxn, rxn) / p.inertia;
        const j = (-(1 + p.restitution) * vn) / denom;
        r.vel[1] += j;                 // n·j, mass = 1
        const dOmega = cross3(rVec, [0, j, 0]);
        r.omega[0] += dOmega[0] / p.inertia;
        r.omega[1] += dOmega[1] / p.inertia;
        r.omega[2] += dOmega[2] / p.inertia;
      }
    }
    // project the deepest penetration out — pure position fix, injects no
    // energy, so it can never destabilise.
    if (maxPen > 0) r.rootPos[1] += maxPen;

    // 3) friction as damping while grounded (never adds energy → always stable)
    if (grounded) {
      const fk = Math.exp(-p.groundFriction * dt);
      r.vel[0] *= fk; r.vel[2] *= fk;
      const ak = Math.exp(-p.groundAngFriction * dt);
      r.omega[0] *= ak; r.omega[1] *= ak; r.omega[2] *= ak;
    }

    // 4) global damping + hard clamps (the stability backstop: the state simply
    // cannot grow past these, so no impulse or contact can ever blow it up)
    const ld = Math.exp(-p.linDamp * dt), ad = Math.exp(-p.angDamp * dt);
    r.vel[0] *= ld; r.vel[1] *= ld; r.vel[2] *= ld;
    r.omega[0] *= ad; r.omega[1] *= ad; r.omega[2] *= ad;
    clampVec(r.vel, p.maxLinSpeed);
    clampVec(r.omega, p.maxAngSpeed);

    // 5) limbs — each a damped limb sagging toward gravity, clamped to its joint
    // limit so it can't fold through the body.
    const gLocal = qrot(qconj(r.rootQuat), [0, -1, 0]); // world-down in torso frame
    for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
      const { part, axis } = RAGDOLL_LIMBS[k];
      const st = r.limbState[part];
      // sag: rotate the limb's current direction toward gravity
      const cur = qrot(st.q, axis);
      const tq = cross3(cur, gLocal);
      st.omega[0] += tq[0] * p.limbGrav * dt;
      st.omega[1] += tq[1] * p.limbGrav * dt;
      st.omega[2] += tq[2] * p.limbGrav * dt;
      // bind spring: pull back toward the rest pose so joints have some stiffness
      const rv = qrotvec(st.q);
      st.omega[0] -= rv[0] * p.limbBind * dt;
      st.omega[1] -= rv[1] * p.limbBind * dt;
      st.omega[2] -= rv[2] * p.limbBind * dt;
      // damp + integrate
      const dk = Math.exp(-p.limbDamp * dt);
      st.omega[0] *= dk; st.omega[1] *= dk; st.omega[2] *= dk;
      clampVec(st.omega, p.maxAngSpeed);
      st.q = qintegrate(st.q, st.omega, dt);
      // clamp to the joint limit: if the swing exceeds it, pin to the limit and
      // kill the outward angular velocity (no energy injected).
      const sv = qrotvec(st.q);
      const sa = len3(sv);
      if (sa > p.limbLimit) {
        const s = p.limbLimit / sa;
        st.q = qAxisAngle(sv, p.limbLimit);
        st.omega[0] *= s * 0.5; st.omega[1] *= s * 0.5; st.omega[2] *= s * 0.5;
      }
      r.limbs[part] = st.q;
    }

    // 6) sleep: once grounded and barely moving for sleepSec, freeze the pose.
    // This is the resting corpse — cheap forever after, and no perpetual jitter.
    if (grounded && len3(r.vel) < p.sleepLin && len3(r.omega) < p.sleepAng) {
      r.sleepT += dt;
      if (r.sleepT >= p.sleepSec) r.asleep = true;
    } else {
      r.sleepT = 0;
    }
  }
}

function clampVec(v, max) {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l > max) {
    const k = max / l;
    v[0] *= k; v[1] *= k; v[2] *= k;
  }
}
