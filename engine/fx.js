// Fire effects — REWORKED (user: flames were basic and low-res). Each site
// is now a real shader flame: two crossed billboarded quads running an fbm
// noise flame shader (scrolling turbulence shaped into tongues, black-body
// color ramp), an ember fountain, a scorch decal burned into the deck, and
// a guttering warm light. Sites come from the sim (breach blaze, burning
// doors, flamethrower burns) plus seeded small damage smolders. Render-only;
// the sim never sees any of it.

import * as THREE from './vendor/three.webgpu.module.js';
import {
  Fn, uv, float, vec2, vec3, vec4,
  fract, sin, dot, floor, mix, smoothstep, abs, clamp, Loop, userData,
} from './vendor/three.tsl.module.js';

// TSL flame — the same fbm value-noise tongue shader as the old GLSL, term
// for term, but built as a node graph so it compiles to WGSL on WebGPU and
// GLSL on the WebGL2 fallback from one source.
const hash2 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise2 = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  return mix(
    mix(hash2(i), hash2(i.add(vec2(1, 0))), u.x),
    mix(hash2(i.add(vec2(0, 1))), hash2(i.add(vec2(1, 1))), u.x), u.y);
});
const fbm2 = Fn(([pIn]) => {
  const p = pIn.toVar();
  const v = float(0).toVar();
  const a = float(0.5).toVar();
  Loop(4, () => {
    v.addAssign(a.mul(noise2(p)));
    p.mulAssign(2.03);
    a.mulAssign(0.5);
  });
  return v;
});

// ONE material serves every flame card in the game (review swarm: a fresh
// Fn() graph per material misses the node-builder cache by design — its key
// is the node instance id — so each ignition paid two full TSL builds
// mid-frame). Per-card time/seed ride on the MESH's userData via userData()
// nodes, which the node system uploads per rendered object.
let _flameMat = null;
function flameMaterial() {
  if (_flameMat) return _flameMat;
  const uT = userData('fireT', 'float');
  const uSeed = userData('fireSeed', 'float');
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
  });
  mat.colorNode = Fn(() => {
    const uvN = uv();
    // turbulence rises: sample noise scrolling DOWN so features rise
    const n = fbm2(vec2(uvN.x.mul(3.0).add(uSeed.mul(17.0)), uvN.y.mul(4.0).sub(uT.mul(2.6))));
    const n2 = fbm2(vec2(uvN.x.mul(7.0).sub(uSeed.mul(9.0)), uvN.y.mul(9.0).sub(uT.mul(4.1))));
    // flame envelope: wide at the base, licking to a point, side falloff
    const cx = uvN.x.sub(0.5).add(n.sub(0.5).mul(0.35).mul(uvN.y));
    const body = smoothstep(0.0, uvN.y.mul(0.75).oneMinus().mul(0.42), abs(cx)).oneMinus();
    const tongue = smoothstep(0.55, 1.0, uvN.y.add(n2.sub(0.5).mul(0.55))).oneMinus();
    const f = clamp(body.mul(tongue).mul(n2.mul(0.55).add(0.65)).mul(1.35), 0.0, 1.0);
    // black-body ramp: deep red -> orange -> yellow-white core
    const col = mix(
      mix(vec3(0.55, 0.08, 0.0), vec3(1.0, 0.45, 0.05), smoothstep(0.1, 0.55, f)),
      vec3(1.0, 0.92, 0.6), smoothstep(0.65, 1.0, f));
    // additive blending: alpha scales the contribution, near-zero adds nothing
    // (the old shader's discard was only a blending shortcut)
    return vec4(col.mul(n2.mul(0.5).add(0.8)), f.mul(0.92));
  })();
  _flameMat = mat;
  return mat;
}

// billboard-quad scratch (embers/sparks are instanced quads now — the node
// renderer draws point primitives at a fixed 1px, so THREE.Points sprites
// silently vanished on both backends)
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _IDENT_Q = new THREE.Quaternion();

export class FireFX {
  constructor(scene, lightPool = null) {
    this.scene = scene;
    this.pool = lightPool; // fire light goes through the global pool (perf)
    this.camera = null;    // main.js sets this; embers billboard to its quaternion
    this.fires = new Map();
    this._quadGeo = new THREE.PlaneGeometry(1, 1);
    this._quadGeo.translate(0, 0.5, 0); // pivot at the base of the flame
    this._scorchTex = FireFX._makeScorchTex();
    this._spotTex = FireFX._makeSpotTex();
    // shared across fires: ember quad + material, scorch geometry + material
    this._emberGeo = new THREE.PlaneGeometry(1, 1);
    this._emberMat = new THREE.MeshBasicMaterial({
      color: 0xffb45c, map: this._spotTex, alphaMap: this._spotTex,
      transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    });
    this._scorchGeo = new THREE.PlaneGeometry(1, 1);
    this._scorchMat = new THREE.MeshBasicMaterial({
      map: this._scorchTex, transparent: true, depthWrite: false,
    });
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
      const card = new THREE.Mesh(this._quadGeo, flameMaterial());
      card.userData.fireT = 0;
      card.userData.fireSeed = (x * 7.3 + z * 3.1 + k * 13.7) % 10;
      card.scale.set(1.15 * scale, 1.7 * scale, 1);
      card.position.set(x, elev + 0.02, z);
      card.rotation.y = k * Math.PI / 2;
      card.renderOrder = 4;
      group.add(card);
      cards.push(card);
    }
    // embers: a sparse fountain of hot instanced billboard quads
    const N = 26;
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) seeds[i] = (i * 0.61803398) % 1;
    const embers = new THREE.InstancedMesh(this._emberGeo, this._emberMat, N);
    _scl.setScalar(0.085 * scale);
    for (let i = 0; i < N; i++) {
      _m4.compose(_pos.set(x, elev, z), _IDENT_Q, _scl);
      embers.setMatrixAt(i, _m4);
    }
    embers.renderOrder = 4;
    embers.frustumCulled = false;
    group.add(embers);
    // scorch burned into the deck under the fire (shared geo/mat, scaled)
    const scorch = new THREE.Mesh(this._scorchGeo, this._scorchMat);
    scorch.scale.setScalar(2.4 * scale);
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(x, elev + 0.012, z);
    scorch.renderOrder = 1;
    group.add(scorch);
    this.scene.add(group);
    this.fires.set(key, {
      group, cards, embers, x, z, elev, scale,
      t: (x * 7 + z * 3) % 10, seeds, lum: 5 * scale, // pooled guttering light
    });
  }

  remove(key) {
    const f = this.fires.get(key);
    if (!f) return;
    this.scene.remove(f.group);
    // cards/scorch use shared material+geometry (never disposed); the only
    // per-fire GPU resource is the ember instance buffer (review swarm: the
    // old remove() leaked ember/scorch geometry and materials)
    f.embers.dispose();
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
      // gutter: incommensurate sines + a fast spit read as real fire-light —
      // declared to the pool; only the fires near you burn real light slots
      f.lum = Math.max(0.5,
        (5.2 + Math.sin(f.t * 11) * 1.7 + Math.sin(f.t * 23.7) * 1.2
          + Math.sin(f.t * 47.3) * 0.5) * f.scale);
      this.pool?.add(f.x, f.elev + 0.9, f.z, 0xff7a28, f.lum, 10 + 6 * f.scale, 1.7);
      const dx = f.x - px, dz = f.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 55 * 55) continue; // far fires: light declared, skip the rest
      // advance the flame shader + billboard the cards toward the player
      const face = Math.atan2(px - f.x, pz - f.z);
      for (let k = 0; k < f.cards.length; k++) {
        const c = f.cards[k];
        c.userData.fireT = f.t;
        c.rotation.y = face + (k === 0 ? 0 : Math.PI / 2);
      }
      // embers rise and die — instanced quads billboarded to the camera
      const q = this.camera?.quaternion ?? _IDENT_Q;
      _scl.setScalar(0.085 * f.scale);
      for (let i = 0; i < f.embers.count; i++) {
        const s = f.seeds[i];
        const life = (f.t * (0.35 + s * 0.5) + s * 7) % 1;
        const ang = s * 6.283 + f.t * (s - 0.5) * 1.6;
        const r = 0.4 * f.scale * (0.3 + s * 0.7) * (0.5 + life * 0.8);
        _m4.compose(_pos.set(
          f.x + Math.cos(ang) * r,
          f.elev + 0.15 + life * (1.9 + s) * f.scale,
          f.z + Math.sin(ang) * r), q, _scl);
        f.embers.setMatrixAt(i, _m4);
      }
      f.embers.instanceMatrix.needsUpdate = true;
    }
  }
}

// BLOOD MARKS (user: rooms should tell their own story): a dark pool with
// drag streaks stamped onto the deck where someone was taken or fell.
// Render-only, ring-buffered so a long run can't accumulate unbounded
// decals — old marks fade under new ones. One shared texture + material.
export class BloodFX {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.idx = 0;
    this.max = 44;
    this._geo = new THREE.PlaneGeometry(1, 1);
    // Several baked VARIANTS, picked per mark: one shared texture made every
    // pool in the ship a rotated copy of the same perfect circle, which read
    // as a decal sticker rather than something that bled out of a body.
    this._mats = [0, 1, 2, 3].map((v) => {
      const tex = new THREE.CanvasTexture(BloodFX._bake(v));
      tex.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    });
  }

  // One pool: overlapping off-centre blobs for a lumpy silhouette, a dark
  // settled centre, drag smears, and a scatter of satellite droplets. The
  // PRNG is seeded per variant, so the bake is byte-identical every boot.
  static _bake(variant) {
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    let s = (0x9e3779b9 ^ Math.imul(variant + 1, 0x85ebca6b)) >>> 0;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const cx = S / 2, cy = S / 2;
    // An organic outline, not a circle: a base radius modulated by a few
    // harmonics with per-variant phase. Stacked radial gradients (the first
    // attempt) read as fuzzy overlapping clouds — liquid needs a DEFINED
    // edge with the soft stain outside it.
    const ph = [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283];
    const lobe = (a, R) => R * (1 + 0.17 * Math.sin(a * 2 + ph[0])
      + 0.11 * Math.sin(a * 3 + ph[1]) + 0.07 * Math.sin(a * 5 + ph[2]));
    const outline = (R, ox = 0, oy = 0) => {
      x.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2, r = lobe(a, R);
        const px = cx + ox + Math.cos(a) * r, py = cy + oy + Math.sin(a) * r;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
      x.closePath();
    };
    const R = 0.30 * S;

    // STAIN — soaked-in halo around the pool, well outside its edge
    const halo = x.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.6);
    halo.addColorStop(0, 'rgba(36,5,7,0.42)');
    halo.addColorStop(1, 'rgba(30,4,6,0)');
    x.fillStyle = halo;
    x.fillRect(0, 0, S, S);

    // POOL — hard-edged liquid body, plus a couple of lobes spilling off it
    // (drawn in the same pass so they UNION instead of ringing each other)
    x.fillStyle = 'rgb(44,5,8)';
    outline(R); x.fill();
    const spills = 2 + ((variant + 1) % 2);
    for (let i = 0; i < spills; i++) {
      const a = rnd() * Math.PI * 2, d = (0.18 + rnd() * 0.14) * S;
      outline((0.10 + rnd() * 0.07) * S, Math.cos(a) * d, Math.sin(a) * d);
      x.fill();
    }

    // DEPTH — darkest where it pooled deepest, clipped to the liquid so the
    // gradient can never bleed past the edge
    x.save();
    outline(R); x.clip();
    const dg = x.createRadialGradient(cx - R * 0.15, cy - R * 0.1, 0, cx, cy, R * 1.05);
    dg.addColorStop(0, 'rgba(18,2,3,0.85)');
    dg.addColorStop(0.55, 'rgba(30,3,5,0.35)');
    dg.addColorStop(1, 'rgba(62,8,11,0)');
    x.fillStyle = dg;
    x.fillRect(0, 0, S, S);
    x.restore();

    // SMEARS — tapered drags pulled out of the rim (a body was moved here)
    const smears = 5 + ((variant * 3) % 4);
    for (let i = 0; i < smears; i++) {
      const a = rnd() * Math.PI * 2;
      // start AT the rim, not inside it — a smear that begins at the centre
      // draws as a needle laid across the pool instead of a drag out of it
      const r0 = lobe(a, R) * 0.94, r1 = r0 + R * (0.25 + rnd() * 0.75);
      const bend = (rnd() - 0.5) * 0.5;   // smears curve; they aren't rays
      const steps = 8;
      const at = (t) => {
        const rr = r0 + (r1 - r0) * t, aa = a + bend * t * t;
        return [cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr];
      };
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        x.strokeStyle = `rgba(40,4,7,${(0.55 * (1 - t0) ** 1.5).toFixed(3)})`;
        x.lineWidth = (1 - t0) * (2.4 + rnd() * 2.2) + 0.35;
        x.lineCap = 'round';
        x.beginPath();
        x.moveTo(...at(t0));
        x.lineTo(...at(t1));
        x.stroke();
      }
    }

    // SPATTER — thrown droplets, crisp (surface tension) and smaller further out
    const drops = 18 + ((variant * 5) % 12);
    for (let i = 0; i < drops; i++) {
      const a = rnd() * Math.PI * 2;
      const t = rnd();
      const d = R * (1.05 + t * 0.55);
      const rr = (1 - t) * 2.2 + 0.55;
      const dx = cx + Math.cos(a) * d, dy = cy + Math.sin(a) * d;
      x.fillStyle = `rgba(40,4,7,${(0.9 - t * 0.35).toFixed(3)})`;
      x.beginPath();
      x.ellipse(dx, dy, rr, rr * (0.6 + rnd() * 0.5), a, 0, Math.PI * 2); // elongated along the throw
      x.fill();
    }
    return c;
  }

  // `sizeMul` lets the caller mark a heavier event (a body dragging itself
  // back up leaves more than a clean fall).
  add(wx, wz, elev, seed = 0, sizeMul = 1) {
    let m = this.pool[this.idx];
    if (!m) {
      m = new THREE.Mesh(this._geo, this._mats[0]);
      m.renderOrder = 1;
      this.scene.add(m);
      this.pool[this.idx] = m;
    }
    m.material = this._mats[(seed >>> 3) % this._mats.length];
    m.rotation.set(-Math.PI / 2, 0, (seed * 2.399) % (Math.PI * 2));
    m.scale.setScalar((1.1 + ((seed * 97) % 10) / 8) * sizeMul);
    m.position.set(
      // the jitter used to be ±0.42 m, which threw the mark clear of the body
      // it belonged to; now the sim hands us the exact spot, so this is only
      // enough wobble to keep repeat marks from stacking perfectly
      wx + (((seed * 31) % 7) - 3) * 0.05,
      elev + 0.014 + (this.idx % 7) * 0.0005, // tiny y-stagger kills z-fighting between marks
      wz + (((seed * 17) % 7) - 3) * 0.05);
    this.idx = (this.idx + 1) % this.max;
  }
}

// SPARKING PANELS (user: better damage effects through the ship): a damaged
// junction spits a burst of sparks at random intervals — a crackle of hot
// points and a hard blue-white stab of light, then dark again. Sites are
// seeded per run by the game. Render-only.
export class SparkFX {
  constructor(scene, lightPool = null) {
    this.scene = scene;
    this.pool = lightPool;
    this.camera = null; // main.js sets this; sparks billboard to its quaternion
    this.sites = [];
    this._n = 18;
    this._spotTex = FireFX._makeSpotTex();
    this._quadGeo = new THREE.PlaneGeometry(1, 1);
  }

  add(x, y, z) {
    // instanced billboard quads (Points render 1px under the node renderer);
    // material cloned per site because opacity animates per burst — standard
    // materials share their compiled program regardless
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcfe4ff, transparent: true, opacity: 0,
      map: this._spotTex, alphaMap: this._spotTex,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const pts = new THREE.InstancedMesh(this._quadGeo, mat, this._n);
    _scl.setScalar(0.06);
    for (let i = 0; i < this._n; i++) {
      _m4.compose(_pos.set(x, y, z), _IDENT_Q, _scl);
      pts.setMatrixAt(i, _m4);
    }
    pts.renderOrder = 4;
    pts.frustumCulled = false;
    pts.visible = false;
    this.scene.add(pts);
    this.sites.push({
      x, y, z, pts,
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
          s.pts.visible = true;
          s.next = 4 + Math.random() * 11; // interval to the NEXT burst
        }
        continue;
      }
      s.burst += dt;
      const p = s.burst / 0.45;
      if (p >= 1) { s.burst = -1; s.pts.material.opacity = 0; s.pts.visible = false; continue; }
      // hard stab of light with a fast flicker, sparks arcing down under gravity
      this.pool?.add(s.x, s.y, s.z, 0x9fc8ff, (1 - p) * (7 + Math.sin(t * 90) * 4), 7, 2.0);
      s.pts.material.opacity = 1 - p;
      const q = this.camera?.quaternion ?? _IDENT_Q;
      _scl.setScalar(0.06);
      for (let i = 0; i < s.pts.count; i++) {
        const sd = s.seeds[i];
        const ang = sd * 6.283, v = 1.4 + sd * 2.4;
        _m4.compose(_pos.set(
          s.x + Math.cos(ang) * v * p,
          s.y + (sd - 0.2) * 1.2 * p - 3.2 * p * p, // ballistic fall
          s.z + Math.sin(ang) * v * p * 0.6), q, _scl);
        s.pts.setMatrixAt(i, _m4);
      }
      s.pts.instanceMatrix.needsUpdate = true;
    }
  }
}
