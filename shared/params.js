// Tuning parameters (§10) and Flood decision-math constants (§13.10).
// Stated values are fixed by design; PLACEHOLDER values are starting guesses.
// The three MASTER DIALS (radio.marineCallReliability, belief.decayRatePerSec,
// belief.predictionQuality) are exposed live in the debug UI.

export const PARAMS = {
  sim: {
    tickHz: 15,               // movement/sense tick
    strategicTickSec: 2.5,    // one "infection round"
  },
  npc: {
    count: 140,               // PLACEHOLDER within 100-200
    corpsesFromEvent: 150,    // from the portal event
    marineFraction: 0.11,     // of npc.count -> ~15 marines -> 3-4 squads (the ship is running light)
    armedFraction: 0.15,      // armed (non-marine) crew
    brigPrisoners: 2,
    medbayWounded: 6,
    lowerMaintenance: 10,     // unarmed maintenance crew roaming decks 4-5 fixing systems
    radio: { civilian: 0.35, armed: 0.7, marine: 1.0 }, // hasRadio fraction
  },
  // DIFFICULTY LEVERS (user direction): without the player in the loop the
  // flood should win most runs — the marines alone can't hold the ship. Tune
  // difficulty with the initial swarm size and comms quality, not squad nerfs.
  flood: {
    initialInfectionForms: 20, // difficulty lever — live input in the sim UI
    initialCombatForms: 4,     // difficulty lever — live input in the sim UI
    initialCarriers: 0,        // difficulty lever — live input in the sim UI (seeded at the breach)
    breachCorpses: 10,         // fresh corpses spawned at the breach
  },
  carrier: {
    incubationIntervalSec: 15, // PLACEHOLDER (T_inc)
    firstIncubationSec: 6,     // first form comes quickly — minting starts the moment it forms
    maxInfectionForms: 8,      // stated 7-8 (M)
    seekOrExplodeFraction: 0.85,
    explodeRelease: 3,         // forms released on detonation
    explodeDamage: 20,         // to humans in node
    transformSec: 4,           // time for a combat form to root into a carrier
    productionBackpressure: 130, // pause minting above this many live infection forms
  },
  combatForm: {
    selfReviveChance: 0.25,    // stated
    selfReviveWindowSec: 10,   // stated
    damageMax: 100,            // maxed = permanently useless
    reviveIntegrityFrac: 0.5,
    reanimateIntegrityFrac: 0.6,
    reanimateTimeSec: 2,
  },
  flamethrower: { fuelUnits: 100, dps: 50, fuelPerSec: 2, fuelPerCorpse: 1, burnNodeSec: 12 },
  door: { lockedFraction: 0.25 },   // PLACEHOLDER, per-run graph mutation (visible variety run to run)
  vent: { blockedFraction: 0.30 },  // PLACEHOLDER, per-run
  ambush: { firstStrikeMult: 3.0 }, // PLACEHOLDER, applies to both sides
  motionTracker: { rangeHops: 1 },  // reveals a moving infection form in a vent
  power: { unstableFraction: 0.20 },// PLACEHOLDER
  sensor: {
    losHops: 1,        // same node + adjacent through open/unlocked standard edge
    hearingHops: 2,    // footsteps/screams
    gunfireHops: 3,    // gunfire carries further
  },
  radio: {
    marineCallReliability: 0.5,   // MASTER DIAL — marine coordination efficiency / difficulty lever
                                  // (0.95 = intact comms; the portal event damaged them.
                                  //  Raise it and the response snuffs most outbreaks —
                                  //  re-tuned down after adding the top-deck garrison,
                                  //  armed officers, and lower-deck maintenance crew.)
    civilianCallReliability: 0.35,// PLACEHOLDER
    callFadeSec: 60,
  },
  rampage: {
    threshold: 1.5,      // local flood:human strength ratio to flip aggressive
    localReserve: 1.5,   // min local flood mass in a region before it rampages
    marineCap: 0.6,      // if believed marine strength in the region exceeds this, hide instead
  },
  swarm: {
    overwhelmRatio: 2.0,   // weighted flood:shooter ratio at which grabs work THROUGH gunfire
    killRatio: 2.0,        // muster:squad ratio to spring on an isolated marine squad
    musterHops: 3,         // how far the hive gathers forms for a squad-wipe
    isolationHops: 3,      // no friendly squad within this = isolated
    reserveForms: 8,       // only trade forms for marines while this pool (or a carrier) remains
    escortPer: 3,          // 1 combat-form escort per ~3 infection forms in a pack
  },
  lastStand: {
    marineFraction: 0.3,   // when squad marines drop below this of start, fall back
    hearChance: 0.65,      // per-survivor roll to hear the fallback call
    officerJoinChance: 0.6,// stay-put officers who step out into the corridor line
    armedJoinFraction: 0.8,// armed civilians who stand WITH the marines on the line
  },
  armory: {
    selfArmChance: 0.25,   // chance an unarmed civilian runs for the armory once panic breaks out
    stock: 10,             // rifles left on the rack — first come, first served
  },
  belief: {
    decayRatePerSec: 0.1,   // MASTER DIAL (lambda) — smart vs unfair
    predictionQuality: 0.7, // MASTER DIAL (q) — how well it guesses your route
    humanSpeedHops: 0.35,   // hops/s for predicted spread radius
  },
  // §13 decision math
  hive: {
    I_ref: 40,
    kS: 1.5,
    scarcityMin: 0.5,
    scarcityMax: 4,
    riskBase: 1.0,
    militaryValue: 1.5,
    ventKillProbPerSec: 0.35,  // p_v while moving+watched
    ventKillProbStillPerSec: 0.06, // seen through grating while still
    values: {                  // targetValue weights for grabs
      helpless: 3.0,
      corpse: 1.2,             // convert corpse -> combat form (plus militaryValue)
      civilianNoRadio: 2.5,
      civilianRadio: 2.0,
      armed: 1.2,
      distressPenalty: 2.5,    // grab likely to trigger a call
    },
    searchMinPool: 45,         // won't spend forms searching below this pool
    openingSweepMargin: 12,    // sec of safety margin vs estimated sweep ETA
  },
  // Combat model (§7 support numbers, all PLACEHOLDER)
  combat: {
    // Weighted (§7 support) so a combat form is a serious threat: 1 marine
    // almost certainly loses, 2 trade roughly even (one marine down for the
    // kill), 3 win reliably. See combat.js focus-fire model.
    marine:   { hp: 45, dps: 14, stompPerSec: 0.4 }, // stomp = infection-form kills/s
    armed:    { hp: 30, dps: 9, stompPerSec: 0.2 },
    civilian: { hp: 20 },
    // Tuned so a combat form's death (2*marineDps) lands right at the moment
    // it downs its first marine (marineHp/cfDps): with 2 marines it's a
    // coin-flip whether they kill it clean or trade one, 3 win clean, 1 loses.
    combatForm: { hp: 63, dps: 20, hpJitter: 0.18 }, // spawn hp varies ±18% -> real 50/50 at 2v1
    carrierHp: 40,
    infectionGrabSec: 1.2,     // time to convert an armed/overwhelmed target
    civilianGrabSec: 1.0,      // an unarmed civilian is taken almost instantly
    grabPins: true,            // a grabbed target is held in place (can't flee)
    armedBraveryStrength: 0.9, // fights only if visible flood strength below this
  },
  marineDoctrine: {
    firstSweepDelaySec: 18,    // muster time before the crash sweep launches (§5.3)
    commandGarrison: 6,        // permanent marines holding the corridor into the top deck (never move)
    officers: 4,               // officer civilians who stay put in Officer Country
    bridgeOfficers: 3,         // captain + officers who never leave the bridge
    sweepDwellSec: 25,         // min pause at each cleared room — slow, methodical (+ jitter)
    sweepDwellJitterSec: 15,
  },
  civilian: {
    fleeHearingHops: 1,        // only bolt from trouble this close (was ship-wide)
    workerFraction: 0.2,       // fraction still working the ship — they move with purpose
    workMoveChancePerSec: 0.03,// a work trip every ~30s, not constant lapping; halved once the outbreak is known
  },
  speed: { // edge-traversal multipliers (1.0 = base edge time), user-set
    civilian: 1.0, civilianFlee: 1.5, armed: 1.0, marine: 1.0,
    infection: 0.9, combatForm: 1.25, carrier: 0.8, drag: 0.5,
  },
  edgeTravelSec: { hatch: 3, blastdoor: 4, lift: 6, ladder: 5, shaft: 8, vent: 6 },
  // command path (companion spec §0/§3.4). In single-player the producer
  // stamps orders this many ticks ahead; the same knob is net.inputDelayTicks
  // (~3-5) once lockstep transport slots underneath the queue.
  net: { inputDelayTicks: 1 },
  command: { linkReliability: 0.9 }, // per-deck order delivery (companion §2.4), tunable
};

// Deep-clone params so a run can mutate its own copy (live dials) without
// touching the defaults.
export function cloneParams() {
  return JSON.parse(JSON.stringify(PARAMS));
}
