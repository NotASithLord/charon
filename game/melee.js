// The butt-stroke's geometry, kept pure so it can be checked headlessly
// (game/melee-check.mjs). main.js owns the world lookups, the wall raycast
// and the damage; everything here is numbers.
//
// THE ARC IS HORIZONTAL, which is what makes it a swing and not a ray: a cone
// on the floor plane against where you are facing, plus a vertical band.
// Measured as a true 3D cone it misses the things you most want to club — an
// infection form at 1.2 m sits 46 deg BELOW eye level, outside any sane cone,
// and you would have to stare at your boots to connect with it.
//
// THE BAND IS ANCHORED TO YOUR FEET, NOT YOUR EYE. Anchored to the camera it
// rode up with you: player.h climbs through a jump while the form stays on the
// deck, so an eye-relative floor of -1.7 m rejected an infection form (centre
// 0.35 m up) the moment h passed 0.43 m — 83% of an ODST's 1.40 m jump,
// including the whole top of the arc, and 55% of it for a standing combat
// form. That silently deleted the jump tier of combatMeleeImpulse: every
// strike that landed was a grounded one. Feet-relative, the band is fixed to
// your body, so a leaping strike connects and so does one aimed at the deck
// below the stair tread or catwalk you are standing on.
const CONE_COS = Math.cos(40 * Math.PI / 180); // half-angle either side of your facing

// above the feet: a form standing on a 1.7 m crate (centre 2.6) is still in
// the arc — the same ceiling the old eye-relative +1.0 gave a grounded player
export const MELEE_RISE = 2.6;
// below the feet: the deck plate under you at the APEX of a jump (ODST.jumpVel
// 8.2 / gravity 24 = 1.40 m, so an infection form's centre sits 1.05 m below
// your boots up there), and the deck below a stair tread or catwalk you are
// standing on — world.js decks are 4.2 m, so a landing can put you a couple of
// metres over a body that is well inside arm's reach horizontally.
export const MELEE_DROP = 1.8;

// Distance from the stock to the target's SURFACE, or -1 if it is outside the
// arc. Reach is measured along the deck (the band owns the vertical), and the
// radius is the same body sphere the bullet path uses — comparing a carrier's
// CENTRE against the reach made you walk a metre closer to club the widest
// body in the game than to shoot it.
export function meleeArcDistance(px, pz, feetY, fx, fz, tx, ty, tz, radius, reach) {
  const dx = tx - px, dz = tz - pz;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return -1;            // inside your own boots: no facing to test against
  const surface = d - radius;
  if (surface > reach) return -1;
  const dy = ty - feetY;
  if (dy > MELEE_RISE || dy < -MELEE_DROP) return -1;
  if ((dx * fx + dz * fz) / d < CONE_COS) return -1;
  // CLAMP AT CONTACT. `surface` goes NEGATIVE once you are inside the body's
  // sphere, and the caller reads any negative as the out-of-arc sentinel — so
  // adding the radius term to fix the FAR edge silently killed the NEAR one.
  // The player really can stand inside all three: player capsule 0.34 + NPC
  // capsule 0.40 + controller skin 0.02 puts contact at 0.76 m, and a carrier
  // pressed against you sat 0.24 m inside the dead zone. You had to back away
  // from the thing you were touching to club it, while bullets still hit it.
  // Bodies in a door throat and downed bodies carry no collider at all and
  // overlap you outright.
  return surface < 0 ? 0 : surface;
}

// The attacker record combatMeleeImpulse reads: `charging` when you are moving
// faster than a walk, `leaping` while your boots are off the deck, `hoverY`
// how high they are (the sim counts anything over 0.05 as airborne, so a jump
// that has barely left the plate already throws a body the airborne way).
export function strikeAttacker(agent, mover, walkSpeed) {
  return {
    ...agent,
    charging: Math.hypot(mover.vx, mover.vz) > walkSpeed,
    leaping: !mover.onGround,
    hoverY: mover.onGround ? 0 : Math.max(0.1, mover.h),
  };
}
