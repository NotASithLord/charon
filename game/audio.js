// Synthesized positional audio (review P0: the horror runs on sound).
// Everything is generated WebAudio — no assets. One-shots are panned and
// attenuated relative to the listener (camera); the alarm is a loop that
// runs only during the last stand. AudioContext resumes on the first
// pointer-lock click (browser gesture requirement).

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = {};
    this.lastPlay = {};   // throttle key -> time
    this.listener = { x: 0, z: 0, yaw: 0 };
    this.alarmNodes = null;
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

  // --- procedural sample bank -----------------------------------------------
  _bake() {
    const sr = this.ctx.sampleRate;
    const mk = (sec, fn) => {
      const buf = this.ctx.createBuffer(1, Math.ceil(sec * sr), sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, i);
      return buf;
    };
    let seed = 1234;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };

    // rifle crack: noise burst with a fast decaying envelope + low thump
    this.buffers.shot = mk(0.16, (t) => {
      const env = Math.exp(-t * 55);
      return (rnd() * 1.6 * env) + Math.sin(t * 2 * Math.PI * 140) * Math.exp(-t * 40) * 0.7;
    });
    this.buffers.shotFar = mk(0.22, (t) => {
      const env = Math.exp(-t * 26);
      return rnd() * 0.9 * env + Math.sin(t * 2 * Math.PI * 90) * Math.exp(-t * 22) * 0.5;
    });
    // flood host weapon: looser, lower crack
    this.buffers.floodShot = mk(0.2, (t) => {
      const env = Math.exp(-t * 34);
      return rnd() * 1.2 * env + Math.sin(t * 2 * Math.PI * 70) * Math.exp(-t * 25) * 0.8;
    });
    // scream: falling squeal
    this.buffers.scream = mk(0.55, (t) => {
      const f = 950 - t * 900;
      return (Math.sin(t * 2 * Math.PI * f) * 0.5 + rnd() * 0.3) * Math.exp(-t * 5) * Math.min(1, t * 30);
    });
    // infection chitter: click train
    this.buffers.chitter = mk(0.35, (t) => {
      const g = Math.sin(t * 2 * Math.PI * 16) > 0.6 ? 1 : 0;
      return rnd() * g * Math.exp(-((t * 16) % 1) * 9) * 0.8;
    });
    // melee thud
    this.buffers.thud = mk(0.25, (t) =>
      Math.sin(t * 2 * Math.PI * (65 - t * 90)) * Math.exp(-t * 18) + rnd() * 0.2 * Math.exp(-t * 30));
    // door hiss
    this.buffers.door = mk(0.3, (t) => rnd() * Math.exp(-t * 9) * 0.4 * Math.min(1, t * 40));
    // grenade / carrier boom
    this.buffers.boom = mk(0.9, (t) =>
      (Math.sin(t * 2 * Math.PI * (55 - t * 30)) * 0.9 + rnd() * 0.8 * Math.exp(-t * 6)) * Math.exp(-t * 4.2));
    // hitmarker tick (UI, non-positional)
    this.buffers.tick = mk(0.05, (t) => Math.sin(t * 2 * Math.PI * 1900) * Math.exp(-t * 90) * 0.6);
    // reload clack + dry click
    this.buffers.clack = mk(0.12, (t) => rnd() * Math.exp(-t * 60) + Math.sin(t * 2 * Math.PI * 400) * Math.exp(-t * 70) * 0.4);
    // grenade bounce
    this.buffers.bounce = mk(0.08, (t) => Math.sin(t * 2 * Math.PI * 240) * Math.exp(-t * 60) * 0.7 + rnd() * 0.2 * Math.exp(-t * 80));
    // fire crackle: sputtering noise pops
    this.buffers.crackle = mk(0.5, (t) => {
      const pop = Math.sin(t * 2 * Math.PI * (7 + t * 5)) > 0.55 ? 1 : 0.2;
      return rnd() * pop * Math.exp(-t * 2.2) * 0.55;
    });
    // radio blip
    this.buffers.radio = mk(0.16, (t) => Math.sin(t * 2 * Math.PI * (t < 0.08 ? 880 : 660)) * 0.35 * Math.exp(-t * 10));
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
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.94 + ((now * 7919) % 100) / 830; // tiny human variation
    const g = this.ctx.createGain();
    g.gain.value = clamp(gain, 0, 1.2);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; src.connect(g).connect(p).connect(this.master); }
    else src.connect(g).connect(this.master);
    src.start();
  }

  // klaxon loop for the last stand
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
