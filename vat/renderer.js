// WebGPU VAT crowd renderer (§9): one instanced draw per LOD tier.
//   near = full biped mesh + VAT, mid = low-poly lump + its own VAT,
//   far = camera-facing billboard. Distance from the dummy camera picks
// the tier. Per-instance data comes straight from the AgentBuffer.

import { buildNearMesh, buildMidMesh } from './mesh.js';
import { bakeVAT, CLIP_DEFS } from './anim.js';

const INST_FLOATS = 12; // posHeading(4) clipTime(4) tint(4)

const VAT_WGSL = /* wgsl */`
struct Uni { viewProj: mat4x4f, camPos: vec4f };
@group(0) @binding(0) var<uniform> uni: Uni;
@group(0) @binding(1) var vat: texture_2d<f32>;
@group(0) @binding(2) var<uniform> clips: array<vec4f, 8>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) tint: vec3f,
};

@vertex fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) posHeading: vec4f,
  @location(1) clipTime: vec4f,
  @location(2) tint: vec4f,
) -> VOut {
  let clip = clips[u32(clipTime.x)];
  let frames = clip.y;
  var frame = clipTime.y * clip.z;
  if (clip.w > 0.5) {
    frame = min(frame, frames - 1.001);
  } else {
    frame = frame - floor(frame / frames) * frames;
  }
  let f0 = floor(frame);
  var f1 = f0 + 1.0;
  if (f1 >= frames) {
    f1 = select(0.0, f0, clip.w > 0.5);
  }
  let k = frame - f0;
  let p0 = textureLoad(vat, vec2u(vi, u32(clip.x + f0)), 0).xyz;
  let p1 = textureLoad(vat, vec2u(vi, u32(clip.x + f1)), 0).xyz;
  var p = mix(p0, p1, k) * clipTime.z;
  let c = cos(posHeading.w);
  let s = sin(posHeading.w);
  p = vec3f(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  let world = p + posHeading.xyz;
  var o: VOut;
  o.pos = uni.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.tint = tint.rgb;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let n = normalize(cross(dpdx(in.world), dpdy(in.world)));
  let l = clamp(dot(n, normalize(vec3f(0.4, 0.8, 0.3))), 0.0, 1.0) * 0.65 + 0.35;
  return vec4f(in.tint * l, 1.0);
}
`;

const BILLBOARD_WGSL = /* wgsl */`
struct Uni { viewProj: mat4x4f, camPos: vec4f, camRight: vec4f, camUp: vec4f };
@group(0) @binding(0) var<uniform> uni: Uni;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) tint: vec3f,
};

// unit quad corners, triangle-list, 6 verts
const CORNERS = array<vec2f, 6>(
  vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(0.5, 1.0),
  vec2f(-0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0),
);

@vertex fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) posHeading: vec4f,
  @location(1) clipTime: vec4f,
  @location(2) tint: vec4f,
) -> VOut {
  let corner = CORNERS[vi];
  // dead/downed billboards lie low and flat
  let dead = clipTime.w;
  let h = mix(1.8, 0.45, dead) * clipTime.z;
  let w = mix(0.62, 1.5, dead) * clipTime.z;
  let bob = mix(abs(sin(clipTime.y * 6.0)) * 0.05, 0.0, dead);
  let world = posHeading.xyz
    + uni.camRight.xyz * corner.x * w
    + vec3f(0.0, corner.y * h + bob, 0.0);
  var o: VOut;
  o.pos = uni.viewProj * vec4f(world, 1.0);
  o.uv = vec2f(corner.x * 2.0, corner.y);
  o.tint = tint.rgb;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  // capsule silhouette: discard outside a rounded column
  let dx = abs(in.uv.x);
  let head = smoothstep(0.98, 0.9, in.uv.y);
  let cap = 1.0 - smoothstep(0.55, 0.9, dx + max(0.0, in.uv.y - 0.86) * 2.0);
  if (cap < 0.35) { discard; }
  let l = 0.35 + 0.45 * (1.0 - dx) * head;
  return vec4f(in.tint * l, 1.0);
}
`;

const GROUND_WGSL = /* wgsl */`
struct Uni { viewProj: mat4x4f, camPos: vec4f };
@group(0) @binding(0) var<uniform> uni: Uni;
struct VOut { @builtin(position) pos: vec4f, @location(0) world: vec3f };
const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
);
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let e = 120.0;
  let p = QUAD[vi] * e;
  var o: VOut;
  o.world = vec3f(p.x, 0.0, p.y);
  o.pos = uni.viewProj * vec4f(o.world, 1.0);
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let g = abs(fract(in.world.xz / 4.0) - 0.5);
  let line = smoothstep(0.46, 0.5, max(g.x, g.y));
  let base = vec3f(0.045, 0.055, 0.07);
  return vec4f(base + vec3f(0.02, 0.03, 0.04) * line, 1.0);
}
`;

// --- tiny mat4 helpers (column-major, WebGPU clip space) ---
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f;
  out[10] = far / (near - far); out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}
export function lookAt(eye, at, up) {
  const z = norm3(sub3(eye, at));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}
export function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class VatRenderer {
  static async create(canvas, { maxInstances = 512 } = {}) {
    if (!navigator.gpu) throw new Error('WebGPU unavailable — use Chrome/Edge 113+ or Safari 18+.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter.');
    const device = await adapter.requestDevice();
    const r = new VatRenderer();
    r.canvas = canvas;
    r.device = device;
    r.maxInstances = maxInstances;
    r.ctx = canvas.getContext('webgpu');
    r.format = navigator.gpu.getPreferredCanvasFormat();
    r.ctx.configure({ device, format: r.format, alphaMode: 'opaque' });
    r._init();
    return r;
  }

  _init() {
    const d = this.device;
    // meshes + VATs for near and mid tiers
    this.tiers = [buildNearMesh(), buildMidMesh()].map((mesh) => {
      const vat = bakeVAT(mesh);
      const tex = d.createTexture({
        size: [vat.width, vat.height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      d.queue.writeTexture({ texture: tex }, vat.data, { bytesPerRow: vat.width * 16 }, [vat.width, vat.height]);
      const clipArr = new Float32Array(8 * 4);
      vat.clipTable.forEach((c, i) => clipArr.set([c.base, c.frames, c.fps, c.holdLast ? 1 : 0], i * 4));
      const clipBuf = d.createBuffer({ size: clipArr.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(clipBuf, 0, clipArr);
      const indexBuf = d.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(indexBuf, 0, mesh.indices);
      return { mesh, tex, clipBuf, indexBuf, indexCount: mesh.indices.length };
    });

    this.uniBuf = d.createBuffer({ size: 64 + 16 * 3, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.instBuf = d.createBuffer({
      size: this.maxInstances * INST_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.instData = new Float32Array(this.maxInstances * INST_FLOATS);

    const instLayout = {
      arrayStride: INST_FLOATS * 4,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
        { shaderLocation: 2, offset: 32, format: 'float32x4' },
      ],
    };
    const depth = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

    const vatModule = d.createShaderModule({ code: VAT_WGSL });
    this.vatPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: vatModule, entryPoint: 'vs', buffers: [instLayout] },
      fragment: { module: vatModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depth,
    });
    for (const tier of this.tiers) {
      tier.bindGroup = d.createBindGroup({
        layout: this.vatPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniBuf } },
          { binding: 1, resource: tier.tex.createView() },
          { binding: 2, resource: { buffer: tier.clipBuf } },
        ],
      });
    }

    const bbModule = d.createShaderModule({ code: BILLBOARD_WGSL });
    this.bbPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: bbModule, entryPoint: 'vs', buffers: [instLayout] },
      fragment: { module: bbModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depth,
    });
    this.bbBindGroup = d.createBindGroup({
      layout: this.bbPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniBuf } }],
    });

    const gModule = d.createShaderModule({ code: GROUND_WGSL });
    this.groundPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: gModule, entryPoint: 'vs' },
      fragment: { module: gModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depth,
    });
    this.groundBindGroup = d.createBindGroup({
      layout: this.groundPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniBuf } }],
    });

    this._resize();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.depthTex) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.depthTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  // instances: array of {x,y,z,heading,clip,animTime,r,g,b,scale,dead}
  // camera: {eye:[..], at:[..]}  lodDist: {near, mid}
  render(instances, camera, lodDist = { near: 14, mid: 34 }) {
    this._resize();
    const d = this.device;
    const aspect = this.canvas.width / this.canvas.height;
    const proj = perspective(Math.PI / 3.4, aspect, 0.1, 400);
    const view = lookAt(camera.eye, camera.at, [0, 1, 0]);
    const viewProj = mul4(proj, view);
    const fwd = norm3(sub3(camera.at, camera.eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const uni = new Float32Array(16 + 12);
    uni.set(viewProj, 0);
    uni.set([...camera.eye, 1], 16);
    uni.set([...right, 0], 20);
    uni.set([...up, 0], 24);
    d.queue.writeBuffer(this.uniBuf, 0, uni);

    // partition instances by camera distance into near / mid / far
    const groups = [[], [], []];
    for (const it of instances) {
      const dx = it.x - camera.eye[0], dy = it.y - camera.eye[1], dz = it.z - camera.eye[2];
      const dist = Math.hypot(dx, dy, dz);
      groups[dist < lodDist.near ? 0 : dist < lodDist.mid ? 1 : 2].push(it);
    }
    let o = 0;
    const ranges = [];
    for (const grp of groups) {
      const first = o / INST_FLOATS;
      for (const it of grp) {
        if (o + INST_FLOATS > this.instData.length) break;
        this.instData[o++] = it.x; this.instData[o++] = it.y; this.instData[o++] = it.z; this.instData[o++] = it.heading;
        this.instData[o++] = it.clip; this.instData[o++] = it.animTime; this.instData[o++] = it.scale ?? 1;
        this.instData[o++] = it.dead ?? 0;
        this.instData[o++] = it.r; this.instData[o++] = it.g; this.instData[o++] = it.b; this.instData[o++] = 1;
      }
      ranges.push({ first, count: o / INST_FLOATS - first });
    }
    d.queue.writeBuffer(this.instBuf, 0, this.instData, 0, o);

    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.025, b: 0.035, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard',
      },
    });
    let drawCalls = 0;
    pass.setPipeline(this.groundPipeline);
    pass.setBindGroup(0, this.groundBindGroup);
    pass.draw(6); drawCalls++;

    pass.setPipeline(this.vatPipeline);
    pass.setVertexBuffer(0, this.instBuf);
    for (let t = 0; t < 2; t++) {
      if (!ranges[t].count) continue;
      pass.setBindGroup(0, this.tiers[t].bindGroup);
      pass.setIndexBuffer(this.tiers[t].indexBuf, 'uint32');
      pass.drawIndexed(this.tiers[t].indexCount, ranges[t].count, 0, 0, ranges[t].first);
      drawCalls++;
    }
    if (ranges[2].count) {
      pass.setPipeline(this.bbPipeline);
      pass.setBindGroup(0, this.bbBindGroup);
      pass.setVertexBuffer(0, this.instBuf);
      pass.draw(6, ranges[2].count, 0, ranges[2].first);
      drawCalls++;
    }
    pass.end();
    d.queue.submit([enc.finish()]);
    return { drawCalls, lodCounts: ranges.map((r) => r.count) };
  }
}
