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
import * as TSL from './vendor/three.tsl.module.js';

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
    // CANONICAL ORDER (perf pass 3): scene.add APPENDS, so growing the pool
    // after a shrink used to leave the re-added lights at the END of
    // scene.children — a light-order PERMUTATION that changes the LightsNode
    // cache key and recompiled every pipeline into variants prewarm never
    // saw. Removing everything and re-adding 0..n-1 in index order makes the
    // scene's light order a pure function of n, so every rung's cache key
    // matches what prewarm compiled.
    for (const L of this.lights) {
      if (L.parent) { L.intensity = 0; this.scene.remove(L); }
    }
    for (let i = 0; i < n; i++) this.scene.add(this.lights[i]);
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

// INSTANCED EMISSIVE FIXTURES (perf pass 5) — the reusable answer to "every
// room builds its own light-fixture mesh with its own material so the
// emissive can animate". That shape costs one draw call and one 55-property
// material refresh per fixture per frame, and it is why fixtures were half
// the visible static draw calls on this engine's first game. One of these
// per fixture KIND instead: a single InstancedMesh whose per-instance
// emissive level rides an instanced float attribute into `emissiveNode`
// (NOT `instanceColor` — that multiplies DIFFUSE, and a dead fixture's
// housing must stay its own colour rather than go black).
//
//   const strips = new InstancedEmissiveFixtures({
//     geometry, capacity, color: 0x8fa4c8, emissive: 0xbfd8ff, gain: 1.25,
//   });
//   const i = strips.place(x, y, z, { sx: 2.1 });  // world transform, baked once
//   strips.finalize(scene);                        // count = placed, add to scene
//   strips.setLevel(i, lvl);                       // 0..1, any frame
//   strips.commit();                               // once per frame IF changed
//
// TSL compiles the same graph to WGSL and GLSL, so this works on both
// backends. Normals: instance scale is axis-aligned on box fixtures, so
// transformNormal through the instance matrix is exact.
export class InstancedEmissiveFixtures {
  constructor({ geometry, capacity, color, emissive, gain = 1, roughness = 0.5, metalness = 0.3 }) {
    this._level = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this._level.setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
    mat.emissiveNode = TSL.color(emissive).mul(TSL.instancedDynamicBufferAttribute(this._level, 'float')).mul(gain);
    this.mesh = new THREE.InstancedMesh(geometry, mat, capacity);
    // fixtures span the whole hull — a per-instance-set bounding sphere would
    // always intersect the frustum anyway, so skip the test outright
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    // receiveShadow is left at the host's discretion: an opaque fixture that
    // ignored the scene's shadows would visibly float, and hosts commonly run
    // a shadow-plumbing traverse that sets it anyway
    this._placed = 0;
    this._m = new THREE.Matrix4();
    this._dirty = false;
  }

  place(x, y, z, { sx = 1, sy = 1, sz = 1, ry = 0, level = 1 } = {}) {
    const i = this._placed++;
    this._m.makeRotationY(ry);
    this._m.scale(new THREE.Vector3(sx, sy, sz));
    this._m.setPosition(x, y, z);
    this.mesh.setMatrixAt(i, this._m);
    this._level.array[i] = level;
    return i;
  }

  // seals the set: count = what was placed (capacity keys the shader's
  // instance-matrix storage, so it must be set at construction and the
  // surplus is simply never drawn)
  finalize(scene) {
    this.mesh.count = this._placed;
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  setLevel(i, v) {
    // quantize BEFORE comparing: the store is float32, and fround(0.04) !==
    // 0.04 — without this, exactly the steady dead/dark levels re-dirtied
    // the buffer on every write and it re-uploaded at 15 Hz forever
    v = Math.fround(v);
    if (this._level.array[i] === v) return;
    this._level.array[i] = v;
    this._dirty = true;
  }

  commit() {
    if (!this._dirty) return;
    this._dirty = false;
    this._level.needsUpdate = true;
  }
}
