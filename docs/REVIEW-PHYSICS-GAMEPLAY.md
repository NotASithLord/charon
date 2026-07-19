# Skeptical review — physics & gameplay gaps

A deliberately harsh pass over the current build (post real-skins, spatial
combat, solid bodies, queued ladders, rig animation). What exists is a
deterministic outbreak sim with a playable first-person window into it.
What it is NOT yet is a game that *feels* like Halo. The gaps, ordered by
how much they cost the experience.

## Physics — honest inventory

**No player↔NPC collision.** You walk straight through marines and flood
alike. NPCs shoulder each other apart (sim separation) and step around
you, but your own camera clips through every body. The worst offender for
believability, and cheap to fix: apply the same body radii as a slide
constraint in `player._move`.

**NPC motion is kinematic scripting, not physics.** Straight lerps along
links, park-drift spirals, steering pulls. No acceleration or momentum, no
turn rates (agents snap 180° in one tick), no knockback from swipes or the
carrier rupture, no ragdolls (corpses are grey boxes; downed forms rotate
flat with zero transition). Turn-rate smoothing and a fall/ragdoll pose
blend are the cheapest wins here.

**Interiors are empty shells.** Rooms have real walls, doors, hatches,
signage — and no contents. No crates, consoles, racks, bunks; nothing that
blocks movement, blocks bullets, or provides cover. This flattens both the
physics (nothing to hide behind) and the tactics (the hive's doorway-hold
and gun-line logic plays out in featureless boxes). Prop geometry needs to
join both the wall raycast (bullets) and `isWalkable` (movement) to count.

**Ballistics are minimal.** Player fire is hitscan against sphere hitboxes
— no locational damage (headshots do nothing), no penetration or ricochet.
NPC fire is statistical: accuracy rolls resolve damage while the tracers
are purely decorative, so what you see (a miss streak) and what happens (a
hit roll) can disagree. No grenades — first-strike has a complete grenade
implementation (arc, bounce, fuse, radial damage) worth porting.

**Doors animate independently of passage.** The sim's movers cross a
doorway on travel-time; the sliding panel is render-side. A body can walk
through a half-open panel. Gate link crossing on the door's `open01` (or
snap the panel open when a mover commits) to close the seam.

**Vertical movement is special-cased.** Ladders are queued and animated
(good), but NPCs on lifts stand on pads and teleport between decks at the
handover; nobody can fall through an open hatch (including the player —
descent is explicit-climb only); jumping exists but there is nothing to
jump onto.

## Gameplay — honest inventory

**No audio. This is the single biggest gap.** The genre runs on sound:
gunfire direction, screams down the corridor, the infection-form chitter,
distress radio chatter, door hisses. The sim already generates every one
of these as events (`gunfireAt`, screams, radio log lines). A WebAudio
layer with positional one-shots would transform the game more than any
visual work. first-strike's synthesized `AudioSys` is a portable starting
point.

**No motion tracker.** Halo's identity item, and the sim has perfect data
for it (positions, factions, movement states within radius). A corner HUD
radar showing movers within ~25 m — with the classic "moving only" rule —
is straightforward and high-value.

**Enemies don't react to being shot.** No flinch, no stagger, no
aggro-switch to whoever is shooting them. The sim's opportunistic
aggression keys off room presence, not damage source, so you can shoot a
form in the back from a doorway and it keeps mauling its current victim
until its next re-target. A `lastHurtBy` nudge into target selection plus
a render-side flinch would fix both the feel and the logic.

**No hit feedback.** No hitmarker, no damage numbers or blood, no death
animations (things just lie down), no directional damage indicator when
YOU are hit — armor drains with no cue as to where from.

**The player has no objective.** Survive-only, and the ship's fate mostly
resolves without you. The command layer the sim already carries
(`commands.js`, squad orders, DESIGNATE_BURN) has no game UI — you cannot
even direct your own fireteam (hold / follow / move-to). Wiring three
fireteam orders to keys would be the fastest way to make the player
matter; real objectives (restore comms to raise `marineCallReliability`,
burn corpse caches, escort civilians to lifepods) are the full answer, and
each maps directly onto levers the sim already has.

**Atmosphere is static.** Uniform ambient light plus one point lamp. The
sim tracks unpowered rooms — nothing renders differently in them. No
flicker, no emergency lighting during the last stand, no alarm state. The
horror is currently carried entirely by the activity log.

**No checkpoints.** Death is a full restart. Fine as a roguelike framing,
but the run length (~10-15 min) is at the outer edge for that framing
without meta-progression or a score screen (kills, conversions witnessed,
time survived — the stats object already tracks all of it).

**Multiplayer is designed but not wired.** The sim is lockstep-clean
(seeded RNG, command queue, input-delay ticks) and the peerd dwapp build
gives a serverless transport (room bridge) — but no netcode joins them.
Peer inputs through the command queue is the intended path; the player's
free movement stream is the part that needs design (it currently bypasses
the queue).

## Priority order (if the next sessions did only this)

1. **Audio pass** — positional one-shots driven by existing sim events.
2. **Hit feedback bundle** — flinch + `lastHurtBy` retargeting, hitmarker,
   directional damage indicator, death pose blend.
3. **Player↔NPC collision** — body radii in `player._move`.
4. **Motion tracker** HUD element.
5. **Fireteam orders** on keys (sim command layer already exists).
6. **Grenades + props/cover** — port from first-strike; furnish key rooms.
7. **Powered/unpowered lighting states + alarm states.**
8. **Objectives layer**, then **peerd multiplayer** on the command queue.

## What is genuinely solid (credit where due)

Deterministic sim with emergent arcs that survives adversarial probing;
real-meter contiguous ship the 3D world extrudes directly; spatial combat
with LOS-triggered engagement; solid-body agents; queued ladders; real
Halo assets with six-part rig animation at instanced-crowd cost; a dwapp
build of the whole thing that runs serverless in peerd's sandbox. The
foundation is real — the gaps above are all *next layers*, not rework.
