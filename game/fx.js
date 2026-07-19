// Fire effects (user note): additive particle flames + a guttering orange
// light per site. Sites come from two places — seeded ambient fires rolled
// once per run (the crash site always burns, plus a few damaged spots that
// differ every seed), and the sim's own flamethrower burns (burningUntil),
// which appear and die out live. Render-only; the sim never sees any of it.

import * as THREE from './vendor/three.module.js';

export class FireFX {
  constructor(scene) {
    this.scene = scene;
    this.fires = new Map();
  }

  add(key, x, z, elev, scale = 1) {
    if (this.fires.has(key)) return;
    const N = 42;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      seeds[i] = (i * 0.61803398) % 1;
      pos[i * 3] = x; pos[i * 3 + 1] = elev; pos[i * 3 + 2] = z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const flames = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xff9a3c, size: 0.34 * scale, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    flames.frustumCulled = false;
    const core = new THREE.Points(geo.clone(), new THREE.PointsMaterial({
      color: 0xffe28c, size: 0.16 * scale, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    core.frustumCulled = false;
    const light = new THREE.PointLight(0xff8a30, 6 * scale, 9 + 5 * scale, 1.8);
    light.position.set(x, elev + 0.8, z);
    this.scene.add(flames, core, light);
    this.fires.set(key, { flames, core, light, x, z, elev, scale, t: (x * 7 + z * 3) % 10, seeds });
  }

  remove(key) {
    const f = this.fires.get(key);
    if (!f) return;
    this.scene.remove(f.flames, f.core, f.light);
    this.fires.delete(key);
  }

  // nearest burning site to a point (for the crackle audio)
  nearest(px, pz, deckElev) {
    let best = null, bestD = Infinity;
    for (const f of this.fires.values()) {
      if (Math.abs(f.elev - deckElev) > 1) continue;
      const d = Math.hypot(f.x - px, f.z - pz);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best ? { x: best.x, z: best.z, d: bestD } : null;
  }

  update(dt, px, pz) {
    for (const f of this.fires.values()) {
      f.t += dt;
      // gutter: two incommensurate sines read as real flame-light
      f.light.intensity = Math.max(0.5,
        (5.2 + Math.sin(f.t * 11) * 1.7 + Math.sin(f.t * 23.7) * 1.2) * f.scale);
      const d2 = (f.x - px) * (f.x - px) + (f.z - pz) * (f.z - pz);
      if (d2 > 55 * 55) continue; // far fires keep the light, skip particle work
      const pos = f.flames.geometry.attributes.position;
      const pos2 = f.core.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const s = f.seeds[i];
        const life = (f.t * (0.55 + s * 0.65) + s * 7) % 1;
        const ang = s * 6.283 + f.t * (s - 0.5) * 2.2;
        const r = 0.55 * f.scale * (1 - life * 0.72) * (0.4 + s * 0.6);
        const x = f.x + Math.cos(ang) * r;
        const y = f.elev + 0.05 + life * 1.5 * f.scale;
        const z = f.z + Math.sin(ang) * r;
        pos.setXYZ(i, x, y, z);
        pos2.setXYZ(i, x, y * 0.99 + f.elev * 0.01, z);
      }
      pos.needsUpdate = true;
      pos2.needsUpdate = true;
    }
  }
}
