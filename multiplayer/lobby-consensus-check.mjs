import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  consensusMaintenancePackets,
  createLobbyConsensus,
  LOBBY_CONSENSUS_TIMING,
  reduceLobbyConsensus,
} from './lobby-consensus.js';

const host = 'did:host';
const alpha = 'did:alpha';
const beta = 'did:beta';
const gamma = 'did:gamma';
const lobbyId = 'lobby-aaaaaaaaaaaa';
const nonce = 'abcdefghijklmnopqrst';
const initial = (selfDid) => createLobbyConsensus({
  selfDid, lobbyId, owner: host, term: 1, revision: 1, members: [host, alpha],
});
const step = (state, event, now = 1_000) => reduceLobbyConsensus(state, event, now);

// Admission is provisional until every committed member and the requester
// confirm the exact nonce-bound proposal.
let hostState = initial(host);
let alphaState = initial(alpha);
let betaState = createLobbyConsensus({ selfDid: beta });
let result = step(hostState, { type: 'owner-propose-add', member: beta, joinNonce: nonce });
hostState = result.state;
const accept = result.effects[0].payload;
assert.deepEqual(hostState.members, [alpha, host]);

result = step(alphaState, { type: 'accept', packet: accept });
alphaState = result.state;
const alphaConfirm = { from: alpha, ...result.effects[0].payload };
result = step(betaState, { type: 'accept', packet: accept, pendingJoinMatches: true });
betaState = result.state;
const betaConfirm = { from: beta, ...result.effects[0].payload };

// Wrong sender/nonce, stale and duplicate confirms cannot commit membership.
assert.equal(step(hostState, { type: 'confirm', packet: { ...betaConfirm, from: 'did:forged' } }).effects.length, 0);
assert.equal(step(hostState, { type: 'confirm', packet: { ...betaConfirm, joinNonce: `${nonce}x` } }).effects.length, 0);
hostState = step(hostState, { type: 'confirm', packet: betaConfirm }).state;
assert.deepEqual(hostState.members, [alpha, host]);
result = step(hostState, { type: 'confirm', packet: alphaConfirm });
hostState = result.state;
assert.equal(result.effects[0].kind, 'roster-commit');
assert.deepEqual(hostState.members, [alpha, beta, host]);
const commit = result.effects[0].payload;
assert.equal(step(initial(alpha), { type: 'roster-commit', packet: commit }).verdict, 'ignored');
alphaState = step(alphaState, { type: 'roster-commit', packet: commit }).state;
const alphaMissedAdmissionFinal = alphaState;
result = step(betaState, { type: 'roster-commit', packet: commit });
betaState = result.state;
const admissionAck = { from: beta, ...result.effects[0].payload };
assert.deepEqual(alphaState.members, hostState.members);
assert.deepEqual(betaState.members, hostState.members);
assert.equal(step(betaState, { type: 'roster-commit', packet: commit }).state, betaState);
assert.equal(step(betaState, { type: 'roster-commit', packet: commit }).verdict, 'idempotent');

// Host commits just before the requester's outer deadline, but the commit is
// delayed. The requester cancels its exact accepted token and ignores the late
// commit; the owner rolls back the unacknowledged ghost with a new revision.
const cancellation = {
  from: beta,
  member: beta,
  proposalId: commit.proposalId,
  lobbyId,
  host,
  term: commit.term,
  revision: commit.baseRevision,
  joinNonce: nonce,
};
let timedOutRequester = step(createLobbyConsensus({ selfDid: beta }), {
  type: 'accept', packet: commit, pendingJoinMatches: true,
}, 5_500).state;
timedOutRequester = step(timedOutRequester, {
  type: 'cancel-pending', member: beta, joinNonce: nonce,
}, 6_000).state;
result = step(hostState, { type: 'cancel-pending', ...cancellation }, 6_050);
const rolledBackHost = result.state;
assert.equal(result.verdict, 'accepted');
assert.equal(result.effects[0].kind, 'roster');
assert.deepEqual(rolledBackHost.members, [alpha, host]);
assert.equal(rolledBackHost.revision, commit.revision + 1);
assert.equal(step(timedOutRequester, {
  type: 'roster-commit', packet: commit,
}, 7_000).verdict, 'ignored');
assert.equal(step(rolledBackHost, { type: 'cancel-pending', ...cancellation }).verdict, 'ignored');
assert.equal(step(rolledBackHost, { type: 'admission-ack', packet: admissionAck }).verdict, 'ignored');

// The opposite ordering is safe: once the exact commit acknowledgement wins,
// a delayed cancel cannot remove the now-final member.
result = step(hostState, { type: 'admission-ack', packet: admissionAck });
let acknowledgedHost = result.state;
const admissionFinal = { from: host, ...result.effects[0].payload };
assert.equal(acknowledgedHost.admission, null);
assert.equal(result.effects[0].kind, 'admission-final');
result = step(acknowledgedHost, { type: 'admission-ack', packet: admissionAck });
assert.equal(result.verdict, 'idempotent');
assert.equal(result.effects[0].kind, 'admission-final');
betaState = step(betaState, { type: 'admission-final', packet: admissionFinal }).state;
assert.equal(betaState.lastAdmissionAck, null);
assert.equal(betaState.finalizedAdmission.proposalId, commit.proposalId);
const betaWithFinalizedProof = betaState;
assert.equal(step(acknowledgedHost, { type: 'cancel-pending', ...cancellation }).verdict, 'ignored');
assert.deepEqual(acknowledgedHost.members, [alpha, beta, host]);
alphaState = step(alphaState, { type: 'admission-ack', packet: admissionAck }).state;
hostState = acknowledgedHost;

// A later rejoin has a different proposal id/nonce. Replaying the old retained
// cancel cannot remove it, even though the DID is the same.
const laterNonce = 'zyxwvutsrqponmlkjihg';
let rejoinHost = step(rolledBackHost, {
  type: 'owner-propose-add', member: beta, joinNonce: laterNonce,
}, 8_000).state;
const laterProposal = rejoinHost.pending.proposal;
const laterAlpha = step(createLobbyConsensus({
  selfDid: alpha, lobbyId, owner: host, term: 1,
  revision: rolledBackHost.revision, members: [alpha, host],
}), { type: 'accept', packet: laterProposal }).effects[0].payload;
const laterBeta = step(createLobbyConsensus({ selfDid: beta }), {
  type: 'accept', packet: laterProposal, pendingJoinMatches: true,
}).effects[0].payload;
rejoinHost = step(rejoinHost, { type: 'confirm', packet: { from: alpha, ...laterAlpha } }).state;
rejoinHost = step(rejoinHost, { type: 'confirm', packet: { from: beta, ...laterBeta } }).state;
assert.equal(rejoinHost.admission.joinNonce, laterNonce);
assert.equal(step(rejoinHost, { type: 'cancel-pending', ...cancellation }).verdict, 'ignored');
assert.deepEqual(rejoinHost.members, [alpha, beta, host]);

// A dropped proposal expires without turning the requester into a member.
let expiring = step(initial(host), { type: 'owner-propose-add', member: beta, joinNonce: nonce }, 5_000).state;
expiring = step(expiring, { type: 'tick' }, 5_001 + LOBBY_CONSENSUS_TIMING.proposalTtlMs).state;
assert.equal(expiring.pending, null);
assert.deepEqual(expiring.members, [alpha, host]);

// The requester cancels its reducer token at the outer discovery deadline.
// A commit delayed into the old 6-8 second window can no longer adopt it.
let cancellingHost = step(initial(host), {
  type: 'owner-propose-add', member: beta, joinNonce: nonce,
}, 20_000).state;
const cancellingProposal = cancellingHost.pending.proposal;
let cancellingBeta = step(createLobbyConsensus({ selfDid: beta }), {
  type: 'accept', packet: cancellingProposal, pendingJoinMatches: true,
}, 20_100).state;
cancellingBeta = step(cancellingBeta, {
  type: 'cancel-pending', member: beta, joinNonce: nonce,
}, 26_000).state;
cancellingHost = step(cancellingHost, {
  type: 'cancel-pending', from: beta, member: beta, joinNonce: nonce,
  proposalId: cancellingProposal.proposalId,
  lobbyId: cancellingProposal.lobbyId,
  host: cancellingProposal.host,
  term: cancellingProposal.term,
  revision: cancellingProposal.baseRevision,
}, 26_000).state;
assert.equal(cancellingHost.pending, null);
assert.equal(cancellingBeta.pending, null);
assert.equal(step(cancellingBeta, {
  type: 'roster-commit', packet: cancellingProposal,
}, 27_000).verdict, 'ignored');

// If the owner leaves after a commit was delivered, members exchange their
// current membership and deterministically elect the same lowest DID/term.
alphaState = step(alphaState, { type: 'owner-left', did: host }, 10_000).state;
betaState = step(betaState, { type: 'owner-left', did: host }, 10_000).state;
const alphaSync = { from: alpha, lobbyId, previousOwner: host, term: 2 };
const betaSync = { from: beta, lobbyId, previousOwner: host, term: 2 };
alphaState = step(alphaState, { type: 'member-sync', packet: betaSync, online: [alpha, beta] }, 10_050).state;
betaState = step(betaState, { type: 'member-sync', packet: alphaSync, online: [alpha, beta] }, 10_050).state;
result = step(alphaState, { type: 'tick' }, 10_051 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs);
alphaState = result.state;
assert.equal(result.effects[0].kind, 'takeover');
const takeover = result.effects[0].payload;
betaState = step(betaState, { type: 'takeover', packet: takeover }, 12_000).state;
assert.deepEqual(betaState.members, alphaState.members);
assert.equal(betaState.owner, alphaState.owner);
assert.equal(betaState.term, 2);

// Alpha misses both the requester ack and the owner's final, then the owner
// dies. Beta remembers the authenticated final and reproves its exact token in
// term 2. An old term-1 cancel is held regardless of whether it arrives before
// or after that proof; alpha finalizes rather than deleting a real member.
let successorAlpha = step(alphaMissedAdmissionFinal, {
  type: 'owner-left', did: host,
}, 17_000).state;
let successorBeta = step(betaWithFinalizedProof, {
  type: 'owner-left', did: host,
}, 17_000).state;
const successorAlphaSync = { from: alpha, lobbyId, previousOwner: host, term: 2 };
const successorBetaSync = { from: beta, lobbyId, previousOwner: host, term: 2 };
successorAlpha = step(successorAlpha, {
  type: 'member-sync', packet: successorBetaSync, online: [alpha, beta],
}, 17_050).state;
successorBeta = step(successorBeta, {
  type: 'member-sync', packet: successorAlphaSync, online: [alpha, beta],
}, 17_050).state;
result = step(successorAlpha, {
  type: 'tick',
}, 17_051 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs);
successorAlpha = result.state;
const successorTakeover = result.effects.find((effect) => effect.kind === 'takeover').payload;
successorBeta = step(successorBeta, {
  type: 'takeover', packet: successorTakeover,
}, 19_000).state;
assert.equal(successorAlpha.owner, alpha);
assert.equal(successorAlpha.admission.resolutionTerm, 2);
assert.equal(successorBeta.lastAdmissionAck.proposalId, commit.proposalId);
const beforeProof = successorAlpha;
assert.equal(step(successorAlpha, {
  type: 'cancel-pending', ...cancellation,
}, 19_100).verdict, 'ignored');
const successorProof = {
  from: beta,
  ...consensusMaintenancePackets(successorBeta)
    .find((effect) => effect.kind === 'admission-ack').payload,
};
result = step(successorAlpha, { type: 'admission-ack', packet: successorProof }, 19_200);
successorAlpha = result.state;
assert.equal(successorAlpha.admission, null);
assert.equal(result.effects[0].kind, 'admission-final');
assert.deepEqual(successorAlpha.members, [alpha, beta]);
assert.equal(step(successorAlpha, {
  type: 'cancel-pending', ...cancellation,
}, 19_300).verdict, 'ignored');
result = step(successorAlpha, { type: 'admission-ack', packet: successorProof }, 19_400);
assert.equal(result.verdict, 'idempotent');
assert.equal(result.effects[0].kind, 'admission-final');

// If the requester has no finalization proof at all, the successor eventually
// rolls the provisional token back instead of blocking the lobby forever.
result = step(beforeProof, {
  type: 'tick',
}, beforeProof.admission.resolveAt);
assert.equal(result.verdict, 'accepted');
assert.equal(result.effects[0].kind, 'roster');
assert.deepEqual(result.state.members, [alpha]);

// A retained final from the departed original owner is still valid after the
// takeover excludes that owner. The successor authenticates it against the
// exact admission lineage instead of treating sender membership as proof.
assert.equal(beforeProof.members.includes(host), false);
assert.equal(beforeProof.owner, alpha);
result = step(beforeProof, {
  type: 'admission-final', packet: admissionFinal,
});
assert.equal(result.verdict, 'accepted');
assert.equal(result.state.admission, null);
assert.deepEqual(result.state.members, [alpha, beta]);
const launcherSource = await readFile(new URL('../game/launcher.js', import.meta.url), 'utf8');
const retainedFinalRoute = launcherSource.indexOf("if (packet.kind === 'admission-final')");
const committedSenderGate = launcherSource.indexOf(
  "if (!lobbyId || packet.lobbyId !== lobbyId || !lobbyMembers.has(packet.from)) return;",
);
assert(retainedFinalRoute >= 0 && committedSenderGate >= 0);
assert(retainedFinalRoute < committedSenderGate);

// With three survivors, a successor that gets no finalization proof rolls the
// provisional member back from both the live roster and durable recovery
// lineage. Late syncs or takeovers cannot resurrect that exact ghost.
const crowdedLobbyId = 'lobby-cccccccccccc';
const crowdedNonce = 'mnopqrstabcdefghijkl';
const crowded = (selfDid) => createLobbyConsensus({
  selfDid,
  lobbyId: crowdedLobbyId,
  owner: host,
  term: 1,
  revision: 1,
  members: [host, alpha, gamma],
});
let crowdedHost = crowded(host);
let crowdedAlpha = crowded(alpha);
let crowdedGamma = crowded(gamma);
let crowdedBeta = createLobbyConsensus({ selfDid: beta });
result = step(crowdedHost, {
  type: 'owner-propose-add', member: beta, joinNonce: crowdedNonce,
}, 50_000);
crowdedHost = result.state;
const crowdedProposal = result.effects[0].payload;
result = step(crowdedAlpha, { type: 'accept', packet: crowdedProposal }, 50_010);
crowdedAlpha = result.state;
const crowdedAlphaConfirm = { from: alpha, ...result.effects[0].payload };
result = step(crowdedGamma, { type: 'accept', packet: crowdedProposal }, 50_010);
crowdedGamma = result.state;
const crowdedGammaConfirm = { from: gamma, ...result.effects[0].payload };
result = step(crowdedBeta, {
  type: 'accept', packet: crowdedProposal, pendingJoinMatches: true,
}, 50_010);
crowdedBeta = result.state;
const crowdedBetaConfirm = { from: beta, ...result.effects[0].payload };
crowdedHost = step(crowdedHost, {
  type: 'confirm', packet: crowdedAlphaConfirm,
}, 50_020).state;
crowdedHost = step(crowdedHost, {
  type: 'confirm', packet: crowdedGammaConfirm,
}, 50_020).state;
result = step(crowdedHost, {
  type: 'confirm', packet: crowdedBetaConfirm,
}, 50_020);
crowdedHost = result.state;
const crowdedCommit = result.effects[0].payload;
crowdedAlpha = step(crowdedAlpha, {
  type: 'roster-commit', packet: crowdedCommit,
}, 50_030).state;
assert.deepEqual(crowdedAlpha.members, [alpha, beta, gamma, host]);

crowdedAlpha = step(crowdedAlpha, {
  type: 'owner-left', did: host,
}, 51_000).state;
const crowdedBetaSync = {
  from: beta, lobbyId: crowdedLobbyId, previousOwner: host, term: 2,
};
const crowdedGammaSync = {
  from: gamma, lobbyId: crowdedLobbyId, previousOwner: host, term: 2,
};
crowdedAlpha = step(crowdedAlpha, {
  type: 'member-sync', packet: crowdedBetaSync, online: [alpha, beta, gamma],
}, 51_010).state;
crowdedAlpha = step(crowdedAlpha, {
  type: 'member-sync', packet: crowdedGammaSync, online: [alpha, beta, gamma],
}, 51_010).state;
result = step(crowdedAlpha, {
  type: 'tick',
}, 51_011 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs);
crowdedAlpha = result.state;
assert.deepEqual(crowdedAlpha.members, [alpha, beta, gamma]);
assert.equal(crowdedAlpha.admission.member, beta);
assert.equal(crowdedAlpha.admission.resolutionTerm, 2);

result = step(crowdedAlpha, {
  type: 'tick',
}, crowdedAlpha.admission.resolveAt);
crowdedAlpha = result.state;
assert.equal(result.verdict, 'accepted');
assert.deepEqual(crowdedAlpha.members, [alpha, gamma]);
assert.equal(crowdedAlpha.recovery.members.includes(beta), false);
assert.equal(crowdedAlpha.recovery.eligible.includes(beta), false);
assert.equal(crowdedAlpha.lastCommit, null);
assert.equal(crowdedAlpha.lastAdmissionAck, null);
assert.equal(crowdedAlpha.lastAdmissionFinal, null);

result = step(crowdedAlpha, {
  type: 'member-sync', packet: crowdedBetaSync, online: [alpha, beta, gamma],
}, 61_000);
assert.equal(result.verdict, 'ignored');
assert.deepEqual(result.state.members, [alpha, gamma]);
const resurrectionTakeover = {
  from: alpha,
  lobbyId: crowdedLobbyId,
  host: alpha,
  previousOwner: host,
  visibility: 'public',
  term: crowdedAlpha.term,
  revision: crowdedAlpha.revision + 1,
  members: [alpha, beta, gamma],
};
result = step(crowdedAlpha, {
  type: 'takeover', packet: resurrectionTakeover, online: [alpha, beta, gamma],
}, 61_010);
assert.equal(result.verdict, 'ignored');
assert.deepEqual(result.state.members, [alpha, gamma]);

// A peer can miss the physical departure event while disconnected. Its
// current authenticated roster plus a committed survivor's next-term sync or
// retained takeover initializes the same recovery, but never while the old
// owner is still online.
const committed = (selfDid) => createLobbyConsensus({
  selfDid, lobbyId, owner: host, term: 1, revision: 2, members: [alpha, beta, host],
});
let missedDeparture = step(committed(beta), {
  type: 'member-sync', packet: alphaSync, online: [alpha, beta],
}, 13_000);
assert.equal(missedDeparture.verdict, 'accepted');
assert.equal(missedDeparture.state.owner, '');
assert.deepEqual(missedDeparture.state.recovery.members, [alpha, beta]);
assert.equal(step(committed(beta), {
  type: 'member-sync', packet: alphaSync, online: [alpha, beta, host],
}, 13_000).verdict, 'ignored');
let takeoverSource = step(committed(alpha), { type: 'owner-left', did: host }, 14_000).state;
takeoverSource = step(takeoverSource, {
  type: 'member-sync', packet: betaSync, online: [alpha, beta],
}, 14_050).state;
const retainedTakeover = step(takeoverSource, {
  type: 'tick',
}, 14_051 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs).effects[0].payload;
missedDeparture = step(committed(beta), {
  type: 'takeover', packet: retainedTakeover, online: [alpha, beta],
}, 16_000);
assert.equal(missedDeparture.verdict, 'accepted');
assert.equal(missedDeparture.state.owner, alpha);
assert.deepEqual(missedDeparture.state.members, [alpha, beta]);
assert.equal(step(committed(beta), {
  type: 'takeover', packet: retainedTakeover, online: [alpha, beta, host],
}, 16_000).verdict, 'ignored');

// A roster member cannot forge a takeover outside an active failover window.
const forgedTakeover = { ...takeover, from: beta, host: beta, members: [beta] };
assert.equal(step(hostState, { type: 'takeover', packet: forgedTakeover }).state, hostState);

// Recovery lineage remains durable after the five-second election window. A
// survivor reconnecting later reactivates sync and a higher canonical takeover
// merges both sides instead of leaving permanent singleton lobbies.
let durableAlpha = step(step(initial(alpha), {
  type: 'accept', packet: accept,
}).state, { type: 'roster-commit', packet: commit }).state;
let durableBeta = step(step(createLobbyConsensus({ selfDid: beta }), {
  type: 'accept', packet: accept, pendingJoinMatches: true,
}).state, { type: 'roster-commit', packet: commit }).state;
durableAlpha = step(durableAlpha, { type: 'owner-left', did: host }, 30_000).state;
durableBeta = step(durableBeta, { type: 'owner-left', did: host }, 30_000).state;
result = step(durableAlpha, { type: 'tick' }, 30_001 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs);
durableAlpha = result.state;
durableBeta = step(durableBeta, { type: 'tick' }, 30_001 + LOBBY_CONSENSUS_TIMING.recoveryLingerMs).state;
durableAlpha = step(durableAlpha, { type: 'tick' }, 30_002 + LOBBY_CONSENSUS_TIMING.recoveryLingerMs).state;
assert.equal(durableAlpha.recovery.active, false);
assert.equal(durableBeta.recovery.active, false);
durableAlpha = step(durableAlpha, {
  type: 'member-sync', packet: { from: beta, lobbyId, previousOwner: host, term: 2 }, online: [alpha, beta],
}, 36_000).state;
durableBeta = step(durableBeta, {
  type: 'member-sync', packet: { from: alpha, lobbyId, previousOwner: host, term: 2 }, online: [alpha, beta],
}, 36_000).state;
result = step(durableAlpha, { type: 'tick' }, 36_001 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs);
durableAlpha = result.state;
durableBeta = step(durableBeta, { type: 'takeover', packet: result.effects[0].payload }, 38_000).state;
assert.deepEqual(durableBeta.members, [alpha, beta]);
assert.equal(durableBeta.term, durableAlpha.term);
assert.equal(durableBeta.revision, durableAlpha.revision);

// Both sides may have already published singleton takeovers before the five
// second window closes. The retained recovery lineage still admits the other
// previously committed member, and the later higher revision converges on the
// canonical lowest member rather than preserving two owners in the same term.
let splitAlpha = step(createLobbyConsensus({
  selfDid: alpha, lobbyId, owner: host, term: 1, revision: 2, members: [alpha, beta, host],
}), { type: 'owner-left', did: host }, 40_000).state;
let splitBeta = step(createLobbyConsensus({
  selfDid: beta, lobbyId, owner: host, term: 1, revision: 2, members: [alpha, beta, host],
}), { type: 'owner-left', did: host }, 40_000).state;
splitAlpha = step(splitAlpha, { type: 'tick' }, 40_001 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs).state;
splitBeta = step(splitBeta, { type: 'tick' }, 40_001 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs).state;
assert.equal(splitAlpha.owner, alpha);
assert.equal(splitBeta.owner, beta);
splitAlpha = step(splitAlpha, { type: 'tick' }, 40_001 + LOBBY_CONSENSUS_TIMING.recoveryLingerMs).state;
splitBeta = step(splitBeta, { type: 'tick' }, 40_001 + LOBBY_CONSENSUS_TIMING.recoveryLingerMs).state;
splitAlpha = step(splitAlpha, {
  type: 'member-sync', packet: betaSync, online: [alpha, beta],
}, 46_000).state;
splitBeta = step(splitBeta, {
  type: 'member-sync', packet: alphaSync, online: [alpha, beta],
}, 46_000).state;
result = step(splitAlpha, { type: 'tick' }, 46_001 + LOBBY_CONSENSUS_TIMING.recoveryGraceMs);
splitAlpha = result.state;
splitBeta = step(splitBeta, { type: 'takeover', packet: result.effects[0].payload }, 48_000).state;
assert.equal(splitBeta.owner, alpha);
assert.deepEqual(splitBeta.members, [alpha, beta]);
assert.equal(splitBeta.revision, splitAlpha.revision);

// Owner-authored departure revisions can only remove existing members.
result = step(hostState, { type: 'owner-remove', member: beta });
assert.deepEqual(result.state.members, [alpha, host]);
alphaState = step(createLobbyConsensus({
  selfDid: alpha, lobbyId, owner: host, term: 1, revision: 2, members: [alpha, beta, host],
}), { type: 'roster', packet: result.effects[0].payload }).state;
assert.deepEqual(alphaState.members, [alpha, host]);

console.log('multiplayer lobby consensus ✓');
