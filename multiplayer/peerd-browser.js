// ../peerd/extension/peerd-distributed/codec/base58.js
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var BASE = 58;
var LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();
var base58encode = (bytes) => {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const input = Array.from(bytes);
  const out = [];
  let start = zeros;
  while (start < input.length) {
    let remainder = 0;
    for (let i = start; i < input.length; i++) {
      const acc = (remainder << 8) + input[i];
      input[i] = Math.floor(acc / BASE);
      remainder = acc % BASE;
    }
    out.push(remainder);
    while (start < input.length && input[start] === 0) start++;
  }
  let str = "1".repeat(zeros);
  for (let i = out.length - 1; i >= 0; i--) str += ALPHABET[out[i]];
  return str;
};
var base58decode = (str) => {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const digits = [];
  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const val = code < 128 ? LOOKUP[code] : -1;
    if (val < 0) throw new Error(`base58decode: invalid character '${str[i]}'`);
    let carry = val;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * BASE;
      digits[j] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 255);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) {
    out[zeros + digits.length - 1 - i] = digits[i];
  }
  return out;
};

// ../peerd/extension/peerd-distributed/identity/did.js
var ED25519_PUB_PREFIX = Uint8Array.from([237, 1]);
var DID_PREFIX = "did:key:z";
var encodeDidKey = (pubkey32) => {
  if (!(pubkey32 instanceof Uint8Array) || pubkey32.length !== 32) {
    throw new Error("encodeDidKey: expected a 32-byte Ed25519 public key");
  }
  const tagged = new Uint8Array(2 + 32);
  tagged.set(ED25519_PUB_PREFIX, 0);
  tagged.set(pubkey32, 2);
  return DID_PREFIX + base58encode(tagged);
};
var decodeDidKey = (did) => {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX)) {
    throw new Error("decodeDidKey: not a did:key:z… string");
  }
  const tagged = base58decode(did.slice(DID_PREFIX.length));
  if (tagged.length !== 34 || tagged[0] !== 237 || tagged[1] !== 1) {
    throw new Error("decodeDidKey: unsupported key type (peerd is Ed25519-only)");
  }
  return tagged.slice(2);
};

// ../peerd/extension/shared/bundle/bytes.js
var utf8 = (s) => new TextEncoder().encode(s);
var toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var toBase64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
var fromBase64 = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
var concat = (...arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

// ../peerd/extension/peerd-distributed/identity/keypair.js
var generateIdentity = async () => {
  const kp = (
    /** @type {CryptoKeyPair} */
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const did = encodeDidKey(pubRaw);
  const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    kp.privateKey,
    /** @type {BufferSource} */
    bytes
  ));
  return { did, publicKey: pubRaw, sign };
};
var PKCS8_ED25519_PREFIX = Uint8Array.from([
  48,
  46,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  112,
  4,
  34,
  4,
  32
]);
var importVerifyKey = (pubkey32) => crypto.subtle.importKey(
  "raw",
  /** @type {BufferSource} */
  pubkey32,
  { name: "Ed25519" },
  true,
  ["verify"]
);
var verifySignature = async (did, signature, bytes) => {
  const key = await importVerifyKey(decodeDidKey(did));
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    /** @type {BufferSource} */
    signature,
    /** @type {BufferSource} */
    bytes
  );
};

// ../peerd/extension/peerd-distributed/transport/channel.js
var createBufferedChannel = ({ send, close } = (
  /** @type {{ send: (msg: any) => void }} */
  {}
)) => {
  let handler = null;
  let closed = false;
  const backlog = [];
  const closeCbs = /* @__PURE__ */ new Set();
  const chan = {
    /** @param {any} msg */
    send: (msg) => {
      if (!closed) send(msg);
    },
    // Called by the transport when a message arrives.
    /** @param {any} msg */
    deliver(msg) {
      if (closed) return;
      if (handler) handler(msg);
      else backlog.push(msg);
    },
    // Install (or clear, with null) the handler. Flushes the backlog.
    /** @param {((msg: any) => void) | null} fn */
    setHandler(fn) {
      handler = fn;
      if (fn) while (backlog.length) fn(backlog.shift());
    },
    isClosed: () => closed,
    // Fires once, immediately if already closed. Returns unsubscribe.
    /** @param {() => void} cb */
    onClose(cb) {
      if (closed) {
        cb();
        return () => {
        };
      }
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },
    // Transport-side: the pipe is gone (remote close, failure, or local
    // close() below). Idempotent.
    signalClose() {
      if (closed) return;
      closed = true;
      for (const cb of [...closeCbs]) cb();
      closeCbs.clear();
    },
    // Local hang-up: tear down the underlying transport too.
    close() {
      if (closed) return;
      try {
        close?.();
      } catch {
      }
      chan.signalClose();
    }
  };
  return chan;
};

// ../peerd/extension/peerd-distributed/transport/ice.js
var DirectPathUnavailableError = class extends Error {
  /** @param {{ local?: CandidateSummary, remote?: CandidateSummary }} [ends] */
  constructor({ local, remote } = {}) {
    const fmt = (s) => s ? `host6:${s.host6} host6ll:${s.host6ll} host4:${s.host4} srflx:${s.srflx} mdns:${s.mdns} relay:${s.relay}` : "unknown";
    const llOnly = local && remote && local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const tail = llOnly ? "and only LINK-LOCAL IPv6 (fe80::, does not route across networks)." : "with no global IPv6 path.";
    super(
      `no direct path between peers — local[${fmt(local)}] remote[${fmt(remote)}]. peerd ships no TURN relay (NORTH-STAR D-5): no routable path — symmetric-NAT IPv4 ${tail} This failure is surfaced, not silently relayed.`
    );
    this.name = "DirectPathUnavailableError";
    this.local = local;
    this.remote = remote;
  }
};
var summarizeCandidates = (sdp = "") => {
  const sum = { host4: 0, host6: 0, host6ll: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 };
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = line.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/);
    if (!m) continue;
    const [, addr, typ] = m;
    if (typ === "host") {
      if (addr.toLowerCase().endsWith(".local")) sum.mdns += 1;
      else if (addr.includes(":")) {
        if (/^fe80/i.test(addr)) sum.host6ll += 1;
        else sum.host6 += 1;
      } else sum.host4 += 1;
    } else if (typ in sum) {
      sum[
        /** @type {keyof CandidateSummary} */
        typ
      ] += 1;
    }
  }
  return sum;
};
var famOf = (addr) => addr && String(addr).includes(":") ? "ipv6" : "ipv4";
var connectionPath = async (pc) => {
  try {
    const stats = await pc.getStats();
    const byId = /* @__PURE__ */ new Map();
    stats.forEach((s) => byId.set(s.id, s));
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s.selected || s.nominated && s.state === "succeeded")) pair = s;
      });
    }
    if (!pair) return { path: "unknown" };
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const fam = famOf(local?.address ?? local?.ip ?? remote?.address ?? remote?.ip);
    const types = [local?.candidateType, remote?.candidateType];
    const kind = types.includes("relay") ? "relay" : types.some((t) => t === "srflx" || t === "prflx") ? "srflx" : "host";
    return {
      path: kind === "host" ? `direct-${fam}` : `direct-${fam}-${kind}`,
      family: fam,
      local: local?.candidateType ?? "unknown",
      remote: remote?.candidateType ?? "unknown"
    };
  } catch {
    return { path: "unknown" };
  }
};

// ../peerd/extension/peerd-distributed/log.js
var DWEB_LOG = true;
var on = () => DWEB_LOG && typeof window !== "undefined" && /** @type {Record<string, unknown>} */
globalThis.__DWEB_LOG__ !== false;
var BADGE = "background:#c4319b;color:#fff;font-weight:bold;border-radius:3px;padding:0 4px";
var TAG = "color:#c4319b;font-weight:bold";
var dlog = (tag, ...args) => {
  if (!on()) return;
  try {
    console.log(`%c DWEB %c ${tag} `, BADGE, TAG, ...args);
  } catch {
  }
};
var dwarn = (tag, ...args) => {
  if (!on()) return;
  try {
    console.warn(`%c DWEB %c ${tag} `, "background:#d04545;color:#fff;font-weight:bold;border-radius:3px;padding:0 4px", "color:#d04545;font-weight:bold", ...args);
  } catch {
  }
};

// ../peerd/extension/peerd-distributed/transport/peer.js
var DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "stun:stun.relay.metered.ca:80" }
  // :80 also slips past some 3478-blocking firewalls
];
var DISCONNECT_GRACE_MS = 5e3;
var MAX_DATA_CHANNEL_FRAME_BYTES = 1e6;
var decode = (data) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  if (bytes > MAX_DATA_CHANNEL_FRAME_BYTES) throw new Error("data-channel frame too large");
  return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
};
var createPeer = ({
  initiator,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  config = { iceServers: DEFAULT_ICE_SERVERS },
  onCandidate = null
} = {}) => {
  if (!RTCPeerConnection) throw new Error("createPeer: WebRTC unavailable in this context");
  const pc = new RTCPeerConnection({ iceCandidatePoolSize: 4, bundlePolicy: "max-bundle", ...config });
  if (onCandidate) {
    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) onCandidate(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    });
  }
  const pendingRemote = [];
  const MAX_PENDING_REMOTE = 64;
  const setRemote = async (desc) => {
    await pc.setRemoteDescription(desc);
    while (pendingRemote.length) {
      try {
        await pc.addIceCandidate(
          /** @type {RTCIceCandidateInit} */
          pendingRemote.shift()
        );
      } catch (e) {
        dwarn("webrtc", `addIceCandidate (flush) failed: ${/** @type {{ message?: string }} */
        e?.message ?? e}`);
      }
    }
  };
  const addRemoteCandidate = async (candidate) => {
    if (!candidate) return;
    if (!pc.remoteDescription) {
      if (pendingRemote.length >= MAX_PENDING_REMOTE) {
        dwarn("webrtc", "dropping ICE candidate — pre-description buffer full");
        return;
      }
      pendingRemote.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      dwarn("webrtc", `addIceCandidate failed: ${/** @type {{ message?: string }} */
      e?.message ?? e}`);
    }
  };
  let resolveChannel;
  let rejectChannel;
  const channelReady = new Promise((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });
  const failDirect = () => {
    const local = summarizeCandidates(pc.localDescription?.sdp);
    const remote = summarizeCandidates(pc.remoteDescription?.sdp);
    const llOnly = local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const why = llOnly ? "the IPv6 host candidates are LINK-LOCAL only (fe80::, don't route across networks) and IPv4 is symmetric-NAT — no path." : "symmetric-NAT IPv4 with no global IPv6 — no path.";
    dlog("webrtc", `no direct path to this peer (expected without TURN — D-5: ${why}). local ${JSON.stringify(local)}, remote ${JSON.stringify(remote)}`);
    rejectChannel(new DirectPathUnavailableError({ local, remote }));
  };
  pc.addEventListener("iceconnectionstatechange", () => {
    dlog("webrtc", `ICE ${initiator ? "(initiator)" : "(responder)"} state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") failDirect();
  });
  const wire = (dc) => {
    dc.binaryType = "arraybuffer";
    const channel = (
      /** @type {ReturnType<typeof createBufferedChannel> & { pc?: RTCPeerConnection }} */
      createBufferedChannel({
        // why guard readyState: the RTCDataChannel can be 'connecting' (a
        // send racing ahead of onopen) or 'closing'/'closed' (the remote
        // vanished — a closed tab rarely sends a clean DC close — before
        // onclose / the connection-state handlers flip the buffered channel
        // shut). dc.send() in any non-'open' state throws InvalidStateError,
        // which surfaced as an uncaught rejection in the offscreen doc.
        // Drop the datagram instead: this is best-effort mesh traffic
        // (gossip / presence / DHT) that re-gossips and multi-hops, so a
        // frame lost to a dying peer is recoverable — the throw was not.
        send: (obj) => {
          if (dc.readyState === "open") dc.send(JSON.stringify(obj));
          else dlog("webrtc", `drop send — data channel is '${dc.readyState}', not open`);
        },
        close: () => {
          try {
            dc.close();
          } catch {
          }
          try {
            pc.close();
          } catch {
          }
        }
      })
    );
    channel.pc = pc;
    dc.onmessage = (e) => {
      let m;
      try {
        m = decode(e.data);
      } catch {
        dwarn("webrtc", "dropping unparseable data-channel frame");
        return;
      }
      channel.deliver(m);
    };
    dc.onopen = () => {
      dlog("webrtc", "🟢 data channel OPEN — peers connected directly");
      resolveChannel(channel);
    };
    dc.onclose = () => channel.signalClose();
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (pc.connectionState === "failed") failDirect();
        channel.signalClose();
      }
    });
    let discoTimer = null;
    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        clearTimeout(discoTimer ?? void 0);
        discoTimer = null;
      } else if (s === "disconnected" && !discoTimer) {
        discoTimer = setTimeout(() => {
          const live = pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
          if (!live) {
            dlog("webrtc", "peer link idle past the grace window — closing it");
            channel.signalClose();
          }
        }, DISCONNECT_GRACE_MS);
      } else if (s === "failed" || s === "closed") {
        clearTimeout(discoTimer ?? void 0);
        discoTimer = null;
        channel.signalClose();
      }
    });
    if (dc.readyState === "open") resolveChannel(channel);
    return channel;
  };
  if (initiator) wire(pc.createDataChannel("peerd", { ordered: true }));
  else pc.ondatachannel = (e) => wire(e.channel);
  return { pc, channelReady, setRemote, addRemoteCandidate };
};

// ../peerd/extension/peerd-distributed/transport/transports/webrtc.js
var requireSignaling = (signaling) => {
  if (typeof signaling?.send !== "function" || typeof signaling?.onRemote !== "function") {
    throw new Error("webrtc: a signaling channel is required ({ send, onRemote })");
  }
};
var abortClosesPc = (signal, p, isOpen) => {
  if (!signal) return;
  signal.addEventListener("abort", () => {
    if (isOpen()) return;
    try {
      p.pc.close();
    } catch {
    }
  }, { once: true });
};
var createWebrtcTransport = ({ RTCPeerConnection, iceServers = DEFAULT_ICE_SERVERS } = {}) => {
  const cfgFor = (sameMachine, override) => ({
    iceServers: override ?? (sameMachine ? [] : iceServers)
  });
  return {
    name: "webrtc",
    // Usable as a general fallback; preferred when the peer advertises it.
    /** @param {{ transports?: Array<{ kind: string }> }} peer */
    canReach(peer) {
      return peer?.transports?.some((t) => t.kind === "webrtc") ? 0.6 : 0.4;
    },
    // INITIATOR. Creates the offer, sends it immediately, then trickles
    // candidates; applies the remote answer + candidates as they arrive.
    // Resolves to the open Channel (or rejects with DirectPathUnavailableError).
    /**
     * @param {any} peer
     * @param {{ signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[], signal?: AbortSignal }} [opts]
     */
    async connect(peer, { signaling, sameMachine = false, iceServers: ice, signal } = {}) {
      requireSignaling(signaling);
      const sig = (
        /** @type {Signaling} */
        signaling
      );
      const p = createPeer({
        initiator: true,
        RTCPeerConnection,
        config: cfgFor(sameMachine, ice),
        onCandidate: (c) => sig.send({ ice: c })
      });
      const off = sig.onRemote(async (msg) => {
        if (!msg) return;
        if (msg.type === "answer") await p.setRemote({ type: "answer", sdp: msg.sdp });
        else if ("ice" in msg) await p.addRemoteCandidate(msg.ice);
      });
      let opened = false;
      p.channelReady.then(() => {
        opened = true;
        off();
      }, () => off());
      abortClosesPc(signal, p, () => opened);
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      sig.send({ type: "offer", sdp: (
        /** @type {RTCSessionDescription} */
        p.pc.localDescription.sdp
      ) });
      return p.channelReady;
    },
    // RESPONDER. The offer already arrived (passed in); the answer +
    // candidates go back over `signaling`. Returns { channel } — a promise
    // that resolves when the data channel opens (NOT awaited here: it can't
    // open until the initiator applies our answer).
    /**
     * @param {{ offer?: { sdp?: string }, signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[], signal?: AbortSignal }} [opts]
     */
    async accept({ offer, signaling, sameMachine = false, iceServers: ice, signal } = {}) {
      requireSignaling(signaling);
      const sig = (
        /** @type {Signaling} */
        signaling
      );
      const p = createPeer({
        initiator: false,
        RTCPeerConnection,
        config: cfgFor(sameMachine, ice),
        onCandidate: (c) => sig.send({ ice: c })
      });
      const off = sig.onRemote(async (msg) => {
        if (msg && "ice" in msg) await p.addRemoteCandidate(msg.ice);
      });
      let opened = false;
      p.channelReady.then(() => {
        opened = true;
        off();
      }, () => off());
      abortClosesPc(signal, p, () => opened);
      await p.setRemote({ type: "offer", sdp: offer?.sdp });
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sig.send({ type: "answer", sdp: (
        /** @type {RTCSessionDescription} */
        p.pc.localDescription.sdp
      ) });
      return { channel: p.channelReady };
    }
  };
};

// ../peerd/extension/peerd-distributed/transport/signaling-client.js
var DEFAULT_SIGNALING = ["wss://bootstrap.peerd.ai/rendezvous"];
var openRendezvous = ({
  url = DEFAULT_SIGNALING[0],
  room,
  kind,
  // 'website' = observe-only visitor (own cap pool); omitted/default = extension
  WebSocket: WS = globalThis.WebSocket,
  timeoutMs = 2e4
} = {}) => (
  /** @type {Promise<RendezvousSession>} */
  new Promise((resolve, reject) => {
    dlog("rendezvous", `connecting to ${url} — room "${room}"`);
    const kindQ = kind && kind !== "extension" ? `&kind=${encodeURIComponent(kind)}` : "";
    const ws = new WS(`${url}?key=${encodeURIComponent(
      /** @type {string} */
      room
    )}${kindQ}`);
    const wsSend = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    const listeners = { joined: /* @__PURE__ */ new Set(), left: /* @__PURE__ */ new Set(), signal: /* @__PURE__ */ new Set(), closed: /* @__PURE__ */ new Set() };
    const emit = (ev, arg) => {
      for (const cb of [...listeners[ev]]) cb(arg);
    };
    let opened = false;
    let closed = false;
    let keepalive;
    const timer = setTimeout(() => {
      if (!opened) {
        try {
          ws.close();
        } catch {
        }
        reject(new Error("signaling: timed out before join confirm"));
      }
    }, timeoutMs);
    const KEEPALIVE_MS = 25e3;
    const session = {
      self: null,
      members: [],
      sendSignal: (to, payload) => wsSend({ t: "signal", to, payload }),
      on: (ev, cb) => {
        listeners[ev].add(cb);
        return () => listeners[ev].delete(cb);
      },
      close: () => {
        closed = true;
        clearInterval(keepalive);
        try {
          ws.close();
        } catch {
        }
      }
    };
    ws.onerror = () => {
      dlog("rendezvous", `websocket error connecting to ${url} (transient? the caller escalates a real outage)`);
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`signaling: websocket error (${url})`));
      }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      clearInterval(keepalive);
      if (!opened) {
        dlog("rendezvous", "closed before join confirm (transient? the caller escalates a real outage)");
        reject(new Error("signaling: closed before join confirm"));
      } else if (!closed) {
        dlog("rendezvous", "node connection closed — reconnecting; mesh survives meanwhile");
        emit("closed", void 0);
      }
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
      } catch {
        return;
      }
      switch (m.t) {
        case "full":
          clearTimeout(timer);
          dwarn("rendezvous", `room "${room}" reported FULL. With real peers this means STALE/ghost connections piled up on the rendezvous node (reloads that never cleanly closed). Fix: try a fresh room code, or restart the node — the server now reaps dead connections on each join, so this should self-heal.`);
          return reject(new Error(`signaling: room "${room}" is full (likely stale connections — try a fresh room code)`));
        case "room":
          opened = true;
          clearTimeout(timer);
          keepalive = setInterval(() => wsSend({ t: "ping" }), KEEPALIVE_MS);
          session.self = m.self;
          session.members = m.members ?? [];
          dlog("rendezvous", `JOINED room "${room}" as ${m.self} — ${session.members.length} member(s) already here:`, session.members);
          return resolve(session);
        case "joined":
          dlog("rendezvous", `peer ${m.member} JOINED the room`);
          return emit("joined", m.member);
        case "left":
          dlog("rendezvous", `peer ${m.member} LEFT the room`);
          return emit("left", m.member);
        case "signal":
          dlog("rendezvous", `SIGNAL from ${m.from}`);
          return emit("signal", { from: m.from, payload: m.payload });
        default:
          return;
      }
    };
  })
);

// ../peerd/extension/shared/bundle/canonical.js
var canonicalize = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    const num = (
      /** @type {number} */
      v
    );
    if (!Number.isFinite(num)) throw new Error("canonicalize: non-finite number");
    if (!Number.isInteger(num)) {
      throw new Error("canonicalize: non-integer number in a signed payload");
    }
    return String(num);
  }
  if (t === "object") {
    const obj = (
      /** @type {Record<string, unknown>} */
      v
    );
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
};

// ../peerd/extension/peerd-distributed/transport/envelope.js
var DOMAIN = "peerd/envelope/v1";
var signingBytes = (env) => {
  const { sig, ...rest } = env;
  return concat(utf8(DOMAIN), Uint8Array.from([0]), utf8(canonicalize(rest)));
};
var buildEnvelope = ({ ch, typ, from, body, id, ts }) => ({
  v: 1,
  ch,
  typ,
  from,
  body,
  id,
  ts
});
var signEnvelope = async (env, identity) => {
  const sig = await identity.sign(signingBytes(env));
  return { ...env, sig: toBase64(sig) };
};
var envelopeBytes = (env) => {
  try {
    return utf8(canonicalize(env)).length;
  } catch {
    return Infinity;
  }
};
var verifyEnvelope = async (env) => {
  if (!env || typeof env !== "object") return false;
  const e = (
    /** @type {Envelope} */
    env
  );
  if (!e.sig || !e.from) return false;
  try {
    return await verifySignature(e.from, fromBase64(e.sig), signingBytes(e));
  } catch {
    return false;
  }
};

// ../peerd/extension/shared/bundle/chunk.js
var sha256hex = async (bytes) => toHex(new Uint8Array(
  await crypto.subtle.digest(
    "SHA-256",
    /** @type {BufferSource} */
    bytes
  )
));

// ../peerd/extension/shared/bundle/manifest.js
var withoutSig = (manifest) => {
  const { sig, ...rest } = manifest;
  return rest;
};
var canonicalManifestBytes = (manifest) => utf8(canonicalize(withoutSig(manifest)));
var manifestHash = async (manifest) => sha256hex(canonicalManifestBytes(manifest));

// ../peerd/extension/peerd-distributed/content/manifest.js
var DOMAIN2 = "peerd/manifest/v1";
var signingBytes2 = (manifest) => concat(utf8(DOMAIN2), Uint8Array.from([0]), canonicalManifestBytes(manifest));
var MAX_BUNDLE_BYTES = 5e7;
var MAX_MANIFEST_BYTES = 256e3;
var MAX_MANIFEST_CHUNKS = 256;
var SHA256_HEX = /^[a-f0-9]{64}$/;
var assertBundleWithinLimits = (manifest) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest malformed");
  let encoded;
  try {
    encoded = JSON.stringify(manifest);
  } catch {
    throw new Error("manifest is not JSON-serializable");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("manifest exceeds the wire ceiling");
  }
  const chunks = manifest?.chunks;
  if (!Array.isArray(chunks)) throw new Error("manifest has no chunk list");
  if (chunks.length > MAX_MANIFEST_CHUNKS) throw new Error("manifest has too many chunks");
  const stringFields = [["type", 32], ["mime", 128], ["entry", 512], ["publisher", 256], ["sig", 512]];
  for (const [field, cap] of stringFields) {
    const value = manifest[field];
    if (value != null && (typeof value !== "string" || value.length > cap)) throw new Error(`manifest ${field} invalid`);
  }
  let declared = 0;
  const sizesByHash = /* @__PURE__ */ new Map();
  for (const c of chunks) {
    if (!c || typeof c !== "object" || !SHA256_HEX.test(c.hash)) throw new Error("manifest chunk hash invalid");
    const size = c?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > 262144) throw new Error("manifest chunk size invalid");
    if (sizesByHash.has(c.hash) && sizesByHash.get(c.hash) !== size) {
      throw new Error("manifest reuses a chunk hash with conflicting sizes");
    }
    sizesByHash.set(c.hash, size);
    declared += size;
    if (declared > MAX_BUNDLE_BYTES) {
      throw new Error(`bundle too large: chunks declare more than ${MAX_BUNDLE_BYTES} bytes`);
    }
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size !== declared) {
    throw new Error(`manifest size ${manifest?.size} does not match its chunk list (${declared})`);
  }
};
var verifyManifest = async (manifest) => {
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, reason: "malformed" };
  }
  if (!manifest.publisher) return { ok: true, publisher: null };
  if (!manifest.sig) return { ok: false, reason: "missing_sig" };
  let ok = false;
  const publisher = (
    /** @type {string} */
    manifest.publisher
  );
  try {
    ok = await verifySignature(
      publisher,
      fromBase64(
        /** @type {string} */
        manifest.sig
      ),
      signingBytes2(manifest)
    );
  } catch {
    return { ok: false, reason: "verify_threw" };
  }
  return ok ? { ok: true, publisher } : { ok: false, reason: "bad_sig" };
};

// ../peerd/extension/peerd-distributed/content/uri.js
var SCHEME = "peerd://";
var HASH_RE = /^[0-9a-f]{64}$/;
var parsePeerdUri = (s) => {
  if (typeof s !== "string" || !s.startsWith(SCHEME)) {
    throw new Error("parsePeerdUri: not a peerd:// URI");
  }
  let rest = s.slice(SCHEME.length);
  let did;
  if (rest.startsWith("did:")) {
    const slash = rest.indexOf("/");
    if (slash < 0) throw new Error("parsePeerdUri: did present but no content hash");
    did = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  const parts = rest.split("/");
  const hash = (
    /** @type {string} */
    parts.shift()
  );
  if (!HASH_RE.test(hash)) {
    throw new Error("parsePeerdUri: invalid content hash");
  }
  const path = parts.length ? parts.join("/") : void 0;
  return { did, hash, path };
};

// ../peerd/extension/peerd-distributed/content/transfer.js
var ALPHA = 3;
var createContentResponder = ({ store }) => (msg, send) => {
  switch (msg && msg.t) {
    case "MANIFEST_REQ": {
      const manifest = store.getManifest(msg.hash);
      send(manifest ? { t: "MANIFEST", hash: msg.hash, manifest } : { t: "NOMANIFEST", hash: msg.hash });
      return;
    }
    case "CHUNK_REQ": {
      const bytes = store.getChunk(msg.hash);
      send(bytes ? { t: "CHUNK", hash: msg.hash, bytes: toBase64(bytes) } : { t: "NOCHUNK", hash: msg.hash });
      return;
    }
    default:
      return;
  }
};
var fetchBundle = async ({ uri, channel, onProgress, timeoutMs = 15e3 } = (
  /** @type {{ uri: string, channel: { send: (msg: any) => void, setHandler: (h: ((msg: ContentMsg) => void) | null) => void } }} */
  {}
)) => {
  const { hash } = parsePeerdUri(uri);
  const pending = /* @__PURE__ */ new Map();
  channel.setHandler((msg) => {
    if (!msg || typeof msg.t !== "string") return;
    const key = `${msg.t}:${msg.hash}`;
    const resolve = pending.get(key);
    if (resolve) {
      pending.delete(key);
      resolve(msg);
    }
  });
  const request = (reqType, respTypes, h) => new Promise((resolve, reject) => {
    const settle = (msg) => {
      clearTimeout(timer);
      for (const rt of respTypes) pending.delete(`${rt}:${h}`);
      resolve(msg);
    };
    for (const rt of respTypes) pending.set(`${rt}:${h}`, settle);
    const timer = setTimeout(() => {
      for (const rt of respTypes) pending.delete(`${rt}:${h}`);
      reject(new Error(`transfer timeout waiting for ${respTypes.join("/")} of ${h}`));
    }, timeoutMs);
    channel.send({ t: reqType, hash: h });
  });
  const manResp = await request("MANIFEST_REQ", ["MANIFEST", "NOMANIFEST"], hash);
  if (manResp.t === "NOMANIFEST") throw new Error(`peer does not hold ${hash}`);
  const manifest = manResp.manifest;
  assertBundleWithinLimits(manifest);
  const computed = await manifestHash(manifest);
  if (computed !== hash) throw new Error("manifest hash mismatch — content address does not match payload");
  const v = await verifyManifest(manifest);
  if (!v.ok) throw new Error(`manifest signature invalid: ${v.reason}`);
  onProgress?.({ phase: "manifest", publisher: v.publisher, total: manifest.chunks.length });
  const uniqueHashes = [...new Set(manifest.chunks.map((c) => c.hash))];
  const expectedSizes = new Map(manifest.chunks.map((c) => [c.hash, c.size]));
  const byHash = /* @__PURE__ */ new Map();
  let idx = 0;
  let done = 0;
  const worker = async () => {
    while (idx < uniqueHashes.length) {
      const h = uniqueHashes[idx++];
      const resp = await request("CHUNK_REQ", ["CHUNK", "NOCHUNK"], h);
      if (resp.t === "NOCHUNK") throw new Error(`chunk unavailable: ${h}`);
      const bytes = fromBase64(
        /** @type {string} */
        resp.bytes
      );
      if (bytes.byteLength !== expectedSizes.get(h)) throw new Error(`chunk size mismatch: ${h}`);
      const got = await sha256hex(bytes);
      if (got !== h) throw new Error(`chunk hash mismatch (tamper?): ${h}`);
      byHash.set(h, bytes);
      done++;
      onProgress?.({ phase: "chunk", done, total: uniqueHashes.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALPHA, uniqueHashes.length || 1) }, worker));
  const payload = concat(...manifest.chunks.map((c) => (
    /** @type {Uint8Array} */
    byHash.get(c.hash)
  )));
  if (payload.length !== manifest.size) throw new Error("reassembled size mismatch");
  channel.setHandler(null);
  return { manifest, payload };
};

// ../peerd/extension/peerd-distributed/transport/mesh.js
var CTRL = Object.freeze({
  PING: 2,
  PONG: 3,
  ROSTER_REQ: 5,
  ROSTER: 6,
  RELAY: 7
});
var CONTENT_REQ = /* @__PURE__ */ new Set(["MANIFEST_REQ", "CHUNK_REQ"]);
var CONTENT_RESP = /* @__PURE__ */ new Set(["MANIFEST", "NOMANIFEST", "CHUNK", "NOCHUNK"]);
var newId = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
var DEFAULT_BUDGET = 16;
var createRoomMesh = ({
  roomId,
  identity,
  now = Date.now,
  budget = DEFAULT_BUDGET,
  // "Are you still there?" cadence — the BACKSTOP for total silence (when neither
  // a clean data-channel close nor ICE 'disconnected' fired, which is rare). PING
  // is cheap (one signed control frame): ping at 8s, drop after 18s (~2 missed
  // pings). The fast paths win in practice: dc.onclose (graceful close, ~secs) and
  // peer.js's ICE-disconnect grace (hard kill, ~5-10s) → onPeerGone → presence
  // forgets the peer at once, so the view drops it without waiting on this.
  pingIntervalMs = 8e3,
  idleTimeoutMs = 18e3,
  // control frames allowed per link per 10s window — generous for honest
  // peers (a ping every 10s), tight for floods.
  ctrlRateLimit = 60,
  audit = null
  // optional (type, detail) => void
} = (
  /** @type {{ roomId: string, identity: Identity }} */
  {}
)) => {
  const links = /* @__PURE__ */ new Map();
  const peerCbs = /* @__PURE__ */ new Set();
  const goneCbs = /* @__PURE__ */ new Set();
  const envelopeCbs = /* @__PURE__ */ new Set();
  const relayCbs = /* @__PURE__ */ new Set();
  const rosterWaiters = /* @__PURE__ */ new Map();
  const contentClients = /* @__PURE__ */ new Map();
  let respondContent = null;
  let pingTimer = null;
  let closed = false;
  const emit = (set, arg) => {
    for (const cb of [...set]) cb(arg);
  };
  const sign = (ch, typ, body) => signEnvelope(buildEnvelope({ ch, typ, from: identity.did, body, id: newId(), ts: now() }), identity);
  const sendTo = (did, env) => {
    const link = links.get(did);
    if (!link) return false;
    link.channel.send(env);
    return true;
  };
  const contentChannelFor = (did) => {
    const link = links.get(did);
    if (!link) return null;
    return {
      /** @param {any} m */
      send: (m) => link.channel.send(m),
      /** @param {((msg: any) => void) | null} h */
      setHandler: (h) => {
        if (h) contentClients.set(did, h);
        else contentClients.delete(did);
      }
    };
  };
  const removeLink = (did, why) => {
    const link = links.get(did);
    if (!link) return;
    links.delete(did);
    link.offClose?.();
    try {
      link.channel.close();
    } catch {
    }
    dlog("mesh", `🔌 peer ${(did || "").slice(-8)} link dropped (${why}) — ${links.size} link(s) left`);
    audit?.("peer_link_closed", { did, why });
    emit(goneCbs, { did, why });
  };
  const ctrlAllowed = (link) => {
    const t = now();
    if (t - link.ctrl.windowStart > 1e4) {
      link.ctrl.windowStart = t;
      link.ctrl.count = 0;
    }
    return ++link.ctrl.count <= ctrlRateLimit;
  };
  const handleControl = async (link, env) => {
    if (!ctrlAllowed(link)) {
      audit?.("peer_ctrl_rate_limited", { did: link.did });
      return;
    }
    const linkLocal = env.from === link.did;
    switch (env.typ) {
      case CTRL.PING:
        if (linkLocal) link.channel.send(await sign(0, CTRL.PONG, { nonce: env.body?.nonce }));
        return;
      case CTRL.PONG:
        return;
      // lastSeen already updated on receipt
      case CTRL.ROSTER_REQ: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const members = [identity.did, ...links.keys()].filter((d) => d !== link.did);
        link.channel.send(await sign(0, CTRL.ROSTER, { room: roomId, members }));
        return;
      }
      case CTRL.ROSTER: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const waiters = rosterWaiters.get(link.did);
        if (waiters) {
          rosterWaiters.delete(link.did);
          for (const res of waiters) res(env.body.members ?? []);
        }
        return;
      }
      case CTRL.RELAY: {
        const b = env.body;
        if (!b || b.room !== roomId || typeof b.to !== "string") return;
        if (b.to === identity.did) {
          emit(relayCbs, { env, via: link.did });
          return;
        }
        if (env.from !== link.did) return;
        if (!sendTo(b.to, env)) audit?.("relay_target_unreachable", { to: b.to, via: link.did });
        return;
      }
      default:
        return;
    }
  };
  const handle = async (link, msg) => {
    if (closed || !msg) return;
    if (typeof msg.t === "string" && CONTENT_REQ.has(msg.t)) {
      respondContent?.(msg, (out) => link.channel.send(out));
      return;
    }
    if (typeof msg.t === "string" && CONTENT_RESP.has(msg.t)) {
      contentClients.get(link.did)?.(msg);
      return;
    }
    if (msg.__t === "HELLO") return;
    if (msg.v !== 1 || !msg.sig) return;
    if (!await verifyEnvelope(msg)) {
      audit?.("peer_envelope_invalid", { via: link.did });
      return;
    }
    link.lastSeen = now();
    if (msg.ch === 0) return handleControl(link, msg);
    if (msg.ch !== 4 && msg.from !== link.did) {
      audit?.("peer_envelope_misattributed", { via: link.did, claimed: msg.from });
      return;
    }
    emit(envelopeCbs, { env: msg, via: link.did });
  };
  const sweep = async () => {
    const t = now();
    for (const [did, link] of [...links]) {
      if (t - link.lastSeen > idleTimeoutMs) {
        removeLink(did, "idle-timeout");
      } else if (t - link.lastSeen > pingIntervalMs) {
        link.channel.send(await sign(0, CTRL.PING, { nonce: newId().slice(0, 8) }));
      }
    }
  };
  const stopTimers = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };
  return Object.freeze({
    roomId,
    selfDid: identity.did,
    // Admit an AUTHENTICATED link (HELLO already done — did is proven).
    /** @param {Channel} channel @param {string} did @param {any} [info] */
    addLink(channel, did, info = {}) {
      if (closed) return false;
      if (did === identity.did) {
        channel.close();
        return false;
      }
      if (links.size >= budget && !links.has(did)) {
        audit?.("peer_budget_refused", { did });
        channel.close();
        return false;
      }
      if (links.has(did)) removeLink(did, "replaced");
      const link = { did, channel, lastSeen: now(), ctrl: { windowStart: now(), count: 0 }, info };
      link.offClose = channel.onClose(() => {
        if (links.get(did) === link) {
          links.delete(did);
          audit?.("peer_link_closed", { did, why: "channel-closed" });
          emit(goneCbs, { did, why: "channel-closed" });
        }
      });
      links.set(did, link);
      channel.setHandler((msg) => {
        handle(link, msg);
      });
      audit?.("peer_connected", { did, room: roomId });
      emit(peerCbs, { did, info });
      return true;
    },
    /** @param {string} did */
    removeLink: (did) => removeLink(did, "removed"),
    /** @param {string} did */
    hasLink: (did) => links.has(did),
    // Merge telemetry onto a link (e.g. the ICE path once stats settle).
    /** @param {string} did @param {any} patch */
    tagLink(did, patch) {
      const link = links.get(did);
      if (link) link.info = { ...link.info, ...patch };
    },
    peers: () => [...links.values()].map((l) => ({ did: l.did, lastSeen: l.lastSeen, info: l.info, channel: l.channel })),
    /** @param {(arg: any) => void} cb */
    onPeer: (cb) => {
      peerCbs.add(cb);
      return () => peerCbs.delete(cb);
    },
    /** @param {(arg: any) => void} cb */
    onPeerGone: (cb) => {
      goneCbs.add(cb);
      return () => goneCbs.delete(cb);
    },
    /** @param {(arg: any) => void} cb */
    onEnvelope: (cb) => {
      envelopeCbs.add(cb);
      return () => envelopeCbs.delete(cb);
    },
    /** @param {(arg: any) => void} cb */
    onRelay: (cb) => {
      relayCbs.add(cb);
      return () => relayCbs.delete(cb);
    },
    // Build-and-sign for upper layers (gossip), so the envelope shape and
    // signing stay in one place.
    sign,
    send: sendTo,
    /** @param {any} env @param {string | null} [exceptDid] */
    broadcast(env, exceptDid = null) {
      for (const [did, link] of links) {
        if (did !== exceptDid) link.channel.send(env);
      }
    },
    // "Who do you see in this room?" — the server-optional roster.
    /** @param {string} did @param {{ timeoutMs?: number }} [opts] */
    requestRoster(did, { timeoutMs = 1e4 } = {}) {
      return new Promise((resolve, reject) => {
        const link = links.get(did);
        if (!link) return reject(new Error(`requestRoster: no link to ${did}`));
        const timer = setTimeout(() => {
          rosterWaiters.get(did)?.delete(settle);
          reject(new Error("roster request timed out"));
        }, timeoutMs);
        const settle = (members) => {
          clearTimeout(timer);
          resolve(members);
        };
        let waiters = rosterWaiters.get(did);
        if (!waiters) {
          waiters = /* @__PURE__ */ new Set();
          rosterWaiters.set(did, waiters);
        }
        waiters.add(settle);
        sign(0, CTRL.ROSTER_REQ, { room: roomId }).then((env) => link.channel.send(env));
      });
    },
    // Send a RELAY frame to `to` THROUGH `via` (a direct link). The body's
    // payload is opaque (SDP); sid correlates offer/answer.
    /**
     * @param {string} via @param {string} to @param {string} kind
     * @param {string} sid @param {any} payload
     */
    async relay(via, to, kind, sid, payload) {
      const env = await sign(0, CTRL.RELAY, { room: roomId, to, kind, sid, payload });
      if (!sendTo(via, env)) throw new Error(`relay: no link to via-peer ${via}`);
    },
    // Content multiplexing on mesh links (announce-set rules unchanged —
    // createContentResponder consults the store).
    /** @param {any} store */
    serveContent(store) {
      respondContent = store ? createContentResponder({ store }) : null;
    },
    // The swarm fetcher reads null as "unreachable" and skips the provider; the
    // per-hop dialer is what later turns a null into a channel for an unlinked
    // provider (it dials first, then this returns a live channel).
    contentChannel: contentChannelFor,
    /** @param {string} did @param {string} uri @param {any} [opts] */
    fetchFrom(did, uri, opts = {}) {
      const channel = contentChannelFor(did);
      if (!channel) return Promise.reject(new Error(`fetchFrom: no link to ${did}`));
      return fetchBundle({ uri, channel, ...opts }).finally(() => contentClients.delete(did));
    },
    // Liveness. start() is explicit so tests (and short-lived dances) can
    // run without timers.
    start: () => {
      if (!pingTimer) pingTimer = setInterval(sweep, Math.min(pingIntervalMs, idleTimeoutMs) / 3);
    },
    stop: stopTimers,
    close: () => {
      if (closed) return;
      closed = true;
      stopTimers();
      for (const did of [...links.keys()]) removeLink(did, "mesh-closed");
    }
  });
};

// ../peerd/extension/peerd-distributed/transport/session.js
var newId2 = () => crypto.randomUUID();
var createSession = async ({ channel, identity, caps = ["content"], now = Date.now }) => {
  let resolveHello;
  let rejectHello;
  const helloReceived = new Promise((res, rej) => {
    resolveHello = res;
    rejectHello = rej;
  });
  const stashed = [];
  channel.setHandler(async (msg) => {
    if (msg && msg.__t === "HELLO") {
      const ok = await verifyEnvelope(msg.env);
      if (!ok) return rejectHello(new Error("peer HELLO signature invalid"));
      if (msg.env.body?.proto !== 1) {
        return rejectHello(new Error(`unsupported protocol version: ${msg.env.body?.proto}`));
      }
      return resolveHello(msg.env.from);
    }
    stashed.push(msg);
  });
  const hello = await signEnvelope(
    buildEnvelope({ ch: 0, typ: 0, from: identity.did, body: { proto: 1, caps }, id: newId2(), ts: now() }),
    identity
  );
  channel.send({ __t: "HELLO", env: hello });
  const remoteDid = await helloReceived;
  channel.setHandler(null);
  for (const m of stashed) channel.deliver(m);
  return { remoteDid };
};

// ../peerd/extension/peerd-distributed/transport/rooms.js
var short = (did) => (did || "").slice(-8);
var newId3 = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
var ANSWER_TIMEOUT_MS = 15e3;
var joinRoom = async ({
  roomId,
  identity,
  url = DEFAULT_SIGNALING[0],
  iceServers,
  transport,
  WebSocket: WS = globalThis.WebSocket,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  now = Date.now,
  audit = null,
  budget,
  caps = ["content", "pubsub"],
  kind: peerKind
  // 'website' = observe-only visitor (own rendezvous cap pool); omitted/default = extension
} = (
  /** @type {{ roomId: string, identity: import('./mesh.js').Identity }} */
  {}
)) => {
  const t = transport ?? createWebrtcTransport({ iceServers });
  const mesh = createRoomMesh({ roomId, identity, now, budget, audit });
  const statusCbs = /* @__PURE__ */ new Set();
  let rendezvousState = url ? "connecting" : "none";
  let session = null;
  let left = false;
  const setStatus = (s) => {
    rendezvousState = s;
    for (const cb of [...statusCbs]) cb({ rendezvous: s });
  };
  const admit = async (channel, expectedDid = null, via = null) => {
    const { remoteDid } = await createSession({ channel, identity, caps, now });
    if (expectedDid && remoteDid !== expectedDid) {
      channel.close();
      audit?.("peer_did_mismatch", { expected: expectedDid, got: remoteDid });
      throw new Error("peer authenticated as a different did than expected");
    }
    if (mesh.hasLink(remoteDid)) {
      dlog("room", `already linked to ${short(remoteDid)} — dropping duplicate channel`);
      channel.close();
      return remoteDid;
    }
    mesh.addLink(channel, remoteDid);
    if (via) mesh.tagLink(remoteDid, { via });
    dlog("room", `✅ CONNECTED to peer ${short(remoteDid)} — data channel open, in the mesh`);
    if (channel.pc) {
      connectionPath(channel.pc).then((p) => {
        mesh.tagLink(remoteDid, { path: p.path });
        dlog("room", `peer ${short(remoteDid)} connectivity: ${p.path}`);
        audit?.("peer_path", { did: remoteDid, path: p.path });
      });
    }
    return remoteDid;
  };
  const makeSignaling = (send) => {
    let handler = null;
    const buffer = [];
    return {
      /** @param {any} payload */
      route: (payload) => {
        if (handler) handler(payload);
        else buffer.push(payload);
      },
      signaling: {
        send,
        /** @param {(payload: any) => void} h */
        onRemote: (h) => {
          handler = h;
          while (buffer.length) h(buffer.shift());
          return () => {
            handler = null;
          };
        }
      }
    };
  };
  const withConnectTimeout = (promise, label) => Promise.race([
    promise,
    /** @type {Promise<T>} */
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ANSWER_TIMEOUT_MS))
  ]);
  const logConnectFail = (what, who, e) => {
    const msg = (
      /** @type {{ message?: string }} */
      e?.message ?? String(e)
    );
    if (msg.includes("timed out")) dlog("room", `${what} ${short(who)} timed out — likely a stale roster member, skipping`);
    else dwarn("room", `${what} ${short(who)} failed: ${msg}`);
  };
  const attachSession = (s) => {
    const routers = /* @__PURE__ */ new Map();
    s.on("signal", async ({ from, payload }) => {
      const route = routers.get(from);
      if (route) {
        route(payload);
        return;
      }
      if (payload?.type !== "offer") return;
      dlog("room", `📥 offer from ${from} — answering (trickle)`);
      const { route: r, signaling } = makeSignaling((p) => s.sendSignal(from, p));
      routers.set(from, r);
      const ac = new AbortController();
      try {
        const { channel } = await t.accept({ offer: payload, iceServers, signaling, signal: ac.signal });
        await admit(await withConnectTimeout(channel, `accept ${from}`), null, "rendezvous");
      } catch (e) {
        logConnectFail("accept from", from, e);
        audit?.("room_accept_failed", { member: from, error: (
          /** @type {{ message?: string }} */
          e?.message
        ) });
      } finally {
        ac.abort();
        routers.delete(from);
      }
    });
    s.on("closed", () => {
      if (s !== session) return;
      audit?.("rendezvous_lost", { roomId });
      scheduleReconnect();
    });
    const dial = async (member) => {
      dlog("room", `📞 dialing ${member} (trickle: offer now, candidates streaming)…`);
      const { route, signaling } = makeSignaling((p) => s.sendSignal(member, p));
      routers.set(member, route);
      const ac = new AbortController();
      try {
        const channel = await withConnectTimeout(
          t.connect({ did: `${roomId}/${member}` }, { iceServers, signaling, signal: ac.signal }),
          `dial ${member}`
        );
        await admit(channel, null, "rendezvous");
      } catch (e) {
        logConnectFail("dial to", member, e);
        audit?.("room_dial_failed", { member, error: (
          /** @type {{ message?: string }} */
          e?.message
        ) });
      } finally {
        ac.abort();
        routers.delete(member);
      }
    };
    return { dial };
  };
  const relayRouters = /* @__PURE__ */ new Map();
  mesh.onRelay(async ({ env, via }) => {
    const { kind, sid, payload } = env.body;
    if (kind === "offer") {
      dlog("room", `📥 relayed offer via ${short(via)} — answering`);
      const { route, signaling } = makeSignaling((p) => mesh.relay(via, env.from, p.type === "answer" ? "answer" : "ice", sid, p));
      relayRouters.set(sid, route);
      const ac = new AbortController();
      try {
        const { channel } = await t.accept({ offer: payload, iceServers, signaling, signal: ac.signal });
        await admit(await withConnectTimeout(channel, `relay accept ${short(env.from)}`), env.from, via);
        audit?.("relay_join_accepted", { did: env.from, via });
      } catch (e) {
        logConnectFail("relay accept", env.from, e);
        audit?.("relay_accept_failed", { from: env.from, error: (
          /** @type {{ message?: string }} */
          e?.message
        ) });
      } finally {
        ac.abort();
        relayRouters.delete(sid);
      }
      return;
    }
    relayRouters.get(sid)?.(payload);
  });
  const dialViaRelay = async (via, targetDid) => {
    const sid = newId3();
    dlog("room", `📞 relay-dialing ${short(targetDid)} via ${short(via)}…`);
    const { route, signaling } = makeSignaling((p) => mesh.relay(via, targetDid, p.type === "offer" ? "offer" : "ice", sid, p));
    relayRouters.set(sid, route);
    const ac = new AbortController();
    try {
      const channel = await withConnectTimeout(
        t.connect({ did: targetDid }, { iceServers, signaling, signal: ac.signal }),
        `relay dial ${short(targetDid)}`
      );
      await admit(channel, targetDid, via);
    } finally {
      ac.abort();
      relayRouters.delete(sid);
    }
  };
  const expandViaPeer = async (viaDid) => {
    const members = (
      /** @type {string[]} */
      await mesh.requestRoster(viaDid)
    );
    const results = await Promise.allSettled(
      members.filter((d) => d !== identity.did && !mesh.hasLink(d)).map((d) => dialViaRelay(viaDid, d))
    );
    for (const r of results) {
      if (r.status === "rejected") audit?.("relay_dial_failed", { error: r.reason?.message });
    }
  };
  let reconnectTimer = null;
  let backoffMs = 2e3;
  const RECONNECT_MAX_MS = 3e4;
  const OUTAGE_WARN_MS = 6e4;
  let reconnectFailures = 0;
  let outageSince = 0;
  let outageWarned = false;
  const connectRendezvous = async () => {
    if (left) return;
    const s = await openRendezvous({ url: (
      /** @type {string} */
      url
    ), room: roomId, WebSocket: WS, kind: peerKind });
    if (left) {
      s.close();
      return;
    }
    session = s;
    setStatus("up");
    backoffMs = 2e3;
    if (outageWarned) dlog("room", `rendezvous recovered after ${Math.round((Date.now() - outageSince) / 1e3)}s`);
    reconnectFailures = 0;
    outageSince = 0;
    outageWarned = false;
    const { dial } = attachSession(session);
    if (session.members.length === 0) dlog("room", "first one here — waiting for others to join and offer");
    else dlog("room", `${session.members.length} member(s) here — dialing each:`, session.members);
    await Promise.allSettled(session.members.map(dial));
  };
  const scheduleReconnect = () => {
    if (left || reconnectTimer) return;
    setStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRendezvous().catch((e) => {
        reconnectFailures += 1;
        if (!outageSince) outageSince = Date.now();
        const downMs = Date.now() - outageSince;
        if (!outageWarned && downMs >= OUTAGE_WARN_MS) {
          outageWarned = true;
          dwarn("room", `rendezvous unreachable for ${Math.round(downMs / 1e3)}s (${reconnectFailures} attempts): ${e?.message ?? e} — still retrying`);
        } else {
          dlog("room", `rendezvous reconnect failed (attempt ${reconnectFailures}): ${e?.message ?? e} — retrying`);
        }
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        scheduleReconnect();
      });
    }, backoffMs);
  };
  dlog("room", `joining room "${roomId}" as ${short(identity.did)} via ${url}`);
  if (url) await connectRendezvous();
  mesh.start();
  dlog("room", `room "${roomId}" assembled — ${mesh.peers().length} live peer link(s)`);
  return Object.freeze({
    roomId,
    did: identity.did,
    mesh,
    peers: mesh.peers,
    onPeer: mesh.onPeer,
    onPeerGone: mesh.onPeerGone,
    onEnvelope: mesh.onEnvelope,
    /** @param {(arg: { rendezvous: string }) => void} cb */
    onStatus: (cb) => {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    rendezvous: () => rendezvousState,
    expandViaPeer,
    // Targeted relay-dial: reach `targetDid` through a peer we already link
    // (`brokerDid` forwards the signaling). The DHT dialer uses this to connect
    // to a lookup contact it doesn't link yet. Resolves once linked, throws on
    // timeout. One hop only — `brokerDid` must be directly linked.
    /** @param {string} brokerDid @param {string} targetDid */
    dialVia: (brokerDid, targetDid) => dialViaRelay(brokerDid, targetDid),
    leave() {
      if (left) return;
      left = true;
      clearTimeout(reconnectTimer ?? void 0);
      try {
        session?.close();
      } catch {
      }
      mesh.close();
    }
  });
};

// ../peerd/extension/peerd-distributed/gossip/topic.js
var PUB = 0;
var MAX_GOSSIP_ENVELOPE_BYTES = 32 * 1024;
var createGossip = ({
  mesh,
  now = Date.now,
  seenCap = 4096,
  // ~20 msgs/s sustained per sender, bursts to 40 — generous for a doc's
  // CRDT updates + cursors, tight enough that one peer can't bury a room.
  ratePerSec = 20,
  rateBurst = 40,
  maxEnvelopeBytes = MAX_GOSSIP_ENVELOPE_BYTES,
  audit = null
} = (
  /** @type {{ mesh: any }} */
  {}
)) => {
  const subs = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const buckets = /* @__PURE__ */ new Map();
  const muted = /* @__PURE__ */ new Set();
  const taps = /* @__PURE__ */ new Set();
  const markSeen = (sig) => {
    seen.add(sig);
    if (seen.size > seenCap) {
      const first = (
        /** @type {string} */
        seen.values().next().value
      );
      seen.delete(first);
    }
  };
  const allow = (did) => {
    const t = now();
    let b = buckets.get(did);
    if (!b) {
      b = { tokens: rateBurst, last: t };
      buckets.set(did, b);
    }
    b.tokens = Math.min(rateBurst, b.tokens + (t - b.last) / 1e3 * ratePerSec);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const oversized = (env, topic) => {
    if (envelopeBytes(env) <= maxEnvelopeBytes) return false;
    audit?.("gossip_envelope_oversized", { did: env.from, topic, cap: maxEnvelopeBytes });
    return true;
  };
  const deliver = (env, via) => {
    const { topic, data } = env.body;
    const msg = { from: env.from, data, ts: env.ts, id: env.id, env, via };
    for (const cb of [...subs.get(topic) ?? []]) cb(msg);
    for (const cb of [...taps]) cb(msg, topic);
  };
  const offEnvelope = mesh.onEnvelope(({ env, via }) => {
    if (env.ch !== 4 || env.typ !== PUB) return;
    if (!env.body || typeof env.body.topic !== "string") return;
    if (seen.has(env.sig)) return;
    markSeen(env.sig);
    if (muted.has(env.from)) return;
    if (!allow(env.from)) {
      audit?.("gossip_rate_limited", { did: env.from, topic: env.body.topic });
      return;
    }
    if (oversized(env, env.body.topic)) return;
    deliver(env, via);
    mesh.broadcast(env, via);
  });
  return Object.freeze({
    /**
     * @param {string} topic
     * @param {any} data
     */
    async publish(topic, data) {
      const env = await mesh.sign(4, PUB, { topic, data });
      markSeen(env.sig);
      mesh.broadcast(env);
      return env;
    },
    /**
     * @param {string} topic
     * @param {(msg: GossipMsg) => void} cb
     */
    subscribe(topic, cb) {
      let set = subs.get(topic);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        subs.set(topic, set);
      }
      set.add(cb);
      return () => subs.get(topic)?.delete(cb);
    },
    // The sync layer's firehose: every delivered publish, any topic.
    /** @param {(msg: GossipMsg, topic: string) => void} cb */
    tap(cb) {
      taps.add(cb);
      return () => taps.delete(cb);
    },
    // Re-deliver an envelope that arrived OUTSIDE the live flood (backfill
    // sync). Never re-broadcast — backfill is point-to-point (gossip/sync.js).
    //
    // why deliver even when already `seen`: on the SHARED base mesh a peer
    // flood-relays every room's messages, including rooms it hasn't joined — so
    // a topic's frame is often marked seen (for loop-prevention) while no local
    // subscriber existed to receive it. Backfill is exactly how a now-subscribed
    // topic recovers those, so a seen frame must still DELIVER here; it just
    // won't re-mark or re-flood. (A live-delivered retained frame is already in
    // the store, so the have-list keeps it from being re-served — no double
    // delivery in practice; apps id-dedup regardless.) Returns whether the frame
    // was newly seen, so sync.js stores fresh-vs-backfilled correctly.
    /**
     * @param {any} env
     * @param {any} [via]
     */
    ingest(env, via = null) {
      if (env.ch !== 4 || env.typ !== PUB) return false;
      if (!env.body || typeof env.body.topic !== "string") return false;
      if (muted.has(env.from)) return false;
      if (oversized(env, env.body.topic)) return false;
      const fresh = !seen.has(env.sig);
      if (fresh) markSeen(env.sig);
      deliver(env, via);
      return fresh;
    },
    /** @param {string} sig */
    hasSeen: (sig) => seen.has(sig),
    /** @param {string} did */
    mute(did) {
      muted.add(did);
      audit?.("gossip_muted", { did });
    },
    /** @param {string} did */
    unmute(did) {
      muted.delete(did);
    },
    /** @param {string} did */
    isMuted: (did) => muted.has(did),
    close() {
      offEnvelope();
      subs.clear();
      taps.clear();
    }
  });
};

// ../peerd/extension/peerd-distributed/gossip/presence.js
var PRESENCE_TOPIC = "~presence";
var FORGET_SUPPRESS_MS = 3e3;
var createPresence = ({
  gossip,
  selfDid,
  meta = () => ({}),
  // The gossip topic the beacon rides. Defaults to the lobby's '~presence';
  // a room (sub-protocol) passes a namespaced topic so its membership is
  // scoped to that room while sharing the one base mesh (base-network.js).
  topic = PRESENCE_TOPIC,
  heartbeatMs = 1e4,
  expireMs = 25e3,
  // match the mesh idle timeout — drop a gone peer from both layers together
  now = Date.now
} = (
  /** @type {{ gossip: any, selfDid: string }} */
  {}
)) => {
  const here = /* @__PURE__ */ new Map();
  const forgotten = /* @__PURE__ */ new Map();
  const joinCbs = /* @__PURE__ */ new Set();
  const leaveCbs = /* @__PURE__ */ new Set();
  let beat = null;
  let sweepTimer = null;
  const emit = (set, arg) => {
    for (const cb of [...set]) cb(arg);
  };
  const offSub = gossip.subscribe(topic, ({ from, data }) => {
    if (from === selfDid) return;
    const until = forgotten.get(from);
    if (until !== void 0) {
      if (now() < until) return;
      forgotten.delete(from);
    }
    const known = here.has(from);
    here.set(from, { lastSeen: now(), meta: data?.meta ?? {} });
    if (!known) emit(joinCbs, { did: from, meta: data?.meta ?? {} });
  });
  const sweep = () => {
    const t = now();
    for (const [did, p] of [...here]) {
      if (t - p.lastSeen > expireMs) {
        here.delete(did);
        emit(leaveCbs, { did });
      }
    }
    for (const [did, until] of [...forgotten]) if (t >= until) forgotten.delete(did);
  };
  const beacon = () => gossip.publish(topic, { meta: meta() });
  return Object.freeze({
    start() {
      if (beat) return;
      beacon();
      beat = setInterval(beacon, heartbeatMs);
      sweepTimer = setInterval(sweep, Math.max(1, Math.floor(expireMs / 3)));
    },
    stop() {
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
    announce: beacon,
    // app changed its meta (renamed) — beacon now
    // Drop a peer NOW (don't wait for the beacon to expire) — used when the mesh
    // tells us the link died, so a disconnected peer leaves the view at once.
    // Arms a short suppression window (FORGET_SUPPRESS_MS) so the peer's last
    // in-flight beacon can't immediately resurrect it as a ghost; a genuine
    // re-join keeps beaconing and is re-added once the window passes.
    /** @param {string} did */
    forget: (did) => {
      forgotten.set(did, now() + FORGET_SUPPRESS_MS);
      if (here.delete(did)) emit(leaveCbs, { did });
    },
    list: () => [...here.entries()].map(([did, p]) => ({ did, ...p })),
    /** @param {(arg: { did: string, meta?: any }) => void} cb */
    onJoin: (cb) => {
      joinCbs.add(cb);
      return () => joinCbs.delete(cb);
    },
    /** @param {(arg: { did: string }) => void} cb */
    onLeave: (cb) => {
      leaveCbs.add(cb);
      return () => leaveCbs.delete(cb);
    },
    close() {
      offSub();
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      here.clear();
      forgotten.clear();
    }
  });
};

// ../peerd/extension/peerd-distributed/messaging/direct.js
var MSG = 0;
var createDirect = ({ mesh }) => {
  const subs = /* @__PURE__ */ new Set();
  const off = mesh.onEnvelope(({ env }) => {
    if (env.ch !== 3 || env.typ !== MSG || !env.body) return;
    const msg = { from: env.from, data: env.body.data, ts: env.ts, id: env.id };
    for (const cb of [...subs]) cb(msg);
  });
  return Object.freeze({
    // Send `data` to ONE recipient over their direct link. Rejects when no
    // live link exists (the recipient isn't a directly-connected peer):
    // honest failure now, store-and-forward to offline peers is §6.2's job.
    /** @param {string} toDid @param {any} data */
    async send(toDid, data) {
      const env = await mesh.sign(3, MSG, { data });
      if (!mesh.send(toDid, env)) throw new Error(`no direct link to ${(toDid || "").slice(-8)}`);
      return { id: env.id, ts: env.ts };
    },
    /** @param {(msg: DirectMsg) => void} cb */
    onMessage(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    close() {
      off();
      subs.clear();
    }
  });
};

// ../peerd/extension/peerd-distributed/apps/room-voice.js
var MEDIA_MARKER = 1;
var MAX_PEERS = 15;
var MAX_SESSION = 64;
var MAX_SDP = 16384;
var MAX_CANDIDATE = 4096;
var MAX_PENDING_ICE = 64;
var MAX_SIGNALS_PER_WINDOW = 160;
var MAX_OFFERS_PER_WINDOW = 6;
var SIGNAL_WINDOW_MS = 1e4;
var MAX_SIGNAL_BYTES_PER_WINDOW = 256 * 1024;
var mediaSessionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
var isRoomVoiceSignal = (data) => {
  if (data?.__peerdMedia !== MEDIA_MARKER || typeof data.kind !== "string" || typeof data.scope !== "string" || data.scope.length < 1 || data.scope.length > 64 || typeof data.session !== "string" || data.session.length < 12 || data.session.length > MAX_SESSION) return false;
  if (data.replyTo !== void 0 && (typeof data.replyTo !== "string" || data.replyTo.length < 12 || data.replyTo.length > MAX_SESSION)) return false;
  if (data.kind === "ready") return typeof data.ack === "boolean";
  if (data.kind === "hangup") return data.replyTo === void 0;
  if (data.kind === "offer" || data.kind === "answer") {
    return typeof data.sdp === "string" && data.sdp.length > 0 && data.sdp.length <= MAX_SDP && typeof data.replyTo === "string";
  }
  if (data.kind !== "ice" || typeof data.replyTo !== "string") return false;
  return typeof data.candidate === "string" && data.candidate.length <= MAX_CANDIDATE && (data.sdpMid === null || typeof data.sdpMid === "string" && data.sdpMid.length <= 64) && (data.sdpMLineIndex === null || Number.isSafeInteger(data.sdpMLineIndex) && data.sdpMLineIndex >= 0 && data.sdpMLineIndex <= 64);
};
var isAudioOnlySdp = (sdp) => {
  const media = sdp.split(/\r?\n/).filter((line) => line.startsWith("m="));
  return media.length === 1 && media[0].startsWith("m=audio ");
};
var preferOpus = (transceiver) => {
  if (!transceiver.setCodecPreferences) return;
  const capabilities = globalThis.RTCRtpReceiver?.getCapabilities?.("audio")?.codecs ?? [];
  const opus = capabilities.filter((codec) => codec.mimeType?.toLowerCase() === "audio/opus");
  if (!opus.length) return;
  try {
    transceiver.setCodecPreferences(opus);
  } catch {
  }
};
var createRoomVoice = ({
  selfDid,
  scope,
  sendSignal,
  onState = () => {
  },
  iceServers = DEFAULT_ICE_SERVERS,
  RTCPeerConnection: PeerConnection = globalThis.RTCPeerConnection,
  mediaDevices = globalThis.navigator?.mediaDevices,
  createAudio = () => document.createElement("audio")
}) => {
  let stream = null;
  let muted = false;
  let playbackBlocked = false;
  let localSession = "";
  let generation = 0;
  let startInFlight = null;
  let allowedPeers = /* @__PURE__ */ new Set();
  const remoteSessions = /* @__PURE__ */ new Map();
  const connections = /* @__PURE__ */ new Map();
  const signalQueues = /* @__PURE__ */ new Map();
  const outboundQueues = /* @__PURE__ */ new Map();
  const earlyIce = /* @__PURE__ */ new Map();
  const peerFlow = /* @__PURE__ */ new Map();
  const disconnectTimers = /* @__PURE__ */ new Map();
  const state = () => ({ active: !!stream, muted, peers: connections.size, codec: "opus", playbackBlocked });
  const report = () => onState(state());
  const send = (peer, signal) => {
    const queued = (outboundQueues.get(peer) ?? Promise.resolve()).catch(() => {
    }).then(() => sendSignal(peer, signal)).catch(() => {
    });
    outboundQueues.set(peer, queued);
    queued.finally(() => {
      if (outboundQueues.get(peer) === queued) outboundQueues.delete(peer);
    });
    return queued;
  };
  const closePeer = (peer, notify = false) => {
    const record = connections.get(peer);
    if (!record) return;
    connections.delete(peer);
    const timer = disconnectTimers.get(peer);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(peer);
    record.pc.onicecandidate = null;
    record.pc.ontrack = null;
    record.pc.onconnectionstatechange = null;
    try {
      record.pc.close();
    } catch {
    }
    try {
      record.audio.pause();
    } catch {
    }
    record.audio.srcObject = null;
    record.audio.remove?.();
    if (notify && localSession) send(peer, {
      __peerdMedia: MEDIA_MARKER,
      scope,
      kind: "hangup",
      session: localSession
    });
    report();
  };
  const sendReady = (peer, ack) => {
    if (!stream || !localSession || !allowedPeers.has(peer)) return;
    send(peer, { __peerdMedia: MEDIA_MARKER, scope, kind: "ready", session: localSession, ack });
  };
  const allowAllocation = (peer) => {
    const now = performance.now();
    let flow = peerFlow.get(peer);
    if (!flow || now - flow.started >= SIGNAL_WINDOW_MS) {
      flow = { started: now, signals: 0, sdps: 0, bytes: 0, allocations: 0 };
      peerFlow.set(peer, flow);
    }
    if (flow.allocations >= MAX_OFFERS_PER_WINDOW) return false;
    flow.allocations += 1;
    return true;
  };
  const makePeer = (peer, remoteSession) => {
    if (!PeerConnection) throw new Error("WebRTC voice is unavailable");
    if (!allowAllocation(peer)) return null;
    closePeer(peer);
    const pc = new PeerConnection({ iceServers });
    const audio = createAudio();
    audio.autoplay = true;
    audio.setAttribute?.("playsinline", "");
    const local = stream;
    const track = local?.getAudioTracks?.()[0];
    if (!local || !track) throw new Error("microphone track unavailable");
    try {
      const transceiver = pc.addTransceiver(track, { direction: "sendrecv", streams: [local] });
      preferOpus(transceiver);
      if ("contentHint" in track) track.contentHint = "speech";
      const parameters = transceiver.sender?.getParameters?.();
      if (parameters) {
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 48e3;
        Promise.resolve(transceiver.sender.setParameters(parameters)).catch(() => {
        });
      }
    } catch (error) {
      try {
        pc.close();
      } catch {
      }
      audio.remove?.();
      throw error;
    }
    const record = (
      /** @type {VoicePeer} */
      { pc, audio, remoteSession, pendingIce: [] }
    );
    connections.set(peer, record);
    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate || connections.get(peer) !== record) return;
      send(peer, {
        __peerdMedia: MEDIA_MARKER,
        scope,
        kind: "ice",
        session: localSession,
        replyTo: record.remoteSession,
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex
      });
    };
    pc.ontrack = (event) => {
      if (connections.get(peer) !== record) return;
      const [remote] = event.streams;
      audio.srcObject = remote ?? new MediaStream([event.track]);
      Promise.resolve(audio.play?.()).then(() => {
        if (playbackBlocked) {
          playbackBlocked = false;
          report();
        }
      }).catch(() => {
        if (!playbackBlocked) {
          playbackBlocked = true;
          report();
        }
      });
    };
    pc.onconnectionstatechange = () => {
      if (connections.get(peer) !== record) return;
      if (pc.connectionState === "connected") {
        const timer = disconnectTimers.get(peer);
        if (timer) clearTimeout(timer);
        disconnectTimers.delete(peer);
        report();
        return;
      }
      if (pc.connectionState === "disconnected") {
        if (!disconnectTimers.has(peer)) disconnectTimers.set(peer, setTimeout(() => {
          disconnectTimers.delete(peer);
          if (connections.get(peer) === record && pc.connectionState === "disconnected") {
            closePeer(peer);
            sendReady(peer, false);
          }
        }, 3e3));
        return;
      }
      if (pc.connectionState === "failed") {
        closePeer(peer);
        sendReady(peer, false);
      }
    };
    report();
    return record;
  };
  const makeOffer = async (peer, remoteSession) => {
    if (!stream || selfDid >= peer || !allowedPeers.has(peer)) return;
    const existing = connections.get(peer);
    if (existing && existing.remoteSession === remoteSession && existing.pc.signalingState !== "closed") return;
    const record = makePeer(peer, remoteSession);
    if (!record) return;
    const offer = await record.pc.createOffer();
    if (connections.get(peer) !== record) return;
    await record.pc.setLocalDescription(offer);
    if (connections.get(peer) !== record || !record.pc.localDescription?.sdp) return;
    await send(peer, {
      __peerdMedia: MEDIA_MARKER,
      scope,
      kind: "offer",
      session: localSession,
      replyTo: remoteSession,
      sdp: record.pc.localDescription.sdp
    });
  };
  const flushIce = async (record) => {
    const pending = record.pendingIce.splice(0);
    for (const candidate of pending) await record.pc.addIceCandidate(candidate).catch(() => {
    });
  };
  const handleSignal = async (from, data) => {
    if (!isRoomVoiceSignal(data) || data.scope !== scope || !stream || !allowedPeers.has(from) || from === selfDid) return true;
    if (data.kind === "ready") {
      const previous = remoteSessions.get(from);
      remoteSessions.set(from, data.session);
      if (previous && previous !== data.session) closePeer(from);
      if (!data.ack) sendReady(from, true);
      await makeOffer(from, data.session);
      return true;
    }
    if (data.kind === "hangup") {
      if (remoteSessions.get(from) === data.session) {
        remoteSessions.delete(from);
        closePeer(from);
      }
      return true;
    }
    if (data.replyTo !== void 0 && data.replyTo !== localSession) return true;
    if (data.kind === "offer") {
      if (selfDid <= from) return true;
      if (!isAudioOnlySdp(data.sdp)) return true;
      const previous = remoteSessions.get(from);
      if (previous && previous !== data.session) closePeer(from);
      remoteSessions.set(from, data.session);
      const record2 = makePeer(from, data.session);
      if (!record2) return true;
      const early = earlyIce.get(from);
      if (early && early.session === data.session) record2.pendingIce.push(...early.candidates);
      earlyIce.delete(from);
      await record2.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      await flushIce(record2);
      const answer = await record2.pc.createAnswer();
      if (connections.get(from) !== record2) return true;
      await record2.pc.setLocalDescription(answer);
      if (!record2.pc.localDescription?.sdp) return true;
      await send(from, {
        __peerdMedia: MEDIA_MARKER,
        scope,
        kind: "answer",
        session: localSession,
        replyTo: data.session,
        sdp: record2.pc.localDescription.sdp
      });
      return true;
    }
    const record = connections.get(from);
    if ((!record || record.remoteSession !== data.session) && data.kind === "ice") {
      let early = earlyIce.get(from);
      if (!early || early.session !== data.session) {
        early = { session: data.session, candidates: [] };
        earlyIce.set(from, early);
      }
      if (early.candidates.length < MAX_PENDING_ICE) early.candidates.push({
        candidate: data.candidate,
        sdpMid: data.sdpMid,
        sdpMLineIndex: data.sdpMLineIndex
      });
      return true;
    }
    if (!record || record.remoteSession !== data.session) return true;
    if (data.kind === "answer") {
      if (selfDid >= from || record.pc.signalingState !== "have-local-offer" || !isAudioOnlySdp(data.sdp)) return true;
      await record.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      await flushIce(record);
      return true;
    }
    const candidate = {
      candidate: data.candidate,
      sdpMid: data.sdpMid,
      sdpMLineIndex: data.sdpMLineIndex
    };
    if (!record.pc.remoteDescription) {
      if (record.pendingIce.length < MAX_PENDING_ICE) record.pendingIce.push(candidate);
    } else await record.pc.addIceCandidate(candidate).catch(() => {
    });
    return true;
  };
  const ingestSignal = (from, data) => {
    if (!isRoomVoiceSignal(data)) return Promise.resolve(false);
    const now = performance.now();
    let flow = peerFlow.get(from);
    if (!flow || now - flow.started >= SIGNAL_WINDOW_MS) {
      flow = { started: now, signals: 0, sdps: 0, bytes: 0, allocations: 0 };
      peerFlow.set(from, flow);
    }
    flow.signals += 1;
    if (data.kind === "offer" || data.kind === "answer") flow.sdps += 1;
    flow.bytes += data.sdp?.length ?? data.candidate?.length ?? 64;
    if (flow.signals > MAX_SIGNALS_PER_WINDOW || flow.sdps > MAX_OFFERS_PER_WINDOW || flow.bytes > MAX_SIGNAL_BYTES_PER_WINDOW) return Promise.resolve(true);
    const signalGeneration = generation;
    const queued = (signalQueues.get(from) ?? Promise.resolve()).catch(() => {
    }).then(() => signalGeneration === generation ? handleSignal(from, data) : true);
    signalQueues.set(from, queued);
    queued.finally(() => {
      if (signalQueues.get(from) === queued) signalQueues.delete(from);
    });
    return queued;
  };
  const setPeers = (peers) => {
    const next = new Set(peers.filter((peer) => typeof peer === "string" && peer && peer !== selfDid).slice(0, MAX_PEERS));
    for (const peer of allowedPeers) {
      if (!next.has(peer)) {
        closePeer(peer, true);
        remoteSessions.delete(peer);
      }
    }
    const added = [...next].filter((peer) => !allowedPeers.has(peer));
    allowedPeers = next;
    for (const peer of added) sendReady(peer, false);
    return { peers: allowedPeers.size };
  };
  const start = async ({ muted: startMuted = false, startMuted: legacyMuted } = {}) => {
    if (legacyMuted !== void 0) startMuted = legacyMuted;
    if (stream) return setMuted(startMuted);
    if (startInFlight) {
      await startInFlight;
      return setMuted(startMuted);
    }
    if (!PeerConnection || !mediaDevices?.getUserMedia) throw new Error("WebRTC microphone capture is unavailable");
    const token = ++generation;
    startInFlight = (async () => {
      const captured = await mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      if (token !== generation) {
        for (const track of captured.getTracks()) track.stop();
        throw new Error("microphone start was cancelled");
      }
      stream = captured;
      muted = !!startMuted;
      localSession = mediaSessionId();
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
      for (const track of stream.getAudioTracks()) track.addEventListener?.("ended", () => {
        if (stream !== captured) return;
        for (const peer of [...connections.keys()]) closePeer(peer);
        stream = null;
        localSession = "";
        report();
      }, { once: true });
      for (const peer of allowedPeers) sendReady(peer, false);
      report();
      return state();
    })();
    try {
      return await startInFlight;
    } finally {
      startInFlight = null;
    }
  };
  const setMuted = (value) => {
    muted = !!value;
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted;
    report();
    return state();
  };
  const stop = () => {
    generation += 1;
    for (const peer of allowedPeers) {
      if (localSession) send(peer, {
        __peerdMedia: MEDIA_MARKER,
        scope,
        kind: "hangup",
        session: localSession
      });
    }
    for (const peer of [...connections.keys()]) closePeer(peer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    localSession = "";
    playbackBlocked = false;
    remoteSessions.clear();
    signalQueues.clear();
    outboundQueues.clear();
    earlyIce.clear();
    peerFlow.clear();
    for (const timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();
    report();
    return state();
  };
  const forget = (peer) => {
    closePeer(peer);
    allowedPeers.delete(peer);
    remoteSessions.delete(peer);
    signalQueues.delete(peer);
    outboundQueues.delete(peer);
    earlyIce.delete(peer);
    peerFlow.delete(peer);
  };
  const resumePlayback = async () => {
    playbackBlocked = false;
    for (const record of connections.values()) {
      if (!record.audio.srcObject) continue;
      try {
        await record.audio.play?.();
      } catch {
        playbackBlocked = true;
      }
    }
    report();
    return state();
  };
  return Object.freeze({ start, stop, setMuted, setPeers, ingestSignal, resumePlayback, forget, status: state });
};
export {
  createDirect,
  createGossip,
  createPresence,
  createRoomVoice,
  generateIdentity,
  isRoomVoiceSignal,
  joinRoom
};
