// Narrow client for peerd's dwapp bridge. The trusted parent owns identity,
// consent, and the always-on WebRTC base network; this frame only sees the
// room-level primitives it asks for.
export function createDwebClient({ timeoutMs = 2_500 } = {}) {
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();

  const receive = (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.peerd === 'dweb:result') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error || 'dweb operation failed'));
      return;
    }
    if (message?.peerd === 'dweb:event') {
      for (const callback of listeners.get(message.event) ?? []) callback(message.data);
    }
  };
  window.addEventListener('message', receive);

  const call = (op, args = {}, callTimeoutMs = 12_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(op === 'hello' ? 'peerd bridge unavailable' : `${op} timed out`));
    }, op === 'hello' ? timeoutMs : callTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ peerd: 'dweb', id, op, args }, '*');
  });

  return Object.freeze({
    hello: () => call('hello'),
    call,
    on(event, callback) {
      const group = listeners.get(event) ?? new Set();
      group.add(callback);
      listeners.set(event, group);
      return () => group.delete(callback);
    },
    dispose() {
      window.removeEventListener('message', receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('dweb client closed'));
      }
      pending.clear();
      listeners.clear();
    },
  });
}
