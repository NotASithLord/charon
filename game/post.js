// HDR post-processing pipeline (user: push the web to its limits). The scene
// renders in LINEAR HDR to a half-float target, then:
//   1. bright-pass extracts everything over the bloom threshold,
//   2. two mip levels of separable gaussian blur build a soft wide halo
//      (the UnrealBloomPass recipe from three's examples, compacted),
//   3. a final grade composites bloom and applies ACES filmic tone mapping,
//      exposure, vignette, animated film grain and a whisper of chromatic
//      aberration, then converts to sRGB.
// Fires, muzzle flashes, emergency lamps and tracers stack past 1.0 in HDR
// and BLOOM — the single biggest step toward engine-grade fidelity the web
// forward path offers. Hand-rolled (no examples/jsm imports) so the dwapp
// bundle stays one self-contained file.

import * as THREE from './vendor/three.module.js';

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform float uThreshold;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + 0.6, l);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uDir; // (1/w, 0) or (0, 1/h)
  void main() {
    vec3 acc = texture2D(tSrc, vUv).rgb * 0.227027;
    vec2 o1 = uDir * 1.3846153;
    vec2 o2 = uDir * 3.2307692;
    acc += (texture2D(tSrc, vUv + o1).rgb + texture2D(tSrc, vUv - o1).rgb) * 0.3162162;
    acc += (texture2D(tSrc, vUv + o2).rgb + texture2D(tSrc, vUv - o2).rgb) * 0.0702703;
    gl_FragColor = vec4(acc, 1.0);
  }
`;

const GRADE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloomA;
  uniform sampler2D tBloomB;
  uniform float uExposure;
  uniform float uTime;
  uniform float uGrain;
  // ACES filmic fit (Narkowicz)
  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 uv = vUv;
    vec2 cc = uv - 0.5;
    float r2 = dot(cc, cc);
    // chromatic aberration: a whisper, growing toward the edges
    vec2 ca = cc * r2 * 0.022;
    vec3 hdr;
    hdr.r = texture2D(tScene, uv - ca).r;
    hdr.g = texture2D(tScene, uv).g;
    hdr.b = texture2D(tScene, uv + ca).b;
    hdr += texture2D(tBloomA, uv).rgb * 0.55 + texture2D(tBloomB, uv).rgb * 0.35;
    vec3 c = aces(hdr * uExposure);
    // vignette: the corners fall away like an unlit hull
    c *= 1.0 - smoothstep(0.32, 0.85, r2) * 0.34;
    // animated film grain — a whisper of sensor noise, mostly in midtones
    // (full-strength grain in the blacks read as static snow)
    float lum = clamp(dot(c, vec3(0.333)), 0.0, 1.0);
    float g = (hash(uv * 953.0 + fract(uTime) * 71.0) - 0.5) * uGrain;
    c += g * lum * (1.0 - lum) * 2.2;
    // linear -> sRGB
    c = pow(max(c, 0.0), vec3(1.0 / 2.2));
    gl_FragColor = vec4(c, 1.0);
  }
`;

const FXAA_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uInvRes;
  // compact FXAA (Lottes' recipe, console preset): edge-directed blur on the
  // graded LDR image — replaces the MSAA the post chain made useless
  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec3 rgbNW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uInvRes).rgb;
    vec3 rgbNE = texture2D(tSrc, vUv + vec2(1.0, -1.0) * uInvRes).rgb;
    vec3 rgbSW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uInvRes).rgb;
    vec3 rgbSE = texture2D(tSrc, vUv + vec2(1.0, 1.0) * uInvRes).rgb;
    vec3 rgbM = texture2D(tSrc, vUv).rgb;
    float lNW = lum(rgbNW), lNE = lum(rgbNE), lSW = lum(rgbSW), lSE = lum(rgbSE), lM = lum(rgbM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uInvRes;
    vec3 rgbA = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                     + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tSrc, vUv + dir * -0.5).rgb
                                   + texture2D(tSrc, vUv + dir * 0.5).rgb);
    float lB = lum(rgbB);
    gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
  }
`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.exposure = 1.35;      // main.js grades this (fog/dark stops)
    this.enabled = true;
    const mkRT = (w, h) => new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.rtScene = mkRT(2, 2);
    this.rtScene.depthBuffer = true; // the scene pass needs depth
    this.rtA = mkRT(2, 2); this.rtA2 = mkRT(2, 2);   // half-res blur ping-pong
    this.rtB = mkRT(2, 2); this.rtB2 = mkRT(2, 2);   // quarter-res blur ping-pong
    this.rtLDR = new THREE.WebGLRenderTarget(2, 2, {  // graded LDR, FXAA input
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });

    this._scene = new THREE.Scene();
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    this.matBright = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tScene: { value: null }, uThreshold: { value: 0.85 } },
    });
    this.matBlur = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
    });
    this.matGrade = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: GRADE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloomA: { value: null }, tBloomB: { value: null },
        uExposure: { value: this.exposure }, uTime: { value: 0 }, uGrain: { value: 0.045 },
      },
    });
    this.matFxaa = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: FXAA_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uInvRes: { value: new THREE.Vector2() } },
    });
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    const W = Math.floor(w * pr), H = Math.floor(h * pr);
    this.rtScene.setSize(W, H);
    this.rtA.setSize(W >> 1, H >> 1); this.rtA2.setSize(W >> 1, H >> 1);
    this.rtB.setSize(W >> 2, H >> 2); this.rtB2.setSize(W >> 2, H >> 2);
    this.rtLDR.setSize(W, H);
    this.matFxaa.uniforms.uInvRes.value.set(1 / W, 1 / H);
  }

  _pass(mat, target) {
    this._quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._scene, this._cam);
  }

  render(scene, camera, timeSec) {
    const r = this.renderer;
    if (!this.enabled) { r.setRenderTarget(null); r.render(scene, camera); return; }
    // 1. scene in linear HDR
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    // 2. bright pass into half-res
    this.matBright.uniforms.tScene.value = this.rtScene.texture;
    this._pass(this.matBright, this.rtA);
    // 3. blur half-res (H then V)
    const blur = (src, dst, w, h) => {
      this.matBlur.uniforms.tSrc.value = src.texture;
      this.matBlur.uniforms.uDir.value.set(1 / w, 0);
      this._pass(this.matBlur, dst);
      this.matBlur.uniforms.tSrc.value = dst.texture;
      this.matBlur.uniforms.uDir.value.set(0, 1 / h);
      this._pass(this.matBlur, src);
    };
    blur(this.rtA, this.rtA2, this.rtA.width, this.rtA.height);
    // 4. downsample to quarter and blur wider
    this.matBlur.uniforms.tSrc.value = this.rtA.texture;
    this.matBlur.uniforms.uDir.value.set(1 / this.rtB.width, 0);
    this._pass(this.matBlur, this.rtB);
    this.matBlur.uniforms.tSrc.value = this.rtB.texture;
    this.matBlur.uniforms.uDir.value.set(0, 1 / this.rtB.height);
    this._pass(this.matBlur, this.rtB2);
    // 5. grade into LDR
    const g = this.matGrade.uniforms;
    g.tScene.value = this.rtScene.texture;
    g.tBloomA.value = this.rtA.texture;
    g.tBloomB.value = this.rtB2.texture;
    g.uExposure.value = this.exposure;
    g.uTime.value = timeSec % 100;
    this._pass(this.matGrade, this.rtLDR);
    // 6. FXAA to screen (MSAA is off — this is the edge treatment)
    this.matFxaa.uniforms.tSrc.value = this.rtLDR.texture;
    this._quad.material = this.matFxaa;
    r.setRenderTarget(null);
    r.render(this._scene, this._cam);
  }
}
