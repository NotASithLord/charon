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
import { MA5, FRAG } from './fps-data.js';
import { GameAudio } from './audio.js';
import { FireFX } from './fx.js';
import { MarineMap } from './map.js';
import { RNG } from '../shared/rng.js';
import { buildRifleViewmodel, GUN_TUNE, RIFLE_MUZZLE } from './rifle-model.js';
import { PhysicsWorld, initRapier, PHYS_DT } from '../physics/physics-world.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 18, 60);

const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 220);

const hemi = new THREE.HemisphereLight(0x9fb2d0, 0x141821, 1.4);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x7d879e, 1.1);
scene.add(ambient);
const lamp = new THREE.PointLight(0xcfe0ff, 15, 18, 1.8);
scene.add(lamp);
// FLASHLIGHT (user rule): in flood-held darkness this is all you have. In
// spore fog its throw clamps to a few meters instead of the whole room.
const torch = new THREE.SpotLight(0xeaf2ff, 0, 30, 0.46, 0.45, 1.2);
const torchTarget = new THREE.Object3D();
scene.add(torch, torchTarget);
torch.target = torchTarget;

// --- boot: random ship every run unless a seed is pinned in the URL
// (?seed=... for a reproducible one), starting flood kept light (20
// infection forms, no combat forms/carriers yet) ---
const seedFromUrl = new URLSearchParams(location.search).get('seed');
const seed = seedFromUrl || 'run-' + Math.random().toString(36).slice(2, 10);
const sim = new Sim(seed);
const world = new World(scene, sim.graph, seed);
const agents = new Agents3D(scene, sim, world);

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
const fire = new FireFX(scene);
for (let i = 0; i < sim.fires.length; i++) {
  const f = sim.fires[i];
  const [fx2, fz2] = world.simToWorld(f.x, f.y, f.deck);
  fire.add(`sim${i}`, fx2, fz2, elevOf(f.deck), f.scale);
}
// burning broken doors glow hot
for (const d of world.doors) {
  if (d.edge.burning) {
    d.mesh.material.color.setHex(0x8a4020);
    d.mesh.material.emissive.setHex(0xff5510);
    d.mesh.material.emissiveIntensity = 0.9;
  }
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
const muzzleFlash = new THREE.PointLight(0xffd9a0, 0, 7, 2);
scene.add(muzzleFlash);
const wallSpark = new THREE.PointLight(0xffb060, 0, 4, 2.4);
scene.add(wallSpark);
const wallRay = new THREE.Raycaster();

// --- HUD ---
const el = (id) => document.getElementById(id);
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
// FOG OF WAR FOR THE FEED (user rule): the GAME's ship log never narrates
// the flood's mind. Flood-POV events are dropped outright, or replaced by
// what a crew would actually perceive — screams, noises, something stirring.
// The sim debug page keeps the full omniscient log.
const _ominousAt = {};
function gameLogView(e) {
  const room = e.node >= 0 ? sim.graph.node(e.node).name : null;
  const throttle = (key, sec = 20) => {
    if (e.t - (_ominousAt[key] ?? -999) < sec) return false;
    _ominousAt[key] = e.t;
    return true;
  };
  switch (e.type) {
    case 'hive': case 'carrier': case 'bait': case 'vent':
      return null; // the hive does not report to the bridge
    case 'ambush':
      return e; // a sprung ambush IS seen/heard by whoever's there — show it (user request)
    case 'convert':
      if (!room || !throttle('c' + e.node)) return null;
      return { t: e.t, type: 'radio', msg: e.msg.includes('taken')
        ? `screams heard from ${room}` : `strange noises reported from ${room}` };
    case 'rampage':
      if (!room || !throttle('m' + e.node, 15)) return null;
      return { t: e.t, type: 'combat', msg: `heavy movement reported near ${room}` };
    case 'revive': case 'reanimate':
      if (!room || !throttle('r' + e.node)) return null;
      return { t: e.t, type: 'radio', msg: `something stirs in ${room}` };
    case 'duct':
      // thin the duct chatter (user): the crew only calls in about half of
      // what they hear in the ductwork — a coin flip per event, rolled once
      // (each event passes through here exactly once)
      return Math.random() < 0.5 ? e : null;
    default:
      return e;
  }
}
function renderLog() {
  const log = el('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let added = false;
  while (lastEvent < sim.events.length) {
    const e = gameLogView(sim.events[lastEvent++]);
    if (!e) continue;
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
let fragPressed = false;
let frags = FRAG.count;
window.addEventListener('keydown', (e) => {
  if (!introGone) return; // still on the briefing — keys only skip the typing
  if (e.code === 'KeyR') reloadPressed = true;
  if (e.code === 'KeyF') meleePressed = true;
  if (e.code === 'KeyG') fragPressed = true;
  if (e.code === 'KeyM') toggleMap();
  // FIRETEAM ORDERS (review P1): the sim's command layer, on your keys
  if (!player.dead && player.locked) {
    if (e.code === 'Digit1') setOrder('follow');
    else if (e.code === 'Digit2') setOrder('hold');
    else if (e.code === 'Digit3') setOrder('advance');
  }
});

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
const boomLight = new THREE.PointLight(0xffc890, 0, 22, 1.6);
scene.add(boomLight);
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
  for (let i = trkState.phantoms.length - 1; i >= 0; i--) {
    if (now >= trkState.phantoms[i].until) trkState.phantoms.splice(i, 1);
  }
}
function drawTracker(now) {
  const R = 75, RANGE = 25;
  trackerUnreliability(now);
  trk.clearRect(0, 0, 150, 150);
  trk.fillStyle = 'rgba(10,16,22,0.75)';
  trk.beginPath(); trk.arc(R, R, 74, 0, Math.PI * 2); trk.fill();
  trk.strokeStyle = 'rgba(110,160,210,0.35)';
  for (const rr of [25, 50, 74]) { trk.beginPath(); trk.arc(R, R, rr, 0, Math.PI * 2); trk.stroke(); }
  if (trkState.static) {
    // the sweep is snow — no contacts paint through it at all
    for (let i = 0; i < 110; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 72;
      const v = 120 + (Math.random() * 110) | 0;
      trk.fillStyle = `rgba(${v},${v + 15},${v + 25},${0.12 + Math.random() * 0.3})`;
      trk.fillRect(R + Math.cos(a) * rr, R + Math.sin(a) * rr, 1 + Math.random() * 2.4, 1 + Math.random() * 1.6);
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
  // phantoms: drawn EXACTLY like real same-deck contacts — indistinguishable
  for (const ph of trkState.phantoms) {
    const tx = R + Math.cos(ph.ang) * ph.dist * 70;
    const ty = R + Math.sin(ph.ang) * ph.dist * 70;
    trk.fillStyle = ph.hostile ? 'rgba(255,72,56,0.95)' : 'rgba(255,214,64,0.95)';
    trk.beginPath(); trk.arc(tx, ty, 3.4, 0, Math.PI * 2); trk.fill();
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
  let offDeckFire = false;
  for (let n = 0; n < g.n; n++) {
    if (sim.tickCount - sim.gunfireTick[n] > 1 || sim.gunfireTick[n] < 5) continue;
    const nd = g.node(n);
    if (nd.deck === player.deck) {
      const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
      firing.push({ n, wx, wz, d: Math.hypot(wx - player.x, wz - player.z) });
    } else if (Math.abs(nd.deck - player.deck) === 1) offDeckFire = true;
  }
  firing.sort((a, b) => a.d - b.d);
  for (const f of firing.slice(0, 3)) audio.play('shotFar', { x: f.wx, z: f.wz }, 0.7, `gun${f.n}`, 220);
  // a battle on another deck is ONE muffled roll through the deckplates
  if (offDeckFire) audio.play('rumble', null, 0.16, 'offdeck', 1400);
  for (let n = 0; n < g.n; n++) {
    if (sim.tickCount - sim.screamTick[n] > 1 || sim.screamTick[n] < 5) continue;
    const nd = g.node(n);
    if (nd.deck !== player.deck) continue;
    const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
    audio.play('scream', { x: wx, z: wz }, 0.7, `scr${n}`, 700);
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
    if (alive) _aliveHumans.set(a.id, { x: a.x, y: a.y, deck: a.deck });
    else if (was) {
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
  // door hisses
  for (const ev of world.doorEvents) {
    if (ev.deck === player.deck) audio.play('door', { x: ev.x, z: ev.z }, 0.7, 'door', 120);
  }
  world.doorEvents.length = 0;
}

// obstacle set for the player's capsule: live, standing bodies on the player's
// deck (dead/downed/other-deck don't block). Radii mirror the old separation
// pass. Handed to the physics world each fixed step.
function playerObstacles() {
  const out = [];
  const R = { 3: 0.32, 4: 0.48, 5: 0.75 };
  const cy = elevOf(player.deck) + 0.9;
  for (const a of sim.agents) {
    if (a.dead || a.isPlayer || a.deck !== player.deck) continue;
    if (a.faction === 6 || a.downed || a.hp <= 0) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    out.push({ id: a.id, x: wx, y: cy, z: wz, radius: R[a.faction] ?? 0.4, half: 0.5 });
  }
  return out;
}

// --- main loop ---
let acc = 0;
let physAcc = 0;
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
      physics.syncBodies(playerObstacles());
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
  soundSweep(now);
  drawTracker(now);
  marineMap.observe();
  if (mapOpen) marineMap.draw(player.agent, player.dead);
  audio.setListener(player.x, player.z, player.yaw);
  audio.alarm(sim.lastStand && !ended);
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
  const inDark = sim.darkAt(player.agent.node);
  const inFog = sim.fogAt(player.agent.node);
  // FLOOD DARKNESS (user rule): inside a held room the world's light dies —
  // your flashlight is all that works. Spore fog closes the flashlight's
  // throw down to a few meters and stains the air green-brown.
  const dimT = Math.min(1, dtReal * 3);
  const ambTarget = inDark ? 0.03 : 1.1;
  const hemiTarget = inDark ? 0.025 : 1.4;
  ambient.intensity += (ambTarget - ambient.intensity) * dimT;
  hemi.intensity += (hemiTarget - hemi.intensity) * dimT;
  lamp.intensity = inDark ? 0.4 : 15 * (0.3 + 0.7 * world.lightLevel(player.agent.node));
  torch.intensity += ((inDark ? 65 : 22) - torch.intensity) * dimT;
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
  syncBurnFires();
  fire.update(dtReal, player.x, player.z);

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
    const pose = player.renderPose(alpha);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(pose.yaw + (shake > 0 ? Math.sin(now * 0.09) * 0.02 * shake : 0));
    camera.rotateX(pose.pitch + (shake > 0 ? Math.sin(now * 0.11) * 0.018 * shake : 0));
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
      hint.textContent = player.queuedTrunk === trunk
        ? 'in line for the ladder — you go next'
        : trunk.edge?.type === 'ladder' && sim.vertBusy(trunk.edge, player.agent.id)
          ? `${kind} busy — L to take the next slot`
          : `L — climb ${kind} ${up ? 'up' : 'down'} to deck ${up ? trunk.upperDeck : trunk.lowerDeck}`;
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
    endScreen('OUTBREAK CONTAINED', 'The marines burned it out. The Saturn Devouring survives.');
  } else if (!ended && !shownLost && sim.tickCount % 30 === 0) {
    const othersAlive = sim.agents.some((a) => !a.dead && a.hp > 0 && !a.isPlayer
      && (a.faction === 0 || a.faction === 1 || a.faction === 2));
    if (!othersAlive) {
      shownLost = true;
      endScreen('THE SATURN DEVOURING IS LOST', 'Every other soul aboard is gone. You are alone with it now.', false);
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug hooks
window.__game = { sim, world, player, agents, weapon };
