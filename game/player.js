// The ODST — first-person controller with the first-strike movement feel
// (exponential accel, gravity, jump), ballistic-armor-over-health, and REAL
// vertical traversal: ladder shafts are climbed (look up/down + move), open
// hatches can be fallen through, stairwell trunks switch decks at the
// landing. No teleport pads. The player is a live sim agent: the flood
// hunts them, grabs pin them, conversion takes them.

import { elevOf, CLEAR_H, DECK_H } from './world.js';
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
    this.yaw = -Math.PI / 2; this.pitch = 0;
    this.keys = new Set();
    this.locked = false;
    this.armed = true; // ODST loadout: you board with the MA5
    this._eLatch = false;
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

    const trunk = this.world.trunkAt(this.deck, this.x, this.z);
    const wantFwd = this.keys.has('KeyW') ? 1 : 0;
    const wantBack = this.keys.has('KeyS') ? 1 : 0;

    // --- climbing (real shafts, user rule: no portals) ---
    this.climbing = false;
    if (trunk && this.locked && !this.pinned) {
      const steep = Math.abs(this.pitch) > 0.35;
      const dir = this.pitch > 0 ? 1 : -1; // looking up climbs up
      if (steep && (wantFwd || wantBack)) {
        this.climbing = true;
        this.vy = ODST.climbSpeed * dir * (wantFwd ? 1 : -1);
        this.vx = 0; this.vz = 0;
        // hold the column while on the ladder
        const cx = trunk.vertical ? trunk.x : (this.deck === trunk.lowerDeck ? trunk.low.x : trunk.high.x);
        const cz = trunk.vertical ? trunk.z : (this.deck === trunk.lowerDeck ? trunk.low.z : trunk.high.z);
        this.x += (cx - this.x) * Math.min(1, dt * 6);
        this.z += (cz - this.z) * Math.min(1, dt * 6);
      }
    }

    // --- walking (first-strike accel model) ---
    if (!this.climbing && this.locked && !this.pinned) {
      let fx = 0, fz = 0;
      if (wantFwd) fz += 1;
      if (wantBack) fz -= 1;
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
    } else if (!this.climbing) {
      this.vx = 0; this.vz = 0;
      this.vy -= ODST.gravity * dt;
    }

    // --- integrate horizontal with wall slide ---
    this._move(this.vx * dt, this.vz * dt);

    // --- integrate vertical: floors, hatches, deck transitions ---
    let footY = elevOf(this.deck) + this.h + this.vy * dt;
    const overHole = trunk && trunk.vertical
      && Math.abs(this.x - trunk.x) < 0.9 && Math.abs(this.z - trunk.z) < 0.9;
    // arriving on the deck above
    if (trunk && this.deck === trunk.lowerDeck && footY >= trunk.highElev - 0.02) {
      if (trunk.vertical) {
        this.deck = trunk.upperDeck;
      } else {
        this.deck = trunk.upperDeck;
        this.x = trunk.high.x; this.z = trunk.high.z; // the switchback landing
        footY = elevOf(this.deck);
        this.vy = 0;
      }
    }
    // dropping/climbing to the deck below
    if (trunk && this.deck === trunk.upperDeck && footY < elevOf(this.deck) - 0.05) {
      if (trunk.vertical && overHole) {
        this.deck = trunk.lowerDeck;
      } else if (!trunk.vertical && this.climbing) {
        this.deck = trunk.lowerDeck;
        this.x = trunk.low.x; this.z = trunk.low.z;
        footY = elevOf(this.deck);
        this.vy = 0;
      }
    }
    this.h = footY - elevOf(this.deck);
    // floor: solid unless standing over an open hatch
    const floorOpen = overHole && trunk && this.deck === trunk.upperDeck;
    if (this.h <= 0 && !floorOpen && !(this.climbing && this.vy < 0)) {
      this.h = 0; this.vy = 0; this.onGround = true;
    } else if (this.h <= 0 && this.climbing) {
      this.h = 0; this.vy = 0; this.onGround = true;
    } else {
      this.onGround = false;
    }
    // ceiling: open above only while the shaft continues upward
    const ceil = trunk && this.deck !== trunk.upperDeck ? DECK_H + CLEAR_H : CLEAR_H;
    if (this.h > ceil - 1.85) { this.h = ceil - 1.85; this.vy = Math.min(0, this.vy); }

    this._syncAgent();
  }

  _move(mx, mz) {
    const w = this.world;
    const [, sy0] = w.worldToSim(this.x, this.z, this.deck);
    const [sx1, sy1] = w.worldToSim(this.x + mx, this.z + mz, this.deck);
    let nx = this.x, nz = this.z;
    if (w.isWalkable(this.deck, sx1, sy0)) nx = this.x + mx;
    if (w.isWalkable(this.deck, nx, sy1)) nz = this.z + mz;
    this.x = nx; this.z = nz;
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
    return {
      x: this.x, y: elevOf(this.deck) + this.h + ODST.eyeHeight, z: this.z,
      yaw: this.yaw, pitch: this.pitch,
    };
  }
}
