// FTL ENGINE · audio — synthesized positional audio with zero assets.
// The engine owns the harness: AudioContext lifecycle (resumed on the
// first user gesture via ensure()), a master bus, bearing-panned and
// distance-attenuated one-shots, a through-the-structure far layer
// (lowpass muffling per vertical level of separation), a continuous
// ambience bed, and a klaxon loop. A host game subclasses and implements
// `_bake()` to define its procedural sample bank with `_mk` / `_rand`.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class PositionalSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = {};
    this.lastPlay = {};   // throttle key -> time
    this.listener = { x: 0, z: 0, yaw: 0 };
    this.alarmNodes = null;
    this.ambNodes = null;
    this._nextGroan = 0;
    this.ambientOneShot = null; // buffer name for the occasional ambience one-shot
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this._bake();
  }

  // hosts override: fill this.buffers with _mk()'d samples
  _bake() {}

  // bake helper: a mono buffer of `sec` seconds filled by fn(t, i)
  _mk(sec, fn) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.ceil(sec * sr), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, i);
    return buf;
  }

  // bake helper: a seeded LCG noise source in [-0.5, 0.5) — deterministic,
  // so a bank bakes identically every boot
  _rand(seed = 1234) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  }

  setListener(x, z, yaw) { this.listener.x = x; this.listener.z = z; this.listener.yaw = yaw; }

  // Play a one-shot. `at` = {x, z} world coords (null = in your ear).
  // `key` throttles repeats (per key, minimum interval).
  play(name, at = null, vol = 1, key = null, minGapMs = 90) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const buf = this.buffers[name];
    if (!buf) return;
    const now = performance.now();
    if (key) {
      if (now - (this.lastPlay[key] ?? 0) < minGapMs) return;
      this.lastPlay[key] = now;
    }
    let gain = vol, pan = 0;
    if (at) {
      const dx = at.x - this.listener.x, dz = at.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      if (d > 48) return;
      gain = vol / (1 + d / 7);
      // pan by the source's bearing relative to the camera
      const rightX = Math.cos(this.listener.yaw), rightZ = -Math.sin(this.listener.yaw);
      pan = d > 0.5 ? clamp((dx * rightX + dz * rightZ) / d, -1, 1) * 0.8 : 0;
    }
    if (!Number.isFinite(gain) || !Number.isFinite(pan)) return; // never feed NaN to an AudioParam
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.94 + ((now * 7919) % 100) / 830; // tiny human variation
    const g = this.ctx.createGain();
    g.gain.value = clamp(gain, 0, 1.2);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; src.connect(g).connect(p).connect(this.master); }
    else src.connect(g).connect(this.master);
    src.start();
    return src; // callers that need to cut a one-shot short (a speaker dying mid-line)
  }

  // Far one-shot heard THROUGH the structure: bearing-panned like play(),
  // but no distance cutoff — a lowpass does the physical muffling, closing
  // down with every level of separation (deckDelta) in the way.
  playFar(name, at, deckDelta, vol = 1, key = null, minGapMs = 2500) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const buf = this.buffers[name];
    if (!buf) return;
    const now = performance.now();
    if (key) {
      if (now - (this.lastPlay[key] ?? 0) < minGapMs) return;
      this.lastPlay[key] = now;
    }
    const dx = at.x - this.listener.x, dz = at.z - this.listener.z;
    const d = Math.hypot(dx, dz);
    const gain = clamp(vol / (1 + d / 30 + deckDelta * 0.7), 0, 0.5);
    if (gain < 0.02) return;
    const rightX = Math.cos(this.listener.yaw), rightZ = -Math.sin(this.listener.yaw);
    const pan = d > 0.5 ? clamp((dx * rightX + dz * rightZ) / d, -1, 1) * 0.6 : 0;
    if (!Number.isFinite(gain) || !Number.isFinite(pan)) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.9 + ((now * 7919) % 100) / 500;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = deckDelta === 0 ? 900 : deckDelta === 1 ? 380 : 220;
    lp.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) { src.connect(lp).connect(g).connect(p).connect(this.master); p.pan.value = pan; }
    else src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  // continuous tone bed: twin detuned drones (a slow beat frequency reads
  // as "machinery somewhere below") + filtered-noise air handling. Subtle —
  // it exists so the space never falls dead silent and one-shots land on
  // something.
  startAmbience() {
    if (!this.ctx || this.ambNodes) return;
    const g = this.ctx.createGain();
    g.gain.value = 0.0;
    g.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime + 3); // fade in
    const o1 = this.ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = 48;
    const o2 = this.ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 48.7;
    const og = this.ctx.createGain(); og.gain.value = 0.5;
    const sr = this.ctx.sampleRate;
    const nb = this.ctx.createBuffer(1, sr * 2, sr);
    const nd = nb.getChannelData(0);
    let s = 0;
    for (let i = 0; i < nd.length; i++) { s = s * 0.985 + (Math.random() - 0.5) * 0.03; nd[i] = s; }
    const noise = this.ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const nf = this.ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 420; nf.Q.value = 0.4;
    const ng = this.ctx.createGain(); ng.gain.value = 0.9;
    o1.connect(og); o2.connect(og); og.connect(g);
    noise.connect(nf).connect(ng).connect(g);
    g.connect(this.master);
    o1.start(); o2.start(); noise.start();
    this.ambNodes = { g, o1, o2, noise };
    this._nextGroan = performance.now() + 15000 + Math.random() * 20000;
  }

  // called each frame: schedules the occasional ambience one-shot (set
  // `this.ambientOneShot` to a baked buffer name) from a random bearing
  ambienceTick() {
    if (!this.ambNodes || !this.ctx || this.ctx.state !== 'running' || !this.ambientOneShot) return;
    const now = performance.now();
    if (now >= this._nextGroan) {
      this._nextGroan = now + 22000 + Math.random() * 40000;
      const ang = Math.random() * Math.PI * 2;
      this.play(this.ambientOneShot, {
        x: this.listener.x + Math.cos(ang) * 25,
        z: this.listener.z + Math.sin(ang) * 25,
      }, 0.8);
    }
  }

  // klaxon loop (alarm state)
  alarm(on) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (on && !this.alarmNodes) {
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoG = this.ctx.createGain();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 300;
      lfo.type = 'square';
      lfo.frequency.value = 1.2;
      lfoG.gain.value = 90;
      lfo.connect(lfoG).connect(osc.frequency);
      g.gain.value = 0.028;
      osc.connect(g).connect(this.master);
      osc.start(); lfo.start();
      this.alarmNodes = { osc, lfo, g };
    } else if (!on && this.alarmNodes) {
      this.alarmNodes.osc.stop(); this.alarmNodes.lfo.stop();
      this.alarmNodes = null;
    }
  }
}
