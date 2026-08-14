import { createDwebClient } from './dweb-client.js';
import { createRoomVoice, isRoomVoiceSignal } from './voice.js';

const scopedTopic = (scope, topic) => `charon/${scope || 'lobby'}/${topic}`;

async function browserCapacity(room) {
  const samples = await Promise.all(room.peers().map(async (peer) => {
    try {
      const stats = await peer.channel?.pc?.getStats?.();
      let selected = null;
      stats?.forEach((row) => {
        if (row.type === 'candidate-pair' && (row.selected || (row.nominated && row.state === 'succeeded'))) selected = row;
      });
      return selected ? {
        outMbps: Number(selected.availableOutgoingBitrate || 0) / 1e6,
        rttMs: Number(selected.currentRoundTripTime || 0) * 1_000,
      } : null;
    } catch { return null; }
  }));
  const valid = samples.filter(Boolean);
  const connection = navigator.connection;
  const cores = Math.max(1, Math.min(16, Number(navigator.hardwareConcurrency) || 2));
  const memory = Math.max(1, Math.min(16, Number(navigator.deviceMemory) || 4));
  const measured = valid.map((sample) => sample.outMbps).filter((value) => value > 0);
  const outMbps = measured.length ? Math.min(...measured) : Math.max(0, Math.min(50, Number(connection?.downlink) || 5));
  const rttValues = valid.map((sample) => sample.rttMs).filter((value) => value > 0);
  const rttMs = rttValues.length ? rttValues.reduce((sum, value) => sum + value, 0) / rttValues.length : 80;
  const score = Math.max(0, Math.min(1_000, Math.round(
    cores * 12 + memory * 7 + Math.min(100, outMbps) * 5 - Math.min(200, rttMs) * 0.35
      - (connection?.saveData ? 120 : 0),
  )));
  // Signed peerd envelopes use an integer-only canonical numeric form.
  return { score, outMbps: Math.round(outMbps), rttMs: Math.round(rttMs) };
}

class SessionBase {
  constructor({ roomId, name, did, transport }) {
    this.roomId = roomId;
    this.name = name;
    this.did = did;
    this.transport = transport;
    this.scope = '';
    this.members = new Map();
    this.listeners = new Map();
    this.topicOff = new Map();
    this.allowedVoicePeers = new Set();
  }

  emit(event, value) {
    // A LISTENER THAT THROWS MUST NOT TAKE THE SESSION WITH IT. `report()` in
    // the voice stack is the LAST statement of makePeer, so an exception
    // raised by a UI listener propagated back through it: makePeer never
    // returned its record, makeOffer never sent an offer, and voice silently
    // failed to connect in BOTH directions. One bad HUD line should cost a
    // HUD line, not the call.
    for (const callback of this.listeners.get(event) ?? []) {
      try { callback(value); } catch (error) { console.error('[charon] session listener failed', event, error); }
    }
  }

  on(event, callback) {
    const group = this.listeners.get(event) ?? new Set();
    group.add(callback);
    this.listeners.set(event, group);
    return () => group.delete(callback);
  }

  setScope(scope) {
    this.scope = String(scope || '');
  }

  roster() {
    return [{ did: this.did, name: this.name, self: true }, ...this.members.values()];
  }

  setVoicePeers(peers) {
    const next = new Set((peers ?? []).filter((did) => typeof did === 'string' && did !== this.did));
    if (next.size === this.allowedVoicePeers.size && [...next].every((did) => this.allowedVoicePeers.has(did))) return false;
    this.allowedVoicePeers = next;
    return true;
  }
}

class BridgeSession extends SessionBase {
  constructor(args) {
    super({ ...args, transport: 'peerd' });
    this.client = args.client;
    this.unsubscribers = [];
  }

  async subscribe(topic, callback) {
    const wire = scopedTopic(this.scope, topic);
    if (!this.topicOff.has(wire)) {
      await this.client.call('subscribe', { topic: wire });
      const off = this.client.on('message', (message) => {
        if (message?.topic === wire) this.emit(`topic:${wire}`, message);
      });
      this.topicOff.set(wire, off);
    }
    return this.on(`topic:${wire}`, callback);
  }

  publish(topic, data) {
    return this.client.call('publish', { topic: scopedTopic(this.scope, topic), data });
  }

  sendDirect(to, data) {
    return this.client.call('dm-send', { to, data });
  }

  capacity() {
    return this.client.call('capacity');
  }

  setVoicePeers(peers) {
    if (!super.setVoicePeers(peers)) return;
    this.client.call('voice-peers', { peers: [...this.allowedVoicePeers] }).catch(() => {});
  }

  startVoice(options = {}) {
    return this.client.call('voice-start', {
      muted: !!options.startMuted,
      peers: [...this.allowedVoicePeers],
    }, 30_000);
  }

  setVoiceMuted(muted) {
    return this.client.call('voice-mute', { muted: !!muted });
  }

  voiceStatus() {
    return this.client.call('voice-status');
  }

  resumeVoicePlayback() {
    return this.client.call('voice-unlock');
  }

  stopVoice() {
    return this.client.call('voice-stop');
  }

  async refreshPresence() {
    const present = await this.client.call('presence');
    this.members.clear();
    for (const peer of present ?? []) {
      if (!peer?.did || peer.did === this.did) continue;
      this.members.set(peer.did, { did: peer.did, name: peer.meta?.name || '' });
    }
    this.emit('roster', this.roster());
    return this.roster();
  }

  async close() {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const off of this.topicOff.values()) off();
    this.topicOff.clear();
    try { await this.client.call('leave'); } catch { /* parent may already be gone */ }
    this.client.dispose();
  }
}

async function bridgeSession({ roomId, name }) {
  const client = createDwebClient();
  let hello;
  try { hello = await client.hello(); }
  catch (error) {
    client.dispose();
    error.code = 'BRIDGE_UNAVAILABLE';
    throw error;
  }
  if (!hello?.available) {
    client.dispose();
    const error = new Error('peerd bridge unavailable');
    error.code = 'BRIDGE_UNAVAILABLE';
    throw error;
  }
  let joined;
  try { joined = await client.call('join', { roomId, name }); }
  catch (error) { client.dispose(); throw error; }
  const session = new BridgeSession({ roomId, name, did: joined.did, client });
  const updateMember = ({ did, meta } = {}) => {
    if (!did || did === session.did) return;
    session.members.set(did, { did, name: meta?.name || session.members.get(did)?.name || '' });
    session.emit('roster', session.roster());
  };
  const dropMember = ({ did } = {}) => {
    if (did && session.members.delete(did)) {
      session.emit('peer-leave', did);
      session.emit('roster', session.roster());
    }
  };
  session.unsubscribers.push(
    client.on('presence-join', updateMember),
    client.on('presence-leave', dropMember),
    client.on('peer-gone', dropMember),
    client.on('direct', (message) => session.emit('direct', message)),
  );
  await client.call('announce', { meta: { name } });
  await session.refreshPresence();
  return session;
}

class BrowserSession extends SessionBase {
  constructor(args) {
    super({ ...args, transport: 'web' });
    this.room = args.room;
    this.gossip = args.gossip;
    this.presence = args.presence;
    this.direct = args.direct;
    this.identity = args.identity;
    this.unsubscribers = args.unsubscribers;
    this.requestedVoicePeers = new Set();
    this.voice = createRoomVoice({
      selfDid: this.did,
      scope: this.roomId,
      sendSignal: (to, signal) => this.direct.send(to, signal),
      onState: (status) => this.emit('voice', status),
    });
  }

  async subscribe(topic, callback) {
    const wire = scopedTopic(this.scope, topic);
    const off = this.gossip.subscribe(wire, callback);
    this.topicOff.set(`${wire}:${this.topicOff.size}`, off);
    return off;
  }

  async publish(topic, data) {
    const envelope = await this.gossip.publish(scopedTopic(this.scope, topic), data);
    return { id: envelope.id, ts: envelope.ts };
  }

  sendDirect(to, data) {
    return this.direct.send(to, data);
  }

  capacity() {
    return browserCapacity(this.room);
  }

  setVoicePeers(peers) {
    this.requestedVoicePeers = new Set(peers ?? []);
    const supported = [...this.requestedVoicePeers]
      .filter((did) => this.members.get(did)?.mediaVoice === 1);
    if (!super.setVoicePeers(supported)) return;
    this.voice.setPeers([...this.allowedVoicePeers]);
  }

  startVoice(options = {}) {
    return this.voice.start({ muted: !!options.startMuted });
  }

  setVoiceMuted(muted) {
    return Promise.resolve(this.voice.setMuted(muted));
  }

  voiceStatus() {
    return Promise.resolve(this.voice.status());
  }

  resumeVoicePlayback() {
    return this.voice.resumePlayback();
  }

  stopVoice() {
    return Promise.resolve(this.voice.stop());
  }

  async refreshPresence() {
    this.members.clear();
    const announced = new Map(this.presence.list().map((peer) => [peer.did, peer]));
    // The authenticated room mesh is the liveness source of truth. Presence
    // metadata can arrive one message later than the WebRTC HELLO, so merging
    // both prevents an existing peer from being invisible to a fresh joiner.
    for (const peer of this.room.peers()) {
      if (!peer?.did || peer.did === this.did) continue;
      const known = announced.get(peer.did) ?? peer;
      this.members.set(peer.did, {
        did: peer.did,
        name: known.meta?.name || this.members.get(peer.did)?.name || '',
        mediaVoice: known.meta?.mediaVoice,
      });
    }
    this.emit('roster', this.roster());
    return this.roster();
  }

  async close() {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const off of this.topicOff.values()) off();
    this.topicOff.clear();
    this.presence.close();
    this.voice.stop();
    this.direct.close();
    this.gossip.close();
    this.room.leave();
  }
}

async function browserSession({ roomId, name, identity: suppliedIdentity }) {
  if (!globalThis.RTCPeerConnection || !globalThis.WebSocket || !globalThis.crypto?.subtle) {
    throw new Error('this browser does not provide WebRTC and WebCrypto');
  }
  const { generateIdentity, joinRoom, createGossip, createPresence, createDirect } = await import('./peerd-browser.js');
  const identity = suppliedIdentity ?? await generateIdentity();
  let room;
  let gossip;
  let presence;
  let direct;
  let session;
  const unsubscribers = [];
  try {
    room = await joinRoom({ roomId, identity, kind: 'website' });
    gossip = createGossip({ mesh: room.mesh });
    presence = createPresence({ gossip, selfDid: identity.did, meta: () => ({ name, mediaVoice: 1 }) });
    direct = createDirect({ mesh: room.mesh });
    session = new BrowserSession({ roomId, name, did: identity.did, identity, room, gossip, presence, direct, unsubscribers });
  unsubscribers.push(
    room.onPeer(({ did } = {}) => {
      if (!did || did === session.did) return;
      if (!session.members.has(did)) {
        session.members.set(did, { did, name: '' });
        session.emit('roster', session.roster());
      }
      // A newcomer could not have heard the beacon sent before its data
      // channel existed. Reannounce as soon as the authenticated link opens.
      Promise.resolve(presence.announce()).catch(() => {});
      session.setVoicePeers([...session.requestedVoicePeers]);
    }),
    presence.onJoin(({ did, meta }) => {
      session.members.set(did, { did, name: meta?.name || '', mediaVoice: meta?.mediaVoice });
      session.emit('roster', session.roster());
      session.setVoicePeers([...session.requestedVoicePeers]);
    }),
    presence.onLeave(({ did }) => {
      session.members.delete(did);
      session.allowedVoicePeers.delete(did);
      session.voice.forget(did);
      session.emit('peer-leave', did);
      session.emit('roster', session.roster());
    }),
    room.onPeerGone(({ did }) => {
      // Presence emits synchronously when it knew the peer. A link synthesized
      // before its first beacon still needs the same immediate leave path.
      presence.forget(did);
      if (did && session.members.delete(did)) {
        session.allowedVoicePeers.delete(did);
        session.voice.forget(did);
        session.emit('peer-leave', did);
        session.emit('roster', session.roster());
      }
    }),
    direct.onMessage(({ from, data }) => {
      if (isRoomVoiceSignal(data)) {
        if (session.allowedVoicePeers.has(from) && session.voice.status().active) {
          session.voice.ingestSignal(from, data).catch(() => {});
        }
        return;
      }
      session.emit('direct', { from, data });
    }),
  );
  presence.start();
  await presence.announce();
  await session.refreshPresence();
  return session;
  } catch (error) {
    for (const off of unsubscribers.splice(0)) off();
    try { presence?.close(); } catch { /* partial setup */ }
    try { direct?.close(); } catch { /* partial setup */ }
    try { gossip?.close(); } catch { /* partial setup */ }
    try { room?.leave(); } catch { /* partial setup */ }
    throw error;
  }
}

export async function joinMultiplayerRoom(options) {
  try {
    return await bridgeSession(options);
  } catch (bridgeError) {
    if (bridgeError?.code !== 'BRIDGE_UNAVAILABLE') throw bridgeError;
    try {
      return await browserSession(options);
    } catch (browserError) {
      const error = new Error(browserError.message || 'multiplayer connection failed');
      error.cause = { bridgeError, browserError };
      throw error;
    }
  }
}
