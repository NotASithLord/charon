import { MAX_PLAYERS } from './protocol.js';
import { normalizeLobbyMembers, validLobbyRevision } from './lobby-state.js';

const NONCE = /^[a-z0-9]{20,48}$/;
const PROPOSAL_TTL_MS = 8_000;
const RECOVERY_GRACE_MS = 1_200;
const RECOVERY_LINGER_MS = 5_000;
const ADMISSION_RESOLUTION_MS = 8_000;

const clonePending = (pending) => pending ? {
  proposal: { ...pending.proposal, members: [...pending.proposal.members] },
  confirmations: [...pending.confirmations],
  expiresAt: pending.expiresAt,
} : null;

const cloneRecovery = (recovery) => recovery ? {
  term: recovery.term,
  previousOwner: recovery.previousOwner,
  members: [...recovery.members],
  eligible: [...recovery.eligible],
  settleAt: recovery.settleAt,
  expiresAt: recovery.expiresAt,
  active: recovery.active !== false,
} : null;

const copy = (state) => ({
  ...state,
  members: [...state.members],
  pending: clonePending(state.pending),
  lastCommit: state.lastCommit ? { ...state.lastCommit, members: [...state.lastCommit.members] } : null,
  lastConfirm: state.lastConfirm ? { ...state.lastConfirm } : null,
  lastAdmissionAck: state.lastAdmissionAck ? { ...state.lastAdmissionAck } : null,
  lastAdmissionFinal: state.lastAdmissionFinal ? { ...state.lastAdmissionFinal } : null,
  finalizedAdmission: state.finalizedAdmission ? { ...state.finalizedAdmission } : null,
  admission: state.admission ? { ...state.admission } : null,
  recovery: cloneRecovery(state.recovery),
});

const versionAfter = (term, revision, state) => term > state.term
  || (term === state.term && revision > state.revision);

export function createLobbyConsensus({
  selfDid,
  lobbyId = '',
  owner = '',
  visibility = 'public',
  term = lobbyId ? 1 : 0,
  revision = lobbyId ? 1 : 0,
  members = lobbyId ? [selfDid] : [],
} = {}) {
  return Object.freeze({
    selfDid: String(selfDid || ''),
    lobbyId: String(lobbyId || ''),
    owner: String(owner || ''),
    visibility: visibility === 'private' ? 'private' : 'public',
    term,
    revision,
    members: normalizeLobbyMembers(members) ?? [],
    pending: null,
    lastCommit: null,
    lastConfirm: null,
    lastAdmissionAck: null,
    lastAdmissionFinal: null,
    finalizedAdmission: null,
    admission: null,
    recovery: null,
  });
}

export function rosterProposalId(value) {
  const members = normalizeLobbyMembers(value?.members);
  if (!members) return '';
  return [
    value.lobbyId,
    value.host,
    value.term,
    value.baseRevision,
    value.revision,
    value.member,
    value.joinNonce,
    members.join(','),
  ].join('|');
}

function validProposal(value) {
  const members = normalizeLobbyMembers(value?.members);
  if (!members || typeof value?.lobbyId !== 'string' || !value.lobbyId
    || typeof value.host !== 'string' || value.from !== value.host
    || !Number.isSafeInteger(value.term) || value.term < 1
    || !validLobbyRevision(value.baseRevision)
    || value.revision !== value.baseRevision + 1
    || typeof value.member !== 'string' || !members.includes(value.member)
    || !NONCE.test(String(value.joinNonce))) return null;
  return { ...value, members, proposalId: rosterProposalId({ ...value, members }) };
}

function applyCommit(state, proposal) {
  const acknowledgement = {
    proposalId: proposal.proposalId,
    lobbyId: proposal.lobbyId,
    host: proposal.host,
    term: proposal.term,
    revision: proposal.revision,
    member: proposal.member,
    joinNonce: proposal.joinNonce,
  };
  return {
    ...state,
    lobbyId: proposal.lobbyId,
    owner: proposal.host,
    visibility: proposal.visibility === 'private' ? 'private' : 'public',
    term: proposal.term,
    revision: proposal.revision,
    members: [...proposal.members],
    pending: null,
    lastCommit: { ...proposal, members: [...proposal.members] },
    lastConfirm: null,
    lastAdmissionAck: proposal.member === state.selfDid ? acknowledgement : null,
    lastAdmissionFinal: null,
    // The owner and existing members retain the exact admission token until
    // the requester proves commit delivery. That lets a later lobby-owner
    // successor honor a retained cancel without confusing it with a rejoin.
    admission: proposal.member !== state.selfDid ? {
      proposalId: proposal.proposalId,
      member: proposal.member,
      joinNonce: proposal.joinNonce,
      lobbyId: proposal.lobbyId,
      host: proposal.host,
      term: proposal.term,
      baseRevision: proposal.baseRevision,
      revision: proposal.revision,
      resolveAt: 0,
      resolutionTerm: proposal.term,
    } : null,
    finalizedAdmission: null,
    recovery: state.recovery ? {
      ...state.recovery,
      members: [...proposal.members],
      eligible: [...new Set([...state.recovery.eligible, ...proposal.members])].sort(),
    } : null,
  };
}

function beginRecovery(state, previousOwner, now) {
  const members = state.members.filter((did) => did !== previousOwner);
  const eligible = [...new Set([
    ...members,
    ...(state.pending?.proposal.members ?? []),
  ])].filter((did) => did !== previousOwner).sort();
  return {
    ...state,
    owner: '',
    members,
    pending: null,
    lastCommit: null,
    recovery: {
      term: state.term + 1,
      previousOwner,
      members: [state.selfDid],
      eligible,
      settleAt: now + RECOVERY_GRACE_MS,
      expiresAt: now + RECOVERY_LINGER_MS,
      active: true,
    },
  };
}

function canInitializeRecovery(state, packet, online) {
  const live = Array.from(online ?? [], String);
  return !state.recovery && !!state.owner && packet?.lobbyId === state.lobbyId
    && packet.previousOwner === state.owner && packet.term === state.term + 1
    && state.members.includes(state.selfDid) && state.members.includes(packet.from)
    && live.includes(packet.from) && !live.includes(state.owner);
}

function withAdmissionResolution(state, now) {
  const next = { ...state };
  if (next.admission && next.term > next.admission.term
    && next.admission.resolutionTerm !== next.term) {
    next.admission = {
      ...next.admission,
      resolveAt: now + ADMISSION_RESOLUTION_MS,
      resolutionTerm: next.term,
    };
  }
  if (next.finalizedAdmission?.member === next.selfDid && next.term > next.finalizedAdmission.term) {
    next.lastAdmissionAck = { ...next.finalizedAdmission };
  }
  return next;
}

function rollbackAdmission(state) {
  const member = state.admission.member;
  const members = state.members.filter((did) => did !== member);
  const recovery = state.recovery ? {
    ...state.recovery,
    members: state.recovery.members.filter((did) => did !== member),
    eligible: state.recovery.eligible.filter((did) => did !== member),
  } : null;
  return {
    state: {
      ...state,
      revision: state.revision + 1,
      members,
      pending: null,
      lastCommit: null,
      lastConfirm: null,
      lastAdmissionAck: null,
      lastAdmissionFinal: null,
      finalizedAdmission: state.finalizedAdmission?.member === member
        ? null : state.finalizedAdmission,
      admission: null,
      recovery,
    },
    roster: {
      from: state.selfDid,
      lobbyId: state.lobbyId,
      host: state.owner,
      visibility: state.visibility,
      term: state.term,
      revision: state.revision + 1,
      members,
    },
  };
}

/**
 * Pure membership/failover reducer. Effects are packets for the caller to
 * publish; outer room envelopes authenticate every `from` at the IO boundary.
 */
export function reduceLobbyConsensus(current, event, now = Date.now()) {
  let state = copy(current);
  const effects = [];
  let verdict = 'ignored';
  const emit = (kind, payload) => effects.push({ kind, payload });

  if (event?.type === 'owner-propose-add') {
    if (!state.lobbyId || state.owner !== state.selfDid || state.pending || state.admission
      || typeof event.member !== 'string' || state.members.includes(event.member)
      || state.members.length >= MAX_PLAYERS || !NONCE.test(String(event.joinNonce))) {
      return { state: current, effects, verdict };
    }
    const proposal = {
      from: state.selfDid,
      lobbyId: state.lobbyId,
      host: state.owner,
      visibility: state.visibility,
      term: state.term,
      baseRevision: state.revision,
      revision: state.revision + 1,
      member: event.member,
      joinNonce: String(event.joinNonce),
      members: [...state.members, event.member].sort(),
    };
    proposal.proposalId = rosterProposalId(proposal);
    state.pending = { proposal, confirmations: [state.selfDid], expiresAt: now + PROPOSAL_TTL_MS };
    state.lastAdmissionFinal = null;
    verdict = 'accepted';
    emit('accept', proposal);
  } else if (event?.type === 'owner-remove') {
    if (state.owner !== state.selfDid || event.member === state.selfDid
      || !state.members.includes(event.member)) return { state: current, effects, verdict };
    const members = state.members.filter((did) => did !== event.member);
    state = {
      ...state,
      revision: state.revision + 1,
      members,
      pending: null,
      lastCommit: null,
      lastConfirm: null,
      lastAdmissionAck: null,
      lastAdmissionFinal: null,
      finalizedAdmission: null,
      admission: state.admission?.member === event.member ? null : state.admission,
      recovery: state.recovery ? {
        ...state.recovery,
        members: state.recovery.members.filter((did) => did !== event.member),
        eligible: state.recovery.eligible.filter((did) => did !== event.member),
      } : null,
    };
    verdict = 'accepted';
    emit('roster', {
      from: state.selfDid,
      lobbyId: state.lobbyId,
      host: state.owner,
      visibility: state.visibility,
      term: state.term,
      revision: state.revision,
      members,
    });
  } else if (event?.type === 'accept') {
    const proposal = validProposal(event.packet);
    if (!proposal || (proposal.term !== state.term && state.lobbyId)
      || (state.lobbyId && (proposal.lobbyId !== state.lobbyId || proposal.host !== state.owner
        || proposal.baseRevision !== state.revision || !state.members.includes(state.selfDid)))
      || (!state.lobbyId && !event.pendingJoinMatches)
      || !proposal.members.includes(state.selfDid)
      || (state.lobbyId && !state.members.every((did) => proposal.members.includes(did)))) {
      return { state: current, effects, verdict };
    }
    state.pending = {
      proposal,
      confirmations: [proposal.host, state.selfDid],
      expiresAt: now + PROPOSAL_TTL_MS,
    };
    state.lastConfirm = {
      proposalId: proposal.proposalId,
      lobbyId: proposal.lobbyId,
      host: proposal.host,
      term: proposal.term,
      revision: proposal.revision,
      member: proposal.member,
      joinNonce: proposal.joinNonce,
    };
    verdict = 'accepted';
    emit('confirm', state.lastConfirm);
  } else if (event?.type === 'confirm') {
    const packet = event.packet;
    const pending = state.pending;
    if (!pending || packet?.proposalId !== pending.proposal.proposalId
      || packet.lobbyId !== pending.proposal.lobbyId || packet.host !== pending.proposal.host
      || packet.term !== pending.proposal.term || packet.revision !== pending.proposal.revision
      || packet.joinNonce !== pending.proposal.joinNonce
      || !pending.proposal.members.includes(packet.from)) return { state: current, effects, verdict };
    pending.confirmations = [...new Set([...pending.confirmations, packet.from])].sort();
    verdict = 'accepted';
    if (state.owner === state.selfDid
      && pending.proposal.members.every((did) => pending.confirmations.includes(did))) {
      const proposal = pending.proposal;
      state = applyCommit(state, proposal);
      emit('roster-commit', proposal);
    }
  } else if (event?.type === 'roster-commit') {
    const proposal = validProposal(event.packet);
    if (proposal && state.lastCommit?.proposalId === proposal.proposalId
      && proposal.term === state.term && proposal.revision === state.revision
      && proposal.members.join('\0') === state.members.join('\0')) {
      if (proposal.member === state.selfDid) emit('admission-ack', state.lastAdmissionAck);
      return { state: current, effects, verdict: 'idempotent' };
    }
    if (!proposal || proposal.from !== proposal.host || !proposal.members.includes(state.selfDid)
      || (state.lobbyId && (proposal.lobbyId !== state.lobbyId || proposal.host !== state.owner))
      || (state.lobbyId && !versionAfter(proposal.term, proposal.revision, state))) {
      return { state: current, effects, verdict };
    }
    // Every recipient, including an existing member, must have accepted and
    // confirmed this exact nonce-bound proposal. A commit that overtakes its
    // accept packet cannot manufacture membership merely because the owner
    // authored it; maintenance will keep retransmitting while the token lives.
    if (!state.pending || proposal.proposalId !== state.pending.proposal.proposalId) {
      return { state: current, effects, verdict };
    }
    state = applyCommit(state, proposal);
    verdict = 'accepted';
    if (proposal.member === state.selfDid) emit('admission-ack', state.lastAdmissionAck);
  } else if (event?.type === 'cancel-pending') {
    const pending = state.pending;
    if (pending && event.member === pending.proposal.member
      && event.joinNonce === pending.proposal.joinNonce
      && (!event.from || (event.from === pending.proposal.member
        && event.proposalId === pending.proposal.proposalId
        && event.lobbyId === pending.proposal.lobbyId
        && event.host === pending.proposal.host
        && event.term === pending.proposal.term
        && event.revision === pending.proposal.baseRevision))) {
      state.pending = null;
      state.lastConfirm = null;
      verdict = 'accepted';
    } else {
      const admission = state.admission;
      if (!admission || state.owner !== state.selfDid
        || event.from !== admission.member || event.member !== admission.member
        || event.joinNonce !== admission.joinNonce
        || event.proposalId !== admission.proposalId || event.lobbyId !== admission.lobbyId
        || event.host !== admission.host || event.term !== admission.term
        || event.revision !== admission.baseRevision) {
        return { state: current, effects, verdict };
      }
      // After owner failover, the original-term cancel races with retained
      // proof that the requester already received and finalized the commit.
      // Never let packet order decide membership: hold it until the bounded
      // term-resolution tick, while the requester reproves its exact token.
      if (state.term > admission.term) return { state: current, effects, verdict };
      const rolled = rollbackAdmission(state);
      state = rolled.state;
      verdict = 'accepted';
      emit('roster', rolled.roster);
      return { state: Object.freeze(state), effects, verdict };
    }
  } else if (event?.type === 'admission-ack') {
    const packet = event.packet;
    const admission = state.admission;
    const exact = (token) => !!token && packet?.from === token.member
      && packet.member === token.member && packet.proposalId === token.proposalId
      && packet.joinNonce === token.joinNonce && packet.lobbyId === token.lobbyId
      && packet.host === token.host && packet.term === token.term
      && packet.revision === token.revision;
    if (exact(admission)) {
      state.admission = null;
      state.lastCommit = null;
      if (state.owner === state.selfDid) {
        state.lastAdmissionFinal = { ...packet };
        emit('admission-final', { ...packet, from: state.selfDid, receiptOwner: state.selfDid });
      }
      verdict = 'accepted';
    } else if (state.owner === state.selfDid && exact(state.lastAdmissionFinal)) {
      emit('admission-final', {
        ...state.lastAdmissionFinal, from: state.selfDid, receiptOwner: state.selfDid,
      });
      verdict = 'idempotent';
    } else {
      return { state: current, effects, verdict };
    }
  } else if (event?.type === 'admission-final') {
    const packet = event.packet;
    const acknowledgement = state.lastAdmissionAck;
    const admission = state.admission;
    const exact = (token) => !!token && packet?.member === token.member
      && packet.proposalId === token.proposalId && packet.joinNonce === token.joinNonce
      && packet.lobbyId === token.lobbyId && packet.host === token.host
      && packet.term === token.term && packet.revision === token.revision;
    const validAuthor = packet?.receiptOwner === packet.from
      && (packet.from === state.owner || packet.from === acknowledgement?.host || packet.from === admission?.host);
    if (!validAuthor || (!exact(acknowledgement) && !exact(admission))) {
      return { state: current, effects, verdict };
    }
    if (exact(acknowledgement)) {
      state.finalizedAdmission = { ...acknowledgement };
      state.lastAdmissionAck = null;
    }
    if (exact(admission)) state.admission = null;
    verdict = 'accepted';
  } else if (event?.type === 'roster') {
    const packet = event.packet;
    const members = normalizeLobbyMembers(packet?.members);
    if (!members || packet.from !== state.owner || packet.host !== state.owner
      || packet.lobbyId !== state.lobbyId || packet.term !== state.term
      || packet.revision <= state.revision || !validLobbyRevision(packet.revision)
      || !members.includes(state.selfDid) || !members.includes(state.owner)
      || members.some((did) => !state.members.includes(did))) return { state: current, effects, verdict };
    state = {
      ...state,
      visibility: packet.visibility === 'private' ? 'private' : 'public',
      revision: packet.revision,
      members,
      pending: null,
      lastCommit: null,
      lastConfirm: null,
      lastAdmissionAck: null,
      lastAdmissionFinal: null,
      finalizedAdmission: null,
      admission: null,
    };
    verdict = 'accepted';
  } else if (event?.type === 'tick') {
    if (state.pending && now > state.pending.expiresAt) state.pending = null;
    if (state.admission && state.owner === state.selfDid && state.term > state.admission.term
      && now >= state.admission.resolveAt) {
      const rolled = rollbackAdmission(state);
      state = rolled.state;
      verdict = 'accepted';
      emit('roster', rolled.roster);
      return { state: Object.freeze(state), effects, verdict };
    }
    if (state.recovery && now > state.recovery.expiresAt) state.recovery.active = false;
    if (state.recovery?.active && now >= state.recovery.settleAt) {
      const members = [...new Set(state.recovery.members)].sort();
      const owner = members[0] || '';
      if (owner === state.selfDid) {
        const revision = state.term === state.recovery.term ? state.revision + 1 : 1;
        const takeover = {
          from: state.selfDid,
          lobbyId: state.lobbyId,
          host: owner,
          previousOwner: state.recovery.previousOwner,
          visibility: state.visibility,
          term: state.recovery.term,
          revision,
          members,
        };
        state = withAdmissionResolution({
          ...state, owner, term: takeover.term, revision, members, pending: null,
        }, now);
        verdict = 'accepted';
        emit('takeover', takeover);
        state.recovery.settleAt = now + RECOVERY_GRACE_MS;
      }
    }
  } else if (event?.type === 'owner-left') {
    if (event.did !== state.owner || !state.members.includes(state.selfDid)) return { state: current, effects, verdict };
    state = beginRecovery(state, event.did, now);
    verdict = 'accepted';
    emit('member-sync', {
      lobbyId: state.lobbyId,
      previousOwner: event.did,
      term: state.recovery.term,
    });
  } else if (event?.type === 'member-sync') {
    const packet = event.packet;
    if (canInitializeRecovery(state, packet, event.online)) {
      state = beginRecovery(state, state.owner, now);
      verdict = 'accepted';
      emit('member-sync', {
        lobbyId: state.lobbyId,
        previousOwner: state.recovery.previousOwner,
        term: state.recovery.term,
      });
    }
    if (!state.recovery || packet?.lobbyId !== state.lobbyId
      || packet.previousOwner !== state.recovery.previousOwner
      || packet.term !== state.recovery.term || typeof packet.from !== 'string'
      || !state.recovery.eligible.includes(packet.from)
      || !event.online?.includes(packet.from)) return { state: current, effects, verdict };
    if (!state.recovery.members.includes(packet.from)) {
      state.recovery.members.push(packet.from);
      state.recovery.members.sort();
      state.recovery.settleAt = now + RECOVERY_GRACE_MS;
      state.recovery.expiresAt = now + RECOVERY_LINGER_MS;
      state.recovery.active = true;
      verdict = 'accepted';
    }
  } else if (event?.type === 'takeover') {
    const packet = event.packet;
    const members = normalizeLobbyMembers(packet?.members);
    if (members && canInitializeRecovery(state, packet, event.online)) {
      state = beginRecovery(state, state.owner, now);
    }
    if (!state.recovery || !members || packet.lobbyId !== state.lobbyId || packet.from !== packet.host
      || packet.host !== members[0] || !members.includes(state.selfDid)
      || packet.previousOwner !== state.recovery.previousOwner
      || packet.term !== state.recovery.term
      || !Number.isSafeInteger(packet.term) || packet.term < state.term
      || !validLobbyRevision(packet.revision)
      || (packet.term === state.term && packet.revision <= state.revision)
      || (state.recovery && packet.term === state.recovery.term
        && (state.recovery.members.some((did) => !members.includes(did))
          || members.some((did) => !state.recovery.eligible.includes(did))))) {
      return { state: current, effects, verdict };
    }
    state = withAdmissionResolution({
      ...state,
      owner: packet.host,
      visibility: packet.visibility === 'private' ? 'private' : 'public',
      term: packet.term,
      revision: packet.revision,
      members,
      pending: null,
      lastCommit: null,
      recovery: state.recovery && state.recovery.term === packet.term
        ? { ...state.recovery, members: [...new Set([...state.recovery.members, ...members])].sort() }
        : null,
    }, now);
    verdict = 'accepted';
  }

  return { state: Object.freeze(state), effects, verdict };
}

export function consensusMaintenancePackets(state) {
  const packets = [];
  if (state.pending && state.owner === state.selfDid) packets.push({ kind: 'accept', payload: state.pending.proposal });
  if (state.lastConfirm) packets.push({ kind: 'confirm', payload: state.lastConfirm });
  if (state.lastAdmissionAck) packets.push({ kind: 'admission-ack', payload: state.lastAdmissionAck });
  if (state.lastCommit && state.owner === state.selfDid) packets.push({ kind: 'roster-commit', payload: state.lastCommit });
  if (state.recovery?.active) packets.push({
    kind: 'member-sync',
    payload: {
      lobbyId: state.lobbyId,
      previousOwner: state.recovery.previousOwner,
      term: state.recovery.term,
    },
  });
  return packets;
}

export const LOBBY_CONSENSUS_TIMING = Object.freeze({
  proposalTtlMs: PROPOSAL_TTL_MS,
  recoveryGraceMs: RECOVERY_GRACE_MS,
  recoveryLingerMs: RECOVERY_LINGER_MS,
  admissionResolutionMs: ADMISSION_RESOLUTION_MS,
});
