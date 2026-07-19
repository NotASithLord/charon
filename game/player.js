// The ODST — first-person controller with the first-strike movement feel
// (exponential accel, gravity, jump), ballistic-armor-over-health, and real
// vertical shafts (not teleport pads): stand at a ladder/stairwell and press
// L to climb it (L, not W — W is forward; walking past a ladder shouldn't
// yank you up it). Direction is never ambiguous (user note: no more guessing
// whether looking up/down goes up or down) — a shaft only ever has ONE other
// end from wherever you're standing, so L always takes you there, with a
// brief climb animation instead of an instant cut. The player is a live sim
// agent: the flood hunts them, grabs pin them, conversion takes them.

import { elevOf, CLEAR_H } from './world.js';
import { ODST } from './fps-data.js';

export class Player {
  constructor(canvas, world, sim, startNode) {
    this.world = world;
    this.sim = sim;
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

  get dead() { return this.agent.dead || this.agent.hp <= 0; }
  get pinned() { return this.agent.held === this.sim.tickCount; }

  update(dt) {
    if (this.dead) return;

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

    // --- climbing: press L at a shaft (not W — that's forward, and walking
    // past a ladder shouldn't yank you up it), arrive at its only other end ---
    this.climbing = !!this.climb;
    if (this.climb) {
      this._stepClimb(dt);
    } else {
      const trunk = this.world.trunkAt(this.deck, this.x, this.z);
      // QUEUED (user rule): a busy ladder puts you in line, it doesn't deny
      // you. Hold the reservation while you stand at the pad and go the
      // moment the rungs clear; stepping away lets your place go.
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

    // --- walking (first-strike accel model) ---
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

      // --- integrate horizontal with wall slide ---
      this._move(this.vx * dt, this.vz * dt);

      // --- integrate vertical: floor only (falling through an open hatch
      // is not a traversal method here — climbing is explicit, via W) ---
      let footY = elevOf(this.deck) + this.h + this.vy * dt;
      this.h = footY - elevOf(this.deck);
      if (this.h <= 0) { this.h = 0; this.vy = 0; this.onGround = true; }
      else this.onGround = false;
      if (this.h > CLEAR_H - 1.85) { this.h = CLEAR_H - 1.85; this.vy = Math.min(0, this.vy); }
    }

    this._syncAgent();
  }

  // Begin a climb: figure out the shaft's OTHER end from wherever we're
  // standing (there is only ever one) and animate straight to it. Direction
  // is never a guess (user note) — up if you're on the lower deck, down if
  // you're on the upper one, full stop.
  _startClimb(trunk) {
    // QUEUED CLIMBING (user rule): one body on the LADDER at a time — if an
    // NPC is on the rungs, the press does nothing (the HUD shows the wait);
    // while WE climb, the claim keeps NPCs at the pads. Lifts are cars —
    // everyone rides together, no queue.
    const link = trunk.edge?.type === 'ladder' ? trunk.edge : null;
    if (link && this.sim.vertBusy(link, this.agent.id)) {
      // IN LINE (user rule): reserve the next slot — NPCs hold at the pads
      // until you've gone (sim.vertReserved) — and auto-climb when clear
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

  _stepClimb(dt) {
    const c = this.climb;
    c.t += dt;
    const p = Math.min(1, c.t / c.dur);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    this.x = c.fromX + (c.tx - c.fromX) * ease;
    this.z = c.fromZ + (c.tz - c.fromZ) * ease;
    c.worldY = elevOf(c.fromDeck) + (elevOf(c.toDeck) - elevOf(c.fromDeck)) * ease;
    if (p >= 1) {
      this.deck = c.toDeck;
      this.x = c.tx; this.z = c.tz;
      this.h = 0;
      if (c.link && c.link.occupiedBy === this.agent.id) c.link.occupiedBy = undefined;
      this.agent.climbingLink = null;
      this.climb = null;
    }
  }

  _move(mx, mz) {
    const w = this.world;
    const [, sy0] = w.worldToSim(this.x, this.z, this.deck);
    const [sx1, sy1] = w.worldToSim(this.x + mx, this.z + mz, this.deck);
    let nx = this.x, nz = this.z;
    if (w.isWalkable(this.deck, sx1, sy0) && !w.propBlocked(this.deck, sx1, sy0)) nx = this.x + mx;
    if (w.isWalkable(this.deck, nx, sy1) && !w.propBlocked(this.deck, nx, sy1)) nz = this.z + mz;
    this.x = nx; this.z = nz;
    this._collideBodies();
  }

  // SOLID BODIES apply to you too (review P0): you can't walk through a
  // marine or a combat form — slide around them like the sim's separation
  // pass does for everyone else. Corpses and downed forms are stepped over.
  _collideBodies() {
    const R = { 3: 0.32, 4: 0.48, 5: 0.75 }; // infection/combat/carrier; humans 0.4
    for (const a of this.sim.agents) {
      if (a.dead || a.isPlayer || a.deck !== this.deck) continue;
      if (a.faction === 6 || a.downed || a.hp <= 0) continue; // the dead don't block
      const [wx, wz] = this.world.simToWorld(a.x, a.y, a.deck);
      const dx = this.x - wx, dz = this.z - wz;
      const need = (R[a.faction] ?? 0.4) + 0.32;
      const d2 = dx * dx + dz * dz;
      if (d2 >= need * need || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (need - d);
      const px = this.x + (dx / d) * push, pz = this.z + (dz / d) * push;
      // never get pushed through a wall — only accept the slide if walkable
      const [sx, sy] = this.world.worldToSim(px, pz, this.deck);
      if (this.world.isWalkable(this.deck, sx, sy)) { this.x = px; this.z = pz; }
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

  cameraPose() {
    const y = this.climb ? this.climb.worldY : elevOf(this.deck) + this.h;
    return { x: this.x, y: y + ODST.eyeHeight, z: this.z, yaw: this.yaw, pitch: this.pitch };
  }
}
