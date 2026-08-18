import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRoomVoiceSignal } from './voice.js';

const base = { __peerdMedia: 1, scope: 'match-room', session: 'abcdefghijkl' };
assert.equal(isRoomVoiceSignal({ ...base, kind: 'ready', ack: false }), true);
assert.equal(isRoomVoiceSignal({ ...base, kind: 'hangup' }), true);
assert.equal(isRoomVoiceSignal({ ...base, kind: 'offer', replyTo: 'mnopqrstuvwx', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }), true);
assert.equal(isRoomVoiceSignal({ ...base, kind: 'offer', replyTo: 'mnopqrstuvwx', sdp: '' }), false);
assert.equal(isRoomVoiceSignal({ ...base, kind: 'ice', replyTo: 'short', candidate: '' }), false);
assert.equal(isRoomVoiceSignal({ ...base, kind: 'video' }), false);

const vendor = await readFile(new URL('../scripts/vendor-peerd-browser.mjs', import.meta.url), 'utf8');
const source = await readFile(new URL('./voice.js', import.meta.url), 'utf8');
assert(!vendor.includes('room-voice.js'));
assert(!source.includes("from './peerd-browser.js'"));
const browser = await import(`./peerd-browser.js?check=${Date.now()}`);
assert.equal(typeof browser.createTopicSync, 'function');
assert.equal(typeof browser.createMemoryTopicStore, 'function');

console.log('multiplayer voice source ✓');
