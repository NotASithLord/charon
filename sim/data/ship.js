// Charon compartment graph — grown from the §3.3 starter data (which the spec
// marks "adjust freely"). The ship now reads much bigger: the hangar is two
// full bays plus a control room, and every deck carries storage rooms and
// misc spaces — exactly the kind of small, forgettable compartments the
// Flood dens in.

// REAL MAP FOUNDATION (user note): every compartment now carries authored
// dimensions in METERS — `w` fore-aft × `d` athwartships — and the layout/
// travel model works in meters, so navigation time is distance / speed.
// This plan is the source the navigable 3D map will be extruded from.
export const SHIP = {
  playableLengthM: 220, // pressurized crew section, bow datum at x=0
  sizeScale: 1.6,       // global hull scale (user tuning: a bigger ship)
  deckHeightM: 4.2,
  nodes: [
    // ---- deck 1 · command ----
    // Lore (Charon-class exterior): the bridge sits atop the dorsal midship
    // superstructure beside the MAC shaft — not in the bow. The whole command
    // deck rides above the habitation deck's fore section.
    { id: 'bridge', name: 'Bridge', deck: 1, foreAft: 0.30, type: 'room', capacity: 6, w: 12, d: 8, row: 2, roles: ['command'] },
    { id: 'cic', name: 'CIC', deck: 1, foreAft: 0.37, type: 'room', capacity: 8, w: 14, d: 10, row: 1, roles: ['command', 'comms'] },
    { id: 'officer', name: 'Officer Country', deck: 1, foreAft: 0.44, type: 'room', capacity: 8, w: 14, d: 8, row: -1, roles: ['quarters', 'soft'] },
    { id: 'signal', name: 'Signal Room', deck: 1, foreAft: 0.50, type: 'room', capacity: 5, w: 10, d: 7, row: 1, roles: ['systems', 'comms'] },
    { id: 'd1corr', name: 'Command Corridor', deck: 1, foreAft: 0.38, type: 'corridor', capacity: 6, w: 34, d: 3, row: 0, roles: ['artery'] },
    // ---- deck 2 · habitation ----
    { id: 'crewA', name: 'Crew Quarters A', deck: 2, foreAft: 0.30, type: 'room', capacity: 14, w: 16, d: 10, row: 1, roles: ['quarters', 'soft'] },
    { id: 'crewB', name: 'Crew Quarters B', deck: 2, foreAft: 0.42, type: 'room', capacity: 14, w: 16, d: 10, row: 2, roles: ['quarters', 'soft'] },
    { id: 'mess', name: 'Mess Hall', deck: 2, foreAft: 0.36, type: 'open', capacity: 28, w: 18, d: 12, row: 1, roles: ['soft'] },
    { id: 'galley', name: 'Galley', deck: 2, foreAft: 0.44, type: 'room', capacity: 8, w: 10, d: 8, row: 2, roles: ['soft'] },
    { id: 'd2store', name: 'Deck 2 Stores', deck: 2, foreAft: 0.49, type: 'room', capacity: 5, w: 8, d: 6, row: -1, roles: ['cargo'] },
    { id: 'medbay', name: 'Medbay', deck: 2, foreAft: 0.52, type: 'room', capacity: 12, w: 14, d: 10, row: -1, roles: ['medbay', 'helpless', 'corpse_cache', 'soft'] },
    { id: 'brig', name: 'Brig', deck: 2, foreAft: 0.58, type: 'room', capacity: 4, w: 8, d: 6, row: -1, roles: ['brig', 'helpless'] },
    { id: 'cryo', name: 'Cryo Bay', deck: 2, foreAft: 0.62, type: 'room', capacity: 10, w: 14, d: 10, row: -1, roles: ['cryo', 'corpse_cache'] },
    { id: 'chapel', name: 'Chapel', deck: 2, foreAft: 0.68, type: 'room', capacity: 6, w: 8, d: 7, row: -1, roles: ['soft'] },
    { id: 'd2corrF', name: 'Hab Corridor Fore', deck: 2, foreAft: 0.33, type: 'corridor', capacity: 8, w: 44, d: 3, row: 0, roles: ['artery'] },
    { id: 'd2corrA', name: 'Hab Corridor Aft', deck: 2, foreAft: 0.55, type: 'corridor', capacity: 8, w: 54, d: 3, row: 0, roles: ['artery'] },
    // ---- deck 3 · operations ----
    { id: 'corrF', name: 'Main Corridor Fore', deck: 3, foreAft: 0.25, type: 'corridor', capacity: 10, w: 48, d: 3.5, row: 0, roles: ['artery'] },
    { id: 'corrM', name: 'Main Corridor Mid', deck: 3, foreAft: 0.50, type: 'corridor', capacity: 10, w: 48, d: 3.5, row: 0, roles: ['artery'] },
    { id: 'corrA', name: 'Main Corridor Aft', deck: 3, foreAft: 0.75, type: 'corridor', capacity: 10, w: 48, d: 3.5, row: 0, roles: ['artery'] },
    { id: 'gym', name: 'Gymnasium', deck: 3, foreAft: 0.30, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['soft'] },
    { id: 'armory', name: 'Armory', deck: 3, foreAft: 0.40, type: 'room', capacity: 8, w: 10, d: 8, row: -1, roles: ['armory', 'armed'] },
    { id: 'security', name: 'Security', deck: 3, foreAft: 0.45, type: 'room', capacity: 10, w: 12, d: 9, row: 1, roles: ['marines'] },
    { id: 'stores3', name: 'Deck 3 Stores', deck: 3, foreAft: 0.55, type: 'room', capacity: 5, w: 8, d: 6, row: 1, roles: ['cargo'] },
    { id: 'barracks', name: 'Barracks', deck: 3, foreAft: 0.60, type: 'room', capacity: 16, w: 18, d: 12, row: -1, roles: ['marines', 'odst'] },
    { id: 'workshop', name: 'Workshop', deck: 3, foreAft: 0.66, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['maintenance'] },
    { id: 'podPort', name: 'Lifepod Bay Port', deck: 3, foreAft: 0.71, type: 'room', capacity: 10, w: 14, d: 8, row: -1, roles: ['lifepods', 'objective'] },
    { id: 'podStbd', name: 'Lifepod Bay Stbd', deck: 3, foreAft: 0.79, type: 'room', capacity: 10, w: 14, d: 8, row: -1, roles: ['lifepods', 'objective'] },
    // ---- deck 4 · flight & cargo ----
    { id: 'maintF', name: 'Maintenance Fore', deck: 4, foreAft: 0.32, type: 'corridor', capacity: 6, w: 26, d: 2.5, row: 1, roles: ['maintenance'] },
    { id: 'pumpRoom', name: 'Pump Room', deck: 4, foreAft: 0.38, type: 'room', capacity: 5, w: 8, d: 7, row: 2, roles: ['maintenance', 'systems'] },
    // GRAND STAIRWELL (user: its own huge two-storey room): a deck-4 hall whose
    // floor meets the hangar and whose mezzanine meets the mid corridor above.
    // Walk the ramp between levels — no ladder. Sits under corrM, fore of the
    // hangar. `stairwell` role marks it two decks tall with a walkable ramp.
    { id: 'grandStair', name: 'Grand Stairwell', deck: 4, foreAft: 0.47, type: 'open', capacity: 20, w: 24, d: 18, row: 0, roles: ['stairwell', 'large'] },
    { id: 'hangar', name: 'Hangar Fore', deck: 4, foreAft: 0.58, type: 'open', capacity: 30, w: 34, d: 20, row: 0, roles: ['hangar', 'large', 'crash_candidate'] },
    { id: 'hangarCtl', name: 'Hangar Control', deck: 4, foreAft: 0.56, type: 'room', capacity: 5, w: 8, d: 6, row: -1, roles: ['systems'] },
    { id: 'hangarA', name: 'Hangar Aft', deck: 4, foreAft: 0.63, type: 'open', capacity: 30, w: 34, d: 20, row: 0, roles: ['hangar', 'large', 'crash_candidate'] },
    { id: 'vehicle', name: 'Vehicle Bay', deck: 4, foreAft: 0.72, type: 'open', capacity: 24, w: 28, d: 16, row: 0, roles: ['vehicles', 'crash_candidate'] },
    { id: 'd4store', name: 'Flight Stores', deck: 4, foreAft: 0.77, type: 'room', capacity: 5, w: 8, d: 6, row: -1, roles: ['cargo'] },
    { id: 'cargo1', name: 'Cargo Hold 1', deck: 4, foreAft: 0.83, type: 'room', capacity: 18, w: 22, d: 14, row: 0, roles: ['cargo', 'crash_candidate'] },
    { id: 'cargo2', name: 'Cargo Hold 2', deck: 4, foreAft: 0.91, type: 'room', capacity: 18, w: 22, d: 14, row: 0, roles: ['cargo', 'crash_candidate'] },
    // ---- deck 5 · engineering ----
    { id: 'lowerCorr', name: 'Lower Corridor', deck: 5, foreAft: 0.60, type: 'corridor', capacity: 10, w: 56, d: 3, row: 0, roles: ['artery'] },
    { id: 'pumps', name: 'Coolant Plant', deck: 5, foreAft: 0.50, type: 'room', capacity: 5, w: 10, d: 8, row: 1, roles: ['systems', 'maintenance'] },
    { id: 'lifesup', name: 'Life Support', deck: 5, foreAft: 0.66, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['systems'] },
    { id: 'd5store', name: 'Engineering Stores', deck: 5, foreAft: 0.72, type: 'room', capacity: 5, w: 8, d: 6, row: 1, roles: ['cargo'] },
    { id: 'eng', name: 'Engineering', deck: 5, foreAft: 0.79, type: 'room', capacity: 12, w: 18, d: 12, row: -1, roles: ['engineering', 'power'] },
    { id: 'reactor', name: 'Reactor', deck: 5, foreAft: 0.88, type: 'room', capacity: 8, w: 14, d: 12, row: -2, roles: ['power', 'hazard'] },
    { id: 'maintA', name: 'Maintenance Aft', deck: 5, foreAft: 0.94, type: 'corridor', capacity: 6, w: 20, d: 2.5, row: 0, roles: ['maintenance', 'crash_candidate'] },
  ],
  edges: [
    // deck 1
    { a: 'bridge', b: 'cic', type: 'hatch', lockable: false },
    { a: 'cic', b: 'd1corr', type: 'hatch', lockable: true },
    { a: 'd1corr', b: 'officer', type: 'hatch', lockable: true },
    { a: 'd1corr', b: 'signal', type: 'hatch', lockable: true },
    { a: 'd1corr', b: 'd2corrF', type: 'lift', lockable: false },
    // deck 2
    { a: 'd2corrF', b: 'crewA', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'mess', type: 'hatch', lockable: true },
    { a: 'mess', b: 'crewB', type: 'hatch', lockable: true },
    { a: 'mess', b: 'galley', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'd2corrA', type: 'hatch', lockable: true },
    // mid lift: hab-aft corridor straight down to the ops mid corridor
    // (spine-to-spine, so it drops vertically — was mess->corrM, which put
    // the shaft on a diagonal since the Mess is offset off the spine)
    { a: 'd2corrA', b: 'corrM', type: 'lift', lockable: false },
    { a: 'd2corrA', b: 'd2store', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'medbay', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'brig', type: 'blastdoor', lockable: true },
    { a: 'd2corrA', b: 'cryo', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'chapel', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'corrF', type: 'ladder', lockable: false },
    // deck 3
    { a: 'corrF', b: 'gym', type: 'hatch', lockable: true },
    { a: 'corrF', b: 'armory', type: 'blastdoor', lockable: true },
    { a: 'corrF', b: 'security', type: 'hatch', lockable: true },
    { a: 'corrF', b: 'corrM', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'stores3', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'barracks', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'corrA', type: 'hatch', lockable: true },
    { a: 'corrA', b: 'workshop', type: 'hatch', lockable: true },
    { a: 'corrA', b: 'podPort', type: 'blastdoor', lockable: true },
    { a: 'corrA', b: 'podStbd', type: 'blastdoor', lockable: true },
    // deck 4
    // GRAND STAIRWELL (user: Pillar-of-Autumn style, its own huge room) — you
    // walk the ramp between the mid corridor (mezzanine) and the hall floor,
    // which opens onto the hangar. The two levels see and shoot across.
    { a: 'corrM', b: 'grandStair', type: 'stairwell', lockable: false },
    { a: 'grandStair', b: 'hangar', type: 'hatch', lockable: false },
    { a: 'hangar', b: 'hangarA', type: 'hatch', lockable: false },
    { a: 'hangar', b: 'hangarCtl', type: 'hatch', lockable: true },
    { a: 'hangarA', b: 'hangarCtl', type: 'hatch', lockable: true },
    { a: 'hangarA', b: 'vehicle', type: 'hatch', lockable: true },
    { a: 'hangar', b: 'maintF', type: 'hatch', lockable: true },
    { a: 'maintF', b: 'pumpRoom', type: 'hatch', lockable: true },
    { a: 'vehicle', b: 'd4store', type: 'hatch', lockable: true },
    { a: 'vehicle', b: 'cargo1', type: 'hatch', lockable: true },
    { a: 'cargo1', b: 'cargo2', type: 'hatch', lockable: true },
    { a: 'hangarA', b: 'lowerCorr', type: 'ladder', lockable: false },
    // deck 5
    { a: 'lowerCorr', b: 'pumps', type: 'hatch', lockable: true },
    { a: 'lowerCorr', b: 'lifesup', type: 'hatch', lockable: true },
    { a: 'lowerCorr', b: 'd5store', type: 'hatch', lockable: true },
    { a: 'lowerCorr', b: 'eng', type: 'hatch', lockable: true },
    { a: 'eng', b: 'reactor', type: 'blastdoor', lockable: true },
    { a: 'eng', b: 'maintA', type: 'hatch', lockable: true },
  ],
  // NOTE: the fore maintF<->corrF and aft cargo1<->eng cross-deck runs used
  // to be human ladders, but those rooms sit far apart athwartships so their
  // shaft could only ever be a diagonal (the "fly through space" the climb
  // read as). They're maintenance shafts now — enclosed, flood-only crawls —
  // and the crew reaches those decks by the vertical ladders/lifts instead.
  maintShafts: [
    { a: 'hangar', b: 'maintF', ambushCorners: 2 },
    { a: 'maintF', b: 'lowerCorr', ambushCorners: 2 },
    { a: 'maintF', b: 'corrF', ambushCorners: 2 },
    { a: 'eng', b: 'cargo1', ambushCorners: 1 },
    { a: 'reactor', b: 'lowerCorr', ambushCorners: 1 },
    { a: 'vehicle', b: 'cargo2', ambushCorners: 1 },
    { a: 'barracks', b: 'corrM', ambushCorners: 2 },
    // deck-5 -> deck-3 maintenance run that BYPASSES the hangar deck, so the
    // two hangar ladders aren't a hard chokepoint you can't get around
    { a: 'lowerCorr', b: 'corrA', ambushCorners: 2 },
    { a: 'hangarA', b: 'cargo1', ambushCorners: 1 },
    { a: 'workshop', b: 'vehicle', ambushCorners: 1 },
    // CROSS-DECK VENTS up top (user: cross-deck ducts the infection AND combat
    // forms use between decks) — the command/hab/ops decks get their own duct
    // risers so the flood isn't forced onto the visible ladders/lifts there.
    { a: 'officer', b: 'crewB', ambushCorners: 1 },   // deck 1 <-> deck 2
    { a: 'signal', b: 'd2store', ambushCorners: 1 },  // deck 1 <-> deck 2
    { a: 'crewA', b: 'gym', ambushCorners: 1 },       // deck 2 <-> deck 3
    { a: 'cryo', b: 'stores3', ambushCorners: 1 },    // deck 2 <-> deck 3
  ],
  vents: [
    { a: 'medbay', b: 'cryo', breakable: true },
    { a: 'cryo', b: 'corrM', breakable: true },
    { a: 'brig', b: 'security', breakable: true },
    { a: 'armory', b: 'corrF', breakable: true },
    { a: 'medbay', b: 'd2corrA', breakable: true },
    { a: 'crewB', b: 'cryo', breakable: true },
    // aft ducting so the crash-zone quadrant isn't a vent desert
    { a: 'cargo1', b: 'cargo2', breakable: true },
    { a: 'eng', b: 'lifesup', breakable: true },
    { a: 'hangar', b: 'maintF', breakable: true },
    // small-space ducting between the new storerooms and their neighbors
    { a: 'd2store', b: 'crewB', breakable: true },
    { a: 'stores3', b: 'cryo', breakable: true },
    { a: 'pumps', b: 'eng', breakable: true },
    { a: 'd4store', b: 'cargo1', breakable: true },
  ],
};
