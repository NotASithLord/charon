// The Flood carrier: a real skinned mesh, instanced.
//
// Every carrier on the ship is one InstancedMesh — but three has no instanced
// skinning, so this does it by hand. scripts/convert-carrier.mjs bakes every
// pose of every clip into a joints x frames float texture of 3x4 skinning
// matrices; the vertex graph below looks up two rows per bone and lerps
// between them. Which two rows, and how far between, is a per-instance
// attribute (`aAnim`), so one draw call renders a dozen carriers each in its
// own clip at its own phase, mid-crossfade, at its own swell.
//
// The insertion point is NodeMaterial.setupPosition — the same slot three's
// own skinning() uses. That matters: it runs BEFORE instancedMesh() adds the
// per-instance transform, so the instance matrix still applies on top the way
// the rest of agents3d expects. (Doing it via material.positionNode would
// silently discard the instance matrix — that hook runs last.)

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import {
  Fn, attribute, texture, textureLoad, ivec2, int, vec3, vec4, dot, mix,
  positionLocal, normalLocal,
} from '../engine/vendor/three.tsl.module.js';
import { CARRIER } from './carrier-data.js';

// name -> {start, count, fps, loop, duration}
export const CARRIER_CLIPS = Object.fromEntries(CARRIER.clips.map((c) => [
  c.name, { ...c, duration: c.count / c.fps },
]));

// How far a full sack pushes the skin out along its normal, in metres. The
// mask is authored per vertex (weight on the Head/Neck/Spine2 chain, which is
// what the gas sack is skinned to) so this bloats the sack and leaves the
// legs alone — unlike a whole-instance scale, which grew its feet.
export const SACK_BLOAT_M = 0.135;

// ---------------------------------------------------------------------------
// per-carrier clip playback
// ---------------------------------------------------------------------------
export class CarrierAnimator {
  constructor(seed = 0) {
    this.clip = CARRIER_CLIPS.idle;
    // golden-ratio phase offset: a row of carriers must never breathe in step
    this.time = ((seed * 0.6180339887498949) % 1) * this.clip.duration;
    this.fadeFrom = CARRIER_CLIPS.idle.start;
    this.fade = 1;      // 1 = fully on this.clip
    this.fadeRate = 0;
  }

  play(name, fadeSec = 0.16) {
    const next = CARRIER_CLIPS[name];
    if (!next || next === this.clip) return;
    this.fadeFrom = this._frame0();    // freeze the pose we are leaving
    this.fade = 0;
    this.fadeRate = 1 / Math.max(0.01, fadeSec);
    // loop -> loop keeps its phase, so walk/run swap without resetting the
    // stride mid-step; anything else starts from the top
    const carry = this.clip.loop && next.loop && this.clip.duration > 0;
    const phase = carry ? (this.time % this.clip.duration) / this.clip.duration : 0;
    this.clip = next;
    this.time = phase * next.duration;
  }

  advance(dt) {
    this.time += dt;
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt * this.fadeRate);
  }

  get finished() { return !this.clip.loop && this.time >= this.clip.duration; }
  get progress() { return this.clip.duration > 0 ? Math.min(1, this.time / this.clip.duration) : 1; }

  // local frame position within the clip, as {i, frac}
  _local() {
    const { count, fps, loop, duration } = this.clip;
    if (loop) {
      const f = ((this.time % duration) + duration) % duration * fps;
      const i = Math.floor(f);
      return { i: i % count, j: (i + 1) % count, frac: f - i };
    }
    const f = Math.min(this.time * fps, count - 1);
    const i = Math.floor(f);
    return { i, j: Math.min(i + 1, count - 1), frac: f - i };
  }

  _frame0() { return this.clip.start + this._local().i; }

  // write [frame0, frame1, mix, bloat] for instance `i` of an aAnim attribute
  write(array, i, bloat) {
    const { start } = this.clip;
    const { i: a, j: b, frac } = this._local();
    const o = i * 4;
    if (this.fade < 1) {
      // crossfade: hold the outgoing pose against the incoming clip's nearest
      // frame. Both ends are continuous, and it reuses the same two taps.
      array[o] = this.fadeFrom;
      array[o + 1] = start + (frac < 0.5 ? a : b);
      array[o + 2] = this.fade;
    } else {
      array[o] = start + a;
      array[o + 1] = start + b;
      array[o + 2] = frac;
    }
    array[o + 3] = bloat;
  }
}

// ---------------------------------------------------------------------------
// mesh + material
// ---------------------------------------------------------------------------
class InstancedSkinNodeMaterial extends THREE.MeshStandardNodeMaterial {
  constructor(params, skinFn) {
    super(params);
    this._skinFn = skinFn;
  }

  setupPosition(builder) {
    this._skinFn();                  // assigns positionLocal / normalLocal
    return super.setupPosition(builder);   // then morph/instance/etc. on top
  }
}

function boneTexture() {
  const { width, height } = CARRIER.boneTex;
  const tex = new THREE.DataTexture(
    new Float32Array(CARRIER.bones), width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build the one instanced carrier mesh.
 * @param {number} cap maximum simultaneous carriers
 * @returns {{mesh: THREE.InstancedMesh, anim: Float32Array, commitAnim: Function}}
 */
export function buildCarrier(cap) {
  const d = CARRIER;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(d.position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(d.normal, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
  geo.setAttribute('boneIndex', new THREE.Float32BufferAttribute(d.boneIndex, d.influences));
  geo.setAttribute('boneWeight', new THREE.Float32BufferAttribute(d.boneWeight, d.influences));
  geo.setAttribute('sackMask', new THREE.Float32BufferAttribute(d.sackMask, 1));
  geo.setIndex(d.index);
  // position[] is in the model's BIND space and is meaningless unposed (the
  // GLB's rest pose is not its bind pose — see the converter). Skip the
  // bounding-sphere computation three would do from it and state the real
  // one: the animated silhouette, generously.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.25, 0.85, 0), 1.6);
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-0.6, 0, -1.1), new THREE.Vector3(1.3, 2.0, 1.1));

  const animAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  animAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAnim', animAttr);

  const bones = texture(boneTexture());

  const skinFn = Fn(() => {
    const anim = attribute('aAnim', 'vec4');
    const f0 = int(anim.x).toConst();
    const f1 = int(anim.y).toConst();
    const blend = anim.z.toConst();

    const bi = attribute('boneIndex', 'vec4');
    const bw = attribute('boneWeight', 'vec4');

    const p = vec4(positionLocal, 1.0).toConst();
    const n = normalLocal.toConst();
    const outP = vec3(0).toVar();
    const outN = vec3(0).toVar();

    // one influence: fetch the bone's three matrix rows at both frames, lerp,
    // and accumulate. Row r of joint j lives at texel (j * 3 + r, frame).
    const influence = (index, weight) => {
      const c = int(index).mul(3).toConst();
      const row = (r) => mix(
        textureLoad(bones, ivec2(c.add(r), f0)),
        textureLoad(bones, ivec2(c.add(r), f1)), blend);
      const r0 = row(0).toConst(), r1 = row(1).toConst(), r2 = row(2).toConst();
      outP.addAssign(vec3(dot(r0, p), dot(r1, p), dot(r2, p)).mul(weight));
      outN.addAssign(vec3(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n)).mul(weight));
    };
    influence(bi.x, bw.x);
    influence(bi.y, bw.y);
    influence(bi.z, bw.z);
    influence(bi.w, bw.w);

    const nrm = outN.normalize().toConst();
    // the swell: push the gas sack out along its own normal
    positionLocal.assign(outP.add(nrm.mul(anim.w.mul(attribute('sackMask', 'float')))));
    normalLocal.assign(nrm);
  }, 'void');

  const loader = new THREE.TextureLoader();
  const load = (file, srgb) => {
    const t = loader.load(`./assets/characters/${file}`);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;   // glTF UV convention, unlike the JMS-converted skins
    return t;
  };

  const mat = new InstancedSkinNodeMaterial({
    map: load(d.texture, true),
    emissiveMap: load(d.emissive, true),
    emissive: 0xffffff,
    emissiveIntensity: 0.85,
    roughness: 0.82,
    metalness: 0.04,
    side: THREE.FrontSide,
  }, skinFn);

  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.count = 0;
  mesh.frustumCulled = false;

  return {
    mesh,
    anim: animAttr.array,
    commitAnim(count) {
      if (animAttr.clearUpdateRanges) {
        animAttr.clearUpdateRanges();
        if (count > 0) animAttr.addUpdateRange(0, count * 4);
      }
      animAttr.needsUpdate = count > 0;
    },
  };
}
