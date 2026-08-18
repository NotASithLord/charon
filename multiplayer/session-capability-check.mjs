import assert from 'node:assert/strict';
import { BridgeSession } from './session.js';

const calls = [];
const client = {
  call(op, args) {
    calls.push({ op, args });
    return Promise.resolve({ active: true, muted: false });
  },
};
const core = new BridgeSession({
  roomId: 'room', name: 'A', did: 'did:a', client, operations: [],
});
assert.equal(core.supportsCapacity, false);
assert.equal(core.supportsVoice, false);
assert.deepEqual(await core.capacity(), { score: 0, outMbps: 0, rttMs: 0 });
core.setVoicePeers(['did:b']);
assert.deepEqual(calls, []);
assert.deepEqual(await core.voiceStatus(), { active: false, muted: false, unavailable: true });
await assert.rejects(core.startVoice(), /unavailable/);
assert.deepEqual(calls, []);

const voiceOps = [
  'capacity', 'voice-start', 'voice-peers', 'voice-mute',
  'voice-status', 'voice-unlock', 'voice-stop',
];
const extended = new BridgeSession({
  roomId: 'room', name: 'A', did: 'did:a', client, operations: voiceOps,
});
assert.equal(extended.supportsCapacity, true);
assert.equal(extended.supportsVoice, true);
await extended.capacity();
extended.setVoicePeers(['did:b']);
await extended.startVoice();
assert.deepEqual(calls.map(({ op }) => op), ['capacity', 'voice-peers', 'voice-start']);

console.log('multiplayer session capabilities ✓');
