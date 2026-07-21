// Charon-class light frigate — interior deck plan.
//
// THOROUGH MAP PASS (user note, keyed off the Charon-class reference hull):
// the ship is read top-to-bottom as five stacked decks, and the DECKS ARE
// WIDE — a spine artery flanked by substantial port/starboard halls, not a
// thin corridor with a couple of rooms hung off it. The signature of the
// class is the weapon sponsons: rows of 50mm point-defence batteries and
// Archer missile pods bulging out both flanks, with their magazines behind.
//
// Deck order (world elevation, deck 1 highest):
//   1  COMMAND      — bridge + CIC atop the dorsal superstructure
//   2  HABITATION   — crew berthing, mess, medical, cryo (widest living deck)
//   3  OPERATIONS   — armoury, barracks, and the flank WEAPON BATTERIES
//   4  ENGINEERING  — reactor, main engineering, MAC capacitor banks
//   5  FLIGHT/HANGAR— the ventral hangar bay, vehicle & cargo holds (LOWEST)
// The hangar is the BOTTOM deck (user: "the hangar is actually the lowest
// deck, engineering and reactor above that") — the outbreak usually crash-lands
// in it and climbs UP through the ship. But the portal can also tear through
// the HULL FLANKS higher up (user: crash possibilities extend to the deck 3 &
// 4 peripherals) — the outboard weapon batteries / archer pods (deck 3) and
// the capacitor banks (deck 4) are crash_candidates too, so some runs open
// with the breach amidships instead of in the belly.
//
// REAL MAP FOUNDATION: every compartment carries authored dimensions in
// METERS — `w` fore-aft × `d` athwartships — and `row` places it off the
// centreline (0 = spine, ±1 flush flank, ±2 outboard hall, ±3 the weapon
// sponsons at the very edge of the hull). Travel time is distance / speed.
// This plan is the source the navigable 3D world is extruded from.
export const SHIP = {
  playableLengthM: 220, // pressurized crew section, bow datum at x=0
  sizeScale: 1.6,       // global hull scale
  deckHeightM: 4.2,
  nodes: [
    // ================= DECK 1 · COMMAND (dorsal superstructure) =========
    { id: 'd1corr', name: 'Command Corridor', deck: 1, foreAft: 0.36, type: 'corridor', capacity: 6, w: 40, d: 4, row: 0, roles: ['artery'] },
    { id: 'cic', name: 'CIC', deck: 1, foreAft: 0.30, type: 'room', capacity: 8, w: 18, d: 12, row: 1, roles: ['command', 'comms'] },
    { id: 'signal', name: 'Signal Room', deck: 1, foreAft: 0.44, type: 'room', capacity: 5, w: 12, d: 9, row: 1, roles: ['systems', 'comms'] },
    { id: 'officer', name: 'Officer Country', deck: 1, foreAft: 0.34, type: 'room', capacity: 8, w: 16, d: 11, row: -1, roles: ['quarters', 'soft'] },
    { id: 'wardroom', name: 'Wardroom', deck: 1, foreAft: 0.46, type: 'room', capacity: 8, w: 12, d: 9, row: -1, roles: ['quarters', 'soft'] },
    // dorsal flanks: the bridge sits behind CIC atop the spine; sensor suites
    // outboard give the command deck real beam
    { id: 'bridge', name: 'Bridge', deck: 1, foreAft: 0.30, type: 'room', capacity: 6, w: 16, d: 11, row: 2, roles: ['command'] },
    { id: 'sensorPort', name: 'Sensor Suite Port', deck: 1, foreAft: 0.44, type: 'room', capacity: 5, w: 14, d: 10, row: 2, roles: ['systems'] },
    { id: 'sensorStbd', name: 'Sensor Suite Stbd', deck: 1, foreAft: 0.36, type: 'room', capacity: 5, w: 14, d: 10, row: -2, roles: ['systems'] },

    // ================= DECK 2 · HABITATION (wide living deck) ===========
    { id: 'd2corrF', name: 'Hab Corridor Fore', deck: 2, foreAft: 0.32, type: 'corridor', capacity: 8, w: 40, d: 4, row: 0, roles: ['artery'] },
    { id: 'd2corrA', name: 'Hab Corridor Aft', deck: 2, foreAft: 0.60, type: 'corridor', capacity: 8, w: 44, d: 4, row: 0, roles: ['artery'] },
    { id: 'crewA', name: 'Crew Quarters A', deck: 2, foreAft: 0.28, type: 'room', capacity: 14, w: 18, d: 12, row: 1, roles: ['quarters', 'soft'] },
    { id: 'mess', name: 'Mess Hall', deck: 2, foreAft: 0.38, type: 'open', capacity: 28, w: 20, d: 14, row: 1, roles: ['soft'] },
    { id: 'galley', name: 'Galley', deck: 2, foreAft: 0.46, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['soft'] },
    { id: 'crewB', name: 'Crew Quarters B', deck: 2, foreAft: 0.30, type: 'room', capacity: 14, w: 18, d: 12, row: -1, roles: ['quarters', 'soft'] },
    { id: 'd2store', name: 'Deck 2 Stores', deck: 2, foreAft: 0.44, type: 'room', capacity: 5, w: 8, d: 7, row: -1, roles: ['cargo'] },
    { id: 'rec', name: 'Rec Room', deck: 2, foreAft: 0.56, type: 'room', capacity: 12, w: 14, d: 11, row: 1, roles: ['soft'] },
    { id: 'chapel', name: 'Chapel', deck: 2, foreAft: 0.68, type: 'room', capacity: 6, w: 10, d: 9, row: 1, roles: ['soft'] },
    { id: 'medbay', name: 'Medbay', deck: 2, foreAft: 0.54, type: 'room', capacity: 12, w: 16, d: 12, row: -1, roles: ['medbay', 'helpless', 'corpse_cache', 'soft'] },
    { id: 'cryo', name: 'Cryo Bay', deck: 2, foreAft: 0.64, type: 'room', capacity: 10, w: 16, d: 12, row: -1, roles: ['cryo', 'corpse_cache'] },
    { id: 'brig', name: 'Brig', deck: 2, foreAft: 0.72, type: 'room', capacity: 4, w: 9, d: 7, row: -1, roles: ['brig', 'helpless'] },
    // wide berthing halls + support fill out the beam
    { id: 'berthPort', name: 'Port Berthing', deck: 2, foreAft: 0.36, type: 'open', capacity: 24, w: 32, d: 15, row: 2, roles: ['quarters', 'soft'] },
    { id: 'berthStbd', name: 'Starboard Berthing', deck: 2, foreAft: 0.34, type: 'open', capacity: 24, w: 32, d: 15, row: -2, roles: ['quarters', 'soft'] },
    { id: 'lounge', name: 'Wardroom Lounge', deck: 2, foreAft: 0.58, type: 'room', capacity: 12, w: 16, d: 12, row: 2, roles: ['soft'] },
    { id: 'hydro', name: 'Hydroponics', deck: 2, foreAft: 0.62, type: 'room', capacity: 8, w: 16, d: 12, row: -2, roles: ['soft', 'systems'] },

    // ================= DECK 3 · OPERATIONS / WEAPONS (widest) ===========
    { id: 'corrF', name: 'Main Corridor Fore', deck: 3, foreAft: 0.24, type: 'corridor', capacity: 10, w: 44, d: 4, row: 0, roles: ['artery'] },
    { id: 'corrM', name: 'Main Corridor Mid', deck: 3, foreAft: 0.50, type: 'corridor', capacity: 10, w: 44, d: 4, row: 0, roles: ['artery'] },
    { id: 'corrA', name: 'Main Corridor Aft', deck: 3, foreAft: 0.74, type: 'corridor', capacity: 10, w: 44, d: 4, row: 0, roles: ['artery'] },
    { id: 'gym', name: 'Gymnasium', deck: 3, foreAft: 0.28, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['soft'] },
    { id: 'security', name: 'Security', deck: 3, foreAft: 0.36, type: 'room', capacity: 10, w: 12, d: 10, row: 1, roles: ['marines'] },
    { id: 'stores3', name: 'Deck 3 Stores', deck: 3, foreAft: 0.44, type: 'room', capacity: 5, w: 8, d: 6, row: 1, roles: ['cargo'] },
    { id: 'armory', name: 'Armory', deck: 3, foreAft: 0.38, type: 'room', capacity: 8, w: 12, d: 9, row: -1, roles: ['armory', 'armed'] },
    { id: 'fireCtl', name: 'Fire Control', deck: 3, foreAft: 0.46, type: 'room', capacity: 6, w: 10, d: 8, row: -1, roles: ['systems', 'marines'] },
    { id: 'barracks', name: 'Barracks', deck: 3, foreAft: 0.58, type: 'room', capacity: 16, w: 20, d: 13, row: -1, roles: ['marines', 'odst'] },
    { id: 'workshop', name: 'Workshop', deck: 3, foreAft: 0.66, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['maintenance'] },
    { id: 'podPort', name: 'Lifepod Bay Port', deck: 3, foreAft: 0.80, type: 'room', capacity: 10, w: 14, d: 10, row: 1, roles: ['lifepods', 'objective'] },
    { id: 'podStbd', name: 'Lifepod Bay Stbd', deck: 3, foreAft: 0.80, type: 'room', capacity: 10, w: 14, d: 10, row: -1, roles: ['lifepods', 'objective'] },
    // THE FLANK WEAPON BATTERIES (user: substantial battery areas on both
    // flanks). Long point-defence halls at the outboard tier, with the Archer
    // missile pods and their magazines at the very edge of the hull.
    { id: 'batteryPort', name: 'Port 50mm Battery', deck: 3, foreAft: 0.40, type: 'open', capacity: 18, w: 42, d: 16, row: 2, roles: ['battery', 'armed', 'large', 'crash_candidate'] },
    { id: 'batteryStbd', name: 'Starboard 50mm Battery', deck: 3, foreAft: 0.42, type: 'open', capacity: 18, w: 42, d: 16, row: -2, roles: ['battery', 'armed', 'large', 'crash_candidate'] },
    { id: 'archerPort', name: 'Port Archer Pods', deck: 3, foreAft: 0.40, type: 'open', capacity: 12, w: 40, d: 12, row: 3, roles: ['magazine', 'hazard', 'large', 'crash_candidate'] },
    { id: 'archerStbd', name: 'Starboard Archer Pods', deck: 3, foreAft: 0.42, type: 'open', capacity: 12, w: 40, d: 12, row: -3, roles: ['magazine', 'hazard', 'large', 'crash_candidate'] },

    // ================= DECK 4 · ENGINEERING (above the hangar) ==========
    { id: 'engCorrF', name: 'Engineering Corridor', deck: 4, foreAft: 0.44, type: 'corridor', capacity: 8, w: 24, d: 4, row: 0, roles: ['artery'] },
    // GRAND STAIRWELL (user's Pillar-of-Autumn room): a big hall on the
    // engineering deck, entered from the corridor by a normal doorway, with a
    // central switchback staircase descending into the hangar bay below. Sits
    // directly over the hangar; walk all the way around the stairs on both
    // levels. foreAft is flush-snapped aft of engCorrF so it lands over the
    // hangar — do NOT edge it into the spine chain other than that one hatch.
    { id: 'grandStair', name: 'Grand Stairwell', deck: 4, foreAft: 0.57, type: 'open', capacity: 18, w: 26, d: 22, row: 0, roles: ['stairwell', 'large'] },
    { id: 'engCorrA', name: 'Aft Engineering Corridor', deck: 4, foreAft: 0.70, type: 'corridor', capacity: 8, w: 24, d: 4, row: 0, roles: ['artery'] },
    { id: 'lifesup', name: 'Life Support', deck: 4, foreAft: 0.40, type: 'room', capacity: 8, w: 14, d: 11, row: 1, roles: ['systems'] },
    { id: 'pumps', name: 'Coolant Plant', deck: 4, foreAft: 0.42, type: 'room', capacity: 5, w: 12, d: 9, row: -1, roles: ['systems', 'maintenance'] },
    { id: 'd5store', name: 'Engineering Stores', deck: 4, foreAft: 0.66, type: 'room', capacity: 5, w: 8, d: 6, row: 1, roles: ['cargo'] },
    { id: 'workshopA', name: 'Aft Workshop', deck: 4, foreAft: 0.68, type: 'room', capacity: 8, w: 12, d: 9, row: 1, roles: ['maintenance'] },
    { id: 'eng', name: 'Main Engineering', deck: 4, foreAft: 0.74, type: 'room', capacity: 12, w: 20, d: 14, row: -1, roles: ['engineering', 'power'] },
    { id: 'reactor', name: 'Reactor', deck: 4, foreAft: 0.82, type: 'room', capacity: 8, w: 16, d: 14, row: -2, roles: ['power', 'hazard'] },
    // (removed 'Maintenance Aft' — a dead-end corridor hanging off Engineering
    //  that went nowhere; user: "just remove it, it's a hallway to nowhere")
    // MAC capacitor banks + coolant loops fill the engineering flanks
    { id: 'capPort', name: 'Port Capacitor Bank', deck: 4, foreAft: 0.42, type: 'open', capacity: 10, w: 30, d: 14, row: 2, roles: ['power', 'hazard', 'large', 'crash_candidate'] },
    { id: 'capStbd', name: 'Starboard Capacitor Bank', deck: 4, foreAft: 0.44, type: 'open', capacity: 10, w: 30, d: 14, row: -2, roles: ['power', 'hazard', 'large', 'crash_candidate'] },
    { id: 'coolant', name: 'Coolant Loop', deck: 4, foreAft: 0.72, type: 'room', capacity: 6, w: 16, d: 12, row: 2, roles: ['systems'] },

    // ================= DECK 5 · FLIGHT / HANGAR (lowest, ventral) =======
    { id: 'maintF', name: 'Maintenance Fore', deck: 5, foreAft: 0.44, type: 'corridor', capacity: 6, w: 20, d: 4, row: 0, roles: ['maintenance'] },
    { id: 'pumpRoom', name: 'Pump Room', deck: 5, foreAft: 0.40, type: 'room', capacity: 5, w: 8, d: 7, row: 1, roles: ['maintenance', 'systems'] },
    { id: 'hangar', name: 'Hangar Fore', deck: 5, foreAft: 0.58, type: 'open', capacity: 30, w: 34, d: 22, row: 0, roles: ['hangar', 'large', 'crash_candidate'] },
    { id: 'hangarCtl', name: 'Hangar Control', deck: 5, foreAft: 0.52, type: 'room', capacity: 5, w: 8, d: 6, row: 1, roles: ['systems'] },
    { id: 'hangarA', name: 'Hangar Aft', deck: 5, foreAft: 0.68, type: 'open', capacity: 30, w: 34, d: 22, row: 0, roles: ['hangar', 'large', 'crash_candidate'] },
    { id: 'vehicle', name: 'Vehicle Bay', deck: 5, foreAft: 0.78, type: 'open', capacity: 24, w: 28, d: 18, row: 0, roles: ['vehicles', 'crash_candidate'] },
    { id: 'd4store', name: 'Flight Stores', deck: 5, foreAft: 0.74, type: 'room', capacity: 5, w: 8, d: 6, row: 1, roles: ['cargo'] },
    { id: 'cargo1', name: 'Cargo Hold 1', deck: 5, foreAft: 0.86, type: 'open', capacity: 18, w: 22, d: 16, row: 0, roles: ['cargo', 'crash_candidate'] },
    { id: 'cargo2', name: 'Cargo Hold 2', deck: 5, foreAft: 0.94, type: 'open', capacity: 18, w: 22, d: 16, row: 0, roles: ['cargo', 'crash_candidate'] },
    // launch bays + ordnance flank the hangar (the deck reads wide, not a slot)
    { id: 'launchPort', name: 'Port Launch Bay', deck: 5, foreAft: 0.60, type: 'open', capacity: 16, w: 26, d: 13, row: 1, roles: ['hangar', 'large'] },
    { id: 'launchStbd', name: 'Starboard Launch Bay', deck: 5, foreAft: 0.60, type: 'open', capacity: 16, w: 26, d: 13, row: -1, roles: ['hangar', 'large'] },
    { id: 'ordnance', name: 'Ordnance Store', deck: 5, foreAft: 0.72, type: 'room', capacity: 8, w: 12, d: 10, row: -1, roles: ['magazine', 'cargo'] },
  ],
  edges: [
    // ---- deck 1 · command ----
    { a: 'bridge', b: 'cic', type: 'hatch', lockable: false },
    { a: 'cic', b: 'd1corr', type: 'blastdoor', lockable: true },
    { a: 'd1corr', b: 'signal', type: 'hatch', lockable: true },
    { a: 'd1corr', b: 'officer', type: 'hatch', lockable: true },
    { a: 'd1corr', b: 'wardroom', type: 'hatch', lockable: true },
    { a: 'signal', b: 'sensorPort', type: 'hatch', lockable: true },
    { a: 'officer', b: 'sensorStbd', type: 'hatch', lockable: true },
    { a: 'd1corr', b: 'd2corrF', type: 'lift', lockable: false }, // deck1->2
    // ---- deck 2 · habitation ----
    { a: 'd2corrF', b: 'crewA', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'mess', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'galley', type: 'hatch', lockable: true },
    { a: 'mess', b: 'galley', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'crewB', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'd2store', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'd2corrA', type: 'hatch', lockable: true },
    { a: 'mess', b: 'berthPort', type: 'hatch', lockable: true },
    { a: 'crewB', b: 'berthStbd', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'rec', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'chapel', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'medbay', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'cryo', type: 'hatch', lockable: true },
    { a: 'd2corrA', b: 'brig', type: 'blastdoor', lockable: true },
    { a: 'rec', b: 'lounge', type: 'hatch', lockable: true },
    { a: 'cryo', b: 'hydro', type: 'hatch', lockable: true },
    { a: 'd2corrF', b: 'corrF', type: 'ladder', lockable: false }, // deck2->3
    { a: 'd2corrA', b: 'corrM', type: 'lift', lockable: false },   // deck2->3
    // ---- deck 3 · operations / weapons ----
    { a: 'corrF', b: 'gym', type: 'hatch', lockable: true },
    { a: 'corrF', b: 'security', type: 'hatch', lockable: true },
    { a: 'corrF', b: 'armory', type: 'blastdoor', lockable: true },
    { a: 'corrF', b: 'corrM', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'stores3', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'fireCtl', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'barracks', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'corrA', type: 'hatch', lockable: true },
    { a: 'corrA', b: 'workshop', type: 'hatch', lockable: true },
    { a: 'corrA', b: 'podPort', type: 'blastdoor', lockable: true },
    { a: 'corrA', b: 'podStbd', type: 'blastdoor', lockable: true },
    { a: 'security', b: 'batteryPort', type: 'hatch', lockable: true },
    { a: 'barracks', b: 'batteryStbd', type: 'hatch', lockable: true },
    { a: 'batteryPort', b: 'archerPort', type: 'hatch', lockable: true },
    { a: 'batteryStbd', b: 'archerStbd', type: 'hatch', lockable: true },
    { a: 'corrM', b: 'engCorrF', type: 'lift', lockable: false },  // deck3->4
    // ---- deck 4 · engineering ----
    { a: 'engCorrF', b: 'grandStair', type: 'hatch', lockable: false },
    { a: 'grandStair', b: 'engCorrA', type: 'hatch', lockable: false },
    { a: 'engCorrF', b: 'lifesup', type: 'hatch', lockable: true },
    { a: 'engCorrF', b: 'pumps', type: 'hatch', lockable: true },
    { a: 'engCorrA', b: 'd5store', type: 'hatch', lockable: true },
    { a: 'engCorrA', b: 'workshopA', type: 'hatch', lockable: true },
    { a: 'engCorrA', b: 'eng', type: 'hatch', lockable: true },
    { a: 'eng', b: 'reactor', type: 'blastdoor', lockable: true },
    { a: 'lifesup', b: 'capPort', type: 'hatch', lockable: true },
    { a: 'pumps', b: 'capStbd', type: 'hatch', lockable: true },
    { a: 'workshopA', b: 'coolant', type: 'hatch', lockable: true },
    { a: 'grandStair', b: 'hangar', type: 'stairwell', lockable: false }, // deck4->5 walk-down
    { a: 'engCorrA', b: 'hangarA', type: 'ladder', lockable: false },     // deck4->5
    // ---- deck 5 · flight / hangar ----
    { a: 'maintF', b: 'hangar', type: 'hatch', lockable: true },
    { a: 'maintF', b: 'pumpRoom', type: 'hatch', lockable: true },
    { a: 'hangar', b: 'hangarCtl', type: 'hatch', lockable: true },
    { a: 'hangar', b: 'hangarA', type: 'hatch', lockable: false },
    { a: 'hangarA', b: 'hangarCtl', type: 'hatch', lockable: true },
    { a: 'hangar', b: 'launchPort', type: 'hatch', lockable: true },
    { a: 'hangar', b: 'launchStbd', type: 'hatch', lockable: true },
    { a: 'hangarA', b: 'vehicle', type: 'hatch', lockable: true },
    { a: 'hangarA', b: 'ordnance', type: 'hatch', lockable: true },
    { a: 'vehicle', b: 'd4store', type: 'hatch', lockable: true },
    { a: 'vehicle', b: 'cargo1', type: 'hatch', lockable: true },
    { a: 'cargo1', b: 'cargo2', type: 'hatch', lockable: true },
  ],
  // MAINTENANCE SHAFTS — enclosed cross-deck crawls the flood uses (infection
  // AND combat forms; humans never). Cross-deck risers give the outbreak
  // private vertical routes so the visible ladders/lifts aren't the only way
  // up, plus a few same-deck bypass crawls.
  maintShafts: [
    // cross-deck risers (deck to deck)
    { a: 'officer', b: 'crewB', ambushCorners: 1 },     // 1 <-> 2
    { a: 'signal', b: 'd2store', ambushCorners: 1 },    // 1 <-> 2
    { a: 'crewA', b: 'gym', ambushCorners: 1 },         // 2 <-> 3
    { a: 'cryo', b: 'fireCtl', ambushCorners: 1 },      // 2 <-> 3
    { a: 'barracks', b: 'engCorrF', ambushCorners: 2 }, // 3 <-> 4
    { a: 'workshop', b: 'workshopA', ambushCorners: 1 },// 3 <-> 4
    { a: 'batteryStbd', b: 'capStbd', ambushCorners: 1 },// 3 <-> 4 (flank riser)
    { a: 'eng', b: 'cargo1', ambushCorners: 1 },        // 4 <-> 5
    { a: 'reactor', b: 'hangarA', ambushCorners: 1 },   // 4 <-> 5
    { a: 'coolant', b: 'vehicle', ambushCorners: 1 },   // 4 <-> 5
    // same-deck bypass crawls so no single deck is a hard choke
    { a: 'hangar', b: 'maintF', ambushCorners: 2 },
    { a: 'hangar', b: 'cargo1', ambushCorners: 2 },
    { a: 'batteryPort', b: 'podPort', ambushCorners: 2 },
    { a: 'corrF', b: 'corrA', ambushCorners: 2 },
    { a: 'lifesup', b: 'eng', ambushCorners: 2 },
  ],
  // Authored ducts supplement the auto-generated net (graph.js ducts every
  // same-deck doorway + each room to its nearest same-deck neighbour). These
  // add a few cross-room runs the doors don't already cover.
  vents: [
    { a: 'medbay', b: 'cryo', breakable: true },
    { a: 'brig', b: 'cryo', breakable: true },
    { a: 'armory', b: 'fireCtl', breakable: true },
    { a: 'batteryPort', b: 'archerPort', breakable: true },
    { a: 'batteryStbd', b: 'archerStbd', breakable: true },
    { a: 'cargo1', b: 'cargo2', breakable: true },
    { a: 'ordnance', b: 'cargo1', breakable: true },
    { a: 'eng', b: 'reactor', breakable: true },
    { a: 'capPort', b: 'lifesup', breakable: true },
    { a: 'berthPort', b: 'lounge', breakable: true },
    { a: 'hangar', b: 'hangarA', breakable: true },
  ],
};
