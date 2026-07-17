// Procedural humanoid meshes for the VAT harness. No model files: a boxy
// biped built from parts, each vertex tagged with a bone id so the baker
// (anim.js) can pose it per frame. Two tiers share the pipeline:
//   near = 10-part biped, mid = 4-part lump. (far tier is a billboard)

export const BONE = {
  PELVIS: 0, TORSO: 1, HEAD: 2,
  L_ARM: 3, R_ARM: 4, L_FOREARM: 5, R_FOREARM: 6,
  L_LEG: 7, R_LEG: 8, L_SHIN: 9, R_SHIN: 10,
};

// box(cx, cy, cz, sx, sy, sz, bone) -> {positions, bones, indices}
function box(cx, cy, cz, sx, sy, sz, bone, out) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const base = out.positions.length / 3;
  const verts = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  for (const v of verts) { out.positions.push(...v); out.bones.push(bone); }
  const quads = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  for (const [a, b, c, d] of quads) {
    out.indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
}

// Character is ~1.8 units tall, facing +Z, origin at feet.
export function buildNearMesh() {
  const out = { positions: [], bones: [], indices: [] };
  box(0, 1.02, 0, 0.34, 0.22, 0.22, BONE.PELVIS, out);
  box(0, 1.38, 0, 0.42, 0.48, 0.24, BONE.TORSO, out);
  box(0, 1.74, 0, 0.22, 0.24, 0.24, BONE.HEAD, out);
  box(-0.29, 1.44, 0, 0.12, 0.34, 0.14, BONE.L_ARM, out);
  box(0.29, 1.44, 0, 0.12, 0.34, 0.14, BONE.R_ARM, out);
  box(-0.29, 1.10, 0, 0.11, 0.34, 0.13, BONE.L_FOREARM, out);
  box(0.29, 1.10, 0, 0.11, 0.34, 0.13, BONE.R_FOREARM, out);
  box(-0.10, 0.72, 0, 0.14, 0.42, 0.16, BONE.L_LEG, out);
  box(0.10, 0.72, 0, 0.14, 0.42, 0.16, BONE.R_LEG, out);
  box(-0.10, 0.26, 0, 0.13, 0.50, 0.14, BONE.L_SHIN, out);
  box(0.10, 0.26, 0, 0.13, 0.50, 0.14, BONE.R_SHIN, out);
  return finish(out);
}

// mid LOD: torso+head+two leg slabs, animated by the same bone curves
export function buildMidMesh() {
  const out = { positions: [], bones: [], indices: [] };
  box(0, 1.30, 0, 0.44, 0.75, 0.24, BONE.TORSO, out);
  box(0, 1.74, 0, 0.22, 0.24, 0.24, BONE.HEAD, out);
  box(-0.10, 0.47, 0, 0.15, 0.94, 0.16, BONE.L_LEG, out);
  box(0.10, 0.47, 0, 0.15, 0.94, 0.16, BONE.R_LEG, out);
  return finish(out);
}

function finish(out) {
  return {
    positions: new Float32Array(out.positions),
    bones: new Uint8Array(out.bones),
    indices: new Uint32Array(out.indices),
    vertexCount: out.positions.length / 3,
  };
}

// pivots for bone rotations (local joint origins)
export const PIVOT = {
  [BONE.PELVIS]: [0, 1.0, 0],
  [BONE.TORSO]: [0, 1.14, 0],
  [BONE.HEAD]: [0, 1.62, 0],
  [BONE.L_ARM]: [-0.29, 1.58, 0],
  [BONE.R_ARM]: [0.29, 1.58, 0],
  [BONE.L_FOREARM]: [-0.29, 1.27, 0],
  [BONE.R_FOREARM]: [0.29, 1.27, 0],
  [BONE.L_LEG]: [-0.10, 0.94, 0],
  [BONE.R_LEG]: [0.10, 0.94, 0],
  [BONE.L_SHIN]: [-0.10, 0.51, 0],
  [BONE.R_SHIN]: [0.10, 0.51, 0],
};
