// The ODST — first-person controller with the first-strike movement feel
// (exponential accel, gravity, jump) and ballistic-armor-over-health. The
// player is a live sim agent: the flood hunts them, grabs pin them, conversion
// takes them.
//
// Collision moved to Rapier (physics/physics-world.js): HORIZONTAL motion is a
// swept capsule resolved by the character controller — sliding along walls and
// cover, blocked by other bodies — replacing the old grid `isWalkable` slide
// and the manual sphere-separation pass. VERTICAL stays analytic here (gravity,
// resting on the floor, the stairwell ramp) because full-height wall boxes are
// all the horizontal sweep needs, so the two layers stay cleanly split. The
// capsule is the authoritative X/Z; walking asks the controller to move it and
// climbs/stair-portals teleport it. why fixed-step: the controller is stepped
// at a fixed PHYS_DT from main.js's accumulator, so player physics is
// deterministic (replay + lockstep depend on it) and the camera interpolates
// between the last two steps for smoothness.
//
// L (not W) climbs a ladder/stairwell you're standing at — walking past a
// ladder shouldn't yank you up it, and a shaft only ever has ONE other end
// from where you stand, so the direction is never a guess.

import { elevOf } from './world.js';
import { ODST } from './fps-data.js';

export class Player {
  constructor(canvas, world, sim, startNode, physics) {
    this.world = world;
    this.sim = sim;
    this.physics = physics ?? null;
    this.canvas = canvas;
    const n = sim.graph.node(startNode);
    this.deck = n.deck;
    const [wx, wz] = world.simToWorld(n.x, n.y, n.deck);
    this.x = wx; this.z = wz;
    this.h = 0; // feet height above current deck floor
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.onGround = true;
    this.climbing = false;
    this.climb = null; // active climb transition, see _startClimb
    this.queuedTrunk = null; // waiting in line for a busy ladder
    this.yaw = -Math.PI / 2; this.pitch = 0;
    this.keys = new Set();
    this.locked = false;
    this.armed = true; // ODST loadout: you board with the MA5
    this._eLatch = false;
    this._wLatch = false;
    this._armoryIdx = sim.graph.byId.get('armory');

    // armor over health (first-strike shield model, ODST-flavored)
    this.armor = ODST.armor;
    this.sinceHit = 99;

    this.agent = sim.attachPlayer(startNode, { odst: true });
    this._lastHp = this.agent.hp;

    // the Rapier capsule holds the authoritative X/Z. Physics may not be ready
    // yet — attachPhysics() wires it when the wasm finishes loading; until then
    // the player just holds still, so the intro/UI never block on the load.
    if (this.physics) this.physics.spawnPlayer(this.x, elevOf(this.deck) + this.h, this.z);

    // render interpolation between the last two fixed physics steps
    this._prev = this._worldPose();
    this._cur = this._worldPose();

    this._syncAgent();

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

  // Wire the Rapier world once its wasm is ready (main.js calls this from the
  // initRapier().then()). why deferred: a slow or failed physics load must
  // never wedge the game on the loading screen, so the player boots without it.
  attachPhysics(physics) {
    this.physics = physics;
    physics.spawnPlayer(this.x, elevOf(this.deck) + this.h, this.z);
    this._prev = this._worldPose();
    this._cur = this._worldPose();
  }

  get dead() { return this.agent.dead || this.agent.hp <= 0; }
  get pinned() { return this.agent.held === this.sim.tickCount; }

  // feet world position (Y follows the climb transition or the deck floor)
  _worldPose() {
    const y = this.climb ? this.climb.worldY : elevOf(this.deck) + this.h;
    return { x: this.x, y, z: this.z };
  }

  // ONE fixed-timestep step (dt === PHYS_DT), driven by main.js's accumulator.
  step(dt) {
    if (!this.physics) return; // physics not attached yet — hold still
    this._prev = this._cur;

    // adopt the X/Z the physics world committed last step (walking moves the
    // capsule through the controller; teleports set it directly — both are
    // already reflected in the capsule, so this re-syncs us to the truth)
    if (!this.dead) {
      const c = this.physics.playerCenter();
      this.x = c.x; this.z = c.z;
    }
    if (this.dead) { this._cur = this._worldPose(); return; }

    // --- armor layer: intercept sim damage; armor soaks, then recovers ---
    const hpNow = this.agent.hp;
    if (hpNow < this._lastHp) {
      const dmg = this._lastHp - hpNow;
      const absorbed = Math.min(this.armor, dmg);
      this.agent.hp = Math.min(this.agent.maxHp, hpNow + absorbed);
      this.armor = Math.max(0, this.armor - dmg);
      this.sinceHit = 0;
    }
    this._lastHp = this.agent.hp;
    this.sinceHit += dt;
    if (this.sinceHit >= ODST.armorDelayS && this.armor < ODST.armor) {
      this.armor = Math.min(ODST.armor, this.armor + ODST.armorRegenPerS * dt);
    }

    // --- E: scavenge ammo from the armory rack or the armed dead ---
    if (this.keys.has('KeyE') && !this._eLatch) {
      this._eLatch = true;
      const src = this.ammoSource();
      if (src && this.onAmmoTaken) this.onAmmoTaken(src);
    } else if (!this.keys.has('KeyE')) this._eLatch = false;

    const wantFwd = this.keys.has('KeyW');
    const wantClimb = this.keys.has('KeyL');

    // --- climbing: press L at a shaft, arrive at its only other end ---
    this.climbing = !!this.climb;
    if (this.climb) {
      this._stepClimb(dt);
    } else {
      const trunk = this.world.trunkAt(this.deck, this.x, this.z);
      // QUEUED: a busy ladder puts you in line; go the moment the rungs clear.
      if (this.queuedTrunk) {
        if (trunk !== this.queuedTrunk || this.pinned || this.dead) this._cancelQueue();
        else if (!this.sim.vertBusy(this.queuedTrunk.edge, this.agent.id)) {
          const q = this.queuedTrunk;
          this._cancelQueue();
          this._startClimb(q);
        }
      }
      if (trunk && this.locked && !this.pinned && wantClimb && !this._wLatch) {
        this._startClimb(trunk);
        this._wLatch = true;
      }
    }
    if (!wantClimb) this._wLatch = false;

    // --- walking (first-strike accel model, Rapier-resolved horizontal) ---
    if (!this.climbing && this.locked && !this.pinned) {
      let fx = 0, fz = 0;
      if (wantFwd) fz += 1;
      if (this.keys.has('KeyS')) fz -= 1;
      if (this.keys.has('KeyA')) fx -= 1;
      if (this.keys.has('KeyD')) fx += 1;
      const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = sprint ? ODST.sprintSpeed : ODST.walkSpeed;
      let wx = 0, wz = 0;
      if (fx || fz) {
        const len = Math.hypot(fx, fz);
        const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
        wx = (fwdX * fz + rightX * fx) / len * speed;
        wz = (fwdZ * fz + rightZ * fx) / len * speed;
      }
      const k = this.onGround ? ODST.accel : ODST.accel * ODST.airControl;
      const blend = 1 - Math.exp(-k * dt);
      this.vx += (wx - this.vx) * blend;
      this.vz += (wz - this.vz) * blend;

      if (this.keys.has('Space') && this.onGround) {
        this.vy = ODST.jumpVel;
        this.onGround = false;
      }
      this.vy -= ODST.gravity * dt;

      // horizontal: the character controller sweeps the capsule and slides it
      // along whatever it hits (walls, cover, bodies)
      const wantX = this.vx * dt, wantZ = this.vz * dt;
      const moved = this.physics.movePlayer(wantX, wantZ, elevOf(this.deck) + this.h);
      this.x += moved.dx;
      this.z += moved.dz;
      // bleed the velocity we couldn't spend into whatever we hit, so we don't
      // keep ramming a wall at full tilt
      if (Math.abs(moved.dx) < Math.abs(wantX) - 1e-4) this.vx *= 0.2;
      if (Math.abs(moved.dz) < Math.abs(wantZ) - 1e-4) this.vz *= 0.2;

      // vertical: feet rest on the ground surface, which in a stairwell room
      // follows the switchback ramp (world.groundHeightAt)
      const base = elevOf(this.deck);
      const groundY = this.world.groundHeightAt(this.deck, this.x, this.z);
      let footY = base + this.h + this.vy * dt;
      if (footY <= groundY) { footY = groundY; this.vy = 0; this.onGround = true; }
      else this.onGround = false;
      this.h = footY - base;
      const ceilH = this.world.ceilHeightAt(this.deck, this.x, this.z);
      if (this.h > ceilH - 1.85) { this.h = ceilH - 1.85; this.vy = Math.min(0, this.vy); }
    } else if (!this.climb) {
      // pinned or unlocked: hold position, but keep the capsule's Y tracking
      // the floor and its next-translation set every step (kinematic bodies
      // want a fresh target each tick)
      this.physics.movePlayer(0, 0, elevOf(this.deck) + this.h);
    }

    this._stairPortal();
    this._syncAgent();
    this._cur = this._worldPose();
  }

  // Begin a climb: figure out the shaft's OTHER end from wherever we're
  // standing (there is only ever one) and animate straight to it.
  _startClimb(trunk) {
    // one body on the LADDER at a time — if an NPC is on the rungs, reserve
    // the next slot and auto-climb when clear. Lifts are cars — no queue.
    const link = trunk.edge?.type === 'ladder' ? trunk.edge : null;
    if (link && this.sim.vertBusy(link, this.agent.id)) {
      link.reservedBy = this.agent.id;
      this.queuedTrunk = trunk;
      return;
    }
    if (link && link.reservedBy === this.agent.id) link.reservedBy = undefined;
    const fromDeck = this.deck;
    const atLower = fromDeck === trunk.lowerDeck;
    const toDeck = atLower ? trunk.upperDeck : trunk.lowerDeck;
    let tx, tz;
    if (trunk.vertical) { tx = trunk.x; tz = trunk.z; }
    else { const dest = atLower ? trunk.high : trunk.low; tx = dest.x; tz = dest.z; }
    const rise = Math.abs(trunk.highElev - trunk.lowElev);
    if (link) { link.occupiedBy = this.agent.id; this.agent.climbingLink = link; }
    this.climb = {
      fromDeck, toDeck, fromX: this.x, fromZ: this.z, tx, tz, link,
      t: 0, dur: Math.max(0.5, Math.min(2.2, rise / ODST.climbSpeed)),
      worldY: elevOf(fromDeck) + this.h,
    };
    this.vx = this.vz = this.vy = 0;
  }

  _cancelQueue() {
    const e = this.queuedTrunk?.edge;
    if (e && e.reservedBy === this.agent.id) e.reservedBy = undefined;
    this.queuedTrunk = null;
  }

  // GRAND STAIRWELL: entering from the corridor is a normal same-deck doorway.
  // The only deck change is at the BOTTOM of the stairs, where the switchback
  // lands on the hangar deck below: crossing the stair mouth flips the player
  // between the stairwell room and the hangar with world height preserved.
  _stairPortal() {
    if (this.climb) return;
    for (const g of (this.world.stairRooms ?? [])) {
      const hangarDeck = g.deck + 1;
      const baseZ = g.wellCz - g.wellHz;   // front edge = foot of the stairs
      const inWellX = this.x >= g.wellCx - 0.3 && this.x <= g.wellCx + g.wellHx + 0.5;
      const worldY = elevOf(this.deck) + this.h;
      if (this.deck === g.deck) {
        if (worldY <= g.loElev + 0.45 && inWellX && this.z <= baseZ + 0.4 && this.vz < 0.05) {
          this.deck = hangarDeck;
          this.z = baseZ - 0.8;
          this.h = worldY - elevOf(hangarDeck); // continuous world height (~0)
          this.vy = 0; this.onGround = true;
          this.physics.teleportPlayer(this.x, worldY, this.z);
        }
      } else if (this.deck === hangarDeck) {
        if (inWellX && this.z >= baseZ - 0.6 && this.z <= baseZ + 0.15 && this.vz > 0.05) {
          this.deck = g.deck;
          this.z = baseZ + 0.6;
          this.h = worldY - elevOf(g.deck);     // negative (below the entry floor)
          this.vy = 0; this.onGround = true;
          this.physics.teleportPlayer(this.x, worldY, this.z);
        }
      }
    }
  }

  _stepClimb(dt) {
    const c = this.climb;
    c.t += dt;
    const p = Math.min(1, c.t / c.dur);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    this.x = c.fromX + (c.tx - c.fromX) * ease;
    this.z = c.fromZ + (c.tz - c.fromZ) * ease;
    c.worldY = elevOf(c.fromDeck) + (elevOf(c.toDeck) - elevOf(c.fromDeck)) * ease;
    // keep the capsule pinned to the climb path (no controller sweep mid-climb)
    this.physics.teleportPlayer(this.x, c.worldY, this.z);
    if (p >= 1) {
      this.deck = c.toDeck;
      this.x = c.tx; this.z = c.tz;
      this.h = 0;
      if (c.link && c.link.occupiedBy === this.agent.id) c.link.occupiedBy = undefined;
      this.agent.climbingLink = null;
      this.climb = null;
      this.physics.teleportPlayer(this.x, elevOf(this.deck) + this.h, this.z);
    }
  }

  _syncAgent() {
    const a = this.agent;
    if (a.dead) return;
    const [sx, sy] = this.world.worldToSim(this.x, this.z, this.deck);
    a.x = sx; a.y = sy;
    a.deck = this.deck;
    a.node = this.world.roomAt(this.deck, sx, sy, a.node);
    a.heading = Math.atan2(-Math.cos(this.yaw), -Math.sin(this.yaw));
  }

  // ammo scavenging: the rack, or rifles on the armed dead
  ammoSource() {
    if (this.dead) return null;
    if (this.agent.node === this._armoryIdx && this.sim.armoryStock > 0) return 'armory';
    const [sx, sy] = this.world.worldToSim(this.x, this.z, this.deck);
    for (const c of this.sim.agents) {
      if (c.dead || c.faction !== 6 || !c.wasArmed || c.damage >= 100) continue;
      if (this.sim.graph.node(c.node).deck !== this.deck) continue;
      const dx = c.x - sx, dy = c.y - sy;
      if (dx * dx + dy * dy < 2.2 * 2.2) return c;
    }
    return null;
  }

  // CURRENT (non-interpolated) eye pose — for the flashlight, the thrown-frag
  // spawn point, and anything that wants "where the player is right now".
  cameraPose() {
    const y = this.climb ? this.climb.worldY : elevOf(this.deck) + this.h;
    return { x: this.x, y: y + ODST.eyeHeight, z: this.z, yaw: this.yaw, pitch: this.pitch };
  }

  // Interpolated eye pose for rendering — blends the last two fixed physics
  // steps by `alpha` (the accumulator remainder) so the camera stays smooth
  // between 60 Hz physics ticks and whatever the display refresh is.
  renderPose(alpha) {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const p = this._prev, c = this._cur;
    return {
      x: p.x + (c.x - p.x) * a,
      y: p.y + (c.y - p.y) * a + ODST.eyeHeight,
      z: p.z + (c.z - p.z) * a,
      yaw: this.yaw, pitch: this.pitch,
    };
  }
}
