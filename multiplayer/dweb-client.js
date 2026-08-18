// Narrow client for peerd's dwapp bridge. The trusted parent owns identity,
// consent, and the always-on WebRTC base network; this frame only sees the
// room-level primitives it asks for.
export function createDwebClient({ timeoutMs = 2_500 } = {}) {
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();
  const randomToken = () => {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const clientId = randomToken();

  const receive = (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.peerd === 'dweb:result') {
      if (message.clientId !== clientId) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error || 'dweb operation failed'));
      return;
    }
    if (message?.peerd === 'dweb:event' && (!message.clientId || message.clientId === clientId)) {
      for (const callback of listeners.get(message.event) ?? []) callback(message.data);
    }
  };
  window.addEventListener('message', receive);

  const call = (op, args = {}, callTimeoutMs = 12_000) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error('dweb client closed'));
      return;
    }
    const id = `${clientId}:${++sequence}:${randomToken()}`;
    const duration = op === 'hello' ? timeoutMs : callTimeoutMs;
    const timer = duration > 0 ? setTimeout(() => {
      if (!pending.delete(id)) return;
      window.parent.postMessage({ peerd: 'dweb:cancel', clientId, id }, '*');
      reject(new Error(op === 'hello' ? 'peerd bridge unavailable' : `${op} timed out`));
    }, duration) : null;
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ peerd: 'dweb', id, clientId, op, args }, '*');
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
      if (closed) return;
      closed = true;
      window.removeEventListener('message', receive);
      for (const [id, request] of pending) {
        clearTimeout(request.timer);
        window.parent.postMessage({ peerd: 'dweb:cancel', clientId, id }, '*');
        request.reject(new Error('dweb client closed'));
      }
      window.parent.postMessage({ peerd: 'dweb:dispose', clientId }, '*');
      pending.clear();
      listeners.clear();
    },
  });
}
