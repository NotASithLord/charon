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
    // REAL-DISTANCE layout (user note): all coordinates are METERS. x is real
    // fore-aft position along the ship; decks are drawn as stacked bands with
    // rooms alternating above/below the deck's corridor line, and every node
    // carries its authored footprint (w × d). Travel time comes from these
    // distances, not from a fixed per-edge constant.
    const LEN = this.data?.playableLengthM ?? 220;
    this.deckHeightM = this.data?.deckHeightM ?? 4.2;
    const BAND = 52, TOP = 18, PADX = 12;
    this.lengthM = LEN;
    this.width = LEN + 2 * PADX;
    this.height = TOP + 5 * BAND + 8;
    this.deckBands = [];
    for (let d = 1; d <= 5; d++) {
      const band = this.nodes.filter((n) => n.deck === d).sort((a, b) => a.foreAft - b.foreAft);
      const y0 = TOP + (d - 1) * BAND;
      this.deckBands.push({ y0, y1: y0 + BAND });
      const yC = y0 + BAND / 2;
      let flip = 1;
      for (const n of band) {
        n.w = n.w ?? 10; n.d = n.d ?? 8;
        n.x = PADX + n.foreAft * LEN;
        if (n.type === 'corridor') { n.y = yC; }
        else { n.y = yC + flip * (2.5 + 1.5 + n.d / 2); flip = -flip; }
        n.r = Math.max(2, Math.min(n.w, n.d) / 2 - 1); // scatter radius inside the room
      }
      // de-overlap same-side rooms along x (deterministic left-to-right push)
      for (const side of [-1, 1]) {
        const row = band.filter((n) => n.type !== 'corridor' && Math.sign(n.y - yC) === side);
        row.sort((a, b) => a.x - b.x);
        for (let i = 1; i < row.length; i++) {
          const minX = row[i - 1].x + row[i - 1].w / 2 + row[i].w / 2 + 2;
          if (row[i].x < minX) row[i].x = minX;
        }
      }
    }
    // per-link real distances: horizontal walk + vertical climb components.
    // Same-deck links measure center-to-center in the deck plane; cross-deck
    // links measure real fore-aft offset plus the deck-height climb (the
    // stacked-band y distance is a drawing artifact, not geometry).
    const measure = (l) => {
      const a = this.nodes[l.a], b = this.nodes[l.b];
      if (a.deck === b.deck) {
        // spaces are ROOMS, not points (user note): the connection is a real
        // doorway on the shared wall. Find where the center-to-center segment
        // leaves rect A and enters rect B; the door sits between those, and
        // the walk is measured through it. flipT is the fraction of the walk
        // at which the mover passes the door — the moment it stops being in
        // space A and starts being in space B.
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = Math.max(0.001, Math.hypot(dx, dy));
        const ux = Math.abs(dx) / L, uy = Math.abs(dy) / L;
        const exitA = Math.min(ux > 1e-6 ? (a.w / 2) / ux : Infinity, uy > 1e-6 ? (a.d / 2) / uy : Infinity);
        const entryB = Math.min(ux > 1e-6 ? (b.w / 2) / ux : Infinity, uy > 1e-6 ? (b.d / 2) / uy : Infinity);
        let doorDist = (exitA + (L - entryB)) / 2; // midpoint of the gap
        if (exitA + entryB >= L) doorDist = L / 2;  // rects touch/overlap
        doorDist = Math.min(L - 0.5, Math.max(0.5, doorDist));
        l.door = { x: a.x + dx / L * doorDist, y: a.y + dy / L * doorDist };
        const lenA = doorDist, lenB = L - doorDist;
        l.flipT = lenA / (lenA + lenB);
        l.horizM = Math.max(3, lenA + lenB);
        l.vertM = 0;
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

  // Shortest path from -> to as [{to, link, layer}] steps, or null.
  path(from, to, layers, passFn) {
    if (from === to) return [];
    const ff = this.flowField([to], layers, passFn);
    if (ff.dist[from] === -1) return null;
    const steps = [];
    let cur = from;
    while (cur !== to) {
      const nxt = ff.next[cur];
      const link = ff.nextLink[cur];
      const layer = link.kind;
      steps.push({ to: nxt, link, layer });
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
