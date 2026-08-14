import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  createInviteCode,
  inviteProof,
  matchScope,
  matchRoom,
  normalizeInviteCode,
  peerNumber,
  privateRoom,
  quickplayRoom,
  rankHosts,
  seedForScope,
  validGamePacket,
  verifyInviteProof,
} from './protocol.js';
import { isRoomVoiceSignal } from './voice.js';

const fixedRandom = { getRandomValues(bytes) { bytes.fill(17); return bytes; } };
const invite = createInviteCode(fixedRandom);
assert.equal(invite.length, 20);
assert.equal(normalizeInviteCode(` ${invite.toUpperCase()} `), invite);
const inviteRoom = await privateRoom(invite);
assert.match(inviteRoom, new RegExp(`^charon:v${PROTOCOL_VERSION}:private:[0-9a-f]{32}$`));
assert.equal(inviteRoom.includes(invite), false);
const proof = await inviteProof(invite, 'did:key:test');
assert.equal(await verifyInviteProof(invite, 'did:key:test', proof), true);
assert.equal(await verifyInviteProof(invite, 'did:key:other', proof), false);
assert.equal(quickplayRoom(0), `charon:quickplay:v${PROTOCOL_VERSION}`);
assert.equal(quickplayRoom(119_999), `charon:quickplay:v${PROTOCOL_VERSION}`);
assert.equal(quickplayRoom(120_000), `charon:quickplay:v${PROTOCOL_VERSION}`);
assert.equal(matchScope(['did:b', 'did:a']), matchScope(['did:a', 'did:b', 'did:a']));
assert.notEqual(matchScope(['did:a']), matchScope(['did:b']));
assert.equal(seedForScope('test'), `charon-multiplayer-v${PROTOCOL_VERSION}:test`);
assert.equal(matchRoom('match-abc123'), `charon:v${PROTOCOL_VERSION}:match-abc123`);
assert.deepEqual(rankHosts(['did:b', 'did:a'], new Map([
  ['did:a', { score: 120 }], ['did:b', { score: 300 }],
])), ['did:b', 'did:a']);
assert.deepEqual(rankHosts(['did:b', 'did:a'], new Map()), ['did:a', 'did:b']);
assert.equal(peerNumber('did:a'), peerNumber('did:a'));
assert.equal(validGamePacket({ v: PROTOCOL_VERSION, kind: 'state', from: 'did:a', seq: 1 }), true);
assert.equal(validGamePacket({ v: PROTOCOL_VERSION - 1, kind: 'state', from: 'did:a', seq: 1 }), false);
assert.equal(validGamePacket({ v: PROTOCOL_VERSION, kind: 'eval', from: 'did:a', seq: 1 }), false);
assert.equal(validGamePacket({ v: PROTOCOL_VERSION, kind: 'state', from: 'did:a', seq: -1 }), false);
const ready = { __peerdMedia: 1, scope: 'squad', kind: 'ready', session: '0123456789ab', ack: false };
assert.equal(isRoomVoiceSignal(ready), true);
assert.equal(isRoomVoiceSignal({ ...ready, session: 'short' }), false);
assert.equal(isRoomVoiceSignal({ ...ready, ack: 'yes' }), false);
assert.equal(isRoomVoiceSignal({ __peerdMedia: 1, scope: 'squad', kind: 'offer', session: ready.session, replyTo: ready.session, sdp: 'v=0' }), true);
assert.equal(isRoomVoiceSignal({ __peerdMedia: 1, scope: 'squad', kind: 'answer', session: ready.session, replyTo: ready.session, sdp: 'v=0' }), true);
assert.equal(isRoomVoiceSignal({ __peerdMedia: 1, scope: 'squad', kind: 'ice', session: ready.session,
  replyTo: ready.session, candidate: '', sdpMid: '0', sdpMLineIndex: 0 }), true);
console.log('multiplayer protocol ✓');
