// Ship graph: three traversal layers (§3.2), adjacency, flow fields (§6.3),
// and the schematic layout used both for the debug view and for agent
// position interpolation.

export const LAYER = { STD: 'std', SHAFT: 'shaft', VENT: 'vent' };

export class ShipGraph {
  constructor(data) {
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
    }));
    this.shafts = data.maintShafts.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), ambushCorners: e.ambushCorners,
      kind: LAYER.SHAFT,
      // occupants lying in wait per end: corner key `${shaftIdx}:${endNode}`
    }));
    this.vents = data.vents.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), breakable: e.breakable,
      blocked: false, kind: LAYER.VENT,
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
    // schematic space: x by foreAft, y by deck band; rooms alternate above/
    // below their deck's corridor line to avoid overlap
    const W = 1280, DECK_H = 132, TOP = 46, PADX = 90;
    this.width = W;
    this.height = TOP + 5 * DECK_H + 20;
    for (let d = 1; d <= 5; d++) {
      const band = this.nodes.filter((n) => n.deck === d).sort((a, b) => a.foreAft - b.foreAft);
      const yC = TOP + (d - 1) * DECK_H + DECK_H / 2;
      let flip = 1;
      for (const n of band) {
        n.x = PADX + n.foreAft * (W - 2 * PADX);
        if (n.type === 'corridor') { n.y = yC; }
        else { n.y = yC + flip * 44; flip = -flip; }
        n.r = 10 + Math.sqrt(n.capacity) * 3.2; // draw + jitter radius
      }
    }
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
