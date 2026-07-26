// FTL ENGINE · runtime — the reusable FPS shell around a three.js
// WebGPURenderer: renderer boot with WebGL2 fallback, device-lost
// recovery, a rung-based quality governor with a whole-frame pixel
// budget, and a fixed-step tick scheduler that runs simulation work
// OUTSIDE the rAF task (in the idle gap between vsyncs).
//
// Nothing in this file knows about any particular game: the governor's
// per-rung effects, the reload URL params, and the tick body are all
// injected by the host. See engine/README.md for the module map.

import * as THREE from './vendor/three.webgpu.module.js';

// Boot a WebGPU renderer. WEBGPU IS REQUIRED for the product path (user
// call: support is universal in evergreen browsers now — no silent
// degraded WebGL2 experience). The WebGL2 backend survives ONLY as a
// dev/testing escape hatch behind `forceWebGL` (`?gl=1` in hosts): the
// TSL materials compile to GLSL for free, and headless CI containers
// cannot run WebGPU, so the entire screenshot/validation harness rides
// this flag. MSAA off by design: FTL's post chain (see engine/post.js)
// does FXAA in the final grade. Tone mapping is OFF at the renderer —
// the scene renders LINEAR into a half-float target and the grade pass
// applies ACES + exposure.
// Throws Error('webgpu-required') when WebGPU is unavailable and
// forceWebGL wasn't explicitly requested — hosts catch it and show their
// "needs WebGPU" screen.
export async function createRenderer({ canvas, forceWebGL = false, pixelRatioCap = 1.25 }) {
  if (!forceWebGL && !navigator.gpu) throw new Error('webgpu-required');
  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: false, powerPreference: 'high-performance', forceWebGL,
  });
  await renderer.init();
  if (!forceWebGL && !renderer.backend.isWebGPUBackend) throw new Error('webgpu-required');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.info.autoReset = false; // hosts accumulate per-frame across post passes
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

// The device can be lost mid-run — WebGPU by spec at any time, WebGL2 (dev
// flag) by context loss. Rather than a frozen black canvas: reload in
// place, capped by a session counter so a hopeless driver doesn't
// reload-loop. There is deliberately NO downgrade onto WebGL2 anymore
// (user call: WebGPU is the product path — a broken WebGPU stack should
// surface, not silently degrade). `params` are written onto the reload
// URL so the host can reboot into the same state (seed).
export function installDeviceLostReload(renderer, { label = 'ftl', storageKey = 'ftl-lost', params = {} } = {}) {
  let handled = false;
  renderer.onDeviceLost = (info) => {
    if (handled || info?.reason === 'destroyed') return;
    handled = true;
    console.error(`[${label}] render device lost:`, info?.message ?? info);
    const n = +(sessionStorage.getItem(storageKey) ?? 0);
    if (n >= 2) return; // twice is a pattern — stop reloading into it
    sessionStorage.setItem(storageKey, String(n + 1));
    const u = new URL(location.href);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    location.replace(u);
  };
}

// QUALITY GOVERNOR — a degradation LADDER: each rung sheds one cost,
// ordered cheapest-look-loss first, and the governor walks it per machine.
// Frame-time EMA drives resolution WITHIN the rung (re-evaluated every ~3s
// so RT reallocation never hitches play), then the rung itself: down when
// pinned at the resolution floor and still slow, back up after a long
// provably-stable stretch. A whole-frame PIXEL BUDGET caps resolution on
// huge windows (integrated GPUs can't buy retina supersampling).
//
//   rungs:  [{ res: [floor, cap], ...anything the host reads }]
//   apply:  (rungDef, index) => void   — host-side effects of the rung
//   onResize: (w, h) => void           — host resizes its post chain
export class QualityGovernor {
  constructor({ renderer, rungs, pixelBudget = 3.0e6, hd = false, pinned = false, apply, onResize, label = 'ftl' }) {
    this.renderer = renderer;
    this.rungs = rungs;
    this.pixelBudget = pixelBudget;
    this.hd = hd;
    this.pinned = pinned;
    this.apply = apply;
    this.onResize = onResize;
    this.label = label;
    this.rung = 0;
    this.prewarming = false;
    this._ema = 16;
    this._evalAt = 0;
    this._slow = 0;
    this._fast = 0;
    this._movedAt = 0;
  }

  applyRung(i) {
    this.rung = i;
    this.apply(this.rungs[i], i);
  }

  // Compile the recompile-heavy rung variants up front (behind a loading /
  // intro screen), so a mid-fight ladder step is a uniform change instead
  // of a shader storm. `forceWarm(scene)` may flip hidden/count-0 objects
  // visible so their pipelines compile too — it must return a restore
  // function, which ALWAYS runs (a failed compile that left warm state
  // applied once read as a fully-dark scene).
  async prewarm(scene, camera, { order, forceWarm } = {}) {
    if (this.pinned) return;
    this.prewarming = true;
    const start = this.rung;
    const seq = order ?? [2, 3, this.rungs.length - 1, start];
    try {
      const restore = forceWarm ? forceWarm(scene) : null;
      try {
        for (const i of seq) {
          this.applyRung(i);
          await this.renderer.compileAsync(scene, camera);
        }
      } finally {
        restore?.();
      }
    } catch {
      this.applyRung(start);
    }
    this.prewarming = false;
  }

  // Call once per frame with the real frame delta; walks resolution and
  // rungs on its internal 3s cadence.
  frame(now, dtRealSec, viewportW, viewportH) {
    this._ema = this._ema * 0.94 + Math.min(50, dtRealSec * 1000) * 0.06;
    if (now - this._evalAt <= 3000) return;
    this._evalAt = now;
    const R = this.rungs[this.rung];
    const cur = this.renderer.getPixelRatio();
    const floor = R.res[0];
    const budgetCap = this.hd ? 9 : Math.sqrt(this.pixelBudget / ((viewportW * viewportH) || 1));
    const cap = Math.max(floor, Math.min(window.devicePixelRatio || 1, this.hd ? 2 : R.res[1], budgetCap));
    let next = cur;
    if (this._ema > 20 && cur > floor) next = Math.max(floor, cur - 0.15);
    else if (this._ema < 13 && cur < cap) next = Math.min(cap, cur + 0.1);
    if (Math.abs(next - cur) > 0.01) {
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(viewportW, viewportH, false);
      this.onResize?.(viewportW, viewportH);
    }
    if (this.pinned || this.prewarming) return;
    // descend: pinned at the floor and still under ~42fps, twice running
    if (this._ema > 24 && cur <= floor + 0.01 && this.rung < this.rungs.length - 1) {
      if (++this._slow >= 2) {
        this.applyRung(this.rung + 1);
        this._slow = 0;
        this._movedAt = now;
        console.info(`[${this.label}] quality rung -> ${this.rung} (frame ${this._ema.toFixed(1)}ms)`);
      }
    } else this._slow = 0;
    // ascend: locked-vsync smooth at full rung resolution for a long
    // stretch, and no recent descent — climb one rung and let it prove itself
    if (this._ema < 17.0 && cur >= cap - 0.01 && this.rung > 0 && now - this._movedAt > 90000) {
      if (++this._fast >= 8) {
        this.applyRung(this.rung - 1);
        this._fast = 0;
        this._movedAt = now;
        console.info(`[${this.label}] quality rung -> ${this.rung} (headroom)`);
      }
    } else this._fast = 0;
  }
}

// TickScheduler lives in engine/tick.js (three-free — hosts with their own
// renderers can import it without pulling the vendored three build); re-
// exported here so existing runtime.js importers keep working.
export { TickScheduler } from './tick.js';
