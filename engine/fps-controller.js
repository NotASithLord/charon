// FTL ENGINE · fps-controller — the first-person movement core: pointer-
// lock mouse look, exponential-accel walking (the "first-strike feel"),
// jump/gravity, a Rapier-swept capsule for horizontal collision with
// analytic vertical (ground snap, step-down glue, ceiling clamp), and
// render-pose interpolation between fixed physics steps.
//
// The controller is deterministic: it is stepped at a fixed dt from the
// host's accumulator, and the camera interpolates between the last two
// steps. It knows nothing about any game: floors, ceilings and level
// stacking come in as callbacks (`elevOf(deck)`, `groundHeightAt(deck, x,
// z, feetY)`, `ceilHeightAt(deck, x, z)`), and hosts subclass to add
// their own game state (health models, climbing, portals) — override
// `poseY()` if something other than the deck floor owns your height.
//
//   tune: { walkSpeed, sprintSpeed, accel, airControl, jumpVel, gravity,
//           eyeHeight, ... }   (hosts may carry extra fields)

export class FpsController {
  constructor({ canvas, tune, deck, x, z, elevOf, groundHeightAt, ceilHeightAt, physics = null }) {
    this.canvas = canvas;
    this.tune = tune;
    this.elevOf = elevOf;
    this.groundHeightAtFn = groundHeightAt;
    this.ceilHeightAtFn = ceilHeightAt;
    this.physics = physics;
    this.deck = deck;
    this.x = x; this.z = z;
    this.h = 0; // feet height above current deck floor
    this.vx = 0; this.vz = 0; this.vy = 0;
    // KNOCKBACK, on its own channel. It cannot live in vx/vz: stepMove blends
    // those toward the WALK INPUT every step (accel 14 → ~21% per frame), so a
    // shove poked in there is gone in about 50 ms and reads as a stutter
    // rather than a hit. This decays on its own clock and is added to the
    // sweep, so being hit moves you even while you hold W into it.
    this.shoveX = 0; this.shoveZ = 0;
    this.onGround = true;
    this.yaw = -Math.PI / 2; this.pitch = 0;
    this.keys = new Set();
    this.locked = false;

    if (this.physics) this.physics.spawnPlayer(this.x, this.elevOf(this.deck) + this.h, this.z);

    // render interpolation between the last two fixed physics steps
    this._prev = this._worldPose();
    this._cur = this._worldPose();

    canvas.addEventListener('click', () => { if (!this.locked) canvas.requestPointerLock(); });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * 0.0022));
    });
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  // Wire the physics world once its wasm is ready. why deferred: a slow or
  // failed physics load must never wedge the host on its loading screen, so
  // the controller boots without it and just holds still.
  attachPhysics(physics) {
    this.physics = physics;
    physics.spawnPlayer(this.x, this.elevOf(this.deck) + this.h, this.z);
    this._prev = this._worldPose();
    this._cur = this._worldPose();
  }

  // feet world Y — hosts override when something other than the deck floor
  // owns the height (a climb transition, a vehicle, a ledge grab)
  poseY() { return this.elevOf(this.deck) + this.h; }

  _worldPose() { return { x: this.x, y: this.poseY(), z: this.z }; }

  // adopt the X/Z the physics world committed last step (walking moves the
  // capsule through the controller; teleports set it directly — both are
  // already reflected in the capsule, so this re-syncs us to the truth)
  adoptCapsule() {
    const c = this.physics.playerCenter();
    this.x = c.x; this.z = c.z;
  }

  // ONE fixed-timestep walking step: input → exponential-accel velocity →
  // capsule sweep (slides along whatever it hits) → analytic vertical
  // (ground rest, step-down snap, ceiling clamp)
  stepMove(dt) {
    const T = this.tune;
    let fx = 0, fz = 0;
    if (this.keys.has('KeyW')) fz += 1;
    if (this.keys.has('KeyS')) fz -= 1;
    if (this.keys.has('KeyA')) fx -= 1;
    if (this.keys.has('KeyD')) fx += 1;
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprint ? T.sprintSpeed : T.walkSpeed;
    let wx = 0, wz = 0;
    if (fx || fz) {
      const len = Math.hypot(fx, fz);
      const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
      const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
      wx = (fwdX * fz + rightX * fx) / len * speed;
      wz = (fwdZ * fz + rightZ * fx) / len * speed;
    }
    const k = this.onGround ? T.accel : T.accel * T.airControl;
    const blend = 1 - Math.exp(-k * dt);
    this.vx += (wx - this.vx) * blend;
    this.vz += (wz - this.vz) * blend;

    if (this.keys.has('Space') && this.onGround) {
      this.vy = T.jumpVel;
      this.onGround = false;
    }
    this.vy -= T.gravity * dt;

    // horizontal: the character controller sweeps the capsule and slides it
    // along whatever it hits (walls, cover, bodies)
    const wantX = (this.vx + this.shoveX) * dt, wantZ = (this.vz + this.shoveZ) * dt;
    const moved = this.physics.movePlayer(wantX, wantZ, this.elevOf(this.deck) + this.h);
    this.x += moved.dx;
    this.z += moved.dz;
    // bleed the velocity we couldn't spend into whatever we hit, so we don't
    // keep ramming a wall at full tilt — the shove bleeds too, so being
    // knocked into a bulkhead stops you dead instead of pinning you to it
    if (Math.abs(moved.dx) < Math.abs(wantX) - 1e-4) { this.vx *= 0.2; this.shoveX *= 0.2; }
    if (Math.abs(moved.dz) < Math.abs(wantZ) - 1e-4) { this.vz *= 0.2; this.shoveZ *= 0.2; }
    const sd = Math.exp(-(T.shoveDecayPerSec ?? 7) * dt);
    this.shoveX *= sd; this.shoveZ *= sd;

    // vertical: feet rest on the ground surface (which may follow ramps —
    // the injected groundHeightAt decides)
    const base = this.elevOf(this.deck);
    const groundY = this.groundHeightAtFn(this.deck, this.x, this.z, base + this.h);
    const wasGrounded = this.onGround;
    let footY = base + this.h + this.vy * dt;
    if (footY <= groundY) { footY = groundY; this.vy = 0; this.onGround = true; }
    else if (wasGrounded && this.vy <= 0 && footY - groundY < 0.55) {
      // STEP-DOWN SNAP: walking down a ramp, gravity alone can't keep pace
      // with the surface dropping away — without this the player goes
      // micro-airborne every step, loses ground control, and crawls down
      // the flights. Grounded + not jumping + surface within a step below =
      // stay glued.
      footY = groundY; this.vy = 0; this.onGround = true;
    } else this.onGround = false;
    this.h = footY - base;
    const ceilH = this.ceilHeightAtFn(this.deck, this.x, this.z);
    if (this.h > ceilH - 1.85) { this.h = ceilH - 1.85; this.vy = Math.min(0, this.vy); }
  }

  // pinned or unlocked: hold position, but keep the capsule's Y tracking the
  // floor and its next-translation set every step (kinematic bodies want a
  // fresh target each tick)
  holdStill() {
    this.physics.movePlayer(0, 0, this.elevOf(this.deck) + this.h);
  }

  // CURRENT (non-interpolated) eye pose — for lights, projectile spawn
  // points, anything that wants "where the player is right now"
  cameraPose() {
    return { x: this.x, y: this.poseY() + this.tune.eyeHeight, z: this.z, yaw: this.yaw, pitch: this.pitch };
  }

  // Interpolated eye pose for rendering — blends the last two fixed physics
  // steps by `alpha` (the accumulator remainder) so the camera stays smooth
  // between fixed-rate physics ticks and whatever the display refresh is.
  renderPose(alpha) {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const p = this._prev, c = this._cur;
    return {
      x: p.x + (c.x - p.x) * a,
      y: p.y + (c.y - p.y) * a + this.tune.eyeHeight,
      z: p.z + (c.z - p.z) * a,
      yaw: this.yaw, pitch: this.pitch,
    };
  }
}
