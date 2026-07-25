// HDR post-processing pipeline (user: push the web to its limits), now on
// three's node/TSL system so it runs on BOTH backends: WGSL under WebGPU and
// GLSL under the WebGL2 fallback, from the same graph. The scene renders in
// LINEAR HDR (PassNode is a half-float target), then:
//   1. BloomNode extracts everything over the threshold and builds the
//      soft wide halo (the UnrealBloomPass mip chain — the same recipe the
//      old hand-rolled two-mip blur compacted),
//   2. a grade node composites bloom and applies ACES filmic tone mapping
//      (Narkowicz fit, kept bit-identical to the old GLSL), exposure,
//      vignette, animated midtone film grain and a whisper of chromatic
//      aberration, then converts to sRGB manually,
//   3. FXAA runs on the graded LDR image (MSAA stays off — this is the
//      edge treatment).
// Fires, muzzle flashes, emergency lamps and tracers stack past 1.0 in HDR
// and BLOOM. The vendored Bloom/FXAA nodes keep the dwapp bundle
// self-contained.

import * as THREE from './vendor/three.webgpu.module.js';
import {
  pass, uniform, uv, Fn, float, vec2, vec3, vec4,
  fract, sin, dot, floor, mix, smoothstep, clamp, pow, max,
} from './vendor/three.tsl.module.js';
import { bloom } from './vendor/BloomNode.js';
import { fxaa } from './vendor/FXAANode.js';

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.enabled = true;

    this._uExposure = uniform(1.35);   // main.js grades this (fog/dark stops)
    this._uTime = uniform(0);
    this._uGrain = uniform(0.045);

    // 1. scene in linear HDR
    this.scenePass = pass(scene, camera);
    const scol = this.scenePass.getTextureNode();

    // 2. bloom mip chain (threshold matches the old bright pass; strength
    // tuned to the old 0.55/0.35 two-mip composite weights)
    this.bloomNode = bloom(scol, 0.75, 0.28, 0.85);

    // 3. grade: CA -> +bloom -> ACES -> vignette -> grain -> sRGB.
    // Same math as the old GLSL, term for term.
    const uE = this._uExposure, uT = this._uTime, uG = this._uGrain;
    const bloomTex = this.bloomNode;
    const grade = Fn(() => {
      const uvN = uv();
      const cc = uvN.sub(0.5);
      const r2 = dot(cc, cc);
      // chromatic aberration: a whisper, growing toward the edges
      const ca = cc.mul(r2).mul(0.022);
      const hdr = vec3(
        scol.sample(uvN.sub(ca)).r,
        scol.sample(uvN).g,
        scol.sample(uvN.add(ca)).b,
      ).add(bloomTex.rgb).toVar();
      // ACES filmic fit (Narkowicz)
      const x = hdr.mul(uE);
      const c = clamp(
        x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14)),
        0.0, 1.0).toVar();
      // vignette: the corners fall away like an unlit hull
      c.mulAssign(smoothstep(0.32, 0.85, r2).mul(0.34).oneMinus());
      // animated film grain — a whisper of sensor noise, mostly in midtones
      // (full-strength grain in the blacks read as static snow)
      const lum = clamp(dot(c, vec3(0.333)), 0.0, 1.0);
      const g = fract(sin(dot(uvN.mul(953.0).add(fract(uT).mul(71.0)),
        vec2(127.1, 311.7))).mul(43758.5453)).sub(0.5).mul(uG);
      c.addAssign(g.mul(lum).mul(lum.oneMinus()).mul(2.2));
      // linear -> sRGB (manual, matching the old pipeline exactly)
      return vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0);
    })();

    // 4. FXAA on the graded LDR image, straight to the canvas. The manual
    // sRGB above is the output transform — disable the built-in one.
    this.post = new THREE.RenderPipeline(renderer);
    this.post.outputColorTransform = false;
    this.post.outputNode = fxaa(grade);

    this._scene = scene;
    this._camera = camera;
  }

  // main.js grades exposure every frame — keep the old property surface
  get exposure() { return this._uExposure.value; }
  set exposure(v) { this._uExposure.value = v; }

  // low quality tier: the bloom chain runs at quarter instead of half input
  // resolution (the node's own mip ladder scales with it)
  set lite(v) { this.bloomNode.setResolutionScale(v ? 0.25 : 0.5); }

  // PassNode/BloomNode track renderer size + pixel ratio on their own
  setSize() {}

  render(scene, camera, timeSec) {
    if (!this.enabled) { this.renderer.render(scene, camera); return; }
    this._uTime.value = timeSec % 100;
    this.post.render();
  }
}
