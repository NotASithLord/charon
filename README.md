# Halo Charon — POC

**Simulation core + VAT rendering validation.** Browser-native, zero dependencies, no build step.

> A dark, drifting warship, a hundred people who do not yet know they are losing, and an enemy
> that begins outnumbered and outgunned and is smarter than anything hunting it.

This is the two-harness POC from the design spec: prove the AI is fun to watch and the rendering
survives the hardware **before anyone models a corridor**. No 3D level geometry, no player
controller, no weapons feel — by design.

## Run it

```sh
npm run serve          # python http.server on :8000 (any static server works)
# open http://localhost:8000/
```

| Page | What it is | Needs |
|---|---|---|
| `/sim/` | Full ship sim, top-down schematic, live master dials, seed replay | any modern browser (Canvas 2D) |
| `/vat/` | VAT crowd renderer, 3 LOD tiers, §1 gate capture | WebGPU (Chrome/Edge 113+, Safari 18+) |
| `/fused/` | Build step 9: VAT renderer fed by the live sim agent buffer | WebGPU |

Headless (no browser, used for tuning and CI):

```sh
node sim/headless.js charon-1 20     # watch a 20-sim-minute run as text
node sim/determinism-check.js        # §2.1 gate: identical replays, divergent seeds
node sim/command-check.js            # companion §0: command queue works + stays deterministic
```

## Layout

```
shared/   agentBuffer.js   the ONE sim↔render boundary (§2.2), SoA typed arrays
          params.js        all tuning params (§10) + hive decision constants (§13.10)
          rng.js           mulberry32; no Math.random() anywhere in sim code
sim/      data/ship.js     the Charon compartment graph (§3.3)
          commands.js      tick-stamped command queue (companion spec §0)
          commandApply.js  the one place a commander order mutates shared state
          graph.js         3 traversal layers, flow fields, layered pathing (§3.2, §6.3)
          init.js          seeded run init: locks, vent blockage, power, NPCs, breach (§4)
          humans.js        civilian FSM, panic contagion, armed, marine squads + radio (§5)
          hive.js          the hive brain: beliefs, scarcity, utility scoring, intents (§6, §13)
          floodExec.js     form actuation: grabs, carriers, reanimation, ambush, bait
          combat.js        integrity/damage model, self-revive, flame, vent kills (§7)
          sim.js           15 Hz movement tick + 2.5 s strategic tick orchestrator (§2.3)
          viz.js, main.js, index.html   debug view (§8)
          headless.js, determinism-check.js
vat/      mesh.js          procedural biped (near) + lump (mid); billboard far tier
          anim.js          bakes 6 clips into rgba32float vertex-animation textures
          renderer.js      WebGPU: ≤4 draw calls total, LOD partition per frame (§9)
          driver.js        synthetic crowd writing a real AgentBuffer
fused/    step 9: sim buffer → VAT renderer
```

## What was validated here

- **Determinism (§2.1):** `determinism-check.js` runs each seed twice and compares state
  fingerprints at 4 checkpoints — identical; different seeds diverge.
- **Emergent arc (§1):** with the default dials, across 9 seeds the outcomes ranged from
  fast containment (marines catch the outbreak before the first carrier pays off) through a
  ~40-minute war of attrition to two total ship losses (~6–8 min). One representative losing
  run: pool crashes to 1 form by 2:00 while carriers incubate → 6 carriers by 5:00 →
  scarcity crosses 1.0 → grabs and conversions accelerate → rampage → ship lost at 8:11.
  No phase flags exist in the code; that curve is the scarcity term (§13.2) doing its job.
- **Observable behaviors:** the opening smash-and-grab races the sweep-ETA belief (§6.7),
  distress calls visibly pull the two nearest squads, dropped calls are logged
  (`squad 3 missed a distress call`), stale-map friction shows up as
  `hive discovers a locked hatch — re-planning`, and vent transits flash as shot windows.
- **Rendering:** all three LOD tiers verified drawing via WebGPU readback (SwiftShader in CI;
  the real gate numbers must come from the reference M2 Air — see below).

## Companion spec — what's built vs. deferred

A companion spec (command layer, transponders, P2P multiplayer, Flood body-gathering)
layers on top of this. Almost all of it is explicitly post-POC. Two things were in scope now:

- **§0 — the command path as a tick-stamped queue (built).** Every commander-authored mutation
  of shared sim state — squad orders (`MOVE_TO`/`GUARD`/`HOLD_CHOKE`/`PATROL`/`RESPOND`/
  `SET_CALL_POLICY`/`ESCORT`/`FALL_BACK`/`RELEASE`), a door thrown, a burn designation — enters
  the sim as a command object stamped with a target tick (`sim.issue(cmd)`), and the sim drains
  the queue on the matching tick in deterministic `(tick, peerId, seq)` order, before any AI runs.
  In single-player the producer is one local commander stamping `net.inputDelayTicks` (=1) ahead,
  so it's invisible — but this is exactly the shape deterministic lockstep needs (§3.10: "the
  tactical command layer IS the lockstep input stream"). Orders are gated by per-deck comms
  reliability (§2.4) and can be dropped by damage; the sim log shows an order fail to take. The
  `/sim/` page has a live command console; `command-check.js` proves orders are obeyed and that a
  command-driven run still replays bit-identically — the property multiplayer depends on. This is
  the one piece that would have forced a rewrite later if the POC had mutated state through direct
  calls instead of the queue.
- **§5.4 — hooks left in, nothing built.** Corpses already carry stable ids + node locations;
  carriers are queryable agents (the "hub"); `graph.trailNode` / `graph.trailEdge` are allocated
  but unwritten, so post-POC blood trails drop in without touching the graph structure.

Deferred entirely (not built): the command-view opportunity cost (§2.5), the Flood commanding
against the player's decisions (§2.6), WebRTC lockstep transport + desync recovery (§3),
the transponder fog-of-war UI (§4), and body-gathering itself (§5). The fixed-point determinism
tax (§3.5) is noted but not paid — the POC sim uses floats, which is fine single-machine; it
becomes mandatory when lockstep transport lands.

## The §1 gate (run this on a real M2 Air)

Open `/vat/`, click **run capture**. It measures avg/p95/worst frame ms, JS heap, and draw
calls at 50/100/150/200 instances (2 s warmup + 5 s sample each) and prints a pass/fail against
p95 < 16.7 ms and < 2 GB at 150 instances. Copy the JSON into the tracking issue. JS heap is
not the full working set — cross-check the browser task manager (GPU process included).

## Tuning notes (state of the dials)

The three master dials are live sliders in `/sim/` (§10):

- `belief.decayRatePerSec` (λ) — how fast the hive loses its fix. Default 0.1.
- `belief.predictionQuality` (q) — how well it guesses flight routes. Default 0.7.
- `radio.marineCallReliability` — marine coordination. **Default lowered to 0.75** (the spec's
  0.95 assumes intact comms; at 0.95 the response snuffs nearly every outbreak — exactly the
  "too crisp" failure mode §10 says to fix with this dial, not with squad nerfs).

Known open tuning item: containment is still the most common outcome (~6/9 seeds). The spec's
target is early extinction *only against near-perfect play* (§12.3). The two highest-leverage
knobs are `radio.marineCallReliability` (down) and marine `stompPerSec` (down), plus squad
sweep dwell time (up). All exposed in `shared/params.js`.

Deviations from the spec's starter numbers, all in the "adjust freely" space it grants:

- Three aft vents added to `ship.js` (cargo1↔cargo2, eng↔lifesup, hangar↔maintF) — the spec's
  vent list left the entire crash-candidate quadrant with no infection-form network, which made
  every opening a death march across the corridor spine.
- Marine complement ~15 (of 140 souls) — the ship is running light, per the scenario.
- Squads berth in crew spaces (never in crash-candidate holds) so the outbreak isn't spawn-camped.
- Carrier production has backpressure (stops minting above ~130 live forms) to respect the
  512-capacity agent buffer.
- **Economy chain** (refined from §13's carrier-costs-a-body model): an infection form + a body
  makes a **combat form** (the form is spent), and a **combat form roots into a carrier** — so
  carriers are converted combat forms and the hive picks the combat:carrier ratio by need
  (defense/hunting vs production). A carrier mints its first infection form within seconds of
  forming, independent of whether it's relocating. Nothing spawns without consuming its inputs.
- Vent exposure is strictly line-of-grating: an infection form moving through a vent can only be
  seen/shot by someone standing in one of the two rooms the vent actually connects.
- A deck-5→deck-3 maintenance shaft (Lower Corridor ↔ Main Corridor Aft) bypasses the hangar deck,
  so the two hangar ladders aren't an inescapable chokepoint.
- All command-deck officers (bridge + Officer Country) are armed and fight in place.
- Marines sweep methodically outward from the breach (nearest un-cleared room, biased toward the
  crash), instead of wandering to already-safe upper decks; the command garrison holds the bridge.
- If reduced to a few combat forms with no carriers/pool, the hive rebuilds (roots its safest form
  into a carrier) rather than hiding to be picked off.
- Debug view renders agent motion smoothed per agent-id, not per buffer slot — the sim repacks the
  buffer on every death/spawn, and the old slot-based interpolation made agents "fly into position"
  whenever the roster changed.

## Open decisions (§12) — current POC behavior

1. **Dead combat form as carrier food:** implemented as specced — `damage ≥ 100` removes it
   from the economy; below that it stays convertible and the hive will reanimate it.
2. **Flamethrower fuel:** 100 units; the flamer marine burns corpse caches once the outbreak
   is known. Burned bodies are permanently out of the economy.
3. **Marine response speed:** see tuning notes above — this is the live balance question.
4. **NPC count:** 140 default; the VAT harness stresses 50–300.
