// HALO CHARON — 3D vertical slice (docs/ROADMAP-3D.md): a solo human running
// the ship in first person while the FULL simulation plays out around them.
// The sim is untouched and authoritative; this page is a renderer + one
// externally-driven agent (the player).

import * as THREE from './vendor/three.module.js';
import { Sim, fmtTime } from '../sim/sim.js';
import { World, elevOf, CLEAR_H } from './world.js';
import { Agents3D } from './agents3d.js';
import { Player } from './player.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 18, 60);

const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 220);

// lighting: dim shipboard ambience + a headlamp on the player
scene.add(new THREE.HemisphereLight(0x9fb2d0, 0x141821, 1.4));
scene.add(new THREE.AmbientLight(0x7d879e, 1.1));
const lamp = new THREE.PointLight(0xcfe0ff, 15, 18, 1.8);
scene.add(lamp);

// --- boot the sim (same params as the debug page defaults) ---
const seedFromUrl = new URLSearchParams(location.search).get('seed');
const sim = new Sim(seedFromUrl || 'charon-1');
const world = new World(scene, sim.graph);
const agents = new Agents3D(scene, sim, world);

// spawn the player on the bridge — the far end of the ship from the breach
const player = new Player(canvas, world, sim, sim.graph.byId.get('bridge'));
agents.playerId = player.agent.id;

// --- HUD ---
const el = (id) => document.getElementById(id);
const overlay = el('overlay');
overlay.addEventListener('click', () => {
  if (player.dead) return; // no coming back from that
  overlay.classList.add('hidden');
  canvas.requestPointerLock();
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
    : 'click to keep moving — it knows you are here';
  overlay.classList.remove('hidden');
}

let lastEvent = 0;
function renderLog() {
  const log = el('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let added = false;
  while (lastEvent < sim.events.length) {
    const e = sim.events[lastEvent++];
    const div = document.createElement('div');
    div.className = `ev ev-${e.type}`;
    div.innerHTML = `<span class="t">${fmtTime(e.t)}</span> ${e.msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}`;
    log.appendChild(div);
    added = true;
  }
  if (added) {
    while (log.childNodes.length > 400) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// --- main loop: fixed-step sim, per-frame player + render ---
let acc = 0;
let shownLost = false;
let last = performance.now();
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  player.update(dtReal);

  acc += dtReal;
  let guard = 0;
  while (acc >= sim.dt && guard++ < 60) {
    sim.tick();
    acc -= sim.dt;
  }
  if (guard >= 60) acc = 0;

  agents.update(dtReal);

  const pose = player.cameraPose();
  camera.position.set(pose.x, pose.y, pose.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(pose.yaw);
  camera.rotateX(pose.pitch);
  lamp.position.set(pose.x, pose.y + 0.2, pose.z);

  // HUD
  el('clock').textContent = fmtTime(sim.t);
  const room = sim.graph.node(player.agent.node);
  el('room').textContent = room ? room.name : '—';
  el('deckLabel').textContent = `DECK ${player.deck}`;
  const hp = Math.max(0, Math.ceil(player.agent.hp));
  const hpEl = el('hp');
  hpEl.textContent = `HP ${hp}`;
  hpEl.classList.toggle('low', hp <= 8);
  el('pinned').style.display = player.pinned && !player.dead ? 'block' : 'none';
  renderLog();

  if (player.dead) {
    endScreen('YOU WERE TAKEN', 'The ship fights on without you. The last thing you hear is the hive, singing.');
  } else if (sim.outcome === 'contained') {
    endScreen('OUTBREAK CONTAINED', 'The marines burned it out. The Charon survives.');
  } else if (!ended && !shownLost && sim.tickCount % 30 === 0) {
    // the sim can't call the ship lost while YOU still count as a human —
    // check whether anyone else is left
    const othersAlive = sim.agents.some((a) => !a.dead && a.hp > 0 && !a.isPlayer
      && (a.faction === 0 || a.faction === 1 || a.faction === 2));
    if (!othersAlive) {
      shownLost = true;
      endScreen('THE CHARON IS LOST', 'Every other soul aboard is gone. You are alone with it now.', false);
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug hooks
window.__game = { sim, world, player, agents };
