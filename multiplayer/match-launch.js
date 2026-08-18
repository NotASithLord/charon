import { sameMatchPayload } from './lobby-state.js';

export const DECISION_OWNER_GRACE_MS = 1_200;

const clone = (state) => ({
  ...state,
  acknowledgements: new Set(state.acknowledgements),
  commitReceipts: new Set(state.commitReceipts),
  goReceipts: new Set(state.goReceipts),
  departed: new Set(state.departed),
  recovery: state.recovery ? { ...state.recovery } : null,
  lastTakeover: state.lastTakeover ? { ...state.lastTakeover } : null,
});

export function createLaunchBarrier({ payload, ownerDid, selfDid, follower = false }) {
  const members = [...payload.members];
  const decisionOrder = [ownerDid, ...members.filter((did) => did !== ownerDid).sort()];
  return Object.freeze({
    payload,
    selfDid,
    decisionOrder,
    decisionOwner: ownerDid,
    decisionTerm: 1,
    phase: 'proposal',
    acknowledgements: new Set(follower ? [] : [selfDid]),
    commitReceipts: new Set(),
    goReceipts: new Set(),
    departed: new Set(),
    recovery: null,
    lastTakeover: null,
  });
}

export const launchControl = (state) => ({
  ...state.payload,
  decisionOwner: state.decisionOwner,
  decisionTerm: state.decisionTerm,
});

export const allAcknowledged = (state) => state.payload.members
  .every((did) => state.acknowledgements.has(did));
export const allCommitReceipts = (state) => state.payload.members
  .every((did) => state.commitReceipts.has(did));
export const allGoReceipts = (state) => state.payload.members
  .every((did) => state.goReceipts.has(did));

const validControl = (state, packet) => sameMatchPayload(packet, state.payload)
  && packet.decisionOwner === state.decisionOwner
  && packet.decisionTerm === state.decisionTerm;

export function reduceLaunchBarrier(current, event, now = Date.now()) {
  const state = clone(current);
  const effects = [];
  let verdict = 'ignored';
  const add = (set, did) => {
    const before = set.size;
    set.add(did);
    return set.size !== before;
  };

  if (event?.type === 'ack') {
    if (state.phase !== 'proposal' || !sameMatchPayload(event.packet, state.payload)
      || !state.payload.members.includes(event.packet.from)) return { state: current, effects, verdict };
    add(state.acknowledgements, event.packet.from);
    verdict = 'accepted';
  } else if (event?.type === 'begin-decision') {
    if (state.phase !== 'proposal' || state.decisionOwner !== state.selfDid || !allAcknowledged(state)) {
      return { state: current, effects, verdict };
    }
    state.phase = 'decision';
    state.commitReceipts.add(state.selfDid);
    verdict = 'accepted';
  } else if (event?.type === 'commit') {
    if (!['proposal', 'decision'].includes(state.phase) || !validControl(state, event.packet)
      || event.packet.from !== state.decisionOwner) return { state: current, effects, verdict };
    state.phase = 'decision';
    state.commitReceipts.add(state.decisionOwner);
    state.commitReceipts.add(state.selfDid);
    state.recovery = null;
    verdict = 'accepted';
    effects.push({ kind: 'commit-receipt', payload: launchControl(state) });
  } else if (event?.type === 'commit-receipt') {
    if (!['decision', 'go', 'launch'].includes(state.phase) || !validControl(state, event.packet)
      || !state.payload.members.includes(event.packet.from)) return { state: current, effects, verdict };
    add(state.commitReceipts, event.packet.from);
    verdict = 'accepted';
  } else if (event?.type === 'begin-go') {
    if (state.phase !== 'decision' || state.decisionOwner !== state.selfDid || !allCommitReceipts(state)) {
      return { state: current, effects, verdict };
    }
    state.phase = 'go';
    state.goReceipts.add(state.selfDid);
    verdict = 'accepted';
  } else if (event?.type === 'go') {
    if (!['decision', 'go'].includes(state.phase) || !validControl(state, event.packet)
      || event.packet.from !== state.decisionOwner) return { state: current, effects, verdict };
    state.phase = 'go';
    state.goReceipts.add(state.decisionOwner);
    state.goReceipts.add(state.selfDid);
    state.recovery = null;
    verdict = 'accepted';
    effects.push({ kind: 'go-receipt', payload: launchControl(state) });
  } else if (event?.type === 'go-receipt') {
    if (!['go', 'launch'].includes(state.phase) || !validControl(state, event.packet)
      || !state.payload.members.includes(event.packet.from)) return { state: current, effects, verdict };
    add(state.goReceipts, event.packet.from);
    verdict = 'accepted';
  } else if (event?.type === 'begin-launch') {
    if (state.phase !== 'go' || state.decisionOwner !== state.selfDid || !allGoReceipts(state)) {
      return { state: current, effects, verdict };
    }
    state.phase = 'launch';
    verdict = 'accepted';
  } else if (event?.type === 'launch') {
    if (!['go', 'launch'].includes(state.phase) || !validControl(state, event.packet)
      || event.packet.from !== state.decisionOwner) return { state: current, effects, verdict };
    state.phase = 'launch';
    state.recovery = null;
    verdict = 'accepted';
    effects.push({ kind: 'deploy', payload: state.payload });
  } else if (event?.type === 'owner-left') {
    if (!['decision', 'go'].includes(state.phase) || event.did !== state.decisionOwner) {
      return { state: current, effects, verdict };
    }
    state.departed.add(event.did);
    state.recovery = { at: now + DECISION_OWNER_GRACE_MS };
    verdict = 'accepted';
  } else if (event?.type === 'tick') {
    if (state.lastTakeover && state.decisionOwner === state.selfDid) {
      effects.push({ kind: 'decision-takeover', payload: state.lastTakeover });
    }
    if (!state.recovery || now < state.recovery.at) return { state: Object.freeze(state), effects, verdict };
    const index = state.decisionOrder.indexOf(state.decisionOwner);
    const nextOwner = state.decisionOrder[index + 1];
    if (!nextOwner) {
      state.phase = 'aborted';
      state.recovery = null;
      verdict = 'accepted';
      return { state: Object.freeze(state), effects, verdict };
    }
    state.decisionOwner = nextOwner;
    state.decisionTerm += 1;
    state.recovery = nextOwner === state.selfDid ? null : { at: now + DECISION_OWNER_GRACE_MS };
    verdict = 'accepted';
    if (nextOwner === state.selfDid) {
      state.lastTakeover = launchControl(state);
      effects.push({ kind: 'decision-takeover', payload: state.lastTakeover });
    }
  } else if (event?.type === 'takeover') {
    const packet = event.packet;
    if (!sameMatchPayload(packet, state.payload) || packet.from !== packet.decisionOwner
      || state.payload.members.includes(packet.decisionOwner) === false) {
      return { state: current, effects, verdict };
    }
    // A peer may have advanced the same frozen rank locally after observing
    // the departure before this retained takeover arrives. Treat the exact
    // announcement as an idempotent receipt and end its recovery timer.
    if (packet.decisionTerm === state.decisionTerm && packet.decisionOwner === state.decisionOwner) {
      state.recovery = null;
      state.lastTakeover = null;
      verdict = 'idempotent';
      return { state: Object.freeze(state), effects, verdict };
    }
    if (packet.decisionTerm <= state.decisionTerm) return { state: current, effects, verdict };
    const currentIndex = state.decisionOrder.indexOf(state.decisionOwner);
    const incomingIndex = state.decisionOrder.indexOf(packet.decisionOwner);
    if (incomingIndex - currentIndex !== packet.decisionTerm - state.decisionTerm) {
      return { state: current, effects, verdict };
    }
    state.decisionOwner = packet.decisionOwner;
    state.decisionTerm = packet.decisionTerm;
    state.recovery = null;
    state.lastTakeover = null;
    verdict = 'accepted';
  }

  return { state: Object.freeze(state), effects, verdict };
}
