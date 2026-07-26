// The ODST — Charon's player on the FTL engine's FpsController (engine/
// fps-controller.js owns pointer-lock look, exponential-accel walking,
// the Rapier capsule sweep, ground/step-down/ceiling vertical, and render
// interpolation). This subclass adds everything that makes the player a
// LIVE SIM AGENT on this ship: the flood hunts them, grabs pin them,
// conversion takes them — plus ballistic armor over health, ladder/shaft
// climbing with the sim's one-body-per-ladder reservations, the grand
// stairwell's deck portals, and ammo scavenging.
//
// L (not W) climbs a ladder/stairwell you're standing at — walking past a
// ladder shouldn't yank you up it, and a shaft only ever has ONE other end
// from where you stand, so the direction is never a guess.

import { FpsController } from '../engine/fps-controller.js';
import { elevOf } from './world.js';
import { ODST } from './fps-data.js';

export class Player extends FpsController {
  constructor(canvas, world, sim, startNode, physics) {
    const n = sim.graph.node(startNode);
    const [wx, wz] = world.simToWorld(n.x, n.y, n.deck);
    super({
      canvas, tune: ODST, deck: n.deck, x: wx, z: wz,
      elevOf,
      groundHeightAt: (deck, x, z, feetY) => world.groundHeightAt(deck, x, z, feetY),
      ceilHeightAt: (deck, x, z) => world.ceilHeightAt(deck, x, z),
      physics: physics ?? null,
    });
    this.world = world;
    this.sim = sim;
    this.climbing = false;
    this.climb = null; // active climb transition, see _startClimb
    this.queuedTrunk = null; // waiting in line for a busy ladder
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
  }

  get dead() { return this.agent.dead || this.agent.hp <= 0; }
  get pinned() { return this.agent.held === this.sim.tickCount; }

  // feet world Y follows the climb transition when one is running
  poseY() { return this.climb ? this.climb.worldY : elevOf(this.deck) + this.h; }

  // ONE fixed-timestep step (dt === PHYS_DT), driven by main.js's accumulator.
  step(dt) {
    if (!this.physics) return; // physics not attached yet — hold still
    this._prev = this._cur;

    if (!this.dead) this.adoptCapsule();
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

    // --- walking (engine stepMove) or holding in place ---
    if (!this.climbing && this.locked && !this.pinned) {
      this.stepMove(dt);
    } else if (!this.climb) {
      this.holdStill();
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
      // BAILED OVER A RAILING (user fix): you're inside the stair room but
      // below the entry ring and NOT over the switchback — that's the
      // hangar's airspace. Hand the fall to the deck below so you land on
      // its floor, instead of being popped back up through the ring.
      if (this.deck === g.deck && worldY < g.hiElev - 0.6) {
        const inRoom = this.x >= g.cx - g.hx && this.x <= g.cx + g.hx
          && this.z >= g.cz - g.hz && this.z <= g.cz + g.hz;
        const inWell = this.x >= g.wellCx - g.wellHx && this.x <= g.wellCx + g.wellHx
          && this.z >= g.wellCz - g.wellHz && this.z <= g.wellCz + g.wellHz;
        if (inRoom && !inWell) {
          this.deck = hangarDeck;
          this.h = worldY - elevOf(hangarDeck);
          this.physics.teleportPlayer(this.x, worldY, this.z);
          continue;
        }
      }
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
}
