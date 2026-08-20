// The MA5 rifle model — ported from first-strike (js/models.js buildRifleParts
// + the extracted CE asset mesh data, js/rifle-model-data.js). Source verts
// are interleaved [pos3, normal3, uv2, color3] (see first-strike geometry.js)
// in a Y-up, +Z-forward frame; deinterleaved here into THREE.BufferGeometry.
// Positioning constants (RIFLE_MUZZLE, the viewmodel gunTune offsets) are
// carried over from first-strike js/main.js verbatim, converted for Three's
// -Z-forward camera convention (the whole rig is built +Z-forward, then
// rotated 180° about Y once — see buildRifleViewmodel/buildRifleCarry).

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { RIFLE_MESHES } from './rifle-model-data.js';

// muzzle tip in the rifle's authored local space (first-strike js/models.js)
export const RIFLE_MUZZLE = new THREE.Vector3(0, 0.015, 0.515);

// first-strike js/main.js gunTune, viewmodel placement in CAMERA-local space.
// Their engine's local +Z is forward; Three's camera-local forward is -Z, so
// z is negated when applied (see wireViewmodel below).
// x/z pulled in 10% from first-strike's CE reference placement (user): the
// rifle sat a touch too far right and too far out in front of the eye. The
// muzzle flash and tracer origin ride rifleMesh.matrixWorld, so they follow.
export const GUN_TUNE = { x: 0.1485, y: -0.235, z: 0.2115, ry: -0.08, rx: -0.045, rz: 0.02, s: 1.15 };

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
  // MATTE GREY, color only (user: the body rendered striped/white). Bisected
  // live: this vendored WebGPU build compiles the viewmodel body's shader
  // with a constant lighting term — output ≈ material.color regardless of
  // every light in the scene (all locked to 0: no change; magenta in →
  // magenta out) — and an async-loading map bakes in as its white
  // placeholder, which is also what striped the original: the port's
  // negative Vs edge-clamped into the atlas's white top row. So the color
  // IS the on-screen pixel: the games' gunmetal, straight up.
  const bodyMat = new THREE.MeshStandardMaterial({
    // (user: consistent now but waaaay too light) — this color IS the
    // on-screen pixel (constant lighting term, see above), so it must be
    // the DARK end of gunmetal, not the mid-grey swatch
    color: 0x14161a,
    roughness: 0.88, metalness: 0.15,
  });
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
  // the ten digit materials are built ONCE and swapped (swarm finding: this
  // was constructing two fresh emissive materials per frame — ~120 WebGPU
  // bind-group builds a second, none ever disposed)
  const digitMats = Array.from({ length: 10 }, (_, d) => numberMat(d));
  let lastMag = -1;
  group.userData.setAmmoDigits = (mag) => {
    if (mag === lastMag) return;
    lastMag = mag;
    leftNum.material = digitMats[Math.floor(mag / 10) % 10];
    rightNum.material = digitMats[mag % 10];
  };
  return group;
}

// --- the flamethrower ------------------------------------------------------
// There is no ported asset for it, and there does not need to be one: what
// matters is that the man holding the only weapon in the game that permanently
// destroys a body is not holding an MA5. So it is built from primitives to the
// SAME conventions as carryGeometry — +X forward, origin at the weapon centre,
// muzzle out at RIFLE_MUZZLE.z — which means solveCarry puts hands on it with
// no changes to the carry at all.
//
// The silhouette is doing all the work and every part of it is chosen to be
// unmistakable at ten metres in the dark: twin pressure tanks riding on TOP
// (nothing else in the game has them), a fat feed hose looping out of them, and
// a long thin nozzle with an igniter ring where a rifle has a muzzle.
function mergeParts(parts) {
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
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  return merged;
}

// nozzle tip in the flamer's local space — where the jet leaves the weapon.
// Shorter than the MA5's 0.515: the igniter sits proud of a stubby barrel.
export const FLAMER_MUZZLE = new THREE.Vector3(0, 0.01, 0.56);

// The parts, authored once, GROUPED BY MATERIAL. The carried version merges
// them all (hundreds of instances, one draw call); the viewmodel keeps the
// groups apart and shades them separately. Same shapes either way, so the
// weapon in your hands and the weapon across the room are the same weapon.
function flamerParts() {
  const body = [], tanks = [], hose = [], nozzle = [];
  const push = (into, g, x, y, z, rx = 0, ry = 0, rz = 0) => {
    g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
    g.translate(x, y, z);
    into.push(g);
  };
  // a cylinder is authored along +Y; -90° about Z lays it down the +X barrel line
  const LIE = -Math.PI / 2;
  // receiver
  push(body, new THREE.BoxGeometry(0.50, 0.12, 0.11), 0.04, 0.0, 0);
  // TWIN PRESSURE TANKS, domed, sitting above the receiver
  for (const s of [-1, 1]) {
    push(tanks, new THREE.CylinderGeometry(0.072, 0.072, 0.40, 12, 1), -0.05, 0.145, s * 0.082, 0, 0, LIE);
    push(tanks, new THREE.SphereGeometry(0.072, 12, 8), 0.15, 0.145, s * 0.082);
    push(tanks, new THREE.SphereGeometry(0.072, 12, 8), -0.25, 0.145, s * 0.082);
  }
  // the yoke strapping them down, and the regulator between them
  push(body, new THREE.BoxGeometry(0.05, 0.20, 0.24), -0.05, 0.08, 0);
  push(body, new THREE.CylinderGeometry(0.038, 0.038, 0.10, 10, 1), 0.10, 0.145, 0, 0, 0, LIE);
  // FEED HOSE: out of the tank fronts, down and forward into the receiver
  {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.20, 0.145, 0.082),
      new THREE.Vector3(0.30, 0.10, 0.05),
      new THREE.Vector3(0.30, 0.01, 0.0),
      new THREE.Vector3(0.21, -0.02, 0.0),
    ]);
    hose.push(new THREE.TubeGeometry(curve, 14, 0.022, 6, false));
  }
  // stubby barrel out to the igniter
  push(body, new THREE.CylinderGeometry(0.030, 0.034, 0.30, 10, 1), 0.36, -0.01, 0, 0, 0, LIE);
  // NOZZLE: a flare, and the igniter ring standing proud of it — the one part
  // of the weapon that is lit from inside when it fires
  push(nozzle, new THREE.CylinderGeometry(0.058, 0.032, 0.09, 12, 1), 0.545, -0.01, 0, 0, 0, LIE);
  push(nozzle, new THREE.TorusGeometry(0.052, 0.013, 6, 14), 0.50, -0.01, 0, 0, Math.PI / 2, 0);
  // pistol grip and forward grip — both under the line, so the solved carry's
  // two hands land on something rather than in air
  push(hose, new THREE.BoxGeometry(0.07, 0.19, 0.06), -0.09, -0.14, 0, 0, 0, 0.22);
  push(hose, new THREE.BoxGeometry(0.06, 0.17, 0.055), 0.19, -0.13, 0, 0, 0, -0.14);
  return { body, tanks, hose, nozzle };
}

let _mergedFlamer = null;
export function flamerGeometry() {
  if (_mergedFlamer) return _mergedFlamer;
  const p = flamerParts();
  // authored +X-forward already (unlike the ported MA5, which needed the bake)
  _mergedFlamer = mergeParts([...p.body, ...p.tanks, ...p.hose, ...p.nozzle]);
  return _mergedFlamer;
}

// The flamethrower as the PLAYER holds it. Same primitives as the carried
// version — one weapon, one silhouette, whether it is in your hands or across
// the room — but as its own group so the igniter ring can be a separate
// emissive material that lights when the trigger is down.
//
// flamerGeometry() is authored +X-forward (the carry convention). The
// viewmodel rig is +Z-forward and gets rotated 180° about Y at the end, the
// same as the MA5, so this is rotated -90° about Y first to convert.
export function buildFlamerViewmodel() {
  const group = new THREE.Group();
  // MATTE AND DARK, on purpose. The torch is mounted at the eye, so a
  // viewmodel is lit from point-blank by the brightest light in the game and
  // then goes through bloom: the first cut of this was one metallic material
  // over the merged geometry and it blew out into a white slab with no
  // readable shape at all. Low metalness + high roughness keeps the specular
  // off it, and three tones give the silhouette internal edges to read by.
  // TEXTURED, and that is the whole trick. Flat-coloured primitives held 30 cm
  // from a head-mounted torch saturate to a single white silhouette with no
  // shading variation left in them — the first two cuts of this read as a
  // featureless cream blob, and neither darkening the colours nor yawing the
  // weapon touched it, because the problem was never shape or placement. The
  // MA5 survives the same light only because its material carries a map whose
  // dark pixels keep albedo variation alive through the exposure. So the
  // flamer borrows the same ship-panel map, tinted per part.
  const panel = tex('body');
  const mat = (r, g, b, rough, metal) => new THREE.MeshStandardMaterial({
    map: panel, color: new THREE.Color(r, g, b), roughness: rough, metalness: metal,
  });
  const bodyMat = mat(0.42, 0.45, 0.42, 0.88, 0.16);
  const tankMat = mat(0.60, 0.53, 0.28, 0.74, 0.26);   // oil-drab pressure bottles
  const hoseMat = mat(0.16, 0.16, 0.18, 0.98, 0.02);
  const nozzMat = mat(0.30, 0.28, 0.26, 0.66, 0.34);
  const p = flamerParts();
  for (const [parts, mat] of [[p.body, bodyMat], [p.tanks, tankMat], [p.hose, hoseMat], [p.nozzle, nozzMat]]) {
    const g = mergeParts(parts);
    g.rotateY(-Math.PI / 2); // +X-forward -> +Z-forward
    group.add(new THREE.Mesh(g, mat));
  }

  // the igniter: a small ring at the nozzle that sits dark until you fire and
  // then glows. It is the only lit part of the weapon, so the pilot light
  // reads clearly against the body in a black corridor.
  const pilotMat = new THREE.MeshStandardMaterial({
    color: 0x2a1b12, emissive: new THREE.Color(1.0, 0.42, 0.12), emissiveIntensity: 0,
    roughness: 0.5,
  });
  const pilot = new THREE.Mesh(new THREE.TorusGeometry(0.054, 0.016, 8, 16), pilotMat);
  pilot.position.set(0, -0.01, 0.50);
  group.add(pilot);

  group.rotation.y = Math.PI; // authored +Z-forward -> Three's -Z-forward
  // 0 = cold, 1 = full stream. Driven from main.js each frame.
  group.userData.setPilot = (v) => { pilotMat.emissiveIntensity = v * 5.5; };
  return group;
}

// Viewmodel placement for the flamer, in CAMERA-local space. It is a bulkier
// weapon than the MA5 and the tanks ride high, so held at the MA5's tune it
// buries the top of the receiver in the bottom of the screen: dropped and
// pushed out, and tipped down a touch so the nozzle stays in frame.
// Yawed well off the view axis on purpose: held square, the weapon points away
// from the eye and all you see is the rear domes of the twin tanks — two
// spheres, no edges. Turning it brings the receiver, the hose and the nozzle
// into frame, which is where its readable detail lives.
export const FLAMER_TUNE = { x: 0.230, y: -0.300, z: 0.325, ry: -0.35, rx: -0.025, rz: 0.04, s: 0.85 };

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
