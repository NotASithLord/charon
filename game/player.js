// First-person player: pointer-lock look, WASD + sprint, wall collision
// against the sim's walkability (rooms + unlocked doorways), lift/ladder
// pads for deck changes. The player IS a sim agent — their position feeds
// the sim every tick, so the flood hunts them like anyone else.

import { elevOf } from './world.js';

export class Player {
  constructor(canvas, world, sim, startNode) {
    this.world = world;
    this.sim = sim;
    this.canvas = canvas;
    const n = sim.graph.node(startNode);
    this.deck = n.deck;
    // world coords
    const [wx, wz] = world.simToWorld(n.x, n.y, n.deck);
    this.x = wx; this.z = wz;
    this.yaw = -Math.PI / 2; this.pitch = 0; // face aft, into the ship

    this.eye = 1.62;
    this.walkMps = 2.4;
    this.runMps = 4.4;
    this.keys = new Set();
    this.padCooldown = 0;
    this.locked = false;

    this.agent = sim.attachPlayer(startNode);
    this._syncAgent();

    canvas.addEventListener('click', () => { if (!this.locked) canvas.requestPointerLock(); });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0023;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * 0.0023));
    });
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  get dead() { return this.agent.dead || this.agent.hp <= 0; }
  get pinned() { return this.agent.held === this.sim.tickCount; }

  update(dt) {
    if (this.dead) return;
    this.padCooldown = Math.max(0, this.padCooldown - dt);

    if (this.locked && !this.pinned) {
      let fx = 0, fz = 0;
      if (this.keys.has('KeyW')) fz += 1;
      if (this.keys.has('KeyS')) fz -= 1;
      if (this.keys.has('KeyA')) fx -= 1;
      if (this.keys.has('KeyD')) fx += 1;
      if (fx || fz) {
        const sp = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? this.runMps : this.walkMps;
        const len = Math.hypot(fx, fz);
        // camera basis: forward = (-sin yaw, -cos yaw) in (x, z)
        const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
        const mx = (fwdX * fz + rightX * fx) / len * sp * dt;
        const mz = (fwdZ * fz + rightZ * fx) / len * sp * dt;
        this._move(mx, mz);
      }
    }

    // lift/ladder pads
    if (this.padCooldown === 0) {
      const pad = this.world.padNear(this.deck, this.x, this.z);
      if (pad) {
        this.deck = pad.toDeck;
        this.x = pad.tx; this.z = pad.tz;
        // step off the destination pad so we don't bounce straight back
        const n = this.sim.graph.node(pad.toNode);
        const [cx, cz] = this.world.simToWorld(n.x, n.y, n.deck);
        const dx = cx - this.x, dz = cz - this.z, dl = Math.hypot(dx, dz) || 1;
        this.x += dx / dl * 1.5; this.z += dz / dl * 1.5;
        this.padCooldown = 1.2;
      }
    }

    this._syncAgent();
  }

  // axis-separated slide against walkability (in sim coords)
  _move(mx, mz) {
    const w = this.world;
    const [sx0, sy0] = w.worldToSim(this.x, this.z, this.deck);
    const [sx1, sy1] = w.worldToSim(this.x + mx, this.z + mz, this.deck);
    let nx = this.x, nz = this.z;
    if (w.isWalkable(this.deck, sx1, sy0)) nx = this.x + mx;
    if (w.isWalkable(this.deck, w.worldToSim(nx, 0, this.deck)[0], sy1)) nz = this.z + mz;
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

  cameraPose() {
    return {
      x: this.x, y: elevOf(this.deck) + this.eye, z: this.z,
      yaw: this.yaw, pitch: this.pitch,
    };
  }
}
