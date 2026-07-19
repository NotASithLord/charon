# Roadmap — from this POC to a droppable-in 3D game

The goal: a player drops into a real-time 3D UNSC frigate as the outbreak
unfolds, and everything rendered — marines sweeping, civilians bolting,
combat forms sprinting and leaping, carriers swelling and rupturing —
**is** the simulation, not a scripted layer over it.

## What already exists (and carries over unchanged)

- **Deterministic authoritative sim** — seeded, fixed 15 Hz tick, replay-
  identical; the whole outbreak (hive economy, marine doctrine, civilian
  panic) runs headless at negligible cost.
- **Meter-true ship plan** — every compartment has authored dimensions and
  positions in meters; doors are real points on shared walls; travel time
  is distance/speed. This plan IS the 3D floor plan source.
- **The sim/render boundary** — one SoA AgentBuffer (positions, headings,
  anim clips, flags). Any renderer that reads it is correct by
  construction. Behavior flags already carry render intent:
  `CHARGING` (lunge/sprint), `ARMED_HOST` (render the host's weapon),
  `EXPOSED`, `AMBUSH`, `DOWNED`, `BURNED`, `PANICKED`, carrier `held`.
- **Command queue (§0)** — every commander mutation is tick-stamped and
  deterministic; lockstep multiplayer slots under it without sim changes.
- **VAT crowd renderer** — WebGPU vertex-animation-texture pipeline with 3
  LOD tiers and ≤4 draw calls for hundreds of agents.

## What's left, in dependency order

### 1. Geometry: extrude the plan into a walkable interior
- Generate room volumes from the meter plan (floor rects × 2.6 m clear
  height per deck), door frames at the computed door points, ladder/lift
  trunks, maintenance shafts and vent runs as crawlable tubes.
- Author-pass the result toward the Charon-class silhouette (hull taper,
  hangar doors, MAC spine) so interiors sit believably inside the
  489.7 m exterior model.
- Bake a navmesh from the same plan. **The graph stays authoritative**
  (which room, which door); the navmesh only handles continuous motion
  inside a room. One source of truth, two resolutions.

### 2. Local motion: continuous positions inside rooms
- Today agents park at per-id offsets and lerp door-to-door. Add a light
  local-steering layer (RVO or flow-field-per-room) so crowds bunch at
  doors, spread through rooms, and take cover — all render-side,
  sim-deterministic (the sim still owns which room / which door / when).
- Micro-positions for combat: shooters pick firing positions at door
  sightlines; grabs/conversions animate at the victim's actual spot.

### 3. Player embodiment
- FPS controller (capsule vs. the extruded geometry), interact verbs:
  open/seal doors (enqueues SET_DOOR into the command queue), weld vents,
  pick up weapons, flamethrower.
- The player is one agent in the buffer with an external input source; the
  sim already applies commands tick-stamped, so the player's effects are
  deterministic and replayable.
- Sensing hands the player real information only: the tracker (moving
  contacts ≤ 1 hop), radio traffic (the distress-call feed), and line of
  sight — the fog the hive fights under applies to the player's map too.

### 4. Rendered behavior = sim behavior (the Halo-fidelity contract)
- Replace the procedural VAT biped with authored skeletal sets per form:
  marine (patrol walk, aim, fire, execute-downed), civilian (work, panic
  bolt, cower), infection form (skitter, latch, burrow-in), combat form
  (lope, **sprint-charge + leap** on `CHARGING`, whip melee, wild-fire
  with hosted weapon on `ARMED_HOST`, revive from downed), carrier
  (waddle, swell stages driven by `held`, rupture).
- Map buffer states/clips 1:1 onto animation graph inputs — no renderer-
  side AI. If it looks like a lunge, it's because the sim charged.
- FX events already exist as log/state transitions: rupture (spawn burst),
  conversion (burrow), flamethrower burn, vent kills.

### 5. Combat model refinement
- Split node-pooled DPS into per-shooter target assignment with tracer/
  projectile visuals (the viz already pairs shooters to targets
  deterministically — promote that pairing into the sim).
- Hitscan for the player's weapons, routed back into the same
  hurtFloodForm/hurtHuman calls so player damage and NPC damage are one
  system.

### 6. Audio + horror pacing
- The compartment graph is an occlusion graph: gunfire carries 3 hops,
  screams 2 — drive audio attenuation/muffling from the same numbers.
- Distress radio as diegetic audio (the calls already exist with caller
  identity); tracker pings; hull groans keyed to the hive's quiet phases.

### 7. Multiplayer
- Transport under the command queue (rollback not needed — lockstep with
  inputDelayTicks is already modeled); state-hash fingerprints per N ticks
  for desync detection (already implemented in the determinism harness).

### 8. Tooling & content
- Seed browser / replay scrubber (the sim replays exactly from seed).
- Balance dashboard: batch headless runs per parameter set (the outcome
  spread across seeds is the difficulty curve).
- Scenario presets over the new explicit-count inputs (squads, patrols,
  civilians, bodies, starting flood).

## Engine question

The sim is dependency-free JS and stays that way. The 3D layer can be:
- **Three.js/WebGPU in-browser** — keeps the zero-install property, reuses
  the VAT pipeline as the far-LOD crowd path; skeletal near-LOD added.
- **Unity/Unreal/Godot** — port the AgentBuffer as a native struct array;
  the sim can stay JS (embedded) or be ported 1:1 (it is deliberately
  allocation-light and integer/float deterministic).

Recommended: stay browser-native through the vertical slice (one deck
walkable, player + full sim + skeletal near-LOD), then decide.
