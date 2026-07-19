// HALO CHARON — 3D slice (docs/ROADMAP-3D.md): an ODST with a fireteam,
// dropped into the ship while the FULL simulation plays out around them.
// Mechanics layer ported from the first-strike vertical slice (MA5 loop,
// armor-over-health, movement feel). The sim is untouched and authoritative.

import * as THREE from './vendor/three.module.js';
import { Sim, fmtTime } from '../sim/sim.js';
import { hurtFloodForm } from '../sim/combat.js';
import { World, elevOf } from './world.js';
import { Agents3D } from './agents3d.js';
import { Player } from './player.js';
import { HeldWeapon } from './weapon.js';
import { MA5 } from './fps-data.js';
import { buildRifleViewmodel, GUN_TUNE, RIFLE_MUZZLE } from './rifle-model.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 18, 60);

const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 220);

scene.add(new THREE.HemisphereLight(0x9fb2d0, 0x141821, 1.4));
scene.add(new THREE.AmbientLight(0x7d879e, 1.1));
const lamp = new THREE.PointLight(0xcfe0ff, 15, 18, 1.8);
scene.add(lamp);

// --- boot: random ship every run unless a seed is pinned in the URL
// (?seed=... for a reproducible one), starting flood kept light (10
// infection forms, no combat forms/carriers yet) ---
const seedFromUrl = new URLSearchParams(location.search).get('seed');
const seed = seedFromUrl || 'run-' + Math.random().toString(36).slice(2, 10);
const sim = new Sim(seed, { flood: { initialInfectionForms: 10, initialCombatForms: 0, initialCarriers: 0 } });
const world = new World(scene, sim.graph);
const agents = new Agents3D(scene, sim, world);

// spawn: Security on deck 3 — an ODST detail with a fireteam
const player = new Player(canvas, world, sim, sim.graph.byId.get('security'));
agents.playerId = player.agent.id;
sim.attachPlayerSquad(player.agent, 3);

const weapon = new HeldWeapon(MA5);
player.onAmmoTaken = (src) => {
  if (src === 'armory') { sim.armoryStock--; weapon.reserve += 120; sim.log('combat', `you strip mags from the rack (${sim.armoryStock} rifles left)`); }
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
const muzzleFlash = new THREE.PointLight(0xffd9a0, 0, 7, 2);
scene.add(muzzleFlash);
const wallSpark = new THREE.PointLight(0xffb060, 0, 4, 2.4);
scene.add(wallSpark);
const wallRay = new THREE.Raycaster();

// --- HUD ---
const el = (id) => document.getElementById(id);
const overlay = el('overlay');
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

// --- firing: MA5 events route into the sim's own damage model. Every shot
// is LOUD. Through-deck shots work when you and the target share an open
// vertical shaft's line ---
let fireHeld = false, reloadPressed = false, meleePressed = false;
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) fireHeld = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) fireHeld = false; });
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') reloadPressed = true;
  if (e.code === 'KeyF') meleePressed = true;
});

const _dir = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hit = new THREE.Vector3();
function shotCandidates() {
  // same-deck LOS via the sim's rules, plus the far room of any open shaft
  // whose column the player stands in/near
  const visible = new Set(sim.visibleNodes(player.agent.node));
  const out = [];
  const trunk = world.trunkAt(player.deck, player.x, player.z);
  const shaftNode = trunk && trunk.vertical
    ? (player.deck === trunk.lowerDeck ? trunk.upperNode : trunk.lowerNode) : -1;
  for (const a of sim.agents) {
    if (a.dead) continue;
    if (a.faction !== 3 && a.faction !== 4 && a.faction !== 5) continue;
    const sameDeck = a.deck === player.deck && visible.has(a.node);
    const viaShaft = shaftNode !== -1 && a.node === shaftNode;
    if (sameDeck || viaShaft) out.push(a);
  }
  return out;
}

// real physics for shots (user note): a bullet stops at the nearest solid
// wall or CLOSED door before it ever reaches an agent standing behind it —
// no shooting through bulkheads. Doors mid-slide count as solid too.
function solidsForShot() {
  const doors = world.doors.filter((d) => d.open01 < 0.92).map((d) => d.mesh);
  return world.wallMeshes.length || doors.length ? world.wallMeshes.concat(doors) : [];
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
  if (best) hurtFloodForm(sim, best, dmg, false);
  else if (hitWallInstead) { wallSpark.position.copy(end); wallSpark.intensity = 6; }
  return !!best;
}

// --- main loop ---
let acc = 0;
let shownLost = false;
let spectateShown = false;
let last = performance.now();
const doorMovers = [];
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  player.update(dtReal);

  // MA5 loop (auto fire, bloom, reload, melee) — pure mechanics, events out
  const wevents = [];
  weapon.step(dtReal, {
    fireHeld: fireHeld && player.locked && !player.dead,
    reloadPressed, meleePressed,
  }, wevents);
  reloadPressed = false; meleePressed = false;
  for (const ev of wevents) {
    if (ev.t === 'fire') traceShot(ev.offAng, ev.offRad);
    else if (ev.t === 'melee_hit') traceShot(0, 0, MA5.meleeRange, MA5.meleeDamage);
  }
  muzzleFlash.intensity *= Math.exp(-14 * dtReal);
  wallSpark.intensity *= Math.exp(-10 * dtReal);
  // viewmodel kick + reload dip
  viewmodel.position.z = -GUN_TUNE.z + weapon.recoil * 1.6;
  viewmodel.position.y = GUN_TUNE.y - (weapon.reloading ? 0.16 : 0) - (weapon.meleeT > 0 ? 0.1 : 0);
  viewmodel.rotation.x = GUN_TUNE.rx + weapon.recoil * 2 + (weapon.meleeT > 0 ? -0.5 : 0);

  acc += dtReal;
  let guard = 0;
  while (acc >= sim.dt && guard++ < 60) {
    sim.tick();
    acc -= sim.dt;
  }
  if (guard >= 60) acc = 0;

  agents.update(dtReal);

  // sliding doors open for ANY movement near them (user rule)
  doorMovers.length = 0;
  doorMovers.push({ deck: player.deck, x: player.x, z: player.z });
  const buf = sim.buffer;
  for (let i = 0; i < buf.count; i++) {
    if (buf.faction[i] === 6) continue; // the dead don't trip doors
    const deck = buf.posZ[i];
    const [wx, wz] = world.simToWorld(buf.posX[i], buf.posY[i], deck);
    doorMovers.push({ deck, x: wx, z: wz });
  }
  world.updateDoors(dtReal, doorMovers);

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
    const pose = player.cameraPose();
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(pose.yaw);
    camera.rotateX(pose.pitch);
    lamp.position.set(pose.x, pose.y + 0.2, pose.z);
    viewmodel.visible = !player.dead;
  }

  // HUD
  el('clock').textContent = fmtTime(sim.t);
  const povAgent = ghost ?? player.agent;
  const room = sim.graph.node(povAgent.node);
  el('room').textContent = room ? room.name : '—';
  el('deckLabel').textContent = `DECK ${povAgent.deck}`;
  const hp = Math.max(0, Math.ceil(povAgent.hp));
  el('healthBar').style.width = `${ghost ? hp / 63 * 100 : hp / 45 * 100}%`;
  el('armorBar').style.width = `${ghost ? 0 : player.armor / 50 * 100}%`;
  el('hpText').textContent = ghost ? `IT ${hp}` : `${Math.ceil(player.armor)} | ${hp}`;
  el('ammo').textContent = ghost ? '' : (weapon.reloading ? 'RELOADING' : `${weapon.mag} / ${weapon.reserve}`);
  rifleMesh.userData.setAmmoDigits?.(weapon.mag);
  const src = player.dead ? null : player.ammoSource();
  const hint = el('hint');
  if (src) {
    hint.textContent = src === 'armory'
      ? `E — strip mags from the rack (${sim.armoryStock} rifles)` : 'E — take mags off the dead';
    hint.style.display = 'block';
  } else if (player.climb) {
    hint.textContent = player.climb.toDeck < player.climb.fromDeck ? 'climbing up…' : 'climbing down…';
    hint.style.display = 'block';
  } else {
    const trunk = player.dead ? null : world.trunkAt(player.deck, player.x, player.z);
    if (trunk) {
      const up = player.deck === trunk.lowerDeck;
      const kind = trunk.vertical ? 'ladder' : 'stairs';
      hint.textContent = `W — climb ${kind} ${up ? 'up' : 'down'} to deck ${up ? trunk.upperDeck : trunk.lowerDeck}`;
      hint.style.display = 'block';
    } else hint.style.display = 'none';
  }
  el('pinned').style.display = player.pinned && !player.dead ? 'block' : 'none';
  renderLog();

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
    endScreen('OUTBREAK CONTAINED', 'The marines burned it out. The Charon survives.');
  } else if (!ended && !shownLost && sim.tickCount % 30 === 0) {
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
window.__game = { sim, world, player, agents, weapon };
