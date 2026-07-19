// The MA5 rifle model — ported from first-strike (js/models.js buildRifleParts
// + the extracted CE asset mesh data, js/rifle-model-data.js). Source verts
// are interleaved [pos3, normal3, uv2, color3] (see first-strike geometry.js)
// in a Y-up, +Z-forward frame; deinterleaved here into THREE.BufferGeometry.
// Positioning constants (RIFLE_MUZZLE, the viewmodel gunTune offsets) are
// carried over from first-strike js/main.js verbatim, converted for Three's
// -Z-forward camera convention (the whole rig is built +Z-forward, then
// rotated 180° about Y once — see buildRifleViewmodel/buildRifleCarry).

import * as THREE from './vendor/three.module.js';
import { RIFLE_MESHES } from './rifle-model-data.js';

// muzzle tip in the rifle's authored local space (first-strike js/models.js)
export const RIFLE_MUZZLE = new THREE.Vector3(0, 0.015, 0.515);

// first-strike js/main.js gunTune, viewmodel placement in CAMERA-local space.
// Their engine's local +Z is forward; Three's camera-local forward is -Z, so
// z is negated when applied (see wireViewmodel below).
export const GUN_TUNE = { x: 0.165, y: -0.235, z: 0.235, ry: -0.08, rx: -0.045, rz: 0.02, s: 1.15 };

function geometryFor(part) {
  const src = RIFLE_MESHES[part];
  const n = src.vertexData.length / 11;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const o = i * 11;
    pos[i * 3] = src.vertexData[o]; pos[i * 3 + 1] = src.vertexData[o + 1]; pos[i * 3 + 2] = src.vertexData[o + 2];
    nrm[i * 3] = src.vertexData[o + 3]; nrm[i * 3 + 1] = src.vertexData[o + 4]; nrm[i * 3 + 2] = src.vertexData[o + 5];
    uv[i * 2] = src.vertexData[o + 6]; uv[i * 2 + 1] = src.vertexData[o + 7];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(src.indexData), 1));
  return geo;
}

const texLoader = new THREE.TextureLoader();
const texCache = new Map();
function tex(name) {
  if (!texCache.has(name)) {
    const t = texLoader.load(`./assets/rifle/${name}.png`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    texCache.set(name, t);
  }
  return texCache.get(name);
}

// Full-detail rifle (grip + gun + the HUD greebles) for the player's own
// viewmodel — one instance on screen, so the extra draw calls are free.
export function buildRifleViewmodel() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ map: tex('body'), roughness: 0.45, metalness: 0.55 });
  const dispMat = new THREE.MeshStandardMaterial({ map: tex('display'), emissive: 0xffffff, emissiveMap: tex('display'), emissiveIntensity: 0.8, roughness: 0.6 });
  const compassMat = new THREE.MeshStandardMaterial({ map: tex('compass'), emissive: 0xffffff, emissiveMap: tex('compass'), emissiveIntensity: 0.8 });
  const numberMat = (d) => new THREE.MeshStandardMaterial({ map: tex(`number-${d}`), emissive: 0xffffff, emissiveMap: tex(`number-${d}`), emissiveIntensity: 1.1, transparent: true });

  group.add(new THREE.Mesh(geometryFor('grip'), bodyMat));
  group.add(new THREE.Mesh(geometryFor('gun'), bodyMat));
  group.add(new THREE.Mesh(geometryFor('Screen1'), dispMat));
  group.add(new THREE.Mesh(geometryFor('Screen2'), dispMat));
  group.add(new THREE.Mesh(geometryFor('Compass'), compassMat));
  group.add(new THREE.Mesh(geometryFor('Ammo_icon'), dispMat));
  const leftNum = new THREE.Mesh(geometryFor('Left_Number'), numberMat(0));
  const rightNum = new THREE.Mesh(geometryFor('Right_Number'), numberMat(0));
  group.add(leftNum, rightNum);
  group.rotation.y = Math.PI; // authored +Z-forward -> Three's -Z-forward
  group.userData.setAmmoDigits = (mag) => {
    const tens = Math.floor(mag / 10) % 10, ones = mag % 10;
    leftNum.material = numberMat(tens);
    rightNum.material = numberMat(ones);
  };
  return group;
}

// Body + gun, merged into ONE geometry (untextured metal tint) so hundreds
// of carried rifles on marines/armed crew/armed combat forms still cost a
// single InstancedMesh draw call. Baked -90° about Y so the asset's native
// +Z-forward (barrel) becomes +X-forward, matching the heading convention
// agents3d.js already uses for carried-weapon placement.
let _mergedCarry = null;
export function carryGeometry() {
  if (_mergedCarry) return _mergedCarry;
  const parts = ['grip', 'gun'].map(geometryFor);
  let vCount = 0, iCount = 0;
  for (const g of parts) { vCount += g.attributes.position.count; iCount += g.index.count; }
  const pos = new Float32Array(vCount * 3), nrm = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  // native +Z-forward -> +X-forward. (+π/2: rotating -π/2 sends +Z to -X,
  // which had every carried rifle pointing backwards — user report)
  merged.rotateY(Math.PI / 2);
  _mergedCarry = merged;
  return merged;
}
