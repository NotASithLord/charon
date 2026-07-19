// Tuning parameters (§10) and Flood decision-math constants (§13.10).
// Stated values are fixed by design; PLACEHOLDER values are starting guesses.
// The three MASTER DIALS (radio.marineCallReliability, belief.decayRatePerSec,
// belief.predictionQuality) are exposed live in the debug UI.

export const PARAMS = {
  sim: {
    tickHz: 15,               // movement/sense tick
    strategicTickSec: 2.5,    // one "infection round"
  },
  // WHAT YOU SET IS WHAT YOU GET (user note): force composition is explicit
  // counts — squads, squad sizes, civilians, bodies — no fractions to decode.
  // Only WHERE everyone starts (plus which doors jam, which vents collapse,
  // which rooms lose power) rolls fresh each run.
  crew: {
    civilians: 96,            // unarmed crew sheltering / working the ship
    armedCrew: 21,            // crew carrying sidearms (not marines)
    lowerMaintenance: 10,     // unarmed maintenance crew roaming decks 4-5 fixing systems
    brigPrisoners: 2,
    medbayWounded: 6,
    radio: { civilian: 0.35, armed: 0.7, marine: 1.0 }, // hasRadio fraction
  },
  marines: {
    squads: 4,                // line squads
    squadSize: 4,             // marines per line squad
    patrols: 3,               // roaming pair patrols walking the whole ship
    patrolSize: 2,
    garrison: 6,              // permanent Command Corridor guard detail
  },
  bodies: {
    eventCorpses: 150,        // portal-event dead scattered through the ship
    breachCorpses: 10,        // fresh dead at the breach (±50% roll on placement)
    // the vast majority of the dead were NOT carrying weapons (user rule):
    // a form raised from them fights with claws alone — sprint, leap, swipe
    armedFraction: 0.08,
  },
  // DIFFICULTY LEVERS (user direction): without the player in the loop the
  // flood should win most runs — the marines alone can't hold the ship. Tune
  // difficulty with the initial swarm size and comms quality, not squad nerfs.
  flood: {
    initialInfectionForms: 20, // difficulty lever — live input in the sim UI
    initialCombatForms: 4,     // difficulty lever — live input in the sim UI
    initialCarriers: 0,        // difficulty lever — live input in the sim UI (seeded at the breach)
  },
  // GAME-ACCURATE CARRIER (user note): forms accumulate INSIDE the swelling
  // carrier and only spill out when it RUPTURES — under fire, or at the top
  // limit. Gestation starts the moment the carrier forms.
  carrier: {
    incubationIntervalSec: 15, // PLACEHOLDER (T_inc)
    firstIncubationSec: 6,     // first form seats quickly
    maxInfectionForms: 8,      // top limit — the skin can't hold more; it ruptures
    seekOrExplodeFraction: 0.85, // near-full: waddle toward prey so the pop lands on someone
    explodeDamage: 20,         // to humans within the rupture radius
    explodeRadiusM: 7,         // real blast reach — a rupture across a hangar misses you
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
    maxMusterForms: 45,    // a wave this size flattens any line — stop waiting
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
    // Re-anchored from the spec's 40 (user note: "always hoarding makes no
    // sense") — in the current economy forms are MEANT to be spent on bodies
    // immediately and carriers replace them, so a modest pool is healthy,
    // not an emergency. Scarcity 1.0 at ~15 forms.
    I_ref: 15,
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
    // kill), 3 win reliably.
    // HALO-STANDARD COMBAT (user note): open-room fights are DISCRETE
    // deterministic events, not damage drizzle — each shooter fires aimed
    // shots on its own cadence and ROLLS to hit (accuracy drops past
    // rifleFalloffM); each combat form lands heavy SWIPES on a cooldown.
    // All rolls go through the seeded sim RNG, so lockstep holds.
    // The bare `dps` numbers are the NOMINAL sustained rates — they still
    // drive the hive's planning estimates and the cramped shaft/ambush
    // pools, and the gun/swing numbers below are tuned to average out to
    // them (e.g. marine 3 rof x 6.5 dmg x 0.72 acc ~= 14 dps).
    marine:   { hp: 45, dps: 14, stompPerSec: 0.4,   // stomp = infection-form kills/s
                gun: { rof: 3, dmg: 6.5, accNear: 0.72, accFar: 0.32 } },
    armed:    { hp: 30, dps: 9, stompPerSec: 0.2,
                gun: { rof: 2, dmg: 6.5, accNear: 0.70, accFar: 0.30 } },
    civilian: { hp: 20 },
    // Tuned so a combat form's death (2*marineDps) lands right at the moment
    // it downs its first marine (marineHp/cfDps): with 2 marines it's a
    // coin-flip whether they kill it clean or trade one, 3 win clean, 1 loses.
    // swing: 18 dmg / 0.9 s = the same 20 dps sustained, delivered in chunks.
    combatForm: { hp: 63, dps: 20, hpJitter: 0.18,   // spawn hp varies ±18% -> real 50/50 at 2v1
                  swing: { dmg: 18, cooldownSec: 0.9 } },
    hostWeaponDps: 5,          // nominal (shaft pools / hive estimates)
    // the armed MINORITY of forms spray the host's weapon one-handed and
    // wildly (lore) — suppressive noise more than marksmanship
    hostGun: { rof: 2, dmg: 5, accNear: 0.35, accFar: 0.15 },
    carrierHp: 40,
    infectionGrabSec: 6,       // armed crew/marines: a LIVE host turns slightly
                               // FASTER than a corpse (user rule) — the flesh cooperates
    civilianGrabSec: 7,        // burrowing in takes real seconds now (user note)
    corpseConvertSec: 7,       // infection form + body -> combat form
    // POINT-BLANK RISK (user rule): letting an infection form get this close
    // is always a mistake, marine or not — it lunges for the latch
    lungeRiskM: 3.0,
    latchDps: 2,               // the embedded spike works while it burrows
    grabPins: true,            // a grabbed target is held in place (can't flee)
    armedBraveryStrength: 0.9, // fights only if visible flood strength below this
    // REAL SPACE COMBAT (user note): claws and grabs land at arm's reach,
    // measured in actual meters — not "anywhere inside the same room record"
    meleeRangeM: 2.2,          // combat-form claws/lunge reach
    grabRangeM: 1.4,           // an infection form must actually reach the body (a short leap latches)
    stompRangeM: 4.0,          // boots/point-fire kill skittering forms only up close
    rifleFalloffM: 12,         // full NPC rifle effect inside this — beyond it, a dark
    rifleFarFactor: 0.5,       // ship and a sprinting target halve effective fire
  },
  marineDoctrine: {
    firstSweepDelaySec: 10,    // muster time before the crash sweep launches (§5.3)
    officers: 4,               // officer civilians who stay put in Officer Country
    bridgeOfficers: 3,         // captain + officers who never leave the bridge
    sweepDwellSec: 15,         // min pause at each cleared room (+ jitter)
    sweepDwellJitterSec: 10,
  },
  civilian: {
    fleeHearingHops: 1,        // only bolt from trouble this close (was ship-wide)
    workerFraction: 0.2,       // fraction still working the ship — they move with purpose
    workMoveChancePerSec: 0.03,// a work trip every ~30s, not constant lapping; halved once the outbreak is known
  },
  speed: { // multipliers on movement.baseMps (relative ratios are user-set)
    civilian: 1.0, civilianFlee: 1.5, armed: 1.0, marine: 1.0,
    infection: 0.9, combatForm: 1.25,
    carrier: 0.55, // lore: a slow, blundering waddle — people underestimate it
    drag: 0.5,
    // lore: combat forms don't jog at prey — they SPRINT, as fast as a
    // sprinting Spartan (~6.3 m/s at this multiplier). Real-space combat
    // made the approach cost real seconds of incoming fire, so the charge
    // must be game-fast or every open-room assault dies crossing the floor.
    chargeMult: 3.6,
    // lore: an infection form closing on a host doesn't walk — it SKITTERS
    // and leaps (~4.4 m/s). Must comfortably beat civilianFlee or no grab
    // ever lands in open space (grabs now require physical reach).
    infectionLunge: 3.5,
  },
  // REAL DISTANCES (user note): the map is laid out in meters and travel
  // time = distance / speed — the foundation for the navigable 3D map.
  // baseMps is a purposeful walk; the speed multipliers above scale it.
  movement: {
    baseMps: 1.4,             // human purposeful walk
    doorDelaySec: { hatch: 0.8, blastdoor: 2.5, lift: 0, ladder: 0 },
    liftSec: 10,              // call + ride, distance-independent
    ladderClimbMps: 1.2,      // vertical speed on ladder runs — a deck in ~3.5s;
                              // with one-body-at-a-time ladders (user rule), the
                              // old 0.5 crawl turned every queue into minutes
    shaftMps: 0.7,            // crawl pace in maintenance shafts
    ventMps: 0.55,            // infection-form pace in ducting
    crawlWindingFactor: 1.35, // shafts/vents are never straight lines
  },
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
