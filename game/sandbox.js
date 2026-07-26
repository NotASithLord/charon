// SANDBOX — one room, spawn whatever you want, look at it.
//
// The game is a five-minute outbreak on a whole ship: to see a carrier strain
// and rupture you had to play until the hive seated one. This boots the SAME
// stack the game does (Sim, World, Agents3D — so what you see here is what
// renders in game, not a mock), then empties the ship, drops you in one room
// on an orbit camera, and gives you buttons to put things in it.
//
//   ?room=<node id>  start in a specific room (default: the biggest on deck 3)
//   ?gl=1            force the WebGL2 fallback backend
//   ?dark=1          start in the game's real lighting instead of demo lighting
//
// Deliberately NOT a copy of main.js: no player controller, no HUD, no weapon,
// no intro. If a demo needs those, play the game.

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { createRenderer } from '../engine/runtime.js';
import { Sim } from '../sim/sim.js';
import { makeAgent, STATE } from '../sim/init.js';
import { FACTION, FLAG, CLIP, CLIPS } from '../shared/agentBuffer.js';
import { World, elevOf } from './world.js';
import { Agents3D } from './agents3d.js';
import { CARRIER_CLIPS } from './carrier-model.js';

const QP = new URLSearchParams(location.search);
const canvas = document.getElementById('c');

const renderer = await createRenderer({ canvas, forceWebGL: QP.has('gl'), pixelRatioCap: 1.5 });
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d12);

const sim = new Sim('sandbox');
const world = new World(scene, sim.graph, 'sandbox');
const agents = new Agents3D(scene, sim, world);
agents.shadowCull = false;   // one room, a handful of bodies: always cast

// --- empty the ship -------------------------------------------------------
// Everything the sim seeded (300-odd crew, the breach corpses, the starting
// infection) would wander in and out of the demo room. Clear the roster; the
// buttons below are the only source of bodies from here on.
for (const a of sim.agents) a.dead = true;
sim.agents.length = 0;
sim.byId.clear();
sim._refreshOccupancy?.();

// --- pick the room --------------------------------------------------------
const roomId = QP.get('room');
const room = roomId && sim.graph.byId.has(roomId)
  ? sim.graph.node(sim.graph.byId.get(roomId))
  : sim.graph.nodes.filter((n) => n.deck === 3).sort((a, b) => b.w * b.d - a.w * a.d)[0];
const [roomX, roomZ] = world.simToWorld(room.x, room.y, room.deck);
const floorY = elevOf(room.deck);

// Agents3D hides anything more than one deck from the player and skips the
// player's own body. A dead marker agent parked in the room gives it the right
// deck without ever being simulated or drawn.
const marker = makeAgent(FACTION.CIVILIAN, room.idx, sim.graph);
sim.spawn(marker);
marker.dead = true;
agents.playerId = marker.id;

world.setActiveVolume(room.deck, roomX);

// --- lighting -------------------------------------------------------------
// The ship is meant to be nearly pitch black. That is correct for the game and
// useless for looking at a model, so the sandbox owns two lights it can swing
// between full daylight and the real thing.
const key = new THREE.DirectionalLight(0xdce8ff, 2.4);
key.position.set(roomX + 6, floorY + 9, roomZ + 5);
key.target.position.set(roomX, floorY, roomZ);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1; key.shadow.camera.far = 40;
key.shadow.camera.left = -12; key.shadow.camera.right = 12;
key.shadow.camera.top = 12; key.shadow.camera.bottom = -12;
scene.add(key, key.target);
const fill = new THREE.HemisphereLight(0xbcd0ee, 0x1a1f28, 1.5);
scene.add(fill);

let dark = QP.has('dark');
function applyLighting() {
  key.intensity = dark ? 0.0 : 2.4;
  fill.intensity = dark ? 0.06 : 1.5;
  scene.background.setHex(dark ? 0x05070a : 0x0a0d12);
}
applyLighting();

// --- orbit camera ---------------------------------------------------------
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
const orbit = { yaw: 2.3, pitch: 0.42, dist: 5.6, tx: roomX, ty: floorY + 0.9, tz: roomZ };

// The camera frames whatever you are looking at: the selected body, else the
// middle of everything in the room, else the empty room. Rooms here run to
// 67m across, so a fixed target on the room centre leaves a spawned body a
// long way off-screen.
function framingTarget() {
  const live = sim.agents.filter((a) => a !== marker && !a.dead);
  const of = (a) => {
    const [x, z] = world.simToWorld(a.x, a.y, a.deck);
    return [x, elevOf(a.deck) + 0.9, z];
  };
  const sel = live.find((a) => a.id === selectedId);
  if (sel) return of(sel);
  if (!live.length) return [roomX, floorY + 0.9, roomZ];
  const sum = live.reduce((s, a) => { const p = of(a); return [s[0] + p[0], s[1] + p[1], s[2] + p[2]]; }, [0, 0, 0]);
  return sum.map((v) => v / live.length);
}

function placeCamera(dt) {
  const [tx, ty, tz] = framingTarget();
  const k = Math.min(1, dt * 6);           // ease so switching selection glides
  orbit.tx += (tx - orbit.tx) * k;
  orbit.ty += (ty - orbit.ty) * k;
  orbit.tz += (tz - orbit.tz) * k;
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    orbit.tx + Math.sin(orbit.yaw) * orbit.dist * cp,
    orbit.ty + Math.sin(orbit.pitch) * orbit.dist,
    orbit.tz + Math.cos(orbit.yaw) * orbit.dist * cp);
  camera.lookAt(orbit.tx, orbit.ty, orbit.tz);
  // Agents3D culls anything past the fog wall using these
  agents.viewX = camera.position.x;
  agents.viewZ = camera.position.z;
}
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.yaw -= (e.clientX - lastX) * 0.008;
  orbit.pitch = Math.max(-0.35, Math.min(1.35, orbit.pitch + (e.clientY - lastY) * 0.006));
  lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.max(1.6, Math.min(40, orbit.dist * (1 + Math.sign(e.deltaY) * 0.12)));
}, { passive: false });

// --- spawning -------------------------------------------------------------
// Bodies land in a ring around the room centre so several stay separable.
let spawnSlot = 0;
function spawn(faction, tweak) {
  // golden-angle ring, wide enough that a carrier and its neighbour do not
  // overlap from a default camera distance
  const ang = spawnSlot * 2.399963, r = spawnSlot === 0 ? 0 : 1.7 + 0.45 * spawnSlot;
  spawnSlot++;
  const a = makeAgent(faction, room.idx, sim.graph);
  a.x = room.x + Math.cos(ang) * r;
  a.y = room.y + Math.sin(ang) * r;
  a.heading = ang + Math.PI;
  if (faction === FACTION.CARRIER) {
    a.hp = a.maxHp = sim.P.combat.carrierHp;
    a.state = STATE.INCUBATING;
    a.held = 1;
    a.mintTimer = 0;
  }
  tweak?.(a);
  sim.spawn(a);
  refreshList();
  return a;
}

function clearAll() {
  for (const a of sim.agents) if (a !== marker) a.dead = true;
  sim.agents = sim.agents.filter((a) => a === marker);
  for (const [id, a] of [...sim.byId]) if (a !== marker) sim.byId.delete(id);
  spawnSlot = 0;
  selectedId = -1;
  refreshList();
}

// --- controls -------------------------------------------------------------
const el = (id) => document.getElementById(id);
let running = false;          // the sim is paused by default: a demo should hold still
let selectedId = -1;
let clipOverride = null;      // force every body onto one clip, or null for sim-picked

const SPAWNS = [
  ['carrier', FACTION.CARRIER, null],
  ['combat form', FACTION.COMBAT, null],
  ['combat (armed)', FACTION.COMBAT, (a) => { a.hostArmed = true; }],
  ['infection form', FACTION.INFECTION, (a) => { a.hp = a.maxHp = 1; }],
  ['marine', FACTION.MARINE, null],
  ['ODST', FACTION.MARINE, (a) => { a.odst = true; }],
  ['crew (armed)', FACTION.ARMED, null],
  ['civilian', FACTION.CIVILIAN, null],
  ['corpse', FACTION.CORPSE, null],
];

el('spawns').innerHTML = SPAWNS.map((s, i) => `<button data-s="${i}">${s[0]}</button>`).join('');
el('spawns').addEventListener('click', (e) => {
  const i = e.target.dataset?.s;
  if (i === undefined) return;
  const [, faction, tweak] = SPAWNS[+i];
  selectedId = spawn(faction, tweak).id;
  refreshList();
});

el('clips').innerHTML = '<button data-c="">sim-picked</button>'
  + CLIPS.map((n, i) => `<button data-c="${i}">${n}</button>`).join('');
el('clips').addEventListener('click', (e) => {
  const c = e.target.dataset?.c;
  if (c === undefined) return;
  clipOverride = c === '' ? null : +c;
  refreshList();
});

el('clear').onclick = clearAll;
el('pause').onclick = () => { running = !running; el('pause').textContent = running ? 'pause sim' : 'run sim'; };
el('lights').onclick = () => { dark = !dark; applyLighting(); el('lights').textContent = dark ? 'ship lighting' : 'demo lighting'; };
el('step').onclick = () => { sim.tick(1 / 15); };
el('held').oninput = () => {
  const a = sim.byId.get(selectedId);
  if (a?.faction === FACTION.CARRIER) { a.held = +el('held').value; refreshList(); }
};
el('pop').onclick = () => {
  const a = sim.byId.get(selectedId);
  if (a?.faction !== FACTION.CARRIER) return;
  // the same path the sim takes: at capacity carrierTick ruptures it, and
  // Agents3D notices the id leave the buffer and plays the detonation
  a.held = sim.P.carrier.maxInfectionForms;
  a.dead = true;
  sim.agents = sim.agents.filter((x) => x !== a);
  sim.byId.delete(a.id);
  selectedId = -1;
  refreshList();
};

function refreshList() {
  const live = sim.agents.filter((a) => a !== marker);
  el('list').innerHTML = live.length
    ? live.map((a) => {
      const name = Object.keys(FACTION).find((k) => FACTION[k] === a.faction).toLowerCase();
      const extra = a.faction === FACTION.CARRIER ? ` held ${a.held}/${sim.P.carrier.maxInfectionForms}` : '';
      return `<button data-id="${a.id}" class="${a.id === selectedId ? 'on' : ''}">${name} #${a.id}${extra}</button>`;
    }).join('')
    : '<i>empty room</i>';
  const sel = sim.byId.get(selectedId);
  const isCarrier = sel?.faction === FACTION.CARRIER;
  el('carrierRow').style.display = isCarrier ? '' : 'none';
  if (isCarrier) {
    el('held').max = sim.P.carrier.maxInfectionForms;
    el('held').value = sel.held;
    el('heldOut').textContent = `${sel.held} / ${sim.P.carrier.maxInfectionForms}`;
  }
  for (const b of el('clips').children) b.classList.toggle('on', (b.dataset.c === '' ? null : +b.dataset.c) === clipOverride);
}
el('list').addEventListener('click', (e) => {
  const id = e.target.dataset?.id;
  if (id === undefined) return;
  selectedId = +id;
  refreshList();
});
refreshList();

// --- loop -----------------------------------------------------------------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (running) sim.tick(dt);
  else sim.writeBuffer();   // paused: still publish poses so the room renders

  // clip override rides on the buffer, after the sim has written it — the sim
  // stays the source of truth and nothing here can desync it
  if (clipOverride !== null) sim.buffer.animClip.fill(clipOverride, 0, sim.buffer.count);

  placeCamera(dt);
  agents.update(dt);
  renderer.render(scene, camera);

  el('hud').textContent = `${room.name} · deck ${room.deck} · `
    + `${sim.agents.length - 1} bodies · carrier clips: ${Object.keys(CARRIER_CLIPS).join('/')}`
    + (running ? ' · SIM RUNNING' : ' · sim paused');
});

window.__sandbox = { sim, world, agents, scene, camera, room, spawn, clearAll };
