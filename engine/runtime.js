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

// Boot a WebGPU renderer, FALLING BACK to the WebGL2 backend when WebGPU
// is missing or fails to initialise. WebGPU is the product path, but a
// hard requirement stranded real players (user report: a browser can
// EXPOSE navigator.gpu yet fail or limp on an OS too old for its WebGPU
// stack — Firefox on older macOS). The same TSL materials compile to
// GLSL for free, so the fallback is the full game, just on the older
// API. `forceWebGL` (`?gl=1` in hosts) still pins the WebGL2 backend
// outright — the headless screenshot/validation harness rides it.
// MSAA off by design: FTL's post chain (see engine/post.js) does FXAA
// in the final grade. Tone mapping is OFF at the renderer — the scene
// renders LINEAR into a half-float target and the grade pass applies
// ACES + exposure.
// Throws only when BOTH backends fail to produce a renderer.
export async function createRenderer({ canvas, forceWebGL = false, pixelRatioCap = 1.25 }) {
  const boot = async (gl) => {
    const renderer = new THREE.WebGPURenderer({
      // alpha:false configures the WebGPU canvas 'opaque' (swarm finding:
      // the default 'premultiplied' makes Firefox composite the full-window
      // canvas WITH blending every frame — pure waste over a black page)
      canvas, antialias: false, alpha: false,
      powerPreference: 'high-performance', forceWebGL: gl,
    });
    await renderer.init();
    return renderer;
  };
  let renderer;
  if (forceWebGL || !navigator.gpu) {
    renderer = await boot(true);
  } else {
    try {
      renderer = await boot(false);
      if (!renderer.backend.isWebGPUBackend) throw new Error('webgpu init fell through');
    } catch (err) {
      console.warn('[ftl] WebGPU unavailable, falling back to WebGL2:', err?.message ?? err);
      renderer = await boot(true);
    }
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.info.autoReset = false; // hosts accumulate per-frame across post passes
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

// The device can be lost mid-run — WebGPU by spec at any time, WebGL2 by
// context loss. Rather than a frozen black canvas: reload in place, capped
// by a session counter so a hopeless driver doesn't reload-loop. A lost
// WEBGPU device downgrades the reload onto the WebGL2 backend (?gl=1) —
// an immature WebGPU stack that dies mid-run (user report: Firefox on an
// older macOS) reboots into the backend that works instead of back into
// the one that just failed. `params` are written onto the reload URL so
// the host can reboot into the same state (seed).
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
    if (renderer.backend?.isWebGPUBackend) u.searchParams.set('gl', '1');
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
    // WATCHDOG (swarm finding, live incident): Firefox's wgpu can grind a
    // compileAsync for minutes (the backend yields one rAF per object at
    // whatever the frame rate is) or stall a pipeline promise outright — and
    // the vendored wrapper only ever RESOLVES, so the catch below can never
    // fire on a stall. Un-deadlined, `prewarming` latched true forever and
    // the descend ladder below was dead code: the game sat at rung 0 at 20
    // FPS. Each rung now races a generous deadline; on timeout we abandon
    // the wait (the compile keeps filling the pipeline cache in the
    // background — pipelines lazy-compile mid-game exactly as pre-prewarm),
    // and `prewarming` ALWAYS clears in the finally.
    const DEADLINE_MS = 18000;
    try {
      const restore = forceWarm ? forceWarm(scene) : null;
      try {
        for (const i of seq) {
          this.applyRung(i);
          const timedOut = await Promise.race([
            this.renderer.compileAsync(scene, camera).then(() => false),
            new Promise((r) => setTimeout(() => r(true), DEADLINE_MS)),
          ]);
          if (timedOut) {
            console.warn(`[${this.label}] prewarm rung ${i} compile exceeded ${DEADLINE_MS}ms — unblocking the quality ladder (slow shader compiles; pipelines will finish warming in the background)`);
            break;
          }
        }
      } finally {
        restore?.();
      }
    } catch { /* fall through to the finally — the ladder must never stay latched */ } finally {
      this.applyRung(start);
      this.prewarming = false;
    }
  }

  // Call once per frame with the real frame delta; walks resolution and
  // rungs on its internal 3s cadence.
  frame(now, dtRealSec, viewportW, viewportH) {
    this._ema = this._ema * 0.94 + Math.min(50, dtRealSec * 1000) * 0.06;
    if (now - this._evalAt <= 3000) return;
    this._evalAt = now;
    // NOTHING moves while pinned or prewarming (swarm finding: the walk used
    // to run on prewarm's TRANSIENT rungs — it read rung 3's 0.60 floor
    // mid-compile-grind and stranded pixel ratio below rung 0's 0.85 floor
    // forever once prewarm restored the start rung)
    if (this.pinned || this.prewarming) return;
    const R = this.rungs[this.rung];
    const cur = this.renderer.getPixelRatio();
    const floor = R.res[0];
    const budgetCap = this.hd ? 9 : Math.sqrt(this.pixelBudget / ((viewportW * viewportH) || 1));
    const cap = Math.max(floor, Math.min(window.devicePixelRatio || 1, this.hd ? 2 : R.res[1], budgetCap));
    let next = cur;
    if (this._ema > 20 && cur > floor) next = Math.max(floor, cur - 0.15);
    else if (this._ema < 13 && cur < cap) next = Math.min(cap, cur + 0.1);
    else if (cur < floor - 0.01) next = floor; // self-heal: never sit stranded below the active rung's floor
    if (Math.abs(next - cur) > 0.01) {
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(viewportW, viewportH, false);
      this.onResize?.(viewportW, viewportH);
    }
    // descend: pinned at the floor and still under ~42fps, twice running —
    // or CATASTROPHICALLY slow (~<25fps), where waiting out the resolution
    // walk first costs 12+ seconds of slideshow (swarm finding): drop a rung
    // immediately per evaluation until the machine breathes
    const catastrophic = this._ema > 40 && this.rung < this.rungs.length - 1;
    if (catastrophic || (this._ema > 24 && cur <= floor + 0.01 && this.rung < this.rungs.length - 1)) {
      if (catastrophic || ++this._slow >= 2) {
        this.applyRung(this.rung + 1);
        this._slow = 0;
        this._movedAt = now;
        console.info(`[${this.label}] quality rung -> ${this.rung} (frame ${this._ema.toFixed(1)}ms${catastrophic ? ', fast descent' : ''})`);
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
