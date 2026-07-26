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
  fract, sin, dot, floor, mix, smoothstep, clamp, pow, max, min, abs,
  select, rtt, textureSize,
} from './vendor/three.tsl.module.js';
import { bloom } from './vendor/BloomNode.js';

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

    // 2. bloom — TWO mips (half + quarter input res), matching the old
    // hand-rolled chain's shape and cost, not the stock five-mip ladder
    // (review swarm: 5 mips = 12 passes and 3.3x the integrated energy).
    // Weights at radius 0.1 are [0.92, 0.76]; strength 0.54 puts the total
    // composite gain at ~0.9x of bright-pass energy — the old 0.55+0.35.
    this.bloomNode = bloom(scol, 0.54, 0.1, 0.85, 2);
    // the old bright pass had a 0.6-wide soft knee (smoothstep 0.85..1.45);
    // BloomNode defaults to a hard 0.01 knee — restore the ramp
    this.bloomNode.smoothWidth.value = 0.6;

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

    // 4. FXAA on the graded LDR image, straight to the canvas — the compact
    // Lottes console preset ported from the old GLSL, running on an 8-bit
    // RTT (the grade output is [0,1] sRGB; the default half-float target
    // would double the bandwidth of the most expensive link in the chain).
    const ldr = rtt(grade, null, null, { type: THREE.UnsignedByteType, depthBuffer: false });
    const lum = (c) => dot(c, vec3(0.299, 0.587, 0.114));
    const fxaaFn = Fn(() => {
      const invRes = vec2(1.0).div(vec2(textureSize(ldr))).toVar();
      const uvN = uv();
      const s = (dx, dy) => ldr.sample(uvN.add(vec2(dx, dy).mul(invRes))).rgb;
      const rgbNW = s(-1, -1).toVar(), rgbNE = s(1, -1).toVar();
      const rgbSW = s(-1, 1).toVar(), rgbSE = s(1, 1).toVar();
      const rgbM = ldr.sample(uvN).rgb.toVar();
      const lNW = lum(rgbNW).toVar(), lNE = lum(rgbNE).toVar();
      const lSW = lum(rgbSW).toVar(), lSE = lum(rgbSE).toVar(), lM = lum(rgbM).toVar();
      const lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      const lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      const dir = vec2(
        lNW.add(lNE).sub(lSW.add(lSE)).negate(),
        lNW.add(lSW).sub(lNE.add(lSE))).toVar();
      const dirReduce = max(lNW.add(lNE).add(lSW).add(lSE).mul(0.25 * 0.125), 1.0 / 128.0);
      const rcpDirMin = float(1.0).div(min(abs(dir.x), abs(dir.y)).add(dirReduce));
      dir.assign(clamp(dir.mul(rcpDirMin), -8.0, 8.0).mul(invRes));
      const rgbA = ldr.sample(uvN.add(dir.mul(1.0 / 3.0 - 0.5))).rgb
        .add(ldr.sample(uvN.add(dir.mul(2.0 / 3.0 - 0.5))).rgb).mul(0.5).toVar();
      const rgbB = rgbA.mul(0.5).add(
        ldr.sample(uvN.add(dir.mul(-0.5))).rgb
          .add(ldr.sample(uvN.add(dir.mul(0.5))).rgb).mul(0.25)).toVar();
      const lB = lum(rgbB);
      return vec4(select(lB.lessThan(lMin).or(lB.greaterThan(lMax)), rgbA, rgbB), 1.0);
    })();

    // manual sRGB in the grade is the output transform — disable the built-in one
    this.post = new THREE.RenderPipeline(renderer);
    this.post.outputColorTransform = false;
    this.post.outputNode = fxaaFn;

    this._scene = scene;
    this._camera = camera;
  }

  // main.js grades exposure every frame — keep the old property surface
  get exposure() { return this._uExposure.value; }
  set exposure(v) { this._uExposure.value = v; }

  // quality ladder: the bloom chain's input resolution scale (0.5 full,
  // stepping down to 0.25 on the lowest rung)
  setBloomScale(s) { this.bloomNode.setResolutionScale(s); }

  // PassNode/BloomNode track renderer size + pixel ratio on their own
  setSize() {}

  render(scene, camera, timeSec) {
    if (!this.enabled) { this.renderer.render(scene, camera); return; }
    this._uTime.value = timeSec % 100;
    this.post.render();
  }
}
