// Ship graph: three traversal layers (§3.2), adjacency, flow fields (§6.3),
// and the schematic layout used both for the debug view and for agent
// position interpolation.

export const LAYER = { STD: 'std', SHAFT: 'shaft', VENT: 'vent' };
const EDGE_PREFIX = { hatch: 'H', blastdoor: 'B', lift: 'L', ladder: 'K' };

export class ShipGraph {
  constructor(data) {
    this.data = data;
    this.nodes = data.nodes.map((n, i) => ({ ...n, idx: i }));
    this.byId = new Map(this.nodes.map((n) => [n.id, n.idx]));
    this.n = this.nodes.length;

    const idx = (id) => {
      const i = this.byId.get(id);
      if (i === undefined) throw new Error(`unknown node ${id}`);
      return i;
    };

    this.edges = data.edges.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), type: e.type, lockable: e.lockable,
      locked: false, kind: LAYER.STD,
      // strict connection designation for the map (user note): H=hatch,
      // B=blastdoor, L=lift, K=ladder, numbered in load order
      label: EDGE_PREFIX[e.type] + '-' + String(i + 1).padStart(2, '0'),
    }));
    this.shafts = data.maintShafts.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), ambushCorners: e.ambushCorners,
      kind: LAYER.SHAFT, label: 'S-' + String(i + 1).padStart(2, '0'),
      // occupants lying in wait per end: corner key `${shaftIdx}:${endNode}`
    }));
    this.vents = data.vents.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), breakable: e.breakable,
      blocked: false, kind: LAYER.VENT, label: 'V-' + String(i + 1).padStart(2, '0'),
    }));
    // VENT NETWORK (user rule): ducting parallels nearly every doorway — the
    // flood's private topology. Infection AND combat forms crawl it (a
    // combat form squeezes through; a bloated carrier cannot), humans never,
    // and door locks don't apply — so a hive in avoid-and-breed posture
    // almost always has an escape hatch. Auto-generated alongside the
    // authored runs: one duct behind every same-deck doorway.
    {
      const seen = new Set(this.vents.map((v) => `${Math.min(v.a, v.b)}:${Math.max(v.a, v.b)}`));
      for (const e of this.edges) {
        if (this.nodes[e.a].deck !== this.nodes[e.b].deck) continue;
        const key = `${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.vents.push({
          i: this.vents.length, a: e.a, b: e.b, breakable: true,
          blocked: false, kind: LAYER.VENT, label: 'V-' + String(this.vents.length + 1).padStart(2, '0'),
        });
      }
    }

    // adjacency: adj[node] = [{to, link}] where link is an edge/shaft/vent record
    this.adj = { std: this._buildAdj(this.edges), shaft: this._buildAdj(this.shafts), vent: this._buildAdj(this.vents) };

    this.unpowered = new Uint8Array(this.n);
    this.breachNode = -1;
    this.burningUntil = new Float64Array(this.n); // sim-time until which node burns
    // Reserved for post-POC body-gathering blood trails (companion spec §5.4):
    // a decaying per-node/per-edge marker the hive lays while hauling corpses
    // and humans can follow. Left allocated so the mechanic drops in without
    // touching the graph structure; nothing writes these yet.
    this.trailNode = new Float32Array(this.n);
    this.trailEdge = new Float32Array(this.edges.length);
    // carrier hub queries (companion spec §5.4) go through the agent list;
    // corpses already carry stable ids + node, so no extra structure needed.

    this._layout();
  }

  _buildAdj(links) {
    const adj = Array.from({ length: this.n }, () => []);
    for (const l of links) {
      adj[l.a].push({ to: l.b, link: l });
      adj[l.b].push({ to: l.a, link: l });
    }
    return adj;
  }

  _layout() {
    // A REAL DECK PLAN (user note): all coordinates are METERS, and the
    // layout is a contiguous floor plan, not a node diagram. Row hints in
    // the ship data place every space FLUSH against the space it opens into
    // (row 0 = the corridor/bay spine, ±1 = flanking rooms sharing the
    // spine's wall, ±2 = the row behind those). Doors are openings cut into
    // genuinely shared walls; only spaces that can't touch get a short
    // connector throat. This is the plan the 3D world extrudes.
    const LEN = this.data?.playableLengthM ?? 220;
    this.deckHeightM = this.data?.deckHeightM ?? 4.2;
    const BAND = 56, TOP = 18, PADX = 12;
    this.lengthM = LEN;
    this.height = TOP + 5 * BAND + 8;
    this.deckBands = [];
    const stdNeighbors = (idx) => this.edges
      .filter((e) => e.a === idx || e.b === idx)
      .map((e) => this.nodes[e.a === idx ? e.b : e.a]);
    for (let d = 1; d <= 5; d++) {
      const band = this.nodes.filter((n) => n.deck === d);
      const y0 = TOP + (d - 1) * BAND;
      this.deckBands.push({ y0, y1: y0 + BAND });
      const yC = y0 + BAND / 2;
      for (const n of band) { n.w = n.w ?? 10; n.d = n.d ?? 8; n.row = n.row ?? 1; }

      // 1. the spine (row 0): corridors and bay chains on the centerline.
      //    Directly-connected consecutive spine spaces are snapped FLUSH so
      //    a corridor run or the hangar chain is one continuous volume.
      const spine = band.filter((n) => n.row === 0).sort((a, b) => a.foreAft - b.foreAft);
      for (const n of spine) { n.x = PADX + n.foreAft * LEN; n.y = yC; }
      for (let i = 1; i < spine.length; i++) {
        const prev = spine[i - 1], n = spine[i];
        const connected = stdNeighbors(n.idx).some((m) => m.idx === prev.idx);
        if (connected) n.x = prev.x + prev.w / 2 + n.w / 2; // flush, shared wall
        else n.x = Math.max(n.x, prev.x + prev.w / 2 + n.w / 2 + 3); // separate segment
      }

      // 2. rows ±1 then ±2: each room sits flush against the parent it opens
      //    into, x clamped so the shared wall genuinely overlaps
      for (const tier of [1, 2]) {
        for (const side of [1, -1]) {
          const row = band.filter((n) => n.row === side * tier).sort((a, b) => a.foreAft - b.foreAft);
          for (const n of row) {
            const parents = stdNeighbors(n.idx).filter((m) => m.deck === d
              && (tier === 1 ? m.row === 0 : Math.abs(m.row) === tier - 1));
            const p = parents[0] ?? spine[0];
            n.x = PADX + n.foreAft * LEN;
            if (p) {
              n.y = p.y + side * (p.d / 2 + n.d / 2);
              // keep the shared wall real: center within the parent's span
              const lo = p.x - p.w / 2 + Math.min(n.w, p.w) / 2;
              const hi = p.x + p.w / 2 - Math.min(n.w, p.w) / 2;
              n.x = Math.max(lo, Math.min(hi, n.x));
            } else {
              n.y = yC + side * (4 + n.d / 2);
            }
          }
          // de-overlap along x (deterministic left-to-right push, zero gap)
          row.sort((a, b) => a.x - b.x);
          for (let i = 1; i < row.length; i++) {
            const minX = row[i - 1].x + row[i - 1].w / 2 + row[i].w / 2;
            if (row[i].x < minX) row[i].x = minX;
          }
        }
      }
      for (const n of band) n.r = Math.max(2, Math.min(n.w, n.d) / 2 - 1);
    }
    this.width = Math.max(...this.nodes.map((n) => n.x + n.w / 2)) + PADX;
    // per-link real distances: horizontal walk + vertical climb components.
    // Same-deck links measure center-to-center in the deck plane; cross-deck
    // links measure real fore-aft offset plus the deck-height climb (the
    // stacked-band y distance is a drawing artifact, not geometry).
    const measure = (l) => {
      const a = this.nodes[l.a], b = this.nodes[l.b];
      if (a.deck === b.deck) {
        // With the plan contiguous, most connections are an opening cut in a
        // GENUINELY SHARED WALL: find the wall two flush rects share and put
        // the door at the middle of the overlap. Only spaces that don't touch
        // fall back to a short connector throat between their footprints.
        const eps = 0.6, minOv = 1.4;
        const xOv = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const yOv = Math.min(a.y + a.d / 2, b.y + b.d / 2) - Math.max(a.y - a.d / 2, b.y - b.d / 2);
        const yGap = Math.abs(a.y - b.y) - (a.d + b.d) / 2; // negative = overlapping
        const xGap = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
        let door = null;
        if (xOv >= minOv && Math.abs(yGap) < eps) {
          // horizontal shared wall (rooms stacked in depth)
          const wallY = a.y < b.y ? (a.y + a.d / 2 + b.y - b.d / 2) / 2 : (a.y - a.d / 2 + b.y + b.d / 2) / 2;
          const cx = (Math.max(a.x - a.w / 2, b.x - b.w / 2) + Math.min(a.x + a.w / 2, b.x + b.w / 2)) / 2;
          door = { x: cx, y: wallY };
        } else if (yOv >= minOv && Math.abs(xGap) < eps) {
          // vertical shared wall (rooms side by side)
          const wallX = a.x < b.x ? (a.x + a.w / 2 + b.x - b.w / 2) / 2 : (a.x - a.w / 2 + b.x + b.w / 2) / 2;
          const cy = (Math.max(a.y - a.d / 2, b.y - b.d / 2) + Math.min(a.y + a.d / 2, b.y + b.d / 2)) / 2;
          door = { x: wallX, y: cy };
        }
        if (door) {
          l.door = door;
          l.doorA = { ...door };
          l.doorB = { ...door };
          l.shared = true; // a real opening, no throat needed
          const lenA = Math.max(0.5, Math.hypot(a.x - door.x, a.y - door.y));
          const lenB = Math.max(0.5, Math.hypot(b.x - door.x, b.y - door.y));
          l.flipT = lenA / (lenA + lenB);
          l.horizM = Math.max(2, lenA + lenB);
          l.vertM = 0;
        } else {
          // no shared wall: a short throat spans the gap (as before)
          const dx = b.x - a.x, dy = b.y - a.y;
          const L = Math.max(0.001, Math.hypot(dx, dy));
          const ux = Math.abs(dx) / L, uy = Math.abs(dy) / L;
          const exitA = Math.min(ux > 1e-6 ? (a.w / 2) / ux : Infinity, uy > 1e-6 ? (a.d / 2) / uy : Infinity);
          const entryB = Math.min(ux > 1e-6 ? (b.w / 2) / ux : Infinity, uy > 1e-6 ? (b.d / 2) / uy : Infinity);
          let doorDist = (exitA + (L - entryB)) / 2;
          if (exitA + entryB >= L) doorDist = L / 2;
          doorDist = Math.min(L - 0.5, Math.max(0.5, doorDist));
          l.door = { x: a.x + dx / L * doorDist, y: a.y + dy / L * doorDist };
          const tA = Math.min(exitA, doorDist), tB = Math.max(L - entryB, doorDist);
          l.doorA = { x: a.x + dx / L * tA, y: a.y + dy / L * tA };
          l.doorB = { x: a.x + dx / L * tB, y: a.y + dy / L * tB };
          l.shared = false;
          const lenA = doorDist, lenB = L - doorDist;
          l.flipT = lenA / (lenA + lenB);
          l.horizM = Math.max(3, lenA + lenB);
          l.vertM = 0;
        }
      } else {
        l.horizM = Math.max(2, Math.abs(a.x - b.x));
        l.vertM = Math.abs(a.deck - b.deck) * this.deckHeightM;
        l.flipT = 0.5; // handover halfway up/down the trunk
      }
    };
    for (const l of this.edges) measure(l);
    for (const l of this.shafts) measure(l);
    for (const l of this.vents) measure(l);
    // mean std-edge length: the hive's ETA guesses are hop-based
    this.avgStdLenM = this.edges.reduce((s, l) => s + l.horizM + l.vertM, 0) / this.edges.length;
  }

  node(i) { return this.nodes[i]; }
  hasRole(i, role) { return this.nodes[i].roles.includes(role); }
  nodesWithRole(role) { return this.nodes.filter((n) => n.roles.includes(role)).map((n) => n.idx); }

  // Neighbors across a set of layers, filtered by a passability predicate.
  // passFn(link, from, to) -> bool. Layers: array of 'std'|'shaft'|'vent'.
  *neighbors(nodeIdx, layers, passFn) {
    for (const layer of layers) {
      for (const { to, link } of this.adj[layer][nodeIdx]) {
        if (!passFn || passFn(link, nodeIdx, to)) yield { to, link, layer };
      }
    }
  }

  // Multi-source BFS flow field toward `targets`. Returns { dist, next, nextLink }
  // where next[i] is the neighbor one hop closer to a target (-1 if unreachable).
  flowField(targets, layers, passFn) {
    const dist = new Int32Array(this.n).fill(-1);
    const next = new Int32Array(this.n).fill(-1);
    const nextLink = new Array(this.n).fill(null);
    const q = [];
    for (const t of targets) if (dist[t] === -1) { dist[t] = 0; q.push(t); }
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      for (const { to, link } of this.neighbors(cur, layers, passFn)) {
        if (dist[to] === -1) {
          dist[to] = dist[cur] + 1;
          next[to] = cur;       // moving from `to` toward target goes via `cur`
          nextLink[to] = link;
          q.push(to);
        }
      }
    }
    return { dist, next, nextLink, targets: new Set(targets) };
  }

  // Reference walking seconds to cross a link (faction-agnostic, 1.4 m/s).
  // Pathing MUST weigh real time, not hops: with authored distances a
  // "one-hop" 48 m maintenance shaft is a 90-second crawl that hop-count
  // BFS preferred over two 15-second corridor hops — which marched whole
  // packs into shafts and read as "the flood spawns and never moves".
  linkCost(l) {
    const run = l.horizM + l.vertM;
    if (l.kind === 'shaft') return run * 1.35 / 0.7;
    if (l.kind === 'vent') return run * 1.35 / 0.55;
    if (l.type === 'lift') return l.horizM / 1.4 + 10;
    if (l.type === 'ladder') return 1.0 + l.vertM / 1.2; // mount + climb (matches travelSec)
    return run / 1.4 + (l.type === 'blastdoor' ? 2.5 : 0.8);
  }

  // Fastest path from -> to as [{to, link, layer}] steps, or null.
  // Dijkstra over real travel time (deterministic: min-cost, ties by index).
  path(from, to, layers, passFn) {
    if (from === to) return [];
    const n = this.n;
    const dist = new Float64Array(n).fill(Infinity);
    const done = new Uint8Array(n);
    const next = new Int32Array(n).fill(-1);
    const nextLink = new Array(n).fill(null);
    dist[to] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u === -1) break;
      done[u] = 1;
      if (u === from) break;
      for (const { to: v, link } of this.neighbors(u, layers, passFn)) {
        const c = dist[u] + this.linkCost(link);
        if (c < dist[v] - 1e-9) { dist[v] = c; next[v] = u; nextLink[v] = link; }
      }
    }
    if (!Number.isFinite(dist[from])) return null;
    const steps = [];
    let cur = from;
    while (cur !== to) {
      const nxt = next[cur];
      const link = nextLink[cur];
      if (nxt === -1) return null;
      steps.push({ to: nxt, link, layer: link.kind });
      cur = nxt;
    }
    return steps;
  }

  hops(from, to, layers, passFn) {
    const ff = this.flowField([to], layers, passFn);
    return ff.dist[from];
  }

  // All nodes within `maxHops` of `from`.
  nodesWithin(from, maxHops, layers, passFn) {
    const dist = new Int32Array(this.n).fill(-1);
    dist[from] = 0;
    const q = [from];
    const out = [from];
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      if (dist[cur] >= maxHops) continue;
      for (const { to, link } of this.neighbors(cur, layers, passFn)) {
        if (dist[to] === -1) { dist[to] = dist[cur] + 1; q.push(to); out.push(to); }
      }
    }
    return out;
  }
}

// --- passability predicates ---

// Humans: standard edges only, blocked by locks; marines may also take shafts.
export function humanPass(link) {
  return link.kind === LAYER.STD ? !link.locked : false;
}
export function marinePass(link) {
  if (link.kind === LAYER.STD) return !link.locked;
  return link.kind === LAYER.SHAFT;
}
// Flood, ground truth: infection forms use std (unlocked) + vents (unblocked);
// combat/carrier use std (unlocked) + shafts.
export function infectionPass(link) {
  if (link.kind === LAYER.STD) return !link.locked;
  return link.kind === LAYER.VENT && !link.blocked;
}
export function bigFormPass(link) {
  if (link.kind === LAYER.STD) return !link.locked;
  return link.kind === LAYER.SHAFT;
}
export function layersFor(kind) {
  switch (kind) {
    case 'human': return ['std'];
    case 'marine': return ['std', 'shaft'];
    case 'infection': return ['std', 'vent'];
    case 'big': return ['std', 'shaft'];
    default: return ['std'];
  }
}
