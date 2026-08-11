# Charon

Charon is a browser-native systemic survival game aboard the UNSC *Saturn
Devouring*. The ship simulation continues with or without the player: marines
sweep, civilians panic, radios fail, and the Flood changes tactics as bodies
and safe routes disappear.

The main experience is a peerd-compatible hub with solo play, authenticated
WebRTC co-op, invite-only fireteams, Quick Match, live fireteam voice, an About
page, and developer documentation. The same hub runs as an ordinary website;
that build carries the required peerd identity, room, gossip, presence, direct
message, and WebRTC primitives itself.

## Run locally

```sh
npm install
npm run serve
# open http://localhost:8000/
```

Localhost is a secure browser context, so microphone capture works there.
Production web hosting must use HTTPS for WebCrypto, WebRTC, and microphone
access.

| Route | Surface |
|---|---|
| `/` or `/game/` | Charon hub, solo game, co-op lobby, About, and docs |
| `/sim/` | Top-down deterministic simulation harness |
| `/vat/` | WebGPU crowd-rendering harness |
| `/fused/` | Live simulation feeding the VAT renderer |

## Multiplayer

Charon has two adapters over one application protocol:

- In peerd, the dwapp calls the consent-gated parent bridge. Identity,
  authenticated room membership, gossip, presence, direct messages, and voice
  stay on peerd's always-on base WebRTC mesh. The opaque app frame receives no
  raw network or microphone primitive.
- On the web, `multiplayer/peerd-browser.js` is a generated browser bundle of
  those same peerd primitives. It establishes authenticated `did:key` WebRTC
  links through peerd's cold-start rendezvous and then communicates peer to
  peer.

Quick Match partitions live, ready peers in a public queue into fireteams of up to four. A
proposal/ack/commit barrier freezes membership, then the fireteam leaves the
queue for its own match room. Private rooms use high-entropy, unlisted invite
codes: the room address is a one-way derivation of the code and every lobby
message must carry a DID-bound HMAC proof. Payload identities must match their
authenticated envelopes.

Every fireteam keeps its full peer mesh. Peers advertise a coarse peerd capacity
score derived from outgoing bandwidth/RTT and local CPU/memory hints; the best
candidate advances the 15 Hz ship simulation. Inputs fan out directly to the
mesh, while the authority sends ordered delta checkpoints at 5 Hz and periodic
full checkpoints. If it disconnects, the next ranked, already-connected peer
continues from its retained checkpoint. Voice uses browser-native WebRTC RTP
with Opus, acoustic echo cancellation, noise suppression, automatic gain, and
the browser jitter buffer; only bounded SDP/ICE signaling uses direct messages.

See [docs/NETWORKING.md](docs/NETWORKING.md) for the protocol and threat model.

## peerd hub package

```sh
npm run vendor:peerd   # refresh the standalone web primitive bundle
npm run build:dwapp    # produce dist/dwapp/{hub,sim,fused}
```

`dist/dwapp/hub/` is a complete schema-1 dwapp:

```text
index.html       hub and game document
launcher.css     hub stylesheet
bundle.js        complete module graph and embedded binary assets
peerd.json       dwapp manifest with the dweb capability
```

Import the folder into peerd or publish it over the dweb. The hub is larger
than peerd's interactive authoring ceiling because it embeds the game's meshes,
textures, and audio, but remains within the import/publish package cap. It does
not perform relative fetches in the opaque-origin runner.

The checked-in `dwapp/hub/` folder is the ready-to-import release snapshot.
See [docs/PEERD-HUB.md](docs/PEERD-HUB.md) for the contract and bridge surface.

## Verify

```sh
npm run check
npm run build:dwapp
```

`npm run check` covers multiplayer protocol invariants, deterministic replay,
the fixed-step physics layer, ragdoll stability, and the simulation command
queue. Changes to the peerd bridge are checked in the sibling peerd repository:

```sh
cd ../peerd
bun test ./tests/peerd-distributed/bridge.test.ts
bun run typecheck
```

## Architecture

```text
game/          hub launcher, first-person game, 3D world, HUD, audio
multiplayer/   peerd/web sessions, lobby protocol, game sync, room voice
sim/           deterministic 15 Hz ship simulation and command queue
shared/        simulation/render boundary, seeded RNG, parameters
engine/        renderer, physics, effects, bundled browser dependencies
scripts/       peerd primitive vendoring and dwapp packaging
docs/          network and package integration reference
```

The simulation writes a packed `AgentBuffer`; renderers consume it without
owning ship state. Seeded randomness and tick-stamped commands keep replay
behavior inspectable and reproducible.

## Controls

- `WASD` move, mouse look, click fire
- `E` take ammunition or a rifle, `R` reload, `F` melee
- `L` use ladders or stair transitions
- `M` tactical map, `G` give a magazine to a fireteam member
- `1` follow, `2` hold, `3` advance

The launcher and developer docs are keyboard navigable. Voice can be muted in
the lobby or from the in-game network HUD.
