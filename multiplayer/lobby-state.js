import { MAX_PLAYERS, seedForScope } from './protocol.js';

const MATCH_SCOPE = /^match-[a-z0-9]{12,48}$/;
const JOIN_NONCE = /^[a-z0-9]{20,48}$/;

export function normalizeLobbyMembers(value) {
  if (!Array.isArray(value)) return null;
  const members = [...new Set(value.filter((did) => typeof did === 'string' && did.length > 0 && did.length <= 160))].sort();
  return members.length >= 1 && members.length <= MAX_PLAYERS ? members : null;
}

export function validLobbyRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

export function createPendingJoin(candidate, nonce, generation, now = Date.now(), ttlMs = 1_500) {
  if (!candidate || typeof candidate.lobbyId !== 'string' || typeof candidate.host !== 'string'
    || !JOIN_NONCE.test(String(nonce)) || !Number.isSafeInteger(generation)
    || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  return Object.freeze({
    lobbyId: candidate.lobbyId,
    host: candidate.host,
    nonce: String(nonce),
    generation,
    expiresAt: now + ttlMs,
  });
}

export function acceptsPendingJoin(pending, packet, selfDid, generation, now = Date.now()) {
  return !!pending && !!packet
    && pending.generation === generation
    && now <= pending.expiresAt
    && packet.member === selfDid
    && packet.lobbyId === pending.lobbyId
    && packet.host === pending.host
    && packet.from === pending.host
    && packet.joinNonce === pending.nonce;
}

export function validateMatchProposal(packet, { expectedMembers, ownerDid, term, revision }) {
  const members = normalizeLobbyMembers(packet?.members);
  const expected = normalizeLobbyMembers(expectedMembers);
  if (!members || !expected || members.length !== expected.length
    || members.some((did, index) => did !== expected[index])
    || packet.from !== ownerDid
    || !Number.isSafeInteger(packet.term) || packet.term < 1 || packet.term !== term
    || packet.revision !== revision
    || !Number.isSafeInteger(packet.attempt) || packet.attempt < 1
    || !Array.isArray(packet.hosts) || packet.hosts.length !== members.length
    || new Set(packet.hosts).size !== members.length
    || packet.hosts.some((did) => typeof did !== 'string' || !members.includes(did))
    || packet.host !== packet.hosts[0]
    || !MATCH_SCOPE.test(packet.scope)
    || packet.seed !== seedForScope(packet.scope)) return null;
  return {
    members,
    hosts: [...packet.hosts],
    scope: packet.scope,
    seed: packet.seed,
    host: packet.host,
    term: packet.term,
    revision: packet.revision,
    attempt: packet.attempt,
  };
}

export function sameMatchPayload(value, expected) {
  return !!value && !!expected
    && value.scope === expected.scope
    && value.seed === expected.seed
    && value.host === expected.host
    && value.term === expected.term
    && value.revision === expected.revision
    && value.attempt === expected.attempt
    && Array.isArray(value.members) && Array.isArray(value.hosts)
    && value.members.join('\u0000') === expected.members.join('\u0000')
    && value.hosts.join('\u0000') === expected.hosts.join('\u0000');
}

export function proposalDisposition(current, highestAttempt, candidate) {
  if (!candidate || !Number.isSafeInteger(candidate.attempt) || candidate.attempt < 1) return 'reject';
  if (current && sameMatchPayload(current, candidate)) return 'duplicate';
  const floor = Math.max(Number.isSafeInteger(highestAttempt) ? highestAttempt : 0, current?.attempt ?? 0);
  return candidate.attempt > floor ? 'replace' : 'stale';
}

export function validateLobbyAbort(packet, {
  ownerDid, lobbyId, term, revision, expectedMembers, pendingPayload = null, selfDid,
}) {
  const members = normalizeLobbyMembers(packet?.members);
  const expected = normalizeLobbyMembers(expectedMembers);
  if (!members || !expected || packet.from !== ownerDid || packet.lobbyId !== lobbyId
    || packet.term !== term
    || packet.revision !== revision || !validLobbyRevision(packet.revision)
    || !Number.isSafeInteger(packet.nextTerm)
    || (packet.nextTerm !== packet.term && packet.nextTerm !== packet.term + 1)
    || !validLobbyRevision(packet.nextRevision)
    || (packet.nextTerm === packet.term && packet.nextRevision !== packet.revision + 1)
    || (packet.nextTerm === packet.term + 1 && packet.nextRevision !== 1)
    || typeof packet.nextOwner !== 'string' || !members.includes(packet.nextOwner)
    || !members.includes(selfDid)
    || members.join('\u0000') !== expected.join('\u0000')
    || (pendingPayload && (packet.attempt !== pendingPayload.attempt
      || packet.revision !== pendingPayload.revision))) return null;
  return {
    members,
    nextOwner: packet.nextOwner,
    nextTerm: packet.nextTerm,
    nextRevision: packet.nextRevision,
  };
}

export function shouldYieldPublicSingleton(ownLobbyId, ownMembers, candidate) {
  const members = normalizeLobbyMembers(ownMembers);
  return !!candidate && members?.length === 1
    && typeof ownLobbyId === 'string'
    && typeof candidate.lobbyId === 'string'
    && candidate.lobbyId < ownLobbyId
    && Array.isArray(candidate.members)
    && candidate.members.length < MAX_PLAYERS;
}
