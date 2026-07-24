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
    lowerMaintenance: 44,     // unarmed repair crew AT WORK in the lower-deck machinery
                              // spaces (engineering/reactor/life support) from the start
                              // (user note: "way more souls alive in the lower levels")
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
  // open flame on the deck (breach blaze + burning broken doors): real
  // environmental damage inside the radius, and every NPC steers clear
  fire: { dps: 10, radiusM: 2.1 },
  bodies: {
    eventCorpses: 69,         // portal-event dead scattered evenly through the ship
                              // (user note: +15% more bodies, evenly spread)
    breachCorpses: 10,        // fresh dead at the breach (±50% roll on placement)
    // the vast majority of the dead were NOT carrying weapons (user rule):
    // a form raised from them fights with claws alone — sprint, leap, swipe
    armedFraction: 0.08,
  },
  // DIFFICULTY LEVERS (user direction): without the player in the loop the
  // flood should win most runs — the marines alone can't hold the ship. Tune
  // difficulty with the initial swarm size and comms quality, not squad nerfs.
  flood: {
    initialInfectionForms: 20, // difficulty lever (user: sim == game defaults)
    initialCombatForms: 0,     // a pure infection swarm; combat forms + carriers
    initialCarriers: 0,        // are EARNED through conversions, not handed out at t=0
  },
  // GAME-ACCURATE CARRIER (user note): forms accumulate INSIDE the swelling
  // carrier and only spill out when it RUPTURES — under fire, or at the top
  // limit. Gestation starts the moment the carrier forms.
  carrier: {
    incubationIntervalSec: 9.75, // -35% (user tuning): production runs hotter
    firstIncubationSec: 3.9,     // first form seats quickly (-35%)
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
    stock: 16,             // rifles racked — first come, first served (once unsealed)
    // THE SEALED RESERVE (user rule): the armory starts LOCKED. Inside: the
    // racked rifles + grenade crates, one flamethrower, and an ODST squad
    // standing by with more armor than a line marine. The seal releases only
    // when the ship is genuinely losing — a strong hive AND a thin line.
    odstSquadSize: 5,
    odstHp: 85,                // vs line marine 45 — hardened ODST plate
    unlockCombatForms: 20,     // flood must field at least this many combat forms
    unlockMarinesLeft: 10,     // and the line squads must be down to this few
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
    // HALO-DURABLE (user rule: difficulty lives in damage/health and hive
    // tactics, not starting headcount — and the player gets NO special
    // multiplier): ~1/3 of an MA5 mag on target drops one, a marine PAIR now
    // trades a man for a form more often than not, 3 marines win clean.
    // swing: 18 dmg / 0.9 s = the same 20 dps sustained, delivered in chunks.
    combatForm: { hp: 90, dps: 20, hpJitter: 0.18,   // spawn hp varies ±18%
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
    latchDps: 4,               // the embedded spike works while it burrows (user: pods
                               // were too unlethal to marines)
    grabPins: true,            // a grabbed target is held in place (can't flee)
    armedBraveryStrength: 0.9, // fights only if visible flood strength below this
    // REAL SPACE COMBAT (user note): claws and grabs land at arm's reach,
    // measured in actual meters — not "anywhere inside the same room record"
    meleeRangeM: 2.2,          // combat-form claws/lunge reach
    grabRangeM: 1.4,           // an infection form must actually reach the body (a short leap latches)
    stompRangeM: 4.0,          // boots/point-fire kill skittering forms only up close
    podAccMult: 0.45,          // a skittering pod is a small fast rifle target
    rifleFalloffM: 12,         // full NPC rifle effect inside this — beyond it, a dark
    rifleFarFactor: 0.5,       // ship and a sprinting target halve effective fire
  },
  // FLOOD DARKNESS (user rule): a room the flood holds ALONE goes dark at
  // 60 s (biomass overgrows the fixtures) and fills with spore fog at
  // 120 s. Humans fight in it by flashlight — accuracy suffers, more in
  // fog. If no flood is present the room recovers at double speed.
  darkness: {
    soloDarkSec: 60,
    fogSec: 120,
    maxHoldSec: 150,
    // FOG PERSISTENCE (user rule): once a room fogs, the murk does NOT fade
    // on its own. It burns off only after the last flood inside is eliminated
    // AND the player or an ODST holds the room for this long — and any flood
    // re-entry before that mark restarts the clock in full.
    fogLingerSec: 120,
    darkAccMult: 0.75,   // flashlight fighting
    fogAccMult: 0.8,     // stacked on top in spore fog (net ~0.6)
    fogViewM: 8,         // how far the player's flashlight cuts into the fog
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
    // pods SKITTER (user note: they were too slow) — quicker than a walking
    // human even off the lunge, matching how the games read
    infection: 1.35, combatForm: 1.25,
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
    // FLOOD DUCT HIGHWAY (user: vent travel ~3x faster) — the ducts are the
    // flood's fast private network; a form rips through them far quicker than
    // it crosses open floor, which is what makes them worth using.
    shaftMps: 2.1,            // crawl pace in cross-deck ducts (was 0.7)
    ventMps: 1.65,           // infection-form pace in same-deck ducting (was 0.55)
    crawlWindingFactor: 1.35, // shafts/vents are never straight lines
  },
  // command path (companion spec §0/§3.4). In single-player the producer
  // stamps orders this many ticks ahead; the same knob is net.inputDelayTicks
  // (~3-5) once lockstep transport slots underneath the queue.
  net: { inputDelayTicks: 1 },
  command: { linkReliability: 0.9 }, // per-deck order delivery (companion §2.4), tunable
  // CLASSIC-HALO RAGDOLL (cosmetic; physics/ragdoll.js). Feel knobs for the
  // death flop — the whole block is render-only and never touches sim state
  // (docs/DESIGN-RAPIER-STACK.md's "ragdoll flourish lives outside the
  // authoritative set"). Tune here, not in the solver. Distances in meters,
  // speeds m/s, damping per-second, angles radians.
  ragdoll: {
    enabled: true,
    maxActive: 48,          // concurrent physics ragdolls; deaths past this render as static corpses
    gravity: 22,            // matches the game's frag-throw gravity, so a flop reads at the same weight
    bodyLen: 1.7, bodyRadius: 0.3, comY: 0.9,   // torso capsule + centre of mass (feet at y=0);
                                                // a flat body rests with its centreline ~radius off
                                                // the deck, matching the legacy corpse's 0.25 lift

    restitution: 0.18,      // bodies thud, maybe bounce once — not rubber
    groundFriction: 6.0, groundAngFriction: 5.0, // slide/tumble bleed-off while touching the deck
    linDamp: 0.1, angDamp: 1.0,                  // air damping (per second, exp)
    maxLinSpeed: 24, maxAngSpeed: 28,            // hard clamps — the stability backstop
    sleepLin: 0.16, sleepAng: 0.4, sleepSec: 0.5,// settle → freeze the resting pose
    inertia: 1.2,           // scalar rotational inertia for contact response
    driftLimitM: 1.5,       // if the sim moves the body this far (dragged/relocated), drop the ragdoll
    // launch off the killing blow (PLAN-ANIM-POLISH "hit-direction deaths").
    // Punchier than the first pass (user: "more drama, more punch to the bullet
    // force") — a shot body jolts back and tumbles harder.
    launchSpeed: 6.5, launchUp: 3.2, spin: 9.0,
    chargeBonus: 4.5,       // a charging/leaping form that dies carries its momentum into the tumble
    corpseKnockSpeed: 4.0, corpseHostileRangeM: 4.0, // a human corpse is thrown off the nearest hostile
    // GRENADE / EXPLOSION deaths (user: "grenades should launch folks in a
    // flailing manner"). Radial off the blast centre, scaled by proximity: big
    // air, a violent tumble, and limbs whipping (blastKick >> limbKick). A blast
    // also re-flings bodies already on the deck. blastRadiusPad extends the
    // "caught in it" reach past the sim blast (cosmetic only); blastTtl keeps the
    // blast live long enough for the deaths it causes to register; blastFalloff
    // is the edge-vs-centre drop.
    blastSpeed: 13, blastUp: 6.0, blastSpin: 17, blastKick: 14,
    blastFalloff: 0.55, blastRadiusPad: 1.5, blastTtl: 0.5,
    // limbs (the floppy flail about the JMS joint pivots)
    limbGrav: 9, limbBind: 2.5, limbDamp: 3.0, limbLimit: 1.4, limbKick: 7.0,
    subDt: 0.008333333, maxSubSteps: 8, dtCap: 0.05, // internal fixed step (1/120) — stable + deterministic
  },
};

// Deep-clone params so a run can mutate its own copy (live dials) without
// touching the defaults.
export function cloneParams() {
  return JSON.parse(JSON.stringify(PARAMS));
}
