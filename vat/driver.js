// Synthetic crowd driver for the VAT harness. Writes a real AgentBuffer —
// the same structure the sim produces (§2.2) — so the renderer is proven
// against the actual boundary format, at gameplay-like motion and clip mix.

import { AgentBuffer, FACTION, CLIP } from '../shared/agentBuffer.js';
import { RNG } from '../shared/rng.js';

const TINTS = {
  [FACTION.CIVILIAN]: [0.95, 0.95, 0.95],
  [FACTION.ARMED]: [0.91, 0.78, 0.25],
  [FACTION.MARINE]: [0.30, 0.56, 0.94],
  [FACTION.INFECTION]: [0.32, 1.0, 0.42],
  [FACTION.COMBAT]: [0.75, 0.23, 0.16],
  [FACTION.CARRIER]: [0.69, 0.37, 0.85],
  [FACTION.CORPSE]: [0.45, 0.45, 0.45],
};

const AREA = 46; // half-extent of the wander field

export class CrowdDriver {
  constructor(capacity = 512, seed = 'vat-crowd') {
    this.buffer = new AgentBuffer(capacity);
    this.rng = new RNG(seed);
    this.agents = [];
    this.setCount(150);
  }

  setCount(n) {
    const rng = this.rng;
    while (this.agents.length < n) {
      const roll = rng.next();
      const faction =
        roll < 0.45 ? FACTION.CIVILIAN :
        roll < 0.6 ? FACTION.MARINE :
        roll < 0.72 ? FACTION.ARMED :
        roll < 0.87 ? FACTION.INFECTION :
        roll < 0.95 ? FACTION.COMBAT :
        roll < 0.98 ? FACTION.CARRIER : FACTION.CORPSE;
      this.agents.push({
        id: this.agents.length + 1,
        faction,
        x: rng.range(-AREA, AREA), z: rng.range(-AREA, AREA),
        tx: rng.range(-AREA, AREA), tz: rng.range(-AREA, AREA),
        heading: rng.range(0, Math.PI * 2),
        speed: faction === FACTION.INFECTION ? 3.4 : faction === FACTION.CARRIER ? 0.8 : rng.range(1.1, 2.4),
        animTime: rng.range(0, 5),
        clip: faction === FACTION.CORPSE ? CLIP.DEATH : CLIP.IDLE,
        pauseUntil: 0,
        t: 0,
      });
    }
    this.agents.length = n;
  }

  tick(dt) {
    const b = this.buffer;
    b.beginTick();
    let i = 0;
    for (const a of this.agents) {
      a.t += dt;
      a.animTime += dt;
      if (a.faction === FACTION.CORPSE) {
        a.clip = CLIP.DEATH;
      } else if (a.t < a.pauseUntil) {
        a.clip = a.faction === FACTION.INFECTION ? CLIP.WRITHE
          : (a.pauseClip ?? CLIP.IDLE);
      } else {
        const dx = a.tx - a.x, dz = a.tz - a.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.5) {
          a.tx = this.rng.range(-AREA, AREA);
          a.tz = this.rng.range(-AREA, AREA);
          a.pauseUntil = a.t + this.rng.range(0.5, 3);
          // occasionally attack or die-and-rise on arrival
          const r = this.rng.next();
          a.pauseClip = r < 0.25 ? CLIP.ATTACK : r < 0.32 ? CLIP.DEATH : CLIP.IDLE;
          if (a.pauseClip === CLIP.DEATH || a.pauseClip === CLIP.ATTACK) a.animTime = 0;
        } else {
          const want = Math.atan2(dx, dz);
          let dh = want - a.heading;
          while (dh > Math.PI) dh -= 2 * Math.PI;
          while (dh < -Math.PI) dh += 2 * Math.PI;
          a.heading += Math.max(-2.5 * dt, Math.min(2.5 * dt, dh));
          a.x += Math.sin(a.heading) * a.speed * dt;
          a.z += Math.cos(a.heading) * a.speed * dt;
          a.clip = a.speed > 2.6 ? CLIP.RUN : CLIP.WALK;
        }
      }
      // write through the shared buffer format
      b.id[i] = a.id;
      b.faction[i] = a.faction;
      b.state[i] = 0;
      b.nodeId[i] = 0;
      b.posX[i] = a.x; b.posY[i] = 0; b.posZ[i] = a.z;
      b.headingR[i] = a.heading;
      b.animClip[i] = a.clip;
      b.animTime[i] = a.animTime;
      b.integrity[i] = 1; b.damage[i] = 0;
      const t = TINTS[a.faction];
      b.tint[i] = (Math.round(t[0] * 255) << 16) | (Math.round(t[1] * 255) << 8) | Math.round(t[2] * 255);
      b.flags[i] = 0;
      i++;
    }
    b.count = i;
    return b;
  }
}

// Convert an AgentBuffer into renderer instances. `mapPos` lets the fused
// page project sim schematic coords into world space.
export function bufferToInstances(b, mapPos = null) {
  const out = [];
  for (let i = 0; i < b.count; i++) {
    const tint = b.tint[i];
    let x = b.posX[i], y = 0, z = b.posZ[i];
    if (mapPos) [x, y, z] = mapPos(b.posX[i], b.posY[i], b.posZ[i]);
    const clip = b.animClip[i];
    const f = b.faction[i];
    out.push({
      x, y, z,
      heading: b.headingR[i],
      clip,
      animTime: b.animTime[i],
      scale: f === FACTION.INFECTION ? 0.45 : f === FACTION.CARRIER ? 1.25 : 1,
      dead: clip === 4 ? 1 : 0,
      r: ((tint >> 16) & 0xff) / 255,
      g: ((tint >> 8) & 0xff) / 255,
      b: (tint & 0xff) / 255,
    });
  }
  return out;
}
