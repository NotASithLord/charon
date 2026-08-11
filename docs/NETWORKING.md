# Multiplayer protocol

Charon protocol version 2 presents the same room API inside peerd and on the
standalone web page. peerd keeps identity, WebRTC, RTC statistics, and
microphone handles in the trusted parent; the website bundles the corresponding
peerd primitives.

## Lobby and deployment

1. Join the live `charon:quickplay:v2` public queue or a private room whose
   address is SHA-256-derived from an invite code. Mesh presence removes stale
   peers; a stable queue avoids stranding players on opposite time epochs.
   Private lobby messages require a DID-bound HMAC proof, so an overlay peer
   that learns the derived room address cannot impersonate an invite holder.
2. Publish `ready` with a bounded host-capacity sample. The sample combines
   available outgoing bitrate/RTT when RTCStats exposes it with coarse
   CPU/memory and Network Information fallbacks.
3. Rank candidates by capacity score, then DID as the deterministic tie-break.
4. The selected candidate proposes an exact roster, isolated random match room,
   seed, and complete failover order.
5. Every member must acknowledge the same proposal. The host retransmits until
   all acknowledge, then publishes commit twice.
6. Each member leaves matchmaking, joins the match room with the same identity,
   removes lobby listeners, and pins voice recipients to the committed roster.

The match room remains a full WebRTC mesh. Electing an authority does not tear
down peer-to-peer connections and does not turn Charon into a star network.

## Authority and failover

Only the elected authority advances the 15 Hz ship simulation. This avoids four
independent AI worlds consuming four times the CPU and eventually disagreeing.
Every player owns a distinct deterministic ODST agent and escort squad.

All peers fan out their 10 Hz pose/input stream and bounded actions to the
committed mesh. The authority validates and applies combat actions. It sends 5
Hz delta checkpoints and a full checkpoint every two seconds. Checkpoints carry
entity presentation/lifecycle state; full checkpoints also refresh RNG time,
doors, outcome, armory, and statistics. Direct sends are serialized per peer so
packet sequence cannot overtake signing.

Every guest retains the latest checkpoint. When the current authority has been
observed and then disappears from match presence, all remaining peers choose
the first connected DID in the committed failover order. The promoted peer
starts ticking its retained state and immediately emits a full checkpoint.

## Game packets

Every direct packet has `{ v, kind, from, name, seq, ...payload }`. Charon
rejects mismatched authenticated/claimed senders, non-members, replayed
sequences, malformed arrays, out-of-world values, and excess action rates.
Continuous values use deterministic 1/1000 fixed-point integers because peerd's
cross-engine signed canonical form intentionally rejects floating-point JSON.

- `state`: player world position, deck, yaw, and health intent.
- `shot`: bounded world-space trace; the host retains it briefly to validate a
  following hit against the target volume.
- `hit`: target id and bounded damage, accepted only by the authority after a
  recent geometrically compatible shot.
- `explosion`: bounded deck/position/radius/damage, accepted only near the
  sender and at a capped rate.
- `snapshot`: host-only delta or full checkpoint.

Gossip is limited to low-rate lobby consensus. Gameplay and media signaling use
direct authenticated WebRTC messages and therefore do not consume peerd's
gossip token bucket or flood unrelated base-mesh peers. Voice itself is RTP
media and does not travel through application data channels.

## Voice

Voice begins only after an explicit user gesture. In peerd, the trusted parent
also asks for app voice consent. A sandboxed dwapp never receives a MediaStream,
AudioContext, device label, raw RTCStats, or networking handle.

Both adapters use dedicated audio-only `RTCPeerConnection` media sessions. The
browser negotiates Opus, caps speech bitrate, and owns RTP packetization,
jitter buffering, acoustic echo cancellation, noise suppression, and automatic
gain control. A deterministic offerer prevents glare. Authenticated direct
messages carry only bounded, versioned ready/SDP/ICE/hangup signaling with
session correlation, rate limits, and allocation caps. Capture cancellation
stops a stream even when permission resolves after the user leaves. Reserved
media signaling never crosses the trusted bridge into the dwapp.

## Failure and trust boundaries

- Bridge fallback occurs only when the bridge is unavailable, never after a
  user denies peerd consent or a joined bridge fails.
- Leaving closes subscriptions, presence, audio tracks/context, direct
  messaging, gossip, and the room.
- Losing a lobby peer cancels in-flight consensus. Losing the match authority
  promotes the next connected committed candidate.
- Rendezvous is discovery/signaling only; established peer links survive its
  outage.
- Public matchmaking includes strangers. Authentication proves packet origin,
  not benevolence, so all input remains bounded and authority-validated.
- Charon sends no microphone audio or simulation state to a gameplay server.
