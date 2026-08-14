import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { hurtFloodForm } from '../sim/combat.js';
import { makeAgent } from '../sim/init.js';
import { PROTOCOL_VERSION, peerNumber, validGamePacket } from './protocol.js';

const STATE_HZ = 10;
const SNAPSHOT_HZ = 5;
const SNAPSHOT_LIMIT = 512;
const SIM_BOUND = 1_000;
// how far a peer's aim may lag the authority's truth before a hit is refused.
// A form sprints ~6.3 m/s; at a 10 Hz snapshot plus transit its position here
// can legitimately be a couple of metres off what the shooter saw.
const LAG_SLACK_M = 2.2;
const MELEE_SLACK_M = 3.5;
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
    // THE ARC, so a remote peer sees the hop instead of a body skating it flat
    // along the deck. hoverY alone would leave the pose wrong — agents3d reads
    // the LEAPING flag for the tuck/lean and the sim derives that flag from
    // hoverY, so both terms have to be on the wire for the two ends to agree.
    // Two integers per row, and only a body actually in the air is ever
    // non-zero, so the delta cache still suppresses everyone on the floor.
    pack(agent.hoverY ?? 0), agent.leaping ? 1 : 0,
    // player ballistic armor: sim-owned since the co-op death desync, so it
    // has to reach the peer or its HUD would show a buffer it does not have
    pack(agent.armor ?? 0),
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
  // 19 fields, or 25 with a melee death impulse on the tail. The two added at
  // 17/18 are the leap arc (see agentRow); the layout change is why
  // PROTOCOL_VERSION moved — a peer on the old shape rejects every row rather
  // than misreading one.
  return Array.isArray(row) && (row.length === 20 || row.length === 26)
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
    && Number.isSafeInteger(row[17]) && row[17] >= 0 && row[17] <= 100 * WIRE_SCALE // hoverY: up, never down
    && (row[18] === 0 || row[18] === 1)                                             // leaping
    && Number.isSafeInteger(row[19]) && row[19] >= 0 && row[19] <= 1_000 * WIRE_SCALE // armor
    && row.slice(20).every((value) => Number.isSafeInteger(value) && Math.abs(value) <= 100 * WIRE_SCALE);
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
  const peerNames = new Map();
  const talkingUntil = new Map();
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
    // SIM_BOUND, not a hand-typed 250 (user: "the flood don't seem to
    // recognize and attack player 2"). World X runs 110 -> 389 on this hull —
    // a quarter of the ship's rooms sit beyond 250 — so every pose packet
    // from a peer who walked aft was silently dropped. Their body froze on
    // the host at the last accepted spot and the flood kept hunting that
    // ghost, which is exactly "the flood ignores player 2". Same bound the
    // snapshot rows already validate against.
    if (Math.abs(x) > SIM_BOUND || Math.abs(z) > SIM_BOUND
      || !Number.isInteger(packet.deck) || packet.deck < 1 || packet.deck > 5
      || Math.abs(yaw) > Math.PI * 8) return;
    // the speaking bit rides the pose packet; hold it briefly so the
    // indicator does not strobe between syllables
    if (packet.talk === 1) talkingUntil.set(from, performance.now() + 900);
    else if (packet.talk === 0) talkingUntil.delete(from);
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
        heading, animTime, dead, downed, helpless, panicked, meleeUntil, hoverY, leaping, armor] = row;
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
        // part of the pose, like the heading: without these a remote peer
        // planted every flood form on the deck and the arc read as a skate.
        agent.hoverY = unpack(hoverY);
        agent.leaping = leaping === 1;
        agent.move = null;
        agent.path.length = 0;
      }
      agent.hp = unpack(hp);
      agent.maxHp = unpack(maxHp);
      agent.damage = unpack(damage);
      agent.animTime = unpack(animTime);
      agent.meleeUntil = unpack(meleeUntil);
      agent.armor = unpack(armor);
      agent.deathImpulse = row.length === 26 ? {
        kind: 'melee', dirX: unpack(row[20]), dirY: unpack(row[21]),
        speed: unpack(row[22]), up: unpack(row[23]), spin: unpack(row[24]), kick: unpack(row[25]),
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
      if (packet.world.outcomeAt === null) sim.outcomeAt = null;
      else if (Number.isSafeInteger(packet.world.outcomeAt)) sim.outcomeAt = unpack(packet.world.outcomeAt);
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
    // ROLL THE MOTION BASELINE. beginTick (pos -> prev) lives at the top of
    // Sim.tick, and a peer never ticks — so prevX/prevY stayed frozen at
    // spawn and every contact read as "moved a hundred metres this frame".
    // The motion tracker ANDs that delta with FLAG.MOVING, so on a peer it
    // painted every standing body, which is exactly what the flag was added
    // to stop. One checkpoint to the next is the right baseline here.
    sim.buffer?.beginTick?.();
    sim.writeBuffer();
  };

  const offDirect = session.on('direct', (message) => {
    const packet = message?.data;
    if (!validGamePacket(packet) || message?.from !== packet.from || packet.from === session.did
      || (allowed.size && !allowed.has(packet.from))) return;
    if (packet.seq <= (latestSequence.get(packet.from) ?? 0)) return;
    latestSequence.set(packet.from, packet.seq);
    // remember what this peer calls itself — the HUD puts it over their head
    if (typeof packet.name === 'string' && packet.name) {
      peerNames.set(packet.from, packet.name.slice(0, 18));
    }
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
      const target = sim.byId.get(packet.targetId);
      if (!target || target.dead || ![3, 4, 5].includes(target.faction)) return;
      if (!Number.isSafeInteger(packet.damage)) return;
      const sender = playerAgents.get(packet.from);
      const [wx, wz] = world.simToWorld(target.x, target.y, target.deck);
      targetPoint.set(wx, target.faction === 3 ? 0.35 : target.downed ? 0.35 : 0.9, wz);
      // LAG IS NOT CHEATING (user: "their bullets don't seem to do damage").
      // The peer aims at where ITS snapshot puts the form; by the time the
      // hit lands here the authority has moved it. The old check tested the
      // ray against a ~1 m body radius with no allowance for that delay, so
      // ordinary hits on anything that was moving got thrown away — and
      // MELEE, which sends no ray at all, was rejected every single time.
      // Both are accepted now: a ray hit inside a lag-widened radius, or a
      // melee kill the sender is physically standing next to. The checks that
      // matter (real target, sane damage, plausible distance) all stand.
      const shot = lastShots.get(packet.from);
      let ok = false;
      if (shot && performance.now() - shot.at <= 400) {
        shotStart.fromArray(shot.from);
        shotEnd.fromArray(shot.to);
        const body = target.faction === 3 ? 0.8 : target.faction === 5 ? 1.3 : 1;
        ok = pointNearSegment(targetPoint, shotStart, shotEnd, body + LAG_SLACK_M);
      }
      if (!ok && sender && sender.deck === target.deck) {
        // point-blank: a rifle butt or a shotgunned form at arm's reach
        ok = Math.hypot(sender.x - target.x, sender.y - target.y) <= MELEE_SLACK_M;
      }
      if (!ok) return;
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
    peerName(did) { return peerNames.get(did) ?? null; },
    peerTalking(did) { return (talkingUntil.get(did) ?? 0) > performance.now(); },
    peerLive(did) { return (latestSequence.get(did) ?? 0) > 0; },
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
          // VOICE ACTIVITY (user: an indicator on when they are speaking).
          // One bit on a packet that is already flying at 10 Hz — no new
          // channel, and it costs nothing when nobody has a mic open.
          talk: player.talking ? 1 : 0,
        };
        const turn = Math.round(Math.PI * 2 * WIRE_SCALE);
        const halfTurn = Math.round(Math.PI * WIRE_SCALE);
        const yawDelta = lastState
          ? Math.abs((((state.yaw - lastState.yaw + halfTurn) % turn + turn) % turn) - halfTurn)
          : Infinity;
        const changed = !lastState || state.deck !== lastState.deck || state.hp !== lastState.hp
          || state.talk !== lastState.talk
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
              // THE CLOCK ON THE END CARD (co-op report: both won, the host's
              // time was 2 s faster). outcomeAt is frozen when the last form
              // goes down; without it on the wire a peer fell back to its own
              // sim.t, which is a checkpoint behind. One number, and both ends
              // read the same run time.
              outcomeAt: sim.outcomeAt === null ? null : pack(sim.outcomeAt),
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
