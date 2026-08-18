import assert from 'node:assert/strict';
import {
  acceptsPendingJoin,
  createPendingJoin,
  normalizeLobbyMembers,
  proposalDisposition,
  sameMatchPayload,
  shouldYieldPublicSingleton,
  validLobbyRevision,
  validateLobbyAbort,
  validateMatchProposal,
} from './lobby-state.js';
import { seedForScope } from './protocol.js';
import { authorityIsPresent } from './authority.js';

const host = 'did:key:host';
const self = 'did:key:self';
const lobbyId = 'lobby-aaaaaaaaaaaa';
const nonce = 'abcdefghijklmnopqrst';
const pending = createPendingJoin({ lobbyId, host }, nonce, 7, 1_000, 500);
const accept = {
  from: host,
  host,
  member: self,
  lobbyId,
  joinNonce: nonce,
};

assert.equal(acceptsPendingJoin(pending, accept, self, 7, 1_250), true);
assert.equal(acceptsPendingJoin(pending, { ...accept, from: 'did:key:attacker' }, self, 7, 1_250), false);
assert.equal(acceptsPendingJoin(pending, { ...accept, host: 'did:key:attacker' }, self, 7, 1_250), false);
assert.equal(acceptsPendingJoin(pending, { ...accept, joinNonce: 'zzzzzzzzzzzzzzzzzzzz' }, self, 7, 1_250), false);
assert.equal(acceptsPendingJoin(pending, accept, self, 8, 1_250), false);
assert.equal(acceptsPendingJoin(pending, accept, self, 7, 1_501), false);

assert.deepEqual(normalizeLobbyMembers([self, host, self]), [host, self]);
assert.equal(normalizeLobbyMembers([]), null);
assert.equal(normalizeLobbyMembers([host, self, 'did:3', 'did:4', 'did:5']), null);
assert.equal(validLobbyRevision(1), true);
assert.equal(validLobbyRevision(0), false);

const scope = 'match-abcdefghijkl';
const proposalPacket = {
  from: host,
  members: [self, host],
  hosts: [self, host],
  scope,
  seed: seedForScope(scope),
  host: self,
  revision: 3,
  term: 1,
  attempt: 2,
};
const proposal = validateMatchProposal(proposalPacket, {
  expectedMembers: [host, self],
  ownerDid: host,
  revision: 3,
  term: 1,
});
assert.deepEqual(proposal, {
  members: [host, self],
  hosts: [self, host],
  scope,
  seed: seedForScope(scope),
  host: self,
  revision: 3,
  term: 1,
  attempt: 2,
});
assert.equal(validateMatchProposal({ ...proposalPacket, from: 'did:key:attacker' }, {
  expectedMembers: [host, self], ownerDid: host, revision: 3,
  term: 1,
}), null);
assert.equal(validateMatchProposal({ ...proposalPacket, hosts: [self, self] }, {
  expectedMembers: [host, self], ownerDid: host, revision: 3,
  term: 1,
}), null);
assert.equal(validateMatchProposal({ ...proposalPacket, revision: 2 }, {
  expectedMembers: [host, self], ownerDid: host, revision: 3,
  term: 1,
}), null);

assert.equal(sameMatchPayload(proposal, { ...proposal }), true);
assert.equal(sameMatchPayload({ ...proposal, attempt: 1 }, proposal), false);
assert.equal(proposalDisposition(null, 0, { ...proposal, attempt: 1 }), 'replace');
assert.equal(proposalDisposition(proposal, 2, { ...proposal }), 'duplicate');
assert.equal(proposalDisposition({ ...proposal, attempt: 2 }, 2, { ...proposal, attempt: 1 }), 'stale');
assert.equal(proposalDisposition(null, 2, { ...proposal, attempt: 1 }), 'stale');
assert.equal(proposalDisposition({ ...proposal, attempt: 2 }, 2, { ...proposal, attempt: 3 }), 'replace');

const abort = {
  from: host,
  lobbyId,
  members: [self, host],
  revision: 3,
  term: 1,
  attempt: 2,
  nextRevision: 4,
  nextTerm: 1,
  nextOwner: host,
};
const abortContext = {
  ownerDid: host,
  lobbyId,
  revision: 3,
  term: 1,
  expectedMembers: [host, self],
  pendingPayload: proposal,
  selfDid: self,
};
assert.deepEqual(validateLobbyAbort(abort, abortContext), {
  members: [host, self], nextOwner: host, nextTerm: 1, nextRevision: 4,
});
assert.equal(validateLobbyAbort({ ...abort, from: 'did:key:attacker' }, abortContext), null);
assert.equal(validateLobbyAbort({ ...abort, attempt: 1 }, abortContext), null);
assert.equal(validateLobbyAbort({ ...abort, nextRevision: 9 }, abortContext), null);
assert.equal(validateLobbyAbort({ ...abort, lobbyId: 'lobby-bbbbbbbbbbbb' }, abortContext), null);

assert.equal(shouldYieldPublicSingleton('lobby-bbbbbbbbbbbb', [self], {
  lobbyId: 'lobby-aaaaaaaaaaaa', host, members: [host],
}), true);
assert.equal(shouldYieldPublicSingleton('lobby-aaaaaaaaaaaa', [self], {
  lobbyId: 'lobby-bbbbbbbbbbbb', host, members: [host],
}), false);
assert.equal(shouldYieldPublicSingleton('lobby-bbbbbbbbbbbb', [self, host], {
  lobbyId: 'lobby-aaaaaaaaaaaa', host, members: [host],
}), false);

assert.equal(authorityIsPresent(self, [{ did: host }], host), true);
assert.equal(authorityIsPresent(self, [], self), true);
assert.equal(authorityIsPresent(self, [], host), false);

console.log('multiplayer lobby state ✓');
