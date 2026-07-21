// shared/geometry.js — the deck-stacking geometry that BOTH the render
// (game/world.js) and the deterministic sim (sim.js leap peak) read, so
// "how tall is this room" has exactly ONE source. Pure math: no THREE, no DOM,
// no Math.random — imports cleanly in Node for the headless sim + harness.

export const DECK_H = 4.2;   // normal deck-to-deck spacing (matches ship data)
export const CLEAR_H = 3.0;  // standard floor-to-ceiling clear height

// The HANGAR DECK (deck 5, the ventral bay) is a TALL hold. Rather than cut
// holes in the deck above it, we lift every deck ABOVE deck 5 by this much, so
// the deck-5 volume opens up to (DECK_H + HANGAR_LIFT) of clear air with no
// deck-4 floor sitting low over the hangar. Every OTHER deck gap stays DECK_H.
// why: a combat form leaping across the hangar needs real vertical space, and
// a ~4 m ceiling reads as no taller than a corridor in a 50 m-wide bay.
export const HANGAR_LIFT = 4.0;

// world Y of a deck's floor. Deck 5 (hangar) sits at 0; decks above are lifted
// so the hangar bay is tall. Deck number DECREASES going up (deck 1 = top).
export function elevOf(deck) {
  return (5 - deck) * DECK_H + (deck < 5 ? HANGAR_LIFT : 0);
}

// The big open volumes the Flood bounds across — hangars, cargo, vehicle bay,
// the flank weapon batteries + magazines, the grand stairwell, wide
// berthing/mess. Keyed off sim node type/roles so the sim and render agree.
const TALL_ROLES = ['hangar', 'large', 'battery', 'magazine', 'stairwell', 'vehicles'];
export function isTallRoom(node) {
  return node.type === 'open' || (node.roles ?? []).some((r) => TALL_ROLES.includes(r));
}

// Per-room clear height (floor to ceiling). A tall hold opens to the FULL gap
// under the deck above (so the deck-5 hangars become genuinely tall — ~8 m);
// everything else keeps the standard CLEAR_H, leaving any extra gap as hidden
// void overhead. The 0.3 m keeps the ceiling just under the next deck's floor.
export function clearHeightOf(node) {
  if (!isTallRoom(node)) return CLEAR_H;
  const gap = elevOf(node.deck - 1) - elevOf(node.deck);
  return Math.min(gap - 0.3, 8);
}
