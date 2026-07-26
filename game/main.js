// HALO CHARON — 3D slice (docs/ROADMAP-3D.md): an ODST with a fireteam,
// dropped into the ship while the FULL simulation plays out around them.
// Mechanics layer ported from the first-strike vertical slice (MA5 loop,
// armor-over-health, movement feel). The sim is untouched and authoritative.

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { Sim, fmtTime } from '../sim/sim.js';
import { hurtFloodForm } from '../sim/combat.js';
import { World, elevOf } from './world.js';
import { Agents3D } from './agents3d.js';
import { Player } from './player.js';
import { HeldWeapon } from './weapon.js';
import { MA5, FRAG, ODST } from './fps-data.js';
import { GameAudio } from './audio.js';
import { FireFX, SparkFX, BloodFX } from '../engine/fx.js';
import { MarineMap } from './map.js';
import { RNG } from '../shared/rng.js';
import { buildRifleViewmodel, GUN_TUNE, RIFLE_MUZZLE } from './rifle-model.js';
import { PhysicsWorld, initRapier, PHYS_DT } from '../engine/physics/physics-world.js';
import { PostFX } from '../engine/post.js';
import { LightPool } from '../engine/lights.js';
import { createRenderer, installDeviceLostReload, QualityGovernor, TickScheduler } from '../engine/runtime.js';

const canvas = document.getElementById('c');
// PERF (user: unusable frame rate on an M4 Air): MSAA off — the post chain
// makes canvas MSAA pure waste (FXAA in the grade handles edges) — and the
// pixel ratio caps at 1.25 instead of 2. Retina pr2 was rendering ~4M px
// through the 5-pass HDR pipeline × every light × PCFSoft; at 1.25 + FXAA +
// grain + bloom the difference on a laptop panel is imperceptible and the
// fragment bill drops ~2.6x. `?hd=1` opts back into full resolution;
// `?q=low` / `?q=full` pin the quality ladder (see RUNGS below).
const QP = new URLSearchParams(location.search);
const HD = QP.has('hd');
const QTIER = QP.get('q');
// WEBGPU (user: a discrete GPU behind WebGL can be hostage to the OS's
// per-app GPU routing — WebGPU's adapter request isn't). three's
// WebGPURenderer asks the browser for the high-performance adapter
// directly, so a laptop's discrete card gets used even when the browser
// process sits on the integrated GPU. Falls back to WebGL2 automatically
// (same node/TSL materials compile to GLSL there); ?gl=1 forces the
// fallback for A/B testing.
// Boot through the FTL engine runtime (engine/runtime.js): WebGPU first,
// automatic WebGL2 fallback when WebGPU is missing or fails to init
// (user report: a browser can expose navigator.gpu yet not actually work
// on an older OS — Firefox/macOS). ?gl=1 pins WebGL2 outright.
let renderer;
try {
  renderer = await createRenderer({
    canvas, forceWebGL: QP.has('gl'), pixelRatioCap: HD ? 2 : 1.25,
  });
} catch (err) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:12px;background:#05070a;color:#cfe0ff;'
    + 'font-family:monospace;text-align:center;padding:24px';
  div.innerHTML = '<b style="font-size:20px;letter-spacing:0.2em">RENDERER OFFLINE</b>'
    + `<span style="color:#8ea0b8;max-width:44em">Neither WebGPU nor WebGL2 could start: `
    + `${String(err?.message ?? err)}. Check that hardware acceleration is enabled.</span>`;
  document.body.appendChild(div);
  throw err;
}

// WEBGPU DIAGNOSTICS (live incident: black screen / vanishing draws on real
// WebGPU while the WebGL2 harness path is clean). Validation errors are
// normally swallowed into the console — surface the first few ON SCREEN so a
// playtest screenshot carries the actual GPU error text.
{
  const gpuDev = renderer.backend?.device;
  if (gpuDev?.addEventListener) {
    let shown = 0;
    gpuDev.addEventListener('uncapturederror', (e) => {
      if (shown >= 4) return;
      shown++;
      const div = document.createElement('div');
      div.style.cssText = 'position:fixed;left:10px;top:' + (40 + shown * 64) + 'px;z-index:98;'
        + 'max-width:46em;background:rgba(60,10,10,0.92);color:#ffb0a0;font:11px monospace;'
        + 'padding:6px 8px;border:1px solid #a05040;white-space:pre-wrap;pointer-events:none';
      div.textContent = 'WEBGPU ERROR: ' + String(e.error?.message ?? e.error).slice(0, 500);
      document.body.appendChild(div);
      console.error('[charon webgpu]', e.error);
    });
  }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 18, 60);

const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 220);
const post = new PostFX(renderer, scene, camera);
// ONE fixed pool serves every dynamic light source (fires, sparks, room
// fixtures, door spill, NPC muzzles, your muzzle/impacts/grenades) — see
// game/lights.js. Constant light count = bounded fragment cost and ZERO
// shader recompiles (adding/removing real lights recompiled every program).
const lightPool = new LightPool(scene, 10);

// IMAGE-BASED LIGHTING (the RoomEnvironment recipe, compacted): a tiny
// procedural interior baked through PMREM gives every PBR material real
// specular response — metal rails, rifle bodies and visors pick up soft
// directional sheen instead of rendering flat. environmentIntensity is
// graded with the darkness state so IBL NEVER leaks light into a black room.
{
  const env = new THREE.Scene();
  const em = (color, intensity, w, h, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color }));
    m.material.color.multiplyScalar(intensity);
    m.position.set(x, y, z); m.rotation.y = ry;
    env.add(m);
  };
  env.add(new THREE.Mesh(new THREE.BoxGeometry(20, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0x10141c, side: THREE.BackSide })));
  em(0xbfd8ff, 4, 6, 1, 0, 3.9, 0);            // cool overhead strip
  em(0x8fa8d8, 1.2, 3, 2, -9.9, 1.5, 0, Math.PI / 2);  // pale port glow
  em(0xff5030, 0.8, 2, 1, 9.9, 1.2, 0, -Math.PI / 2);  // faint red starboard
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.environmentIntensity = 0.08;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0x9fb2d0, 0x141821, 0.07);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x7d879e, 0.06);
scene.add(ambient);
const lamp = new THREE.PointLight(0xcfe0ff, 0, 10, 1.8);
scene.add(lamp);
// FLASHLIGHT (user rule): in flood-held darkness this is all you have. In
// spore fog its throw clamps to a few meters instead of the whole room.
// It casts REAL shadows now — a soft-penumbra spot, not a dumb hard cone.
const torch = new THREE.SpotLight(0xeaf2ff, 0, 30, 0.46, 0.62, 1.5);
const torchTarget = new THREE.Object3D();
scene.add(torch, torchTarget);
torch.target = torchTarget;
torch.castShadow = true;
// HALF-RATE SHADOWS: the WebGPU renderer throttles per-light — the loop
// stamps shadow.needsUpdate at 30Hz instead of every frame
torch.shadow.autoUpdate = false;
torch.shadow.mapSize.set(1024, 1024);
torch.shadow.camera.near = 0.3;
torch.shadow.camera.far = 32;
torch.shadow.bias = -0.002;
torch.shadow.radius = 4; // soft edges on everything the beam throws

// --- boot: random ship every run unless a seed is pinned in the URL
// (?seed=... for a reproducible one), starting flood kept light (20
// infection forms, no combat forms/carriers yet) ---
const seedFromUrl = new URLSearchParams(location.search).get('seed');
const seed = seedFromUrl || 'run-' + Math.random().toString(36).slice(2, 10);

// SAFETY NET (engine/runtime.js): device loss reloads onto the WebGL2
// fallback (WebGPU) or in place with a session cap (WebGL2), rebooting
// into the same seed — same ship.
installDeviceLostReload(renderer, {
  label: 'charon', storageKey: 'charon-gl-lost', params: { seed },
});
const sim = new Sim(seed);
const world = new World(scene, sim.graph, seed);
const agents = new Agents3D(scene, sim, world);
// ?nosc=1: disable the shadow-caster curation (A/B lever for the live
// real-WebGPU incident — webgl2 validates clean, webgpu can't run headless)
world.shadowCull = agents.shadowCull = !QP.has('nosc');

// spawn: CIC on the command deck (user tuning) — an ODST detail with a fireteam.
// Created synchronously WITHOUT physics so the intro/UI never blocks on the
// wasm load.
const player = new Player(canvas, world, sim, sim.graph.byId.get('cic'));

// Rapier physics: the player's authoritative horizontal collision, built from
// the same wall meshes the world just extruded (world.collisionBoxes()). Loaded
// OFF the boot path — a slow or failed wasm load must never wedge the game on
// the loading screen — and attached to the player when it resolves.
let physics = null;
initRapier().then(() => {
  physics = new PhysicsWorld({ staticBoxes: world.collisionBoxes() });
  player.attachPhysics(physics);
}).catch((e) => console.error('[charon] Rapier physics failed to initialise:', e));
agents.playerId = player.agent.id;
const fireteam = sim.attachPlayerSquad(player.agent, 3);
// MARINE TACNET (user request): the sim view's plan, filtered to what the
// marine teams actually see. Intel accumulates whether the map is open or not.
const marineMap = new MarineMap(
  document.getElementById('mapcanvas'), document.getElementById('mapside'),
  sim, fireteam.id, player.agent.id);
let mapOpen = false;
function toggleMap(open = !mapOpen) {
  mapOpen = open;
  document.getElementById('mapview').classList.toggle('mv-hidden', !mapOpen);
}
const audio = new GameAudio();
canvas.addEventListener('click', () => audio.ensure());

// FIRE (user rule): fires are SIM objects now — the breach blaze plus the
// ship's broken (jammed) doors, all seeded in the sim itself so the flames
// that hurt you are exactly the flames you see. The sim's flamethrower
// burns still light up live below.
const fire = new FireFX(scene, lightPool);
const blood = new BloodFX(scene);
for (let i = 0; i < sim.fires.length; i++) {
  const f = sim.fires[i];
  const [fx2, fz2] = world.simToWorld(f.x, f.y, f.deck);
  fire.add(`sim${i}`, fx2, fz2, elevOf(f.deck), f.scale);
}
// burning jammed doors carry a faint ember heat in the scorched panel
// material (the visible damage itself is the scorch texture + buckle +
// guttering amber lamp — no more flat red slab)
if (world.doorPanelsBad) {
  world.doorPanelsBad.material.emissive.setHex(0xff5510);
  world.doorPanelsBad.material.emissiveIntensity = 0.14;
}
// DAMAGE THROUGH THE SHIP (user: small high-fidelity fires + glow where it's
// dark, sparking junctions): render-only sites seeded per run — the portal
// event rattled the whole hull, so every deck carries a few small smolders
// and shorted panels. Never on the player's spawn room.
const sparks = new SparkFX(scene, lightPool);
fire.camera = camera;   // embers/sparks are instanced quads that billboard
sparks.camera = camera; // to the camera each update
{
  const dmgRng = new RNG(seed + ':damage');
  const byDeck = new Map();
  for (const n of sim.graph.nodes) {
    if (n.idx === sim.graph.breachNode || n.idx === player.agent.node) continue;
    if (!['corridor'].includes(n.type) && !n.roles.some((r) => ['maintenance', 'cargo', 'engineering', 'power', 'hangar'].includes(r))) continue;
    (byDeck.get(n.deck) ?? byDeck.set(n.deck, []).get(n.deck)).push(n);
  }
  for (const [deck, rooms] of byDeck) {
    for (let i = 0; i < 2 && rooms.length; i++) {
      const n = rooms[Math.floor(dmgRng.next() * rooms.length)];
      const [wx, wz] = world.simToWorld(
        n.x + dmgRng.range(-(n.w / 2 - 1.4), n.w / 2 - 1.4),
        n.y + (dmgRng.chance(0.5) ? -(n.d / 2 - 0.9) : n.d / 2 - 0.9), deck);
      if (dmgRng.chance(0.5)) fire.add(`dmg${deck}:${i}`, wx, wz, elevOf(deck), 0.45);
      else sparks.add(wx, elevOf(deck) + 1.7, wz);
    }
  }
}

// DUST IN THE AIR (fidelity pass): a drift of fine particulate rides along
// with the player — visible where light crosses it, invisible in the black.
// Motes wrap around a 9m cube centered on you so the cloud never runs out.
const motes = (() => {
  const N = 36, HALF = 4.5; // cut hard from 140 (user: fewer, smaller — gladly)
  // instanced billboard quads — the node renderer draws point primitives at
  // a fixed 1px, so the old THREE.Points motes silently vanished
  const p = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    p[i * 3] = (Math.random() - 0.5) * HALF * 2;
    p[i * 3 + 1] = Math.random() * 2.6 + 0.2;
    p[i * 3 + 2] = (Math.random() - 0.5) * HALF * 2;
    seeds[i] = Math.random() * 10;
  }
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(8, 8, 0.5, 8, 8, 7.5);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 16, 16);
  const tex = new THREE.CanvasTexture(c);
  const pts = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x9daabb, transparent: true, opacity: 0.1,
      map: tex, alphaMap: tex, depthWrite: false, fog: false,
    }), N);
  pts.frustumCulled = false;
  scene.add(pts);
  return {
    pts, p, seeds, HALF, t: 0, count: N,
    setCount(n) { this.count = Math.min(N, n); this.pts.count = this.count; },
  };
})();
const _moteM4 = new THREE.Matrix4();
const _moteV = new THREE.Vector3();
const _moteS = new THREE.Vector3(0.014, 0.014, 0.014);
function updateMotes(dt) {
  motes.t += dt;
  const H = motes.HALF;
  const p = motes.p;
  const q = camera.quaternion;
  for (let i = 0; i < motes.count; i++) {
    const s = motes.seeds[i];
    let x = p[i * 3] + Math.sin(motes.t * 0.3 + s) * 0.0012 + 0.0007;
    let y = p[i * 3 + 1] + Math.sin(motes.t * 0.22 + s * 2.1) * 0.0009 - 0.0004;
    let z = p[i * 3 + 2] + Math.cos(motes.t * 0.26 + s) * 0.0012;
    if (x > H) x -= H * 2; if (x < -H) x += H * 2;
    if (z > H) z -= H * 2; if (z < -H) z += H * 2;
    if (y < 0.1) y = 2.8; if (y > 2.9) y = 0.2;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    _moteM4.compose(_moteV.set(x, y, z), q, _moteS);
    motes.pts.setMatrixAt(i, _moteM4);
  }
  motes.pts.instanceMatrix.needsUpdate = true;
  motes.pts.position.set(player.x, elevOf(player.deck), player.z);
}

// shadow plumbing: the world is built — floors/ceilings receive, cover and
// bodies cast. Additive/transparent FX never cast.
scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  if (o.material?.transparent || o.material?.blending === THREE.AdditiveBlending) return;
  o.receiveShadow = true;
});
for (const m of world.wallMeshes) { m.castShadow = true; }
for (const set of [agents.civSet, agents.armedSet, agents.marineSet, agents.odstSet,
  agents.infectionSet, agents.combatCivSet, agents.combatOdstSet]) {
  for (const mesh of set) mesh.castShadow = true;
}
agents.carrier.castShadow = true;
agents.rifle.castShadow = true;

// QUALITY LADDER (user: framerate on an M2 Air — accessibility is the
// target). The old binary full/low tier is now a governed DEGRADATION
// LADDER: each rung sheds one cost, ordered cheapest-look-loss first, and
// the governor walks it per machine — resolution first inside a rung, then
// down a rung when pinned at the floor and still slow, back up after a
// long stable stretch. Every machine finds its own level; no guessing.
//   0  full: PCFSoft 1024 shadows @30Hz, 10 lights, bloom 0.5, 36 motes
//   1  tighter res window, shadow map 768
//   2  shadow map 512, 8 lights, bloom 0.375        (one recompile)
//   3  shadows OFF                                  (one recompile)
//   4  6 lights, bloom 0.25, 12 motes, floor 0.55   (one recompile; = old low)
// The recompile rungs are PREWARMED behind the intro (compileAsync), so
// stepping down mid-fight costs a uniform change, not a shader storm.
// ?q=full pins rung 0, ?q=low pins rung 4; ?hd=1 pins 0 with a 2.0 cap.
const RUNGS = [
  { res: [0.85, 1.25], shadowMap: 1024, shadows: true, lights: 10, bloom: 0.5, motes: 36 },
  { res: [0.7, 1.1], shadowMap: 768, shadows: true, lights: 10, bloom: 0.5, motes: 36 },
  { res: [0.7, 1.0], shadowMap: 512, shadows: true, lights: 8, bloom: 0.375, motes: 24 },
  { res: [0.6, 1.0], shadowMap: 512, shadows: false, lights: 8, bloom: 0.375, motes: 24 },
  { res: [0.55, 0.9], shadowMap: 512, shadows: false, lights: 6, bloom: 0.25, motes: 12 },
];
// whole-frame pixel budget: huge windows can't buy retina supersampling on
// an integrated GPU — the cap yields before the budget does (HD opts out)
const PIXEL_BUDGET = 3.0e6;
let rung = 0;
// the governor (engine/runtime.js) walks the ladder; the per-rung EFFECTS
// stay here — they touch this game's torch, light pool, bloom and motes
const governor = new QualityGovernor({
  renderer, rungs: RUNGS, pixelBudget: PIXEL_BUDGET, hd: HD, label: 'charon',
  apply: (R, i) => {
    rung = i;
    renderer.shadowMap.enabled = R.shadows;
    torch.castShadow = R.shadows;
    if (R.shadows) {
      if (torch.shadow.mapSize.x !== R.shadowMap) {
        torch.shadow.mapSize.set(R.shadowMap, R.shadowMap);
        torch.shadow.map?.dispose();
        torch.shadow.map = null;
      }
      torch.shadow.needsUpdate = true;
    }
    lightPool.setActive(R.lights);
    post.setBloomScale(R.bloom);
    motes.setCount(R.motes);
  },
  onResize: (w, h) => post.setSize(w, h),
});
const applyRung = (i) => governor.applyRung(i);
window.__quality = (i) => { governor.pinned = false; applyRung(Math.max(0, Math.min(RUNGS.length - 1, i))); };
if (QTIER === 'low') { applyRung(RUNGS.length - 1); governor.pinned = true; }
else if (QTIER === 'full' || HD) { applyRung(0); governor.pinned = true; }
else {
  try {
    // WebGPU exposes GPUAdapterInfo; the WebGL2 fallback still has the
    // debug-renderer string. Known-weak silicon starts near the bottom
    // (still free to climb if it proves fast).
    let gpu = '';
    if (renderer.backend.isWebGPUBackend) {
      // GPUDevice.adapterInfo — the backend stores the device, not the adapter
      const a = renderer.backend.device?.adapterInfo;
      gpu = [a?.vendor, a?.architecture, a?.device, a?.description].filter(Boolean).join(' ');
    } else {
      const gl = renderer.backend.gl;
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    }
    const weak = /Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Intel\(R\)? (U?HD|Iris|GMA)|\bgen-9|software/i.test(gpu)
      || (navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4);
    if (weak) applyRung(3);
  } catch { /* boot heuristic only — the governor still catches slow machines */ }
}

// PREWARM (perf): compile the recompile-heavy rung variants behind the
// intro screen (engine governor). forceWarm flips the late-appearing
// pipelines on — count-0 instanced sets, hidden flood veils — so the FIRST
// muzzle flash / veil / decal of a run doesn't compile mid-fight; the
// governor guarantees the restore runs even if a compile fails.
governor.prewarm(scene, camera, {
  forceWarm: (s) => {
    const warmed = [];
    s.traverse((o) => {
      if (o.isInstancedMesh && o.count === 0) { warmed.push([o, 'count', 0]); o.count = 1; }
    });
    for (const v of world.darkVeils) {
      if (v && !v.visible) { warmed.push([v, 'visible', false]); v.visible = true; }
    }
    return () => { for (const [o, k, val] of warmed) o[k] = val; };
  },
});

// REAL FLICKER SPILL (user: flickering lighting for real in each room): the
// ceiling strips' flicker used to be emissive-only — visible on the fixture,
// invisible on the room. A small pool of pooled point lights now rides the
// nearest unsteady fixtures on your deck, so a guttering room actually
// throws guttering light on its walls, floor and occupants.
function updateRoomLightPool() {
  // every powered fixture and every dead-room red lamp declares a VIRTUAL
  // light — the global pool picks the winners near you (dead ship, discrete
  // sources instead of an ambient wash)
  for (let n = 0; n < sim.graph.n; n++) {
    const L = world.roomLights[n];
    if (!L || L.x === undefined) continue;
    if (sim.darkAt(n)) continue; // flood-held rooms are DARK — nothing burns there
    const nd = sim.graph.node(n);
    if (nd.deck !== player.deck) continue;
    const d2 = (L.x - player.x) * (L.x - player.x) + (L.z - player.z) * (L.z - player.z);
    if (d2 > 40 * 40) continue;
    if (L.mode === 'dead' && L.emergency) {
      // red battery lamp over the hatch — dim, warm, with a slow breathe
      lightPool.add(L.em.x, L.em.y, L.em.z, 0xff4030,
        2.6 + Math.sin(performance.now() * 0.0011 + L.phase) * 0.5, 11, 1.9);
    } else {
      // hung WELL below the plating: the throw pools on the deck and walls
      // while the ceiling above stays near-black (user: bright ceilings
      // ruin the darkness — light the room, not the overhead). LONG rooms
      // (corridors, holds) emit up to three fixtures spaced down the long
      // axis — one center light left 40m corridor ends pitch black even
      // with the mains up (user: pitch-black regression).
      const nd = sim.graph.node(n);
      const longSpan = Math.max(nd.w, nd.d);
      const nFix = longSpan > 30 ? 3 : longSpan > 14 ? 2 : 1;
      const alongX = nd.w >= nd.d;
      const stepW = longSpan / (nFix + (nFix > 1 ? 0.2 : 1));
      for (let f = 0; f < nFix; f++) {
        const off = nFix === 1 ? 0 : (f - (nFix - 1) / 2) * stepW;
        lightPool.add(L.x + (alongX ? off : 0), L.y - 1.25, L.z + (alongX ? 0 : off),
          0xbfd4f2, L.mode === 'steady' ? 14 : 15 * L.lvl, 19, 1.9);
      }
    }
  }
}

// LIGHT TRANSFERS BETWEEN ROOMS (user rule): a lit room next to a dark one
// doesn't end at a flat black doorway — its fixtures push a pool of light a
// little way into the dark side. A small pool of spill lights sits just
// inside the dark room at each lit->dark doorway near the player.
function updateDoorSpill() {
  for (const d of world.doors) {
    if (d.deck !== player.deck) continue;
    const dx = d.x - player.x, dz = d.z - player.z;
    if (dx * dx + dz * dz > 30 * 30) continue;
    if (d.open01 < 0.05) continue; // a shut door spills nothing
    const a = d.edge.a, b = d.edge.b;
    const litA = world.lightLevel(a) > 0.1 && !sim.darkAt(a);
    const litB = world.lightLevel(b) > 0.1 && !sim.darkAt(b);
    if (litA === litB) continue; // both lit or both dark — no gradient
    const darkN = litA ? b : a;
    if (sim.darkAt(darkN)) continue; // the growth eats the spill
    const nd = sim.graph.node(darkN);
    const [cx2, cz2] = world.simToWorld(nd.x, nd.y, nd.deck);
    const ox = cx2 - d.x, oz = cz2 - d.z, ol = Math.hypot(ox, oz) || 1;
    lightPool.add(d.x + (ox / ol) * 1.4, elevOf(d.deck) + 1.7, d.z + (oz / ol) * 1.4,
      0xaec6e8, 2.2 * d.open01, 7, 2.0); // swells as the door slides up
  }
}

// GUNFIRE IS A LIGHT SOURCE (user rule): NPC muzzle flashes declare virtual
// lights — a dark room in a firefight strobes, through the global pool.
function updateMuzzleLights() {
  for (const p of agents.flashPoints ?? []) {
    lightPool.add(p.x, p.y, p.z, 0xffd9a0, 22, 9, 2.0);
  }
  // the player's own transients ride the pool too (they always win a slot)
  if (muzzleFlash.intensity > 0.02) lightPool.add(muzzleFlash.position.x, muzzleFlash.position.y, muzzleFlash.position.z, 0xffd9a0, muzzleFlash.intensity, 7, 2);
  if (wallSpark.intensity > 0.02) lightPool.add(wallSpark.position.x, wallSpark.position.y, wallSpark.position.z, 0xffb060, wallSpark.intensity, 4, 2.4);
  if (boomLight.intensity > 0.02) lightPool.add(boomLight.position.x, boomLight.position.y, boomLight.position.z, 0xffc890, boomLight.intensity, 22, 1.6);
}

// live flamethrower burns from the sim
function syncBurnFires() {
  for (let n = 0; n < sim.graph.n; n++) {
    const key = `burn${n}`;
    const burning = sim.graph.burningUntil[n] > sim.t;
    if (burning && !fire.fires.has(key)) {
      const nd = sim.graph.node(n);
      const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
      fire.add(key, wx, wz, elevOf(nd.deck), 1.2);
    } else if (!burning && fire.fires.has(key)) fire.remove(key);
  }
}

const weapon = new HeldWeapon(MA5);
player.onAmmoTaken = (src) => {
  if (src === 'armory') { sim.armoryStock--; weapon.reserve += 120; frags = Math.min(FRAG.max, frags + 4); sim.log('combat', `you strip mags and a bandolier of frags from the rack (${sim.armoryStock} rifles left)`); }
  else { src.wasArmed = false; weapon.reserve += 60; sim.log('combat', 'you take the mags off the dead'); }
};

// MA5 viewmodel — the real ported first-strike asset (game/rifle-model.js),
// at first-strike's exact CE reference placement (js/main.js gunTune),
// translated for Three's -Z-forward camera convention (their engine is
// +Z-forward; only the forward axis flips, right/up match 1:1).
const rifleMesh = buildRifleViewmodel();
const viewmodel = new THREE.Group();
viewmodel.add(rifleMesh);
viewmodel.position.set(GUN_TUNE.x, GUN_TUNE.y, -GUN_TUNE.z);
viewmodel.rotation.set(GUN_TUNE.rx, GUN_TUNE.ry, GUN_TUNE.rz);
viewmodel.scale.setScalar(GUN_TUNE.s);
camera.add(viewmodel);
scene.add(camera);
// transient combat lights are VIRTUAL now — they ride the global pool
// (near the player they always win a slot, so the look is unchanged)
const muzzleFlash = { position: new THREE.Vector3(), intensity: 0 };
const wallSpark = { position: new THREE.Vector3(), intensity: 0 };
const wallRay = new THREE.Raycaster();

// --- HUD ---
const el = (id) => document.getElementById(id);
// dirty-checked DOM writes (perf: setting textContent/style every frame
// forces style work even when the value is unchanged)
const _hudCache = {};
function setText(id, s) {
  if (_hudCache[id] !== s) { _hudCache[id] = s; el(id).textContent = s; }
}
function setStyle(id, prop, v) {
  const k = id + ':' + prop;
  if (_hudCache[k] !== v) { _hudCache[k] = v; el(id).style[prop] = v; }
}
const overlay = el('overlay');

// --- INTRO (user request): the briefing types itself out like a military
// report. Any key or click while it types reveals the whole thing; when it's
// done, a click deploys you (that click doubles as the pointer-lock and
// audio gesture). The sim runs cold underneath — by the time you hit the
// deck, the ship's log already has a history.
const INTRO_BODY = [
  'UNSC FLEETCOM — PRIORITY TRAFFIC // EYES ONLY',
  'FROM: CENTCOM SOL / MARS DEFENSE COORDINATION',
  'TO:   FFG-201 UNSC SATURN DEVOURING — MARS HIGH ANCHOR',
  'DATE: OCTOBER 2552 // LOCAL 0347',
  '',
  'SITUATION FOLLOWS.',
  '',
  'Sol has been a war of attrition since the day the Covenant first',
  'appeared off Earth. Every week they probe the anchorages, every',
  'week we push them back, at a high and bleeding cost. There are',
  'little less of us left to do the bleeding. This Charon class',
  'frigate has held the Mars sector through all of it.',
  '',
  'Two transmissions reached this station in the past week.',
  'The first: an outbreak on Earth. Not Covenant. Something else,',
  'loose near Voi — something that eats the dead and wears them.',
  'The second, stranger: a faction of the Covenant has broken from',
  'their own fleet and offered us alliance against it.',
  '',
  'At 0331 local, HOLY CHARITY — the Covenant holy city itself —',
  'exited slipspace directly on top of the Mars anchorage.',
  'At 0339 it tore open a slipspace rupture larger and more violent',
  'than anything on record, and was gone into it.',
  '',
  'The collapse wave killed the reactor, primary systems, and comms.',
  'Emergency power only. Every ship and station around Mars is likely',
  'as dark as we are. You have no way of knowing.',
  '',
  // the impact names the ACTUAL breach room this seed rolled
  `Moments before the rupture, something impacted the ${sim.graph.node(sim.graph.breachNode).name} deck.`,
  '',
  'Internal sensors are down. The crew is at stations.',
  'You are not alone in the dark.',
].join('\n');
const INTRO_MISSION = 'MISSION: SURVIVE. CONTAIN.';
const INTRO_TOTAL = INTRO_BODY.length + INTRO_MISSION.length;
const intro = el('intro'), introText = el('introText'), introMission = el('introMission'), introHint = el('introHint');
let introChars = 0, introDone = false, introGone = false;
function introRender() {
  introText.textContent = INTRO_BODY.slice(0, Math.min(introChars, INTRO_BODY.length));
  introMission.textContent = introChars > INTRO_BODY.length
    ? INTRO_MISSION.slice(0, introChars - INTRO_BODY.length) : '';
  if (introChars >= INTRO_TOTAL && !introDone) {
    introDone = true;
    introHint.textContent = 'CLICK TO DEPLOY';
    introHint.classList.add('ready');
  }
}
const introTimer = setInterval(() => {
  if (introGone || introDone) { clearInterval(introTimer); return; }
  introChars += 2;
  introRender();
}, 22);
function dismissIntro() {
  introGone = true;
  intro.style.display = 'none';
  overlay.classList.add('hidden');
  audio.ensure();
  canvas.requestPointerLock();
}
intro.addEventListener('click', () => {
  if (introDone) dismissIntro();
  else { introChars = INTRO_TOTAL; introRender(); }
});
window.addEventListener('keydown', () => {
  if (!introGone && !introDone) { introChars = INTRO_TOTAL; introRender(); }
});
const ghostAlive = () => {
  const gh = sim.playerConvertedTo ? sim.byId.get(sim.playerConvertedTo) : null;
  return gh && !gh.dead && gh.damage < 100 ? gh : null;
};
overlay.addEventListener('click', () => {
  if (player.dead && !ghostAlive()) return;
  overlay.classList.add('hidden');
  if (!player.dead) canvas.requestPointerLock();
});
let ended = false;
function endScreen(title, text, final = true) {
  if (ended) return;
  if (final) ended = true;
  document.exitPointerLock?.();
  el('ovTitle').textContent = title;
  el('ovText').textContent = text;
  overlay.querySelector('.keys').textContent = final
    ? 'reload the page for a new run (add ?seed=... for a specific ship)'
    : 'click to keep watching';
  overlay.classList.remove('hidden');
}

let lastEvent = 0;
// RADIO NET (user: the log is radio-report transcripts now, and its
// unreliability is IMPLICIT). Every line the player sees is a broadcast
// from a NAMED crew member. The rules:
//   - an event needs a living WITNESS in or adjacent to the room, or
//     nobody transmits and the player never hears about it;
//   - same-deck broadcasts always reach you;
//   - everything cross-deck is a crapshoot (the comms are dying);
//   - the armory ODSTs' hardened gear ALWAYS punches through.
// The sim debug page keeps the full omniscient log; the flood's mind is
// still never narrated here.
const _ominousAt = {};
const HUMAN_F = new Set([0, 1, 2]); // civilian, armed, marine
function humanIn(node, pred) {
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0 || a.isPlayer || !a.callsign) continue;
    if (!HUMAN_F.has(a.faction) || a.node !== node) continue;
    if (!pred || pred(a)) return a;
  }
  return null;
}
function witnessNear(node, pred = null) {
  if (node == null || node < 0) return null;
  const here = humanIn(node, pred);
  if (here) return here;
  for (const { to } of sim.graph.adj.std[node] ?? []) {
    const w = humanIn(to, pred);
    if (w) return w;
  }
  return null;
}
function squadSpeaker(msg) {
  const m = msg.match(/squad (\d+)/) ?? msg.match(/patrol (\d+)/);
  if (!m) return null;
  const isPatrol = m[0].startsWith('patrol');
  const squad = sim.squads.find((s) => isPatrol ? s.patrolNo === +m[1] : s.id === +m[1] - 1);
  if (!squad) return null;
  for (const id of squad.members) {
    const a = sim.byId.get(id);
    if (a && !a.dead && a.hp > 0 && a.callsign) return a;
  }
  return null;
}
function odstSpeaker() {
  for (const a of sim.agents) {
    if (a.odst && !a.dead && a.hp > 0 && !a.isPlayer && a.callsign) return a;
  }
  return null;
}
// did the broadcast reach you? (Math.random is fine here — receipt is a
// display-layer concern; the sim never sees it)
function delivered(speaker, always = false) {
  if (always) return true;
  if (!speaker) return false;               // nobody transmitted
  if (speaker.odst) return true;            // ODST comms always punch through
  if (speaker.deck === player.deck) return true;
  return Math.random() < 0.45;              // cross-deck: the net is dying
}
const spkName = (a) => a?.callsign ? `${a.callsign.rank} ${a.callsign.name}`.toUpperCase() : null;
function rx(e, speaker, msg, { always = false, type = 'radio', spk } = {}) {
  if (!delivered(speaker, always)) return null;
  return { t: e.t, type, spk: spk ?? spkName(speaker), msg };
}
// DIALOGUE VARIETY (user: dozens of diverse phrasings for every reportable
// event). Each transmission draws a random line from its pool — Math.random
// is fine, receipt and phrasing are display-layer; the sim never sees them.
// `r` is the room name (caller guarantees a fallback).
const VOICES = {
  ambush: [
    (r) => `contact! they were waiting for us in ${r}!`,
    (r) => `it's a trap — they were dug in at ${r}!`,
    (r) => `ambush! ambush in ${r}!`,
    (r) => `they hit us the second we cleared the hatch — ${r} is hot!`,
    (r) => `hostiles were sitting on ${r} — walked right into it!`,
    (r) => `they let us walk in. ${r}. everybody down!`,
    (r) => `contact rear! they were behind the racks in ${r}!`,
    (r) => `they were WAITING — say again, ${r} was staged!`,
    (r) => `sprung on us in ${r} — need guns here now!`,
    (r) => `point man's hit — they boxed us in at ${r}!`,
    (r) => `out of the dark, all sides — ${r}!`,
    (r) => `set-piece ambush in ${r}, they knew we were coming!`,
  ],
  taken: [
    (r) => `screams coming from ${r} — someone's in trouble`,
    (r) => `somebody's screaming in ${r}, we can't get to them`,
    (r) => `we heard a scream cut off in ${r}. it just stopped`,
    (r) => `someone in ${r} is yelling for help — who's closest?`,
    (r) => `they got somebody in ${r}. we heard the whole thing`,
    (r) => `there's screaming out of ${r} — repeat, screaming`,
    (r) => `struggle in ${r}. sounded bad. then nothing`,
    (r) => `we lost voice contact with ${r} mid-sentence`,
    (r) => `someone was calling for help near ${r} — gone quiet now`,
    (r) => `people are getting dragged down in ${r}, we can hear it`,
    (r) => `banging and screaming through the bulkhead from ${r}`,
    (r) => `that was a human voice in ${r}. was.`,
  ],
  strange: [
    (r) => `strange noises out of ${r}`,
    (r) => `hearing something wet moving around in ${r}`,
    (r) => `there's something in ${r}. don't know what`,
    (r) => `movement in ${r} — doesn't sound like boots`,
    (r) => `anyone else hearing that from ${r}?`,
    (r) => `something's scraping along the deck in ${r}`,
    (r) => `noises out of ${r} again. it's not the ventilation`,
    (r) => `${r} sounds wrong. requesting someone check it`,
    (r) => `low sounds from ${r} — like breathing, but not right`,
    (r) => `we keep hearing movement in ${r} and nobody's posted there`,
    (r) => `something knocked over a rack in ${r}. nobody's in there`,
    (r) => `can't explain what we're hearing out of ${r}`,
  ],
  rampage: [
    (r) => `heavy movement near ${r} — multiple contacts`,
    (r) => `multiple hostiles moving through ${r}!`,
    (r) => `they're pouring through ${r} — count is double digits`,
    (r) => `${r} is crawling with them!`,
    (r) => `mass movement in ${r}, headed our way!`,
    (r) => `we've got a swarm in ${r} — say again, a SWARM`,
    (r) => `whatever's in ${r}, it's not one of them, it's a lot`,
    (r) => `hostiles rampaging through ${r} — they're tearing it apart`,
    (r) => `stampede through ${r}! get clear of the hatches!`,
    (r) => `they're moving in force through ${r}`,
    (r) => `activity spike in ${r} — it's a push, they're pushing!`,
    (r) => `everything on this deck is converging on ${r}`,
  ],
  revive: [
    (r) => `something's moving in ${r}... it was down a second ago`,
    (r) => `the one we dropped in ${r} — it's getting up`,
    (r) => `body in ${r} just moved. bodies don't move`,
    (r) => `confirm your kills! the dead in ${r} aren't staying dead!`,
    (r) => `it stood back up. ${r}. it STOOD BACK UP`,
    (r) => `we put it down in ${r} and it's walking again`,
    (r) => `casualty in ${r} just... reanimated. engaging again`,
    (r) => `they don't stay down — another one's up in ${r}`,
    (r) => `movement from the casualties in ${r}. all of you, eyes on the floor`,
    (r) => `that thing in ${r} took a full mag and it's up again`,
    (r) => `dead pile in ${r} is moving. burn them. BURN them`,
    (r) => `whatever we killed in ${r}, we didn't kill it`,
  ],
  duct: [
    (r) => `hearing something in the ducts near ${r}`,
    (r) => `movement in the trunking over ${r}`,
    (r) => `there's something crawling through the vents by ${r}`,
    (r) => `scratching in the overhead near ${r} — it's in the ductwork`,
    (r) => `vent noise over ${r}. something heavy. moving fast`,
    (r) => `the trunking above ${r} just flexed — something's inside it`,
    (r) => `slithering sounds in the air handling near ${r}`,
    (r) => `it's in the walls. ${r}. it's IN the walls`,
    (r) => `duct grate rattling in ${r} — nobody's on maintenance rotation`,
    (r) => `tell me that's the fans in ${r}. that's not the fans`,
    (r) => `something's using the vents to move around ${r}`,
    (r) => `overhead noise tracking across ${r} — it's headed somewhere`,
  ],
  manDown: [
    (r) => `we have a man down in ${r}!`,
    (r) => `man down! man down in ${r}!`,
    (r) => `marine down in ${r} — we need help NOW`,
    (r) => `we lost one in ${r}!`,
    (r) => `casualty in ${r}! still taking fire!`,
    (r) => `he's down — ${r} — he's not moving`,
    (r) => `they got one of ours in ${r}!`,
    (r) => `KIA in ${r}. we couldn't reach him`,
    (r) => `one of my people is down in ${r}, request immediate support`,
    (r) => `we're carrying a casualty out of ${r} — cover the corridor!`,
    (r) => `${r} — man down, man down, MAN DOWN`,
    (r) => `lost another one in ${r}. that's on me`,
  ],
  distress: [
    (r) => `taking fire in ${r}! anyone copy?`,
    (r) => `contact in ${r}! we are engaged!`,
    (r) => `${r} — we're in it, need backup!`,
    (r) => `any station, any station — firefight in ${r}!`,
    (r) => `we are pinned in ${r}! somebody answer!`,
    (r) => `heavy contact in ${r} — expending fast!`,
    (r) => `they're on us in ${r}! copy anyone!`,
    (r) => `mayday from ${r}, we cannot hold this room alone!`,
    (r) => `who's near ${r}?! we need shooters!`,
    (r) => `engaged in ${r} — they just keep coming!`,
    (r) => `${r} is falling, say again ${r} is falling!`,
    (r) => `does ANYONE copy?! ${r}! now!`,
  ],
  burn: [
    (r) => `burning the bodies in ${r}`,
    (r) => `torching the casualties in ${r} — orders stand`,
    (r) => `flame team working through ${r}`,
    (r) => `putting the dead in ${r} to the torch. all of them`,
    (r) => `${r} cleared — burning what's left`,
    (r) => `incinerating remains in ${r}. don't let them lie`,
    (r) => `it's ugly work but ${r}'s bodies won't get back up`,
    (r) => `burn detail on ${r}. nothing rises from ash`,
  ],
  powerBack: [
    (r) => `power's coming back in ${r}`,
    (r) => `${r} just got mains power again`,
    (r) => `lights back up in ${r}`,
    (r) => `${r} is lit again — engineering came through`,
    (r) => `power restored to ${r}, we can see again`,
    (r) => `breakers reset — ${r} has lighting`,
  ],
  airClear: [
    (r) => `air's finally clearing in ${r}`,
    (r) => `the fog in ${r} is thinning out`,
    (r) => `scrubbers caught up — ${r} air is breathable`,
    (r) => `visibility improving in ${r}`,
    (r) => `${r} spore count dropping, masks stay ON`,
    (r) => `you can see across ${r} again`,
  ],
  armoryArms: [
    () => 'civilians drawing rifles off the racks — arming everyone who can hold one',
    () => 'racks are open — putting weapons in every pair of hands we have',
    () => 'handing out MA5s to the crew. everyone fights now',
    () => 'civilians are arming up off the racks. god help us',
    () => 'weapons free for all hands — the racks are stripped',
    () => 'every adult on this deck is carrying now. no more bystanders',
  ],
  coDown: [
    () => 'command net silent. the CO is down. say again — the CO is down',
    () => 'we lost the commander. CIC is not answering',
    () => 'the old man\'s channel just went dead. nobody is running this net now',
    () => 'be advised: command is gone. we are on our own',
    () => 'no more orders coming. the CO didn\'t make it',
    () => 'CIC has gone quiet. assume command casualties. hold where you are',
  ],
  cdrOrder: [
    (sq, r) => `squad ${sq}, push to ${r} — contact reported, sweep and clear`,
    (sq, r) => `squad ${sq}, this is actual — move to ${r} and engage`,
    (sq, r) => `re-tasking squad ${sq}: ${r}, weapons free`,
    (sq, r) => `squad ${sq}, we have a confirmed report at ${r}. take it back`,
    (sq, r) => `all units copy — squad ${sq} moves on ${r}`,
    (sq, r) => `squad ${sq}, ${r}, double-time. don't let it dig in`,
    (sq, r) => `squad ${sq}, break off and clear ${r} — report when done`,
    (sq, r) => `contact logged at ${r}. squad ${sq}, it's yours`,
  ],
  respond: [
    (r) => `we are responding to distress in ${r}`,
    (r) => `copy the mayday — moving to ${r} now`,
    (r) => `en route to ${r}, hold what you've got`,
    (r) => `we're coming to you — ${r}, two minutes`,
    (r) => `heard you, ${r}. we're on our way`,
    (r) => `moving to reinforce ${r}`,
    (r) => `${r}, help is coming — keep shooting`,
    (r) => `double-timing it to ${r}`,
    (r) => `on our way to ${r} — watch your crossfire when we come in`,
    (r) => `hang on ${r}, we are inbound`,
  ],
  confirmKill: [
    (r) => `making sure the downed one in ${r} stays down`,
    (r) => `double-tap on the body in ${r}. learned that the hard way`,
    (r) => `putting another burst in the one we dropped in ${r}`,
    (r) => `confirming the kill in ${r} — we don't take chances anymore`,
    (r) => `it doesn't get back up this time. ${r} secure`,
    (r) => `round in every body in ${r}. new policy`,
    (r) => `the one in ${r} won't be standing up again`,
    (r) => `securing the downed contact in ${r} before it decides otherwise`,
  ],
};
const say = (key, r) => { const p = VOICES[key]; return p[(Math.random() * p.length) | 0](r); };
function gameLogView(e) {
  const room = e.node >= 0 ? sim.graph.node(e.node).name : null;
  const throttle = (key, sec = 20) => {
    if (e.t - (_ominousAt[key] ?? -999) < sec) return false;
    _ominousAt[key] = e.t;
    return true;
  };
  const msg = e.msg;
  switch (e.type) {
    case 'hive': case 'carrier': case 'bait': case 'vent':
      return null; // the hive does not report to the bridge
    case 'init':
      return { ...e, spk: 'FLEETCOM' };
    case 'end':
      return e; // endgame banner, not radio
    case 'ambush': {
      const w = witnessNear(e.node);
      return room ? rx(e, w, say('ambush', room), { type: 'combat' }) : e;
    }
    case 'convert': {
      if (!room || !throttle('c' + e.node)) return null;
      const w = witnessNear(e.node);
      return rx(e, w, say(msg.includes('taken') ? 'taken' : 'strange', room));
    }
    case 'rampage': {
      if (!room || !throttle('m' + e.node, 15)) return null;
      const w = witnessNear(e.node);
      return rx(e, w, say('rampage', room), { type: 'combat' });
    }
    case 'revive': case 'reanimate': {
      if (!room || !throttle('r' + e.node)) return null;
      const w = witnessNear(e.node);
      return rx(e, w, say('revive', room));
    }
    case 'duct': {
      // someone has to be close enough to HEAR the ductwork, then transmit,
      // then you have to receive it
      const w = witnessNear(e.node);
      return rx(e, w, say('duct', room ?? 'my position'));
    }
    case 'combat': {
      if (msg.includes('(you)') || msg.startsWith('you ')) return e; // your own actions, no radio
      if (msg.startsWith('a marine falls')) {
        const w = witnessNear(e.node, (a) => a.faction === 2 || a.faction === 1);
        return rx(e, w, say('manDown', room ?? 'here'), { type: 'combat' });
      }
      if (msg.includes('arms up at the armory')) {
        return rx(e, odstSpeaker(), say('armoryArms'), { always: !sim.armoryLocked });
      }
      if (msg.includes('make sure of a downed form')) {
        // the confirm-kill habit, reported over the same unreliable net —
        // and throttled: a sweep through a room is one report, not five
        if (!throttle('k' + e.node, 25)) return null;
        const w = witnessNear(e.node, (a) => a.faction === 2);
        return rx(e, w, say('confirmKill', room ?? 'here'));
      }
      return e;
    }
    case 'burn': {
      const w = witnessNear(e.node, (a) => a.faction === 2);
      return rx(e, w, room ? say('burn', room) : msg);
    }
    case 'sweep': case 'morale': {
      const s = squadSpeaker(msg);
      return rx(e, s, msg, { type: e.type });
    }
    case 'radio': {
      if (msg.includes('(you)') || msg.startsWith('your fireteam') || msg.startsWith('fireteam:')) return e;
      if (msg.startsWith('ARMORY SEAL RELEASED')) {
        return rx(e, odstSpeaker(), 'armory seal released — ODST reserve deploying. racks are open', { always: true });
      }
      if (msg.startsWith('command net silent')) {
        // the whole net notices the command channel drop — always lands
        return rx(e, null, say('coDown'), { always: true, spk: 'NET' });
      }
      if (msg.startsWith('CDR orders')) {
        const m2 = msg.match(/^CDR orders squad (\d+) to (.+) — /);
        const cdr = sim.cdrId !== undefined ? sim.byId.get(sim.cdrId) : null;
        if (m2 && cdr) {
          const p = VOICES.cdrOrder;
          return rx(e, cdr, p[(Math.random() * p.length) | 0](m2[1], m2[2]));
        }
        return e;
      }
      if (msg.startsWith('distress call')) {
        const w = witnessNear(e.node);
        return rx(e, w, say('distress', room ?? 'here'), { type: 'combat' });
      }
      if (msg.startsWith('FALL BACK')) {
        // CIC all-hands broadcast — strong transmitter, but the same rules:
        // command deck is deck 1; if you're below and the net drops it, you
        // find out when the stragglers do
        const cic = { deck: 1, callsign: null };
        return rx(e, cic, msg.toLowerCase().replace('fall back', 'FALL BACK'), { spk: 'CIC' });
      }
      if (msg.includes('souls heard the call') || msg.includes('stragglers')) {
        return rx(e, { deck: 1 }, msg, { spk: 'CIC' });
      }
      if (msg.includes('missed a distress call')) return null; // non-receipt IS silence now
      if (msg.includes('word of the outbreak')) return null;   // omniscient narration
      if (msg.startsWith('squad') || msg.startsWith('patrol')) {
        const s = squadSpeaker(msg);
        const dm = msg.match(/responding to distress in (.+)$/);
        if (dm) return rx(e, s, say('respond', dm[1]));
        return rx(e, s, msg.replace(/^(squad|patrol) \d+ /, 'we are '));
      }
      if (msg.includes('spore fog') || msg.includes('power flickers')) {
        const w = witnessNear(e.node);
        return rx(e, w, say(msg.includes('power') ? 'powerBack' : 'airClear', room ?? 'this section'));
      }
      const w = e.node >= 0 ? witnessNear(e.node) : null;
      return w ? rx(e, w, msg) : e;
    }
    default:
      return e;
  }
}
function renderLog() {
  // no new events -> touch NOTHING (swarm finding: the scroll-metric reads
  // below force a synchronous reflow, and they ran every frame)
  if (lastEvent >= sim.events.length) return;
  const log = el('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let added = false;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  while (lastEvent < sim.events.length) {
    const raw = sim.events[lastEvent++];
    // PHYSICAL side-effects of raw events, independent of radio receipt:
    // blood marks where people are taken or fall, the 1MC PA for shipwide
    // orders (the speakers are in every compartment — no radio needed)
    if (raw.node >= 0 && (raw.type === 'convert' || (raw.type === 'combat' && raw.msg.startsWith('a marine falls')))) {
      const nd = sim.graph.node(raw.node);
      const [bx, bz] = world.simToWorld(nd.x, nd.y, nd.deck);
      blood.add(bx, bz, elevOf(nd.deck), lastEvent * 7919);
    }
    if (raw.type === 'radio' && (raw.msg.startsWith('FALL BACK') || raw.msg.startsWith('ARMORY SEAL'))) {
      audio.play('pa', null, 0.55, 'pa', 6000);
    }
    const e = gameLogView(raw);
    if (!e) continue;
    const div = document.createElement('div');
    div.className = `ev ev-${e.type}`;
    const spk = e.spk ? `<span class="spk">[${esc(e.spk)}]</span> ` : '';
    div.innerHTML = `<span class="t">${fmtTime(e.t)}</span> ${spk}${esc(e.msg)}`;
    log.appendChild(div);
    added = true;
    // the crackle of a transmission landing (not for FLEETCOM framing text)
    if (e.spk && e.spk !== 'FLEETCOM') audio.play('squelch', null, 0.22, 'squelch', 1400);
  }
  if (added) {
    while (log.childNodes.length > 400) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

// RETICLE NAMEPLATE (user): point at anyone — living crew, a corpse on the
// deck, or the combat form sprinting at you — and their rank+name floats
// above them. Conversions keep the host's callsign, so the thing wearing
// Pvt Jenkins still reads PVT JENKINS. Infection forms were never anyone.
const _npDir = new THREE.Vector3();
const _npVec = new THREE.Vector3();
const _npRay = new THREE.Raycaster();
let _npSticky = null; // hysteresis: the current target keeps a wider cone
let _npAt = 0; // target-selection throttle clock (swarm finding: the full
// agent scan + no-BVH triangle raycast ran every frame; ~15Hz is invisible
// with the sticky hysteresis, and the cached target reprojects every frame)
let _npBest = null;
function updateNameplate() {
  const np = el('nameplate');
  if (player.dead) { np.style.display = 'none'; return; }
  const nowNp = performance.now();
  if (nowNp - _npAt > 66) {
    _npAt = nowNp;
    _npBest = pickNameplateTarget();
    _npSticky = _npBest?.a ?? null;
  }
  const best = _npBest;
  if (!best || best.a.dead) { np.style.display = 'none'; return; }
  const a = best.a;
  _npVec.set(best.wx, best.labelY, best.wz).project(camera);
  if (_npVec.z > 1) { np.style.display = 'none'; return; }
  np.style.left = `${(_npVec.x * 0.5 + 0.5) * canvas.clientWidth}px`;
  np.style.top = `${Math.max(20, (-_npVec.y * 0.5 + 0.5) * canvas.clientHeight)}px`;
  np.className = a.faction === 4 || a.faction === 5 ? 'np-flood'
    : a.faction === 6 ? 'np-corpse'
      : a.faction === 2 || a.odst ? 'np-marine' : 'np-crew';
  np.textContent = `${a.callsign.rank} ${a.callsign.name}`.toUpperCase();
  np.style.display = 'block';
}
function pickNameplateTarget() {
  camera.getWorldDirection(_npDir);
  let best = null, bestScore = 1;
  for (const a of sim.agents) {
    if (a.isPlayer || !a.callsign || a.deck !== player.deck) continue;
    const low = a.faction === 6 || a.downed; // corpses and downed forms lie on the deck
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    // anchor on the actual surface underfoot (stair ring, raised launch
    // apron) — a flat deck elevation put plates inside raised floors
    const base = world.groundHeightAt(a.deck, wx, wz);
    _npVec.set(wx, base + (low ? 0.3 : 1.45), wz).sub(camera.position);
    const dist = _npVec.length();
    if (dist > 32 || dist < 0.4) continue;
    _npVec.divideScalar(dist);
    const err = Math.hypot(_npVec.x - _npDir.x, _npVec.y - _npDir.y, _npVec.z - _npDir.z);
    // the cone widens up close (a body fills the screen at arm's length):
    // accept ~0.7m of lateral miss at any range, floor ~5 degrees far out;
    // the target you already have holds on with a wider cone so a shuffling
    // marine at arm's length doesn't strobe the plate
    const cone = Math.max(0.09, 0.7 / dist) * (a === _npSticky ? 1.8 : 1);
    if (err < cone && err / cone < bestScore) {
      bestScore = err / cone;
      best = { a, wx, wz, dist, labelY: base + (low ? 0.6 : 2.05) };
    }
  }
  if (best) {
    // DIRECT LINE OF SIGHT ONLY (user rule): a wall between you and them
    // kills the plate. The far margin is razor-thin — a crewman hugging the
    // other side of a wall used to slip his chest point past a fat margin
    // and read through the plating. Closed door panels count as walls too.
    _npVec.set(best.wx, best.labelY - 0.6, best.wz).sub(camera.position).normalize();
    _npRay.set(camera.position, _npVec);
    _npRay.far = best.dist - 0.06;
    if (_npRay.intersectObjects(world.wallMeshes, false).length
      || _npRay.intersectObjects(world.doorPanelMeshes ?? [], false).length) best = null;
  }
  return best;
}

// debug: raycast from the camera in a direction, report what's hit
window.__probe = (dx, dy, dz) => {
  const rc = new THREE.Raycaster(camera.position.clone(), new THREE.Vector3(dx, dy, dz).normalize());
  rc.far = 40;
  const solids = scene.children.filter((o) => o.isMesh && !o.isInstancedMesh);
  return rc.intersectObjects(solids, false).slice(0, 5).map((h) => ({
    d: +h.distance.toFixed(2), type: h.object.type,
    col: h.object.material?.color?.getHexString?.(), vis: h.object.visible,
  }));
};
// perf instrumentation (headless harness + on-device debugging)
window.__perf = () => {
  let meshes = 0, lights = 0;
  scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) meshes++;
    if (o.isLight && (o.intensity ?? 0) > 0.01) lights++;
  });
  return {
    calls: renderer.info.render.drawCalls, tris: renderer.info.render.triangles,
    meshes, lights, pr: renderer.getPixelRatio(), rung,
    backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
  };
};

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  post.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// --- firing: MA5 events route into the sim's own damage model. Every shot
// is LOUD. Through-deck shots work when you and the target share an open
// vertical shaft's line ---
let fireHeld = false, reloadPressed = false, meleePressed = false;
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) fireHeld = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) fireHeld = false; });
let fragPressed = false;
let frags = FRAG.count;
window.addEventListener('keydown', (e) => {
  if (!introGone) return; // still on the briefing — keys only skip the typing
  if (e.code === 'KeyR') reloadPressed = true;
  if (e.code === 'KeyF') meleePressed = true;
  if (e.code === 'KeyG') fragPressed = true;
  if (e.code === 'KeyM') toggleMap();
  // AMMO ECONOMY (user): T hands a mag from your reserve to the neediest
  // fireteam marine in reach — they burn real magazines now (combat.js)
  if (e.code === 'KeyT' && !player.dead && weapon.reserve >= 32) {
    const took = sim.giveMag(player.agent);
    if (took) weapon.reserve -= 32;
  }
  // FIRETEAM ORDERS (review P1): the sim's command layer, on your keys
  if (!player.dead && player.locked) {
    if (e.code === 'Digit1') setOrder('follow');
    else if (e.code === 'Digit2') setOrder('hold');
    else if (e.code === 'Digit3') setOrder('advance');
  }
});

// the neediest fireteam marine in hand-off reach, throttled to ~3Hz —
// drives the "T — hand a mag" hint (ammo economy)
let _dryNear = null, _dryNearAt = 0;
function dryEscortName() {
  if (performance.now() - _dryNearAt > 300) {
    _dryNearAt = performance.now();
    _dryNear = null;
    let bd = Infinity;
    for (const id of fireteam.members) {
      const m = sim.byId.get(id);
      if (!m || m.dead || m.hp <= 0 || m.mags === undefined) continue;
      if (m.mags * 32 + m.rounds > 40) continue; // only when genuinely low
      if (m.deck !== player.agent.deck) continue;
      const d = Math.hypot(m.x - player.agent.x, m.y - player.agent.y);
      if (d > 3.5 || d >= bd) continue;
      bd = d;
      _dryNear = m.callsign ? `${m.callsign.rank} ${m.callsign.name}`.toUpperCase() : 'your marine';
    }
  }
  return _dryNear;
}

function setOrder(kind) {
  const lead = fireteam.members.map((id) => sim.byId.get(id)).find((m) => m && !m.dead);
  if (!lead) return;
  if (kind === 'follow') {
    fireteam.order = { kind: 'order:escort', entityId: player.agent.id };
    sim.log('radio', 'fireteam: on me');
  } else if (kind === 'hold') {
    fireteam.order = { kind: 'order:guard', node: lead.node };
    sim.log('radio', `fireteam: hold ${sim.graph.node(lead.node).name}`);
  } else {
    // advance: send them at the room you're looking at (ray to nearest room
    // center in your facing cone, this deck)
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    let best = -1, bestScore = Infinity;
    for (const n of sim.graph.nodes) {
      if (n.deck !== player.deck || n.idx === player.agent.node) continue;
      const [nx, nz] = world.simToWorld(n.x, n.y, n.deck);
      const dx = nx - player.x, dz = nz - player.z;
      const d = Math.hypot(dx, dz);
      if (d > 60) continue;
      const dot = (dx * fx + dz * fz) / (d || 1);
      if (dot < 0.55) continue;
      const score = d * (2 - dot);
      if (score < bestScore) { bestScore = score; best = n.idx; }
    }
    if (best !== -1) {
      fireteam.order = { kind: 'order:move', node: best };
      sim.log('radio', `fireteam: advance to ${sim.graph.node(best).name}`);
    }
  }
  el('order').textContent = `FIRETEAM: ${kind.toUpperCase()}`;
}

const _dir = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hit = new THREE.Vector3();
function shotCandidates() {
  // REAL SPACE (user note): every flood body on your deck is a candidate —
  // the wall raycast decides occlusion, not room-graph membership. This is
  // what makes a form ten meters into the hangar shootable the moment you
  // can see it, instead of only after its pathfinder "arrives". Plus the far
  // room of any open vertical shaft whose column you're standing in.
  const out = [];
  const trunk = world.trunkAt(player.deck, player.x, player.z);
  const shaftNode = trunk && trunk.vertical
    ? (player.deck === trunk.lowerDeck ? trunk.upperNode : trunk.lowerNode) : -1;
  // GRAND STAIRWELL (user: PoA stairs): standing in a stairwell room, the
  // other level is fair game — the opening is a real hole, and player shots
  // pass through floors anyway, so the wall raycast decides the rest.
  let stairNode = -1;
  for (const s of sim.graph.stairwells) {
    if (player.agent.node === s.upper) stairNode = s.lower;
    else if (player.agent.node === s.lower) stairNode = s.upper;
  }
  for (const a of sim.agents) {
    if (a.dead) continue;
    if (a.faction !== 3 && a.faction !== 4 && a.faction !== 5) continue;
    if (a.move && (a.move.layer === 'vent' || a.move.layer === 'shaft') && a.move.hidden) continue; // hidden mid-crawl only; a form at the grate IS a target
    if (a.deck === player.deck || (shaftNode !== -1 && a.node === shaftNode) || a.node === stairNode) out.push(a);
  }
  return out;
}

// real physics for shots (user note): a bullet stops at the nearest solid
// wall or CLOSED door before it ever reaches an agent standing behind it —
// no shooting through bulkheads. Doors mid-slide count as solid too.
function solidsForShot() {
  // door panels are two InstancedMeshes now — raycast hits any panel
  // (slid-open panels sit inside walls, which stop the ray themselves)
  return world.wallMeshes.concat(world.doorPanelMeshes ?? []);
}

function traceShot(offAng = 0, offRad = 0, maxDist = 100, dmg = MA5.damage) {
  camera.getWorldDirection(_dir);
  _rt.crossVectors(_dir, camera.up).normalize();
  _up.crossVectors(_rt, _dir).normalize();
  _dir.addScaledVector(_rt, Math.cos(offAng) * offRad)
    .addScaledVector(_up, Math.sin(offAng) * offRad).normalize();
  const origin = camera.position;

  wallRay.set(origin, _dir);
  wallRay.far = maxDist;
  wallRay.near = 0.05;
  const wallHits = wallRay.intersectObjects(solidsForShot(), false);
  const wallT = wallHits.length ? wallHits[0].distance : Infinity;

  let best = null, bestT = Math.min(maxDist, wallT);
  for (const a of shotCandidates()) {
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const cy = elevOf(a.deck) + (a.faction === 3 ? 0.35 : a.downed ? 0.35 : 0.9);
    _hit.set(wx, cy, wz).sub(origin);
    const t = _hit.dot(_dir);
    if (t < 0.05 || t > bestT) continue;
    const px = origin.x + _dir.x * t - wx, py = origin.y + _dir.y * t - cy, pz = origin.z + _dir.z * t - wz;
    const r = a.faction === 3 ? 0.5 : a.faction === 5 ? 1.0 : 0.7;
    if (px * px + py * py + pz * pz < r * r) { best = a; bestT = t; }
  }
  sim.gunfireAt(player.agent.node);
  const hitWallInstead = !best && wallT < maxDist;
  const travel = best ? bestT : (hitWallInstead ? wallT : Math.min(30, maxDist));
  const end = new THREE.Vector3().copy(origin).addScaledVector(_dir, travel);
  // the real muzzle tip (first-strike RIFLE_MUZZLE, carried through the
  // viewmodel's actual world transform) rather than an eyeball offset
  rifleMesh.updateWorldMatrix(true, false);
  const muzzle = RIFLE_MUZZLE.clone().applyMatrix4(rifleMesh.matrixWorld);
  agents.playerShot(muzzle, end);
  muzzleFlash.position.copy(muzzle);
  muzzleFlash.intensity = 8;
  if (best) {
    // parity (user rule): a combat form soaks the same fire from the player
    // as from any marine — its durability lives in the sim's hp, not in a
    // player-only multiplier
    hurtFloodForm(sim, best, dmg, false, player.agent.id);
    hitFlash = 1;
    audio.play('tick', null, 0.5, 'tick', 40);
  } else if (hitWallInstead) { wallSpark.position.copy(end); wallSpark.intensity = 6; }
  return !!best;
}

// --- grenades (review P1): a real lofted frag with bounces and a fuse.
// The blast goes through sim.explodeAt — walls contain it, corpses shred,
// the ship hears it, and survivors hold the grudge. ---
const liveFrags = [];
const fragGeo = new THREE.SphereGeometry(0.09, 8, 6);
const fragMat = new THREE.MeshStandardMaterial({ color: 0x39443a, roughness: 0.5, metalness: 0.6 });
const boomLight = { position: new THREE.Vector3(), intensity: 0 }; // virtual — global pool
let shake = 0;
let hitFlash = 0;
let dmgFlash = 0, dmgAngle = 0, lastSinceHit = 99;

function throwFrag() {
  if (frags <= 0 || player.dead || !player.locked) return;
  frags--;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const mesh = new THREE.Mesh(fragGeo, fragMat);
  const pose = player.cameraPose();
  mesh.position.set(pose.x + dir.x * 0.45, pose.y - 0.15, pose.z + dir.z * 0.45);
  scene.add(mesh);
  liveFrags.push({
    mesh,
    vx: dir.x * FRAG.throwSpeed, vy: dir.y * FRAG.throwSpeed + FRAG.upBoost, vz: dir.z * FRAG.throwSpeed,
    fuse: FRAG.fuseS, deck: player.deck,
  });
  audio.play('clack', null, 0.6);
}

const fragRay = new THREE.Raycaster();
function stepFrags(dt) {
  for (let i = liveFrags.length - 1; i >= 0; i--) {
    const f = liveFrags[i];
    f.vy -= FRAG.gravity * dt;
    const p = f.mesh.position;
    const nx = p.x + f.vx * dt, ny = p.y + f.vy * dt, nz = p.z + f.vz * dt;
    // wall bounce: cast along this frame's motion
    const mv = new THREE.Vector3(nx - p.x, ny - p.y, nz - p.z);
    const dist = mv.length();
    if (dist > 1e-6) {
      fragRay.set(p, mv.clone().normalize());
      fragRay.far = dist + 0.09;
      const hit = fragRay.intersectObjects(solidsForShot(), false)[0];
      if (hit) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const v = new THREE.Vector3(f.vx, f.vy, f.vz);
        v.sub(n.multiplyScalar(2 * v.dot(n))).multiplyScalar(FRAG.bounce);
        f.vx = v.x; f.vy = v.y; f.vz = v.z;
        audio.play('bounce', { x: p.x, z: p.z }, 0.7, 'bounce', 60);
      } else { p.set(nx, ny, nz); }
    }
    // floor bounce
    const floor = elevOf(f.deck) + 0.09;
    if (p.y < floor) {
      p.y = floor;
      if (Math.abs(f.vy) > 1.2) audio.play('bounce', { x: p.x, z: p.z }, 0.6, 'bounce', 60);
      f.vy = -f.vy * FRAG.bounce;
      f.vx *= 0.7; f.vz *= 0.7;
    }
    f.fuse -= dt;
    if (f.fuse <= 0) {
      const [sx, sy] = world.worldToSim(p.x, p.z, f.deck);
      sim.explodeAt(f.deck, sx, sy, FRAG.radiusM, FRAG.damage, player.agent.id);
      // tell the renderer where the blast landed so bodies it kills get thrown
      // and flail, and bodies already down get re-flung (cosmetic; render-only)
      agents.noteExplosion(f.deck, p.x, p.z, FRAG.radiusM);
      boomLight.position.set(p.x, elevOf(f.deck) + 1.2, p.z);
      boomLight.intensity = 60;
      shake = Math.min(1, shake + 1.2 / (1 + Math.hypot(p.x - player.x, p.z - player.z) / 6));
      audio.play('boom', { x: p.x, z: p.z }, 1.2);
      scene.remove(f.mesh);
      liveFrags.splice(i, 1);
      el('frags').textContent = `${frags} FRAG`;
    }
  }
}

// --- motion tracker (review P0): the classic 25 m sweep. Moving contacts
// only — hold still and you vanish from it, exactly like the games. ---
// UNRELIABLE (user rule: the radar lies like the comms do). It statics out
// about half the time in ragged windows, and it HALLUCINATES — brief phantom
// blips, friendly-yellow and hostile-red both, where nothing stands. You can
// never fully trust it: a clean sweep might be static, a red blip might be
// nothing, and the thing that kills you might never have painted.
const trk = el('tracker').getContext('2d');
const trkState = { static: false, until: 0, phantoms: [], nextPhantom: 0 };
function trackerUnreliability(now) {
  if (now >= trkState.until) {
    // ~50% duty cycle: ragged clear windows vs ragged static windows
    trkState.static = !trkState.static;
    trkState.until = now + (trkState.static ? 1200 + Math.random() * 3200 : 1400 + Math.random() * 3000);
  }
  // phantom contacts spawn mostly as a window flips (interference artifacts)
  if (now >= trkState.nextPhantom) {
    trkState.nextPhantom = now + 2600 + Math.random() * 5200;
    const n = 1 + (Math.random() < 0.3 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      trkState.phantoms.push({
        ang: Math.random() * Math.PI * 2,          // bearing in tracker space
        dist: 0.25 + Math.random() * 0.7,          // fraction of range
        hostile: Math.random() < 0.55,
        until: now + 400 + Math.random() * 1100,   // brief — then it's just gone
      });
    }
  }
  // a phantom doesn't just vanish — it FLICKERS OUT (user rule): a real
  // contact simply stops painting, but a ghost sputters and dissolves for
  // ~half a second, so only after the fact do you know it was never there
  const FLICKER_MS = 550;
  for (let i = trkState.phantoms.length - 1; i >= 0; i--) {
    if (now >= trkState.phantoms[i].until + FLICKER_MS) trkState.phantoms.splice(i, 1);
  }
}
function drawTracker(now) {
  const R = 75, RANGE = 25;
  trackerUnreliability(now);
  trk.clearRect(0, 0, 150, 150);
  trk.fillStyle = 'rgba(10,16,22,0.75)';
  trk.beginPath(); trk.arc(R, R, 74, 0, Math.PI * 2); trk.fill();
  if (!trkState.static) {
    trk.strokeStyle = 'rgba(110,160,210,0.35)';
    for (const rr of [25, 50, 74]) { trk.beginPath(); trk.arc(R, R, rr, 0, Math.PI * 2); trk.stroke(); }
  }
  if (trkState.static) {
    // the sweep is snow to the ENCLOSURE edge — and the rings themselves
    // glitch: jittered, broken arcs instead of clean circles (user rule)
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 75;
      const v = 120 + (Math.random() * 110) | 0;
      trk.fillStyle = `rgba(${v},${v + 15},${v + 25},${0.12 + Math.random() * 0.3})`;
      trk.fillRect(R + Math.cos(a) * rr, R + Math.sin(a) * rr, 1 + Math.random() * 2.4, 1 + Math.random() * 1.6);
    }
    trk.strokeStyle = 'rgba(110,160,210,0.3)';
    for (const rr of [25, 50, 74]) {
      // each ring becomes 5-8 broken arcs at slightly wrong radii
      const segs = 5 + (Math.random() * 4) | 0;
      for (let s = 0; s < segs; s++) {
        if (Math.random() < 0.35) continue; // dropout
        const a0 = Math.random() * Math.PI * 2;
        const jr = rr + (Math.random() - 0.5) * 5;
        trk.beginPath();
        trk.arc(R + (Math.random() - 0.5) * 2, R + (Math.random() - 0.5) * 2,
          Math.max(4, jr), a0, a0 + 0.3 + Math.random() * 0.9);
        trk.stroke();
      }
    }
    // occasional horizontal tear across the whole face
    if (Math.random() < 0.3) {
      const ty = Math.random() * 150;
      trk.fillStyle = 'rgba(160,190,220,0.18)';
      trk.fillRect(0, ty, 150, 1 + Math.random() * 2);
    }
    trk.fillStyle = '#cfe0ff';
    trk.beginPath(); trk.moveTo(R, R - 5); trk.lineTo(R - 4, R + 4); trk.lineTo(R + 4, R + 4); trk.fill();
    return;
  }
  const pov = player.dead ? ghostAlive() : player.agent;
  if (!pov) return;
  const [px, pz] = [player.x, player.z];
  // tracker basis = the player's ACTUAL forward/right vectors (user report:
  // radar inverted) — rotating the offset by -yaw only agreed with the
  // camera at yaw 0, because forward is (-sin, -cos), not (sin, cos)
  const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
  const rightX = Math.cos(player.yaw), rightZ = -Math.sin(player.yaw);
  const buf = sim.buffer;
  for (let i = 0; i < buf.count; i++) {
    if (buf.id[i] === player.agent.id) continue;
    const fbuf = buf.faction[i];
    if (fbuf === 6) continue;
    // MOVING CONTACTS ONLY (user rule): hold still and you vanish, exactly like
    // the real motion tracker. Keyed off actual position delta this sim tick,
    // NOT the anim clip — an agent can be mid-attack or ambushing and dead
    // still, and those should not paint.
    const moved = Math.hypot(buf.posX[i] - buf.prevX[i], buf.posY[i] - buf.prevY[i]);
    if (buf.animClip[i] === 4 || moved < 0.03) continue; // dead or not moving = invisible
    const deck = buf.posZ[i];
    if (Math.abs(deck - player.deck) > 1) continue;
    const [wx, wz] = world.simToWorld(buf.posX[i], buf.posY[i], deck);
    const dx = wx - px, dz = wz - pz;
    const d = Math.hypot(dx, dz);
    if (d > RANGE) continue;
    // project into tracker space: up = facing, right = your right hand
    const tx = R + ((dx * rightX + dz * rightZ) / RANGE) * 70;
    const ty = R - ((dx * fwdX + dz * fwdZ) / RANGE) * 70;
    const hostile = fbuf === 3 || fbuf === 4 || fbuf === 5;
    trk.fillStyle = hostile ? 'rgba(255,72,56,0.95)' : 'rgba(255,214,64,0.95)';
    if (deck === player.deck) {
      trk.beginPath(); trk.arc(tx, ty, 3.4, 0, Math.PI * 2); trk.fill();
    } else {
      trk.strokeStyle = trk.fillStyle;
      trk.beginPath(); trk.arc(tx, ty, 3.2, 0, Math.PI * 2); trk.stroke();
    }
  }
  // phantoms: drawn EXACTLY like real same-deck contacts while "alive" —
  // then they FLICKER OUT: sputtering alpha, jittering position, shrinking,
  // gone. The dissolve is the tell, and it only comes after the fact.
  for (const ph of trkState.phantoms) {
    let tx = R + Math.cos(ph.ang) * ph.dist * 70;
    let ty = R + Math.sin(ph.ang) * ph.dist * 70;
    let alpha = 0.95, rad = 3.4;
    if (now >= ph.until) {
      const p = (now - ph.until) / 550; // 0..1 through the die-off
      if (Math.sin(now * 0.09 + ph.ang * 7) < p * 1.6 - 0.4) continue; // sputter: skip frames, more as it dies
      alpha = 0.95 * (1 - p * 0.7);
      rad = 3.4 * (1 - p * 0.45);
      tx += (Math.random() - 0.5) * 3 * p; // breaking up
      ty += (Math.random() - 0.5) * 3 * p;
    }
    trk.fillStyle = ph.hostile ? `rgba(255,72,56,${alpha})` : `rgba(255,214,64,${alpha})`;
    trk.beginPath(); trk.arc(tx, ty, rad, 0, Math.PI * 2); trk.fill();
  }
  // faint interference flecks even when "clear" — the unit is never healthy
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 72;
    trk.fillStyle = `rgba(150,170,190,${0.05 + Math.random() * 0.1})`;
    trk.fillRect(R + Math.cos(a) * rr, R + Math.sin(a) * rr, 1.4, 1.2);
  }
  // you
  trk.fillStyle = '#cfe0ff';
  trk.beginPath(); trk.moveTo(R, R - 5); trk.lineTo(R - 4, R + 4); trk.lineTo(R + 4, R + 4); trk.fill();
}

// --- positional sound sweep: voice the sim's own senses ---
// REWORKED (user: constant bumping/banging from clustered NPCs made you mute
// it). The old sweep played a one-shot PER FIRING NODE per tick — a crowded
// fight was a wall of overlapping bangs, and adjacent-deck fire was a raw
// 'thud'. Now: same-deck gunfire is capped at the 3 NEAREST firing rooms,
// other decks collapse into ONE soft distant rumble, and the flood/human
// horror layer (growls, shrieks, gurgles, death screams) does the storytelling.
let chitterAt = 0, growlAt = 0, shriekAt = 0, gurgleAt = 0;
const _aliveHumans = new Map(); // id -> {x, y, deck} — for death screams
function soundSweep(now) {
  const g = sim.graph;
  // same-deck gunfire: nearest 3 firing rooms only, quieter with distance
  const firing = [];
  const offDeck = [];
  for (let n = 0; n < g.n; n++) {
    if (sim.tickCount - sim.gunfireTick[n] > 1 || sim.gunfireTick[n] < 5) continue;
    const nd = g.node(n);
    if (nd.deck === player.deck) {
      const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
      firing.push({ n, wx, wz, d: Math.hypot(wx - player.x, wz - player.z) });
    } else if (Math.abs(nd.deck - player.deck) <= 2) {
      const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
      offDeck.push({ n, wx, wz, dd: Math.abs(nd.deck - player.deck), d: Math.hypot(wx - player.x, wz - player.z) });
    }
  }
  firing.sort((a, b) => a.d - b.d);
  for (const f of firing.slice(0, 3)) audio.play('shotFar', { x: f.wx, z: f.wz }, 0.7, `gun${f.n}`, 220);
  // battles on other decks come DIRECTIONALLY through the hull now — dull
  // thump-bursts panned to the fight's bearing, muffled harder per deck of
  // steel (pairs with the radio net: no report may arrive, but you can still
  // HEAR where the fight is), over the low rumble in the deckplates
  offDeck.sort((a, b) => (a.dd * 100 + a.d) - (b.dd * 100 + b.d));
  for (const f of offDeck.slice(0, 2)) {
    audio.playFar('farFight', { x: f.wx, z: f.wz }, f.dd, 0.9, `far${f.n}`, 3400);
  }
  if (offDeck.length) audio.play('rumble', null, 0.09, 'offdeck', 2600);
  for (let n = 0; n < g.n; n++) {
    if (sim.tickCount - sim.screamTick[n] > 1 || sim.screamTick[n] < 5) continue;
    const nd = g.node(n);
    const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
    if (nd.deck === player.deck) {
      audio.play('scream', { x: wx, z: wz }, 0.7, `scr${n}`, 700);
    } else if (Math.abs(nd.deck - player.deck) === 1) {
      // someone dying one deck away — a faint cry through the plating
      audio.playFar('deathScream', { x: wx, z: wz }, 1, 0.5, `fscr${n}`, 4000);
    }
  }
  // --- flood proximity (user: flood sounds and screams when they are nearby) ---
  let nearCombat = null, nearCarrier = null, charging = null;
  for (const a of sim.agents) {
    if (a.dead || a.deck !== player.deck) continue;
    if (a.faction !== 3 && a.faction !== 4 && a.faction !== 5) continue;
    if (a.move?.hidden) continue; // in the ducts — heard via duct log, not here
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const d = Math.hypot(wx - player.x, wz - player.z);
    if (a.faction === 3 && d < 18 && now - chitterAt > 900) { audio.play('chitter', { x: wx, z: wz }, 0.8); chitterAt = now; }
    if (a.faction === 4) {
      if (!nearCombat || d < nearCombat.d) nearCombat = { wx, wz, d };
      if (a.charging && d < 26 && (!charging || d < charging.d)) charging = { wx, wz, d };
    }
    if (a.faction === 5 && (!nearCarrier || d < nearCarrier.d)) nearCarrier = { wx, wz, d };
  }
  if (nearCombat && nearCombat.d < 22 && now - growlAt > 2600 + Math.random() * 2200) {
    audio.play('growl', { x: nearCombat.wx, z: nearCombat.wz }, 0.9);
    growlAt = now;
  }
  if (charging && now - shriekAt > 1800) { // it's coming — you HEAR it commit
    audio.play('shriek', { x: charging.wx, z: charging.wz }, 1.0);
    shriekAt = now;
  }
  if (nearCarrier && nearCarrier.d < 16 && now - gurgleAt > 3200 + Math.random() * 2500) {
    audio.play('gurgle', { x: nearCarrier.wx, z: nearCarrier.wz }, 0.9);
    gurgleAt = now;
  }
  // --- human death screams (user: human screams when they die and you're close) ---
  for (const a of sim.agents) {
    const isHuman = a.faction === 0 || a.faction === 1 || a.faction === 2;
    const alive = isHuman && !a.dead && a.hp > 0 && !a.downed;
    const was = _aliveHumans.get(a.id);
    if (alive) {
      // mutate in place (swarm finding: a fresh record per human per sweep
      // was ~9k short-lived objects a second)
      if (was) { was.x = a.x; was.y = a.y; was.deck = a.deck; }
      else _aliveHumans.set(a.id, { x: a.x, y: a.y, deck: a.deck });
    } else if (was) {
      _aliveHumans.delete(a.id);
      if (!a.isPlayer && Math.abs(was.deck - player.deck) <= 1) {
        const [wx, wz] = world.simToWorld(was.x, was.y, was.deck);
        const d = Math.hypot(wx - player.x, wz - player.z);
        if (d < 30) audio.play('deathScream', { x: wx, z: wz }, was.deck === player.deck ? 0.95 : 0.5, 'death', 350);
      }
    }
  }
  // fire crackle from the nearest burning site
  const nf = fire.nearest(player.x, player.z, elevOf(player.deck));
  if (nf && nf.d < 17) audio.play('crackle', { x: nf.x, z: nf.z }, 0.85, 'crackle', 420);
  // door hisses — ONLY nearby doors, and sparsely (user: random bumping
  // around NPC clusters — this was every door any NPC tripped, ship-wide on
  // your deck, on a 120ms global throttle = constant knocking)
  for (const ev of world.doorEvents) {
    if (ev.deck !== player.deck) continue;
    if (Math.hypot(ev.x - player.x, ev.z - player.z) > 18) continue;
    audio.play('door', { x: ev.x, z: ev.z }, 0.5, 'door', 600);
  }
  world.doorEvents.length = 0;
}

// obstacle set for the player's capsule: live, standing bodies on the player's
// deck (dead/downed/other-deck don't block). Radii mirror the old separation
// pass. Handed to the physics world each fixed step.
// pooled like doorMovers (swarm finding: a fresh array + record per agent at
// 60Hz was measurable GC churn on the physics path)
const _obstacleR = { 3: 0.32, 4: 0.48, 5: 0.75 };
const _obstacleRecs = [];
let _obstacleN = 0;
let _obstacleKey = -1;
function playerObstacles() {
  const cy = elevOf(player.deck) + 0.9;
  let n = 0;
  for (const a of sim.agents) {
    if (a.dead || a.isPlayer || a.deck !== player.deck) continue;
    if (a.faction === 6 || a.downed || a.hp <= 0) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const r = _obstacleRecs[n] ?? (_obstacleRecs[n] = { id: 0, x: 0, y: 0, z: 0, radius: 0.4, half: 0.5 });
    r.id = a.id; r.x = wx; r.y = cy; r.z = wz; r.radius = _obstacleR[a.faction] ?? 0.4;
    n++;
  }
  _obstacleN = n;
  return _obstacleRecs;
}

// --- main loop ---
let frameNo = 0;
let physAcc = 0;
let _trackerAt = 0, _observeAt = 0, _sweepAt = 0; // subsystem throttle clocks (perf pass 2)
let _smYaw = 0, _smPitch = 0, _bobPhase = 0, _bobAmp = 0; // viewmodel sway/bob (first-strike feel)
let _fpsEma = 16.7, _fpsWorst = 0, _fpsShownAt = 0; // top-right perf readout
// sim ticks run OUTSIDE the rAF task (engine/runtime.js TickScheduler):
// the browser executes them in the idle gap between vsyncs
const ticker = new TickScheduler({ stepSec: sim.dt, run: () => sim.tick() });
let shownLost = false;
let spectateShown = false;
let last = performance.now();
const doorMovers = [];
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  // fixed-timestep player physics: step the Rapier world in whole PHYS_DT
  // increments (deterministic — replay/lockstep depend on it), letting the
  // camera interpolate the remainder. Bodies are re-synced each step so the
  // capsule collides with live NPCs.
  physAcc += dtReal;
  let alpha = 0;
  if (physics) {
    let pSteps = 0;
    while (physAcc >= PHYS_DT && pSteps++ < 6) {
      // obstacle positions come from raw sim state, which only changes on the
      // 15Hz sim tick (or when the player changes decks) — skip the whole
      // JS→wasm re-sync on the other ~45 physics steps a second
      const obsKey = sim.tickCount * 8 + player.deck;
      if (obsKey !== _obstacleKey) {
        _obstacleKey = obsKey;
        physics.syncBodies(playerObstacles(), _obstacleN);
      }
      player.step(PHYS_DT);
      physics.step();
      physAcc -= PHYS_DT;
    }
    if (pSteps >= 6) physAcc = 0; // don't spiral if a frame stalls
    alpha = physAcc / PHYS_DT;
  }

  // MA5 loop (auto fire, bloom, reload, melee) — pure mechanics, events out
  const wevents = [];
  weapon.step(dtReal, {
    fireHeld: fireHeld && player.locked && !player.dead,
    reloadPressed, meleePressed,
  }, wevents);
  reloadPressed = false; meleePressed = false;
  for (const ev of wevents) {
    if (ev.t === 'fire') { traceShot(ev.offAng, ev.offRad); audio.play('shot', null, 0.9); }
    else if (ev.t === 'melee_hit') { traceShot(0, 0, MA5.meleeRange, MA5.meleeDamage); audio.play('thud', null, 0.8); }
    else if (ev.t === 'reload_start') audio.play('clack', null, 0.7);
    else if (ev.t === 'dry') audio.play('clack', null, 0.4);
  }
  if (fragPressed) { throwFrag(); fragPressed = false; el('frags').textContent = `${frags} FRAG`; }
  stepFrags(dtReal);
  boomLight.intensity *= Math.exp(-7 * dtReal);
  muzzleFlash.intensity *= Math.exp(-14 * dtReal);
  wallSpark.intensity *= Math.exp(-10 * dtReal);
  // VIEWMODEL KINEMATICS (ported from first-strike — user: the gun reads
  // better there): aim-lag sway from smoothed yaw/pitch, walk bob sharing
  // the head-bob phase, a real reload TILT (the barrel dips through an
  // arc instead of the whole gun sinking), and the melee swing composed
  // into translation + rotation.
  {
    const sBlend = 1 - Math.exp(-14 * dtReal);
    _smYaw += (player.yaw - _smYaw) * sBlend;
    _smPitch += (player.pitch - _smPitch) * sBlend;
    const swayX = Math.max(-0.06, Math.min(0.06, (_smYaw - player.yaw) * 0.35));
    const swayY = Math.max(-0.05, Math.min(0.05, (_smPitch - player.pitch) * 0.3));
    const groundSpeed = Math.hypot(player.vx, player.vz);
    const speed01 = Math.max(0, Math.min(1, groundSpeed / ODST.sprintSpeed));
    _bobAmp += ((player.onGround ? speed01 : 0) - _bobAmp) * (1 - Math.exp(-8 * dtReal));
    _bobPhase += dtReal * 9 * speed01 * (player.onGround ? 1 : 0);
    const gunBobY = Math.sin(_bobPhase * 2) * 0.012 * _bobAmp;
    let tilt = 0;
    if (weapon.reloading) {
      const ph = 1 - weapon.reloadT / weapon.def.reloadS;
      tilt = -0.85 * Math.sin(Math.min(ph * Math.PI, Math.PI));
    }
    const meleeSwing = weapon.meleeT > 0 ? Math.sin((1 - weapon.meleeT / weapon.meleeDuration) * Math.PI) : 0;
    viewmodel.position.x = GUN_TUNE.x + swayX - meleeSwing * 0.07;
    viewmodel.position.y = GUN_TUNE.y + swayY + gunBobY + meleeSwing * 0.3;
    viewmodel.position.z = -GUN_TUNE.z + weapon.recoil * 1.6;
    viewmodel.rotation.x = GUN_TUNE.rx + weapon.recoil * 2 + meleeSwing * 0.95 - tilt;
    viewmodel.rotation.y = GUN_TUNE.ry + meleeSwing * 0.08;
    viewmodel.rotation.z = GUN_TUNE.rz - meleeSwing * 0.08;
  }
  // reticle bloom (first-strike CE reticle): arc radius tracks true spread
  {
    const spreadRad = weapon.spreadDeg * Math.PI / 180;
    const focal = 0.5 * (canvas.clientHeight || 720) / Math.tan((72 * Math.PI / 180) / 2);
    const sp = `${(Math.tan(spreadRad) * focal).toFixed(1)}px`;
    if (_hudCache['xh:sp'] !== sp) {
      _hudCache['xh:sp'] = sp;
      el('crosshair').style.setProperty('--sp', sp);
    }
  }

  ticker.add(dtReal); // due sim ticks run between vsyncs, never on the frame

  agents.viewX = player.x; agents.viewZ = player.z; // fog-exact stamp culling
  agents.update(dtReal);
  // the sweep voices 10-15Hz sim data; every one-shot has a >=220ms throttle
  // window, so scanning at 15Hz instead of every frame is inaudible (swarm)
  if (now - _sweepAt > 66) { _sweepAt = now; soundSweep(now); }
  // subsystem throttles (perf pass 2): a 25m sweep display reads perfectly
  // at 20Hz, and the ops board's intel accumulates fine at 6Hz — neither
  // needs to burn canvas/agent-scan time every frame
  if (now - _trackerAt > 50) { _trackerAt = now; drawTracker(now); }
  if (now - _observeAt > 160) { _observeAt = now; marineMap.observe(); }
  if (mapOpen) marineMap.draw(player.agent, player.dead);
  audio.setListener(player.x, player.z, player.yaw);
  audio.alarm(sim.lastStand && !ended);
  if (sim.lastStand && !window._paLastStand) { window._paLastStand = true; audio.play('pa', null, 0.6); }
  audio.startAmbience(); // no-op until the AudioContext exists (first click)
  audio.ambienceTick();

  // ALARM + POWER STATES (review P2 slice): the last stand turns the ship's
  // light red and pulsing; an unpowered compartment flickers your lamp
  const hemiPulse = sim.lastStand ? (Math.sin(now * 0.004) + 1) / 2 : 0;
  hemi.color.setRGB(0.62 + hemiPulse * 0.35, 0.70 - hemiPulse * 0.4, 0.82 - hemiPulse * 0.55);
  // seeded room lighting: your lamp follows the room fixture's state, so a
  // faulty compartment strobes around you and a dead one goes near-black
  world.updateLights(now * 0.001);
  world.updateDarkness(sim, player.agent.node, dtReal);
  // TOTAL DARKNESS (user rule): an unlit room — flood-darkened OR just a dead
  // fixture — has NO ambient wash at all. The only light is what actually
  // emits: your flashlight, the red emergency lamps over the hatches, fire,
  // and gunfire.
  const inDark = sim.darkAt(player.agent.node) || world.lightLevel(player.agent.node) <= 0.1;
  const inFog = sim.fogAt(player.agent.node);
  // FLOOD DARKNESS (user rule): inside a held room the world's light dies —
  // your flashlight is all that works. Spore fog closes the flashlight's
  // throw down to a few meters and stains the air green-brown.
  const dimT = Math.min(1, dtReal * 3);
  // DEAD SHIP (user rule): NO ambient wash at all, ever — a bright visible
  // ceiling kills the horror. A hair of structural floor stops pure-black
  // banding; every visible photon comes from discrete sources: the fixture
  // pool, the red hatch lamps, doorway spill, fires, muzzles, your torch.
  // lit rooms keep a LOW structural floor (~3x darker than the old wash —
  // ceilings stay dark, fixtures carry the light); flood-dark and dead
  // rooms stay at absolute zero, torch-only (user: pitch-black regression
  // after the first darkness pass over-crushed LIT compartments too)
  const ambTarget = inDark ? 0.0 : 0.1;
  const hemiTarget = inDark ? 0.0 : 0.12;
  ambient.intensity += (ambTarget - ambient.intensity) * dimT;
  hemi.intensity += (hemiTarget - hemi.intensity) * dimT;
  lamp.intensity = inDark ? 0.0 : 4.5 * (0.3 + 0.7 * world.lightLevel(player.agent.node));
  torch.intensity += ((inDark ? 95 : 60) - torch.intensity) * dimT;
  torch.distance = inFog ? sim.P.darkness.fogViewM + 2 : 30;
  {
    const tp = player.cameraPose();
    const tdir = new THREE.Vector3();
    camera.getWorldDirection(tdir);
    torch.position.set(tp.x, tp.y - 0.1, tp.z);
    torchTarget.position.set(tp.x + tdir.x * 10, tp.y + tdir.y * 10, tp.z + tdir.z * 10);
  }
  // fog wall: global exponential-ish fog closes in inside a spore room
  const fogTarget = inFog ? sim.P.darkness.fogViewM + 3 : inDark ? 34 : 60;
  scene.fog.far += (fogTarget - scene.fog.far) * dimT;
  scene.fog.near = inFog ? 1.5 : 18;
  scene.fog.color.setHex(inFog ? 0x1c2410 : 0x05070a);
  scene.background.setHex(inFog ? 0x151b0a : 0x05070a);
  // volume-scoped rendering (user: don't draw the whole ship): decks beyond
  // ±1 and fore/aft thirds beyond full fog are hidden — both pixel-exact
  world.setActiveVolume(player.deck, player.x);
  lightPool.frame(); // all dynamic sources re-declare below
  syncBurnFires();
  fire.update(dtReal, player.x, player.z);
  sparks.update(dtReal, now / 1000, player.x, player.z);
  updateMotes(dtReal);
  updateRoomLightPool();
  updateDoorSpill();
  updateMuzzleLights();
  lightPool.commit(player.x, player.z);
  // EXPOSURE GRADE (user: the fog dimming should be very good): the camera
  // itself stops down in murk — fog crushes the frame, plain darkness dims
  // it, clean compartments read bright. Slow lerp so it feels like eyes
  // adjusting, not a switch.
  {
    const expTarget = inFog ? 0.9 : inDark ? 1.12 : 1.35;
    post.exposure += (expTarget - post.exposure) * Math.min(1, dtReal * 1.6);
    // IBL never lights a black room — it fades with the ambient state
    scene.environmentIntensity = 0.08 * (ambient.intensity / 0.06);
  }

  // hit feedback fades
  if (hitFlash > 0) { hitFlash = Math.max(0, hitFlash - dtReal * 5); el('hitmarker').style.opacity = hitFlash.toFixed(2); }
  // directional damage: the moment armor takes a hit, point at the attacker
  if (player.sinceHit < lastSinceHit) {
    const src2 = sim.byId.get(player.agent.lastHurtBy);
    if (src2 && !src2.dead) {
      const [ax, az] = world.simToWorld(src2.x, src2.y, src2.deck);
      const bearing = Math.atan2(ax - player.x, -(az - player.z));
      dmgAngle = bearing + player.yaw;
      dmgFlash = 1;
      // (the per-hit 'thud' is GONE — user: the constant banging in a brawl
      // made you mute the game. The damage flash + growls carry the hit.)
    } else dmgFlash = 1;
  }
  lastSinceHit = player.sinceHit;
  if (dmgFlash > 0) {
    dmgFlash = Math.max(0, dmgFlash - dtReal * 1.6);
    const dd = el('dmgdir');
    dd.style.opacity = dmgFlash.toFixed(2);
    dd.style.transform = `rotate(${(-dmgAngle * 180 / Math.PI).toFixed(1)}deg)`;
  }
  shake = Math.max(0, shake - dtReal * 3);

  // sliding doors open for ANY movement near them (user rule) — mover
  // records come from a reused pool (perf pass 2: ~200 object literals per
  // frame was measurable GC churn)
  let nMovers = 0;
  const takeMover = () => doorMovers[nMovers] ?? (doorMovers[nMovers] = { deck: 0, x: 0, z: 0 });
  { const m = takeMover(); m.deck = player.deck; m.x = player.x; m.z = player.z; nMovers++; }
  const buf = sim.buffer;
  for (let i = 0; i < buf.count; i++) {
    if (buf.faction[i] === 6) continue; // the dead don't trip doors
    const deck = buf.posZ[i];
    const [wx, wz] = world.simToWorld(buf.posX[i], buf.posY[i], deck);
    const m = takeMover();
    m.deck = deck; m.x = wx; m.z = wz;
    nMovers++;
  }
  world.updateDoors(dtReal, doorMovers, nMovers);

  // camera: your eyes — or the eyes of what you became
  const ghost = player.dead ? ghostAlive() : null;
  if (ghost) {
    const [gx, gz] = world.simToWorld(ghost.x, ghost.y, ghost.deck);
    const gy = elevOf(ghost.deck) + (ghost.downed ? 0.45 : 1.5);
    camera.position.set(gx, gy, gz);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(Math.atan2(-Math.cos(ghost.heading), -Math.sin(ghost.heading)));
    lamp.position.set(gx, gy + 0.2, gz);
    viewmodel.visible = false;
  } else {
    const pose = player.renderPose(alpha);
    // head bob (first-strike feel): shares the viewmodel's bob phase
    camera.position.set(pose.x, pose.y + Math.sin(_bobPhase * 2) * 0.02 * _bobAmp, pose.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(pose.yaw + (shake > 0 ? Math.sin(now * 0.09) * 0.02 * shake : 0));
    camera.rotateX(pose.pitch + (shake > 0 ? Math.sin(now * 0.11) * 0.018 * shake : 0));
    lamp.position.set(pose.x, pose.y + 0.2, pose.z);
    viewmodel.visible = !player.dead;
  }

  // HUD — dirty-checked: unconditional textContent/style writes every frame
  // force style recalc even when nothing changed (part of the M2 stutter)
  setText('clock', fmtTime(sim.t));
  const povAgent = ghost ?? player.agent;
  const room = sim.graph.node(povAgent.node);
  setText('room', room ? room.name : '—');
  setText('deckLabel', `DECK ${povAgent.deck}`);
  const hp = Math.max(0, Math.ceil(povAgent.hp));
  setStyle('healthBar', 'width', `${ghost ? hp / 63 * 100 : hp / 45 * 100}%`);
  setStyle('armorBar', 'width', `${ghost ? 0 : player.armor / 50 * 100}%`);
  setText('hpText', ghost ? `IT ${hp}` : `${Math.ceil(player.armor)} | ${hp}`);
  setText('ammo', ghost ? '' : (weapon.reloading ? 'RELOADING' : `${weapon.mag} / ${weapon.reserve}`));
  // ROOM LIGHT STATE (user: note-taking between playthroughs) — the sim's
  // authoritative fixture + flood states for the compartment you're in
  {
    const rs = el('roomState');
    const ni = povAgent.node;
    if (ni >= 0) {
      const lm = sim.graph.lightMode[ni];
      const dead = lm === 3 || sim.darkAt(ni);
      const label = sim.darkAt(ni) ? 'FLOOD DARK'
        : ['LIGHTS STEADY', 'SOFT FLICKER', 'HARSH FLICKER', 'LIGHTS DEAD'][lm];
      const extras = [
        sim.fogAt(ni) ? 'SPORE FOG' : null,
        sim.graph.unpowered[ni] ? 'UNPOWERED' : null,
      ].filter(Boolean);
      setText('roomState', extras.length ? `${label} · ${extras.join(' · ')}` : label);
      const rc = dead ? 'rs-dead' : lm === 2 ? 'rs-harsh' : lm === 1 ? 'rs-soft' : 'rs-steady';
      if (rs.className !== rc) rs.className = rc;
    } else setText('roomState', '—');
  }
  rifleMesh.userData.setAmmoDigits?.(weapon.mag);
  const src = player.dead ? null : player.ammoSource();
  if (src) {
    setText('hint', src === 'armory'
      ? `E — strip mags from the rack (${sim.armoryStock} rifles)` : 'E — take mags off the dead');
    setStyle('hint', 'display', 'block');
  } else if (player.climb) {
    setText('hint', player.climb.toDeck < player.climb.fromDeck ? 'climbing up…' : 'climbing down…');
    setStyle('hint', 'display', 'block');
  } else if (!player.dead && weapon.reserve >= 32 && dryEscortName()) {
    setText('hint', `T — hand a mag to ${dryEscortName()}`);
    setStyle('hint', 'display', 'block');
  } else {
    const trunk = player.dead ? null : world.trunkAt(player.deck, player.x, player.z);
    if (trunk) {
      const up = player.deck === trunk.lowerDeck;
      const kind = trunk.vertical ? 'ladder' : 'stairs';
      setText('hint', player.queuedTrunk === trunk
        ? 'in line for the ladder — you go next'
        : trunk.edge?.type === 'ladder' && sim.vertBusy(trunk.edge, player.agent.id)
          ? `${kind} busy — L to take the next slot`
          : `L — climb ${kind} ${up ? 'up' : 'down'} to deck ${up ? trunk.upperDeck : trunk.lowerDeck}`);
      setStyle('hint', 'display', 'block');
    } else setStyle('hint', 'display', 'none');
  }
  setStyle('pinned', 'display', player.pinned && !player.dead ? 'block' : 'none');
  renderLog();
  updateNameplate();

  if (player.dead && ghost) {
    if (!spectateShown) {
      spectateShown = true;
      endScreen('YOU WERE TAKEN',
        'It is wearing you now. You can see — but it is not you moving. A player taken never seeds a carrier; it fights until it is put down.', false);
    }
  } else if (player.dead) {
    endScreen(sim.playerConvertedTo ? 'PUT DOWN' : 'KIA',
      sim.playerConvertedTo
        ? 'What was left of you is finally still.'
        : 'The ship fights on without you. The last thing you hear is the hive, singing.');
  } else if (sim.outcome === 'contained') {
    endScreen('OUTBREAK CONTAINED', 'The marines burned it out. The Saturn Devouring survives.');
  } else if (!ended && !shownLost && sim.tickCount % 30 === 0) {
    const othersAlive = sim.agents.some((a) => !a.dead && a.hp > 0 && !a.isPlayer
      && (a.faction === 0 || a.faction === 1 || a.faction === 2));
    if (!othersAlive) {
      shownLost = true;
      endScreen('THE SATURN DEVOURING IS LOST', 'Every other soul aboard is gone. You are alone with it now.', false);
    }
  }

  // quality ladder: resolution walk + rung descend/ascend live in the
  // engine governor now (engine/runtime.js) — per-rung effects still land
  // through this game's apply callback above
  governor.frame(now, dtReal, window.innerWidth, window.innerHeight);

  // PERF READOUT (user: benchmark across hardware) — live FPS + frame ms +
  // a slow-decaying worst spike + resolution/rung/backend, top right under
  // the room state. Refreshed at 4Hz, dirty-checked.
  {
    const ms = dtReal * 1000;
    _fpsEma = _fpsEma * 0.92 + Math.min(200, ms) * 0.08;
    if (ms > _fpsWorst) _fpsWorst = ms;
    if (now - _fpsShownAt > 250) {
      _fpsShownAt = now;
      const fps = Math.round(1000 / _fpsEma);
      const cls = fps >= 55 ? 'fps-good' : fps >= 30 ? 'fps-mid' : 'fps-bad';
      const html = `<b>${fps} FPS</b> · ${_fpsEma.toFixed(1)}ms · spike ${_fpsWorst.toFixed(0)}ms`
        + ` · ${renderer.getPixelRatio().toFixed(2)}x · r${rung}`
        + ` · ${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2'}`;
      const meter = el('fpsMeter');
      if (meter.className !== cls) meter.className = cls;
      if (_hudCache.fpsMeter !== html) { _hudCache.fpsMeter = html; meter.innerHTML = html; }
      _fpsWorst *= 0.55; // spikes linger a couple of seconds, then fade
    }
  }
  if (renderer.shadowMap.enabled && (frameNo & 1) === 0) torch.shadow.needsUpdate = true; // 30Hz shadows
  frameNo++;
  renderer.info.reset(); // per-frame accumulation across all post passes
  post.render(scene, camera, now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug hooks
window.__game = { sim, world, player, agents, weapon, camera, scene, renderer };
