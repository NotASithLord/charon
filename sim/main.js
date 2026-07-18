// Sim harness UI wiring: run loop with fixed-step accumulator, decoupled
// render (§2.3), seed replay, live master dials (§10).

import { Sim } from './sim.js';
import { Viz, renderStats, renderLog } from './viz.js';
import { CMD } from './commands.js';

const canvas = document.getElementById('canvas');
const statsEl = document.getElementById('stats');
const logEl = document.getElementById('log');

// starting-force composition is an init-time difficulty lever (user note):
// infection forms, combat forms, and carriers each set independently,
// applied on restart
function swarmOverrides() {
  const num = (id, lo, hi, dflt) => {
    const v = Number(document.getElementById(id).value);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
  };
  return {
    flood: {
      initialInfectionForms: num('startInf', 0, 60, 20),
      initialCombatForms: num('startCf', 0, 20, 4),
      initialCarriers: num('startCar', 0, 6, 0),
    },
  };
}

let sim = new Sim(document.getElementById('seed').value, swarmOverrides());
let viz = new Viz(canvas, sim);
let paused = false;
let speed = 1;
let acc = 0;
let last = performance.now();

function applyDials() {
  const lambda = Number(document.getElementById('dialLambda').value);
  const q = Number(document.getElementById('dialQ').value);
  const radio = Number(document.getElementById('dialRadio').value);
  sim.P.belief.decayRatePerSec = lambda;
  sim.P.belief.predictionQuality = q;
  sim.P.radio.marineCallReliability = radio;
  document.getElementById('dialLambdaV').textContent = lambda.toFixed(2);
  document.getElementById('dialQV').textContent = q.toFixed(2);
  document.getElementById('dialRadioV').textContent = radio.toFixed(2);
}

function restart() {
  sim = new Sim(document.getElementById('seed').value.trim() || 'charon-1', swarmOverrides());
  applyDials();
  viz.setSim(sim);
  acc = 0;
  populateCommandUI();
}

// --- tactical command console (companion spec §0/§2) ---
function populateCommandUI() {
  const nodeSel = document.getElementById('cmdNode');
  const doorSel = document.getElementById('cmdDoor');
  const squadSel = document.getElementById('cmdSquad');
  nodeSel.innerHTML = sim.graph.nodes.map((n) => `<option value="${n.idx}">${n.name}</option>`).join('');
  doorSel.innerHTML = sim.graph.edges
    .map((e, i) => e.lockable ? `<option value="${i}">${sim.graph.node(e.a).name}↔${sim.graph.node(e.b).name}</option>` : '')
    .join('');
  squadSel.innerHTML = sim.squads.map((s) => `<option value="${s.id}">squad ${s.id + 1}</option>`).join('');
}

function wireCommandUI() {
  document.getElementById('cmdIssue').addEventListener('click', () => {
    const squadId = Number(document.getElementById('cmdSquad').value);
    const node = Number(document.getElementById('cmdNode').value);
    const type = document.getElementById('cmdType').value;
    if (type === 'RELEASE') sim.issue({ type: CMD.RELEASE, squadId });
    else if (type === 'SET_CALL_POLICY') sim.issue({ type: CMD.SET_CALL_POLICY, squadId, policy: 'ignore' });
    else if (type === 'PATROL') {
      const deck = sim.graph.node(node).deck;
      const route = sim.graph.nodes.filter((n) => n.deck === deck).map((n) => n.idx);
      sim.issue({ type: CMD.PATROL, squadId, route });
    } else sim.issue({ type: CMD[type], squadId, node });
  });
  document.getElementById('cmdSeal').addEventListener('click', () =>
    sim.issue({ type: CMD.SET_DOOR, edgeIdx: Number(document.getElementById('cmdDoor').value), locked: true }));
  document.getElementById('cmdOpen').addEventListener('click', () =>
    sim.issue({ type: CMD.SET_DOOR, edgeIdx: Number(document.getElementById('cmdDoor').value), locked: false }));
  document.getElementById('cmdBurn').addEventListener('click', () =>
    sim.issue({ type: CMD.DESIGNATE_BURN, node: Number(document.getElementById('cmdNode').value) }));
}

function resize() {
  const wrap = document.getElementById('canvasWrap');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
}
window.addEventListener('resize', resize);
resize();

document.getElementById('restart').addEventListener('click', restart);
document.getElementById('randomSeed').addEventListener('click', () => {
  // UI-side randomness only (not sim code) — picks a fresh seed then restarts
  document.getElementById('seed').value = 'run-' + Math.random().toString(36).slice(2, 8);
  restart();
});
document.getElementById('pause').addEventListener('click', (e) => {
  paused = !paused;
  e.target.textContent = paused ? 'run ▶' : 'pause ⏸';
});
document.getElementById('step').addEventListener('click', () => {
  paused = true;
  document.getElementById('pause').textContent = 'run ▶';
  const target = sim.tickCount + sim.strategicEvery; // one full infection round
  while (sim.tickCount < target) sim.tick();
});
document.getElementById('speed').addEventListener('input', (e) => {
  speed = Math.pow(2, Number(e.target.value)); // 0.25x .. 8x
  document.getElementById('speedVal').textContent = speed >= 1 ? `${speed}×` : `${speed.toFixed(2)}×`;
});
document.getElementById('seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') restart(); });
document.getElementById('legendToggle').addEventListener('click', (e) => {
  const hidden = document.getElementById('legend').classList.toggle('hidden');
  e.target.classList.toggle('active', !hidden);
});

for (const d of document.querySelectorAll('#deckBtns button')) {
  d.addEventListener('click', () => {
    document.querySelectorAll('#deckBtns button').forEach((b) => b.classList.remove('active'));
    d.classList.add('active');
    viz.deckFilter = Number(d.dataset.deck);
  });
}
const ov = (id, key) => document.getElementById(id).addEventListener('change', (e) => { viz.overlays[key] = e.target.checked; });
ov('ovInfluence', 'influence'); ov('ovShafts', 'shafts'); ov('ovVents', 'vents');
ov('ovCalls', 'calls'); ov('ovTracker', 'tracker'); ov('ovBeliefs', 'beliefs'); ov('ovLabels', 'labels'); ov('ovConns', 'conns');
for (const id of ['dialLambda', 'dialQ', 'dialRadio']) {
  document.getElementById(id).addEventListener('input', applyDials);
}
applyDials();
populateCommandUI();
wireCommandUI();

function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += dtReal * speed;
    const tickDt = sim.dt;
    let guard = 0;
    while (acc >= tickDt && guard++ < 240) {
      sim.tick();
      acc -= tickDt;
    }
    if (guard >= 240) acc = 0; // fell behind; drop time rather than spiral
  }
  // pass real frame time; the viz smooths agent positions by id (see Viz)
  viz.draw(dtReal * (paused ? 0.4 : Math.max(1, speed)));
  renderStats(sim, statsEl);
  renderLog(sim, logEl);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
