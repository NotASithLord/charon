#!/usr/bin/env node
// scripts/convert-carrier.mjs — convert the Halo 3 Flood carrier GLB (a
// Mixamo-rigged skinned mesh) into the game's own formats:
//   game/carrier-data.js                     mesh + skin weights + a baked
//                                            bone-matrix animation bank
//   game/assets/characters/floodcarrier*.jpg the embedded diffuse/emissive
//
// Source: "Enemies>Halo 3>The Flood>Carrier" by jameslucino117 on Sketchfab,
// CC-BY-4.0 — see game/assets/NOTICE.txt. Run with:
//   CARRIER_SRC=/path/to/enemieshalo_3the_floodcarrier.glb \
//     node scripts/convert-carrier.mjs [--probe]
//
// WHY A BONE BANK AND NOT A SkinnedMesh: the renderer draws every carrier on
// the ship from ONE InstancedMesh (see game/agents3d.js), and three has no
// instanced skinning. So every pose of every clip is evaluated here, offline,
// into a joints x frames texture of 3x4 skinning matrices; the shader looks
// up two rows and lerps. Per-instance clip/phase then rides on an instanced
// attribute, and the whole hive still costs one draw call.
//
// The GLB ships ONE clip ("Detonation" — a Mixamo forward-fall retarget).
// Every other state the sim can put a carrier in (rooted and incubating,
// waddling, hurrying, straining near-full) is authored here as local joint
// curves over the bind pose — see CLIPS below.

import { readFile, writeFile } from 'fs/promises';

const SRC = process.env.CARRIER_SRC
  ?? '/Users/notasithlord/Downloads/enemieshalo_3the_floodcarrier.glb';
const OUT_JS = 'game/carrier-data.js';
const OUT_TEX = 'game/assets/characters';
const PROBE = process.argv.includes('--probe');

// The carrier stands about a head shorter than a marine (1.83m) but is far
// wider — this is the height of the bind pose, feet on the deck.
const TARGET_HEIGHT = 1.72;

// ---------------------------------------------------------------------------
// minimal mat4 / quat math (column-major, same layout as THREE.Matrix4.elements)
// ---------------------------------------------------------------------------
const mIdent = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mMul(a, b) { // a * b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function mFromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

// general 4x4 inverse (the ancestor chain carries an arbitrary matrix)
function mInv(m) {
  const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) throw new Error('singular matrix');
  const d = 1 / det;
  return [
    t11 * d, (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d,
    t12 * d, (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d,
    t13 * d, (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d,
    t14 * d, (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d,
  ];
}

const mPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const mDir = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
];

// intrinsic XYZ euler -> quaternion
function qEuler(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function qSlerp(a, b, t) {
  let [ax, ay, az, aw] = a; const [bx, by, bz, bw] = b;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; ax = -ax; ay = -ay; az = -az; aw = -aw; }
  if (cos > 0.9995) {
    const o = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t];
    const l = Math.hypot(...o) || 1;
    return o.map((v) => v / l);
  }
  const th = Math.acos(cos), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

// ---------------------------------------------------------------------------
// GLB / glTF reader (zero-dependency; this repo ships no build step)
// ---------------------------------------------------------------------------
function parseGLB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = dv.getUint32(off, true);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type.startsWith('JSON')) json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
    else bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
    if (len % 4) off += 4 - (len % 4);
  }
  return { json, bin };
}

const COMPONENT = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
  5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function makeAccessorReader(json, bin) {
  return (index) => {
    const a = json.accessors[index];
    const bv = json.bufferViews[a.bufferView];
    const [TypedArray, bytes] = COMPONENT[a.componentType];
    const n = NUM_COMPONENTS[a.type];
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    if (bv.byteStride && bv.byteStride !== n * bytes) { // de-interleave
      const out = new TypedArray(a.count * n);
      for (let i = 0; i < a.count; i++) {
        const src = new TypedArray(bin.buffer, bin.byteOffset + base + i * bv.byteStride, n);
        out.set(src, i * n);
      }
      return out;
    }
    return new TypedArray(bin.buffer, bin.byteOffset + base, a.count * n);
  };
}

// ---------------------------------------------------------------------------
// authored clips
// ---------------------------------------------------------------------------
// Each pose function gets the cycle phase u in [0,1) and returns per-joint
// local deltas keyed by the Mixamo joint's short name: {rx, ry, rz} is a
// rotation POST-multiplied onto the joint's bind local transform (so it turns
// about the joint's own origin, carrying its children), and `s` is a uniform
// scale about that origin.
//
// Rig note for anyone re-tuning these: the carrier's gas sack is skinned to
// `Head` (the single heaviest joint on the model — 292 of the weight, more
// than Hips), so `Head.s` IS the bloat control. The spine chain leans the
// whole mass, and the legs are stubby so their swing reads mostly as a
// side-to-side lurch rather than a stride.
//
// AXES ARE PER JOINT, NOT GLOBAL. Mixamo bakes a different orientation into
// every bone — the Hips carry a 90-degree turn the legs do not — so there is
// no single "rz swings fore/aft" rule. Run `node scripts/convert-carrier.mjs
// --axes` to re-measure; as of this rig:
//
//   Hips              rx = roll (weight side to side)   ry = yaw   rz = pitch
//   Spine/Spine1/2    rz = pitch (lean)                 rx = lateral lean
//   Neck / Head       rz = rides the sack UP and DOWN   rx = sways it sideways
//   arms, legs, knees rz = swing fore/aft               rx = splay outward
//
// Getting this wrong is not subtle but it is easy to miss: an early cut drove
// Hips.rz as a roll, which actually pitched the whole body a sixth of a radian
// every step and dominated the foot travel the stride check measures.
const TAU = Math.PI * 2;

const CLIPS = {
  // ROOTED / INCUBATING: a seated carrier barely moves — it breathes, the
  // sack creaks, and the stubby limbs shift weight. Long cycle so a row of
  // carriers never pulses in unison (agents3d also phase-offsets by id).
  idle: {
    frames: 40, fps: 20, loop: true,
    pose: (u) => {
      const b = Math.sin(u * TAU);           // one slow breath per cycle
      const b2 = Math.sin(u * TAU * 2);
      return {
        Head: { s: 1 + b * 0.038, rz: b * 0.06, rx: b2 * 0.04 },   // sack rises and settles
        Neck: { rz: b * 0.04 },
        Spine2: { rz: b * 0.03, rx: b2 * 0.025 },                  // slow fore/aft breath
        Spine1: { rz: b * 0.022 },
        Spine: { rz: b * 0.018 },
        Hips: { rx: b * 0.02, ry: Math.sin(u * TAU + 1.1) * 0.03 },  // weight rocks, hips drift
        LeftArm: { rz: b * 0.07, rx: 0.05 + b2 * 0.04 },
        RightArm: { rz: -b * 0.06, rx: -0.05 - b2 * 0.04 },
        LeftForeArm: { rz: b2 * 0.05 },
        RightForeArm: { rz: -b2 * 0.05 },
        LeftUpLeg: { rz: b * 0.03 },
        RightUpLeg: { rz: -b * 0.03 },
      };
    },
  },

  // WADDLE: the sim walks a carrier at 0.55 x 1.4 m/s, so one full two-step
  // cycle is ~1.4s. It does not stride — it rolls its mass over one stubby
  // leg then the other, and the sack lags a beat behind the hips (the lag is
  // the whole reason it reads as heavy and full of liquid).
  walk: {
    frames: 28, fps: 20, loop: true,
    pose: (u) => {
      const s = Math.sin(u * TAU);           // step phase
      const roll = Math.sin(u * TAU - 0.6);  // weight transfer leads the step
      const lag = Math.sin(u * TAU - 1.5);   // sack sloshes late
      return {
        Hips: { rx: roll * 0.07, ry: s * 0.09, rz: 0.05 },   // roll + yaw, held forward
        Spine: { rx: -roll * 0.06, rz: -0.02 },
        Spine1: { rx: -roll * 0.05 },
        Spine2: { rx: lag * 0.08, rz: 0.03 },
        Neck: { rz: lag * 0.05, rx: lag * 0.05 },
        Head: { rz: lag * 0.09, rx: lag * 0.08, s: 1 + lag * 0.022 },
        LeftUpLeg: { rz: s * 0.56, rx: 0.10 },
        RightUpLeg: { rz: -s * 0.56, rx: -0.10 },
        // knees only fold on the swing-through half of each leg's cycle
        LeftLeg: { rz: Math.max(0, -s) * 0.55 },
        RightLeg: { rz: Math.max(0, s) * 0.55 },
        LeftArm: { rz: -s * 0.22, rx: 0.16 },
        RightArm: { rz: s * 0.22, rx: -0.16 },
        LeftForeArm: { rz: -0.12 - Math.max(0, s) * 0.18 },
        RightForeArm: { rz: -0.12 - Math.max(0, -s) * 0.18 },
      };
    },
  },

  // HURRYING: a near-full carrier closing on prey.
  //
  // NOT a bigger stride — a faster one. The sim moves a carrier at a flat
  // 0.55 x 1.4 = 0.77 m/s whatever it is doing (speedMult.carrier; _clipFor
  // never even returns RUN for one), so a longer step has no extra ground to
  // cover and the feet just skate. An early cut of this clip over-strode 2.6x
  // and looked like it was paddling. So: shorter cycle, SHORTER steps than
  // the walk, and all the extra energy in the torso, arms and sack.
  run: {
    frames: 20, fps: 20, loop: true,
    pose: (u) => {
      const s = Math.sin(u * TAU);
      const roll = Math.sin(u * TAU - 0.6);
      const lag = Math.sin(u * TAU - 1.7);
      return {
        Hips: { rx: roll * 0.10, ry: s * 0.13, rz: 0.12 },   // pitched further forward
        Spine: { rx: -roll * 0.09, rz: 0.05 },
        Spine1: { rx: -roll * 0.07, rz: 0.04 },
        Spine2: { rx: lag * 0.13, rz: 0.05 },
        Neck: { rz: lag * 0.08, rx: lag * 0.08 },
        Head: { rz: lag * 0.15, rx: lag * 0.13, s: 1 + lag * 0.035 },
        LeftUpLeg: { rz: s * 0.38, rx: 0.14 },
        RightUpLeg: { rz: -s * 0.38, rx: -0.14 },
        LeftLeg: { rz: Math.max(0, -s) * 0.34 },
        RightLeg: { rz: Math.max(0, s) * 0.34 },
        LeftArm: { rz: -s * 0.38, rx: 0.26 },
        RightArm: { rz: s * 0.38, rx: -0.26 },
        LeftForeArm: { rz: -0.22 - Math.max(0, s) * 0.26 },
        RightForeArm: { rz: -0.22 - Math.max(0, -s) * 0.26 },
      };
    },
  },

  // STRAINING: held >= ~85% of capacity. The skin can barely hold; the body
  // arches back around the sack, the limbs splay away from it, and the whole
  // thing shudders on a fast beat under the slow swell. This is the tell that
  // it is about to go, and the sim's ATTACK clip maps here.
  strain: {
    frames: 30, fps: 20, loop: true,
    pose: (u) => {
      const swell = Math.sin(u * TAU);
      const shudder = Math.sin(u * TAU * 6) * (0.55 + 0.45 * swell);
      return {
        // sack swells and rides UP; the spine arches BACK around it (rz < 0)
        Head: { s: 1.035 + swell * 0.055, rz: 0.07 + shudder * 0.05, rx: shudder * 0.07 },
        Neck: { rz: 0.05 + shudder * 0.04 },
        Spine2: { rz: -0.14 + shudder * 0.035, rx: shudder * 0.03 },
        Spine1: { rz: -0.11 + shudder * 0.025 },
        Spine: { rz: -0.09, rx: shudder * 0.02 },
        Hips: { rz: -0.05, rx: shudder * 0.03 },
        // limbs shoved outward and back by the swell, trembling
        LeftArm: { rz: 0.34 + shudder * 0.10, rx: 0.42 },
        RightArm: { rz: -0.34 - shudder * 0.10, rx: -0.42 },
        LeftForeArm: { rz: -0.30 + shudder * 0.09 },
        RightForeArm: { rz: -0.30 - shudder * 0.09 },
        LeftUpLeg: { rz: 0.12, rx: 0.20 },
        RightUpLeg: { rz: -0.12, rx: -0.20 },
        LeftLeg: { rz: 0.16 + Math.abs(shudder) * 0.06 },
        RightLeg: { rz: 0.16 + Math.abs(shudder) * 0.06 },
      };
    },
  },
};

// The GLB's own clip, resampled onto the same frame grid as the authored ones.
//
// It is NOT a clean standing-to-ground fall: at t=0 the hips are already down
// at 49 units against the rest pose's 87 (the body starts mid-collapse), and
// the root then slides ~0.5m forward over the clip. Both are fixed at bake
// time by `settle()` below — horizontal root motion is mostly cancelled so the
// carrier ruptures where the sim put it, and every frame is lifted so the
// lowest vertex rests exactly on the deck instead of sinking 0.65m through it.
//
// What survives is the useful part: the legs buckling under the load and the
// mass pitching forward. agents3d crossfades into it from standing (which
// reads as the legs giving out) and ramps the sack bloat across it, so the
// collapse and the rupture are the same motion. Only the first 0.55s is kept
// — past that the clip is just a settled body twitching, and by then the
// carrier has burst and is gone.
const BAKED = {
  name: 'detonate', source: 'Detonation', fps: 30, loop: false,
  seconds: 0.55, driftRemoved: 0.75,
};

// ---------------------------------------------------------------------------
async function main() {
  const { json, bin } = parseGLB(await readFile(SRC));
  const read = makeAccessorReader(json, bin);
  const nodes = json.nodes;
  const skin = json.skins[0];
  const prim = json.meshes[0].primitives[0];

  // --- node hierarchy -------------------------------------------------------
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));

  const baseTRS = nodes.map((n) => ({
    t: n.translation ? [...n.translation] : [0, 0, 0],
    r: n.rotation ? [...n.rotation] : [0, 0, 0, 1],
    s: n.scale ? [...n.scale] : [1, 1, 1],
    m: n.matrix ? [...n.matrix] : null,
  }));
  const localOf = (i, override) => {
    const b = baseTRS[i];
    if (b.m && !override) return b.m;
    const t = override?.t ?? b.t, r = override?.r ?? b.r;
    return mFromTRS(t, r, b.s);
  };

  // short joint name -> node index ("mixamorig:LeftUpLeg_015" -> "LeftUpLeg")
  const shortName = (n) => (n.name || '').replace(/^mixamorig:/, '').replace(/_\d+$/, '');
  const jointNodes = skin.joints;
  const nodeByName = new Map();
  jointNodes.forEach((ni) => nodeByName.set(shortName(nodes[ni]), ni));

  // world transform for every node, given per-node local overrides
  function worldMatrices(overrides) {
    const world = new Array(nodes.length).fill(null);
    const walk = (i, parentM) => {
      const m = mMul(parentM, overrides?.[i] ?? localOf(i));
      world[i] = m;
      for (const c of nodes[i].children || []) walk(c, m);
    };
    for (const rootIdx of json.scenes[json.scene ?? 0].nodes) walk(rootIdx, mIdent());
    return world;
  }

  const ibmFlat = read(skin.inverseBindMatrices);
  const IBM = jointNodes.map((_, j) => Array.from(ibmFlat.subarray(j * 16, j * 16 + 16)));

  // --- geometry -------------------------------------------------------------
  const position = read(prim.attributes.POSITION);
  const normal = read(prim.attributes.NORMAL);
  const uvRaw = read(prim.attributes.TEXCOORD_0);
  const jointsRaw = read(prim.attributes.JOINTS_0);
  const weightsRaw = read(prim.attributes.WEIGHTS_0);
  const indices = read(prim.indices);
  const vertexCount = position.length / 3;

  // --- normalisation: y-up, +X forward, feet at y=0, TARGET_HEIGHT metres ---
  // NOTE ON THIS FILE'S REST POSE: Sketchfab baked frame 0 of the fall clip
  // into the node TRS, so the scene-graph rest pose is NOT the bind pose —
  // jointWorld * IBM is a 90-degree turn, not identity. POSITION therefore
  // lives in bind space and only looks right once skinned. Everything below
  // consequently leaves position/normal untouched and folds the normalising
  // transform into the LEFT of every skinning matrix (N * world * IBM), which
  // is the same thing the GPU would do one step later.
  const restWorld = worldMatrices(null);
  const restSkin = jointNodes.map((ni, j) => mMul(restWorld[ni], IBM[j]));
  const wp = (name) => {
    const m = restWorld[nodeByName.get(name)];
    return [m[12], m[13], m[14]];
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Vertical comes from the LEGS (toes -> hips), not hips -> head: a carrier
  // is hunched, so its spine leans ~30 degrees off vertical even standing
  // still, and using it tips the whole model over.
  const hipMid = mid(wp('LeftUpLeg'), wp('RightUpLeg'));
  const toeMid = mid(wp('LeftToeBase'), wp('RightToeBase'));
  const up = norm(sub(hipMid, toeMid));
  let right = norm(sub(wp('RightUpLeg'), wp('LeftUpLeg')));
  right = norm(sub(right, up.map((c) => c * dot3(right, up))));  // re-orthogonalise
  // repo convention (see scripts/convert-h3-assets.mjs): +X forward, +Y up,
  // +Z right, right-handed -> forward = up x right
  const forward = norm(cross(up, right));
  // independent check: the feet must point the way we think forward is
  const footFwd = norm(sub(toeMid, mid(wp('LeftFoot'), wp('RightFoot'))));
  const footAgree = dot3(footFwd, forward);
  if (footAgree < 0.3) throw new Error(`forward axis disagrees with the feet (dot ${footAgree.toFixed(3)}) — check the joint names`);

  // rows of the rotation that sends (forward,up,right) onto (X,Y,Z)
  const R = [
    forward[0], up[0], right[0], 0,
    forward[1], up[1], right[1], 0,
    forward[2], up[2], right[2], 0,
    0, 0, 0, 1,
  ];

  // pose the mesh at rest and measure THAT (bind-space bounds are meaningless
  // here — see the note above), so the scale and floor offset describe the
  // silhouette the player actually sees standing on the deck
  const skinAt = (mats, v) => {
    const p = [0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const w = weightsRaw[v * 4 + c];
      if (w <= 0) continue;
      const q = mPoint(mats[jointsRaw[v * 4 + c]], [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]);
      p[0] += q[0] * w; p[1] += q[1] * w; p[2] += q[2] * w;
    }
    return p;
  };
  let minY = Infinity, maxY = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const y = mPoint(R, skinAt(restSkin, v))[1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const scale = TARGET_HEIGHT / (maxY - minY);
  const N = mMul(
    [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, -minY * scale, 0, 1],
    R,
  );

  // position/normal ship in bind space, untouched; N rides on the matrices
  const outPos = Float32Array.from(position);
  const outNrm = Float32Array.from(normal);

  // --- skin weights ---------------------------------------------------------
  // Sorted heaviest-first and renormalised. Pruning to 3 influences would
  // save a quarter of the per-vertex bone fetches, but this rig leans on the
  // 4th influence hard (up to 16% of a vertex's weight, mostly where the sack
  // meets the shoulders) and it creases visibly, so all four ride.
  const INFLUENCES = 4;
  const outIdx = new Float32Array(vertexCount * INFLUENCES);
  const outWgt = new Float32Array(vertexCount * INFLUENCES);
  let maxDropped = 0;
  for (let v = 0; v < vertexCount; v++) {
    const pairs = [];
    for (let c = 0; c < 4; c++) {
      const w = weightsRaw[v * 4 + c];
      if (w > 0) pairs.push([jointsRaw[v * 4 + c], w]);
    }
    pairs.sort((a, b) => b[1] - a[1]);
    const total = pairs.reduce((s, p) => s + p[1], 0) || 1;
    const kept = pairs.slice(0, INFLUENCES);
    const keptSum = kept.reduce((s, p) => s + p[1], 0);
    maxDropped = Math.max(maxDropped, (total - keptSum) / total);
    for (let c = 0; c < INFLUENCES; c++) {
      outIdx[v * INFLUENCES + c] = kept[c]?.[0] ?? 0;
      outWgt[v * INFLUENCES + c] = (kept[c]?.[1] ?? 0) / (keptSum || 1);
    }
  }

  // sack mask: how much of a vertex belongs to the gas sack (Head/Neck/Spine2
  // chain). agents3d inflates along the normal by this to show a carrier's
  // load without scaling its legs.
  const sackJoints = new Set(['Head', 'HeadTop_End', 'Neck', 'Spine2']
    .map((n) => jointNodes.indexOf(nodeByName.get(n))).filter((j) => j >= 0));
  const outSack = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    let m = 0;
    for (let c = 0; c < INFLUENCES; c++) if (sackJoints.has(outIdx[v * INFLUENCES + c])) m += outWgt[v * INFLUENCES + c];
    outSack[v] = m;
  }

  // --- animation bank -------------------------------------------------------
  // Sample the GLB's own clip onto a frame grid.
  const anim = json.animations.find((a) => a.name === BAKED.source) ?? json.animations[0];
  const tracks = new Map(); // nodeIndex -> {translation?, rotation?}
  let duration = 0;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = read(s.input);
    const values = read(s.output);
    duration = Math.max(duration, times[times.length - 1]);
    if (!tracks.has(ch.target.node)) tracks.set(ch.target.node, {});
    tracks.get(ch.target.node)[ch.target.path] = { times, values };
  }
  const sampleTrack = (track, stride, t, lerp) => {
    const { times, values } = track;
    let i = 0;
    while (i < times.length - 1 && times[i + 1] < t) i++;
    const j = Math.min(i + 1, times.length - 1);
    const span = times[j] - times[i];
    const f = span > 0 ? (t - times[i]) / span : 0;
    const a = Array.from(values.subarray(i * stride, i * stride + stride));
    const b = Array.from(values.subarray(j * stride, j * stride + stride));
    return lerp(a, b, Math.max(0, Math.min(1, f)));
  };
  const vLerp = (a, b, f) => a.map((v, k) => v + (b[k] - v) * f);

  // Assemble the frame list: one entry per (clip, frame) with the local
  // override matrices for that pose.
  const clipTable = [];
  const frames = [];      // each: array of JOINTS skinning matrices, in game space
  const frameRoot = [];   // matching hip position per frame, for root-motion removal
  const hipsNode = nodeByName.get('Hips');

  const bakePose = (overrides) => {
    const world = worldMatrices(overrides);
    // glTF skinning matrix with the normalising transform folded in front:
    // bind space -> scene space -> game space, in one 3x4
    const rootM = mMul(N, world[hipsNode]);
    return {
      mats: jointNodes.map((ni, j) => mMul(N, mMul(world[ni], IBM[j]))),
      root: [rootM[12], rootM[13], rootM[14]],
    };
  };

  const pushClip = (name, count, fps, loop, overrideFor) => {
    const start = frames.length;
    for (let f = 0; f < count; f++) {
      const posed = bakePose(overrideFor(f));
      frames.push(posed.mats);
      frameRoot.push(posed.root);
    }
    const clip = { name, start, count, fps, loop };
    clipTable.push(clip);
    return clip;
  };

  // Cancel a clip's root translation and stand it back on the deck. Authored
  // clips need neither (they only rotate joints); the GLB's does — see BAKED.
  const settle = (clip, driftRemoved) => {
    const restRoot = bakePose(null).root;
    for (let f = clip.start; f < clip.start + clip.count; f++) {
      let lowest = Infinity;
      for (let v = 0; v < vertexCount; v++) lowest = Math.min(lowest, skinAt(frames[f], v)[1]);
      const dx = -(frameRoot[f][0] - restRoot[0]) * driftRemoved;
      const dz = -(frameRoot[f][2] - restRoot[2]) * driftRemoved;
      const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, dx, -lowest, dz, 1];
      frames[f] = frames[f].map((m) => mMul(T, m));
    }
  };

  // authored clips
  for (const [name, clip] of Object.entries(CLIPS)) {
    pushClip(name, clip.frames, clip.fps, clip.loop, (f) => {
      const deltas = clip.pose(f / clip.frames);
      const overrides = {};
      for (const [jointName, d] of Object.entries(deltas)) {
        const ni = nodeByName.get(jointName);
        if (ni === undefined) throw new Error(`clip "${name}" references unknown joint ${jointName}`);
        const rot = mFromTRS([0, 0, 0], qEuler(d.rx || 0, d.ry || 0, d.rz || 0), [d.s ?? 1, d.s ?? 1, d.s ?? 1]);
        overrides[ni] = mMul(localOf(ni), rot);
      }
      return overrides;
    });
  }

  // the GLB's detonation, resampled and truncated to the useful window
  const detFrames = Math.round(Math.min(BAKED.seconds, duration) * BAKED.fps) + 1;
  const detClip = pushClip(BAKED.name, detFrames, BAKED.fps, BAKED.loop, (f) => {
    const t = (f / BAKED.fps);
    const overrides = {};
    for (const [ni, tr] of tracks) {
      const b = baseTRS[ni];
      const tt = tr.translation ? sampleTrack(tr.translation, 3, t, vLerp) : b.t;
      const rr = tr.rotation ? sampleTrack(tr.rotation, 4, t, qSlerp) : b.r;
      overrides[ni] = mFromTRS(tt, rr, b.s);
    }
    return overrides;
  });
  settle(detClip, BAKED.driftRemoved);

  // --- pack the bone texture ------------------------------------------------
  // layout: x = joint * 3 + row, y = frame; each texel is one row of the 3x4
  // affine skinning matrix. RGBA float, point sampled, fetched with textureLoad.
  const JOINTS = jointNodes.length;
  const texW = JOINTS * 3, texH = frames.length;
  const bones = new Float32Array(texW * texH * 4);
  for (let f = 0; f < frames.length; f++) {
    for (let j = 0; j < JOINTS; j++) {
      const m = frames[f][j];
      for (let r = 0; r < 3; r++) {
        const o = ((f * texW) + j * 3 + r) * 4;
        bones[o] = m[r]; bones[o + 1] = m[4 + r]; bones[o + 2] = m[8 + r]; bones[o + 3] = m[12 + r];
      }
    }
  }

  // --- sanity checks --------------------------------------------------------
  // the normalised rest pose must stand on the deck at TARGET_HEIGHT — this
  // catches a bad axis derivation or a botched N far more cheaply than the game does
  const restBank = bakePose(null).mats;
  let restLo = Infinity, restHi = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const y = skinAt(restBank, v)[1];
    restLo = Math.min(restLo, y); restHi = Math.max(restHi, y);
  }
  if (Math.abs(restLo) > 1e-3 || Math.abs((restHi - restLo) - TARGET_HEIGHT) > 1e-3) {
    throw new Error(`normalised rest pose is y[${restLo.toFixed(4)}, ${restHi.toFixed(4)}], expected [0, ${TARGET_HEIGHT}]`);
  }
  if (maxDropped > 0.05) throw new Error(`pruning to ${INFLUENCES} influences drops up to ${(maxDropped * 100).toFixed(1)}% of a vertex's weight`);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('bad normalisation scale');
  for (let k = 0; k < bones.length; k++) if (!Number.isFinite(bones[k])) throw new Error(`non-finite bone matrix at ${k}`);

  // FOOT SKATE. A locomotion clip has to match the sim's ground speed or the
  // feet slide: over one cycle each foot travels back, relative to the body,
  // by the ground the body covers while it is planted (~half the cycle). The
  // carrier always moves at speedMult.carrier * movement.baseMps whatever it
  // is doing — _clipFor never even returns RUN for one — so `run` is a faster
  // cadence with SHORTER steps, not a longer stride.
  const CARRIER_MPS = 0.55 * 1.4;   // shared/params.js
  const toeJoint = jointNodes.indexOf(nodeByName.get('LeftToeBase'));
  let toeVert = 0, toeWeight = -1;
  for (let v = 0; v < vertexCount; v++) {
    for (let c = 0; c < INFLUENCES; c++) {
      if (outIdx[v * INFLUENCES + c] === toeJoint && outWgt[v * INFLUENCES + c] > toeWeight) {
        toeWeight = outWgt[v * INFLUENCES + c]; toeVert = v;
      }
    }
  }
  const toeTravel = clipTable.map((c) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let f = c.start; f < c.start + c.count; f++) {
      const p = skinAt(frames[f], toeVert);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    }
    const ground = CARRIER_MPS * (c.count / c.fps) / 2;
    return { name: c.name, fwd: hi[0] - lo[0], lat: hi[2] - lo[2], vert: hi[1] - lo[1], ground };
  });
  for (const t of toeTravel) {
    if (t.name !== 'walk' && t.name !== 'run') continue;
    const ratio = t.fwd / t.ground;
    if (ratio < 0.7 || ratio > 1.4) {
      throw new Error(`"${t.name}" strides ${t.fwd.toFixed(2)}m against ${t.ground.toFixed(2)}m of ground ` +
        `(${ratio.toFixed(2)}x) — the feet will skate. Retune the leg curves, or run --axes if a joint's axes moved.`);
    }
  }

  // per-clip bounds, so a bad authored curve shows up here and not in-game
  const clipBounds = clipTable.map((c) => {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let f = c.start; f < c.start + c.count; f++) {
      for (let v = 0; v < vertexCount; v += 7) { // sparse sample, this is a guard not a report
        const p = [0, 0, 0];
        for (let inf = 0; inf < INFLUENCES; inf++) {
          const w = outWgt[v * INFLUENCES + inf];
          if (w <= 0) continue;
          const m = frames[f][outIdx[v * INFLUENCES + inf]];
          const q = mPoint(m, [outPos[v * 3], outPos[v * 3 + 1], outPos[v * 3 + 2]]);
          p[0] += q[0] * w; p[1] += q[1] * w; p[2] += q[2] * w;
        }
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      }
    }
    return { name: c.name, lo, hi };
  });

  // --axes: what does rx/ry/rz actually DO on each joint? Mixamo bakes a
  // different orientation into every bone (the Hips carry a 90-degree turn the
  // legs do not), so "rz swings fore/aft" is true per joint, not globally.
  // Prints the world displacement of each joint's heaviest vertex under a
  // +0.25 rad twist about each local axis: x = forward, y = up, z = right.
  if (process.argv.includes('--axes')) {
    const authored = [...new Set(Object.values(CLIPS).flatMap((c) => Object.keys(c.pose(0.13))))];
    // report the vertex that MOVES MOST under each twist — measuring the
    // joint's own heaviest vertex is useless for roots like the Hips, whose
    // heaviest vertices sit right on the pivot and barely shift while the
    // entire body above them swings.
    const restPts = [];
    for (let v = 0; v < vertexCount; v++) restPts.push(skinAt(restBank, v));
    const probeAxis = (ni, e) => {
      const mats = bakePose({ [ni]: mMul(localOf(ni), mFromTRS([0, 0, 0], qEuler(...e), [1, 1, 1])) }).mats;
      let best = [0, 0, 0], bestLen = -1;
      for (let v = 0; v < vertexCount; v++) {
        const p = skinAt(mats, v), b = restPts[v];
        const d = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
        const len = Math.hypot(...d);
        if (len > bestLen) { bestLen = len; best = d; }
      }
      return `(${best[0].toFixed(2)},${best[1].toFixed(2)},${best[2].toFixed(2)})`.padEnd(24);
    };
    console.log('largest vertex displacement under a +0.25 rad twist, as (fwd, up, right)');
    console.log('joint          rx                      ry                      rz');
    for (const jointName of authored) {
      const ni = nodeByName.get(jointName);
      console.log(`  ${jointName.padEnd(13)}` +
        [[0.25, 0, 0], [0, 0.25, 0], [0, 0, 0.25]].map((e) => probeAxis(ni, e)).join(''));
    }
    return;
  }

  if (PROBE) {
    console.log('axes  up', up.map((v) => v.toFixed(3)).join(','),
      ' right', right.map((v) => v.toFixed(3)).join(','),
      ' forward', forward.map((v) => v.toFixed(3)).join(','),
      ` (feet agree ${footAgree.toFixed(2)})`);
    const spineLean = Math.acos(Math.max(-1, Math.min(1, dot3(norm(sub(wp('Head'), wp('Hips'))), up)))) * 180 / Math.PI;
    console.log(`rest spine lean ${spineLean.toFixed(1)} deg off vertical`);
    console.log(`scale ${scale.toFixed(5)}  height ${TARGET_HEIGHT}  verts ${vertexCount}  tris ${indices.length / 3}`);
    console.log(`weights: max dropped by ${INFLUENCES}-influence prune = ${(maxDropped * 100).toFixed(2)}%`);
    console.log(`rest pose y[${restLo.toFixed(4)}, ${restHi.toFixed(4)}]`);
    console.log(`bone texture ${texW} x ${texH} (${(bones.length * 4 / 1024).toFixed(0)} KB float)`);
    for (const b of clipBounds) {
      console.log(`  ${b.name.padEnd(9)} x[${b.lo[0].toFixed(2)},${b.hi[0].toFixed(2)}] ` +
        `y[${b.lo[1].toFixed(2)},${b.hi[1].toFixed(2)}] z[${b.lo[2].toFixed(2)},${b.hi[2].toFixed(2)}]`);
    }
    // forward travel must dominate lateral, or the legs are paddling rather
    // than stepping (measured with the foot-skate guard above)
    console.log('  --- left-toe travel per clip (forward / lateral / vertical)');
    for (const t of toeTravel) {
      const skate = t.name === 'walk' || t.name === 'run'
        ? `  stride ${t.fwd.toFixed(2)}m vs ${t.ground.toFixed(2)}m of ground (${(t.fwd / t.ground).toFixed(2)}x)` : '';
      console.log(`    ${t.name.padEnd(9)} fwd ${t.fwd.toFixed(3)}m  ` +
        `lat ${t.lat.toFixed(3)}m  vert ${t.vert.toFixed(3)}m${skate}`);
    }
    // per-frame trace of the baked clip: where does the body leave the deck?
    const det = clipTable.find((c) => c.name === BAKED.name);
    console.log(`  --- ${BAKED.name} per frame (t, floor gap, forward drift, head height)`);
    for (let f = det.start; f < det.start + det.count; f++) {
      let lo = Infinity, fwd = -Infinity, top = -Infinity;
      for (let v = 0; v < vertexCount; v += 3) {
        const p = skinAt(frames[f], v);
        lo = Math.min(lo, p[1]); fwd = Math.max(fwd, p[0]); top = Math.max(top, p[1]);
      }
      console.log(`    f${String(f - det.start).padStart(2)} t=${((f - det.start) / det.fps).toFixed(2)}s ` +
        `y0=${lo.toFixed(2)} xmax=${fwd.toFixed(2)} ytop=${top.toFixed(2)}`);
    }
    return;
  }

  // --- emit -----------------------------------------------------------------
  for (const [i, name] of [[0, 'floodcarrier'], [1, 'floodcarrier_emissive']]) {
    const bv = json.bufferViews[json.images[i].bufferView];
    const start = bv.byteOffset || 0;
    await writeFile(`${OUT_TEX}/${name}.jpg`, bin.subarray(start, start + bv.byteLength));
  }

  const f32 = (a, p = 5) => `[${Array.from(a, (v) => {
    const s = v.toFixed(p);
    return s.replace(/\.?0+$/, '') || '0';
  }).join(',')}]`;
  const u32 = (a) => `[${Array.from(a).join(',')}]`;

  const src = `// GENERATED by scripts/convert-carrier.mjs — do not edit by hand.
// Halo 3 Flood carrier: skinned mesh + a baked bone-matrix animation bank.
// Source model "Enemies>Halo 3>The Flood>Carrier" by jameslucino117
// (sketchfab.com), CC-BY-4.0. See game/assets/NOTICE.txt.
//
// bones[] is a ${texW} x ${texH} RGBA-float image: x = joint * 3 + row,
// y = frame, each texel one row of a 3x4 skinning matrix. The bind pose is
// exactly identity, so frame data composes directly onto position[].
export const CARRIER = {
  influences: ${INFLUENCES},
  joints: ${JOINTS},
  height: ${TARGET_HEIGHT},
  texture: 'floodcarrier.jpg',
  emissive: 'floodcarrier_emissive.jpg',
  clips: ${JSON.stringify(clipTable)},
  boneTex: { width: ${texW}, height: ${texH} },
  position: ${f32(outPos)},
  normal: ${f32(outNrm, 4)},
  uv: ${f32(uvRaw, 5)},
  boneIndex: ${u32(outIdx)},
  boneWeight: ${f32(outWgt, 4)},
  sackMask: ${f32(outSack, 3)},
  index: ${u32(indices)},
  bones: ${f32(bones, 5)},
};
`;
  await writeFile(OUT_JS, src);
  console.log(`wrote ${OUT_JS} (${(src.length / 1024 / 1024).toFixed(2)} MB), ` +
    `${vertexCount} verts / ${indices.length / 3} tris, ` +
    `${clipTable.length} clips / ${frames.length} frames, bone tex ${texW}x${texH}`);
  for (const c of clipTable) console.log(`  ${c.name.padEnd(9)} ${String(c.count).padStart(3)}f @ ${c.fps}fps ${c.loop ? 'loop' : 'once'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
