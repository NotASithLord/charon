import assert from 'node:assert/strict';
import {
  allAcknowledged,
  allCommitReceipts,
  allGoReceipts,
  createLaunchBarrier,
  DECISION_OWNER_GRACE_MS,
  launchControl,
  reduceLaunchBarrier,
} from './match-launch.js';

const members = ['did:a', 'did:b', 'did:c'];
const payload = Object.freeze({
  members,
  hosts: [...members],
  scope: 'match-abcdefghijkl',
  seed: 'seed',
  host: 'did:a',
  term: 4,
  revision: 7,
  attempt: 2,
});
const packet = (kind, from, state, extra = {}) => ({
  kind, from, ...launchControl(state), ...extra,
});
const reduce = (state, event, now) => reduceLaunchBarrier(state, event, now);

let owner = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:a' });
for (const from of ['did:b', 'did:c']) {
  owner = reduce(owner, { type: 'ack', packet: packet('ack', from, owner) }).state;
}
assert.equal(allAcknowledged(owner), true);
owner = reduce(owner, { type: 'begin-decision' }).state;

let follower = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:b', follower: true });
// Reordered go/final packets cannot skip the commit barrier.
assert.equal(reduce(follower, { type: 'go', packet: packet('go', 'did:a', owner) }).verdict, 'ignored');
assert.equal(reduce(follower, { type: 'launch', packet: packet('launch', 'did:a', owner) }).verdict, 'ignored');

// The first commit may be dropped. A retransmit is accepted and every duplicate
// deterministically emits another receipt, so a dropped receipt also heals.
let accepted = reduce(follower, { type: 'commit', packet: packet('commit', 'did:a', owner) });
follower = accepted.state;
assert.deepEqual(accepted.effects.map((effect) => effect.kind), ['commit-receipt']);
accepted = reduce(follower, { type: 'commit', packet: packet('commit', 'did:a', owner) });
assert.deepEqual(accepted.effects.map((effect) => effect.kind), ['commit-receipt']);
follower = accepted.state;
for (const from of ['did:b', 'did:c']) {
  owner = reduce(owner, { type: 'commit-receipt', packet: packet('commit-receipt', from, owner) }).state;
}
assert.equal(allCommitReceipts(owner), true);
owner = reduce(owner, { type: 'begin-go' }).state;

// Go is only a prepare. No peer deploys until it has sent a go receipt and
// later observes the retained final launch decision.
accepted = reduce(follower, { type: 'go', packet: packet('go', 'did:a', owner) });
follower = accepted.state;
assert.deepEqual(accepted.effects.map((effect) => effect.kind), ['go-receipt']);
assert.equal(accepted.effects.some((effect) => effect.kind === 'deploy'), false);
accepted = reduce(follower, { type: 'go', packet: packet('go', 'did:a', owner) });
assert.deepEqual(accepted.effects.map((effect) => effect.kind), ['go-receipt']);
for (const from of ['did:b', 'did:c']) {
  owner = reduce(owner, { type: 'go-receipt', packet: packet('go-receipt', from, owner) }).state;
}
assert.equal(allGoReceipts(owner), true);
owner = reduce(owner, { type: 'begin-launch' }).state;
assert.equal(owner.phase, 'launch');

// Simulate every live launch packet being dropped. A later retained-history
// replay is still the one event that permits the follower to deploy.
assert.equal(follower.phase, 'go');
accepted = reduce(follower, { type: 'launch', packet: packet('launch', 'did:a', owner) });
assert.equal(accepted.state.phase, 'launch');
assert.deepEqual(accepted.effects.map((effect) => effect.kind), ['deploy']);

// If the original decision owner dies after prepare, the go receipts already
// prove that every frozen member crossed the no-return barrier. The successor
// retransmits go under its higher term, collects any receipt that was dropped,
// and is the only peer allowed to publish the final launch.
let ownerBeforeDeath = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:a' });
for (const from of ['did:b', 'did:c']) {
  ownerBeforeDeath = reduce(ownerBeforeDeath, {
    type: 'ack', packet: packet('ack', from, ownerBeforeDeath),
  }).state;
}
ownerBeforeDeath = reduce(ownerBeforeDeath, { type: 'begin-decision' }).state;
for (const from of ['did:b', 'did:c']) {
  ownerBeforeDeath = reduce(ownerBeforeDeath, {
    type: 'commit-receipt', packet: packet('commit-receipt', from, ownerBeforeDeath),
  }).state;
}
ownerBeforeDeath = reduce(ownerBeforeDeath, { type: 'begin-go' }).state;
let goB = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:b', follower: true });
let goC = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:c', follower: true });
for (const stateName of ['goB', 'goC']) {
  let state = stateName === 'goB' ? goB : goC;
  state = reduce(state, { type: 'commit', packet: packet('commit', 'did:a', ownerBeforeDeath) }).state;
  for (const from of ['did:b', 'did:c']) {
    state = reduce(state, {
      type: 'commit-receipt', packet: packet('commit-receipt', from, state),
    }).state;
  }
  state = reduce(state, { type: 'go', packet: packet('go', 'did:a', ownerBeforeDeath) }).state;
  if (stateName === 'goB') goB = state;
  else goC = state;
}
goB = reduce(goB, { type: 'owner-left', did: 'did:a' }, 500).state;
goC = reduce(goC, { type: 'owner-left', did: 'did:a' }, 500).state;
const goTakeover = reduce(goB, { type: 'tick' }, 500 + DECISION_OWNER_GRACE_MS);
goB = goTakeover.state;
goC = reduce(goC, { type: 'tick' }, 500 + DECISION_OWNER_GRACE_MS).state;
goC = reduce(goC, {
  type: 'takeover', packet: packet('decision-takeover', 'did:b', goB), online: ['did:b', 'did:c'],
}).state;
const replayedGo = reduce(goC, { type: 'go', packet: packet('go', 'did:b', goB) });
goC = replayedGo.state;
assert.deepEqual(replayedGo.effects.map((effect) => effect.kind), ['go-receipt']);
goB = reduce(goB, {
  type: 'go-receipt', packet: packet('go-receipt', 'did:c', goB),
}).state;
assert.equal(allGoReceipts(goB), true);
goB = reduce(goB, { type: 'begin-launch' }).state;
assert.equal(goB.phase, 'launch');
assert.equal(reduce(goC, {
  type: 'launch', packet: packet('launch', 'did:b', goB),
}).effects[0].kind, 'deploy');

// Partition/owner-death recovery follows the frozen rank, not local presence
// ordering. Both sides advance to B; B's retained takeover clears C's recovery.
let b = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:b', follower: true });
let c = createLaunchBarrier({ payload, ownerDid: 'did:a', selfDid: 'did:c', follower: true });
for (const stateName of ['b', 'c']) {
  let state = stateName === 'b' ? b : c;
  state = reduce(state, { type: 'commit', packet: packet('commit', 'did:a', owner) }).state;
  for (const from of ['did:b', 'did:c']) {
    state = reduce(state, { type: 'commit-receipt', packet: packet('commit-receipt', from, state) }).state;
  }
  if (stateName === 'b') b = state;
  else c = state;
}
b = reduce(b, { type: 'owner-left', did: 'did:a' }, 100).state;
c = reduce(c, { type: 'owner-left', did: 'did:a' }, 100).state;
const bElection = reduce(b, { type: 'tick' }, 100 + DECISION_OWNER_GRACE_MS);
b = bElection.state;
c = reduce(c, { type: 'tick' }, 100 + DECISION_OWNER_GRACE_MS).state;
assert.equal(b.decisionOwner, 'did:b');
assert.equal(c.decisionOwner, 'did:b');
assert.equal(bElection.effects[0].kind, 'decision-takeover');
const takeover = packet('decision-takeover', 'did:b', b);
const merged = reduce(c, { type: 'takeover', packet: takeover, online: ['did:b', 'did:c'] });
assert.equal(merged.verdict, 'idempotent');
assert.equal(merged.state.recovery, null);

// Old-owner control is stale after takeover, even when delayed packets arrive
// with an otherwise exact match payload.
assert.equal(reduce(merged.state, {
  type: 'commit',
  packet: { ...packet('commit', 'did:a', owner), decisionOwner: 'did:a', decisionTerm: 1 },
}).verdict, 'ignored');

// The successor resumes the already-receipted decision. If it also disappears,
// C deterministically advances once more and can either finish or abort if no
// candidate remains.
assert.equal(allCommitReceipts(b), true);
b = reduce(b, { type: 'begin-go' }).state;
assert.equal(b.phase, 'go');
let cAfterB = reduce(merged.state, { type: 'owner-left', did: 'did:b' }, 2_000).state;
const cElection = reduce(cAfterB, { type: 'tick' }, 2_000 + DECISION_OWNER_GRACE_MS);
cAfterB = cElection.state;
assert.equal(cAfterB.decisionOwner, 'did:c');
assert.equal(cAfterB.decisionTerm, 3);
assert.equal(cElection.effects[0].kind, 'decision-takeover');
cAfterB = reduce(cAfterB, { type: 'owner-left', did: 'did:c' }, 4_000).state;
cAfterB = reduce(cAfterB, { type: 'tick' }, 4_000 + DECISION_OWNER_GRACE_MS).state;
assert.equal(cAfterB.phase, 'aborted');

console.log('multiplayer match launch ✓');
