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

// Boot a WebGPU renderer (automatic WebGL2 fallback; `forceWebGL` pins the
// fallback for A/B testing). MSAA off by design: FTL's post chain (see
// engine/post.js) does FXAA in the final grade, so canvas MSAA is pure
// waste against a 5-pass HDR pipeline. Tone mapping is OFF at the renderer
// — the scene renders LINEAR into a half-float target and the grade pass
// applies ACES + exposure.
export async function createRenderer({ canvas, forceWebGL = false, pixelRatioCap = 1.25 }) {
  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: false, powerPreference: 'high-performance', forceWebGL,
  });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.info.autoReset = false; // hosts accumulate per-frame across post passes
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

// Either backend can lose its device mid-run — WebGPU by spec at any time,
// WebGL2 by context loss (which the node renderer routes here too). Rather
// than a frozen black canvas: a WebGPU loss reloads once onto the WebGL2
// fallback (`?gl=1`); a WebGL2 loss reloads in place, capped by a session
// counter so a hopeless driver doesn't reload-loop. `params` are written
// onto the reload URL so the host can reboot into the same state (seed).
export function installDeviceLostReload(renderer, { label = 'ftl', storageKey = 'ftl-gl-lost', params = {} } = {}) {
  let handled = false;
  renderer.onDeviceLost = (info) => {
    if (handled || info?.reason === 'destroyed') return;
    handled = true;
    console.error(`[${label}] render device lost:`, info?.message ?? info);
    const u = new URL(location.href);
    if (renderer.backend.isWebGPUBackend) {
      u.searchParams.set('gl', '1');
    } else {
      const n = +(sessionStorage.getItem(storageKey) ?? 0);
      if (n >= 2) return; // twice is a pattern — stop reloading into it
      sessionStorage.setItem(storageKey, String(n + 1));
    }
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

// FIXED-STEP TICK SCHEDULER — simulation steps run in a MessageChannel
// macrotask OUTSIDE the rAF callback: the browser executes them in the
// idle gap between vsyncs, so a heavy tick delays at most the next frame
// instead of stacking on top of every frame's render cost. At most
// `maxPerTask` steps per task — a tab-restore backlog drains over a few
// tasks instead of freezing one — and a backlog deeper than
// `dropBacklogSteps` is dropped rather than marathon-replayed.
export class TickScheduler {
  constructor({ stepSec, run, maxPerTask = 3, dropBacklogSteps = 40 }) {
    this.stepSec = stepSec;
    this.run = run;
    this.maxPerTask = maxPerTask;
    this.dropBacklogSteps = dropBacklogSteps;
    this.acc = 0;
    const ch = new MessageChannel();
    this._port = ch.port2;
    ch.port1.onmessage = () => this._drain();
  }

  _drain() {
    let ran = 0;
    while (this.acc >= this.stepSec && ran++ < this.maxPerTask) {
      this.run();
      this.acc -= this.stepSec;
    }
    if (this.acc > this.stepSec * this.dropBacklogSteps) this.acc = 0;
    else if (this.acc >= this.stepSec) this._port.postMessage(0);
  }

  // call from the frame loop with the real delta; due steps are scheduled,
  // never run inline
  add(dtSec) {
    this.acc += dtSec;
    if (this.acc >= this.stepSec) this._port.postMessage(0);
  }
}
