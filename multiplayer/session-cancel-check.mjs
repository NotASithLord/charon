import assert from 'node:assert/strict';

const sent = [];
const handlers = new Map();
const parent = {
  postMessage(message) {
    sent.push(message);
    if (message.peerd === 'dweb' && message.op === 'hello') queueMicrotask(() => {
      handlers.get('message')?.({
        source: parent,
        data: { peerd: 'dweb:result', id: message.id, clientId: message.clientId, ok: true, value: { available: true } },
      });
    });
  },
};
globalThis.window = {
  parent,
  addEventListener(type, handler) { handlers.set(type, handler); },
  removeEventListener(type, handler) { if (handlers.get(type) === handler) handlers.delete(type); },
};

const { joinMultiplayerRoom } = await import('./session.js');
const controller = new AbortController();
const joining = joinMultiplayerRoom({ roomId: 'consent-room', name: 'tester', signal: controller.signal });
while (!sent.some((message) => message.peerd === 'dweb' && message.op === 'join')) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const request = sent.find((message) => message.peerd === 'dweb' && message.op === 'join');
controller.abort();
await assert.rejects(joining, (error) => error?.code === 'JOIN_CANCELLED');
assert(sent.some((message) => message.peerd === 'dweb:cancel'
  && message.clientId === request.clientId && message.id === request.id));
assert(sent.some((message) => message.peerd === 'dweb:dispose' && message.clientId === request.clientId));

console.log('multiplayer session cancellation ✓');
