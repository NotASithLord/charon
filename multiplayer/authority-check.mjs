import assert from 'node:assert/strict';
import {
  advanceAuthority, AUTHORITY_ARRIVAL_GRACE_MS, mergeAuthorityElection, packetMatchesAuthority,
} from './authority.js';

const base = {
  selfDid: 'did:b',
  authorityDid: 'did:a',
  authoritySeen: false,
  candidates: ['did:a', 'did:b', 'did:c'],
  connected: ['did:b', 'did:c'],
  graceUntil: AUTHORITY_ARRIVAL_GRACE_MS,
};
assert.deepEqual(advanceAuthority({ ...base, now: AUTHORITY_ARRIVAL_GRACE_MS - 1 }), {
  authorityDid: 'did:a', authoritySeen: false, graceUntil: AUTHORITY_ARRIVAL_GRACE_MS, promoted: false,
});
const promoted = advanceAuthority({ ...base, now: AUTHORITY_ARRIVAL_GRACE_MS });
assert.deepEqual(promoted, {
  authorityDid: 'did:b', authoritySeen: true, graceUntil: AUTHORITY_ARRIVAL_GRACE_MS, promoted: true,
});
// Late arrival of did:a cannot preempt the permanent did:b decision.
assert.deepEqual(advanceAuthority({
  ...base, ...promoted, connected: ['did:a', 'did:b', 'did:c'], now: AUTHORITY_ARRIVAL_GRACE_MS + 1,
}), { authorityDid: 'did:b', authoritySeen: true, graceUntil: AUTHORITY_ARRIVAL_GRACE_MS, promoted: false });
// A previously seen authority fails over immediately, without another grace.
assert.deepEqual(advanceAuthority({
  ...base, authoritySeen: true, now: 1, connected: ['did:c'],
}), { authorityDid: 'did:b', authoritySeen: true, graceUntil: AUTHORITY_ARRIVAL_GRACE_MS, promoted: true });

// Presence skew cannot make did:c skip over the frozen did:b rank. It waits a
// second grace for did:b instead, so all peers make the same permanent step.
assert.deepEqual(advanceAuthority({ ...base, selfDid: 'did:c', connected: ['did:c'], now: AUTHORITY_ARRIVAL_GRACE_MS }), {
  authorityDid: 'did:b',
  authoritySeen: false,
  graceUntil: AUTHORITY_ARRIVAL_GRACE_MS * 2,
  promoted: true,
});

const election = {
  authorityDid: 'did:a', authorityTerm: 1, candidates: ['did:a', 'did:b', 'did:c'],
};
assert.deepEqual(mergeAuthorityElection({
  ...election, packet: { from: 'did:b', authority: 'did:b', authorityTerm: 2 },
}), { authorityDid: 'did:b', authorityTerm: 2, accepted: true });
// A peer reconnecting from the older side of a partition adopts the canonical
// higher term even when it missed the intermediate election packet.
assert.deepEqual(mergeAuthorityElection({
  ...election, packet: { from: 'did:c', authority: 'did:c', authorityTerm: 3 },
}), { authorityDid: 'did:c', authorityTerm: 3, accepted: true });
assert.deepEqual(mergeAuthorityElection({
  ...election, authorityDid: 'did:b', authorityTerm: 2,
  packet: { from: 'did:b', authority: 'did:c', authorityTerm: 3 },
}), { authorityDid: 'did:b', authorityTerm: 2, accepted: false });
assert.deepEqual(mergeAuthorityElection({
  ...election, authorityDid: 'did:c', authorityTerm: 3,
  packet: { from: 'did:b', authority: 'did:b', authorityTerm: 2 },
}), { authorityDid: 'did:c', authorityTerm: 3, accepted: false });

// A partition that promoted farther down the frozen order wins on reconnect;
// it remains canonical even on the side where the old authority is physically
// present. Snapshots/actions from that stale side are then rejected even when
// their packet sequence happens to be newer.
const healed = mergeAuthorityElection({
  ...election, authorityDid: 'did:b', authorityTerm: 2,
  packet: { from: 'did:c', authority: 'did:c', authorityTerm: 3 },
});
assert.deepEqual(healed, { authorityDid: 'did:c', authorityTerm: 3, accepted: true });
assert.equal(packetMatchesAuthority(healed, {
  authority: 'did:b', authorityTerm: 2, seq: 999,
}), false);
assert.equal(packetMatchesAuthority(healed, {
  authority: 'did:c', authorityTerm: 3, seq: 1,
}), true);

console.log('multiplayer authority ✓');
