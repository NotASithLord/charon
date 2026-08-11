// HALO CHARON — 3D slice (docs/ROADMAP-3D.md): an ODST with a fireteam,
// dropped into the ship while the FULL simulation plays out around them.
// Mechanics layer ported from the first-strike vertical slice (MA5 loop,
// armor-over-health, movement feel). The sim is untouched and authoritative.

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { Sim, fmtTime } from '../sim/sim.js';
import { combatMeleeImpulse, hurtFloodForm } from '../sim/combat.js';
import { World, elevOf, DOOR_W } from './world.js';
import { Agents3D } from './agents3d.js';
import { Player } from './player.js';
import { HeldWeapon, FlameThrower } from './weapon.js';
import { MA5, FRAG, ODST } from './fps-data.js';
import { GameAudio } from './audio.js';
import { FireFX, SparkFX, BloodFX, FlameJetFX } from '../engine/fx.js';
import { MarineMap } from './map.js';
import { RNG } from '../shared/rng.js';
import {
  buildRifleViewmodel, GUN_TUNE, RIFLE_MUZZLE,
  buildFlamerViewmodel, FLAMER_TUNE,
} from './rifle-model.js';
import { PhysicsWorld, initRapier, PHYS_DT } from '../engine/physics/physics-world.js';
import { PostFX } from '../engine/post.js';
import { LightPool } from '../engine/lights.js';
import { createRenderer, installDeviceLostReload, QualityGovernor, TickScheduler } from '../engine/runtime.js';
import { createGameSync } from '../multiplayer/game-sync.js';

const canvas = document.getElementById('c');
// PERF (user: unusable frame rate on an M4 Air): MSAA off — the post chain
// makes canvas MSAA pure waste (FXAA in the grade handles edges) — and the
// pixel ratio caps at 1.25 instead of 2. Retina pr2 was rendering ~4M px
// through the 5-pass HDR pipeline × every light × PCFSoft; at 1.25 + FXAA +
// grain + bloom the difference on a laptop panel is imperceptible and the
// fragment bill drops ~2.6x. `?hd=1` opts back into full resolution;
// `?q=low` / `?q=full` pin the quality ladder (see RUNGS below).
const QP = new URLSearchParams(location.search);
const LAUNCH = globalThis.__charonLaunch ?? { mode: 'solo', session: null };
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
// 16 slots so the top rungs can afford real weapon lights alongside the room
// fixtures (user: an M2 in Chrome has GPU headroom, spend it on realism). The
// governor shrinks the live count per rung — setActive REMOVES lights from the
// scene, which shortens the light loop compiled into every shader — so the
// lower rungs land at or below the old budget.
const lightPool = new LightPool(scene, 16);
// Real spotlights for the weapon lights. SEVEN of them at the top rungs — a
// fireteam plus stragglers — because a POINT light cannot have a heading, and
// heading is the entire request ("i dont see the direction of the wall hes
// looking at illuminated. I want different illuminated spots coming from
// their heading"). Isolating the two kinds side by side in a blacked-out CIC
// settled it: five spotlights alone gave crisp discs on the exact bulkheads
// the men were facing with everything else at zero, while just TWO of the
// pooled point blobs lit the whole compartment — ceiling, deck, all four
// walls — because a sphere of light radiates into every surface it can see.
// So the spot count went up and the blobs went away as the primary; only the
// overflow past the spot budget still gets one, and only as a small disc.
// They deliberately do NOT cast shadows; only your own torch does.
//
// DECAY 2 IS THE OTHER HALF (user: "i dont think a cone is realistic at
// all... what is it reflecting off of?"). The first pass used decay 1.6 over
// a 28-degree cone, which is a soft even wash: every surface in the room came
// back at roughly the same brightness, so nothing read as a beam LANDING on
// anything. True inverse-square plus a tighter cone means the footprint is
// hot at its centre, falls off hard across the room, and the geometry inside
// it is picked out by N.L instead of flattened.
const TEAM_TORCH_HEX = 0xe2ecff;   // a shade cooler than yours (0xeaf2ff) — same lamp family, tellable apart
const TEAM_TORCH_CD = 560;         // candela; a tighter reflector concentrates the same lumens
const teamTorches = Array.from({ length: 7 }, () => {
  const L = new THREE.SpotLight(TEAM_TORCH_HEX, 0, 24, 0.26, 0.6, 2);
  L.castShadow = false;
  scene.add(L);
  scene.add(L.target);
  return L;
});
let teamSpotN = teamTorches.length;
// same trick as LightPool.setActive: genuinely REMOVE the spare spots from the
// scene on the low rungs, which shortens the light loop compiled into every
// shader rather than just multiplying by a zero uniform
function setTeamSpots(n) {
  n = Math.max(0, Math.min(n, teamTorches.length));
  if (n === teamSpotN) return;
  teamSpotN = n;
  teamTorches.forEach((L, i) => {
    if (i < n) { if (!L.parent) { scene.add(L); scene.add(L.target); } }
    else if (L.parent) { L.intensity = 0; scene.remove(L); scene.remove(L.target); }
  });
}

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
//
// TWO CONES, because that is what a weapon light actually is: a tight hot
// core thrown by the reflector plus a much wider, much dimmer spill from the
// same lens. One medium-wide soft spot reads as a grey smear on the wall —
// there is no bright disc to say "the beam is pointed HERE", and no dark
// surround to say "and nowhere else". The core is narrow enough that the
// shadow map spends all its texels on the part you are looking at, and it is
// the only one of the two that casts.
const torch = new THREE.SpotLight(0xeaf2ff, 0, 30, 0.22, 0.4, 2);
const torchTarget = new THREE.Object3D();
const _torchRifleBase = new THREE.Vector3();
const _torchRifleTip = new THREE.Vector3();
const _torchRifleDirection = new THREE.Vector3();
scene.add(torch, torchTarget);
torch.target = torchTarget;
torch.castShadow = true;
// the spill: keeps you from walking down a black tunnel with a dot in it,
// and puts light on the deck at your feet. No shadow, no cost beyond one more
// light in the loop. Its apex sits ~0.75 m AHEAD of the eye — far enough that
// the whole viewmodel is behind the cone's origin, because at true
// inverse-square a wide cone from the eye puts 100+ lux on a rifle held 0.6 m
// away and the gun renders as a white cutout. The world cannot tell the
// difference between an apex at the eye and one at arm's length.
const torchSpill = new THREE.SpotLight(0xeaf2ff, 0, 14, 0.50, 0.95, 2);
torchSpill.castShadow = false;
torchSpill.target = torchTarget;
scene.add(torchSpill);
// ...which leaves the rifle lit by nothing at all, so it gets its own rig, the
// way every shooter lights a viewmodel. A 1.5 m point light parented to the
// camera physically cannot reach the room (a bulkhead you are pressed against
// takes ~5% of what the gun takes), so the compartment stays honest.
const gunFill = new THREE.PointLight(0xdfeaff, 0, 1.5, 1);
gunFill.position.set(0.06, 0.02, -0.42);
camera.add(gunFill);
const _torchDir = new THREE.Vector3(); // per-frame scratch (was allocating one a frame)
// HALF-RATE SHADOWS: the WebGPU renderer throttles per-light — the loop
// stamps shadow.needsUpdate at 30Hz instead of every frame
torch.shadow.autoUpdate = false;
const fixedShadowSize = renderer.backend.isWebGPUBackend && !HD ? 768 : 1024;
torch.shadow.mapSize.set(fixedShadowSize, fixedShadowSize);
torch.shadow.camera.near = 0.3;
torch.shadow.camera.far = 32;
torch.shadow.bias = -0.002;
torch.shadow.radius = 4; // soft edges on everything the beam throws
// NEVER pitch black (user: torch shadows of lying bodies read as flat black
// "shader glitch" splats — a corpse under the beam at a grazing angle throws
// a long razor umbra with zero fill). Part-lit shadows keep the depth cue
// without the cardboard-cutout artifact.
torch.shadow.intensity = 0.62;

// --- boot: random ship every run unless a seed is pinned in the URL
// (?seed=... for a reproducible one), starting flood kept light (20
// infection forms, no combat forms/carriers yet) ---
const seedFromUrl = LAUNCH.seed || new URLSearchParams(location.search).get('seed');
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
const cic = sim.graph.byId.get('cic');
const networkPlayers = new Map();
const networkSquads = new Map();
if (LAUNCH.session) {
  for (const did of [...new Set(LAUNCH.members || [LAUNCH.session.did])].sort()) {
    const agent = sim.attachPlayer(cic, { odst: true });
    networkPlayers.set(did, agent);
    networkSquads.set(did, sim.attachPlayerSquad(agent, 3));
  }
}
const player = new Player(canvas, world, sim, cic, null, networkPlayers.get(LAUNCH.session?.did));

// Rapier physics: the player's authoritative horizontal collision, built from
// the same wall meshes the world just extruded (world.collisionBoxes()). Loaded
// OFF the boot path — a slow or failed wasm load must never wedge the game on
// the loading screen — and attached to the player when it resolves.
let physics = null;
initRapier().then(() => {
  physics = new PhysicsWorld({ staticBoxes: world.collisionBoxes() });
  // door colliders are DYNAMIC (doors jam/unjam mid-session, and the armory
  // seal releases): one parked/placed fixed box per door, toggled below
  physics.setDoorBoxes(world.doorBoxes());
  player.attachPhysics(physics);
}).catch((e) => console.error('[charon] Rapier physics failed to initialise:', e));
agents.playerId = player.agent.id;
const fireteam = networkSquads.get(LAUNCH.session?.did) ?? sim.attachPlayerSquad(player.agent, 3);
const gameSync = createGameSync({
  session: LAUNCH.session,
  scene,
  world,
  sim,
  player,
  agents,
  name: LAUNCH.name || 'ODST',
  members: LAUNCH.members || [],
  host: LAUNCH.host,
  hostOrder: LAUNCH.hostOrder || [],
  playerAgents: networkPlayers,
});
const isSimAuthority = () => !LAUNCH.session || gameSync?.isAuthority();
if (LAUNCH.session) {
  const networkHud = document.getElementById('networkHud');
  const networkState = document.getElementById('networkState');
  const gameVoice = document.getElementById('gameVoice');
  networkHud.hidden = false;
  const updateNetwork = () => {
    const online = new Set(LAUNCH.session.roster().map((peer) => peer.did));
    const peers = (LAUNCH.members || [...online]).filter((did) => online.has(did)).length;
    networkState.textContent = `P2P · ${peers} ONLINE · ${LAUNCH.session.transport === 'peerd' ? 'PEERD' : 'WEBRTC'}`;
  };
  const updateVoice = (status) => {
    gameVoice.textContent = !status?.active ? 'ENABLE MIC'
      : status.playbackBlocked ? 'ENABLE AUDIO' : status.muted ? 'MIC MUTED' : 'MIC LIVE';
  };
  LAUNCH.session.on('roster', updateNetwork);
  LAUNCH.session.on('voice', updateVoice);
  updateNetwork();
  LAUNCH.session.voiceStatus().then(updateVoice).catch(() => updateVoice(null));
  gameVoice.addEventListener('click', async () => {
    gameVoice.disabled = true;
    try {
      const status = await LAUNCH.session.voiceStatus().catch(() => ({ active: false, muted: false }));
      const next = status.playbackBlocked
        ? await LAUNCH.session.resumeVoicePlayback()
        : status.active ? await LAUNCH.session.setVoiceMuted(!status.muted)
        : await LAUNCH.session.startVoice({ startMuted: false });
      updateVoice(next);
    } catch (error) {
      updateVoice(null);
      gameVoice.title = error?.message || 'Microphone unavailable';
    } finally {
      gameVoice.disabled = false;
    }
  });
}
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

// SOUND BOARD (user: "the sounds are so goofy, create a menu item where i can
// play each sound one at a time and i can tell you which im talking about").
// K opens it. It enumerates audio.buffers at runtime rather than a hand-kept
// list, so it can never drift out of date as the bank changes — every voice
// the game can make is in here, named exactly as game/audio.js names it, and
// played non-positionally at full gain with the rate limiter bypassed.
let soundBoard = null;
function toggleSoundBoard() {
  if (soundBoard) { soundBoard.remove(); soundBoard = null; return; }
  audio.ensure();
  document.exitPointerLock?.();
  const names = Object.keys(audio.buffers).sort();
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;'
    + 'width:min(560px,92vw);max-height:82vh;overflow:auto;background:rgba(6,10,16,0.96);'
    + 'border:1px solid #2a3a4e;padding:14px 16px;font:12px/1.6 ui-monospace,Menlo,monospace;'
    + 'color:#bfd4f2;box-shadow:0 8px 40px rgba(0,0,0,0.7)';
  const head = document.createElement('div');
  head.style.cssText = 'color:#7fe3ff;letter-spacing:0.14em;margin-bottom:10px';
  head.textContent = `SOUND BOARD — ${names.length} VOICES · K TO CLOSE`;
  d.appendChild(head);
  for (const n of names) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:3px 0;border-bottom:1px solid #16202c';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;color:#dce6ff';
    label.textContent = n;
    const btn = document.createElement('button');
    btn.textContent = 'play';
    btn.style.cssText = 'background:#16283a;color:#9fd8ff;border:1px solid #2f4a63;'
      + 'padding:2px 14px;font:11px ui-monospace,monospace;cursor:pointer';
    btn.onclick = () => audio.play(n, null, 1);
    row.append(label, btn);
    d.appendChild(row);
  }
  soundBoard = d;
  document.body.appendChild(d);
}

// AUDIO LOG (user: "so i can see what's playing visually by name"). The board
// above answers "what does X sound like"; this answers the harder one — "what
// WAS that?" — by naming every cue as it fires. It is a HUD, not a dialog: it
// does not take pointer lock, so you can watch it while you play.
//   J opens it. Rows are newest-first. A cue repeating inside 1.2 s collapses
// to a xN counter instead of scrolling the interesting things off the top,
// which matters because a firefight is mostly `shot` and `shriek`.
let audioLog = null;
function toggleAudioLog() {
  if (audioLog) { audioLog.stop(); audioLog = null; return; }
  audio.ensure();
  const d = document.createElement('div');
  d.className = 'hud';
  d.style.cssText = 'right:12px;top:180px;width:210px;z-index:6;'
    + 'font:11px/1.5 ui-monospace,Menlo,monospace;color:#bfd4f2;'
    + 'background:rgba(6,10,16,0.72);border:1px solid #2a3a4e;padding:8px 10px';
  const rows = document.createElement('div');
  const head = document.createElement('div');
  head.style.cssText = 'color:#7fe3ff;letter-spacing:0.12em;margin-bottom:6px';
  head.textContent = 'AUDIO LOG · J';
  d.append(head, rows);
  document.body.appendChild(d);

  const render = () => {
    const now = performance.now();
    // collapse consecutive repeats walking newest -> oldest
    const out = [];
    for (let i = audio.cues.length - 1; i >= 0 && out.length < 12; i--) {
      const c = audio.cues[i];
      const last = out[out.length - 1];
      if (last && last.name === c.name && last.far === c.far && last.t - c.t < 1200) {
        last.n++;
        last.t = c.t;
        continue;
      }
      out.push({ name: c.name, far: c.far, t: c.t, d: c.d, positional: c.positional, n: 1 });
    }
    rows.textContent = '';
    if (!out.length) {
      const empty = document.createElement('div');
      empty.style.color = '#4a5a6e';
      empty.textContent = 'silence';
      rows.appendChild(empty);
      return;
    }
    for (const c of out) {
      const age = (now - c.t) / 1000;
      const row = document.createElement('div');
      // the newest cue is the one you are asking about, so it stays bright and
      // the rest dim out over ~8 s — the panel reads as a decaying tail
      row.style.cssText = `display:flex;gap:6px;opacity:${Math.max(0.28, 1 - age / 8).toFixed(2)}`;
      const name = document.createElement('span');
      name.style.cssText = 'flex:1;color:' + (c.far ? '#8fa8c4' : '#dce6ff');
      name.textContent = c.far ? `${c.name} (far)` : c.name;
      const meta = document.createElement('span');
      meta.style.color = '#5f7c8f';
      meta.textContent = (c.n > 1 ? `x${c.n} ` : '') + (c.positional ? `${c.d.toFixed(0)}m` : 'ear');
      row.append(name, meta);
      rows.appendChild(row);
    }
  };

  render();
  audio.onCue = render;
  const tick = setInterval(render, 400); // ages the opacity out while nothing fires
  audioLog = {
    stop() { clearInterval(tick); if (audio.onCue === render) audio.onCue = null; d.remove(); },
  };
}

// FLOOD READOUT (user: "a flood strength/number indicator for debugging"). H
// opens it. Everything here is read straight off sim.hive.stats — the numbers
// the hive scored its own decisions with — so if the panel says AGGRESSIVE, it
// is aggressive; there is no second opinion to drift.
//   mass = infection + combat*2 + carriers*2, the same figure that arms ALL-IN
// at >= 50 and >= 3x the believed survivors. scarcity gates the posture flip.
let floodHud = null;
function toggleFloodHud() {
  if (floodHud) { floodHud.stop(); floodHud = null; return; }
  const d = document.createElement('div');
  d.className = 'hud';
  d.style.cssText = 'right:12px;top:12px;width:210px;z-index:6;'
    + 'font:11px/1.5 ui-monospace,Menlo,monospace;color:#bfd4f2;'
    + 'background:rgba(6,10,16,0.72);border:1px solid #3a2a2e;padding:8px 10px';
  document.body.appendChild(d);

  const render = () => {
    const s = sim.hive?.stats;
    if (!s) { d.textContent = 'FLOOD · H — hive has not ticked yet'; return; }
    const row = (k, v, hot) =>
      `<div style="display:flex;gap:6px"><span style="flex:1;color:#8fa8c4">${k}</span>`
      + `<span style="color:${hot ? '#ff8a6a' : '#dce6ff'}">${v}</span></div>`;
    d.innerHTML = `<div style="color:#ff8a6a;letter-spacing:0.12em;margin-bottom:6px">FLOOD · H</div>`
      + row('mass', s.mass, s.mass >= 50)
      + row('infection', s.I)
      + row('combat', s.C)
      + row('carriers', s.K)
      + row('bodies free', s.bodies)
      + row('scarcity', s.S.toFixed(2), s.S > 1.05)
      + row('believed alive', s.believedAlive)
      + row('posture', s.posture, s.posture === 'AGGRESSIVE')
      + row('phase', s.opening ? 'opening' : 'steady')
      + (s.allIn ? '<div style="margin-top:4px;color:#ff8a6a">ALL-IN — every form converging</div>' : '');
  };

  render();
  // the hive thinks on a 2.5 s tick; polling twice that fast is enough to look
  // live without pretending to a resolution the sim does not have
  const tick = setInterval(render, 1200);
  floodHud = { stop() { clearInterval(tick); d.remove(); } };
}

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
// the flamethrower's stream: declared per frame from agents3d's FLAG.FLAMING
// carriers, exactly as the weapon lights are (see updateFlameJets)
const jets = new FlameJetFX(scene, lightPool);
fire.camera = camera;   // embers/sparks are instanced quads that billboard
sparks.camera = camera; // to the camera each update
jets.camera = camera;
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
//   0  full: PCFSoft 1024 shadows @30Hz (768 on WebGPU laptops), 10 lights, bloom 0.5, 36 motes
//   1  tighter res window, shadow map 768
//   2  shadow map 512, 8 lights, bloom 0.375        (one recompile)
//   3  shadows OFF                                  (one recompile)
//   4  6 lights, bloom 0.25, 12 motes, floor 0.55   (one recompile; = old low)
// The recompile rungs are PREWARMED behind the intro (compileAsync), so
// stepping down mid-fight costs a uniform change, not a shader storm.
// ?q=full pins rung 0, ?q=low pins rung 4; ?hd=1 pins 0 with a 2.0 cap.
let _shadowAt = 0; // torch shadow refresh clock (wall time, not frame parity)
const RUNGS = [
  { res: [0.85, 1.25], shadowMap: 1024, shadows: true, lights: 14, bloom: 0.5, litePost: false, motes: 36, rag: 48, rifleLights: 6, teamSpots: 3 },
  { res: [0.7, 1.1], shadowMap: 768, shadows: true, lights: 14, bloom: 0.5, litePost: false, motes: 36, rag: 48, rifleLights: 6, teamSpots: 3 },
  { res: [0.7, 1.0], shadowMap: 512, shadows: true, lights: 10, bloom: 0.375, litePost: false, motes: 24, rag: 32, rifleLights: 4, teamSpots: 2 },
  { res: [0.6, 1.0], shadowMap: 512, shadows: false, lights: 8, bloom: 0.375, litePost: true, motes: 24, rag: 24, rifleLights: 3, teamSpots: 1 },
  { res: [0.55, 0.9], shadowMap: 512, shadows: false, lights: 6, bloom: 0.25, litePost: true, motes: 12, rag: 16, rifleLights: 2, teamSpots: 0 },
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
    // NOTHING HERE MAY DESTROY A SHADOW RESOURCE. Reported again on the Legion
    // (Windows/Chrome/Dawn): "Destroyed texture [ShadowDepthTexture] used in a
    // submit", the same class of crash Firefox died of. Two paths caused it and
    // both are gone:
    //   - toggling renderer.shadowMap.enabled across a rung tears shadow
    //     resources down mid-flight. It is pinned on at boot now; a rung with
    //     shadows off simply stops the caster, so no shadow pass runs and the
    //     cost is the same.
    //   - re-sizing the map orphaned the old render target, and an orphaned
    //     target IS eventually destroyed — which is exactly what the error
    //     says. The map size is fixed for the session instead.
    // Why it only showed up on that machine now: the 240Hz cadence fix
    // unfroze the ladder. Before it, `locked` was permanently false on a
    // high-refresh panel and rung changes could not happen at all, so this
    // latent crash had nothing to trigger it.
    torch.castShadow = R.shadows;
    if (R.shadows) {
      torch.shadow.needsUpdate = true;
      _shadowAt = performance.now();
    }
    lightPool.setActive(R.lights);
    setTeamSpots(R.teamSpots ?? 3);
    post.setBloomScale(R.bloom);
    post.setLite(R.litePost);
    motes.setCount(R.motes);
    // CPU lever (swarm finding: the ladder shed only GPU cost): fewer live
    // ragdoll solvers on the low rungs — the cap gates new flops, extras
    // evict oldest-asleep exactly as at the full cap
    if (agents.ragdolls) agents.ragdolls.p.maxActive = R.rag ?? 48;
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
function updateRoomLightPool(inDark) {
  // every powered fixture and every dead-room red lamp declares a VIRTUAL
  // light — the global pool picks the winners near you (dead ship, discrete
  // sources instead of an ambient wash)
  const pnode = player.agent.node;
  for (let n = 0; n < sim.graph.n; n++) {
    const L = world.roomLights[n];
    if (!L || L.x === undefined) continue;
    if (sim.darkAt(n)) continue; // flood-held rooms are DARK — nothing burns there
    const nd = sim.graph.node(n);
    if (nd.deck !== player.deck) continue;
    const d2 = (L.x - player.x) * (L.x - player.x) + (L.z - player.z) * (L.z - player.z);
    if (d2 > 40 * 40) continue;
    // NEIGHBOURS DON'T SHINE THROUGH THE BULKHEAD. A pooled point light has
    // no occluder — a strip two compartments away with a 19 m reach lit our
    // walls from BEHIND, and that unowned leak was what kept a blacked-out
    // room sitting at a flat blue lift instead of at zero. It is invisible
    // when you are in a lit room, and it is the entire problem when you are
    // not. Shortening the reach of everything outside your own compartment
    // kills the leak but still lets a lit room read as lit when you look into
    // it through a hatch; the doorway transfer itself is updateDoorSpill's
    // job, and that one is placed with knowledge of the wall.
    const leak = inDark && n !== pnode ? 0.47 : 1;
    if (L.mode === 'dead' && L.emergency) {
      // red battery lamp over the hatch — dim, warm, with a slow breathe
      lightPool.add(L.em.x, L.em.y, L.em.z, 0xff4030,
        2.6 + Math.sin(performance.now() * 0.0011 + L.phase) * 0.5, 11 * leak, 1.9);
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
          0xbfd4f2, L.mode === 'steady' ? 14 : 15 * L.lvl, 19 * leak, 1.9);
      }
    }
  }
  // WEAPON LIGHTS (user: a light on their rifle that does real work, so you
  // naturally see more in a dark room with your fireteam than without —
  // from the pure physics). agents3d declares one per armed body standing in
  // a blacked-out room; they compete in the same pool as everything else, and
  // in a dark room the fixtures are off, so there is little to compete with.
  // Nearest-first, budgeted per rung.
  // TEAM TORCHES (user: "in pitch darkness all you see is your lights but also
  // your teams lights illuminating things in the same room"). The nearest few
  // get a REAL SPOTLIGHT aimed down the barrel, so you see the beam's footprint
  // sweep the deck and bulkheads the way your own torch does — a point light at
  // the wall is just a round blob. Everyone beyond those slots still declares a
  // cheap pooled point light at the spot their beam lands, so a crowded dark
  // room is many separate pools rather than an ambient lift.
  const lit = [];
  for (let i = 0; i < agents.rifleLightN; i++) lit.push(agents.rifleLights[i]);
  lit.sort((a, b) => a.d2 - b.d2);
  const spots = Math.min(teamSpotN, lit.length);
  for (let i = 0; i < teamSpotN; i++) {
    const T = teamTorches[i], r = i < spots ? lit[i] : null;
    if (!r) { T.intensity = 0; continue; }
    T.position.set(r.ox, r.oy, r.oz);
    // NOSE-DOWN. agents3d solves the aim purely in plan view, so every beam
    // came out dead level at 1.05 m and a room full of marines read as a line
    // of dots ruled around the bulkhead at exactly chest height. Men clearing
    // a compartment hold the light down: a 3-degree depression puts the pool
    // low on the far wall, and on a long throw it lands on the DECK short of
    // the wall instead — which is where you actually look for a body.
    // agents3d now emits the barrel's REAL elevation, so the old flat ~3%
    // depression here would double-count to ~6 degrees and drop every pool
    // short of what the man is actually pointing at
    T.target.position.set(r.tx, r.ty, r.tz);
    T.target.updateMatrixWorld();
    // three windows the inverse-square falloff to zero at `distance` with a
    // pow4 ramp, so a cutoff set just past the wall eats about half the
    // landing brightness. Put the cutoff well beyond the throw and let the
    // decay do the work — the beam then dies with range instead of with an
    // arbitrary radius.
    T.distance = r.throw * 1.6 + 8;
    T.intensity = TEAM_TORCH_CD;
  }
  // OVERFLOW ONLY, and kept on a very short leash. A point light AT the wall
  // grazes it and dumps most of its output backwards into the room, which is
  // why the old blobs washed everything; backing it 1.3 m off the surface
  // along the man's own beam makes it face the wall and read as a disc, and a
  // 5 m reach means it physically cannot reach the compartment behind it.
  const rlCap = RUNGS[rung].rifleLights ?? 4;
  for (let i = spots; i < Math.min(lit.length, spots + rlCap); i++) {
    const r = lit[i];
    const bx = r.tx - r.ox, bz = r.tz - r.oz;
    const bl = Math.hypot(bx, bz) || 1;
    lightPool.add(r.tx - bx / bl * 1.3, r.ty, r.tz - bz / bl * 1.3,
      TEAM_TORCH_HEX, 26, 5, 2);
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

// live flamethrower burns from the sim.
// THE FIRE LANDS WHERE THE FLAME WENT. This used to light the blaze at the
// room's GEOMETRIC CENTRE, because the node was all the sim handed over — so
// in a hangar the flame hit a body against a bulkhead and a fire lit up thirty
// metres away mid-deck. The sim now records the spot the fuel landed on
// (graph.burnX/burnY, written wherever burningUntil is), the same route the
// blood marks take, and FireFX.add has always taken an arbitrary world point.
function syncBurnFires() {
  for (let n = 0; n < sim.graph.n; n++) {
    const key = `burn${n}`;
    const burning = sim.graph.burningUntil[n] > sim.t;
    if (burning && !fire.fires.has(key)) {
      const nd = sim.graph.node(n);
      const [wx, wz] = world.simToWorld(sim.graph.burnX[n], sim.graph.burnY[n], nd.deck);
      fire.add(key, wx, wz, elevOf(nd.deck), 1.2);
    } else if (!burning && fire.fires.has(key)) fire.remove(key);
  }
}

// THE FLAME JET (item 1): agents3d hands over one record per marine with the
// trigger down — origin at his nozzle, direction down his barrel, length out to
// the spot the sim says the fuel is landing on. Drained here, like rifleLights,
// so the FX and its three pooled lights live with the rest of the effects.
// The roar is retriggered on a key gap slightly under the sample length, so a
// sustained burn sounds continuous and a corpse-cache squirt is one bark.
function updateFlameJets(dtReal) {
  jets.frame();
  for (let i = 0; i < agents.flameJetN; i++) {
    const r = agents.flameJets[i];
    jets.emit(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz, r.len, r.seed);
    if (Math.hypot(r.ox - player.x, r.oz - player.z) < 34) {
      audio.play('flame', { x: r.ox, z: r.oz }, 0.7, `flame${r.seed}`, 900);
    }
  }
  // YOUR OWN stream rides the same pool and the same roar — one flame system
  // in the game, whoever is holding the trigger. Louder and unpositioned: it
  // is going off beside your head, not across the compartment.
  if (_flameJet) {
    const j = _flameJet;
    jets.emit(j.ox, j.oy, j.oz, j.dx, j.dy, j.dz, j.len, _flameSeed);
    audio.play('flame', null, 1.0, 'flame-player', 900);
  }
  jets.update(dtReal, camera.position.x, camera.position.y, camera.position.z);
}

const weapon = new HeldWeapon(MA5);
// THE FLAMETHROWER YOU CAN CARRY (user). `hasFlamer` is the pickup; `heldIsFlamer`
// is which of the two is up. You never lose the MA5 — the flamer is a second
// weapon on the sling, because a tank that empties in twelve seconds would be
// a death sentence if taking it meant dropping the rifle.
const FLAME = sim.P.flamethrower.player;
const flamer = new FlameThrower(FLAME);
let hasFlamer = false, heldIsFlamer = false;
player.onAmmoTaken = (src) => {
  if (src === 'armory') { sim.armoryStock--; weapon.reserve += 120; frags = Math.min(FRAG.max, frags + 4); sim.log('combat', `you strip mags and a bandolier of frags from the rack (${sim.armoryStock} rifles left)`); }
  else { src.wasArmed = false; weapon.reserve += 60; sim.log('combat', 'you take the mags off the dead'); }
};
// E on a flamethrower source. Offered ahead of the ammo prompt (see the hint
// block) because the flamer is the rarer find and a body can carry both.
player.onFlamerTaken = () => {
  const src = player.flamerSource(hasFlamer, flamer.frac);
  if (!src) return false;
  if (src === 'refuel') {
    flamer.fuel = sim.playerRefuel(flamer.fuel);
    sim.log('combat', 'you swap a fuel can into the flamethrower (you)');
  } else {
    flamer.fuel = sim.playerTakeFlamer(player.agent, src === 'armory' ? null : src);
    if (!hasFlamer) { hasFlamer = true; heldIsFlamer = true; } // the first one comes straight up
  }
  return true;
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
// the flamer's own viewmodel, on the same camera rig. Both exist for the
// whole session and visibility picks between them — building one on a weapon
// swap would hitch the first time you switch, mid-fight, in the dark.
const flamerMesh = buildFlamerViewmodel();
const flamerModel = new THREE.Group();
flamerModel.add(flamerMesh);
flamerModel.scale.setScalar(FLAMER_TUNE.s);
flamerModel.visible = false;
camera.add(flamerModel);
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
// ATMOSPHERE FIRST (user): the briefing opens on the ship's CURRENT state —
// what you are about to step into — then backfills the lore as a mission log.
const INTRO_BODY = [
  'UNSC SATURN DEVOURING — INTERNAL STATUS LOG // AUTO-GENERATED',
  'SHIP: FFG-201 UNSC SATURN DEVOURING — MARS HIGH ANCHOR',
  'DATE: OCTOBER 2552 // LOCAL 0347',
  '',
  'STATUS:',
  'Primary power offline. Secondary systems unstable.',
  'Ship heavily damaged. Radiation and electromagnetic interference',
  'disrupting radar and communications.',
  // the contact names the ACTUAL breach room this seed rolled
  `Contact in ${sim.graph.node(sim.graph.breachNode).name} — an object of`,
  'unknown type, originating from the Covenant holy city HIGH CHARITY.',
  'Fireteams mustering.',
  '',
  'MISSION LOG:',
  'Sol has been a war of attrition since the day the Covenant first',
  'appeared off Earth. Every week they probe the anchorages, every',
  'week we push them back, at a high and bleeding cost. There are',
  'little less of us left to do the bleeding. This Charon class',
  'frigate has held the Mars sector through all of it.',
  '',
  'One transmission reached this station in the past week:',
  'an outbreak on Earth. Not Covenant. Something else,',
  'loose near Voi — something that eats the dead and wears them.',
  '',
  'At 0331 local, HIGH CHARITY — the Covenant holy city itself —',
  'exited slipspace directly on top of the Mars anchorage.',
  'At 0339 it tore open a slipspace rupture larger and more violent',
  'than anything on record, and was gone into it. The collapse wave',
  'killed the reactor. Every ship and station around Mars is likely',
  'as dark as we are. You have no way of knowing.',
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
window.addEventListener('keydown', (event) => {
  if (introGone) return;
  if (!introDone) { introChars = INTRO_TOTAL; introRender(); }
  else if (event.code === 'Enter' || event.code === 'Space') {
    event.preventDefault();
    dismissIntro();
  }
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
  // FIRST CONTACT (user): the first squads to see the flood don't call in a
  // clean contact report — they call in confusion. Nobody briefed them for
  // this, and the one thing they know for sure is that it isn't Covenant.
  firstContact: [
    (r) => `contact in ${r} — be advised, these are NOT Covenant`,
    (r) => `what the hell are these things?! ${r}, we are engaging!`,
    (r) => `${r}, contact, type... unknown. it's not Covenant. say again, NOT Covenant`,
    (r) => `visual on hostiles in ${r} — they're wearing our uniforms. god, they used to be crew`,
    (r) => `something is very wrong in ${r} — they're not stopping, they're NOT STOPPING`,
    (r) => `unknown hostiles in ${r}. no shields, no plasma — they just keep walking at us`,
    (r) => `it took a full burst center mass and kept coming! ${r}!`,
    (r) => `these aren't elites, they aren't grunts, they aren't anything we were briefed on — ${r}!`,
    (r) => `eyes on ${r} — hostile bio, type unknown. it moves like something's puppeting it`,
    (r) => `what IS that?! ${r} — I need somebody to tell me what I'm shooting at!`,
    (r) => `${r} — whatever came off that thing from HIGH CHARITY, it's in here with us`,
    (r) => `they came out of the dark all wrong — ${r}, that is not a Covenant boarding party`,
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
  // the door rotation, heard as the crew hears it (user: the raw sim line
  // "a door mechanism seizes between X and Y" read as third-person leftover)
  doorJam: [
    (a, b) => `the door between ${a} and ${b} just slammed itself shut — it won't budge`,
    (a, b) => `door mechanism's seized between ${a} and ${b}. we're cut off that way`,
    (a, b) => `that door between ${a} and ${b} just ground shut on its own. it's stuck fast`,
    (a, b) => `lost the door between ${a} and ${b} — motor's dead, panel's dark`,
    (a, b) => `the ${a} door just froze mid-track on the ${b} side. it is NOT opening`,
    (a, b) => `door's stuck between ${a} and ${b}. find another way around`,
    (a, b) => `great. the door between ${a} and ${b} picked NOW to die`,
    (a, b) => `something in the track let go — ${a} to ${b} is sealed tight`,
  ],
  doorFree: [
    (a, b) => `the jammed door between ${a} and ${b} just popped free`,
    (a, b) => `door between ${a} and ${b} is moving again — must've shaken itself loose`,
    (a, b) => `that stuck door between ${a} and ${b} finally gave. it's open`,
    (a, b) => `the ${a} door ground back open on its own. I don't trust it`,
    (a, b) => `door's cycling again between ${a} and ${b}`,
    (a, b) => `whatever seized the ${a} door let go — it just slid open`,
  ],
  // friendly-fire discipline (user: marines hold and reposition when a
  // squadmate wanders into the lane — and pay for it in blood when the
  // chaos wins anyway)
  checkFire: [
    (r) => `hold fire, hold fire — got a man in my lane in ${r}!`,
    (r) => `check your lanes in ${r}, we are crossing each other!`,
    (r) => `can't shoot — friendly in my line in ${r}. moving for an angle`,
    (r) => `watch your spacing in ${r}! I keep losing my lane`,
    (r) => `shifting left for a clear lane in ${r} — nobody wander into my fire`,
    (r) => `you're in my line! step out, step OUT — ${r}`,
  ],
  ffHit: [
    (r) => `CHECK YOUR FIRE! CHECK YOUR FIRE! man hit in ${r}!`,
    (r) => `who's shooting?! you just clipped one of ours in ${r}!`,
    (r) => `blue on blue in ${r}! I say again, blue on blue!`,
    (r) => `cease fire, cease fire — we're hitting our own in ${r}!`,
    (r) => `friendly hit in ${r} — watch your damn lanes!`,
    (r) => `round just took a piece of my squadmate — ${r}, tighten it UP!`,
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
const say = (key, ...args) => { const p = VOICES[key]; return p[(Math.random() * p.length) | 0](...args); };
let _firstContacts = 0; // the first few flood calls read as confusion, not procedure
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
      {
        const dj = msg.match(/^a door mechanism seizes between (.+) and (.+)$/);
        if (dj) return rx(e, witnessNear(e.node), say('doorJam', dj[1], dj[2]));
        const df = msg.match(/^the jammed door between (.+) and (.+) grinds free$/);
        if (df) return rx(e, witnessNear(e.node), say('doorFree', df[1], df[2]));
        const cf = msg.match(/^check your fire — friendlies in the lane in (.+)$/);
        if (cf) return rx(e, witnessNear(e.node), say('checkFire', cf[1]));
        const fh = msg.match(/^a stray round hits a friendly in (.+)$/);
        if (fh) return rx(e, witnessNear(e.node), say('ffHit', fh[1]), { type: 'combat' });
      }
      if (msg.startsWith('distress call')) {
        const w = witnessNear(e.node);
        // the first few contact calls of the run are CONFUSION, not procedure
        // — nobody knows what these things are yet (user: "what the hell are
        // these things", "it's not Covenant")
        if (_firstContacts < 3) {
          _firstContacts++;
          return rx(e, w, say('firstContact', room ?? 'here'), { type: 'combat' });
        }
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
  // lastEvent is an ABSOLUTE counter matched against sim.eventTotal, with
  // sim.eventBase mapping into the (splice-capped) events array — the old
  // array-length compare wedged the log for 200 events every time the 1600
  // cap hit, then silently skipped them (user report: log stuck at min 12)
  const total = sim.eventTotal ?? sim.events.length;
  // no new events -> touch NOTHING (swarm finding: the scroll-metric reads
  // below force a synchronous reflow, and they ran every frame)
  if (lastEvent >= total) return;
  const base = sim.eventBase ?? 0;
  if (lastEvent < base) lastEvent = base; // events already aged off the buffer
  const log = el('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let added = false;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  while (lastEvent < total) {
    const raw = sim.events[lastEvent++ - base];
    // PHYSICAL side-effects of raw events, independent of radio receipt:
    // blood marks where people are taken or fall, the 1MC PA for shipwide
    // orders (the speakers are in every compartment — no radio needed)
    // BLOOD LANDS ON THE BODY (user: splats belong right over the reanimated
    // bodies). The sim now carries the exact spot on the event — before this,
    // conversions passed NO node at all (so they left no mark whatsoever) and
    // the marine-falls mark was stamped at the room's geometric centre, which
    // in a hangar is tens of metres from the corpse.
    if (raw.node >= 0 && (raw.type === 'convert' || raw.type === 'reanimate'
      || (raw.type === 'combat' && raw.msg.startsWith('a marine falls')))) {
      const nd = sim.graph.node(raw.node);
      const [bx, bz] = world.simToWorld(raw.x ?? nd.x, raw.y ?? nd.y, nd.deck);
      // a body that gets back up drags a fresh pool out from under itself
      blood.add(bx, bz, elevOf(nd.deck), lastEvent * 7919, raw.type === 'convert' ? 1.25 : 1);
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
  if (e.code === 'KeyK') toggleSoundBoard();
  if (e.code === 'KeyJ') toggleAudioLog();
  if (e.code === 'KeyH') toggleFloodHud();
  // WEAPON SWAP: Q. NOT 1/2 — those are the fireteam order keys (follow /
  // hold / advance) and binding a weapon to them would fire both actions off
  // one press. Silently ignored until you have actually found a flamethrower.
  if (e.code === 'KeyQ' && hasFlamer) heldIsFlamer = !heldIsFlamer;
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

function traceShot(offAng = 0, offRad = 0, maxDist = 100, dmg = MA5.damage, melee = false) {
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
  gameSync?.shot(muzzle, end);
  muzzleFlash.position.copy(muzzle);
  muzzleFlash.intensity = 8;
  if (best) {
    // parity (user rule): a combat form soaks the same fire from the player
    // as from any marine — its durability lives in the sim's hp, not in a
    // player-only multiplier
    const impact = melee ? combatMeleeImpulse({
      ...player.agent,
      charging: Math.hypot(player.vx, player.vz) > ODST.walkSpeed,
      leaping: !player.onGround,
      hoverY: player.onGround ? 0 : Math.max(0.1, player.h),
    }, best, sim.P.combat.combatForm.swing) : null;
    hurtFloodForm(sim, best, dmg, false, player.agent.id, impact);
    gameSync?.hitFlood(best.id, dmg);
    hitFlash = 1;
    audio.play('tick', null, 0.5, 'tick', 40);
  } else if (hitWallInstead) { wallSpark.position.copy(end); wallSpark.intensity = 6; }
  return !!best;
}

// --- the flamethrower in your hands ---------------------------------------
// One frame of live stream. Unlike traceShot this is not a ray: it is a cone
// with a reach, so it bites everything inside it rather than the one thing
// under the reticle. Sequence per frame: find how far the stream actually
// gets (a wall stops it), burn what is inside the cone out to that distance,
// tell the sim the room is on fire and WHERE, and hand the geometry to the
// jet FX.
const _fdir = new THREE.Vector3(), _fto = new THREE.Vector3();
const _fmuzzle = new THREE.Vector3(), _fend = new THREE.Vector3();
let _flameJet = null;      // {ox,oy,oz,dx,dy,dz,len} for this frame, or null
let _flameSeed = 1;

function flameTick(dt) {
  camera.getWorldDirection(_fdir);
  const origin = camera.position;

  // REACH: the stream stops at the first wall or closed door. Without this
  // you burn the compartment on the other side of a bulkhead, and the fire
  // lands in a room you cannot see.
  wallRay.set(origin, _fdir);
  wallRay.far = FLAME.rangeM;
  wallRay.near = 0.05;
  const hits = wallRay.intersectObjects(solidsForShot(), false);
  // back off the wall slightly so the flame washes the face of it rather than
  // vanishing into the geometry
  const reach = hits.length ? Math.max(0.6, hits[0].distance - 0.35) : FLAME.rangeM;

  // the jet leaves the NOZZLE, carried through the viewmodel's real world
  // transform (same treatment the MA5's muzzle flash gets)
  flamerMesh.updateWorldMatrix(true, false);
  _fmuzzle.set(0, -0.01, 0.50).applyMatrix4(flamerMesh.matrixWorld);
  _fend.copy(origin).addScaledVector(_fdir, reach);

  // COMBUSTION VOLUME: everything inside the cone, out to the reach. A pool
  // split between targets (the way resolveCombat models a marine's flamer) is
  // wrong for an aimed weapon — a cone does not divide itself between the
  // things standing in it. Every body in the fire takes the full rate, and
  // the tank is what stops you: 12.5 s of trigger, total.
  const cosLimit = Math.cos(FLAME.coneDeg * Math.PI / 180);
  const burn = FLAME.dps * dt;
  let anyHit = false;
  for (const a of shotCandidates()) {
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const cy = elevOf(a.deck) + (a.faction === 3 ? 0.35 : a.downed ? 0.35 : 0.9);
    _fto.set(wx, cy, wz).sub(origin);
    const d = _fto.length();
    if (d < 0.2 || d > reach) continue;
    if (_fto.dot(_fdir) / d < cosLimit) continue;
    hurtFloodForm(sim, a, burn, true, player.agent.id); // `true`: fire kills permanently
    anyHit = true;
  }
  // FIRE DOES NOT CHECK BADGES (user built friendly fire in deliberately). A
  // marine standing in your cone burns exactly like a combat form does, and
  // your own fireteam is the most likely thing to be standing in it.
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0 || a.isPlayer) continue;
    if (a.faction !== 0 && a.faction !== 1 && a.faction !== 2) continue;
    if (a.deck !== player.deck) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    _fto.set(wx, elevOf(a.deck) + 0.9, wz).sub(origin);
    const d = _fto.length();
    if (d < 0.2 || d > reach) continue;
    if (_fto.dot(_fdir) / d < cosLimit) continue;
    sim.hurtHuman(a, burn, player.agent.id); // blamed on you, like any friendly fire
  }

  // the room is burning, and it is burning WHERE THE FUEL LANDED — the far
  // end of the stream, not the room's centre
  const [bx, by] = world.worldToSim(_fend.x, _fend.z, player.deck);
  sim.playerFlame(player.agent.node, bx, by);
  sim.gunfireAt(player.agent.node); // a flamethrower is not quiet
  if (anyHit) hitFlash = Math.max(hitFlash, 0.35);

  _flameJet = _flameJet ?? {};
  _flameJet.ox = _fmuzzle.x; _flameJet.oy = _fmuzzle.y; _flameJet.oz = _fmuzzle.z;
  _flameJet.dx = _fdir.x; _flameJet.dy = _fdir.y; _flameJet.dz = _fdir.z;
  _flameJet.len = reach;
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
const _fragMove = new THREE.Vector3();
const _fragNormal = new THREE.Vector3();
const _fragVelocity = new THREE.Vector3();
function stepFrags(dt) {
  for (let i = liveFrags.length - 1; i >= 0; i--) {
    const f = liveFrags[i];
    f.vy -= FRAG.gravity * dt;
    const p = f.mesh.position;
    const nx = p.x + f.vx * dt, ny = p.y + f.vy * dt, nz = p.z + f.vz * dt;
    // wall bounce: cast along this frame's motion
    const mv = _fragMove.set(nx - p.x, ny - p.y, nz - p.z);
    const dist = mv.length();
    if (dist > 1e-6) {
      fragRay.set(p, mv.normalize());
      fragRay.far = dist + 0.09;
      const hit = fragRay.intersectObjects(solidsForShot(), false)[0];
      if (hit) {
        const n = _fragNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        const v = _fragVelocity.set(f.vx, f.vy, f.vz);
        v.sub(n.multiplyScalar(2 * v.dot(n))).multiplyScalar(FRAG.bounce);
        f.vx = v.x; f.vy = v.y; f.vz = v.z;
        audio.play('bounce', { x: p.x, z: p.z }, 0.7, 'bounce', 60);
      } else { p.set(nx, ny, nz); }
    }
    // floor bounce — unless the frag is over a REAL opening (a ladder hatch
    // hole or the grand stair well): the holes are genuinely cut through the
    // deck, so a grenade drops through to the deck below (user: toss grenades
    // through them to the next floor)
    const overHatch = f.deck < 5 && world.trunks.some((t) => t.vertical && f.deck === t.upperDeck
      && Math.abs(p.x - t.x) < 0.85 && Math.abs(p.z - t.z) < 0.85);
    if (overHatch && p.y < elevOf(f.deck)) {
      f.deck = world.trunks.find((t) => t.vertical && f.deck === t.upperDeck
        && Math.abs(p.x - t.x) < 0.85 && Math.abs(p.z - t.z) < 0.85).lowerDeck;
    }
    // the stair well descends within its own room — groundHeightAt returns
    // the flight surface under the frag, so it rolls/bounces DOWN the stairs
    const floor = world.groundHeightAt(f.deck, p.x, p.z, p.y - 0.09) + 0.09;
    if (p.y < floor && !overHatch) {
      p.y = floor;
      if (Math.abs(f.vy) > 1.2) audio.play('bounce', { x: p.x, z: p.z }, 0.6, 'bounce', 60);
      f.vy = -f.vy * FRAG.bounce;
      f.vx *= 0.7; f.vz *= 0.7;
    }
    f.fuse -= dt;
    if (f.fuse <= 0) {
      const [sx, sy] = world.worldToSim(p.x, p.z, f.deck);
      sim.explodeAt(f.deck, sx, sy, FRAG.radiusM, FRAG.damage, player.agent.id);
      gameSync?.explosion(f.deck, sx, sy, FRAG.radiusM, FRAG.damage);
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
      // 2.8s per room (was 700ms — a metronome of screams during any panic)
      audio.play('scream', { x: wx, z: wz }, 0.65, `scr${n}`, 2800);
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
    if (a.faction === 3 && d < 18 && now - chitterAt > 1600 + Math.random() * 1200) { audio.play('chitter', { x: wx, z: wz }, 0.55); chitterAt = now; }
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
const _doorsOnDeck = {};
let _obstacleN = 0;
let _obstacleKey = -1;
function playerObstacles() {
  const cy = elevOf(player.deck) + 0.9;
  // doors on the player's deck — an NPC HOLDING in a door throat (squads
  // pack up at doors before pushing) must not wall the player out of the
  // room (user: "marines stop at a door and block me, just stuck"). You
  // shoulder through people in a doorway; everywhere else they still block.
  // ORIENTED THROAT (user: blocked out of Cargo Hold 2 by a body parked in
  // the doorway). The old test was a 1.3 m sphere on the door's centre point,
  // which is wrong in both directions: it missed a body standing in the far
  // half of a deep throat — still squarely in your way — while freeing anyone
  // loitering BESIDE the door, where they should block you normally. Test the
  // actual opening instead: within the door's width across, and a throat's
  // depth through it.
  const deckDoors = (_doorsOnDeck[player.deck] ??= world.doors.filter((d) => d.deck === player.deck)
    .map((d) => ({ x: d.x, z: d.z, c: Math.cos(d.phi), s: Math.sin(d.phi) })));
  const THROAT_HALF_W = DOOR_W / 2 + 0.35, THROAT_DEPTH = 1.7;
  let n = 0;
  for (const a of sim.agents) {
    if (a.dead || a.isPlayer || a.deck !== player.deck) continue;
    if (a.faction === 6 || a.downed || a.hp <= 0) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    let inThroat = false;
    for (let di = 0; di < deckDoors.length; di++) {
      const d = deckDoors[di];
      const ddx = wx - d.x, ddz = wz - d.z;
      const lx = ddx * d.c + ddz * d.s;      // across the opening
      const lz = -ddx * d.s + ddz * d.c;     // through it
      if (lx > -THROAT_HALF_W && lx < THROAT_HALF_W && lz > -THROAT_DEPTH && lz < THROAT_DEPTH) { inThroat = true; break; }
    }
    if (inThroat) continue;
    const r = _obstacleRecs[n] ?? (_obstacleRecs[n] = { id: 0, x: 0, y: 0, z: 0, radius: 0.4, half: 0.5 });
    r.id = a.id; r.x = wx; r.y = cy; r.z = wz; r.radius = _obstacleR[a.faction] ?? 0.4;
    n++;
  }
  _obstacleN = n;
  return _obstacleRecs;
}

// MARINE BARKS (user: "weave in very very very sporadically and rarely to
// earn them and not be repetitive, once per game each at most, needs to come
// from a specific marine. if they die its interrupted").
//
// Four real voice lines, each spent ONCE per run and never repeated. They are
// earned rather than scheduled: a line only fires in the lull AFTER a fight —
// a living marine near you, nothing hostile left in his room, but gunfire in
// that room within the last half minute. On top of that a long enforced gap
// and a coin flip, so two runs never hear them at the same beats.
//
// The line belongs to that marine: it plays from his position, and if he is
// killed part-way through it is cut off mid-word.
const BARK_KEYS = ['bark1', 'bark2', 'bark3', 'bark4'];
const barkState = { unspent: BARK_KEYS.slice(), active: null, lastAt: -1e9, checkAt: 0 };
function updateBarks(now) {
  // interrupt: the man saying it just died
  const a = barkState.active;
  if (a) {
    const sp = sim.byId.get(a.id);
    if (!sp || sp.dead || sp.hp <= 0) {
      try { a.src.stop(); } catch { /* already ended */ }
      barkState.active = null;
    } else if (now >= a.endsAt) barkState.active = null;
  }
  if (now < barkState.checkAt) return;
  barkState.checkAt = now + 3000;
  if (barkState.active || !barkState.unspent.length) return;
  if (sim.t < 90 || now - barkState.lastAt < 240000) return;  // earn the first, and space the rest
  if (Math.random() > 0.35) return;
  // a living marine near you, in a room that is quiet NOW but was loud recently
  const quietSince = sim.tickCount - 30 * sim.P.sim.tickHz;
  let pick = null, bestD = 18 * 18;
  for (const m of sim.agents) {
    if (m.dead || m.hp <= 0 || m.faction !== 2 || m.deck !== player.deck) continue;
    if ((sim.gunfireTick[m.node] ?? -1e9) < quietSince) continue;   // no fight here lately
    if (sim.floodStrengthAt(m.node) > 0) continue;                  // still hot — not a lull
    const [mx, mz] = world.simToWorld(m.x, m.y, m.deck);
    const d2 = (mx - player.x) ** 2 + (mz - player.z) ** 2;
    if (d2 < bestD) { bestD = d2; pick = { m, x: mx, z: mz }; }
  }
  if (!pick) return;
  const key = barkState.unspent.splice((Math.random() * barkState.unspent.length) | 0, 1)[0];
  const buf = audio.buffers[key];
  const src = audio.play(key, { x: pick.x, z: pick.z }, 0.95);
  if (!src) { barkState.unspent.push(key); return; }              // out of earshot / not loaded
  barkState.lastAt = now;
  barkState.active = { src, id: pick.m.id, endsAt: now + (buf ? buf.duration * 1000 : 3000) };
}

// --- main loop ---
let physAcc = 0;
let _trackerAt = 0, _observeAt = 0, _sweepAt = 0; // subsystem throttle clocks (perf pass 2)
let _lightingAt = 0;
let _smYaw = 0, _smPitch = 0, _bobPhase = 0, _bobAmp = 0; // viewmodel sway/bob (first-strike feel)
let reloadFlashJank = 0;
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

  // MA5 loop (auto fire, bloom, reload, melee) — pure mechanics, events out.
  // The trigger goes to ONE weapon: whichever is up. Reload and melee still
  // reach the rifle with the flamer out, so you can top the MA5 up while the
  // torch is in your hands and butt-stroke something that gets inside the
  // stream's minimum useful range.
  const triggerLive = fireHeld && player.locked && !player.dead;
  const wevents = [];
  weapon.step(dtReal, {
    fireHeld: triggerLive && !heldIsFlamer,
    reloadPressed, meleePressed,
  }, wevents);
  reloadPressed = false; meleePressed = false;
  for (const ev of wevents) {
    if (ev.t === 'fire') { traceShot(ev.offAng, ev.offRad); audio.play('shot', null, 0.9); }
    else if (ev.t === 'melee_hit') { traceShot(0, 0, MA5.meleeRange, MA5.meleeDamage, true); audio.play('thud', null, 0.8); }
    else if (ev.t === 'reload_start') audio.play('clack', null, 0.7);
    else if (ev.t === 'dry') audio.play('clack', null, 0.4);
  }
  // the flamethrower, on the same trigger. `_flameJet` is cleared every frame
  // and only re-declared while the stream is live, so it goes out the instant
  // you release — the same discipline the light pool and the NPC jets use.
  _flameJet = null;
  if (hasFlamer) {
    const fevents = [];
    flamer.step(dtReal, { fireHeld: triggerLive && heldIsFlamer }, fevents);
    for (const ev of fevents) {
      if (ev.t === 'flame') flameTick(ev.dt);
      else if (ev.t === 'flame_on') { _flameSeed = (_flameSeed + 1) & 0xffff; audio.play('thud', null, 0.35); }
      else if (ev.t === 'dry') audio.play('clack', null, 0.35);
    }
  }
  // the igniter ring lights while the stream is out
  flamerMesh.userData.setPilot?.(flamer.live ? 1 : (hasFlamer ? 0.10 : 0));
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
    reloadFlashJank = 0;
    if (weapon.reloading) {
      const ph = 1 - weapon.reloadT / weapon.def.reloadS;
      tilt = -0.85 * Math.sin(Math.min(ph * Math.PI, Math.PI));
      reloadFlashJank = Math.sin(Math.min(ph * Math.PI, Math.PI));
    }
    const meleeSwing = weapon.meleeT > 0 ? Math.sin((1 - weapon.meleeT / weapon.meleeDuration) * Math.PI) : 0;
    viewmodel.position.x = GUN_TUNE.x + swayX - meleeSwing * 0.07;
    viewmodel.position.y = GUN_TUNE.y + swayY + gunBobY + meleeSwing * 0.3;
    viewmodel.position.z = -GUN_TUNE.z + weapon.recoil * 1.6;
    viewmodel.rotation.x = GUN_TUNE.rx + weapon.recoil * 2 + meleeSwing * 0.95 - tilt;
    viewmodel.rotation.y = GUN_TUNE.ry + meleeSwing * 0.08;
    viewmodel.rotation.z = GUN_TUNE.rz - meleeSwing * 0.08;
    // the flamer shares the sway and the bob, and gets a low-frequency shudder
    // of its own while burning — a pressure feed kicks, it does not recoil in
    // discrete jolts the way the rifle does
    const shudder = flamer.live ? Math.sin(_bobPhase * 31 + now * 0.021) * 0.006 : 0;
    flamerModel.position.x = FLAMER_TUNE.x + swayX;
    flamerModel.position.y = FLAMER_TUNE.y + swayY + gunBobY + shudder;
    flamerModel.position.z = -FLAMER_TUNE.z + (flamer.live ? 0.012 : 0);
    flamerModel.rotation.x = FLAMER_TUNE.rx + shudder * 1.6;
    flamerModel.rotation.y = FLAMER_TUNE.ry;
    flamerModel.rotation.z = FLAMER_TUNE.rz;
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

  if (isSimAuthority()) ticker.add(dtReal); // multiplayer peers render host checkpoints; only the elected host advances the world

  agents.viewX = player.x; agents.viewZ = player.z; // fog-exact stamp culling
  agents.update(dtReal);
  gameSync?.update(dtReal, now);
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
  if (now - _lightingAt >= 66) {
    const lightingDt = Math.min(0.2, (now - _lightingAt) / 1000);
    _lightingAt = now;
    world.updateLights(now * 0.001);
    world.updateDarkness(sim, player.agent.node, lightingDt);
  }
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
  // candela, not the old 1.5-decay number: at true inverse-square 430 cd puts
  // a wall at 4 m near clipping and a bulkhead at 20 m at a believable glimmer,
  // which is what a handheld actually does. The spill is a tenth of it, and
  // the viewmodel rig a four-hundredth — both ride the same dial so the whole
  // lamp brightens and dims as one.
  torch.intensity += ((inDark ? 430 : 260) - torch.intensity) * dimT;
  torchSpill.intensity = torch.intensity * 0.09;
  gunFill.intensity = torch.intensity * 0.0038;
  torch.distance = inFog ? sim.P.darkness.fogViewM + 2 : 30;
  torchSpill.distance = inFog ? sim.P.darkness.fogViewM + 1 : 14;
  {
    const tp = player.cameraPose();
    const tdir = _torchDir;
    camera.getWorldDirection(tdir);
    if (reloadFlashJank > 0.001) {
      // The lamp is rail-mounted: while the support hand rolls the rifle up
      // for a magazine change, the beam follows the real viewmodel barrel
      // instead of remaining supernaturally fixed at the reticle.
      rifleMesh.updateWorldMatrix(true, false);
      _torchRifleBase.copy(RIFLE_MUZZLE);
      _torchRifleBase.z -= 0.5;
      _torchRifleBase.applyMatrix4(rifleMesh.matrixWorld);
      _torchRifleTip.copy(RIFLE_MUZZLE).applyMatrix4(rifleMesh.matrixWorld);
      _torchRifleDirection.subVectors(_torchRifleTip, _torchRifleBase).normalize();
      tdir.lerp(_torchRifleDirection, reloadFlashJank * 0.94).normalize();
    }
    torch.position.set(tp.x, tp.y - 0.1, tp.z);
    // spill apex out past the muzzle — see the note where it is built
    torchSpill.position.set(tp.x + tdir.x * 0.75, tp.y - 0.1 + tdir.y * 0.75, tp.z + tdir.z * 0.75);
    torchTarget.position.set(tp.x + tdir.x * 10, tp.y + tdir.y * 10, tp.z + tdir.z * 10);
    // In darkness the close, off-axis splash catches the visor while the gun
    // crosses the eye line. It is deliberately tied to the beam motion and
    // darkness: a lit-room reload never produces a generic white screen flash.
    const glare = (inDark ? 0.68 : inFog ? 0.24 : 0) * reloadFlashJank * reloadFlashJank;
    setStyle('reloadGlare', 'opacity', glare.toFixed(3));
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
  world.showRoomSign(player.deck, player.x, player.z);
  updateBarks(now);
  lightPool.frame(); // all dynamic sources re-declare below
  syncBurnFires();
  fire.update(dtReal, player.x, player.z);
  updateFlameJets(dtReal);
  sparks.update(dtReal, now / 1000, player.x, player.z);
  updateMotes(dtReal);
  updateRoomLightPool(inDark);
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
  // keep the door colliders on the sim's lock state (setDoorClosed is a
  // dirty-checked no-op when nothing changed — ~60 cheap comparisons)
  if (physics) for (let i = 0; i < world.doors.length; i++) {
    physics.setDoorClosed(i, !!world.doors[i].edge.locked);
  }

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
    flamerModel.visible = false;
  } else {
    const pose = player.renderPose(alpha);
    // head bob (first-strike feel): shares the viewmodel's bob phase
    camera.position.set(pose.x, pose.y + Math.sin(_bobPhase * 2) * 0.02 * _bobAmp, pose.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(pose.yaw + (shake > 0 ? Math.sin(now * 0.09) * 0.02 * shake : 0));
    camera.rotateX(pose.pitch + (shake > 0 ? Math.sin(now * 0.11) * 0.018 * shake : 0));
    lamp.position.set(pose.x, pose.y + 0.2, pose.z);
    // exactly one weapon on screen
    viewmodel.visible = !player.dead && !heldIsFlamer;
    flamerModel.visible = !player.dead && heldIsFlamer;
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
  // the ammo readout follows whichever weapon is up: rounds for the rifle,
  // a fuel percentage for the flamer (there is nothing to count in a tank)
  setText('ammo', ghost ? ''
    : heldIsFlamer ? (flamer.empty ? 'TANK DRY' : `FUEL ${Math.ceil(flamer.frac * 100)}%`)
      : (weapon.reloading ? 'RELOADING' : `${weapon.mag} / ${weapon.reserve}`));
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
  // the flamethrower prompt outranks the ammo prompt, matching the order the
  // E key resolves them in (player.js) — the rarer pickup wins the line
  const fsrc = player.dead ? null : player.flamerSource(hasFlamer, flamer.frac);
  const src = fsrc ? null : (player.dead ? null : player.ammoSource());
  if (fsrc) {
    setText('hint', fsrc === 'armory' ? 'E — take the flamethrower off the rack'
      : fsrc === 'refuel' ? `E — swap a fuel can (${sim.armoryFuelCans} left)`
        : 'E — take the flamethrower off the operator');
    setStyle('hint', 'display', 'block');
  } else if (src) {
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
  // WALL CLOCK, not frame parity: every-other-frame is 30Hz at 60Hz but 120Hz
  // on the Legion's 240Hz panel, and the map is head-locked to the camera pose
  // so two thirds of those passes re-rendered an identical depth buffer.
  // >= 30 reproduces today's cadence exactly at 60Hz (two vsyncs is 33.3ms).
  // gate on the CASTER, not the renderer flag — the flag is pinned on now
  if (torch.castShadow && now - _shadowAt >= 30) { _shadowAt = now; torch.shadow.needsUpdate = true; }
  renderer.info.reset(); // per-frame accumulation across all post passes
  post.render(scene, camera, now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug hooks
window.__game = {
  sim, world, player, agents, weapon, camera, scene, renderer, flamer,
  viewmodel, flamerModel, jets, FLAMER_TUNE,
  // test/debug hooks for the flamethrower (harnesses can't press E at a body)
  giveFlamer: () => { hasFlamer = true; heldIsFlamer = true; flamer.fuel = FLAME.tankUnits; },
  setTrigger: (v) => { fireHeld = !!v; },
  putRifleUp: () => { heldIsFlamer = false; },
  flamerState: () => ({ hasFlamer, heldIsFlamer, fuel: flamer.fuel, live: flamer.live, jet: _flameJet }),
};
window.__audio = audio; // sound-board / audit harness
