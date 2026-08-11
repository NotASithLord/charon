# peerd hub integration

The Charon hub package is emitted at `dist/dwapp/hub/` and mirrored to
`dwapp/hub/` for direct import.

## Manifest

`peerd.json` declares a schema-1 `dwapp`, `index.html` as the entry, a bound app
agent, and the `dweb` capability. That capability allows the runner to attach
the narrow parent bridge; it does not expose extension APIs to the app.

## Runner constraints

peerd composes app files into an opaque-origin sandbox. Raw networking,
top-level navigation, and extension access are unavailable. Charon's build
therefore:

- flattens every JavaScript module into one ESM bundle;
- embeds texture and audio bytes as data URIs;
- reroutes asset loader and audio `fetch` calls to those data URIs;
- leaves no relative dynamic import in the final bundle;
- ships the hub stylesheet as an app file for peerd to inline;
- delegates all distributed operations and microphone access to the trusted
  parent bridge.

## Bridge operations

Charon uses:

```text
hello
join / leave
presence / announce
subscribe / publish
capacity
dm-send
voice-start / voice-peers / voice-mute / voice-status / voice-unlock / voice-stop
```

`capacity` returns a coarse, bounded, integer authority-election score computed
in the trusted host from RTCStats and local resource hints; it exposes no
candidate addresses or raw statistics. Room grants are scoped to the app's content identity and exact room id. Voice
has a separate consent prompt. `voice-peers` narrows audio to selected match
members, which is required because multiple Quick Match fireteams can share one
physical public room. Media uses native RTP/Opus; authenticated direct messages
carry bounded SDP/ICE signaling only. `voice-unlock` retries speaker playback
after a browser autoplay gate.

## Standalone browser adapter

`npm run vendor:peerd` bundles only peerd's browser-facing identity, room,
gossip, presence, direct-message, and WebRTC dependencies into
`multiplayer/peerd-browser.js`. The source is the sibling peerd checkout by
default; set `PEERD_SOURCE` to another compatible checkout when testing a peerd
change.

The dwapp build contains the adapter as an unreachable fallback, but peerd's
runner denies raw WebRTC. A successful bridge handshake always selects the
trusted `BridgeSession` path.

## Build checks

`npm run build:dwapp` prints package size against peerd's live loader caps. A
valid hub has four files and no unresolved `import()` expression in its bundle.
The corresponding bridge tests and typecheck live in the peerd repository.
