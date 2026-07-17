// Command queue (companion spec §0) — the load-bearing POC requirement.
//
// Every mutation of SHARED sim state that originates from a commander (a
// squad order, a door thrown, a burn designation) enters the sim as a
// command object stamped with a target tick, and the sim applies it from
// this queue on the matching tick. In single-player the queue has one
// producer and ~zero delay, so it's invisible — but it is exactly the shape
// deterministic lockstep needs (§3.10: "the tactical command layer IS the
// lockstep input stream"). Building it now keeps multiplayer a transport
// layer instead of a rewrite.
//
// Ordering is deterministic: (targetTick, peerId, seq). Identical command
// sets execute identically on every peer — the whole point.

export const CMD = {
  // squad orders (companion spec §2.2) — override autonomous behavior
  MOVE_TO: 'MOVE_TO',            // {squadId, node}
  GUARD: 'GUARD',               // {squadId, node}
  HOLD_CHOKE: 'HOLD_CHOKE',     // {squadId, edgeIdx}
  PATROL: 'PATROL',             // {squadId, route: node[]}
  RESPOND: 'RESPOND',           // {squadId, callId}
  SET_CALL_POLICY: 'SET_CALL_POLICY', // {squadId, policy: 'auto'|'ignore'}
  ESCORT: 'ESCORT',             // {squadId, entityId}
  FALL_BACK: 'FALL_BACK',       // {squadId, node}
  RELEASE: 'RELEASE',           // {squadId}
  // ship control (also shared-state mutations, so also commands)
  SET_DOOR: 'SET_DOOR',         // {edgeIdx, locked} — throw a blast door
  DESIGNATE_BURN: 'DESIGNATE_BURN', // {node} — order the flamethrower here
  // post-POC hook: avatar-caused mutations land here as HIT/BURN commands
  // (companion spec §3.6). Left defined so the apply switch is the one place
  // multiplayer wires into.
};

export class CommandQueue {
  constructor() {
    this.pending = []; // [{targetTick, peerId, seq, cmd}]
    this.seq = 0;
    this.log = [];     // applied commands, for the replay/debug trail
  }

  // Stamp and enqueue. peerId defaults to 0 (the local single-player commander).
  enqueue(cmd, targetTick, peerId = 0) {
    this.pending.push({ targetTick, peerId, seq: this.seq++, cmd });
  }

  // Drain every command due on `tick`, in deterministic order. The lockstep
  // barrier (§3.4) lives above this in multiplayer; single-player is never
  // blocked because the sole producer stamps into the future by inputDelay.
  collect(tick) {
    if (!this.pending.length) return [];
    const due = [];
    const keep = [];
    for (const e of this.pending) (e.targetTick <= tick ? due : keep).push(e);
    this.pending = keep;
    due.sort((a, b) => (a.targetTick - b.targetTick) || (a.peerId - b.peerId) || (a.seq - b.seq));
    return due;
  }
}
