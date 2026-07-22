# Animation & Texture Polish Plan

The rigs are six-part rigid bodies (JMS parts with joint pivots) driven by
procedural swing cycles. That got characters on screen; it does not read as
Halo. This is the staged plan from "silly" to "right", ordered by visible
payoff per unit of work. Items marked ✅ are implemented as of this commit.

## P0 — reads-as-broken fixes (highest payoff)

- ✅ **Weapon held in hands, not floating at the sternum.** The carry rifle
  is now offset to the grip point (forward + to the right hand) and pitched
  to a two-hand low-ready instead of hovering level at chest height. Next
  step (below, P1) is attaching it to the arm part's swing transform so it
  pumps with the run cycle.
- ✅ **Revives/reanimations telegraphed.** A downed combat form no longer
  snaps upright between two frames ("seems like a bug"). It rises through
  a 0.85 s reverse of the death fall with a shudder, and the game feed cues
  it ominously ("something stirs in …") instead of narrating the hive.
- **Latch/burrow read.** The infection form riding a frantic host needs a
  distinct pose (legs wrapped, body at the neck) instead of standing on the
  victim's back point. One special-case stamp in agents3d.

## P1 — animation correctness

- **Attach carried weapons to the arm chain.** Stamp the rifle with the
  right-arm part's composed matrix (pivot + swing) × a per-model grip
  offset, so the weapon moves with the arms in walk/attack cycles. Grip
  offsets live in characters-data per model.
- **Real JMA clip playback.** Parse Halo .JMA animation files (same tag
  dumps as the JMS meshes) into per-bone keyframe tracks, retarget onto the
  six-part rigs (nearest-bone mapping, same partOfBone table used for
  skinning), and sample per instance by CLIP + animTime. Replaces every
  procedural swing. Biggest single upgrade available; bounded scope: walk,
  run, melee, death, flood lurch.
- ✅ **Hit-direction deaths.** Superseded by a full physics ragdoll
  (`physics/ragdoll.js`, driven from `game/agents3d.js`): a dead body goes
  limp and is thrown OFF the killing blow (away from `lastHurtBy`, or the
  nearest hostile for an attacker-less human corpse), tumbles, its limbs flail
  about the JMS pivots, and it settles into a heap — continuous pose variety
  rather than 2–3 canned poses. Cosmetic/render-side (the sim stays
  byte-identical); gated by `npm run ragdoll`. A charging/leaping form that
  dies carries its momentum into the tumble.
- **Lunge arcs.** Infection-form leaps get a ballistic hop (y offset over
  the lunge segment) instead of a floor slide; combat-form charge gets a
  lowered, forward-leaning posture (small rx during CHARGING flag).

## P2 — texture & material polish

- **Texture pass.** Anisotropy up, correct sRGB audit on every map,
  sharpen the TIF conversions (some exported soft), and per-material
  roughness tuning — armor plates vs cloth vs flood flesh currently share
  one roughness.
- **Flood materials.** Emissive pustule accents on combat forms (mask from
  the alpha channels we already strip), subtle vertex wobble on the carrier
  sack (shader onBeforeCompile), wet specular on infection forms.
- **Corruption set dressing.** Rooms past darkAt grow biomass: instanced
  tendril/nodule meshes accumulating with floodHoldSec, plus creep decals
  spreading from vents. Sells "the growth has taken the room" beyond fog.
- **Blood/impact decals.** Cheap quad decals at hurtHuman/hurtFloodForm
  positions with a ring-buffer cap.

## P3 — flourish

- **Carrier rupture gibs** (cone burst of sack fragments + pod spawn pop).
- **Shell casings + tracer variance** on sustained fire.
- **Two-stage collapse** for human deaths (knees, then floor) using the
  same blend machinery as the revive rise.
- **Ambient motion**: idle sway, breathing scale on live humans, infection
  form leg-wiggle amplitude tied to actual speed.
