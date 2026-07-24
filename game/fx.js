// Fire effects — REWORKED (user: flames were basic and low-res). Each site
// is now a real shader flame: two crossed billboarded quads running an fbm
// noise flame shader (scrolling turbulence shaped into tongues, black-body
// color ramp), an ember fountain, a scorch decal burned into the deck, and
// a guttering warm light. Sites come from the sim (breach blaze, burning
// doors, flamethrower burns) plus seeded small damage smolders. Render-only;
// the sim never sees any of it.

import * as THREE from './vendor/three.module.js';

const FLAME_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FLAME_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uT;
  uniform float uSeed;
  uniform float uIntensity;
  // cheap value-noise fbm — plenty at flame scale
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int k = 0; k < 4; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 uv = vUv;
    // turbulence rises: sample noise scrolling DOWN so features rise
    float n = fbm(vec2(uv.x * 3.0 + uSeed * 17.0, uv.y * 4.0 - uT * 2.6));
    float n2 = fbm(vec2(uv.x * 7.0 - uSeed * 9.0, uv.y * 9.0 - uT * 4.1));
    // flame envelope: wide at the base, licking to a point, side falloff
    float cx = uv.x - 0.5 + (n - 0.5) * 0.35 * uv.y;
    float body = 1.0 - smoothstep(0.0, 0.42 * (1.0 - uv.y * 0.75), abs(cx));
    float tongue = 1.0 - smoothstep(0.55, 1.0, uv.y + (n2 - 0.5) * 0.55);
    float f = body * tongue * (0.65 + 0.55 * n2);
    f = clamp(f * uIntensity, 0.0, 1.0);
    if (f < 0.03) discard;
    // black-body ramp: deep red -> orange -> yellow-white core
    vec3 col = mix(vec3(0.55, 0.08, 0.0), vec3(1.0, 0.45, 0.05), smoothstep(0.1, 0.55, f));
    col = mix(col, vec3(1.0, 0.92, 0.6), smoothstep(0.65, 1.0, f));
    gl_FragColor = vec4(col * (0.8 + 0.5 * n2), f * 0.92);
  }
`;

export class FireFX {
  constructor(scene) {
    this.scene = scene;
    this.fires = new Map();
    this._quadGeo = new THREE.PlaneGeometry(1, 1);
    this._quadGeo.translate(0, 0.5, 0); // pivot at the base of the flame
    this._scorchTex = FireFX._makeScorchTex();
    this._spotTex = FireFX._makeSpotTex();
  }

  static _makeSpotTex() {
    // soft round sprite for embers/sparks — points stop rendering as squares
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(16, 16, 1, 16, 16, 15);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  static _makeScorchTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 6, 64, 64, 62);
    g.addColorStop(0, 'rgba(4,3,2,0.9)');
    g.addColorStop(0.55, 'rgba(8,6,4,0.55)');
    g.addColorStop(1, 'rgba(10,8,6,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    // charred flecks
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 52;
      x.fillStyle = `rgba(2,2,2,${0.2 + Math.random() * 0.4})`;
      x.fillRect(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 2 + Math.random() * 3, 1 + Math.random() * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  add(key, x, z, elev, scale = 1) {
    if (this.fires.has(key)) return;
    const group = new THREE.Group();
    // two crossed flame cards, billboarded toward the player per-frame (Y-only)
    const cards = [];
    for (let k = 0; k < 2; k++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
        uniforms: {
          uT: { value: 0 },
          uSeed: { value: (x * 7.3 + z * 3.1 + k * 13.7) % 10 },
          uIntensity: { value: 1.35 },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const card = new THREE.Mesh(this._quadGeo, mat);
      card.scale.set(1.15 * scale, 1.7 * scale, 1);
      card.position.set(x, elev + 0.02, z);
      card.rotation.y = k * Math.PI / 2;
      card.renderOrder = 4;
      group.add(card);
      cards.push(card);
    }
    // embers: a sparse fountain of hot points
    const N = 26;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      seeds[i] = (i * 0.61803398) % 1;
      pos[i * 3] = x; pos[i * 3 + 1] = elev; pos[i * 3 + 2] = z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const embers = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffb45c, size: 0.085 * scale, transparent: true, opacity: 0.9,
      map: this._spotTex, alphaMap: this._spotTex,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    embers.frustumCulled = false;
    group.add(embers);
    // scorch burned into the deck under the fire
    const scorch = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4 * scale, 2.4 * scale),
      new THREE.MeshBasicMaterial({ map: this._scorchTex, transparent: true, depthWrite: false }));
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(x, elev + 0.012, z);
    scorch.renderOrder = 1;
    group.add(scorch);
    // guttering warm light (the glow in the dark is the point — user note)
    const light = new THREE.PointLight(0xff7a28, 6 * scale, 10 + 6 * scale, 1.7);
    light.position.set(x, elev + 0.9, z);
    group.add(light);
    this.scene.add(group);
    this.fires.set(key, {
      group, cards, embers, light, x, z, elev, scale,
      t: (x * 7 + z * 3) % 10, seeds,
    });
  }

  remove(key) {
    const f = this.fires.get(key);
    if (!f) return;
    this.scene.remove(f.group);
    for (const c of f.cards) c.material.dispose();
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
      // gutter: incommensurate sines + a fast spit read as real fire-light
      f.light.intensity = Math.max(0.5,
        (5.2 + Math.sin(f.t * 11) * 1.7 + Math.sin(f.t * 23.7) * 1.2
          + Math.sin(f.t * 47.3) * 0.5) * f.scale);
      const dx = f.x - px, dz = f.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 55 * 55) continue; // far fires keep the light, skip the rest
      // advance the flame shader + billboard the cards toward the player
      const face = Math.atan2(px - f.x, pz - f.z);
      for (let k = 0; k < f.cards.length; k++) {
        const c = f.cards[k];
        c.material.uniforms.uT.value = f.t;
        c.rotation.y = face + (k === 0 ? 0 : Math.PI / 2);
      }
      // embers rise and die
      const pos = f.embers.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const s = f.seeds[i];
        const life = (f.t * (0.35 + s * 0.5) + s * 7) % 1;
        const ang = s * 6.283 + f.t * (s - 0.5) * 1.6;
        const r = 0.4 * f.scale * (0.3 + s * 0.7) * (0.5 + life * 0.8);
        pos.setXYZ(i,
          f.x + Math.cos(ang) * r,
          f.elev + 0.15 + life * (1.9 + s) * f.scale,
          f.z + Math.sin(ang) * r);
      }
      pos.needsUpdate = true;
    }
  }
}

// SPARKING PANELS (user: better damage effects through the ship): a damaged
// junction spits a burst of sparks at random intervals — a crackle of hot
// points and a hard blue-white stab of light, then dark again. Sites are
// seeded per run by the game. Render-only.
export class SparkFX {
  constructor(scene) {
    this.scene = scene;
    this.sites = [];
    const N = 18;
    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this._n = N;
    this._spotTex = FireFX._makeSpotTex();
  }

  add(x, y, z) {
    const geo = this._geo.clone();
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xcfe4ff, size: 0.06, transparent: true, opacity: 0,
      map: this._spotTex, alphaMap: this._spotTex,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    pts.frustumCulled = false;
    const light = new THREE.PointLight(0x9fc8ff, 0, 7, 2.0);
    light.position.set(x, y, z);
    this.scene.add(pts, light);
    this.sites.push({
      x, y, z, pts, light,
      next: 2 + ((x * 13.7 + z * 7.3) % 9),  // staggered first burst
      burst: -1, seeds: Array.from({ length: this._n }, (_, i) => (i * 0.754877) % 1),
    });
  }

  update(dt, t, px, pz) {
    for (const s of this.sites) {
      if (s.burst < 0) {
        s.next -= dt;
        if (s.next <= 0 && Math.hypot(s.x - px, s.z - pz) < 60) {
          s.burst = 0;
          s.next = 4 + Math.random() * 11; // interval to the NEXT burst
        }
        continue;
      }
      s.burst += dt;
      const p = s.burst / 0.45;
      if (p >= 1) { s.burst = -1; s.pts.material.opacity = 0; s.light.intensity = 0; continue; }
      // hard stab of light with a fast flicker, sparks arcing down under gravity
      s.light.intensity = (1 - p) * (7 + Math.sin(t * 90) * 4);
      s.pts.material.opacity = 1 - p;
      const pos = s.pts.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const sd = s.seeds[i];
        const ang = sd * 6.283, v = 1.4 + sd * 2.4;
        pos.setXYZ(i,
          s.x + Math.cos(ang) * v * p,
          s.y + (sd - 0.2) * 1.2 * p - 3.2 * p * p, // ballistic fall
          s.z + Math.sin(ang) * v * p * 0.6);
      }
      pos.needsUpdate = true;
    }
  }
}
