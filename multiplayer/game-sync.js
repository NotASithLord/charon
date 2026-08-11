import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { hurtFloodForm } from '../sim/combat.js';
import { makeAgent } from '../sim/init.js';
import { PROTOCOL_VERSION, peerNumber, validGamePacket } from './protocol.js';

const STATE_HZ = 10;
const SNAPSHOT_HZ = 5;
const SNAPSHOT_LIMIT = 512;
const SIM_BOUND = 1_000;
const WIRE_SCALE = 1_000;
const ACTION_LIMITS = Object.freeze({ hit: 18, shot: 20, explosion: 4 });

const pack = (value) => Math.round(Number(value) * WIRE_SCALE);
const unpack = (value) => value / WIRE_SCALE;
const packedIntegers = (values) => values.every(Number.isSafeInteger);

function actionAllowed(buckets, from, kind, now) {
  const limit = ACTION_LIMITS[kind];
  if (!limit) return true;
  const key = `${from}:${kind}`;
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.started >= 1_000) {
    bucket = { started: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function pointNearSegment(point, start, end, radius) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq <= 0.0001) return false;
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy + (point.z - start.z) * dz) / lengthSq));
  const qx = start.x + dx * t;
  const qy = start.y + dy * t;
  const qz = start.z + dz * t;
  return (point.x - qx) ** 2 + (point.y - qy) ** 2 + (point.z - qz) ** 2 <= radius * radius;
}

function agentRow(agent) {
  const row = [
    agent.id, agent.faction, agent.state, agent.node,
    pack(agent.x), pack(agent.y), agent.deck,
    pack(agent.hp), pack(agent.maxHp), pack(agent.damage),
    pack(agent.heading), pack(agent.animTime), agent.dead ? 1 : 0,
    agent.downed ? 1 : 0, agent.helpless ? 1 : 0, agent.panicked ? 1 : 0,
    pack(agent.meleeUntil ?? -1),
  ];
  const hit = agent.deathImpulse;
  if (hit?.kind === 'melee') row.push(
    pack(hit.dirX), pack(hit.dirY), pack(hit.speed), pack(hit.up), pack(hit.spin), pack(hit.kick),
  );
  return row;
}

function snapshotState(sim, cache, full) {
  const active = sim.agents.filter((agent) => !agent.dead || agent.isPlayer);
  const rows = [];
  const present = new Set();
  for (const agent of active.slice(0, SNAPSHOT_LIMIT)) {
    const row = agentRow(agent);
    const signature = row.join(',');
    present.add(agent.id);
    if (full || cache.get(agent.id) !== signature) rows.push(row);
    cache.set(agent.id, signature);
  }
  const removed = [];
  for (const id of cache.keys()) {
    if (!present.has(id)) {
      cache.delete(id);
      removed.push(id);
    }
  }
  return {
    full,
    complete: active.length <= SNAPSHOT_LIMIT,
    rows,
    removed,
  };
}

function validSnapshotRow(row, graph) {
  return Array.isArray(row) && (row.length === 17 || row.length === 23)
    && packedIntegers(row.slice(0, 12))
    && Number.isSafeInteger(row[0]) && row[0] > 0
    && Number.isInteger(row[1]) && row[1] >= 0 && row[1] <= 6
    && Number.isInteger(row[2]) && row[2] >= 0 && row[2] <= 11
    && Number.isInteger(row[3]) && row[3] >= 0 && row[3] < graph.n
    && Math.abs(row[4]) <= SIM_BOUND * WIRE_SCALE && Math.abs(row[5]) <= SIM_BOUND * WIRE_SCALE
    && Number.isInteger(row[6]) && row[6] >= 1 && row[6] <= 5
    && row[7] >= -1_000 * WIRE_SCALE && row[7] <= 10_000 * WIRE_SCALE
    && row[8] > 0 && row[8] <= 10_000 * WIRE_SCALE
    && row[9] >= 0 && row[9] <= 10_000 * WIRE_SCALE
    && row.slice(12, 16).every((flag) => flag === 0 || flag === 1)
    && Number.isSafeInteger(row[16]) && row[16] >= -WIRE_SCALE && row[16] <= 10_000 * WIRE_SCALE
    && row.slice(17).every((value) => Number.isSafeInteger(value) && Math.abs(value) <= 100 * WIRE_SCALE);
}

export function createGameSync({
  session, world, sim, player, agents, name, members = [], host, hostOrder = [], playerAgents = new Map(),
}) {
  if (!session) return null;
  const allowed = new Set(members);
  const candidates = [...new Set([...hostOrder, host, ...members].filter((did) => allowed.has(did)))];
  let authorityDid = candidates[0] || session.did;
  let authoritySeen = authorityDid === session.did;
  const latestSequence = new Map();
  const lastShots = new Map();
  const actionBuckets = new Map();
  const sendChains = new Map();
  const snapshotCache = new Map();
  const shotStart = new THREE.Vector3();
  const shotEnd = new THREE.Vector3();
  const targetPoint = new THREE.Vector3();
  let sequence = 0;
  let stateAccumulator = 0;
  let snapshotAccumulator = 0;
  let closed = false;
  let lastState = null;
  let lastStateAt = -Infinity;
  let lastFullSnapshotAt = -Infinity;
  const isAuthority = () => session.did === authorityDid;

  const offRoster = session.on('roster', (roster) => {
    const connected = new Set(roster.map((peer) => peer.did).filter((did) => allowed.has(did)));
    if (connected.has(authorityDid)) {
      authoritySeen = true;
      return;
    }
    if (!authoritySeen) return;
    const replacement = candidates.find((did) => connected.has(did));
    if (!replacement || replacement === authorityDid) return;
    authorityDid = replacement;
    authoritySeen = true;
    snapshotCache.clear();
    lastFullSnapshotAt = -Infinity;
  });

  const recipients = () => [...allowed].filter((did) => did !== session.did);
  const send = (kind, payload = {}) => {
    const packet = {
      v: PROTOCOL_VERSION,
      kind,
      from: session.did,
      name,
      seq: ++sequence,
      ...payload,
    };
    return Promise.allSettled(recipients().map((did) => {
      const next = (sendChains.get(did) ?? Promise.resolve())
        .catch(() => {})
        .then(() => session.sendDirect(did, packet));
      sendChains.set(did, next);
      return next;
    }));
  };

  const applyRemotePose = (from, packet) => {
    if (!packedIntegers([packet.x, packet.z, packet.deck, packet.yaw, packet.hp])) return;
    const x = unpack(packet.x);
    const z = unpack(packet.z);
    const yaw = unpack(packet.yaw);
    if (Math.abs(x) > 250 || Math.abs(z) > 250
      || !Number.isInteger(packet.deck) || packet.deck < 1 || packet.deck > 5
      || Math.abs(yaw) > Math.PI * 8) return;
    const agent = playerAgents.get(from);
    if (!agent || agent.dead) return;
    const [simX, simY] = world.worldToSim(x, z, packet.deck);
    agent.x = simX;
    agent.y = simY;
    agent.deck = packet.deck;
    agent.node = world.roomAt(packet.deck, simX, simY, agent.node);
    agent.heading = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
    agent.move = null;
    agent.path.length = 0;
  };

  const applySnapshot = (packet) => {
    if (!Array.isArray(packet.agents) || packet.agents.length > SNAPSHOT_LIMIT
      || !Array.isArray(packet.removed) || packet.removed.length > SNAPSHOT_LIMIT
      || !Number.isSafeInteger(packet.tick) || packet.tick < 0
      || !Number.isSafeInteger(packet.t) || packet.t < 0) return;
    // One malformed entity must not suppress the clock and every otherwise
    // valid entity in the checkpoint. Invalid rows are ignored independently;
    // a partial full snapshot is never allowed to prune unseen local entities.
    const rows = packet.agents.filter((row) => validSnapshotRow(row, sim.graph));
    const complete = packet.complete === true && rows.length === packet.agents.length;
    const live = new Set();
    for (const row of rows) {
      const [id, faction, state, node, x, y, deck, hp, maxHp, damage,
        heading, animTime, dead, downed, helpless, panicked, meleeUntil] = row;
      live.add(id);
      let agent = sim.byId.get(id);
      if (!agent) {
        agent = makeAgent(faction, node, sim.graph);
        agent.id = id;
        sim.spawn(agent);
      }
      const isLocal = agent === player.agent;
      agent.faction = faction;
      agent.state = state;
      if (!isLocal) {
        agent.node = node;
        agent.x = unpack(x);
        agent.y = unpack(y);
        agent.deck = deck;
        agent.heading = unpack(heading);
        agent.move = null;
        agent.path.length = 0;
      }
      agent.hp = unpack(hp);
      agent.maxHp = unpack(maxHp);
      agent.damage = unpack(damage);
      agent.animTime = unpack(animTime);
      agent.meleeUntil = unpack(meleeUntil);
      agent.deathImpulse = row.length === 23 ? {
        kind: 'melee', dirX: unpack(row[17]), dirY: unpack(row[18]),
        speed: unpack(row[19]), up: unpack(row[20]), spin: unpack(row[21]), kick: unpack(row[22]),
      } : null;
      agent.dead = !!dead;
      agent.downed = !!downed;
      agent.helpless = !!helpless;
      agent.panicked = !!panicked;
    }
    for (const id of packet.removed.filter((value) => Number.isSafeInteger(value) && value > 0)) {
      const agent = sim.byId.get(id);
      if (agent && !agent.isPlayer) agent.dead = true;
    }
    if (packet.full === true && complete) {
      for (const agent of sim.agents) {
        if (!agent.isPlayer && !live.has(agent.id)) agent.dead = true;
      }
    }
    if (packet.tick >= sim.tickCount) {
      sim.tickCount = packet.tick;
      sim.t = unpack(packet.t);
    }
    if (Number.isSafeInteger(packet.rng)) sim.rng.s = packet.rng >>> 0;
    if (packet.world && typeof packet.world === 'object') {
      const edgeState = packet.world.edges;
      if (Array.isArray(edgeState) && edgeState.length === sim.graph.edges.length) {
        let lockChanged = false;
        for (let index = 0; index < edgeState.length; index++) {
          const bits = edgeState[index];
          if (!Number.isInteger(bits) || bits < 0 || bits > 3) continue;
          const edge = sim.graph.edges[index];
          const locked = !!(bits & 1);
          if (edge.locked !== locked) { edge.locked = locked; lockChanged = true; }
          edge.burning = !!(bits & 2);
        }
        // cached flow fields read link.locked — the per-tick wipe that used
        // to cover this apply is gone (graph.sweepBurns replaced it)
        if (lockChanged) sim.graph.invalidatePathCache();
      }
      if (packet.world.outcome === null || packet.world.outcome === 'contained' || packet.world.outcome === 'lost') {
        sim.outcome = packet.world.outcome;
      }
      sim.lastStand = !!packet.world.lastStand;
      if (Number.isFinite(packet.world.armoryStock)) sim.armoryStock = packet.world.armoryStock;
      sim.armoryLocked = !!packet.world.armoryLocked;
      if (packet.world.stats && typeof packet.world.stats === 'object') {
        for (const key of Object.keys(sim.stats)) {
          if (Number.isFinite(packet.world.stats[key])) sim.stats[key] = packet.world.stats[key];
        }
      }
    }
    sim._refreshOccupancy?.();
    sim._computeInfluence?.();
    sim.writeBuffer();
  };

  const offDirect = session.on('direct', (message) => {
    const packet = message?.data;
    if (!validGamePacket(packet) || message?.from !== packet.from || packet.from === session.did
      || (allowed.size && !allowed.has(packet.from))) return;
    if (packet.seq <= (latestSequence.get(packet.from) ?? 0)) return;
    latestSequence.set(packet.from, packet.seq);
    if (!actionAllowed(actionBuckets, packet.from, packet.kind, performance.now())) return;

    if (packet.kind === 'state') {
      applyRemotePose(packet.from, packet);
      return;
    }
    if (packet.kind === 'snapshot') {
      if (!isAuthority() && packet.from === authorityDid) applySnapshot(packet);
      return;
    }
    if (packet.kind === 'shot') {
      if (!Array.isArray(packet.fromPos) || !Array.isArray(packet.toPos)
        || !packedIntegers([...packet.fromPos, ...packet.toPos])
        || [...packet.fromPos, ...packet.toPos].some((value) => Math.abs(value) > 500 * WIRE_SCALE)) return;
      shotStart.fromArray(packet.fromPos.map(unpack));
      shotEnd.fromArray(packet.toPos.map(unpack));
      if (shotStart.distanceToSquared(shotEnd) > 110 * 110) return;
      lastShots.set(packet.from, {
        at: performance.now(),
        from: packet.fromPos.map(unpack),
        to: packet.toPos.map(unpack),
      });
      agents.playerShot(shotStart, shotEnd);
      return;
    }
    if (!isAuthority()) return;
    if (packet.kind === 'hit') {
      const shot = lastShots.get(packet.from);
      const target = sim.byId.get(packet.targetId);
      if (!shot || performance.now() - shot.at > 250 || !target || target.dead
        || ![3, 4, 5].includes(target.faction)) return;
      shotStart.fromArray(shot.from);
      shotEnd.fromArray(shot.to);
      const [wx, wz] = world.simToWorld(target.x, target.y, target.deck);
      targetPoint.set(wx, target.faction === 3 ? 0.35 : target.downed ? 0.35 : 0.9, wz);
      const radius = target.faction === 3 ? 0.8 : target.faction === 5 ? 1.3 : 1;
      if (!pointNearSegment(targetPoint, shotStart, shotEnd, radius)) return;
      if (!Number.isSafeInteger(packet.damage)) return;
      hurtFloodForm(sim, target, Math.max(0, Math.min(80, unpack(packet.damage))), false, peerNumber(packet.from));
    } else if (packet.kind === 'explosion') {
      const values = [packet.deck, packet.x, packet.y, packet.radius, packet.damage];
      if (!packedIntegers(values) || !Number.isInteger(packet.deck) || packet.deck < 1 || packet.deck > 5
        || Math.abs(packet.x) > SIM_BOUND * WIRE_SCALE || Math.abs(packet.y) > SIM_BOUND * WIRE_SCALE) return;
      const x = unpack(packet.x);
      const y = unpack(packet.y);
      const sender = playerAgents.get(packet.from);
      if (!sender || sender.deck !== packet.deck || Math.hypot(sender.x - x, sender.y - y) > 60) return;
      const radius = Math.max(0, Math.min(12, unpack(packet.radius)));
      const damage = Math.max(0, Math.min(250, unpack(packet.damage)));
      sim.explodeAt(packet.deck, x, y, radius, damage, peerNumber(packet.from));
      const [wx, wz] = world.simToWorld(x, y, packet.deck);
      agents.noteExplosion(packet.deck, wx, wz, radius);
    }
  });

  return Object.freeze({
    hitFlood(targetId, damage) {
      send('hit', { targetId, damage: pack(damage) });
    },
    explosion(deck, x, y, radius, damage) {
      send('explosion', { deck, x: pack(x), y: pack(y), radius: pack(radius), damage: pack(damage) });
    },
    shot(from, to) {
      send('shot', {
        fromPos: [pack(from.x), pack(from.y), pack(from.z)],
        toPos: [pack(to.x), pack(to.y), pack(to.z)],
      });
    },
    update(dt, now) {
      if (closed) return;
      stateAccumulator += dt;
      if (stateAccumulator >= 1 / STATE_HZ) {
        stateAccumulator %= 1 / STATE_HZ;
        const state = {
          x: pack(player.x), z: pack(player.z), deck: player.deck,
          yaw: pack(player.yaw), hp: pack(player.agent.hp),
        };
        const turn = Math.round(Math.PI * 2 * WIRE_SCALE);
        const halfTurn = Math.round(Math.PI * WIRE_SCALE);
        const yawDelta = lastState
          ? Math.abs((((state.yaw - lastState.yaw + halfTurn) % turn + turn) % turn) - halfTurn)
          : Infinity;
        const changed = !lastState || state.deck !== lastState.deck || state.hp !== lastState.hp
          || Math.abs(state.x - lastState.x) > 15 || Math.abs(state.z - lastState.z) > 15 || yawDelta > 15;
        if (changed || now - lastStateAt >= 1_000) {
          send('state', state);
          lastState = state;
          lastStateAt = now;
        }
      }
      if (isAuthority()) {
        snapshotAccumulator += dt;
        if (snapshotAccumulator >= 1 / SNAPSHOT_HZ) {
          snapshotAccumulator %= 1 / SNAPSHOT_HZ;
          const full = now - lastFullSnapshotAt >= 2_000;
          const snapshot = snapshotState(sim, snapshotCache, full);
          if (full) lastFullSnapshotAt = now;
          send('snapshot', {
            tick: sim.tickCount,
            t: pack(sim.t),
            rng: sim.rng.s >>> 0,
            full: snapshot.full,
            complete: snapshot.complete,
            agents: snapshot.rows,
            removed: snapshot.removed,
            ...(full ? { world: {
              edges: sim.graph.edges.map((edge) => (edge.locked ? 1 : 0) | (edge.burning ? 2 : 0)),
              outcome: sim.outcome,
              lastStand: sim.lastStand,
              armoryStock: sim.armoryStock,
              armoryLocked: sim.armoryLocked,
              stats: { ...sim.stats },
            } } : {}),
          });
        }
      }
    },
    peers: () => session.roster().filter((peer) => !peer.self && allowed.has(peer.did)),
    isAuthority,
    authority: () => authorityDid,
    close() {
      closed = true;
      offDirect();
      offRoster();
      latestSequence.clear();
      lastShots.clear();
      actionBuckets.clear();
      sendChains.clear();
      snapshotCache.clear();
    },
  });
}
