import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  createInviteCode,
  createPublicLobbyId,
  inviteProof,
  isPublicLobbyId,
  matchScope,
  matchRoom,
  normalizeInviteCode,
  peerNumber,
  privateRoom,
  quickplayRoom,
  rankHosts,
  seedForScope,
  selectOpenLobby,
  validGamePacket,
  verifyInviteProof,
} from './protocol.js';
import { isRoomVoiceSignal } from './voice.js';

const fixedRandom = { getRandomValues(bytes) { bytes.fill(17); return bytes; } };
const invite = createInviteCode(fixedRandom);
assert.equal(invite.length, 20);
assert.equal(normalizeInviteCode(` ${invite.toUpperCase()} `), invite);
const publicLobby = createPublicLobbyId(fixedRandom);
assert.equal(isPublicLobbyId(publicLobby), true);
assert.equal(isPublicLobbyId('private-room'), false);
assert.deepEqual(selectOpenLobby([
  { lobbyId: 'lobby-aaaaaaaaaaaa', host: 'did:a', members: ['did:a'] },
  { lobbyId: 'lobby-bbbbbbbbbbbb', host: 'did:b', members: ['did:b', 'did:c'] },
  { lobbyId: 'lobby-cccccccccccc', host: 'did:z', members: ['did:z'] },
  { lobbyId: 'lobby-dddddddddddd', host: 'did:d', members: ['did:d', 'did:e', 'did:f', 'did:g'] },
], ['did:a', 'did:b', 'did:c', 'did:d', 'did:e', 'did:f', 'did:g']), {
  lobbyId: 'lobby-bbbbbbbbbbbb', host: 'did:b', members: ['did:b', 'did:c'],
});
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
const gamePacket = { v: PROTOCOL_VERSION, kind: 'state', from: 'did:a', authority: 'did:a', authorityTerm: 1, seq: 1 };
assert.equal(validGamePacket(gamePacket), true);
assert.equal(validGamePacket({ ...gamePacket, v: PROTOCOL_VERSION - 1 }), false);
assert.equal(validGamePacket({ ...gamePacket, kind: 'eval' }), false);
assert.equal(validGamePacket({ ...gamePacket, seq: -1 }), false);
assert.equal(validGamePacket({ ...gamePacket, authorityTerm: 0 }), false);
const ready = { __peerdMedia: 1, scope: 'squad', kind: 'ready', session: '0123456789ab', ack: false };
assert.equal(isRoomVoiceSignal(ready), true);
assert.equal(isRoomVoiceSignal({ ...ready, session: 'short' }), false);
assert.equal(isRoomVoiceSignal({ ...ready, ack: 'yes' }), false);
assert.equal(isRoomVoiceSignal({ __peerdMedia: 1, scope: 'squad', kind: 'offer', session: ready.session, replyTo: ready.session, sdp: 'v=0' }), true);
assert.equal(isRoomVoiceSignal({ __peerdMedia: 1, scope: 'squad', kind: 'answer', session: ready.session, replyTo: ready.session, sdp: 'v=0' }), true);
assert.equal(isRoomVoiceSignal({ __peerdMedia: 1, scope: 'squad', kind: 'ice', session: ready.session,
  replyTo: ready.session, candidate: '', sdpMid: '0', sdpMLineIndex: 0 }), true);
console.log('multiplayer protocol ✓');
