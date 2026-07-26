// GLOBAL DYNAMIC LIGHT POOL (perf pass — user: frame rate unusable, cut
// nothing). three's forward renderer compiles EVERY light in the scene into
// EVERY material's shader and evaluates all of them per fragment — and it
// RECOMPILES every program whenever the light count changes. Before this,
// fires, spark sites, room fixtures, door spill and muzzle strobes each
// owned real PointLights: 30-40 lights, all paid for everywhere, with
// compile hitches every time a fire started or died.
//
// Now every dynamic source is VIRTUAL: systems declare {position, color,
// intensity, distance} each frame, and a fixed pool of N real lights is
// assigned to the highest-scoring sources near the player. Fragment cost is
// bounded and constant, the shader never recompiles, and since a light 40m
// away through three walls contributed nothing visible, the screen looks
// IDENTICAL — the far sources were pure waste.

import * as THREE from './vendor/three.webgpu.module.js';

export class LightPool {
  constructor(scene, n = 10) {
    this.scene = scene;
    this.lights = Array.from({ length: n }, () => {
      const L = new THREE.PointLight(0xffffff, 0, 10, 1.8);
      scene.add(L);
      return L;
    });
    this.active = n;
    this.virtual = [];
    this._pool = []; // recycled virtual-light records (perf: zero per-frame garbage)
    this._used = 0;
  }

  // shrink/grow the live pool (quality tiers). Removing a light from the
  // scene shrinks the light loop compiled into every shader — a real
  // per-fragment cut, not just dimming to zero. Costs one program rebuild
  // at the moment of the switch, then stays stable.
  setActive(n) {
    n = Math.max(1, Math.min(n, this.lights.length));
    if (n === this.active) return;
    this.active = n;
    this.lights.forEach((L, i) => {
      if (i < n) { if (!L.parent) this.scene.add(L); }
      else if (L.parent) { L.intensity = 0; this.scene.remove(L); }
    });
  }

  // start a frame: forget last frame's declarations
  frame() { this.virtual.length = 0; this._used = 0; }

  // declare a virtual light for this frame — records recycle across frames
  add(x, y, z, color, intensity, distance, decay = 1.8) {
    if (intensity <= 0.02) return;
    const v = this._pool[this._used] ?? (this._pool[this._used] = {
      x: 0, y: 0, z: 0, color: 0, intensity: 0, distance: 0, decay: 0, score: 0,
    });
    this._used++;
    v.x = x; v.y = y; v.z = z; v.color = color;
    v.intensity = intensity; v.distance = distance; v.decay = decay; v.score = 0;
    this.virtual.push(v);
  }

  // assign the pool: brightest-and-nearest win
  commit(px, pz) {
    for (const v of this.virtual) {
      const d = Math.hypot(v.x - px, v.z - pz);
      v.score = d > 55 ? 0 : v.intensity * v.distance / (1 + d * d * 0.015);
    }
    this.virtual.sort((a, b) => b.score - a.score);
    for (let i = 0; i < this.active; i++) {
      const L = this.lights[i];
      const v = this.virtual[i];
      if (!v || v.score <= 0) { L.intensity = 0; continue; }
      L.position.set(v.x, v.y, v.z);
      L.color.set(v.color);
      L.intensity = v.intensity;
      L.distance = v.distance;
      L.decay = v.decay;
    }
  }
}
