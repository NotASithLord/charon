import assert from 'node:assert/strict';

const sent = [];
const handlers = new Map();
const parent = { postMessage: (message) => sent.push(message) };
globalThis.window = {
  parent,
  addEventListener(type, handler) { handlers.set(type, handler); },
  removeEventListener(type, handler) { if (handlers.get(type) === handler) handlers.delete(type); },
};
const { createDwebClient } = await import('./dweb-client.js');
const client = createDwebClient();
const pending = client.call('join', { roomId: 'room' }, 0);
const request = sent.at(-1);
assert.equal(request.peerd, 'dweb');
assert.match(request.clientId, /^[0-9a-f]{32}$/);
assert.match(request.id, new RegExp(`^${request.clientId}:1:`));
handlers.get('message')({ source: parent, data: {
  peerd: 'dweb:result', id: request.id, clientId: 'stale-client', ok: true, value: { did: 'bad' },
} });
handlers.get('message')({ source: parent, data: {
  peerd: 'dweb:result', id: request.id, clientId: request.clientId, ok: true, value: { did: 'did:self' },
} });
assert.deepEqual(await pending, { did: 'did:self' });
const abandoned = client.call('join', { roomId: 'other' }, 0);
const abandonedRequest = sent.at(-1);
client.dispose();
await assert.rejects(abandoned, /closed/);
assert(sent.some((message) => message.peerd === 'dweb:cancel'
  && message.clientId === abandonedRequest.clientId && message.id === abandonedRequest.id));
assert(sent.some((message) => message.peerd === 'dweb:dispose'
  && message.clientId === abandonedRequest.clientId));
await assert.rejects(client.call('presence'), /closed/);

console.log('multiplayer dweb client ✓');
