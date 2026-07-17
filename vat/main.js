// VAT harness main loop (§9): synthetic crowd -> AgentBuffer -> renderer.
// Capture mode measures frame time / memory / draw calls at 50/100/150/200
// instances — the §1 go/no-go gate numbers.

import { VatRenderer } from './renderer.js';
import { CrowdDriver, bufferToInstances } from './driver.js';

const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');
const errEl = document.getElementById('err');
const capturePanel = document.getElementById('capturePanel');

let renderer;
try {
  renderer = await VatRenderer.create(canvas, { maxInstances: 512 });
} catch (e) {
  errEl.style.display = 'flex';
  errEl.textContent = String(e.message || e);
  throw e;
}

const driver = new CrowdDriver(512);
driver.setCount(150);

let orbit = true;
let camAngle = 0.6;
const frameTimes = [];
let last = performance.now();
let lastStats = { drawCalls: 0, lodCounts: [0, 0, 0] };

// capture state machine
let capture = null;

document.querySelectorAll('button[data-n]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('button[data-n]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    driver.setCount(Number(btn.dataset.n));
  });
});
document.getElementById('orbit').addEventListener('click', (e) => {
  orbit = !orbit;
  e.target.classList.toggle('active', orbit);
});
document.getElementById('capture').addEventListener('click', startCapture);

function startCapture() {
  capture = { counts: [50, 100, 150, 200], idx: 0, phase: 'warm', until: performance.now() + 2000, samples: [], results: [] };
  driver.setCount(50);
  capturePanel.style.display = 'block';
  capturePanel.innerHTML = 'capturing… (2s warmup + 5s sample per count)';
}

function stepCapture(now, frameMs) {
  const c = capture;
  if (c.phase === 'warm') {
    if (now >= c.until) { c.phase = 'sample'; c.until = now + 5000; c.samples = []; }
    return;
  }
  c.samples.push(frameMs);
  if (now < c.until) return;
  const sorted = [...c.samples].sort((a, b) => a - b);
  const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
  c.results.push({
    n: c.counts[c.idx],
    avg: c.samples.reduce((s, x) => s + x, 0) / c.samples.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
    worst: sorted[sorted.length - 1],
    memMB: mem,
    drawCalls: lastStats.drawCalls,
  });
  c.idx++;
  if (c.idx < c.counts.length) {
    driver.setCount(c.counts[c.idx]);
    c.phase = 'warm';
    c.until = now + 2000;
  } else {
    finishCapture(c.results);
    capture = null;
  }
}

function finishCapture(results) {
  const gate = results.find((r) => r.n === 150);
  const pass = gate && gate.p95 < 16.7 && (gate.memMB === null || gate.memMB < 2048);
  capturePanel.innerHTML = `
    <b>Capture results</b> — <span class="${pass ? 'gate-pass' : 'gate-fail'}">${pass ? 'GATE PASS (on this machine)' : 'CHECK GATE'}</span>
    <table>
      <tr><th>N</th><th>avg ms</th><th>p95 ms</th><th>worst</th><th>JS heap MB</th><th>draws</th></tr>
      ${results.map((r) => `<tr><td>${r.n}</td><td>${r.avg.toFixed(2)}</td><td>${r.p95.toFixed(2)}</td><td>${r.worst.toFixed(1)}</td><td>${r.memMB === null ? 'n/a' : r.memMB.toFixed(0)}</td><td>${r.drawCalls}</td></tr>`).join('')}
    </table>
    <div style="margin-top:6px;color:#6a7686">gate = p95 &lt; 16.7 ms and &lt; 2 GB working set at 150 instances,
    measured on the reference M2 Air. JS heap ≠ full working set — check the browser task manager for GPU memory.
    <button id="copyJson" style="margin-top:4px">copy JSON</button></div>`;
  document.getElementById('copyJson').addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify({ ua: navigator.userAgent, results }, null, 2));
  });
}

function frame(now) {
  const frameMs = now - last;
  last = now;
  frameTimes.push(frameMs);
  if (frameTimes.length > 90) frameTimes.shift();

  const dt = Math.min(0.1, frameMs / 1000);
  if (orbit) camAngle += dt * 0.12;
  const eye = [Math.sin(camAngle) * 34, 15, Math.cos(camAngle) * 34];
  const buf = driver.tick(dt);
  const instances = bufferToInstances(buf);
  lastStats = renderer.render(instances, { eye, at: [0, 1, 0] });

  if (capture) stepCapture(now, frameMs);

  const avg = frameTimes.reduce((s, x) => s + x, 0) / frameTimes.length;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a (Chrome only)';
  hud.innerHTML = [
    ['instances', buf.count],
    ['frame avg', avg.toFixed(2) + ' ms'],
    ['frame p95', p95.toFixed(2) + ' ms'],
    ['fps', (1000 / avg).toFixed(0)],
    ['draw calls', lastStats.drawCalls],
    ['LOD near/mid/far', lastStats.lodCounts.join(' / ')],
    ['JS heap', mem],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
