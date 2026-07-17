// Bakes the six clips (§9: idle, walk, run, attack, death, infect_writhe)
// into a vertex animation texture: one texel per vertex per frame, rgba32float,
// row = clipBase + frame, column = vertex index. The vertex shader reads two
// rows and lerps — no skinning at draw time, no per-frame CPU work.

import { BONE, PIVOT } from './mesh.js';

export const CLIP_DEFS = [
  { name: 'idle', frames: 16, fps: 10 },
  { name: 'walk', frames: 16, fps: 14 },
  { name: 'run', frames: 12, fps: 18 },
  { name: 'attack', frames: 14, fps: 16 },
  { name: 'death', frames: 16, fps: 14, holdLast: true },
  { name: 'infect_writhe', frames: 16, fps: 12 },
];

const TWO_PI = Math.PI * 2;

// Per-clip bone pose: returns {rotX per bone, pelvisDy, pelvisPitch}
function pose(clip, ph) {
  const r = {}; // bone -> rotX (radians, forward swing)
  let dy = 0, pitch = 0, roll = 0;
  const s = (k, amp, off = 0) => Math.sin(ph * TWO_PI * k + off) * amp;
  switch (clip) {
    case 'idle':
      dy = s(1, 0.015);
      r[BONE.L_ARM] = 0.06 + s(1, 0.03);
      r[BONE.R_ARM] = -0.06 + s(1, 0.03, 1.3);
      r[BONE.HEAD] = s(1, 0.04, 0.7);
      break;
    case 'walk': {
      const sw = 0.55;
      r[BONE.L_LEG] = s(1, sw);
      r[BONE.R_LEG] = s(1, sw, Math.PI);
      r[BONE.L_SHIN] = Math.max(0, s(1, 0.8, Math.PI * 0.5));
      r[BONE.R_SHIN] = Math.max(0, s(1, 0.8, Math.PI * 1.5));
      r[BONE.L_ARM] = s(1, 0.4, Math.PI);
      r[BONE.R_ARM] = s(1, 0.4);
      dy = Math.abs(s(2, 0.03));
      break;
    }
    case 'run': {
      const sw = 0.95;
      r[BONE.L_LEG] = s(1, sw);
      r[BONE.R_LEG] = s(1, sw, Math.PI);
      r[BONE.L_SHIN] = Math.max(0, s(1, 1.3, Math.PI * 0.5));
      r[BONE.R_SHIN] = Math.max(0, s(1, 1.3, Math.PI * 1.5));
      r[BONE.L_ARM] = s(1, 0.8, Math.PI);
      r[BONE.R_ARM] = s(1, 0.8);
      r[BONE.L_FOREARM] = -0.9; r[BONE.R_FOREARM] = -0.9;
      dy = Math.abs(s(2, 0.06));
      pitch = 0.18;
      break;
    }
    case 'attack': {
      const lunge = ph < 0.4 ? ph / 0.4 : Math.max(0, 1 - (ph - 0.4) / 0.6);
      r[BONE.L_ARM] = -1.6 * lunge;
      r[BONE.R_ARM] = -1.6 * lunge + s(2, 0.15);
      r[BONE.L_FOREARM] = -0.5 * lunge;
      r[BONE.R_FOREARM] = -0.5 * lunge;
      pitch = 0.28 * lunge;
      dy = -0.05 * lunge;
      break;
    }
    case 'death': {
      const k = Math.min(1, ph * 1.5);
      pitch = 1.45 * k;          // topple forward
      dy = -0.82 * k;
      r[BONE.L_ARM] = 0.8 * k; r[BONE.R_ARM] = 0.7 * k;
      r[BONE.L_LEG] = -0.3 * k; r[BONE.R_LEG] = -0.2 * k;
      break;
    }
    case 'infect_writhe':
      dy = -0.75 + Math.abs(s(2, 0.05));
      pitch = 1.2 + s(2, 0.15);
      roll = s(3, 0.4);
      r[BONE.L_ARM] = s(3, 0.9); r[BONE.R_ARM] = s(3, 0.9, 1.1);
      r[BONE.L_LEG] = s(2, 0.7, 0.4); r[BONE.R_LEG] = s(2, 0.7, 1.9);
      r[BONE.L_SHIN] = Math.abs(s(3, 0.8)); r[BONE.R_SHIN] = Math.abs(s(3, 0.8, 0.9));
      break;
  }
  return { r, dy, pitch, roll };
}

function rotX(p, pivot, ang) {
  const y = p[1] - pivot[1], z = p[2] - pivot[2];
  const c = Math.cos(ang), s = Math.sin(ang);
  return [p[0], pivot[1] + y * c - z * s, pivot[2] + y * s + z * c];
}
function rotZ(p, pivot, ang) {
  const x = p[0] - pivot[0], y = p[1] - pivot[1];
  const c = Math.cos(ang), s = Math.sin(ang);
  return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, p[2]];
}

// Bake all clips for a mesh -> { data: Float32Array (w*h*4), width, height, clipTable }
export function bakeVAT(mesh) {
  const width = mesh.vertexCount;
  const totalFrames = CLIP_DEFS.reduce((s, c) => s + c.frames, 0);
  const data = new Float32Array(width * totalFrames * 4);
  const clipTable = [];
  let row = 0;
  const rootPivot = [0, 1.0, 0];
  for (const clip of CLIP_DEFS) {
    clipTable.push({ base: row, frames: clip.frames, fps: clip.fps, holdLast: !!clip.holdLast });
    for (let f = 0; f < clip.frames; f++) {
      const ph = f / clip.frames;
      const { r, dy, pitch, roll } = pose(clip.name, ph);
      for (let v = 0; v < mesh.vertexCount; v++) {
        let p = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
        const bone = mesh.bones[v];
        // limb rotation about its pivot
        if (r[bone]) p = rotX(p, PIVOT[bone] ?? rootPivot, r[bone]);
        // shins/forearms inherit their parent limb's swing
        const parent = { [BONE.L_SHIN]: BONE.L_LEG, [BONE.R_SHIN]: BONE.R_LEG, [BONE.L_FOREARM]: BONE.L_ARM, [BONE.R_FOREARM]: BONE.R_ARM }[bone];
        if (parent !== undefined && r[parent]) p = rotX(p, PIVOT[parent], r[parent]);
        // whole-body pitch/roll/bob
        if (pitch) p = rotX(p, rootPivot, pitch);
        if (roll) p = rotZ(p, rootPivot, roll);
        p[1] += dy;
        const o = (row * width + v) * 4;
        data[o] = p[0]; data[o + 1] = p[1]; data[o + 2] = p[2]; data[o + 3] = 1;
      }
      row++;
    }
  }
  return { data, width, height: totalFrames, clipTable };
}
