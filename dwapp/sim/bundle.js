// shared/rng.js
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  h = Math.imul(h ^ h >>> 16, 2246822507);
  h = Math.imul(h ^ h >>> 13, 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
var RNG = class {
  constructor(seed) {
    this.s = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  }
  next() {
    let t = this.s += 1831565813;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  chance(p) {
    return this.next() < p;
  }
  range(a, b) {
    return a + this.next() * (b - a);
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // Weighted pick: items [{w, v}] or parallel arrays
  weighted(items, weightOf) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = this.next() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }
};

// shared/params.js
var PARAMS = {
  sim: {
    tickHz: 15,
    // movement/sense tick
    strategicTickSec: 2.5
    // one "infection round"
  },
  // WHAT YOU SET IS WHAT YOU GET (user note): force composition is explicit
  // counts — squads, squad sizes, civilians, bodies — no fractions to decode.
  // Only WHERE everyone starts (plus which doors jam, which vents collapse,
  // which rooms lose power) rolls fresh each run.
  crew: {
    civilians: 96,
    // unarmed crew sheltering / working the ship
    armedCrew: 21,
    // crew carrying sidearms (not marines)
    lowerMaintenance: 44,
    // unarmed repair crew AT WORK in the lower-deck machinery
    // spaces (engineering/reactor/life support) from the start
    // (user note: "way more souls alive in the lower levels")
    brigPrisoners: 2,
    medbayWounded: 6,
    radio: { civilian: 0.35, armed: 0.7, marine: 1 }
    // hasRadio fraction
  },
  marines: {
    squads: 4,
    // line squads
    squadSize: 4,
    // marines per line squad
    patrols: 3,
    // roaming pair patrols walking the whole ship
    patrolSize: 2,
    garrison: 6
    // permanent Command Corridor guard detail
  },
  // open flame on the deck (breach blaze + burning broken doors): real
  // environmental damage inside the radius, and every NPC steers clear
  fire: { dps: 10, radiusM: 2.1 },
  bodies: {
    eventCorpses: 69,
    // portal-event dead scattered evenly through the ship
    // (user note: +15% more bodies, evenly spread)
    breachCorpses: 10,
    // fresh dead at the breach (±50% roll on placement)
    // the vast majority of the dead were NOT carrying weapons (user rule):
    // a form raised from them fights with claws alone — sprint, leap, swipe
    armedFraction: 0.08
  },
  // DIFFICULTY LEVERS (user direction): without the player in the loop the
  // flood should win most runs — the marines alone can't hold the ship. Tune
  // difficulty with the initial swarm size and comms quality, not squad nerfs.
  flood: {
    initialInfectionForms: 20,
    // difficulty lever (user: sim == game defaults)
    initialCombatForms: 0,
    // a pure infection swarm; combat forms + carriers
    initialCarriers: 0
    // are EARNED through conversions, not handed out at t=0
  },
  // GAME-ACCURATE CARRIER (user note): forms accumulate INSIDE the swelling
  // carrier and only spill out when it RUPTURES — under fire, or at the top
  // limit. Gestation starts the moment the carrier forms.
  carrier: {
    incubationIntervalSec: 9.75,
    // -35% (user tuning): production runs hotter
    firstIncubationSec: 3.9,
    // first form seats quickly (-35%)
    maxInfectionForms: 8,
    // top limit — the skin can't hold more; it ruptures
    seekOrExplodeFraction: 0.85,
    // near-full: waddle toward prey so the pop lands on someone
    explodeDamage: 20,
    // to humans within the rupture radius
    explodeRadiusM: 7,
    // real blast reach — a rupture across a hangar misses you
    transformSec: 4,
    // time for a combat form to root into a carrier
    productionBackpressure: 130
    // pause minting above this many live infection forms
  },
  combatForm: {
    selfReviveChance: 0.25,
    // stated
    selfReviveWindowSec: 10,
    // stated
    damageMax: 100,
    // maxed = permanently useless
    reviveIntegrityFrac: 0.5,
    reanimateIntegrityFrac: 0.6,
    reanimateTimeSec: 2
  },
  flamethrower: { fuelUnits: 100, dps: 50, fuelPerSec: 2, fuelPerCorpse: 1, burnNodeSec: 12 },
  door: { lockedFraction: 0.25 },
  // PLACEHOLDER, per-run graph mutation (visible variety run to run)
  vent: { blockedFraction: 0.3 },
  // PLACEHOLDER, per-run
  ambush: { firstStrikeMult: 3 },
  // PLACEHOLDER, applies to both sides
  motionTracker: { rangeHops: 1 },
  // reveals a moving infection form in a vent
  power: { unstableFraction: 0.2 },
  // PLACEHOLDER
  sensor: {
    losHops: 1,
    // same node + adjacent through open/unlocked standard edge
    hearingHops: 2,
    // footsteps/screams
    gunfireHops: 3
    // gunfire carries further
  },
  radio: {
    marineCallReliability: 0.5,
    // MASTER DIAL — marine coordination efficiency / difficulty lever
    // (0.95 = intact comms; the portal event damaged them.
    //  Raise it and the response snuffs most outbreaks —
    //  re-tuned down after adding the top-deck garrison,
    //  armed officers, and lower-deck maintenance crew.)
    civilianCallReliability: 0.35,
    // PLACEHOLDER
    callFadeSec: 60
  },
  rampage: {
    threshold: 1.5,
    // local flood:human strength ratio to flip aggressive
    localReserve: 1.5,
    // min local flood mass in a region before it rampages
    marineCap: 0.6
    // if believed marine strength in the region exceeds this, hide instead
  },
  swarm: {
    overwhelmRatio: 2,
    // weighted flood:shooter ratio at which grabs work THROUGH gunfire
    killRatio: 2,
    // muster:squad ratio to spring on an isolated marine squad
    musterHops: 3,
    // how far the hive gathers forms for a squad-wipe
    maxMusterForms: 45,
    // a wave this size flattens any line — stop waiting
    isolationHops: 3,
    // no friendly squad within this = isolated
    reserveForms: 8,
    // only trade forms for marines while this pool (or a carrier) remains
    escortPer: 3
    // 1 combat-form escort per ~3 infection forms in a pack
  },
  lastStand: {
    marineFraction: 0.3,
    // when squad marines drop below this of start, fall back
    hearChance: 0.65,
    // per-survivor roll to hear the fallback call
    officerJoinChance: 0.6,
    // stay-put officers who step out into the corridor line
    armedJoinFraction: 0.8
    // armed civilians who stand WITH the marines on the line
  },
  armory: {
    selfArmChance: 0.25,
    // chance an unarmed civilian runs for the armory once panic breaks out
    stock: 16,
    // rifles racked — first come, first served (once unsealed)
    // THE SEALED RESERVE (user rule): the armory starts LOCKED. Inside: the
    // racked rifles + grenade crates, one flamethrower, and an ODST squad
    // standing by with more armor than a line marine. The seal releases only
    // when the ship is genuinely losing — a strong hive AND a thin line.
    odstSquadSize: 5,
    odstHp: 85,
    // vs line marine 45 — hardened ODST plate
    unlockCombatForms: 20,
    // flood must field at least this many combat forms
    unlockMarinesLeft: 10
    // and the line squads must be down to this few
  },
  belief: {
    decayRatePerSec: 0.1,
    // MASTER DIAL (lambda) — smart vs unfair
    predictionQuality: 0.7,
    // MASTER DIAL (q) — how well it guesses your route
    humanSpeedHops: 0.35
    // hops/s for predicted spread radius
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
    riskBase: 1,
    militaryValue: 1.5,
    values: {
      // targetValue weights for grabs
      helpless: 3,
      corpse: 1.2,
      // convert corpse -> combat form (plus militaryValue)
      civilianNoRadio: 2.5,
      civilianRadio: 2,
      armed: 1.2,
      distressPenalty: 2.5
      // grab likely to trigger a call
    },
    searchMinPool: 45,
    // won't spend forms searching below this pool
    openingSweepMargin: 12
    // sec of safety margin vs estimated sweep ETA
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
    marine: {
      hp: 45,
      dps: 14,
      stompPerSec: 0.4,
      // stomp = infection-form kills/s
      gun: { rof: 3, dmg: 6.5, accNear: 0.72, accFar: 0.32 }
    },
    armed: {
      hp: 30,
      dps: 9,
      stompPerSec: 0.2,
      gun: { rof: 2, dmg: 6.5, accNear: 0.7, accFar: 0.3 }
    },
    civilian: { hp: 20 },
    // HALO-DURABLE (user rule: difficulty lives in damage/health and hive
    // tactics, not starting headcount — and the player gets NO special
    // multiplier): ~1/3 of an MA5 mag on target drops one, a marine PAIR now
    // trades a man for a form more often than not, 3 marines win clean.
    // swing: 18 dmg / 0.9 s = the same 20 dps sustained, delivered in chunks.
    combatForm: {
      hp: 90,
      dps: 20,
      hpJitter: 0.18,
      // spawn hp varies ±18%
      swing: { dmg: 18, cooldownSec: 0.9 }
    },
    hostWeaponDps: 5,
    // nominal (shaft pools / hive estimates)
    // the armed MINORITY of forms spray the host's weapon one-handed and
    // wildly (lore) — suppressive noise more than marksmanship
    hostGun: { rof: 2, dmg: 5, accNear: 0.35, accFar: 0.15 },
    carrierHp: 40,
    infectionGrabSec: 6,
    // armed crew/marines: a LIVE host turns slightly
    // FASTER than a corpse (user rule) — the flesh cooperates
    civilianGrabSec: 7,
    // burrowing in takes real seconds now (user note)
    corpseConvertSec: 7,
    // infection form + body -> combat form
    // POINT-BLANK RISK (user rule): letting an infection form get this close
    // is always a mistake, marine or not — it lunges for the latch
    lungeRiskM: 3,
    latchDps: 4,
    // the embedded spike works while it burrows (user: pods
    // were too unlethal to marines)
    grabPins: true,
    // a grabbed target is held in place (can't flee)
    armedBraveryStrength: 0.9,
    // fights only if visible flood strength below this
    // REAL SPACE COMBAT (user note): claws and grabs land at arm's reach,
    // measured in actual meters — not "anywhere inside the same room record"
    meleeRangeM: 2.2,
    // combat-form claws/lunge reach
    grabRangeM: 1.4,
    // an infection form must actually reach the body (a short leap latches)
    stompRangeM: 4,
    // boots/point-fire kill skittering forms only up close
    podAccMult: 0.45,
    // a skittering pod is a small fast rifle target
    rifleFalloffM: 12,
    // full NPC rifle effect inside this — beyond it, a dark
    rifleFarFactor: 0.5
    // ship and a sprinting target halve effective fire
  },
  // FLOOD DARKNESS (user rule): a room the flood holds ALONE goes dark at
  // 60 s (biomass overgrows the fixtures) and fills with spore fog at
  // 120 s. Humans fight in it by flashlight — accuracy suffers, more in
  // fog. If no flood is present the room recovers at double speed.
  darkness: {
    soloDarkSec: 60,
    fogSec: 120,
    maxHoldSec: 150,
    darkAccMult: 0.75,
    // flashlight fighting
    fogAccMult: 0.8,
    // stacked on top in spore fog (net ~0.6)
    fogViewM: 8
    // how far the player's flashlight cuts into the fog
  },
  marineDoctrine: {
    firstSweepDelaySec: 10,
    // muster time before the crash sweep launches (§5.3)
    officers: 4,
    // officer civilians who stay put in Officer Country
    bridgeOfficers: 3,
    // captain + officers who never leave the bridge
    sweepDwellSec: 15,
    // min pause at each cleared room (+ jitter)
    sweepDwellJitterSec: 10
  },
  civilian: {
    fleeHearingHops: 1,
    // only bolt from trouble this close (was ship-wide)
    workerFraction: 0.2,
    // fraction still working the ship — they move with purpose
    workMoveChancePerSec: 0.03
    // a work trip every ~30s, not constant lapping; halved once the outbreak is known
  },
  speed: {
    // multipliers on movement.baseMps (relative ratios are user-set)
    civilian: 1,
    civilianFlee: 1.5,
    armed: 1,
    marine: 1,
    // pods SKITTER (user note: they were too slow) — quicker than a walking
    // human even off the lunge, matching how the games read
    infection: 1.35,
    combatForm: 1.25,
    carrier: 0.55,
    // lore: a slow, blundering waddle — people underestimate it
    drag: 0.5,
    // lore: combat forms don't jog at prey — they SPRINT, as fast as a
    // sprinting Spartan (~6.3 m/s at this multiplier). Real-space combat
    // made the approach cost real seconds of incoming fire, so the charge
    // must be game-fast or every open-room assault dies crossing the floor.
    chargeMult: 3.6,
    // lore: an infection form closing on a host doesn't walk — it SKITTERS
    // and leaps (~4.4 m/s). Must comfortably beat civilianFlee or no grab
    // ever lands in open space (grabs now require physical reach).
    infectionLunge: 3.5
  },
  // REAL DISTANCES (user note): the map is laid out in meters and travel
  // time = distance / speed — the foundation for the navigable 3D map.
  // baseMps is a purposeful walk; the speed multipliers above scale it.
  movement: {
    baseMps: 1.4,
    // human purposeful walk
    doorDelaySec: { hatch: 0.8, blastdoor: 2.5, lift: 0, ladder: 0 },
    liftSec: 10,
    // call + ride, distance-independent
    ladderClimbMps: 1.2,
    // vertical speed on ladder runs — a deck in ~3.5s;
    // with one-body-at-a-time ladders (user rule), the
    // old 0.5 crawl turned every queue into minutes
    // FLOOD DUCT HIGHWAY (user: vent travel ~3x faster) — the ducts are the
    // flood's fast private network; a form rips through them far quicker than
    // it crosses open floor, which is what makes them worth using.
    shaftMps: 2.1,
    // crawl pace in cross-deck ducts (was 0.7)
    ventMps: 1.65,
    // infection-form pace in same-deck ducting (was 0.55)
    crawlWindingFactor: 1.35
    // shafts/vents are never straight lines
  },
  // command path (companion spec §0/§3.4). In single-player the producer
  // stamps orders this many ticks ahead; the same knob is net.inputDelayTicks
  // (~3-5) once lockstep transport slots underneath the queue.
  net: { inputDelayTicks: 1 },
  command: { linkReliability: 0.9 },
  // per-deck order delivery (companion §2.4), tunable
  // CLASSIC-HALO RAGDOLL (cosmetic; physics/ragdoll.js). Feel knobs for the
  // death flop — the whole block is render-only and never touches sim state
  // (docs/DESIGN-RAPIER-STACK.md's "ragdoll flourish lives outside the
  // authoritative set"). Tune here, not in the solver. Distances in meters,
  // speeds m/s, damping per-second, angles radians.
  ragdoll: {
    enabled: true,
    maxActive: 48,
    // concurrent physics ragdolls; deaths past this render as static corpses
    gravity: 22,
    // matches the game's frag-throw gravity, so a flop reads at the same weight
    bodyLen: 1.7,
    bodyRadius: 0.3,
    comY: 0.9,
    // torso capsule + centre of mass (feet at y=0);
    // a flat body rests with its centreline ~radius off
    // the deck, matching the legacy corpse's 0.25 lift
    restitution: 0.18,
    // bodies thud, maybe bounce once — not rubber
    groundFriction: 6,
    groundAngFriction: 5,
    // slide/tumble bleed-off while touching the deck
    linDamp: 0.1,
    angDamp: 1,
    // air damping (per second, exp)
    maxLinSpeed: 24,
    maxAngSpeed: 28,
    // hard clamps — the stability backstop
    sleepLin: 0.16,
    sleepAng: 0.4,
    sleepSec: 0.5,
    // settle → freeze the resting pose
    inertia: 1.2,
    // scalar rotational inertia for contact response
    driftLimitM: 1.5,
    // if the sim moves the body this far (dragged/relocated), drop the ragdoll
    // launch off the killing blow (PLAN-ANIM-POLISH "hit-direction deaths")
    launchSpeed: 4.2,
    launchUp: 2.6,
    spin: 7,
    chargeBonus: 3.5,
    // a charging/leaping form that dies carries its momentum into the tumble
    corpseKnockSpeed: 3,
    corpseHostileRangeM: 4,
    // a human corpse is thrown off the nearest hostile
    // limbs (the floppy flail about the JMS joint pivots)
    limbGrav: 9,
    limbBind: 2.5,
    limbDamp: 3,
    limbLimit: 1.4,
    limbKick: 6,
    subDt: 8333333e-9,
    maxSubSteps: 8,
    dtCap: 0.05
    // internal fixed step (1/120) — stable + deterministic
  }
};
function cloneParams() {
  return JSON.parse(JSON.stringify(PARAMS));
}

// shared/agentBuffer.js
var FACTION = {
  CIVILIAN: 0,
  ARMED: 1,
  MARINE: 2,
  INFECTION: 3,
  COMBAT: 4,
  CARRIER: 5,
  CORPSE: 6
};
var FLAG = {
  HAS_RADIO: 1 << 0,
  FLINCH: 1 << 12,
  // just-hurt: renderers jerk the body
  HELPLESS: 1 << 1,
  REANIMATABLE: 1 << 2,
  DOWNED: 1 << 3,
  PANICKED: 1 << 4,
  EXPOSED: 1 << 5,
  // infection form currently transiting a vent
  AMBUSH: 1 << 6,
  // stationary in a shaft ambush corner
  BURNED: 1 << 7,
  // damage >= 100 (permanently out of the economy)
  FLAMER: 1 << 8,
  // carries the ship's one flamethrower
  IN_SHAFT: 1 << 9,
  ARMED_HOST: 1 << 10,
  // combat form whose host carried a weapon (render with gun)
  CHARGING: 1 << 11,
  // combat form in a lunge/charge burst (render sprint)
  LEAPING: 1 << 13,
  // combat form airborne mid-leap (render lifted off the floor)
  ODST: 1 << 14
  // armory-reserve ODST (render in black plate)
};
var CLIP = { IDLE: 0, WALK: 1, RUN: 2, ATTACK: 3, DEATH: 4, WRITHE: 5 };
var AgentBuffer = class {
  constructor(capacity = 512) {
    this.capacity = capacity;
    this.count = 0;
    this.id = new Int32Array(capacity);
    this.faction = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
    this.nodeId = new Int16Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.hoverY = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.prevZ = new Float32Array(capacity);
    this.headingR = new Float32Array(capacity);
    this.animClip = new Uint8Array(capacity);
    this.animTime = new Float32Array(capacity);
    this.integrity = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.tint = new Uint32Array(capacity);
    this.flags = new Uint16Array(capacity);
  }
  beginTick() {
    this.prevX.set(this.posX);
    this.prevY.set(this.posY);
    this.prevZ.set(this.posZ);
  }
};

// shared/geometry.js
var DECK_H = 4.2;
var CLEAR_H = 3;
var HANGAR_LIFT = 4;
function elevOf(deck) {
  return (5 - deck) * DECK_H + (deck < 5 ? HANGAR_LIFT : 0);
}
var TALL_ROLES = ["hangar", "large", "battery", "magazine", "stairwell", "vehicles"];
function isTallRoom(node) {
  return node.type === "open" || (node.roles ?? []).some((r) => TALL_ROLES.includes(r));
}
function clearHeightOf(node) {
  if (!isTallRoom(node)) return CLEAR_H;
  const gap = elevOf(node.deck - 1) - elevOf(node.deck);
  return Math.min(gap - 0.3, 8);
}

// sim/graph.js
var LAYER = { STD: "std", SHAFT: "shaft", VENT: "vent" };
var EDGE_PREFIX = { hatch: "H", blastdoor: "B", lift: "L", ladder: "K", stairwell: "T" };
var ShipGraph = class {
  constructor(data) {
    this.data = data;
    const S = data.sizeScale ?? 1;
    this.nodes = data.nodes.map((n, i) => ({
      ...n,
      idx: i,
      w: (n.w ?? 10) * S,
      d: (n.d ?? 8) * S
    }));
    this.byId = new Map(this.nodes.map((n) => [n.id, n.idx]));
    this.n = this.nodes.length;
    const idx = (id) => {
      const i = this.byId.get(id);
      if (i === void 0) throw new Error(`unknown node ${id}`);
      return i;
    };
    this.edges = data.edges.map((e, i) => ({
      i,
      a: idx(e.a),
      b: idx(e.b),
      type: e.type,
      lockable: e.lockable,
      locked: false,
      kind: LAYER.STD,
      // strict connection designation for the map (user note): H=hatch,
      // B=blastdoor, L=lift, K=ladder, numbered in load order
      label: EDGE_PREFIX[e.type] + "-" + String(i + 1).padStart(2, "0")
    }));
    this.shafts = data.maintShafts.map((e, i) => ({
      i,
      a: idx(e.a),
      b: idx(e.b),
      ambushCorners: e.ambushCorners,
      kind: LAYER.SHAFT,
      label: "S-" + String(i + 1).padStart(2, "0")
      // occupants lying in wait per end: corner key `${shaftIdx}:${endNode}`
    }));
    this.vents = data.vents.map((e, i) => ({
      i,
      a: idx(e.a),
      b: idx(e.b),
      breakable: e.breakable,
      blocked: false,
      kind: LAYER.VENT,
      label: "V-" + String(i + 1).padStart(2, "0")
    }));
    {
      const seen = new Set(this.vents.map((v) => `${Math.min(v.a, v.b)}:${Math.max(v.a, v.b)}`));
      const addVent = (a, b) => {
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        if (seen.has(key) || a === b) return;
        seen.add(key);
        this.vents.push({
          i: this.vents.length,
          a,
          b,
          breakable: true,
          blocked: false,
          kind: LAYER.VENT,
          label: "V-" + String(this.vents.length + 1).padStart(2, "0")
        });
      };
      for (const e of this.edges) {
        if (this.nodes[e.a].deck !== this.nodes[e.b].deck) continue;
        addVent(e.a, e.b);
      }
      const byDeck = {};
      for (const n of this.nodes) (byDeck[n.deck] ??= []).push(n);
      for (const deck of Object.keys(byDeck)) {
        const rooms = byDeck[deck];
        for (const n of rooms) {
          const near = rooms.filter((m) => m.idx !== n.idx).map((m) => ({ m, d: (m.x - n.x) ** 2 + (m.y - n.y) ** 2 })).sort((p, q) => p.d - q.d || p.m.idx - q.m.idx).slice(0, 1);
          for (const { m } of near) addVent(n.idx, m.idx);
        }
      }
    }
    this.adj = { std: this._buildAdj(this.edges), shaft: this._buildAdj(this.shafts), vent: this._buildAdj(this.vents) };
    for (const v of this.vents) {
      v.doorEdge = (this.adj.std[v.a] ?? []).find((e) => e.to === v.b)?.link ?? null;
    }
    this.stairwells = this.edges.filter((e) => e.type === "stairwell").map((e) => {
      const upper = this.nodes[e.a].deck < this.nodes[e.b].deck ? e.a : e.b;
      const lower = upper === e.a ? e.b : e.a;
      return { upper, lower, edge: e };
    });
    this.unpowered = new Uint8Array(this.n);
    this.breachNode = -1;
    this.burningUntil = new Float64Array(this.n);
    this.trailNode = new Float32Array(this.n);
    this.trailEdge = new Float32Array(this.edges.length);
    this._layout();
  }
  _buildAdj(links) {
    const adj = Array.from({ length: this.n }, () => []);
    for (const l of links) {
      adj[l.a].push({ to: l.b, link: l });
      adj[l.b].push({ to: l.a, link: l });
    }
    return adj;
  }
  _layout() {
    const S = this.data?.sizeScale ?? 1;
    const LEN = (this.data?.playableLengthM ?? 220) * S;
    this.deckHeightM = this.data?.deckHeightM ?? 4.2;
    const BAND = 88 * S, TOP = 18, PADX = 12;
    this.lengthM = LEN;
    this.height = TOP + 5 * BAND + 8;
    this.deckBands = [];
    const stdNeighbors = (idx) => this.edges.filter((e) => e.a === idx || e.b === idx).map((e) => this.nodes[e.a === idx ? e.b : e.a]);
    for (let d = 1; d <= 5; d++) {
      const band = this.nodes.filter((n) => n.deck === d);
      const y0 = TOP + (d - 1) * BAND;
      this.deckBands.push({ y0, y1: y0 + BAND });
      const yC = y0 + BAND / 2;
      for (const n of band) {
        n.w = n.w ?? 10;
        n.d = n.d ?? 8;
        n.row = n.row ?? 1;
      }
      const spine = band.filter((n) => n.row === 0).sort((a, b) => a.foreAft - b.foreAft);
      for (const n of spine) {
        n.x = PADX + n.foreAft * LEN;
        n.y = yC;
      }
      for (let i = 1; i < spine.length; i++) {
        const prev = spine[i - 1], n = spine[i];
        const connected = stdNeighbors(n.idx).some((m) => m.idx === prev.idx);
        if (connected) n.x = prev.x + prev.w / 2 + n.w / 2;
        else n.x = Math.max(n.x, prev.x + prev.w / 2 + n.w / 2 + 3);
      }
      for (const tier of [1, 2, 3]) {
        for (const side of [1, -1]) {
          const row = band.filter((n) => n.row === side * tier).sort((a, b) => a.foreAft - b.foreAft);
          for (const n of row) {
            const parents = stdNeighbors(n.idx).filter((m) => m.deck === d && (tier === 1 ? m.row === 0 : Math.abs(m.row) === tier - 1));
            const p = parents[0] ?? spine[0];
            n.x = PADX + n.foreAft * LEN;
            if (p) {
              n.y = p.y + side * (p.d / 2 + n.d / 2);
              const lo = p.x - p.w / 2 + Math.min(n.w, p.w) / 2;
              const hi = p.x + p.w / 2 - Math.min(n.w, p.w) / 2;
              n.x = Math.max(lo, Math.min(hi, n.x));
            } else {
              n.y = yC + side * (4 + n.d / 2);
            }
          }
          row.sort((a, b) => a.x - b.x);
          for (let i = 1; i < row.length; i++) {
            const minX = row[i - 1].x + row[i - 1].w / 2 + row[i].w / 2;
            if (row[i].x < minX) row[i].x = minX;
          }
        }
      }
      for (const n of band) n.r = Math.max(2, Math.min(n.w, n.d) / 2 - 1);
    }
    this.width = Math.max(...this.nodes.map((n) => n.x + n.w / 2)) + PADX;
    const measure = (l) => {
      const a = this.nodes[l.a], b = this.nodes[l.b];
      if (a.deck === b.deck) {
        const eps = 0.6, minOv = 1.4;
        const xOv = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const yOv = Math.min(a.y + a.d / 2, b.y + b.d / 2) - Math.max(a.y - a.d / 2, b.y - b.d / 2);
        const yGap = Math.abs(a.y - b.y) - (a.d + b.d) / 2;
        const xGap = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
        let door = null;
        if (xOv >= minOv && Math.abs(yGap) < eps) {
          const wallY = a.y < b.y ? (a.y + a.d / 2 + b.y - b.d / 2) / 2 : (a.y - a.d / 2 + b.y + b.d / 2) / 2;
          const cx = (Math.max(a.x - a.w / 2, b.x - b.w / 2) + Math.min(a.x + a.w / 2, b.x + b.w / 2)) / 2;
          door = { x: cx, y: wallY };
        } else if (yOv >= minOv && Math.abs(xGap) < eps) {
          const wallX = a.x < b.x ? (a.x + a.w / 2 + b.x - b.w / 2) / 2 : (a.x - a.w / 2 + b.x + b.w / 2) / 2;
          const cy = (Math.max(a.y - a.d / 2, b.y - b.d / 2) + Math.min(a.y + a.d / 2, b.y + b.d / 2)) / 2;
          door = { x: wallX, y: cy };
        }
        if (door) {
          l.door = door;
          l.doorA = { ...door };
          l.doorB = { ...door };
          l.shared = true;
          const lenA = Math.max(0.5, Math.hypot(a.x - door.x, a.y - door.y));
          const lenB = Math.max(0.5, Math.hypot(b.x - door.x, b.y - door.y));
          l.flipT = lenA / (lenA + lenB);
          l.horizM = Math.max(2, lenA + lenB);
          l.vertM = 0;
          if (l.kind === "vent") {
            const horizWall = xOv >= minOv && Math.abs(yGap) < eps;
            const dir = l.i % 2 ? 1 : -1;
            if (horizWall) {
              const lo = Math.max(a.x - a.w / 2, b.x - b.w / 2) + 0.7;
              const hi = Math.min(a.x + a.w / 2, b.x + b.w / 2) - 0.7;
              const gx = Math.max(lo, Math.min(hi, door.x + Math.max(1.9, (hi - lo) * 0.3) * dir));
              l.doorA = { x: gx, y: door.y };
              l.doorB = { x: gx, y: door.y };
            } else {
              const lo = Math.max(a.y - a.d / 2, b.y - b.d / 2) + 0.7;
              const hi = Math.min(a.y + a.d / 2, b.y + b.d / 2) - 0.7;
              const gy = Math.max(lo, Math.min(hi, door.y + Math.max(1.9, (hi - lo) * 0.3) * dir));
              l.doorA = { x: door.x, y: gy };
              l.doorB = { x: door.x, y: gy };
            }
          }
        } else {
          const dx = b.x - a.x, dy = b.y - a.y;
          const L = Math.max(1e-3, Math.hypot(dx, dy));
          const ux = Math.abs(dx) / L, uy = Math.abs(dy) / L;
          const exitA = Math.min(ux > 1e-6 ? a.w / 2 / ux : Infinity, uy > 1e-6 ? a.d / 2 / uy : Infinity);
          const entryB = Math.min(ux > 1e-6 ? b.w / 2 / ux : Infinity, uy > 1e-6 ? b.d / 2 / uy : Infinity);
          let doorDist = (exitA + (L - entryB)) / 2;
          if (exitA + entryB >= L) doorDist = L / 2;
          doorDist = Math.min(L - 0.5, Math.max(0.5, doorDist));
          l.door = { x: a.x + dx / L * doorDist, y: a.y + dy / L * doorDist };
          const tA = Math.min(exitA, doorDist), tB = Math.max(L - entryB, doorDist);
          l.doorA = { x: a.x + dx / L * tA, y: a.y + dy / L * tA };
          l.doorB = { x: a.x + dx / L * tB, y: a.y + dy / L * tB };
          l.shared = false;
          const lenA = doorDist, lenB = L - doorDist;
          l.flipT = lenA / (lenA + lenB);
          l.horizM = Math.max(3, lenA + lenB);
          l.vertM = 0;
        }
      } else {
        l.horizM = Math.max(2, Math.abs(a.x - b.x));
        l.vertM = Math.abs(a.deck - b.deck) * this.deckHeightM;
        l.flipT = 0.5;
      }
    };
    for (const l of this.edges) measure(l);
    for (const l of this.shafts) measure(l);
    for (const l of this.vents) measure(l);
    this.avgStdLenM = this.edges.reduce((s, l) => s + l.horizM + l.vertM, 0) / this.edges.length;
  }
  node(i) {
    return this.nodes[i];
  }
  hasRole(i, role) {
    return this.nodes[i].roles.includes(role);
  }
  nodesWithRole(role) {
    return this.nodes.filter((n) => n.roles.includes(role)).map((n) => n.idx);
  }
  // Neighbors across a set of layers, filtered by a passability predicate.
  // passFn(link, from, to) -> bool. Layers: array of 'std'|'shaft'|'vent'.
  *neighbors(nodeIdx, layers, passFn) {
    for (const layer of layers) {
      for (const { to, link } of this.adj[layer][nodeIdx]) {
        if (!passFn || passFn(link, nodeIdx, to)) yield { to, link, layer };
      }
    }
  }
  // Multi-source BFS flow field toward `targets`. Returns { dist, next, nextLink }
  // where next[i] is the neighbor one hop closer to a target (-1 if unreachable).
  flowField(targets, layers, passFn) {
    const dist = new Int32Array(this.n).fill(-1);
    const next = new Int32Array(this.n).fill(-1);
    const nextLink = new Array(this.n).fill(null);
    const q = [];
    for (const t of targets) if (dist[t] === -1) {
      dist[t] = 0;
      q.push(t);
    }
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      for (const { to, link } of this.neighbors(cur, layers, passFn)) {
        if (dist[to] === -1) {
          dist[to] = dist[cur] + 1;
          next[to] = cur;
          nextLink[to] = link;
          q.push(to);
        }
      }
    }
    return { dist, next, nextLink, targets: new Set(targets) };
  }
  // Reference walking seconds to cross a link (faction-agnostic, 1.4 m/s).
  // Pathing MUST weigh real time, not hops: with authored distances a
  // "one-hop" 48 m maintenance shaft is a 90-second crawl that hop-count
  // BFS preferred over two 15-second corridor hops — which marched whole
  // packs into shafts and read as "the flood spawns and never moves".
  linkCost(l) {
    const run = l.horizM + l.vertM;
    if (l.kind === "shaft") return run * 1.35 / 2.1 * 0.92;
    if (l.kind === "vent") {
      if (l.doorEdge && !l.doorEdge.locked) return this.linkCost(l.doorEdge) + 1;
      return run * 1.35 / 1.65 * 0.82;
    }
    if (l.type === "lift") return l.horizM / 1.4 + 10;
    if (l.type === "ladder") return 1 + l.vertM / 1.2;
    return run / 1.4 + (l.type === "blastdoor" ? 2.5 : 0.8);
  }
  // Fastest path from -> to as [{to, link, layer}] steps, or null.
  // Dijkstra over real travel time (deterministic: min-cost, ties by index).
  path(from, to, layers, passFn) {
    if (from === to) return [];
    const n = this.n;
    const dist = new Float64Array(n).fill(Infinity);
    const done = new Uint8Array(n);
    const next = new Int32Array(n).fill(-1);
    const nextLink = new Array(n).fill(null);
    dist[to] = 0;
    for (; ; ) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
      if (u === -1) break;
      done[u] = 1;
      if (u === from) break;
      for (const { to: v, link } of this.neighbors(u, layers, passFn)) {
        const c = dist[u] + this.linkCost(link);
        if (c < dist[v] - 1e-9) {
          dist[v] = c;
          next[v] = u;
          nextLink[v] = link;
        }
      }
    }
    if (!Number.isFinite(dist[from])) return null;
    const steps = [];
    let cur = from;
    while (cur !== to) {
      const nxt = next[cur];
      const link = nextLink[cur];
      if (nxt === -1) return null;
      steps.push({ to: nxt, link, layer: link.kind });
      cur = nxt;
    }
    return steps;
  }
  hops(from, to, layers, passFn) {
    const ff = this.flowField([to], layers, passFn);
    return ff.dist[from];
  }
  // All nodes within `maxHops` of `from`.
  nodesWithin(from, maxHops, layers, passFn) {
    const dist = new Int32Array(this.n).fill(-1);
    dist[from] = 0;
    const q = [from];
    const out = [from];
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      if (dist[cur] >= maxHops) continue;
      for (const { to, link } of this.neighbors(cur, layers, passFn)) {
        if (dist[to] === -1) {
          dist[to] = dist[cur] + 1;
          q.push(to);
          out.push(to);
        }
      }
    }
    return out;
  }
};
function humanPass(link) {
  return link.kind === LAYER.STD ? !link.locked : false;
}
var marinePass = humanPass;

// sim/data/ship.js
var SHIP = {
  playableLengthM: 220,
  // pressurized crew section, bow datum at x=0
  sizeScale: 1.6,
  // global hull scale
  deckHeightM: 4.2,
  nodes: [
    // ================= DECK 1 · COMMAND (dorsal superstructure) =========
    { id: "d1corr", name: "Command Corridor", deck: 1, foreAft: 0.36, type: "corridor", capacity: 6, w: 40, d: 4, row: 0, roles: ["artery"] },
    { id: "cic", name: "CIC", deck: 1, foreAft: 0.3, type: "room", capacity: 8, w: 18, d: 12, row: 1, roles: ["command", "comms"] },
    { id: "signal", name: "Signal Room", deck: 1, foreAft: 0.44, type: "room", capacity: 5, w: 12, d: 9, row: 1, roles: ["systems", "comms"] },
    { id: "officer", name: "Officer Country", deck: 1, foreAft: 0.34, type: "room", capacity: 8, w: 16, d: 11, row: -1, roles: ["quarters", "soft"] },
    { id: "wardroom", name: "Wardroom", deck: 1, foreAft: 0.46, type: "room", capacity: 8, w: 12, d: 9, row: -1, roles: ["quarters", "soft"] },
    // dorsal flanks: the bridge sits behind CIC atop the spine; sensor suites
    // outboard give the command deck real beam
    { id: "bridge", name: "Bridge", deck: 1, foreAft: 0.3, type: "room", capacity: 6, w: 16, d: 11, row: 2, roles: ["command"] },
    { id: "sensorPort", name: "Sensor Suite Port", deck: 1, foreAft: 0.44, type: "room", capacity: 5, w: 14, d: 10, row: 2, roles: ["systems"] },
    { id: "sensorStbd", name: "Sensor Suite Stbd", deck: 1, foreAft: 0.36, type: "room", capacity: 5, w: 14, d: 10, row: -2, roles: ["systems"] },
    // ================= DECK 2 · HABITATION (wide living deck) ===========
    { id: "d2corrF", name: "Hab Corridor Fore", deck: 2, foreAft: 0.32, type: "corridor", capacity: 8, w: 40, d: 4, row: 0, roles: ["artery"] },
    { id: "d2corrA", name: "Hab Corridor Aft", deck: 2, foreAft: 0.6, type: "corridor", capacity: 8, w: 44, d: 4, row: 0, roles: ["artery"] },
    { id: "crewA", name: "Crew Quarters A", deck: 2, foreAft: 0.28, type: "room", capacity: 14, w: 18, d: 12, row: 1, roles: ["quarters", "soft"] },
    { id: "mess", name: "Mess Hall", deck: 2, foreAft: 0.38, type: "open", capacity: 28, w: 20, d: 14, row: 1, roles: ["soft"] },
    { id: "galley", name: "Galley", deck: 2, foreAft: 0.46, type: "room", capacity: 8, w: 12, d: 9, row: 1, roles: ["soft"] },
    { id: "crewB", name: "Crew Quarters B", deck: 2, foreAft: 0.3, type: "room", capacity: 14, w: 18, d: 12, row: -1, roles: ["quarters", "soft"] },
    { id: "d2store", name: "Deck 2 Stores", deck: 2, foreAft: 0.44, type: "room", capacity: 5, w: 8, d: 7, row: -1, roles: ["cargo"] },
    { id: "rec", name: "Rec Room", deck: 2, foreAft: 0.56, type: "room", capacity: 12, w: 14, d: 11, row: 1, roles: ["soft"] },
    { id: "chapel", name: "Chapel", deck: 2, foreAft: 0.68, type: "room", capacity: 6, w: 10, d: 9, row: 1, roles: ["soft"] },
    { id: "medbay", name: "Medbay", deck: 2, foreAft: 0.54, type: "room", capacity: 12, w: 16, d: 12, row: -1, roles: ["medbay", "helpless", "corpse_cache", "soft"] },
    { id: "cryo", name: "Cryo Bay", deck: 2, foreAft: 0.64, type: "room", capacity: 10, w: 16, d: 12, row: -1, roles: ["cryo", "corpse_cache"] },
    { id: "brig", name: "Brig", deck: 2, foreAft: 0.72, type: "room", capacity: 4, w: 9, d: 7, row: -1, roles: ["brig", "helpless"] },
    // wide berthing halls + support fill out the beam
    { id: "berthPort", name: "Port Berthing", deck: 2, foreAft: 0.36, type: "open", capacity: 24, w: 32, d: 15, row: 2, roles: ["quarters", "soft"] },
    { id: "berthStbd", name: "Starboard Berthing", deck: 2, foreAft: 0.34, type: "open", capacity: 24, w: 32, d: 15, row: -2, roles: ["quarters", "soft"] },
    { id: "lounge", name: "Wardroom Lounge", deck: 2, foreAft: 0.58, type: "room", capacity: 12, w: 16, d: 12, row: 2, roles: ["soft"] },
    { id: "hydro", name: "Hydroponics", deck: 2, foreAft: 0.62, type: "room", capacity: 8, w: 16, d: 12, row: -2, roles: ["soft", "systems"] },
    // ================= DECK 3 · OPERATIONS / WEAPONS (widest) ===========
    // The fore + mid main-corridor sections were MERGED into one spinal
    // corridor (user: "remove the [Main Corridor Fore] corridor" — it clustered
    // every game). It now runs the whole bow-to-mid length with the gym /
    // security / armory hanging off it, and the two deck-2 descents land at
    // OPPOSITE ends (fore ladder, aft lift) so arrivals spread down its length
    // instead of knotting at one landing.
    { id: "corrM", name: "Main Corridor", deck: 3, foreAft: 0.43, type: "corridor", capacity: 16, w: 74, d: 4, row: 0, roles: ["artery"] },
    { id: "corrA", name: "Main Corridor Aft", deck: 3, foreAft: 0.74, type: "corridor", capacity: 10, w: 44, d: 4, row: 0, roles: ["artery"] },
    { id: "gym", name: "Gymnasium", deck: 3, foreAft: 0.28, type: "room", capacity: 8, w: 12, d: 9, row: 1, roles: ["soft"] },
    { id: "security", name: "Security", deck: 3, foreAft: 0.36, type: "room", capacity: 10, w: 12, d: 10, row: 1, roles: ["marines"] },
    { id: "stores3", name: "Deck 3 Stores", deck: 3, foreAft: 0.44, type: "room", capacity: 5, w: 8, d: 6, row: 1, roles: ["cargo"] },
    { id: "armory", name: "Armory", deck: 3, foreAft: 0.38, type: "room", capacity: 8, w: 12, d: 9, row: -1, roles: ["armory", "armed"] },
    { id: "fireCtl", name: "Fire Control", deck: 3, foreAft: 0.46, type: "room", capacity: 6, w: 10, d: 8, row: -1, roles: ["systems", "marines"] },
    { id: "barracks", name: "Barracks", deck: 3, foreAft: 0.58, type: "room", capacity: 16, w: 20, d: 13, row: -1, roles: ["marines", "odst"] },
    { id: "workshop", name: "Workshop", deck: 3, foreAft: 0.66, type: "room", capacity: 8, w: 12, d: 9, row: 1, roles: ["maintenance"] },
    { id: "podPort", name: "Lifepod Bay Port", deck: 3, foreAft: 0.8, type: "room", capacity: 10, w: 14, d: 10, row: 1, roles: ["lifepods", "objective"] },
    { id: "podStbd", name: "Lifepod Bay Stbd", deck: 3, foreAft: 0.8, type: "room", capacity: 10, w: 14, d: 10, row: -1, roles: ["lifepods", "objective"] },
    // THE FLANK WEAPON BATTERIES (user: substantial battery areas on both
    // flanks). Long point-defence halls at the outboard tier, with the Archer
    // missile pods and their magazines at the very edge of the hull.
    { id: "batteryPort", name: "Port 50mm Battery", deck: 3, foreAft: 0.4, type: "open", capacity: 18, w: 42, d: 16, row: 2, roles: ["battery", "armed", "large", "crash_candidate"] },
    { id: "batteryStbd", name: "Starboard 50mm Battery", deck: 3, foreAft: 0.42, type: "open", capacity: 18, w: 42, d: 16, row: -2, roles: ["battery", "armed", "large", "crash_candidate"] },
    { id: "archerPort", name: "Port Archer Pods", deck: 3, foreAft: 0.4, type: "open", capacity: 12, w: 40, d: 12, row: 3, roles: ["magazine", "hazard", "large", "crash_candidate"] },
    { id: "archerStbd", name: "Starboard Archer Pods", deck: 3, foreAft: 0.42, type: "open", capacity: 12, w: 40, d: 12, row: -3, roles: ["magazine", "hazard", "large", "crash_candidate"] },
    // ================= DECK 4 · ENGINEERING (above the hangar) ==========
    { id: "engCorrF", name: "Engineering Corridor", deck: 4, foreAft: 0.44, type: "corridor", capacity: 8, w: 24, d: 4, row: 0, roles: ["artery"] },
    // GRAND STAIRWELL (user's Pillar-of-Autumn room): a big hall on the
    // engineering deck, entered from the corridor by a normal doorway, with a
    // central switchback staircase descending into the hangar bay below. Sits
    // directly over the hangar; walk all the way around the stairs on both
    // levels. foreAft is flush-snapped aft of engCorrF so it lands over the
    // hangar — do NOT edge it into the spine chain other than that one hatch.
    { id: "grandStair", name: "Grand Stairwell", deck: 4, foreAft: 0.57, type: "open", capacity: 18, w: 26, d: 22, row: 0, roles: ["stairwell", "large"] },
    { id: "engCorrA", name: "Aft Engineering Corridor", deck: 4, foreAft: 0.7, type: "corridor", capacity: 8, w: 24, d: 4, row: 0, roles: ["artery"] },
    { id: "lifesup", name: "Life Support", deck: 4, foreAft: 0.4, type: "room", capacity: 8, w: 14, d: 11, row: 1, roles: ["systems"] },
    { id: "pumps", name: "Coolant Plant", deck: 4, foreAft: 0.42, type: "room", capacity: 5, w: 12, d: 9, row: -1, roles: ["systems", "maintenance"] },
    { id: "d5store", name: "Engineering Stores", deck: 4, foreAft: 0.66, type: "room", capacity: 5, w: 8, d: 6, row: 1, roles: ["cargo"] },
    { id: "workshopA", name: "Aft Workshop", deck: 4, foreAft: 0.68, type: "room", capacity: 8, w: 12, d: 9, row: 1, roles: ["maintenance"] },
    { id: "eng", name: "Main Engineering", deck: 4, foreAft: 0.74, type: "room", capacity: 12, w: 20, d: 14, row: -1, roles: ["engineering", "power"] },
    { id: "reactor", name: "Reactor", deck: 4, foreAft: 0.82, type: "room", capacity: 8, w: 16, d: 14, row: -2, roles: ["power", "hazard"] },
    // (removed 'Maintenance Aft' — a dead-end corridor hanging off Engineering
    //  that went nowhere; user: "just remove it, it's a hallway to nowhere")
    // MAC capacitor banks + coolant loops fill the engineering flanks
    { id: "capPort", name: "Port Capacitor Bank", deck: 4, foreAft: 0.42, type: "open", capacity: 10, w: 30, d: 14, row: 2, roles: ["power", "hazard", "large", "crash_candidate"] },
    { id: "capStbd", name: "Starboard Capacitor Bank", deck: 4, foreAft: 0.44, type: "open", capacity: 10, w: 30, d: 14, row: -2, roles: ["power", "hazard", "large", "crash_candidate"] },
    { id: "coolant", name: "Coolant Loop", deck: 4, foreAft: 0.72, type: "room", capacity: 6, w: 16, d: 12, row: 2, roles: ["systems"] },
    // ================= DECK 5 · FLIGHT / HANGAR (lowest, ventral) =======
    { id: "maintF", name: "Maintenance Fore", deck: 5, foreAft: 0.44, type: "corridor", capacity: 6, w: 20, d: 4, row: 0, roles: ["maintenance"] },
    { id: "pumpRoom", name: "Pump Room", deck: 5, foreAft: 0.4, type: "room", capacity: 5, w: 8, d: 7, row: 1, roles: ["maintenance", "systems"] },
    { id: "hangar", name: "Hangar Fore", deck: 5, foreAft: 0.58, type: "open", capacity: 30, w: 34, d: 22, row: 0, roles: ["hangar", "large", "crash_candidate"] },
    { id: "hangarCtl", name: "Hangar Control", deck: 5, foreAft: 0.52, type: "room", capacity: 5, w: 8, d: 6, row: 1, roles: ["systems"] },
    { id: "hangarA", name: "Hangar Aft", deck: 5, foreAft: 0.68, type: "open", capacity: 30, w: 34, d: 22, row: 0, roles: ["hangar", "large", "crash_candidate"] },
    { id: "vehicle", name: "Vehicle Bay", deck: 5, foreAft: 0.78, type: "open", capacity: 24, w: 28, d: 18, row: 0, roles: ["vehicles", "crash_candidate"] },
    { id: "d4store", name: "Flight Stores", deck: 5, foreAft: 0.74, type: "room", capacity: 5, w: 8, d: 6, row: 1, roles: ["cargo"] },
    { id: "cargo1", name: "Cargo Hold 1", deck: 5, foreAft: 0.86, type: "open", capacity: 18, w: 22, d: 16, row: 0, roles: ["cargo", "crash_candidate"] },
    { id: "cargo2", name: "Cargo Hold 2", deck: 5, foreAft: 0.94, type: "open", capacity: 18, w: 22, d: 16, row: 0, roles: ["cargo", "crash_candidate"] },
    // launch bays + ordnance flank the hangar (the deck reads wide, not a slot)
    { id: "launchPort", name: "Port Launch Bay", deck: 5, foreAft: 0.6, type: "open", capacity: 16, w: 26, d: 13, row: 1, roles: ["hangar", "large"] },
    { id: "launchStbd", name: "Starboard Launch Bay", deck: 5, foreAft: 0.6, type: "open", capacity: 16, w: 26, d: 13, row: -1, roles: ["hangar", "large"] },
    { id: "ordnance", name: "Ordnance Store", deck: 5, foreAft: 0.72, type: "room", capacity: 8, w: 12, d: 10, row: -1, roles: ["magazine", "cargo"] }
  ],
  edges: [
    // ---- deck 1 · command ----
    { a: "bridge", b: "cic", type: "hatch", lockable: false },
    { a: "cic", b: "d1corr", type: "blastdoor", lockable: true },
    { a: "d1corr", b: "signal", type: "hatch", lockable: true },
    { a: "d1corr", b: "officer", type: "hatch", lockable: true },
    { a: "d1corr", b: "wardroom", type: "hatch", lockable: true },
    { a: "signal", b: "sensorPort", type: "hatch", lockable: true },
    { a: "officer", b: "sensorStbd", type: "hatch", lockable: true },
    { a: "d1corr", b: "d2corrF", type: "lift", lockable: false },
    // deck1->2
    // ---- deck 2 · habitation ----
    { a: "d2corrF", b: "crewA", type: "hatch", lockable: true },
    { a: "d2corrF", b: "mess", type: "hatch", lockable: true },
    { a: "d2corrF", b: "galley", type: "hatch", lockable: true },
    { a: "mess", b: "galley", type: "hatch", lockable: true },
    { a: "d2corrF", b: "crewB", type: "hatch", lockable: true },
    { a: "d2corrF", b: "d2store", type: "hatch", lockable: true },
    { a: "d2corrF", b: "d2corrA", type: "hatch", lockable: true },
    { a: "mess", b: "berthPort", type: "hatch", lockable: true },
    { a: "crewB", b: "berthStbd", type: "hatch", lockable: true },
    { a: "d2corrA", b: "rec", type: "hatch", lockable: true },
    { a: "d2corrA", b: "chapel", type: "hatch", lockable: true },
    { a: "d2corrA", b: "medbay", type: "hatch", lockable: true },
    { a: "d2corrA", b: "cryo", type: "hatch", lockable: true },
    { a: "d2corrA", b: "brig", type: "blastdoor", lockable: true },
    { a: "rec", b: "lounge", type: "hatch", lockable: true },
    { a: "cryo", b: "hydro", type: "hatch", lockable: true },
    { a: "d2corrF", b: "corrM", type: "ladder", lockable: false },
    // deck2->3 (fore landing)
    { a: "d2corrA", b: "corrM", type: "lift", lockable: false },
    // deck2->3 (aft landing)
    // ---- deck 3 · operations / weapons ----
    { a: "corrM", b: "gym", type: "hatch", lockable: true },
    { a: "corrM", b: "security", type: "hatch", lockable: true },
    { a: "corrM", b: "armory", type: "blastdoor", lockable: true },
    { a: "corrM", b: "stores3", type: "hatch", lockable: true },
    { a: "corrM", b: "fireCtl", type: "hatch", lockable: true },
    { a: "corrM", b: "barracks", type: "hatch", lockable: true },
    { a: "corrM", b: "corrA", type: "hatch", lockable: true },
    { a: "corrA", b: "workshop", type: "hatch", lockable: true },
    { a: "corrA", b: "podPort", type: "blastdoor", lockable: true },
    { a: "corrA", b: "podStbd", type: "blastdoor", lockable: true },
    { a: "security", b: "batteryPort", type: "hatch", lockable: true },
    { a: "barracks", b: "batteryStbd", type: "hatch", lockable: true },
    { a: "batteryPort", b: "archerPort", type: "hatch", lockable: true },
    { a: "batteryStbd", b: "archerStbd", type: "hatch", lockable: true },
    { a: "corrM", b: "engCorrF", type: "lift", lockable: false },
    // deck3->4
    // ---- deck 4 · engineering ----
    { a: "engCorrF", b: "grandStair", type: "hatch", lockable: false },
    { a: "grandStair", b: "engCorrA", type: "hatch", lockable: false },
    { a: "engCorrF", b: "lifesup", type: "hatch", lockable: true },
    { a: "engCorrF", b: "pumps", type: "hatch", lockable: true },
    { a: "engCorrA", b: "d5store", type: "hatch", lockable: true },
    { a: "engCorrA", b: "workshopA", type: "hatch", lockable: true },
    { a: "engCorrA", b: "eng", type: "hatch", lockable: true },
    { a: "eng", b: "reactor", type: "blastdoor", lockable: true },
    { a: "lifesup", b: "capPort", type: "hatch", lockable: true },
    { a: "pumps", b: "capStbd", type: "hatch", lockable: true },
    { a: "workshopA", b: "coolant", type: "hatch", lockable: true },
    { a: "grandStair", b: "hangar", type: "stairwell", lockable: false },
    // deck4->5 walk-down
    { a: "engCorrA", b: "hangarA", type: "ladder", lockable: false },
    // deck4->5
    // ---- deck 5 · flight / hangar ----
    { a: "maintF", b: "hangar", type: "hatch", lockable: true },
    { a: "maintF", b: "pumpRoom", type: "hatch", lockable: true },
    { a: "hangar", b: "hangarCtl", type: "hatch", lockable: true },
    { a: "hangar", b: "hangarA", type: "hatch", lockable: false },
    { a: "hangarA", b: "hangarCtl", type: "hatch", lockable: true },
    { a: "hangar", b: "launchPort", type: "hatch", lockable: true },
    { a: "hangar", b: "launchStbd", type: "hatch", lockable: true },
    { a: "hangarA", b: "vehicle", type: "hatch", lockable: true },
    { a: "hangarA", b: "ordnance", type: "hatch", lockable: true },
    { a: "vehicle", b: "d4store", type: "hatch", lockable: true },
    { a: "vehicle", b: "cargo1", type: "hatch", lockable: true },
    { a: "cargo1", b: "cargo2", type: "hatch", lockable: true }
  ],
  // MAINTENANCE SHAFTS — enclosed cross-deck crawls the flood uses (infection
  // AND combat forms; humans never). Cross-deck risers give the outbreak
  // private vertical routes so the visible ladders/lifts aren't the only way
  // up, plus a few same-deck bypass crawls.
  maintShafts: [
    // cross-deck risers (deck to deck)
    { a: "officer", b: "crewB", ambushCorners: 1 },
    // 1 <-> 2
    { a: "signal", b: "d2store", ambushCorners: 1 },
    // 1 <-> 2
    { a: "crewA", b: "gym", ambushCorners: 1 },
    // 2 <-> 3
    { a: "cryo", b: "fireCtl", ambushCorners: 1 },
    // 2 <-> 3
    { a: "barracks", b: "engCorrF", ambushCorners: 2 },
    // 3 <-> 4
    { a: "workshop", b: "workshopA", ambushCorners: 1 },
    // 3 <-> 4
    { a: "batteryStbd", b: "capStbd", ambushCorners: 1 },
    // 3 <-> 4 (flank riser)
    { a: "eng", b: "cargo1", ambushCorners: 1 },
    // 4 <-> 5
    { a: "reactor", b: "hangarA", ambushCorners: 1 },
    // 4 <-> 5
    { a: "coolant", b: "vehicle", ambushCorners: 1 },
    // 4 <-> 5
    // same-deck bypass crawls so no single deck is a hard choke
    { a: "hangar", b: "maintF", ambushCorners: 2 },
    { a: "hangar", b: "cargo1", ambushCorners: 2 },
    { a: "batteryPort", b: "podPort", ambushCorners: 2 },
    { a: "corrM", b: "corrA", ambushCorners: 2 },
    { a: "lifesup", b: "eng", ambushCorners: 2 }
  ],
  // Authored ducts supplement the auto-generated net (graph.js ducts every
  // same-deck doorway + each room to its nearest same-deck neighbour). These
  // add a few cross-room runs the doors don't already cover.
  vents: [
    { a: "medbay", b: "cryo", breakable: true },
    { a: "brig", b: "cryo", breakable: true },
    { a: "armory", b: "fireCtl", breakable: true },
    { a: "batteryPort", b: "archerPort", breakable: true },
    { a: "batteryStbd", b: "archerStbd", breakable: true },
    { a: "cargo1", b: "cargo2", breakable: true },
    { a: "ordnance", b: "cargo1", breakable: true },
    { a: "eng", b: "reactor", breakable: true },
    { a: "capPort", b: "lifesup", breakable: true },
    { a: "berthPort", b: "lounge", breakable: true },
    { a: "hangar", b: "hangarA", breakable: true }
  ]
};

// sim/init.js
var STATE = {
  // shared across factions where meaningful
  IDLE: 0,
  ALERT: 1,
  FLEE: 2,
  HIDE: 3,
  COWER: 4,
  FIGHT: 5,
  MOVE: 6,
  DEAD: 7,
  DOWNED: 8,
  GRABBING: 9,
  AMBUSHING: 10,
  INCUBATING: 11
};
var NEXT_ID = 1;
function makeAgent(kind, node, graph) {
  const nd = graph.node(node);
  return {
    id: NEXT_ID++,
    faction: kind,
    state: STATE.IDLE,
    node,
    x: nd.x,
    y: nd.y,
    deck: nd.deck,
    heading: 0,
    // movement along an edge: null when parked in a node
    move: null,
    // { to, link, layer, t (0..1), travelSec }
    path: [],
    // remaining [{to, link, layer}]
    hp: 1,
    maxHp: 1,
    damage: 0,
    hasRadio: false,
    helpless: false,
    panicked: false,
    stayPut: false,
    garrison: false,
    worker: false,
    captain: false,
    fleeSteps: 0,
    downed: false,
    reviveAt: -1,
    // self-revive schedule (sim seconds)
    squad: -1,
    flamer: false,
    fuel: 0,
    task: null,
    // hive task for flood forms
    hideTimer: 0,
    alertTimer: 0,
    grabTimer: 0,
    calledOut: false,
    held: 0,
    // infection forms gestating INSIDE a carrier
    mintTimer: 0,
    lastMovedAt: 0,
    // for ambush "stationary" checks
    animTime: 0,
    dragging: -1,
    // corpse id being dragged
    hoverY: 0,
    leaping: false,
    leapDist0: 0,
    leapTX: 0,
    leapTY: 0,
    // Flood leap arc (sim.js _spatialSteer)
    chargeTargetId: -1,
    // sticky spatial-charge target for LOS pursuit (sim.js)
    followNode: -1,
    // escort: last node re-pathed toward (humans.js)
    firePost: null
    // [x,y] firing stance a shooter holds in a firefight (sim.js _firingSlot)
  };
}
function resetIds() {
  NEXT_ID = 1;
}
function initRun(seed, rng, P) {
  resetIds();
  const graph = new ShipGraph(SHIP);
  for (const e of graph.edges) {
    if (e.lockable && rng.chance(P.door.lockedFraction)) e.locked = true;
  }
  repairHumanConnectivity(graph);
  assertDeckConnectivity(graph);
  for (const v of graph.vents) {
    if (rng.chance(P.vent.blockedFraction)) v.blocked = true;
  }
  for (const cacheIdx of graph.nodesWithRole("corpse_cache")) {
    const reachable = [...graph.neighbors(
      cacheIdx,
      ["std", "vent"],
      (l) => l.kind === "std" ? !l.locked : !l.blocked
    )];
    if (reachable.length === 0) {
      const vents = graph.adj.vent[cacheIdx];
      if (vents.length) vents[0].link.blocked = false;
      else {
        const es = graph.adj.std[cacheIdx];
        if (es.length) es[0].link.locked = false;
      }
    }
  }
  for (const n of graph.nodes) {
    if (rng.chance(P.power.unstableFraction)) graph.unpowered[n.idx] = 1;
  }
  const breach = rng.pick(graph.nodesWithRole("crash_candidate"));
  graph.breachNode = breach;
  graph.unpowered[breach] = 1;
  const breachDanger = /* @__PURE__ */ new Set([breach]);
  for (const { to } of graph.neighbors(breach, ["std"], null)) breachDanger.add(to);
  const agents = [];
  const M = P.marines;
  const squads = [];
  {
    const marinePostIds = [
      "barracks",
      // deck 3 — the barracks (squad 0 musters here; holds the flamethrower)
      "security",
      // deck 3 — the security office
      "grandStair",
      // deck 4 — holding the engineering stairwell down to the hangar
      "crewB",
      // deck 2 — a squad berthed forward with the crew
      "fireCtl",
      // deck 3 — the fire-control watch
      "launchStbd"
      // deck 5 — a posting on the flight deck
      // (the armory is NOT a line post — it starts SEALED with the ODST
      // reserve inside; see the sealed-reserve block below)
    ];
    const marinePosts = marinePostIds.map((id) => graph.byId.get(id));
    for (let si = 0; si < M.squads; si++) {
      let pi = si % marinePosts.length;
      for (let g = 0; g < marinePosts.length && breachDanger.has(marinePosts[pi]); g++) pi = (pi + 1) % marinePosts.length;
      const node = marinePosts[pi];
      const squad = { id: si, members: [], objective: null, morale: 1, respondingTo: null, phase1: false };
      for (let m = 0; m < M.squadSize; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = rng.chance(P.crew.radio.marine);
        a.squad = si;
        scatterInRoom(a, graph.node(node), rng);
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    }
    const flamerSquad = squads[0];
    if (flamerSquad) {
      const holder = agents.find((a) => a.id === flamerSquad.members[0]);
      holder.flamer = true;
      holder.fuel = P.flamethrower.fuelUnits;
    }
  }
  {
    const armoryIdx = graph.byId.get("armory");
    const door = graph.edges.find((e) => (e.a === armoryIdx || e.b === armoryIdx) && e.lockable);
    if (door) door.locked = true;
    const squad = {
      id: squads.length,
      members: [],
      objective: null,
      morale: 1,
      respondingTo: null,
      phase1: true,
      odst: true
      // phase1 done — no opening sweep
    };
    for (let m = 0; m < P.armory.odstSquadSize; m++) {
      const a = makeAgent(FACTION.MARINE, armoryIdx, graph);
      a.hp = a.maxHp = P.armory.odstHp;
      a.hasRadio = true;
      a.squad = squad.id;
      a.odst = true;
      scatterInRoom(a, graph.node(armoryIdx), rng);
      squad.members.push(a.id);
      agents.push(a);
    }
    const lead = agents.find((x) => x.id === squad.members[0]);
    lead.flamer = true;
    lead.fuel = P.flamethrower.fuelUnits;
    squads.push(squad);
  }
  {
    const post = graph.byId.get("d1corr");
    for (let i = 0; i < M.garrison; i++) {
      const a = makeAgent(FACTION.MARINE, post, graph);
      a.hp = a.maxHp = P.combat.marine.hp;
      a.hasRadio = true;
      a.squad = -1;
      a.garrison = true;
      agents.push(a);
    }
  }
  {
    const route = [
      "d1corr",
      "d2corrF",
      "mess",
      "d2corrA",
      "corrM",
      "corrA",
      "engCorrF",
      "eng",
      "engCorrA",
      "hangarA",
      "hangar",
      "vehicle",
      "cargo1",
      "hangarA",
      "engCorrA",
      "corrM"
    ].map((id) => graph.byId.get(id));
    for (let p = 0; p < M.patrols; p++) {
      let leg = Math.floor(p * route.length / Math.max(1, M.patrols));
      for (let guard = 0; guard < route.length && breachDanger.has(route[leg]); guard++) {
        leg = (leg + 1) % route.length;
      }
      const node = route[leg];
      const squad = {
        id: squads.length,
        members: [],
        objective: null,
        morale: 1,
        respondingTo: null,
        phase1: false,
        patrol: true,
        patrolNo: p + 1,
        route,
        leg
      };
      for (let m = 0; m < M.patrolSize; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = true;
        a.squad = squad.id;
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    }
  }
  {
    const corridors = graph.nodes.filter((n) => n.type === "corridor" && n.idx !== breach).map((n) => n.idx);
    const softRooms = graph.nodes.filter((n) => n.roles.includes("soft") && n.idx !== breach).map((n) => n.idx);
    const battleStations = graph.nodes.filter((n) => (n.roles.includes("battery") || n.roles.includes("marines") && n.roles.includes("systems")) && n.idx !== breach).map((n) => n.idx);
    const armedCount = P.crew.armedCrew;
    for (let i = 0; i < armedCount; i++) {
      const r = i / armedCount;
      const node = r < 0.55 && battleStations.length ? rng.pick(battleStations) : r < 0.75 ? rng.pick(corridors) : rng.pick(softRooms);
      const a = makeAgent(FACTION.ARMED, node, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.hasRadio = rng.chance(P.crew.radio.armed);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }
  }
  {
    const softIdx = graph.nodes.filter((n) => n.roles.includes("soft") || n.roles.includes("quarters")).map((n) => n.idx);
    const habitable = graph.nodes.filter((n) => n.type !== "corridor" && n.idx !== graph.breachNode && !n.roles.includes("command") && !n.roles.includes("hazard") && !n.roles.includes("power") && !n.roles.includes("hangar") && !n.roles.includes("vehicles") && !n.roles.includes("armory") && !n.roles.includes("battery") && !n.roles.includes("magazine"));
    const spreadPool = [];
    for (const n of habitable) {
      const copies = Math.max(1, Math.round(n.w * n.d / 12));
      for (let k = 0; k < copies; k++) spreadPool.push(n.idx);
    }
    const soft = softIdx;
    const brig = graph.byId.get("brig");
    const medbay = graph.byId.get("medbay");
    const officerPost = graph.byId.get("officer");
    for (let i = 0; i < P.crew.brigPrisoners; i++) {
      const a = makeAgent(FACTION.CIVILIAN, brig, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = true;
      agents.push(a);
    }
    for (let i = 0; i < P.crew.medbayWounded; i++) {
      const a = makeAgent(FACTION.CIVILIAN, medbay, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = true;
      agents.push(a);
    }
    for (let i = 0; i < P.marineDoctrine.officers; i++) {
      const a = makeAgent(FACTION.ARMED, officerPost, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.stayPut = true;
      a.hasRadio = true;
      agents.push(a);
    }
    for (let i = 0; i < P.crew.civilians; i++) {
      const node = rng.chance(0.55) ? rng.pick(soft) : rng.pick(spreadPool);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.worker = rng.chance(P.civilian.workerFraction);
      a.hasRadio = a.worker || rng.chance(P.crew.radio.civilian);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }
    const bridge = graph.byId.get("bridge");
    for (let i = 0; i < P.marineDoctrine.bridgeOfficers; i++) {
      const a = makeAgent(FACTION.ARMED, bridge, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.stayPut = true;
      a.captain = i === 0;
      a.hasRadio = true;
      agents.push(a);
    }
    const repairRooms = graph.nodes.filter((n) => n.deck >= 4 && n.idx !== breach && ["power", "engineering", "systems", "maintenance"].some((r) => n.roles.includes(r))).map((n) => n.idx);
    const lowerNodes = graph.nodes.filter((n) => n.deck >= 4 && n.idx !== breach).map((n) => n.idx);
    for (let i = 0; i < P.crew.lowerMaintenance; i++) {
      const node = repairRooms.length ? repairRooms[i % repairRooms.length] : rng.pick(lowerNodes);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.worker = true;
      a.lowerDecks = true;
      a.hasRadio = rng.chance(P.crew.radio.civilian);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }
  }
  const corpses = [];
  {
    const weights = graph.nodes.map((n) => {
      let w = n.w * n.d * rng.range(0.8, 1.2);
      if (n.roles.includes("corpse_cache")) w *= 1.8;
      if (n.type === "corridor") w *= 0.45;
      return w;
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < P.bodies.eventCorpses; i++) {
      let r = rng.next() * totalW, node = graph.n - 1;
      for (let k = 0; k < weights.length; k++) {
        r -= weights[k];
        if (r <= 0) {
          node = k;
          break;
        }
      }
      const c = makeAgent(FACTION.CORPSE, node, graph);
      c.state = STATE.DEAD;
      c.hp = 0;
      c.damage = 0;
      c.wasArmed = rng.chance(P.bodies.armedFraction);
      scatterInRoom(c, graph.node(node), rng);
      corpses.push(c);
    }
  }
  const flood = [];
  for (let i = 0; i < P.flood.initialInfectionForms; i++) {
    const a = makeAgent(FACTION.INFECTION, breach, graph);
    a.hp = a.maxHp = 1;
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCarriers; i++) {
    const a = makeAgent(FACTION.CARRIER, breach, graph);
    a.hp = a.maxHp = P.combat.carrierHp;
    a.state = STATE.INCUBATING;
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCombatForms; i++) {
    const a = makeAgent(FACTION.COMBAT, breach, graph);
    a.hp = a.maxHp = P.combat.combatForm.hp * (1 + rng.range(-P.combat.combatForm.hpJitter, P.combat.combatForm.hpJitter));
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  const freshDead = Math.max(2, Math.round(P.bodies.breachCorpses * rng.range(0.5, 1.6)));
  for (let i = 0; i < freshDead; i++) {
    const c = makeAgent(FACTION.CORPSE, breach, graph);
    c.state = STATE.DEAD;
    c.hp = 0;
    c.damage = 0;
    c.wasArmed = rng.chance(P.bodies.armedFraction);
    scatterInRoom(c, graph.node(breach), rng);
    corpses.push(c);
  }
  return { graph, agents: [...agents, ...corpses, ...flood], squads, breach };
}
function scatterInRoom(a, nd, rng) {
  a.x = nd.x + rng.range(-0.5, 0.5) * Math.max(2, nd.w - 2.5);
  a.y = nd.y + rng.range(-0.5, 0.5) * Math.max(2, nd.d - 2.5);
}
function repairHumanConnectivity(graph) {
  const start = graph.byId.get("bridge");
  for (let guard = 0; guard < 64; guard++) {
    const ff = graph.flowField([start], ["std"], humanPass);
    const stranded = [];
    for (let i = 0; i < graph.n; i++) if (ff.dist[i] === -1) stranded.push(i);
    if (!stranded.length) return;
    let fixed = false;
    for (const e of graph.edges) {
      if (!e.locked) continue;
      const aIn = ff.dist[e.a] !== -1, bIn = ff.dist[e.b] !== -1;
      if (aIn !== bIn) {
        e.locked = false;
        fixed = true;
        break;
      }
    }
    if (!fixed) return;
  }
}
function assertDeckConnectivity(graph) {
  const start = graph.byId.get("bridge");
  const ff = graph.flowField([start], ["std"], humanPass);
  const decksSeen = /* @__PURE__ */ new Set();
  for (let i = 0; i < graph.n; i++) if (ff.dist[i] !== -1) decksSeen.add(graph.node(i).deck);
  if (decksSeen.size < 5) {
    console.warn(`[charon] deck connectivity broken: only decks {${[...decksSeen].sort().join(",")}} reachable from the bridge — check for a lockable cross-deck edge`);
  }
}

// sim/humans.js
function updateHumansTick(sim2, dt) {
  for (const a of sim2.agents) {
    if (a.dead || a.hp <= 0) continue;
    if (a.isPlayer) continue;
    if (a.fallbackNode !== void 0 && a.node !== a.fallbackNode && (a.faction !== FACTION.MARINE || !a.garrison && sim2.squads[a.squad]?.broken) && a.state !== STATE.FIGHT && !a.move && !a.path.length && floodThreatVisible(sim2, a) === 0) {
      if (sim2.setPathTo(a, a.fallbackNode, ["std"], humanPass)) a.state = STATE.MOVE;
    } else if (a.armingUp !== void 0 && a.fallbackNode === void 0 && a.faction === FACTION.CIVILIAN && a.state !== STATE.FIGHT && !a.move && !a.path.length && floodThreatVisible(sim2, a) === 0) {
      if (a.node === a.armingUp) {
        const took = (sim2.armoryStock ?? 0) > 0;
        a.armingUp = void 0;
        if (took) {
          sim2.armoryStock--;
          a.faction = FACTION.ARMED;
          a.hp = a.maxHp = Math.max(a.hp, sim2.P.combat.armed.hp);
          a.hasRadio = true;
          sim2.log("combat", `a civilian arms up at the armory (${sim2.armoryStock} rifles left)`);
        }
      } else if (sim2.setPathTo(a, a.armingUp, ["std"], humanPass)) a.state = STATE.MOVE;
      else a.armingUp = void 0;
    }
    if (a.faction === FACTION.CIVILIAN) updateCivilian(sim2, a, dt);
    else if (a.faction === FACTION.ARMED) updateArmed(sim2, a, dt);
    else if (a.faction === FACTION.MARINE) updateMarineTick(sim2, a, dt);
  }
}
function floodThreatVisible(sim2, a) {
  let s = 0;
  for (const n of sim2.visibleNodes(a.pnode ?? a.node)) s += sim2.floodStrengthAt(n);
  return s;
}
function maybeDistressCall(sim2, a, reliability) {
  if (a.calledOut || !a.hasRadio) return;
  a.calledOut = true;
  if (sim2.rng.chance(reliability)) sim2.emitCall(a);
}
function updateCivilian(sim2, a, dt) {
  const P = sim2.P;
  if (a.helpless) {
    if (floodThreatVisible(sim2, a) > 0) maybeDistressCall(sim2, a, P.radio.civilianCallReliability);
    return;
  }
  const threat = floodThreatVisible(sim2, a);
  if (threat > 0 && a.panicked) a.panicUntil = sim2.t + 8;
  if (a.panicked && sim2.t > (a.panicUntil ?? 0) && threat === 0) a.panicked = false;
  if (!a.panicked && !a.stayPut) {
    for (const n of sim2.visibleNodes(a.node)) {
      if (sim2.panickedAt(n) && sim2.rng.chance(0.06 * dt * 15)) {
        a.panicked = true;
        a.panicUntil = sim2.t + 8;
        if (a.state === STATE.IDLE || a.state === STATE.HIDE) {
          a.state = STATE.FLEE;
          a.hideTimer = 0;
          a.fleeSteps = 0;
        }
        break;
      }
    }
  }
  const floodHere = sim2.floodStrengthAt(a.node) > 0;
  switch (a.state) {
    case STATE.IDLE:
    case STATE.HIDE:
      if (threat > 0) {
        a.state = STATE.ALERT;
        a.alertTimer = floodHere ? 0 : 0.3;
        if (sim2.rng.chance(floodHere ? 0.9 : 0.4)) {
          a.panicked = true;
          a.panicUntil = sim2.t + 8;
        }
        maybeDistressCall(sim2, a, P.radio.civilianCallReliability * (floodHere ? 0.25 : 1));
      } else if (a.worker && a.fallbackNode === void 0 && !sim2.lastStand && !a.move && !a.path.length && sim2.rng.chance(P.civilian.workMoveChancePerSec * (sim2.floodKnown ? 0.5 : 1) * dt)) {
        workerRelocate(sim2, a);
      }
      break;
    case STATE.ALERT:
      a.alertTimer -= dt;
      if (a.alertTimer <= 0) {
        a.state = a.stayPut ? STATE.COWER : STATE.FLEE;
        a.hideTimer = 0;
        a.fleeSteps = 0;
      }
      break;
    case STATE.FLEE: {
      if (!a.move && !a.path.length) {
        const next = fleeStep(sim2, a);
        if (next === -1) {
          a.state = STATE.COWER;
          break;
        }
        if (next === null) {
          a.state = STATE.HIDE;
          a.panicked = false;
          break;
        }
        sim2.setPath(a, [next]);
        a.lastFledFrom = a.node;
        a.fleeSteps = (a.fleeSteps || 0) + 1;
      }
      if (threat === 0 && !a.move && !a.path.length) {
        a.hideTimer += dt;
        if (a.hideTimer > 1.5 || a.fleeSteps >= 3) {
          a.state = STATE.HIDE;
          a.panicked = false;
        }
      } else a.hideTimer = 0;
      break;
    }
    case STATE.COWER:
      if (floodHere) maybeDistressCall(sim2, a, P.radio.civilianCallReliability);
      if (threat === 0) a.state = STATE.HIDE;
      else if (!floodHere && fleeStep(sim2, a) !== -1) {
        a.state = STATE.FLEE;
        a.fleeSteps = 0;
      }
      break;
    case STATE.MOVE:
      if (threat > 0) {
        a.path = [];
        a.state = STATE.ALERT;
        a.alertTimer = floodHere ? 0 : 0.3;
        if (sim2.rng.chance(floodHere ? 0.9 : 0.4)) a.panicked = true;
        maybeDistressCall(sim2, a, P.radio.civilianCallReliability * (floodHere ? 0.25 : 1));
      } else if (!a.move && !a.path.length) a.state = STATE.IDLE;
      break;
  }
}
function workerRelocate(sim2, a) {
  if (!a._workNodes) {
    a._workNodes = sim2.graph.nodes.filter((n) => ["systems", "power", "engineering", "medbay", "armed", "quarters", "soft", "command"].some((r) => n.roles.includes(r)) || a.lowerDecks && ["maintenance", "cargo", "vehicles", "hangar"].some((r) => n.roles.includes(r))).filter((n) => !a.lowerDecks || n.deck >= 4).map((n) => n.idx);
  }
  const dest = sim2.rng.pick(a._workNodes);
  if (dest === a.node) return;
  if (sim2.floodStrengthAt(dest) > 0) return;
  const path = sim2.graph.path(a.node, dest, ["std"], humanPass);
  if (path && !path.some((s) => sim2.floodStrengthAt(s.to) > 0)) {
    a.path = path;
    a.state = STATE.MOVE;
  }
}
function fleeStep(sim2, a) {
  const floodHere = sim2.floodStrengthAt(a.node) > 0;
  const safe = [];
  for (const { to } of sim2.graph.neighbors(a.node, ["std"], humanPass)) {
    if (sim2.floodStrengthAt(to) > 0) continue;
    if (to === a.lastFledFrom && !floodHere) continue;
    safe.push(to);
  }
  if (!safe.length) return floodHere ? -1 : null;
  if (a.panicked && sim2.rng.chance(0.4)) return sim2.rng.pick(safe);
  let best = null, bestScore = Infinity;
  for (const to of safe) {
    const score = sim2.influence.floodStr[to] * 4 + sim2.rng.range(0, 0.3);
    if (score < bestScore) {
      bestScore = score;
      best = to;
    }
  }
  if (!floodHere) {
    const here = sim2.influence.floodStr[a.node] * 4;
    if (bestScore >= here - 0.4) return null;
  }
  return best;
}
function updateArmed(sim2, a, dt) {
  const P = sim2.P;
  const threatHere = sim2.floodStrengthAt(a.pnode ?? a.node);
  const threat = floodThreatVisible(sim2, a);
  const cornered = fleeStep(sim2, a) === -1 && threat > 0;
  if (a.state === STATE.FIGHT) {
    if (threat === 0) a.state = a.stayPut ? STATE.IDLE : STATE.FLEE;
    else if (!a.stayPut && threatHere > P.combat.armedBraveryStrength && !cornered) a.state = STATE.FLEE;
    return;
  }
  if (threat > 0) {
    maybeDistressCall(sim2, a, P.radio.civilianCallReliability * 1.5);
    if (a.stayPut || cornered || threatHere <= P.combat.armedBraveryStrength) {
      a.state = STATE.FIGHT;
      a.path = [];
      a.move = null;
      return;
    }
  }
  updateCivilian(sim2, a, dt);
}
function updateMarineTick(sim2, a, dt) {
  if (a.garrison) {
    a.state = sim2.floodStrengthAt(a.pnode ?? a.node) > 0 ? STATE.FIGHT : STATE.IDLE;
    a.path = [];
    a.move = null;
    if (a.state === STATE.FIGHT && a.hasRadio && sim2.tickCount % 60 === 0) sim2.emitCall(a);
    return;
  }
  if (a.odst && sim2.armoryLocked) {
    a.state = sim2.floodStrengthAt(a.pnode ?? a.node) > 0 ? STATE.FIGHT : STATE.IDLE;
    a.path = [];
    a.move = null;
    return;
  }
  const squad = sim2.squads[a.squad];
  if (!squad || squad.broken) {
    updateArmed(sim2, a, dt);
    return;
  }
  const threat = floodThreatVisible(sim2, a);
  if (sim2.floodStrengthAt(a.pnode ?? a.node) > 0) {
    a.state = STATE.FIGHT;
    a.path = [];
    a.move = null;
    return;
  }
  if (a.state === STATE.FIGHT) a.state = STATE.MOVE;
  if (sim2.graph.node(a.node).type !== "corridor" && threat === 0) sim2.sweptAt[a.node] = sim2.t;
  if (threat > 0) {
    squad.contactNode = nearestThreatNode(sim2, a);
    squad.contactTick = sim2.tickCount;
    sim2.floodKnown = true;
    if (a.hasRadio && !squad.calledContact) {
      squad.calledContact = true;
      if (sim2.rng.chance(sim2.P.radio.marineCallReliability)) sim2.emitCall(a);
    }
  }
  if (squad.order?.kind === "order:escort") {
    a.closeFollow = false;
    const lead = sim2.byId.get(squad.order.entityId);
    if (lead && !lead.dead) {
      if (lead.node !== a.node && !a.move && lead.node !== a.followNode) {
        a.followNode = lead.node;
        a.path = [];
        if (sim2.setPathTo(a, lead.node, ["std"], humanPass)) a.state = STATE.MOVE;
      } else if (lead.node === a.node && !a.move && sim2.floodStrengthAt(a.node) === 0) {
        const mi = Math.max(0, squad.members.indexOf(a.id));
        const ang = lead.heading + Math.PI + (mi % 3 - 1) * 0.6;
        const off = 1.5 + (mi >= 3 ? 1 : 0);
        const tx = lead.x + Math.cos(ang) * off, ty = lead.y + Math.sin(ang) * off;
        const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
        if (d > 0.5) {
          const mps = d > 7 ? 8 : d > 3 ? 6 : 2.6;
          const step = Math.min(d, mps * dt);
          a.x += dx / d * step;
          a.y += dy / d * step;
          sim2._clampToRoom(a, sim2.graph.node(a.node));
        }
        a.heading = d > 0.8 ? Math.atan2(dy, dx) : lead.heading;
        a.animTime += dt;
        a.closeFollow = true;
      }
    }
  }
  if (!a.move && !a.path.length && squad.objective) {
    const target = squad.objective.node;
    if (a.node !== target) {
      let ok = sim2.setPathTo(a, target, ["std"], humanPass);
      if (!ok) ok = sim2.setPathTo(a, target, ["std", "shaft"], marinePass);
      if (!ok) squad.objective = null;
      else a.state = STATE.MOVE;
    }
  }
  if (a.flamer && a.fuel > 0 && sim2.floodKnown && sim2.floodStrengthAt(a.node) === 0) {
    const nd = sim2.graph.node(a.node);
    if (nd.roles.includes("corpse_cache") || a.node === sim2.graph.breachNode || a.node === sim2.burnOrderNode) {
      a.burnTimer = (a.burnTimer || 0) + dt;
      if (a.burnTimer >= 2) {
        a.burnTimer = 0;
        const corpse = sim2.agents.find((c) => !c.dead && c.faction === FACTION.CORPSE && c.node === a.node && c.damage < 100);
        if (corpse) {
          corpse.damage = 100;
          a.fuel -= sim2.P.flamethrower.fuelPerCorpse;
          sim2.stats.corpsesBurned++;
          sim2.graph.burningUntil[a.node] = sim2.t + sim2.P.flamethrower.burnNodeSec;
          if (sim2.stats.corpsesBurned % 10 === 1) sim2.log("burn", `flamethrower burning bodies in ${nd.name} (fuel ${a.fuel.toFixed(0)})`, a.node);
        }
      }
    }
  }
}
function nearestThreatNode(sim2, a) {
  for (const n of sim2.visibleNodes(a.node)) if (sim2.floodStrengthAt(n) > 0) return n;
  return a.node;
}
function applySquadOrder(sim2, squad, leader) {
  const o = squad.order;
  switch (o.kind) {
    case "order:move":
      if (leader.node === o.node) {
        if (o.respond !== void 0 || o.fallback) {
          squad.order = null;
          return false;
        }
        squad.objective = { kind: "hold", node: o.node };
      } else {
        squad.objective = { kind: "order", node: o.node };
      }
      return true;
    case "order:guard":
      squad.objective = { kind: "order", node: o.node };
      return true;
    case "order:patrol": {
      const route = o.route;
      if (leader.node === route[o.leg]) o.leg = (o.leg + 1) % route.length;
      squad.objective = { kind: "order", node: route[o.leg] };
      return true;
    }
    case "order:escort": {
      const target = sim2.byId.get(o.entityId);
      if (!target || target.dead) {
        squad.order = null;
        return false;
      }
      squad.objective = { kind: "order", node: target.node };
      return true;
    }
    default:
      return false;
  }
}
function strategicSquads(sim2) {
  const P = sim2.P;
  if (!sim2.firstSweepCleared && sim2.floodKnown && sim2.t > 120) {
    sim2.firstSweepCleared = true;
    sim2.log("sweep", "crash site is hot and holding — squads begin general deck sweeps");
    for (const s of sim2.squads) {
      if (s.objective?.kind === "breach") s.objective = null;
    }
  }
  mergeThinSquads(sim2);
  for (const squad of sim2.squads) {
    const members = squad.members.map((id) => sim2.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    if (!squad.broken && members.length > 0 && members.length < Math.ceil(squad.size0 / 2)) {
      squad.broken = true;
      sim2.log("morale", `squad ${squad.id + 1} broken — survivors fall back to individual behavior`);
      continue;
    }
    if (squad.broken || members.length === 0) continue;
    if (squad.odst && sim2.armoryLocked) continue;
    const leader = members[0];
    if (members.some((m) => m.state === STATE.FIGHT)) continue;
    if (squad.patrol) {
      patrolPlan(sim2, squad, leader);
      continue;
    }
    if (squad.pendingSweep && sim2.t >= sim2.P.marineDoctrine.firstSweepDelaySec) {
      squad.pendingSweep = false;
      squad.objective = { kind: "breach", node: sim2.graph.breachNode };
      squad.phase1 = true;
      sim2.log("sweep", `squad ${squad.id + 1} moves out to the crash site`);
    }
    if (squad.pendingSweep) continue;
    if (squad.order && applySquadOrder(sim2, squad, leader)) continue;
    if (squad.lastStandBound) {
      squad.objective = { kind: "order", node: sim2.graph.byId.get("d1corr") };
      continue;
    }
    const callPolicy = squad.callPolicy ?? "auto";
    const mustering = sim2.t < P.marineDoctrine.firstSweepDelaySec;
    for (const call of mustering || callPolicy === "ignore" ? [] : sim2.calls) {
      if (sim2.t - call.t > P.radio.callFadeSec) continue;
      if (call.rolled.has(squad.id)) continue;
      call.rolled.add(squad.id);
      if (!sim2.rng.chance(P.radio.marineCallReliability)) {
        sim2.log("radio", `squad ${squad.id + 1} missed a distress call (comms damage)`);
        continue;
      }
      if (squad.objective?.kind === "breach") continue;
      const responders = sim2.squads.filter((s) => !s.broken && s.respondingTo === call.id).length;
      if (responders >= 2) continue;
      const cur = squad.objective?.kind === "distress" ? sim2.graph.hops(leader.node, squad.objective.node, ["std"], humanPass) : Infinity;
      const d = sim2.graph.hops(leader.node, call.node, ["std", "shaft"], marinePass);
      if (d !== -1 && d < cur) {
        squad.objective = { kind: "distress", node: call.node, callId: call.id };
        squad.respondingTo = call.id;
        sim2.log("radio", `squad ${squad.id + 1} responding to distress in ${sim2.graph.node(call.node).name}`);
      }
    }
    if (squad.objective?.kind === "breach" && !squad.reachedBreach && leader.node === sim2.graph.breachNode) {
      squad.reachedBreach = true;
      sim2.log("sweep", `squad ${squad.id + 1} reaches the crash site`);
    }
    if (squad.contactNode !== void 0 && sim2.tickCount - squad.contactTick < 15 * 10 && squad.objective?.kind !== "breach" && sim2.rng.chance(0.6)) {
      squad.objective = { kind: "pursuit", node: squad.contactNode };
    }
    const objNode = squad.objective?.node;
    const arrived = objNode !== void 0 && members.every((m) => m.node === objNode || sim2.graph.hops(m.node, objNode, ["std", "shaft"], marinePass) <= 1);
    const clear = objNode !== void 0 && sim2.visibleNodes(objNode).every((n) => sim2.floodStrengthAt(n) === 0);
    if (!squad.objective || arrived && clear) {
      if (squad.objective?.kind === "breach") {
        if (!sim2.firstSweepCleared) {
          sim2.firstSweepCleared = true;
          sim2.log("sweep", `first sweep cleared the breach region (${sim2.graph.node(sim2.graph.breachNode).name})`);
        }
        squad.objective = { kind: "hold", node: leader.node };
        squad.holdUntil = sim2.t + 30;
        continue;
      }
      if (squad.objective?.kind === "breach" || sim2.firstSweepCleared || !squad.objective) {
        if (sim2.firstSweepCleared || squad.objective) {
          if (squad.holdUntil === void 0 || sim2.t >= squad.holdUntil) {
            const target = pickSweepTarget(sim2, leader);
            squad.objective = target !== -1 ? { kind: "sweep", node: target } : { kind: "hold", node: leader.node };
            squad.holdUntil = sim2.t + P.marineDoctrine.sweepDwellSec + sim2.rng.range(0, P.marineDoctrine.sweepDwellJitterSec);
          }
        } else {
          squad.objective = { kind: "hold", node: leader.node };
        }
      }
    }
  }
}
function patrolPlan(sim2, squad, leader) {
  const P = sim2.P;
  if (squad.lastStandBound) {
    squad.objective = { kind: "order", node: sim2.graph.byId.get("d1corr") };
    return;
  }
  if (squad.order && applySquadOrder(sim2, squad, leader)) return;
  const callPolicy = squad.callPolicy ?? "auto";
  for (const call of callPolicy === "ignore" ? [] : sim2.calls) {
    if (sim2.t - call.t > P.radio.callFadeSec) continue;
    if (call.rolled.has(squad.id)) continue;
    call.rolled.add(squad.id);
    if (!sim2.rng.chance(P.radio.marineCallReliability)) continue;
    const responders = sim2.squads.filter((s) => !s.broken && s.respondingTo === call.id).length;
    if (responders >= 2) continue;
    const cur = squad.objective?.kind === "distress" ? sim2.graph.hops(leader.node, squad.objective.node, ["std"], humanPass) : Infinity;
    const d = sim2.graph.hops(leader.node, call.node, ["std", "shaft"], marinePass);
    if (d !== -1 && d < cur) {
      squad.objective = { kind: "distress", node: call.node, callId: call.id };
      squad.respondingTo = call.id;
      sim2.log("radio", `patrol ${squad.patrolNo} responding to distress in ${sim2.graph.node(call.node).name}`);
    }
  }
  if (squad.objective?.kind === "distress") {
    const objNode = squad.objective.node;
    const clear = sim2.visibleNodes(objNode).every((n) => sim2.floodStrengthAt(n) === 0);
    if (leader.node === objNode && clear) {
      squad.objective = null;
      squad.respondingTo = null;
    } else return;
  }
  if (leader.node === squad.route[squad.leg] && !leader.move && !leader.path.length) {
    squad.leg = (squad.leg + 1) % squad.route.length;
  }
  squad.objective = { kind: "patrol", node: squad.route[squad.leg] };
}
function mergeThinSquads(sim2) {
  for (const A of sim2.squads) {
    const aliveA = A.members.map((id) => sim2.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    if (!aliveA.length) continue;
    if (!A.broken && aliveA.length > 2) continue;
    if (A.patrol && aliveA.length >= 2) continue;
    for (const B of sim2.squads) {
      if (B === A || B.broken) continue;
      const aliveB = B.members.map((id) => sim2.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (aliveB.length < 2) continue;
      const d = sim2.graph.hops(aliveA[0].node, aliveB[0].node, ["std"], humanPass);
      if (d === -1 || d > 1) continue;
      for (const m of aliveA) {
        m.squad = B.id;
        B.members.push(m.id);
      }
      A.members = A.members.filter((id) => !aliveA.some((m) => m.id === id));
      B.size0 += aliveA.length;
      sim2.log("morale", `survivors of squad ${A.id + 1} fold into squad ${B.id + 1} (${aliveB.length + aliveA.length} rifles)`);
      break;
    }
  }
}
function pickSweepTarget(sim2, leader) {
  const g = sim2.graph;
  const taken = /* @__PURE__ */ new Set();
  for (const s of sim2.squads) {
    if (!s.broken && (s.objective?.kind === "sweep" || s.objective?.kind === "order")) taken.add(s.objective.node);
  }
  let best = -1, bestScore = Infinity;
  for (const n of g.nodes) {
    if (n.type === "corridor" || n.idx === leader.node || taken.has(n.idx)) continue;
    if (n.roles.includes("command")) continue;
    const staleness = sim2.t - sim2.sweptAt[n.idx];
    if (staleness < 40) continue;
    const d = g.hops(leader.node, n.idx, ["std", "shaft"], marinePass);
    if (d === -1) continue;
    const breachDist = g.hops(n.idx, g.breachNode, ["std", "shaft"], marinePass);
    const score = d * 0.5 + (breachDist === -1 ? 8 : breachDist) * 0.9 - (n.deck >= 4 ? 2.5 : 0) - Math.min(staleness, 300) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = n.idx;
    }
  }
  return best;
}
function assignFirstSweep(sim2) {
  const ranked = [];
  for (const squad of sim2.squads) {
    const leader = sim2.byId.get(squad.members[0]);
    squad.size0 = squad.members.length;
    if (squad.patrol) continue;
    squad.objective = { kind: "hold", node: leader.node };
    const d = sim2.graph.hops(leader.node, sim2.graph.breachNode, ["std"], humanPass);
    if (d !== -1) ranked.push({ squad, d });
  }
  ranked.sort((a, b) => a.d - b.d);
  for (const { squad, d } of ranked.slice(0, 2)) {
    squad.pendingSweep = true;
    sim2.log("sweep", `squad ${squad.id + 1} mustering to investigate the crash (${sim2.graph.node(sim2.graph.breachNode).name}, ${d} hops) — moving out in ~${sim2.P.marineDoctrine.firstSweepDelaySec}s`);
  }
}

// sim/hive.js
var TASK = {
  MOVE: "move",
  // {node}
  GRAB: "grab",
  // {targetId}
  CONVERT: "convert",
  // {corpseId} infection form + body -> combat form (form spent)
  TRANSFORM: "transform",
  // combat form roots into a carrier (the hive's ratio lever)
  GUARD: "guard",
  // {node} defend a carrier
  REANIMATE: "reanimate",
  // {targetId} downed combat form
  DRAG: "drag",
  // {corpseId, node} haul carrier food
  AMBUSH: "ambush",
  // {linkIdx, end} lie in wait mid-shaft
  BAIT: "bait",
  // {squadId, shaftIdx} get seen, retreat through shaft
  DECOY: "decoy",
  // {show, stage} get seen far from the dens, then evade
  ATTACK: "attack",
  // {node} open aggression (rampage)
  SCOUT: "scout"
  // {node} refresh a lost belief — costs forms to look
};
var W_HUMAN = { [FACTION.CIVILIAN]: 0.1, [FACTION.ARMED]: 0.6, [FACTION.MARINE]: 1 };
var W_FLOOD = { [FACTION.INFECTION]: 0.25, [FACTION.COMBAT]: 1, [FACTION.CARRIER]: 0.5 };
var Hive = class {
  constructor(sim2) {
    this.sim = sim2;
    this.knownLocked = /* @__PURE__ */ new Set();
    this.knownBlockedVents = /* @__PURE__ */ new Set();
    this.beliefs = /* @__PURE__ */ new Map();
    this.believedHumanStr = new Float32Array(sim2.graph.n);
    this.believedHardness = new Float32Array(sim2.graph.n);
    this.opening = true;
    this.carrierSite = -1;
    this.sweepEtaSec = Infinity;
    this.baitCooldownUntil = 0;
    this.strongpoints = /* @__PURE__ */ new Map();
    const garrison = [
      ...sim2.graph.nodesWithRole("armory"),
      ...sim2.graph.nodesWithRole("marines"),
      ...sim2.graph.nodesWithRole("odst")
    ];
    this.garrisonDist = sim2.graph.flowField(garrison, ["std"], () => true).dist;
    const barracks = sim2.graph.byId.get("barracks");
    for (const a of sim2.agents) {
      if (a.dead) continue;
      if (a.faction === FACTION.CIVILIAN && (a.helpless || a.stayPut)) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.9, static: true });
      else if (a.faction === FACTION.CIVILIAN) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.3 });
      else if (a.faction === FACTION.ARMED) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.25 });
      else if (a.faction === FACTION.MARINE) this.beliefs.set(a.id, { node: a.node, t: 0, conf: a.node === barracks ? 0.8 : 0.2 });
    }
  }
  // --- stale-map passability: believed, not actual ---
  infectionPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    if (link.kind === "std") return !this.knownLocked.has(link.i) || !link.lockable;
    if (link.kind === "vent") return !this.knownBlockedVents.has(link.i);
    return link.kind === "shaft";
  };
  bigPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    if (link.kind === "std") return !this.knownLocked.has(link.i);
    return link.kind === "shaft";
  };
  // combat forms squeeze through the vent network too (user rule) — only the
  // bloated carriers are stuck with corridors and shafts (bigPass above)
  combatPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    if (link.kind === "std") return !this.knownLocked.has(link.i);
    if (link.kind === "shaft") return true;
    return link.kind === "vent" && !this.knownBlockedVents.has(link.i);
  };
  _layersFor(kind) {
    return kind === "infection" ? ["std", "vent", "shaft"] : kind === "combat" ? ["std", "shaft"] : ["std", "shaft"];
  }
  _passFor(kind) {
    return kind === "infection" ? this.infectionPass : kind === "combat" ? this.combatPass : this.bigPass;
  }
  observeBlocked(link) {
    const g = this.sim.graph;
    if (link.kind === "std" && !this.knownLocked.has(link.i)) {
      this.knownLocked.add(link.i);
      this.sim.log("hive", `hive discovers a locked ${link.type} (${g.node(link.a).name} ↔ ${g.node(link.b).name}) — re-planning`);
    } else if (link.kind === "vent" && !this.knownBlockedVents.has(link.i)) {
      this.knownBlockedVents.add(link.i);
      this.sim.log("hive", `hive finds a collapsed vent (${g.node(link.a).name} ↔ ${g.node(link.b).name})`);
    }
  }
  // --- §13.2 scarcity: the engine of emergent phases ---
  scarcity(I) {
    const P = this.sim.P.hive;
    return Math.min(P.scarcityMax, Math.max(P.scarcityMin, Math.pow(P.I_ref / Math.max(I, 1), P.kS)));
  }
  // --- belief maintenance (§6.1, §13.6) ---
  updateBeliefs() {
    const sim2 = this.sim, dt = sim2.P.sim.strategicTickSec;
    const lambda = sim2.P.belief.decayRatePerSec;
    for (const b of this.beliefs.values()) {
      if (!b.static) b.conf *= Math.exp(-lambda * dt);
    }
    const seen = /* @__PURE__ */ new Set();
    const observed = /* @__PURE__ */ new Map();
    for (const f of sim2.agents) {
      if (f.dead || !isActiveFloodForm(f)) continue;
      for (const n of sim2.floodSenses(f.node)) {
        let shooterW = 0;
        for (const h of sim2.occupants(n)) {
          if (!isLivingHuman(h)) continue;
          if (h.faction === FACTION.MARINE) shooterW += 1;
          else if (h.faction === FACTION.ARMED) shooterW += 0.6;
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          const old = this.beliefs.get(h.id);
          this.beliefs.set(h.id, { node: h.node, t: sim2.t, conf: 1, static: old?.static && (h.helpless || h.stayPut) });
        }
        if (shooterW >= 2) this.strongpoints.set(n, { w: shooterW, t: sim2.t });
        const prev = observed.get(n);
        if (prev === void 0 || shooterW > prev) observed.set(n, shooterW);
      }
    }
    const P = sim2.P;
    this.believedHumanStr.fill(0);
    this.believedHardness.fill(0);
    for (const [id, b] of this.beliefs) {
      const h = sim2.byId.get(id);
      if (!h || h.dead || h.hp <= 0) {
        this.beliefs.delete(id);
        continue;
      }
      if (b.conf < 0.05) continue;
      const w = W_HUMAN[h.faction] * b.conf;
      const dtSeen = sim2.t - b.t;
      const spreadHops = b.static ? 0 : Math.min(4, Math.floor(P.belief.humanSpeedHops * dtSeen));
      const q = P.belief.predictionQuality;
      if (spreadHops === 0 || b.conf > 0.95) {
        this.believedHumanStr[b.node] += w;
        if (h.faction === FACTION.MARINE) this.believedHardness[b.node] += w;
      } else {
        const nodes = sim2.graph.nodesWithin(b.node, spreadHops, ["std"], humanPass);
        let total = 0;
        const score = nodes.map((n) => {
          const model = 1 / (1 + sim2.influence.floodStr[n] * 3);
          const s = 1 - q + q * model;
          total += s;
          return s;
        });
        nodes.forEach((n, i) => {
          const p = score[i] / total;
          this.believedHumanStr[n] += w * p;
          if (h.faction === FACTION.MARINE) this.believedHardness[n] += w * p;
        });
      }
    }
    for (const [n, sp] of this.strongpoints) {
      if (observed.has(n) && observed.get(n) < 2) {
        this.strongpoints.delete(n);
        continue;
      }
      const age = sim2.t - sp.t;
      if (age > 360) {
        this.strongpoints.delete(n);
        continue;
      }
      const s = sp.w * Math.exp(-age / 180);
      this.believedHardness[n] += Math.max(0, s - this.believedHardness[n]);
      this.believedHumanStr[n] += Math.max(0, s - this.believedHumanStr[n]);
    }
  }
  // --- route risk (§13.8) ---
  routeRisk(path) {
    if (!path) return 1;
    const g = this.sim.graph;
    let risk = 0;
    for (const step of path) {
      if (step.layer === "vent") risk += this.ventWatched(step.link) * 0.5;
      else if (step.layer === "shaft") risk += Math.min(1, this.believedHardness[step.link.a] + this.believedHardness[step.link.b]) * 0.6;
      else {
        risk += Math.min(1, this.believedHumanStr[step.to] * 1);
        const nd = g.node(step.to);
        if (nd.roles.includes("artery") || nd.type === "open") risk += 0.25;
      }
    }
    return Math.min(2.5, risk);
  }
  ventWatched(link) {
    let w = 0;
    for (const end of [link.a, link.b]) {
      w += this.believedHardness[end] + this.believedHumanStr[end] * 0.5;
    }
    return Math.min(1, w);
  }
  // Stealth pathing (§6.3): prefer routes around believed human presence and
  // watched vents; fall back to the direct route when there is no choice.
  stealthPath(from, to, kind) {
    const g = this.sim.graph;
    const layers = this._layersFor(kind);
    const base = this._passFor(kind);
    const quiet = (l, a, b) => {
      if (!base(l, a, b)) return false;
      if (b !== to && this.believedHumanStr[b] > 0.25) return false;
      if (l.kind === "vent" && this.ventWatched(l) > 0.5) return false;
      return true;
    };
    return g.path(from, to, layers, quiet) ?? g.path(from, to, layers, base);
  }
  safeInfectionPath(from, to) {
    return this.stealthPath(from, to, "infection");
  }
  // Combat-form route that never cuts THROUGH a remembered gun line: any
  // intermediate node with real believed hardness is off-limits (only the
  // destination itself may be hard — that's the assault). Walking the muster
  // through the last-stand corridor was how forms trickled in one at a time.
  safeAssaultPath(from, to) {
    const pass = (l, a, b) => {
      if (!this.bigPass(l, a, b)) return false;
      if (b !== from && b !== to && this.believedHardness[b] > 0.7) return false;
      return true;
    };
    return this.sim.graph.path(from, to, ["std", "shaft"], pass);
  }
  // --- sweep ETA (§6.7/§13.5): a belief, not ground truth ---
  estimateSweepEta() {
    const sim2 = this.sim;
    let bestHops = Infinity;
    for (const [id, b] of this.beliefs) {
      const h = sim2.byId.get(id);
      if (!h || h.faction !== FACTION.MARINE || b.conf < 0.15) continue;
      const d = sim2.graph.hops(b.node, sim2.graph.breachNode, ["std"], humanPass);
      if (d !== -1 && d < bestHops) bestHops = d;
    }
    if (bestHops === Infinity) return Infinity;
    return bestHops * (sim2.graph.avgStdLenM / (sim2.P.movement.baseMps * sim2.P.speed.marine));
  }
  // arteries carry marine traffic; denning beside them is asking to be found
  trafficPenalty(node) {
    let p = 0;
    if (this.sim.graph.hasRole(node, "artery")) p += 2;
    for (const { to } of this.sim.graph.neighbors(node, ["std"], () => true)) {
      if (this.sim.graph.hasRole(to, "artery")) p += 0.4;
    }
    return p;
  }
  // escape options from a node across all layers the hive can use — a
  // carrier site or fallback point with one exit is a trap, not a refuge
  exitCount(node) {
    let n = 0;
    for (const _ of this.sim.graph.neighbors(node, ["std"], (l) => !this.knownLocked.has(l.i))) n++;
    for (const _ of this.sim.graph.neighbors(node, ["shaft"], () => true)) n++;
    for (const _ of this.sim.graph.neighbors(node, ["vent"], (l) => !this.knownBlockedVents.has(l.i))) n++;
    return n;
  }
  // absorbed map knowledge (§6.1): garrison compartments are dangerous
  // whether or not the hive currently sees anyone in them
  staticGarrison(node) {
    const roles = this.sim.graph.node(node).roles;
    if (roles.includes("marines") || roles.includes("odst")) return 1.2;
    if (roles.includes("armory") || roles.includes("armed")) return 0.8;
    return 0;
  }
  // hardness the hive believes is at/near a node (for evade + siting)
  localThreat(node) {
    let h = this.believedHardness[node] + this.believedHumanStr[node] * 0.4 + this.staticGarrison(node);
    for (const { to } of this.sim.graph.neighbors(node, ["std"], () => true)) {
      h += this.believedHardness[to] * 0.6 + this.staticGarrison(to) * 0.5;
    }
    return h;
  }
  // ======================= strategic tick =======================
  strategicTick() {
    const sim2 = this.sim;
    this.updateBeliefs();
    const claimedNow = /* @__PURE__ */ new Set();
    for (const a of sim2.agents) {
      if (a.dead || !a.task) continue;
      if (a.task.corpseId !== void 0) claimedNow.add(a.task.corpseId);
      if (a.task.targetId !== void 0) claimedNow.add(a.task.targetId);
    }
    for (const a of sim2.agents) {
      if (a.claimed && !claimedNow.has(a.id)) a.claimed = false;
    }
    const forms = sim2.agents.filter((a) => !a.dead && isActiveFloodForm(a));
    const infection = forms.filter((a) => a.faction === FACTION.INFECTION);
    const combat = forms.filter((a) => a.faction === FACTION.COMBAT);
    const carriers = sim2.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER && a.hp > 0);
    const bodies = sim2.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
    const I = infection.length;
    const C = combat.length;
    const K = carriers.length;
    const S = this.scarcity(I + K * 2);
    this.lastScarcity = S;
    const mass = I + C * 2 + K * 2;
    const wasAllIn = this.allIn;
    this.allIn = this.beliefs.size > 0 && mass >= 50 && mass >= this.beliefs.size * 3;
    if (this.allIn && !wasAllIn) sim2.log("hive", "the hive rises as one — every form converges for the end");
    const wasAggro = this.posture === "AGGRESSIVE";
    this.posture = K >= 2 && S <= 1.05 || this.allIn ? "AGGRESSIVE" : "EVASIVE";
    if (this.posture === "AGGRESSIVE" && !wasAggro) sim2.log("hive", "the hive turns from hit-and-run to open aggression");
    for (const f of forms) {
      if (f.task?.kind === TASK.CONVERT || f.task?.kind === TASK.REANIMATE) continue;
      if (f.path.length && f.path.some((s) => this.believedHumanStr[s.to] > 0.5 || this.believedHardness[s.to] > 0.4)) {
        f.path = [];
      }
    }
    this.evade(forms, carriers);
    if (this.opening) {
      this.openingMove(infection, combat, bodies);
      if (sim2.firstSweepCleared) {
        this.opening = false;
        sim2.log("hive", "hive hands off to steady-state economy (first sweep has passed)");
      }
      return;
    }
    this.steadyState(infection, combat, carriers, bodies, I, C, K, S);
  }
  // §6.4 evade: any form standing where believed hardness beats local flood
  // strength runs for the quietest reachable node. Overrides economy tasks
  // (but not a sprung ambush — those forms are the trap).
  evade(forms, carriers) {
    const sim2 = this.sim;
    for (const f of forms) {
      if (f.faction === FACTION.COMBAT) continue;
      if (f.task?.kind === TASK.AMBUSH || f.task?.kind === TASK.BAIT || f.task?.kind === TASK.ATTACK || f.task?.kind === TASK.TRANSFORM) continue;
      if (f.task?.kind === TASK.GUARD && f.task.muster !== void 0) continue;
      if (f.state === STATE.GRABBING) continue;
      const threat = this.localThreat(f.node);
      const own = sim2.influence.floodStr[f.node];
      if (threat > Math.max(own, 0.8)) {
        const safe = this.quietNodeNear(f.node, f.faction === FACTION.INFECTION ? "infection" : "combat");
        if (safe !== -1 && safe !== f.node) {
          this.assign(f, { kind: TASK.MOVE, node: safe, evade: true });
        }
      }
    }
    for (const c of carriers) {
      const threat = this.localThreat(c.node);
      if (c.path.length) {
        const next = this.localThreat(c.path[0].to);
        const dest = this.localThreat(c.path[c.path.length - 1].to);
        if (next > threat || dest >= Math.max(0.35, threat)) c.path = [];
      }
      if (threat > 0.7) {
        const dest = c.path.length ? c.path[c.path.length - 1].to : c.node;
        const headingSomewhereSafe = c.path.length && this.localThreat(dest) <= 0.6;
        if (!headingSomewhereSafe) {
          const safe = this.quietNodeNear(c.node, "big");
          if (safe !== -1 && safe !== c.node && this.localThreat(safe) < threat) {
            const path = this.stealthPath(c.node, safe, "big");
            if (path && !path.some((s) => this.localThreat(s.to) > threat)) {
              sim2.setPath(c, path);
              if (sim2.t - (c._fleeLogAt ?? -99) > 25) {
                c._fleeLogAt = sim2.t;
                sim2.log("hive", `a carrier slips away from the guns toward ${sim2.graph.node(safe).name}`);
              }
            }
          }
        }
      }
    }
  }
  quietNodeNear(from, kind) {
    const g = this.sim.graph;
    const reach = g.nodesWithin(from, 4, this._layersFor(kind), this._passFor(kind));
    let best = -1, bestScore = -Infinity;
    for (const n of reach) {
      if (g.burningUntil[n] > this.sim.t) continue;
      let score = -this.localThreat(n) * 3 + this.sim.influence.floodStr[n] * 0.5;
      const nd = g.node(n);
      if (nd.roles.includes("maintenance") || nd.roles.includes("cargo")) score += 0.7;
      score -= this.trafficPenalty(n) * 0.4;
      if (this.exitCount(n) < 2) score -= 1.5;
      if (n === from) score -= 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }
  // Score every plausible den node near the breach (out of the sweep's
  // sightline, quiet, defensible, ideally sitting on carrier food).
  denCandidates(maxHops = 3) {
    const sim2 = this.sim, g = sim2.graph;
    const bodies0 = sim2.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
    const bodyAt = new Set(bodies0.map((b) => b.node));
    const sweepLOS = new Set(sim2.visibleNodes(g.breachNode));
    const out = [];
    for (const n of g.nodes) {
      const d = g.hops(g.breachNode, n.idx, ["std", "shaft"], this.bigPass);
      if (d === -1 || d < 1 || d > maxHops || sweepLOS.has(n.idx)) continue;
      const route = this.stealthPath(g.breachNode, n.idx, "big");
      if (!route) continue;
      let score = -this.localThreat(n.idx) * 3 - this.routeRisk(route) * 2.5;
      if (n.roles.includes("maintenance")) score += 1;
      if (n.roles.includes("cargo") || n.roles.includes("corpse_cache")) score += 1;
      if (bodyAt.has(n.idx)) score += 1.2;
      if (n.type === "corridor" && !n.roles.includes("maintenance")) score -= 2;
      if (n.type === "open") score -= 2;
      score -= this.trafficPenalty(n.idx);
      score += Math.min(this.garrisonDist[n.idx] === -1 ? 4 : this.garrisonDist[n.idx], 4) * 0.5;
      if (this.exitCount(n.idx) < 2) score -= 3;
      score -= d * 0.2;
      out.push({ node: n.idx, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  // Pick up to `count` den sites that are spread apart (>=2 hops), so the
  // hive hedges its opening across several hiding spots instead of stacking
  // everything in one room (user note: it over-concentrates early).
  pickDenSites(count) {
    const g = this.sim.graph;
    const cand = this.denCandidates(3);
    const chosen = [];
    for (const c of cand) {
      if (chosen.length >= count) break;
      if (chosen.every((s) => g.hops(s, c.node, ["std", "shaft"], this.bigPass) >= 2)) chosen.push(c.node);
    }
    if (!chosen.length && cand.length) chosen.push(cand[0].node);
    return chosen;
  }
  // --- §6.7/§13.5 the opening: a timed smash-and-grab ---
  openingMove(infection, combat, bodies) {
    const sim2 = this.sim, g = sim2.graph;
    this.sweepEtaSec = this.estimateSweepEta();
    const margin = sim2.P.hive.openingSweepMargin;
    const timeLeft = this.sweepEtaSec === Infinity ? 999 : this.sweepEtaSec;
    const mustRun = timeLeft < margin;
    if (!this.denSites) {
      this.denSites = this.pickDenSites(3);
      this.carrierSite = this.denSites[0] ?? -1;
      sim2.log("hive", `hive splits toward ${this.denSites.map((n) => g.node(n).name).join(", ")} (est. sweep in ${timeLeft === 999 ? "?" : Math.round(timeLeft)}s)`);
    }
    const dens = this.denSites;
    const homeFor = (id) => dens[id % dens.length];
    const breachBodies = bodies.filter((b) => b.node === g.breachNode && !b.claimed);
    let draggers = combat.filter((c) => c.task?.kind === TASK.DRAG).length;
    for (const c of combat) {
      if (c.task && c.task.kind !== TASK.GUARD) continue;
      const home = homeFor(c.id);
      const homeHasBody = bodies.some((b) => b.node === home);
      if (timeLeft > 20 && draggers < dens.length && !homeHasBody && breachBodies.length) {
        const body = breachBodies.shift();
        body.claimed = true;
        this.assign(c, { kind: TASK.DRAG, corpseId: body.id, node: home });
        draggers++;
      } else if (!c.task) {
        this.assign(c, { kind: TASK.GUARD, node: this.scatterNode(home, c.id, "big") });
      }
    }
    for (const f of infection) {
      if (f.task && f.task.kind !== TASK.MOVE) continue;
      const home = homeFor(f.id);
      if (mustRun && !f.task?.evade) {
        this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(home, f.id, "infection") });
        continue;
      }
      if (!f.task) {
        const grab = this.bestGrab(f, 0.6, timeLeft);
        if (grab) this.assign(f, grab);
        else this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(home, f.id, "infection") });
      }
    }
    if (!this.decoySent && combat.length >= 3) {
      this.decoySent = true;
      const decoy = combat.find((c) => !c.task || c.task.kind === TASK.GUARD);
      if (decoy) {
        let show = -1, bestScore = -Infinity;
        for (const n of g.nodes) {
          if (this.staticGarrison(n.idx) > 0) continue;
          const d = g.hops(decoy.node, n.idx, ["std", "shaft"], this.bigPass);
          if (d === -1 || d < 2 || d > 5) continue;
          let minDen = Infinity;
          for (const den of dens) {
            const dd = g.hops(n.idx, den, ["std", "shaft"], this.bigPass);
            if (dd !== -1) minDen = Math.min(minDen, dd);
          }
          const score = Math.min(minDen, 6) * 1 + this.believedHumanStr[n.idx] * 1.5 - d * 0.2;
          if (score > bestScore) {
            bestScore = score;
            show = n.idx;
          }
        }
        if (show !== -1) {
          this.assign(decoy, { kind: TASK.DECOY, show, stage: 0 });
          sim2.log("bait", `a combat form breaks cover toward ${g.node(show).name} — drawing the sweep off the dens`);
        }
      }
    }
    const carriersNow = sim2.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER).length;
    let transforming = combat.filter((c) => c.task?.kind === TASK.TRANSFORM).length;
    const wantCarriers = Math.min(dens.length, 2);
    for (const den of dens) {
      if (carriersNow + transforming >= wantCarriers) break;
      if (this.localThreat(den) >= 0.6) continue;
      if (sim2.agents.some((a) => !a.dead && a.faction === FACTION.CARRIER && a.node === den)) continue;
      const cf = combat.find((c) => c.node === den && !c.move && !c.fromPlayer && (!c.task || c.task.kind === TASK.GUARD || c.task.kind === TASK.DRAG));
      if (cf) {
        this.assign(cf, { kind: TASK.TRANSFORM });
        transforming++;
      }
    }
    for (const den of dens) {
      if (this.localThreat(den) >= 0.6) continue;
      const feed = bodies.find((b) => b.node === den && !b.claimed);
      const former = infection.find((f) => f.node === den && (!f.task || f.task.kind === TASK.MOVE));
      if (feed && former && combat.length < 4) {
        feed.claimed = true;
        this.assign(former, { kind: TASK.CONVERT, corpseId: feed.id });
      }
    }
  }
  // spread forms among a site and its quiet neighbors (no deathballs), but
  // never out onto an artery — the main corridors are where the forms were
  // getting mown down in transit
  scatterNode(site, salt, kind) {
    const g = this.sim.graph;
    const opts = [site];
    for (const { to } of g.neighbors(site, this._layersFor(kind), this._passFor(kind))) {
      if (this.localThreat(to) < 0.6 && !g.hasRole(to, "artery") && g.node(to).type !== "open") opts.push(to);
    }
    return opts[salt % opts.length];
  }
  // --- steady state: §13.3 utility over candidate actions ---
  steadyState(infection, combat, carriers, bodies, I, C, K, S) {
    const sim2 = this.sim, g = sim2.graph, P = sim2.P;
    const riskAversion = P.hive.riskBase * S;
    const rampaging = /* @__PURE__ */ new Set();
    if (this.posture === "AGGRESSIVE") for (const n of g.nodes) {
      const region = g.nodesWithin(n.idx, 1, ["std"], () => true);
      let fs = 0, hs = 0, hard = 0;
      for (const r of region) {
        fs += sim2.influence.floodStr[r];
        hs += this.believedHumanStr[r];
        hard += this.believedHardness[r];
      }
      if (fs >= P.rampage.threshold * Math.max(hs, 0.3) && fs >= P.rampage.localReserve && hard < P.rampage.marineCap) rampaging.add(n.idx);
    }
    if (rampaging.size > 0 && !this.rampageLogged) {
      this.rampageLogged = true;
      sim2.log("rampage", `flood pockets go loud where the crew is undefended (${rampaging.size} region(s))`);
    }
    let wantK = Math.min(4, 2 + Math.floor((I + C) / 22));
    if (sim2.t < (this._breedUntil ?? 0)) wantK = Math.min(6, wantK + 2);
    if (K < wantK && (C > K || K === 0)) {
      const target = this.bestCarrierNode();
      if (target !== -1) {
        const spares = combat.filter((c2) => !c2.fromPlayer && (!c2.task || c2.task.kind === TASK.GUARD && c2.task.muster === void 0 || c2.task.kind === TASK.ATTACK));
        const c = this.nearest(spares, target, ["std", "shaft"], this.bigPass);
        if (c) {
          if (c.node === target && !c.move && this.localThreat(target) < 0.5) this.assign(c, { kind: TASK.TRANSFORM });
          else this.assign(c, { kind: TASK.GUARD, node: target, seed: true });
        }
      }
    }
    const desperate = K === 0 && I < 6 && combat.length <= 4;
    if (desperate) {
      for (const c of combat) {
        if (c.downed || c.task?.kind === TASK.TRANSFORM) continue;
        c.desperateSince ??= sim2.t;
        const overdue = sim2.t - c.desperateSince > 30;
        if ((this.localThreat(c.node) < 0.9 || overdue) && !c.move && !c.fromPlayer) {
          this.assign(c, { kind: TASK.TRANSFORM });
        } else {
          const quiet = this.quietNodeNear(c.node, "big");
          if (quiet !== -1 && quiet !== c.node) this.assign(c, { kind: TASK.GUARD, node: quiet });
          else if (!c.move) this.assign(c, { kind: TASK.TRANSFORM });
        }
      }
      if (!this._desperateLogged) {
        this._desperateLogged = true;
        this.sim.log("hive", "the last combat forms go to ground to seed new carriers");
      }
    } else {
      for (const c of combat) c.desperateSince = void 0;
    }
    this._desperate = desperate;
    {
      const seeding = combat.reduce((n, c) => n + (c.task?.kind === TASK.TRANSFORM || c.task?.seed ? 1 : 0), 0);
      const raider = this._raiderId !== void 0 ? sim2.byId.get(this._raiderId) : null;
      const raiderLive = raider && !raider.dead && !raider.downed && raider.hp > 0;
      if (!raiderLive) this._raiderId = void 0;
      if ((this.posture === "EVASIVE" || K + seeding >= 3) && !raiderLive && sim2.t >= (this._raidCooldownUntil ?? 0)) {
        let bestT = -1, bestS = 0.5;
        for (const n of g.nodes) {
          if (!n.roles.includes("soft") && !n.roles.includes("medbay")) continue;
          if (this.believedHardness[n.idx] > 0.3) continue;
          const s = this.believedHumanStr[n.idx] - this.believedHardness[n.idx] * 2;
          if (s > bestS) {
            bestS = s;
            bestT = n.idx;
          }
        }
        if (bestT !== -1) {
          const spares = combat.filter((c) => !c.fromPlayer && !c.downed && (!c.task || c.task.kind === TASK.GUARD && c.task.muster === void 0 && !c.task.seed));
          const r = this.nearest(spares, bestT, ["std", "shaft", "vent"], this.combatPass);
          if (r) {
            this._raiderId = r.id;
            this._raidCooldownUntil = sim2.t + 60;
            this.assign(r, { kind: TASK.ATTACK, node: bestT });
            sim2.log("rampage", `a combat form slips off to raid ${g.node(bestT).name} — soft target, likely unguarded`);
          }
        }
      }
    }
    const guardsWanted = S >= 1.5 ? 2 : 1;
    for (const carrier of carriers) {
      const guards = combat.filter((c) => c.task?.kind === TASK.GUARD && c.task.node === carrier.node);
      if (guards.length < guardsWanted) {
        const free = combat.filter((c) => !c.task);
        const guard = this.nearest(free, carrier.node, ["std", "shaft"], this.bigPass);
        if (guard) this.assign(guard, { kind: TASK.GUARD, node: carrier.node });
      }
    }
    for (const f of combat) {
      if (!rampaging.has(f.node)) continue;
      if (f.task && (f.task.kind === TASK.ATTACK || f.task.kind === TASK.AMBUSH || f.task.kind === TASK.BAIT || f.task.kind === TASK.TRANSFORM)) continue;
      if (f.task?.seed) continue;
      const target = this.nearestBelievedHuman(f.node);
      if (target === -1) continue;
      const ban = this._musterBan?.get(target);
      if (ban && sim2.t < ban.until && combat.length < ban.needed) continue;
      const defense = this.believedHumanStr[target] + this.believedHardness[target];
      if (defense > 0.8) {
        const stage = this.stagingNodeNear(target);
        if (stage !== -1) {
          const until = f.task?.kind === TASK.GUARD && f.task.muster === target ? f.task.until : sim2.t + 90;
          this.assign(f, { kind: TASK.GUARD, node: stage, muster: target, until });
          if (sim2.t >= (this._musterLogAt ?? 0)) {
            this._musterLogAt = sim2.t + 30;
            sim2.log("hive", `the hive masses outside ${g.node(target).name} — waiting for the numbers`);
          }
        }
        continue;
      }
      this.assign(f, { kind: TASK.ATTACK, node: target });
    }
    {
      const staged = /* @__PURE__ */ new Map();
      for (const f of combat) {
        const t = f.task;
        if (t?.kind !== TASK.GUARD || t.muster === void 0) continue;
        if (sim2.t > t.until) {
          f.task = null;
          continue;
        }
        if (!staged.has(t.muster)) staged.set(t.muster, []);
        staged.get(t.muster).push(f);
      }
      this._musterStart ??= /* @__PURE__ */ new Map();
      this._musterBan ??= /* @__PURE__ */ new Map();
      for (const [target, forms] of staged) {
        const defense = this.believedHumanStr[target] + this.believedHardness[target];
        const needed = this.allIn ? 1 : Math.min(defense * P.swarm.killRatio, P.swarm.maxMusterForms);
        const arrived = forms.filter((f) => !f.move && f.node === f.task.node).length;
        if (defense <= 0.8 || arrived >= needed) {
          this._musterStart.delete(target);
          for (const f of forms) this.assign(f, { kind: TASK.ATTACK, node: target });
          sim2.log("rampage", `the muster is up — ${forms.length} forms storm ${g.node(target).name} together`);
          continue;
        }
        const stagedSince = this._musterStart.get(target);
        if (stagedSince !== void 0 && sim2.t - stagedSince > 75 && arrived >= Math.max(3, needed * 0.6)) {
          this._musterStart.delete(target);
          for (const f of forms) this.assign(f, { kind: TASK.ATTACK, node: target });
          sim2.log("rampage", `the hive tires of waiting — ${forms.length} forms storm ${g.node(target).name}`);
          continue;
        }
        if (combat.length < needed) {
          const raisable = sim2.agents.filter((d) => !d.dead && d.faction === FACTION.COMBAT && d.downed && d.damage < 100 && !d.claimed && !sim2.occupants(d.pnode ?? d.node).some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)));
          const medics = infection.filter((f) => !f.task || f.task.kind === TASK.MOVE || f.task.kind === TASK.SCOUT);
          if (raisable.length > 0) {
            this._breedUntil = 0;
            let k = 0;
            while (k < raisable.length && k < medics.length && combat.length + k < needed + 2) {
              const d = raisable[k];
              d.claimed = true;
              this.assign(medics[k], { kind: TASK.REANIMATE, targetId: d.id });
              k++;
            }
            if (k) sim2.log("hive", `the hive raises its dead — ${k} downed forms reclaimed for the ${g.node(target).name} muster`);
            for (const f of forms) f.task.until = Math.max(f.task.until ?? 0, sim2.t + 60);
            continue;
          }
          this._musterStart.delete(target);
          this._musterBan.set(target, { until: sim2.t + 300, needed });
          this._breedUntil = sim2.t + 300;
          for (const f of forms) f.task = null;
          sim2.log("hive", `the hive cannot make the numbers for ${g.node(target).name} — everything turns to breeding`);
          continue;
        }
        if (!this._musterStart.has(target)) this._musterStart.set(target, sim2.t);
        const spareCount = combat.filter((c) => !c.task || c.task.kind === TASK.GUARD && c.task.muster === void 0 && !c.task.seed).length;
        if (sim2.t - this._musterStart.get(target) > 120 && forms.length + spareCount < needed) {
          this._musterStart.delete(target);
          this._musterBan.set(target, { until: sim2.t + 180, needed });
          for (const f of forms) f.task = null;
          sim2.log("hive", `the hive breaks off the muster at ${g.node(target).name} — not enough mass; it turns back to breeding`);
          continue;
        }
        if (forms.length < needed + 2) {
          const stage = forms[0].task.node;
          const spares = combat.filter((c) => !c.task || c.task.kind === TASK.GUARD && c.task.muster === void 0);
          const ranked = spares.map((c) => ({ c, d: g.hops(c.node, stage, ["std", "shaft"], this.bigPass) })).filter((x) => x.d !== -1).sort((x, y) => x.d - y.d || x.c.id - y.c.id);
          let strength = forms.length;
          for (const { c } of ranked) {
            if (strength >= needed + 2) break;
            this.assign(c, { kind: TASK.GUARD, node: stage, muster: target, until: sim2.t + 90 });
            strength++;
          }
        }
        if (forms.length >= needed) {
          for (const f of forms) f.task.until = Math.max(f.task.until, sim2.t + 30);
        }
      }
    }
    for (const f of infection) {
      if (f.task) continue;
      const closeDowned = sim2.agents.find((d) => !d.dead && d.faction === FACTION.COMBAT && d.downed && d.damage < 100 && !d.claimed && sim2.nodesNear(f.node, 2).includes(d.pnode ?? d.node) && !sim2.occupants(d.pnode ?? d.node).some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)));
      if (closeDowned) {
        closeDowned.claimed = true;
        this.assign(f, { kind: TASK.REANIMATE, targetId: closeDowned.id });
        continue;
      }
      const body = this.nearestBody(f, bodies);
      if (body) {
        body.claimed = true;
        this.assign(f, { kind: TASK.CONVERT, corpseId: body.id });
        continue;
      }
      const grab = this.bestGrab(f, riskAversion, null, S);
      if (grab) {
        this.assign(f, grab);
        continue;
      }
      const downed = sim2.agents.find((d) => !d.dead && d.faction === FACTION.COMBAT && d.downed && d.damage < 100 && !d.claimed && (this.believedHardness[d.node] <= 0.5 || !sim2.occupants(d.pnode ?? d.node).some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED))));
      if (downed && 2 - S * 1 > 0) {
        downed.claimed = true;
        this.assign(f, { kind: TASK.REANIMATE, targetId: downed.id });
        continue;
      }
      if (I >= P.hive.searchMinPool && sim2.rng.chance(0.3)) {
        this.assign(f, { kind: TASK.SCOUT, node: sim2.rng.int(g.n) });
        continue;
      }
      const rally = this.nearestFoodNode(f);
      if (rally !== -1 && f.node !== rally) {
        this.assign(f, { kind: TASK.MOVE, node: rally, rally: true });
      } else if (rally === -1 && carriers.length) {
        this.assign(f, { kind: TASK.MOVE, node: this.scatterNode(carriers[f.id % carriers.length].node, f.id, "infection") });
      }
    }
    {
      const rallyCounts = /* @__PURE__ */ new Map();
      for (const f of infection) {
        if (f.task?.kind === TASK.MOVE && f.task.rally) {
          rallyCounts.set(f.task.node, (rallyCounts.get(f.task.node) || 0) + 1);
        }
      }
      for (const [node, count] of rallyCounts) {
        const want = Math.floor(count / P.swarm.escortPer);
        if (want < 1) continue;
        const escorts = combat.filter((c) => c.task?.kind === TASK.GUARD && c.task.node === node).length;
        if (escorts >= want) continue;
        const free = combat.filter((c) => !c.task);
        const e = this.nearest(free, node, ["std", "shaft"], this.bigPass);
        if (e) this.assign(e, { kind: TASK.GUARD, node });
      }
    }
    if (C >= 4 && S <= 1.3 && sim2.t >= this.baitCooldownUntil) this.tryBait(combat);
    this.trySquadWipe(infection, combat, carriers, I);
    for (const c of combat) {
      if (c.task) continue;
      const prey = this._desperate ? -1 : this.nearestHuntNode(c.node);
      if (prey !== -1) {
        this.assign(c, { kind: TASK.ATTACK, node: prey });
        continue;
      }
      const home = carriers.length ? carriers[c.id % carriers.length].node : this.carrierSite;
      if (home !== -1 && c.node !== home) this.assign(c, { kind: TASK.GUARD, node: this.scatterNode(home, c.id, "big") });
    }
  }
  // score grab candidates per §13.3; returns a task or null.
  // openingTimeLeft non-null => opening gate (§13.5). S taxes the form cost.
  bestGrab(form, riskAversion, openingTimeLeft = null, S = 1) {
    const sim2 = this.sim, P = sim2.P;
    let best = null, bestU = 0;
    for (const [id, b] of this.beliefs) {
      const h = sim2.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || b.conf < 0.25) continue;
      if (h.faction === FACTION.MARINE) continue;
      const path = this.safeInfectionPath(form.node, b.node);
      if (!path) continue;
      const hops = path.length;
      if (openingTimeLeft !== null) {
        const eta = hops * (sim2.graph.avgStdLenM / (P.movement.baseMps * P.speed.infection)) + P.combat.infectionGrabSec;
        if (eta > openingTimeLeft - P.hive.openingSweepMargin) continue;
        if (hops > 3) continue;
      }
      let value;
      if (h.helpless) value = P.hive.values.helpless;
      else if (h.faction === FACTION.CIVILIAN) {
        value = h.hasRadio ? P.hive.values.civilianRadio : P.hive.values.civilianNoRadio;
        if (!h.calledOut) {
          if (this.believedHumanStr[b.node] > 0.4) value -= P.hive.values.distressPenalty * 0.5;
          if (h.hasRadio) value -= P.hive.values.distressPenalty * 0.3;
        }
      } else value = P.hive.values.armed - (this.believedHumanStr[b.node] > 0.6 ? 1 : 0);
      if (h.helpless || h.stayPut) value += 1;
      const risk = this.routeRisk(path);
      const U = value * b.conf - S * 0.35 - riskAversion * 0.25 * risk - hops * 0.06;
      if (U > bestU) {
        bestU = U;
        best = { kind: TASK.GRAB, targetId: id };
      }
    }
    return best;
  }
  // Best node to root a new carrier: quiet, defensible, near our own mass,
  // and spread from existing carriers so production isn't one clearable cluster.
  bestCarrierNode() {
    const g = this.sim.graph;
    const carrierNodes = this.sim.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER).map((a) => a.node);
    const bodyAt = new Float32Array(g.n);
    for (const b of this.sim.agents) {
      if (b.dead || b.faction !== FACTION.CORPSE || b.damage >= 100) continue;
      bodyAt[b.node] += 1;
      for (const { to } of g.neighbors(b.node, ["std"], () => true)) bodyAt[to] += 0.3;
    }
    const marineNodes = [];
    for (const [id, b] of this.beliefs) {
      const h = this.sim.byId.get(id);
      if (h && !h.dead && h.hp > 0 && h.faction === FACTION.MARINE && b.conf >= 0.4) marineNodes.push(b.node);
    }
    const marineDist = marineNodes.length ? g.flowField(marineNodes, ["std", "shaft"], () => true).dist : null;
    let best = -1, bestScore = 0.2;
    for (const n of g.nodes) {
      const idx = n.idx;
      if (g.burningUntil[idx] > this.sim.t) continue;
      if (this.localThreat(idx) > 0.4) continue;
      if (this.exitCount(idx) < 2) continue;
      let score = this.sim.influence.floodStr[idx] * 0.6;
      score += Math.min(bodyAt[idx], 8) * 0.35;
      if (this.sim.influence.floodStr[idx] < 0.05) score -= 1.2;
      if (n.roles.includes("maintenance") || n.roles.includes("cargo") || n.roles.includes("corpse_cache")) score += 1;
      if (n.type === "corridor" || n.type === "open") score -= 1.5;
      score -= this.trafficPenalty(idx) * 0.5;
      score += Math.min(this.garrisonDist[idx] === -1 ? 4 : this.garrisonDist[idx], 4) * 0.25;
      if (marineDist) {
        const d = marineDist[idx];
        score += Math.min(d === -1 ? 6 : d, 6) * 0.3;
      }
      if (carrierNodes.length) {
        let near = Infinity;
        for (const cn of carrierNodes) {
          const d = g.hops(idx, cn, ["std", "shaft"], this.bigPass);
          if (d !== -1) near = Math.min(near, d);
        }
        if (near === 0) continue;
        if (near === 1) score -= 2.5;
        if (near !== Infinity) score += Math.min(near, 5) * 0.5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    return best;
  }
  tryBait(combat) {
    const sim2 = this.sim, g = sim2.graph;
    for (const squad of sim2.squads) {
      if (squad.broken) continue;
      const leader = sim2.byId.get(squad.members[0]);
      if (!leader || leader.dead) continue;
      const b = this.beliefs.get(leader.id);
      if (!b || b.conf < 0.6) continue;
      for (const shaft of g.shafts) {
        const dA = g.hops(b.node, shaft.a, ["std"], humanPass);
        const dB = g.hops(b.node, shaft.b, ["std"], humanPass);
        const near = Math.min(dA === -1 ? 99 : dA, dB === -1 ? 99 : dB);
        if (near > 2) continue;
        const mouth = dA !== -1 && (dB === -1 || dA <= dB) ? shaft.a : shaft.b;
        const farEnd = mouth === shaft.a ? shaft.b : shaft.a;
        const free = combat.filter((c) => !c.task || c.task.kind === TASK.GUARD);
        if (free.length < 3) return;
        this.assign(free[0], { kind: TASK.AMBUSH, linkIdx: shaft.i, end: mouth });
        this.assign(free[1], { kind: TASK.AMBUSH, linkIdx: shaft.i, end: farEnd });
        this.assign(free[2], { kind: TASK.BAIT, squadId: squad.id, shaftIdx: shaft.i, mouth, stage: 0 });
        this.baitCooldownUntil = sim2.t + 90;
        sim2.log("bait", `hive baits squad ${squad.id + 1} toward the ${g.node(mouth).name} shaft`);
        return;
      }
    }
  }
  staleBeliefs() {
    for (const [id, b] of this.beliefs) {
      const h = this.sim.byId.get(id);
      if (h && h.faction === FACTION.MARINE && b.conf > 0.5) return false;
    }
    return true;
  }
  nearest(list, node, layers, pass) {
    let best = null, bestD = Infinity;
    for (const a of list) {
      const d = this.sim.graph.hops(a.node, node, layers, pass);
      if (d !== -1 && d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }
  nearestBody(form, bodies) {
    let best = null, bestD = Infinity;
    for (const b of bodies) {
      if (b.claimed) continue;
      if (this.believedHardness[b.node] > 0.5 || this.localThreat(b.node) > 1.2) continue;
      const d = this.sim.graph.hops(form.node, b.node, ["std", "vent"], this.infectionPass);
      if (d !== -1 && d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }
  // Where a combat form goes to make bodies. Combines live belief with the
  // hive's standing knowledge of where the crew lives (absorbed crew memory):
  // quarters, mess, medbay and cryo are always worth checking even with no
  // current contact — that's how it "seeks out civilians as soon as able."
  // Marine-held nodes are avoided (hide from the guns, hunt the soft).
  nearestHuntNode(from) {
    const sim2 = this.sim, g = sim2.graph;
    const prior = new Float32Array(g.n);
    for (const [id, b] of this.beliefs) {
      const h = sim2.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || h.faction === FACTION.MARINE) continue;
      let w = b.conf * (h.helpless || h.stayPut ? 3 : 1);
      prior[b.node] += w;
    }
    for (const n of g.nodes) {
      if (n.roles.includes("quarters") || n.roles.includes("soft")) prior[n.idx] += 0.6;
      if (n.roles.includes("helpless") || n.roles.includes("medbay") || n.roles.includes("brig")) prior[n.idx] += 1.2;
    }
    let best = -1, bestScore = 0.4;
    for (const n of g.nodes) {
      if (prior[n.idx] <= 0) continue;
      if (this.believedHardness[n.idx] > 0.5) continue;
      if (this.localThreat(n.idx) > 1) continue;
      const p = this.safeAssaultPath(from, n.idx);
      if (!p || p.length > 7) continue;
      const score = prior[n.idx] - p.length * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = n.idx;
      }
    }
    return best;
  }
  // Closest thing an infection form can eat or convert: a corpse, or a
  // believed civilian position. Skips marine-held ground.
  nearestFoodNode(form) {
    const sim2 = this.sim;
    let best = -1, bestD = Infinity;
    for (const b of sim2.agents) {
      if (b.dead || b.faction !== FACTION.CORPSE || b.damage >= 100) continue;
      if (this.believedHardness[b.node] > 0.5) continue;
      const d = sim2.graph.hops(form.node, b.node, ["std", "vent"], this.infectionPass);
      if (d !== -1 && d < bestD) {
        bestD = d;
        best = b.node;
      }
    }
    for (const [id, bel] of this.beliefs) {
      const h = sim2.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || h.faction === FACTION.MARINE || bel.conf < 0.3) continue;
      if (this.believedHardness[bel.node] > 0.5) continue;
      const d = sim2.graph.hops(form.node, bel.node, ["std", "vent"], this.infectionPass);
      if (d !== -1 && d < bestD) {
        bestD = d;
        best = bel.node;
      }
    }
    return best;
  }
  // §swarm-kill (user note): an ISOLATED squad the hive can muster 2:1 on
  // gets hit immediately, losses accepted, as long as the hive keeps a
  // reserve (forms or a carrier) elsewhere. Eliminating the main threat is
  // worth trading currency for.
  trySquadWipe(infection, combat, carriers, I) {
    const sim2 = this.sim, g = sim2.graph, P = sim2.P.swarm;
    if (sim2.t < 60) return;
    if (sim2.t < (this.squadWipeCooldownUntil ?? 0)) return;
    for (const squad of sim2.squads) {
      if (squad.broken) continue;
      const members = squad.members.map((id) => sim2.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (!members.length) continue;
      const leader = members[0];
      const bel = this.beliefs.get(leader.id);
      if (!bel || bel.conf < 0.6) continue;
      let isolated = true;
      for (const other of sim2.squads) {
        if (other === squad || other.broken) continue;
        const oLeader = sim2.byId.get(other.members[0]);
        if (!oLeader || oLeader.dead) continue;
        const ob = this.beliefs.get(oLeader.id);
        if (!ob || ob.conf < 0.3) continue;
        const d = g.hops(bel.node, ob.node, ["std"], humanPass);
        if (d !== -1 && d <= P.isolationHops) {
          isolated = false;
          break;
        }
      }
      if (!isolated) continue;
      const squadW = Math.max(
        members.length,
        this.believedHumanStr[bel.node] + this.believedHardness[bel.node]
      );
      const muster = [];
      let musterW = 0;
      for (const f of [...combat, ...infection]) {
        if (f.task?.kind === TASK.TRANSFORM) continue;
        const d = g.hops(
          f.node,
          bel.node,
          ["std", "shaft", "vent"],
          f.faction === FACTION.INFECTION ? this.infectionPass : this.bigPass
        );
        if (d !== -1 && d <= P.musterHops) {
          muster.push(f);
          musterW += f.faction === FACTION.COMBAT ? 1 : 0.25;
        }
      }
      const reserveOk = carriers.length > 0 || I - muster.filter((m) => m.faction === FACTION.INFECTION).length >= 0 ? carriers.length > 0 || I >= P.reserveForms : false;
      if (musterW >= squadW * P.killRatio && reserveOk && muster.length) {
        for (const f of muster) this.assign(f, { kind: TASK.ATTACK, node: bel.node });
        this.squadWipeCooldownUntil = sim2.t + 45;
        sim2.log("rampage", `the hive springs on isolated squad ${squad.id + 1} in ${g.node(bel.node).name} (${muster.length} forms, ${musterW.toFixed(1)}:${squadW} odds)`);
        return;
      }
    }
  }
  // weighted flood mass within `hops` of a node — what the hive could bring
  // to an assault there
  musterStrength(node, hops = 2) {
    const near = new Set(this.sim.graph.nodesWithin(node, hops, ["std", "shaft", "vent"], () => true));
    let s = 0;
    for (const a of this.sim.agents) {
      if (a.dead || a.hp <= 0 || a.downed) continue;
      if (a.faction === FACTION.COMBAT && near.has(a.node)) s += 1;
      else if (a.faction === FACTION.INFECTION && near.has(a.node)) s += 0.25;
    }
    return s;
  }
  // a quiet gathering point 1-2 hops from a defended target
  stagingNodeNear(target) {
    const g = this.sim.graph;
    let best = -1, bestScore = -Infinity;
    for (const n of g.nodesWithin(target, 2, ["std", "shaft"], this.bigPass)) {
      if (n === target) continue;
      const score = -this.localThreat(n) * 2 - (g.hasRole(n, "artery") ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }
  nearestBelievedHuman(from) {
    let best = -1, bestScore = -Infinity;
    for (let n = 0; n < this.sim.graph.n; n++) {
      if (this.believedHumanStr[n] <= 0.05) continue;
      if (this.sim.t < 60 && this.staticGarrison(n) > 0) continue;
      const p = this.safeAssaultPath(from, n);
      if (!p) continue;
      const s = this.believedHumanStr[n] - p.length * 0.2;
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    return best;
  }
  assign(form, task) {
    if (form.task && form.taskProgress > 0 && (form.task.kind === TASK.CONVERT || form.task.kind === TASK.REANIMATE || form.task.kind === TASK.TRANSFORM)) {
      const ct = form.task;
      const body = this.sim.byId.get(ct.corpseId ?? ct.targetId);
      const alive = ct.kind === TASK.TRANSFORM ? !form.downed && form.hp > 0 : body && !body.dead && body.damage < 100;
      if (alive) return;
    }
    const t = form.task;
    const same = t && t.kind === task.kind && t.node === task.node && t.targetId === task.targetId && t.corpseId === task.corpseId && t.muster === task.muster;
    if (!same && t) {
      if (t.corpseId !== void 0) {
        const b = this.sim.byId.get(t.corpseId);
        if (b && !b.dead) b.claimed = false;
      }
      if (t.kind === TASK.REANIMATE && t.targetId !== void 0) {
        const d = this.sim.byId.get(t.targetId);
        if (d && d.claimed) d.claimed = false;
      }
    }
    form.task = task;
    if (!same) {
      form.path = [];
      form.taskProgress = 0;
    }
    if (form.state === STATE.GRABBING) {
      form.state = STATE.IDLE;
      form.grabTimer = 0;
    }
    if (form.inShaftAmbush !== void 0 && task.kind !== TASK.AMBUSH) {
      this.sim.graph.shafts[form.inShaftAmbush]?.ambushers?.delete(form.id);
      form.inShaftAmbush = void 0;
      if (form.state === STATE.AMBUSHING) form.state = STATE.IDLE;
    }
  }
};
function isActiveFloodForm(a) {
  return (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT) && !a.downed && a.hp > 0;
}
function isLivingHuman(a) {
  return (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE) && a.hp > 0 && !a.dead;
}

// sim/floodExec.js
function updateFloodTick(sim2, dt) {
  const hive = sim2.hive;
  for (const a of sim2.agents) {
    if (a.dead) continue;
    if (a.faction === FACTION.CARRIER) {
      updateCarrier(sim2, a, dt);
      continue;
    }
    if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT) continue;
    if (a.downed) {
      if (a.reviveAt >= 0 && sim2.t >= a.reviveAt && a.damage < 100) {
        a.downed = false;
        a.reviveAt = -1;
        a.hp = a.maxHp * sim2.P.combatForm.reviveIntegrityFrac;
        a.state = STATE.IDLE;
        sim2.log("revive", `a downed combat form drags itself back up in ${sim2.graph.node(a.node).name}`);
      }
      continue;
    }
    if (a.hp <= 0) continue;
    if (a.state === STATE.GRABBING && a.task?.kind !== TASK.GRAB) {
      a.state = STATE.IDLE;
      a.grabTimer = 0;
    }
    if (a.faction === FACTION.INFECTION && !a.move && a.state !== STATE.GRABBING && a.task?.kind !== TASK.CONVERT && a.task?.kind !== TASK.REANIMATE && (sim2.hive.lastScarcity ?? 3) > 0.8) {
      const pn = a.pnode ?? a.node;
      const roomies = sim2.occupants(pn);
      const hot = roomies.some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED && h.state === STATE.FIGHT));
      const inLunge = roomies.some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE) && Math.hypot(h.x - a.x, h.y - a.y) <= sim2.P.combat.lungeRiskM);
      if (hot && !inLunge) {
        let hereDanger = 0;
        for (const h of roomies) {
          if (h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED && h.state === STATE.FIGHT)) hereDanger += 2;
        }
        let best = null, bestDanger = Infinity;
        for (const { to, link } of sim2.graph.neighbors(
          a.node,
          ["std", "vent"],
          (l) => l.kind === "std" ? !l.locked : !l.blocked
        )) {
          if (sim2.graph.burningUntil[to] > sim2.t) continue;
          let danger = link.kind === "vent" ? -0.5 : 0;
          for (const h of sim2.occupants(to)) {
            if (h.hp > 0 && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)) danger += 2;
          }
          if (danger < bestDanger) {
            bestDanger = danger;
            best = { to, link };
          }
        }
        if (best && bestDanger < hereDanger) {
          if (a.task?.corpseId !== void 0) {
            const b = sim2.byId.get(a.task.corpseId);
            if (b && !b.dead) b.claimed = false;
          }
          a.task = null;
          a.taskProgress = 0;
          a.path = [];
          sim2.setPath(a, [{ to: best.to, link: best.link, layer: best.link.kind }]);
          a.state = STATE.MOVE;
          continue;
        }
        if (hereDanger > 0) {
          let close = null, closeD = Infinity;
          for (const h of roomies) {
            if (h.hp <= 0 || h.dead) continue;
            if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
            const d = Math.hypot(h.x - a.x, h.y - a.y);
            if (d < closeD - 1e-9 || Math.abs(d - closeD) <= 1e-9 && h.id < (close?.id ?? Infinity)) {
              closeD = d;
              close = h;
            }
          }
          if (close && a.task?.targetId !== close.id) {
            hive.assign(a, { kind: TASK.GRAB, targetId: close.id });
          }
        }
      }
    }
    if (a.faction === FACTION.INFECTION && !a.downed && a.hp > 0 && a.state !== STATE.GRABBING && !a.move && a.task?.kind !== TASK.CONVERT && a.task?.kind !== TASK.REANIMATE) {
      const here = sim2.occupants(a.pnode ?? a.node);
      let gunsW = 0;
      for (const h of here) {
        if (h.hp <= 0 || h.dead) continue;
        if (h.faction === FACTION.MARINE) gunsW += 1;
        else if (h.faction === FACTION.ARMED && h.state === STATE.FIGHT) gunsW += 0.6;
      }
      const overwhelmed = gunsW > 0 && sim2.floodStrengthAt(a.pnode ?? a.node) >= gunsW * sim2.P.swarm.overwhelmRatio;
      let close = null, closeD = Infinity;
      for (const h of here) {
        if (h.hp <= 0 || h.dead) continue;
        if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
        const d = Math.hypot(h.x - a.x, h.y - a.y);
        if (d < closeD - 1e-9 || Math.abs(d - closeD) <= 1e-9 && h.id < (close?.id ?? Infinity)) {
          closeD = d;
          close = h;
        }
      }
      if (close && closeD <= sim2.P.combat.lungeRiskM) {
        if (a.task?.targetId !== close.id) hive.assign(a, { kind: TASK.GRAB, targetId: close.id });
      } else if (gunsW === 0 || overwhelmed) {
        const prey = here.find((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || overwhelmed && h.faction === FACTION.MARINE));
        if (prey && a.task?.targetId !== prey.id) {
          hive.assign(a, { kind: TASK.GRAB, targetId: prey.id });
        } else if (!prey) {
          const corpse = here.find((c) => c.faction === FACTION.CORPSE && !c.dead && c.damage < 100 && !c.claimed);
          if (corpse) {
            corpse.claimed = true;
            hive.assign(a, { kind: TASK.CONVERT, corpseId: corpse.id });
          }
        }
      }
    }
    if (a.faction === FACTION.COMBAT && a.state !== STATE.GRABBING) {
      const held = a.task && (a.task.kind === TASK.TRANSFORM || a.task.kind === TASK.AMBUSH || a.task.kind === TASK.BAIT || a.task.kind === TASK.DECOY || a.task.kind === TASK.GUARD && a.task.muster !== void 0 || a.task.kind === TASK.ATTACK && a.task.node === a.node);
      if (!held) {
        const pn = a.pnode ?? a.node;
        const prey = sim2.occupants(pn).some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE));
        if (prey) hive.assign(a, { kind: TASK.ATTACK, node: pn });
      }
    }
    const t = a.task;
    if (!t) continue;
    switch (t.kind) {
      case TASK.MOVE:
      case TASK.SCOUT:
      case TASK.GUARD:
        moveToward(sim2, a, t.node);
        if (a.node === t.node && !a.move && (t.kind === TASK.MOVE || t.kind === TASK.SCOUT)) a.task = null;
        break;
      case TASK.ATTACK:
        moveToward(sim2, a, t.node, (from, to) => hive.safeAssaultPath(from, to));
        if (a.node === t.node && !a.move) {
          let preyNode = -1;
          for (const n of sim2.floodSenses(a.node)) {
            if (sim2.occupants(n).some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE))) {
              preyNode = n;
              break;
            }
          }
          if (preyNode === -1) a.task = null;
          else if (preyNode !== a.node) {
            let def = 0;
            for (const h of sim2.occupants(preyNode)) {
              if (h.hp <= 0 || h.dead) continue;
              if (h.faction === FACTION.MARINE) def += 1;
              else if (h.faction === FACTION.ARMED) def += 0.6;
            }
            const local = sim2.floodStrengthAt(a.node) + sim2.floodStrengthAt(preyNode);
            if (def === 0 || hive.allIn || local >= def * sim2.P.swarm.killRatio) t.node = preyNode;
          }
        }
        break;
      case TASK.GRAB: {
        const target = sim2.byId.get(t.targetId);
        if (!target || target.dead || target.hp <= 0) {
          a.task = null;
          if (a.state === STATE.GRABBING) {
            a.state = STATE.IDLE;
            a.grabTimer = 0;
          }
          break;
        }
        const believed = hive.beliefs.get(t.targetId);
        const goal = sim2.floodSenses(a.node).includes(target.node) ? target.node : believed?.node ?? target.node;
        const samePhys = (a.pnode ?? a.node) === (target.pnode ?? target.node) && a.deck === target.deck;
        if (samePhys && Math.hypot(target.x - a.x, target.y - a.y) <= sim2.P.combat.grabRangeM) {
          a.state = STATE.GRABBING;
          a.move = null;
          a.path = [];
          if (sim2.P.combat.grabPins) target.held = sim2.tickCount;
          sim2.hurtHuman(target, sim2.P.combat.latchDps * dt, a.id);
          a.grabTimer += dt;
          a.x = target.x - Math.cos(target.heading) * 0.45;
          a.y = target.y - Math.sin(target.heading) * 0.45;
          a.heading = target.heading;
          const need = target.faction === FACTION.CIVILIAN ? sim2.P.combat.civilianGrabSec : sim2.P.combat.infectionGrabSec;
          if (a.grabTimer >= need && !target.dead) convertHuman(sim2, a, target);
        } else if (samePhys && a.grabTimer > 0) {
          a.x = target.x - Math.cos(target.heading) * 0.45;
          a.y = target.y - Math.sin(target.heading) * 0.45;
        } else if (samePhys) {
          a.state = STATE.MOVE;
          a.grabTimer = 0;
        } else if (target.faction === FACTION.MARINE) {
          a.task = null;
          a.state = STATE.IDLE;
          a.grabTimer = 0;
        } else {
          a.state = STATE.MOVE;
          a.grabTimer = 0;
          moveToward(sim2, a, goal, hive.safeInfectionPath.bind(hive));
          if (!a.move && !a.path.length && a.node !== goal) a.task = null;
        }
        break;
      }
      case TASK.CONVERT: {
        const body = sim2.byId.get(t.corpseId);
        if (!body || body.dead || body.damage >= 100) {
          a.task = null;
          break;
        }
        if (a.node === body.node && !a.move) {
          const dx = body.x - a.x, dy = body.y - a.y;
          if (a.taskProgress === 0 && Math.hypot(dx, dy) > 0.35) {
            a.x += dx * Math.min(1, dt * 5);
            a.y += dy * Math.min(1, dt * 5);
            a.heading = Math.atan2(dy, dx);
            a.animTime += dt;
            break;
          }
          a.x = body.x;
          a.y = body.y;
          a.taskProgress += dt;
          if (a.taskProgress >= sim2.P.combat.corpseConvertSec) {
            body.dead = true;
            const cf = spawnCombatForm(sim2, a.node, body);
            cf.hostArmed = body.wasArmed === true;
            sim2.stats.conversions++;
            sim2.stats.conversionsRound++;
            sim2.removeAgent(a);
            sim2.log("convert", `a corpse rises as a combat form in ${sim2.graph.node(a.node).name}`);
          }
        } else moveToward(sim2, a, body.node, hive.safeInfectionPath.bind(hive));
        break;
      }
      case TASK.TRANSFORM: {
        if (a.faction !== FACTION.COMBAT || a.downed || a.fromPlayer) {
          a.task = null;
          break;
        }
        if (a.move) break;
        a.taskProgress += dt;
        if (a.taskProgress >= sim2.P.carrier.transformSec) {
          const carrier = makeAgent(FACTION.CARRIER, a.node, sim2.graph);
          carrier.hp = carrier.maxHp = sim2.P.combat.carrierHp;
          carrier.state = STATE.INCUBATING;
          carrier.mintTimer = a.taskProgress;
          sim2.spawn(carrier);
          sim2.removeAgent(a);
          sim2.stats.carriersSeated++;
          sim2.log("carrier", `a combat form roots into a carrier in ${sim2.graph.node(a.node).name} — incubation begins`);
        }
        break;
      }
      case TASK.REANIMATE: {
        const target = sim2.byId.get(t.targetId);
        if (!target || target.dead || !target.downed || target.damage >= 100) {
          a.task = null;
          break;
        }
        if (a.node === target.node && !a.move) {
          const dx = target.x - a.x, dy = target.y - a.y;
          if (a.taskProgress === 0 && Math.hypot(dx, dy) > 0.35) {
            a.x += dx * Math.min(1, dt * 5);
            a.y += dy * Math.min(1, dt * 5);
            a.heading = Math.atan2(dy, dx);
            a.animTime += dt;
            break;
          }
          a.x = target.x;
          a.y = target.y;
          a.taskProgress += dt;
          if (a.taskProgress >= sim2.P.combatForm.reanimateTimeSec) {
            target.downed = false;
            target.reviveAt = -1;
            target.hp = target.maxHp * sim2.P.combatForm.reanimateIntegrityFrac;
            sim2.removeAgent(a);
            sim2.log("reanimate", `the hive spends a form to reanimate a body in ${sim2.graph.node(target.node).name}`);
          }
        } else moveToward(sim2, a, target.node, hive.safeInfectionPath.bind(hive));
        break;
      }
      case TASK.DRAG: {
        const body = sim2.byId.get(t.corpseId);
        if (!body || body.dead || body.damage >= 100) {
          a.task = null;
          a.dragging = -1;
          break;
        }
        if (a.dragging !== body.id && a.node === body.node && !a.move) a.dragging = body.id;
        if (a.dragging === body.id) {
          body.node = a.node;
          body.x = a.x;
          body.y = a.y - 4;
          if (a.node === t.node && !a.move) {
            a.dragging = -1;
            a.task = null;
            body.claimed = false;
          } else moveToward(sim2, a, t.node);
        } else moveToward(sim2, a, body.node);
        break;
      }
      case TASK.AMBUSH: {
        const link = sim2.graph.shafts[t.linkIdx];
        if (a.inShaftAmbush === t.linkIdx) break;
        if (a.node === t.end && !a.move) {
          a.inShaftAmbush = t.linkIdx;
          a.state = STATE.AMBUSHING;
          (link.ambushers ??= /* @__PURE__ */ new Set()).add(a.id);
        } else moveToward(sim2, a, t.end);
        break;
      }
      case TASK.DECOY: {
        if (t.stage === 0) {
          if (a.node !== t.show) moveToward(sim2, a, t.show);
          else {
            const seen = sim2.occupantsNear(a.node, 1).some((h) => !h.dead && h.hp > 0 && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED));
            if (seen) {
              t.stage = 1;
              const quiet = hive.quietNodeNear(a.node, "big");
              t.hide = quiet !== -1 ? quiet : a.node;
              sim2.log("bait", "the decoy has been spotted — it melts away");
            }
          }
        } else {
          if (a.node !== t.hide) moveToward(sim2, a, t.hide);
          else if (!a.move) a.task = null;
        }
        break;
      }
      case TASK.BAIT: {
        const squad = sim2.squads[t.squadId];
        const shaft = sim2.graph.shafts[t.shaftIdx];
        if (!squad || squad.broken) {
          a.task = null;
          break;
        }
        if (t.stage === 0) {
          if (a.node !== t.mouth) moveToward(sim2, a, t.mouth);
          else {
            const seen = sim2.occupantsNear(a.node, 1).some((h) => h.faction === FACTION.MARINE && h.hp > 0);
            if (seen) {
              t.stage = 1;
              sim2.log("bait", "the bait shows itself and slips into the shaft");
            }
          }
        } else {
          const far = a.node === shaft.a ? shaft.b : shaft.a;
          if (a.node === shaft.a || a.node === shaft.b) {
            if (!a.move) sim2.setPath(a, [{ to: far, link: shaft, layer: "shaft" }]);
          } else if (!a.move && !a.path.length) a.task = null;
        }
        break;
      }
    }
  }
}
function moveToward(sim2, a, node, pathFn = null) {
  if (a.move || a.path.length || a.node === node) return;
  const hive = sim2.hive;
  let path;
  if (pathFn) path = pathFn(a.node, node);
  else if (a.faction === FACTION.INFECTION) path = hive.safeInfectionPath(a.node, node);
  else path = hive.safeAssaultPath(a.node, node) ?? sim2.graph.path(a.node, node, ["std", "shaft", "vent"], hive.combatPass);
  if (path && path.length) sim2.setPath(a, path);
  else if (!path) a.task = null;
}
function spawnCombatForm(sim2, node, at = null) {
  const f = makeAgent(FACTION.COMBAT, node, sim2.graph);
  const cf = sim2.P.combat.combatForm;
  const j = 1 + sim2.rng.range(-cf.hpJitter, cf.hpJitter);
  f.hp = f.maxHp = cf.hp * j;
  if (at) {
    f.x = at.x;
    f.y = at.y;
  }
  sim2.spawn(f);
  return f;
}
function updateCarrier(sim2, a, dt) {
  const P = sim2.P;
  if (a.hp <= 0 || a.dead) return;
  a.mintTimer += dt;
  if (sim2.agents.reduce((n, x) => n + (!x.dead && x.faction === FACTION.INFECTION ? 1 : 0), 0) >= P.carrier.productionBackpressure) return;
  const due = a.held === 0 ? P.carrier.firstIncubationSec : P.carrier.incubationIntervalSec;
  if (a.mintTimer >= due && a.held < P.carrier.maxInfectionForms) {
    a.mintTimer = 0;
    a.held++;
    if (a.held === 1) sim2.log("carrier", `the carrier in ${sim2.graph.node(a.node).name} begins to swell`);
  }
  if (a.held >= P.carrier.maxInfectionForms) {
    explodeCarrier(sim2, a);
    return;
  }
  if (a.held >= P.carrier.maxInfectionForms * P.carrier.seekOrExplodeFraction) {
    const nearHumans = sim2.occupantsNear(a.node, 1).filter((h) => h.hp > 0 && (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE));
    if (nearHumans.length && !a.move && !a.path.length && nearHumans[0].node !== a.node) {
      const path = sim2.graph.path(a.node, nearHumans[0].node, ["std"], sim2.hive.bigPass);
      if (path) sim2.setPath(a, path);
    }
  }
}
function explodeCarrier(sim2, a) {
  if (a.dead) return;
  a.dead = true;
  const P = sim2.P;
  for (const h of sim2.agents) {
    if (h.dead || h.hp <= 0 || h.deck !== a.deck) continue;
    if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
    if ((h.pnode ?? h.node) !== (a.pnode ?? a.node)) continue;
    if (Math.hypot(h.x - a.x, h.y - a.y) <= P.carrier.explodeRadiusM) {
      sim2.hurtHuman(h, P.carrier.explodeDamage);
    }
  }
  const room = sim2.graph.node(a.node);
  const n = a.held ?? 0;
  for (let i = 0; i < n; i++) {
    const f = makeAgent(FACTION.INFECTION, a.node, sim2.graph);
    f.hp = f.maxHp = 1;
    const ang = i * 2.399963;
    const r = 0.6 + 0.22 * i;
    f.x = Math.max(room.x - room.w / 2 + 0.4, Math.min(room.x + room.w / 2 - 0.4, a.x + Math.cos(ang) * r));
    f.y = Math.max(room.y - room.d / 2 + 0.4, Math.min(room.y + room.d / 2 - 0.4, a.y + Math.sin(ang) * r));
    sim2.spawn(f);
  }
  sim2.stats.formsMinted += n;
  sim2.log("carrier", `a carrier ruptures in ${sim2.graph.node(a.node).name} — ${n} infection form${n === 1 ? "" : "s"} spill out`);
}
function convertHuman(sim2, form, target) {
  if (target.hasRadio && !target.calledOut) {
    target.calledOut = true;
    if (sim2.rng.chance(0.5)) sim2.emitCall(target);
  }
  target.dead = true;
  const cf = spawnCombatForm(sim2, target.node, target);
  cf.hostArmed = target.faction === FACTION.ARMED || target.faction === FACTION.MARINE;
  if (target.isPlayer) {
    cf.fromPlayer = true;
    sim2.playerConvertedTo = cf.id;
  }
  sim2.removeAgent(form);
  sim2.stats.conversions++;
  sim2.stats.conversionsRound++;
  sim2.stats.humansConverted++;
  sim2.log("convert", `${factionName(target.faction)} taken in ${sim2.graph.node(target.node).name} — a new combat form stands up`);
}
function factionName(f) {
  return f === FACTION.CIVILIAN ? "a civilian" : f === FACTION.ARMED ? "an armed crewman" : "a marine";
}

// sim/combat.js
function resolveCombat(sim2, dt) {
  const P = sim2.P;
  const groups = /* @__PURE__ */ new Map();
  for (const a of sim2.agents) {
    if (a.dead) continue;
    let key;
    if (a.move && a.move.layer === "vent" && a.move.hidden) key = `Lvent${a.move.link.i}`;
    else if (a.move && a.move.layer === "shaft" && a.move.hidden && sim2.graph.node(a.move.link.a).deck !== sim2.graph.node(a.move.link.b).deck) {
      key = `Lshaft${a.move.link.i}`;
    } else key = `N${a.pnode ?? a.node}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(a);
  }
  for (const [key, group] of groups) {
    if (!key.startsWith("Lshaft")) continue;
    const linkIdx = Number(key.slice(6));
    const shaft = sim2.graph.shafts[linkIdx];
    const ambushers = [...shaft.ambushers ?? []].map((id) => sim2.byId.get(id)).filter((x) => x && !x.dead && x.hp > 0);
    for (const mover of group) {
      if (mover.firstStruckIn === linkIdx) continue;
      for (const amb of ambushers) {
        if (amb.faction === mover.faction) continue;
        const hostile = isFlood(amb) !== isFlood(mover);
        if (!hostile) continue;
        mover.firstStruckIn = linkIdx;
        const dps = amb.faction === FACTION.COMBAT ? P.combat.combatForm.dps : P.combat.marine.dps;
        const strike = dps * P.ambush.firstStrikeMult;
        sim2.log("ambush", `ambush sprung in the ${sim2.graph.node(shaft.a).name} ↔ ${sim2.graph.node(shaft.b).name} shaft`);
        if (isFlood(mover)) hurtFloodForm(sim2, mover, strike, false, amb.id);
        else sim2.hurtHuman(mover, strike, amb.id);
      }
    }
    for (const amb of ambushers) {
      const foes = group.filter((m) => isFlood(m) !== isFlood(amb) && m.hp > 0 && !m.dead);
      for (const foe of foes) {
        const dps = amb.faction === FACTION.COMBAT ? P.combat.combatForm.dps : P.combat.marine.dps;
        if (isFlood(foe)) hurtFloodForm(sim2, foe, dps * dt, false);
        else sim2.hurtHuman(foe, dps * dt);
      }
    }
    const shooters = group.filter((a) => a.hp > 0 && !a.dead && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED && a.state === STATE.FIGHT));
    const combatForms = group.filter((a) => a.faction === FACTION.COMBAT && !a.downed && a.hp > 0 && !a.dead);
    const carriers = group.filter((a) => a.faction === FACTION.CARRIER && a.hp > 0 && !a.dead);
    const humans = group.filter((a) => a.hp > 0 && !a.dead && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
    if (shooters.length && (combatForms.length || carriers.length)) {
      sim2.gunfireAt(shaft.a);
      sim2.gunfireAt(shaft.b);
      let pool = shooters.reduce((s, a) => s + (a.faction === FACTION.MARINE ? P.combat.marine.dps : P.combat.armed.dps), 0) * dt;
      for (const t of [...combatForms, ...carriers].sort((a, b) => a.id - b.id)) {
        if (pool <= 0) break;
        const d = Math.min(pool, t.hp);
        pool -= d;
        hurtFloodForm(sim2, t, d, false);
      }
    }
    if (combatForms.length && humans.length) {
      let pool = combatForms.reduce((s, f) => s + P.combat.combatForm.dps + (f.hostArmed ? P.combat.hostWeaponDps : 0), 0) * dt;
      for (const v of humans.sort((a, b) => rank(a) - rank(b) || a.id - b.id)) {
        if (pool <= 0) break;
        const d = Math.min(pool, v.hp);
        pool -= d;
        sim2.hurtHuman(v, d);
      }
    }
  }
  for (const [key, group] of groups) {
    if (!key.startsWith("N")) continue;
    const node = Number(key.slice(1));
    const shooters = group.filter((a) => a.hp > 0 && !a.dead && (a.faction === FACTION.MARINE && !sim2.squads[a.squad]?.broken || a.faction === FACTION.MARINE || a.faction === FACTION.ARMED && a.state === STATE.FIGHT));
    const combatForms = group.filter((a) => a.faction === FACTION.COMBAT && !a.downed && a.hp > 0 && !a.dead);
    const infForms = group.filter((a) => a.faction === FACTION.INFECTION && a.hp > 0 && !a.dead);
    const carriers = group.filter((a) => a.faction === FACTION.CARRIER && a.hp > 0 && !a.dead);
    const downedForms = group.filter((a) => a.faction === FACTION.COMBAT && a.downed && !a.dead && a.damage < 100);
    const anyFlood = combatForms.length + infForms.length + carriers.length > 0;
    if (!shooters.length && !anyFlood) continue;
    if (shooters.length && anyFlood) {
      sim2.gunfireAt(node);
      const flamer = shooters.find((s) => s.flamer && s.fuel > 0);
      const targets = [...combatForms, ...carriers].sort((a, b) => a.id - b.id);
      if (flamer && targets.length) {
        flamer.fuel = Math.max(0, flamer.fuel - P.flamethrower.fuelPerSec * dt);
        sim2.graph.burningUntil[node] = sim2.t + P.flamethrower.burnNodeSec;
        let flamePool = P.flamethrower.dps * dt;
        for (const t of targets) {
          if (flamePool <= 0) break;
          const d = Math.min(flamePool, t.hp);
          flamePool -= d;
          hurtFloodForm(sim2, t, d, true);
        }
      }
      for (const s of shooters) {
        if (s === flamer) continue;
        if (sim2.t < (s.nextShotAt ?? 0)) continue;
        let best = null, bestD = Infinity;
        for (const t of [...targets, ...infForms]) {
          if (t.hp <= 0 || t.dead) continue;
          const bias = t.faction === FACTION.CARRIER ? 1e3 : t.faction === FACTION.INFECTION ? 500 : 0;
          const d = Math.hypot(t.x - s.x, t.y - s.y) + bias;
          if (d < bestD - 1e-9 || Math.abs(d - bestD) <= 1e-9 && t.id < (best?.id ?? Infinity)) {
            bestD = d;
            best = t;
          }
        }
        if (!best) break;
        const gun = s.faction === FACTION.MARINE ? P.combat.marine.gun : P.combat.armed.gun;
        s.nextShotAt = sim2.t + 1 / gun.rof;
        const range = Math.hypot(best.x - s.x, best.y - s.y);
        let acc2 = range <= P.combat.rifleFalloffM ? gun.accNear : gun.accFar;
        if (best.faction === FACTION.INFECTION) acc2 *= P.combat.podAccMult;
        if (sim2.darkAt(node)) acc2 *= P.darkness.darkAccMult;
        if (sim2.fogAt(node)) acc2 *= P.darkness.fogAccMult;
        if (sim2.rng.chance(acc2)) {
          if (best.faction === FACTION.INFECTION) {
            sim2.removeAgent(best);
            sim2.stats.infectionFormsKilled++;
          } else hurtFloodForm(sim2, best, gun.dmg, false, s.id);
        }
      }
      let stomps = shooters.reduce((s, a) => s + (a.faction === FACTION.MARINE ? P.combat.marine.stompPerSec : P.combat.armed.stompPerSec) * (a.held === sim2.tickCount ? 0.5 : 1), 0) * dt;
      for (const f of [...infForms].sort((a, b) => a.id - b.id)) {
        if (stomps <= 0) break;
        if (!shooters.some((s) => Math.hypot(s.x - f.x, s.y - f.y) <= P.combat.stompRangeM)) continue;
        if (sim2.rng.chance(Math.min(1, stomps))) {
          sim2.removeAgent(f);
          sim2.stats.infectionFormsKilled++;
        }
        stomps -= 1;
      }
    } else if (shooters.length && downedForms.length) {
      const marines = shooters.filter((s) => s.faction === FACTION.MARINE);
      if (marines.length) {
        const t = downedForms.sort((a, b) => a.id - b.id)[0];
        t.damage = Math.min(100, t.damage + 40 * dt * marines.length);
        if (t.damage >= 100) sim2.log("combat", `marines make sure of a downed form in ${sim2.graph.node(node).name}`);
      }
    }
    if (combatForms.length) {
      const victims = group.filter((a) => a.hp > 0 && !a.dead && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
      if (victims.length) {
        let fired = false;
        for (const f of [...combatForms].sort((a, b) => a.id - b.id)) {
          let best = null, bestScore = Infinity;
          for (const v of victims) {
            if (v.hp <= 0 || v.dead) continue;
            const d = Math.hypot(v.x - f.x, v.y - f.y);
            const grudge = v.id === f.lastHurtBy && d < 8 && sim2.tickCount - (f.lastHurtTick ?? -999) < 30 ? -6 : 0;
            const score = d + rank(v) * 0.5 + grudge + v.id * 1e-6;
            if (score < bestScore) {
              bestScore = score;
              best = v;
            }
          }
          if (!best) break;
          const range = Math.hypot(best.x - f.x, best.y - f.y);
          if (range <= P.combat.meleeRangeM && sim2.t >= (f.nextSwingAt ?? 0)) {
            f.nextSwingAt = sim2.t + P.combat.combatForm.swing.cooldownSec;
            sim2.hurtHuman(best, P.combat.combatForm.swing.dmg, f.id);
          }
          if (f.hostArmed && sim2.t >= (f.nextHostShotAt ?? 0)) {
            f.nextHostShotAt = sim2.t + 1 / P.combat.hostGun.rof;
            fired = true;
            const acc2 = range <= P.combat.rifleFalloffM ? P.combat.hostGun.accNear : P.combat.hostGun.accFar;
            if (sim2.rng.chance(acc2)) sim2.hurtHuman(best, P.combat.hostGun.dmg, f.id);
          }
        }
        if (fired) sim2.gunfireAt(node);
      }
    }
    for (const c of carriers) {
      if (shooters.length && c.hp < c.maxHp * 0.5) explodeCarrier(sim2, c);
    }
  }
  for (const s of sim2.graph.stairwells) {
    for (const [gunNode, floodNode] of [[s.upper, s.lower], [s.lower, s.upper]]) {
      const shooters = sim2.occupants(gunNode).filter((a) => a.hp > 0 && !a.dead && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED && a.state === STATE.FIGHT));
      if (!shooters.length) continue;
      const gn = sim2.graph.node(gunNode);
      const targets = sim2.occupants(floodNode).filter((a) => !a.dead && a.hp > 0 && !a.downed && (a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER));
      if (!targets.length) continue;
      sim2.gunfireAt(gunNode);
      for (const sh of shooters) {
        if (sim2.t < (sh.nextShotAt ?? 0)) continue;
        let best = null, bestD = Infinity;
        for (const t of targets) {
          const d = Math.hypot(t.x - sh.x, t.y - sh.y) + (t.faction === FACTION.CARRIER ? 1e3 : 0);
          if (d < bestD - 1e-9 || Math.abs(d - bestD) <= 1e-9 && t.id < (best?.id ?? Infinity)) {
            bestD = d;
            best = t;
          }
        }
        if (!best) break;
        const gun = sh.faction === FACTION.MARINE ? P.combat.marine.gun : P.combat.armed.gun;
        sh.nextShotAt = sim2.t + 1 / gun.rof;
        let acc2 = gun.accFar;
        if (sim2.darkAt(gunNode) || sim2.darkAt(floodNode)) acc2 *= P.darkness.darkAccMult;
        if (sim2.fogAt(gunNode) || sim2.fogAt(floodNode)) acc2 *= P.darkness.fogAccMult;
        if (sim2.rng.chance(acc2)) hurtFloodForm(sim2, best, gun.dmg, false, sh.id);
      }
    }
  }
}
function rank(a) {
  return a.faction === FACTION.MARINE ? 0 : a.faction === FACTION.ARMED ? 1 : 2;
}
function isFlood(a) {
  return a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER;
}
function hurtFloodForm(sim2, a, dmg, isFlame, by = -1) {
  const P = sim2.P;
  if (by >= 0 && dmg > 0) {
    a.lastHurtBy = by;
    a.lastHurtTick = sim2.tickCount;
  }
  if (a.faction === FACTION.INFECTION) {
    if (isFlame) a.damage = 100;
    sim2.removeAgent(a);
    sim2.stats.infectionFormsKilled++;
    return;
  }
  a.hp -= dmg;
  if (isFlame) a.damage = Math.min(100, a.damage + dmg * 2);
  else if (a.downed) a.damage = Math.min(100, a.damage + dmg);
  if (a.hp <= 0 && !a.downed) {
    if (isFlame) a.damage = 100;
    if (a.faction === FACTION.CARRIER) {
      explodeCarrier(sim2, a);
      return;
    }
    a.hp = 0;
    a.downed = true;
    a.state = STATE.DOWNED;
    a.task = null;
    a.path = [];
    a.move = null;
    if (a.inShaftAmbush !== void 0) clearAmbush(sim2, a);
    sim2.stats.combatFormsDowned++;
    if (a.damage < 100 && sim2.rng.chance(P.combatForm.selfReviveChance)) {
      a.reviveAt = sim2.t + sim2.rng.range(0, P.combatForm.selfReviveWindowSec);
    }
    if (a.damage >= 100) a.dead = false;
  }
}
function clearAmbush(sim2, a) {
  const shaft = sim2.graph.shafts[a.inShaftAmbush];
  shaft?.ambushers?.delete(a.id);
  a.inShaftAmbush = void 0;
}
function humanDeathToCorpse(sim2, a) {
  a.dead = true;
  const corpse = makeAgent(FACTION.CORPSE, a.node, sim2.graph);
  corpse.state = STATE.DEAD;
  corpse.damage = 15;
  corpse.x = a.x;
  corpse.y = a.y;
  corpse.wasArmed = a.faction === FACTION.ARMED || a.faction === FACTION.MARINE;
  sim2.spawn(corpse);
}

// sim/commands.js
var CMD = {
  // squad orders (companion spec §2.2) — override autonomous behavior
  MOVE_TO: "MOVE_TO",
  // {squadId, node}
  GUARD: "GUARD",
  // {squadId, node}
  HOLD_CHOKE: "HOLD_CHOKE",
  // {squadId, edgeIdx}
  PATROL: "PATROL",
  // {squadId, route: node[]}
  RESPOND: "RESPOND",
  // {squadId, callId}
  SET_CALL_POLICY: "SET_CALL_POLICY",
  // {squadId, policy: 'auto'|'ignore'}
  ESCORT: "ESCORT",
  // {squadId, entityId}
  FALL_BACK: "FALL_BACK",
  // {squadId, node}
  RELEASE: "RELEASE",
  // {squadId}
  // ship control (also shared-state mutations, so also commands)
  SET_DOOR: "SET_DOOR",
  // {edgeIdx, locked} — throw a blast door
  DESIGNATE_BURN: "DESIGNATE_BURN"
  // {node} — order the flamethrower here
  // post-POC hook: avatar-caused mutations land here as HIT/BURN commands
  // (companion spec §3.6). Left defined so the apply switch is the one place
  // multiplayer wires into.
};
var CommandQueue = class {
  constructor() {
    this.pending = [];
    this.seq = 0;
    this.log = [];
  }
  // Stamp and enqueue. peerId defaults to 0 (the local single-player commander).
  enqueue(cmd, targetTick, peerId = 0) {
    this.pending.push({ targetTick, peerId, seq: this.seq++, cmd });
  }
  // Drain every command due on `tick`, in deterministic order. The lockstep
  // barrier (§3.4) lives above this in multiplayer; single-player is never
  // blocked because the sole producer stamps into the future by inputDelay.
  collect(tick) {
    if (!this.pending.length) return [];
    const due = [];
    const keep = [];
    for (const e of this.pending) (e.targetTick <= tick ? due : keep).push(e);
    this.pending = keep;
    due.sort((a, b) => a.targetTick - b.targetTick || a.peerId - b.peerId || a.seq - b.seq);
    return due;
  }
};

// sim/commandApply.js
function applyCommand(sim2, entry) {
  const { cmd, peerId } = entry;
  const g = sim2.graph;
  const squad = cmd.squadId !== void 0 ? sim2.squads[cmd.squadId] : null;
  const delivered = () => {
    if (!squad) return true;
    const leader = sim2.byId.get(squad.members[0]);
    if (!leader || leader.dead) return false;
    const deckPowered = !g.unpowered[leader.node];
    const rel = sim2.P.command.linkReliability * (deckPowered ? 1 : 0.4);
    if (!sim2.rng.chance(rel)) {
      sim2.log("command", `order to squad ${cmd.squadId + 1} lost (comms damage) — it stays autonomous`);
      return false;
    }
    return true;
  };
  switch (cmd.type) {
    case CMD.MOVE_TO:
      if (squad && delivered()) setOrder(sim2, squad, { kind: "order:move", node: cmd.node }, `move to ${g.node(cmd.node).name}`, peerId);
      break;
    case CMD.GUARD:
      if (squad && delivered()) setOrder(sim2, squad, { kind: "order:guard", node: cmd.node }, `guard ${g.node(cmd.node).name}`, peerId);
      break;
    case CMD.HOLD_CHOKE: {
      if (squad && delivered()) {
        const e = g.edges[cmd.edgeIdx];
        setOrder(sim2, squad, { kind: "order:guard", node: e.a, choke: cmd.edgeIdx }, `hold the ${g.node(e.a).name}↔${g.node(e.b).name} chokepoint`, peerId);
      }
      break;
    }
    case CMD.PATROL:
      if (squad && delivered()) setOrder(sim2, squad, { kind: "order:patrol", route: cmd.route.slice(), leg: 0 }, `patrol ${cmd.route.length} nodes`, peerId);
      break;
    case CMD.RESPOND: {
      if (squad && delivered()) {
        const call = sim2.calls.find((c) => c.id === cmd.callId);
        if (call) setOrder(sim2, squad, { kind: "order:move", node: call.node, respond: cmd.callId }, `respond to ${g.node(call.node).name}`, peerId);
      }
      break;
    }
    case CMD.SET_CALL_POLICY:
      if (squad && delivered()) {
        squad.callPolicy = cmd.policy;
        sim2.log("command", `squad ${cmd.squadId + 1} call policy → ${cmd.policy}`);
      }
      break;
    case CMD.ESCORT:
      if (squad && delivered()) setOrder(sim2, squad, { kind: "order:escort", entityId: cmd.entityId }, `escort #${cmd.entityId}`, peerId);
      break;
    case CMD.FALL_BACK:
      if (squad && delivered()) setOrder(sim2, squad, { kind: "order:move", node: cmd.node, fallback: true }, `fall back to ${g.node(cmd.node).name}`, peerId);
      break;
    case CMD.RELEASE:
      if (squad && delivered()) {
        squad.order = null;
        sim2.log("command", `squad ${cmd.squadId + 1} released to autonomous behavior`);
      }
      break;
    case CMD.SET_DOOR: {
      const e = g.edges[cmd.edgeIdx];
      if (!e || !e.lockable) break;
      if (cmd.locked && (g.unpowered[e.a] || g.unpowered[e.b])) {
        sim2.log("command", `cannot seal ${g.node(e.a).name}↔${g.node(e.b).name} — no power`);
        break;
      }
      e.locked = !!cmd.locked;
      sim2._precomputeSensing();
      sim2.log("command", `${cmd.locked ? "sealed" : "opened"} ${g.node(e.a).name}↔${g.node(e.b).name}`);
      break;
    }
    case CMD.DESIGNATE_BURN:
      sim2.burnOrderNode = cmd.node;
      sim2.log("command", `flamethrower directed to ${g.node(cmd.node).name}`);
      break;
  }
}
function setOrder(sim2, squad, order, desc, peerId) {
  squad.order = order;
  squad.orderBy = peerId;
  sim2.log("command", `squad ${squad.id + 1}: ${desc}`);
}

// sim/sim.js
var TINT = {
  [FACTION.CIVILIAN]: 15921906,
  [FACTION.ARMED]: 15255616,
  [FACTION.MARINE]: 5082864,
  [FACTION.INFECTION]: 5373802,
  [FACTION.COMBAT]: 11023402,
  [FACTION.CARRIER]: 11624409,
  [FACTION.CORPSE]: 9079434
};
var Sim = class {
  constructor(seed, paramOverrides = null) {
    this.seed = String(seed);
    this.P = cloneParams();
    if (paramOverrides) deepMerge(this.P, paramOverrides);
    this.rng = new RNG(this.seed);
    this.t = 0;
    this.tickCount = 0;
    this.dt = 1 / this.P.sim.tickHz;
    this.strategicEvery = Math.round(this.P.sim.strategicTickSec * this.P.sim.tickHz);
    const { graph, agents, squads } = initRun(this.seed, this.rng, this.P);
    this.graph = graph;
    this.agents = agents;
    this.squads = squads;
    this.byId = new Map(agents.map((a) => [a.id, a]));
    this._deckRooms = {};
    for (const n of graph.nodes) (this._deckRooms[n.deck] ??= []).push(n);
    this.buffer = new AgentBuffer(512);
    this.commands = new CommandQueue();
    this.events = [];
    this.calls = [];
    this.callSeq = 0;
    this.floodKnown = false;
    this.firstSweepCleared = false;
    this.burnOrderNode = -1;
    this.lastStand = false;
    this.initialSquadMarines = agents.filter((a) => a.faction === FACTION.MARINE && !a.garrison && !a.odst).length;
    this.armoryStock = this.P.armory.stock;
    this.armoryLocked = true;
    this.outcome = null;
    this.stats = {
      conversions: 0,
      conversionsRound: 0,
      humansConverted: 0,
      carriersSeated: 0,
      formsMinted: 0,
      corpsesBurned: 0,
      infectionFormsKilled: 0,
      combatFormsDowned: 0,
      humansDead: 0,
      distressCalls: 0
    };
    this._precomputeSensing();
    this.influence = {
      floodStr: new Float32Array(graph.n),
      humanStr: new Float32Array(graph.n),
      hardness: new Float32Array(graph.n)
    };
    this._floodAt = new Float32Array(graph.n);
    this._humanAt = new Uint16Array(graph.n);
    this.floodHoldSec = new Float64Array(graph.n);
    this.gunfireTick = new Int32Array(graph.n).fill(-9999);
    this.screamTick = new Int32Array(graph.n).fill(-9999);
    this.sweptAt = new Float64Array(graph.n).fill(-9999);
    this._panicked = new Uint8Array(graph.n);
    this.fires = [];
    {
      const br = graph.node(graph.breachNode);
      this.fires.push({
        deck: br.deck,
        node: br.idx,
        x: br.x + this.rng.range(-br.w / 4, br.w / 4),
        y: br.y + this.rng.range(-br.d / 4, br.d / 4),
        scale: 1.7
      });
      const brokenDoors = graph.edges.filter((e) => e.locked && e.door && graph.node(e.a).deck === graph.node(e.b).deck);
      const count = Math.min(brokenDoors.length, 2 + this.rng.int(3));
      for (let i = 0; i < count; i++) {
        const e = brokenDoors.splice(this.rng.int(brokenDoors.length), 1)[0];
        e.burning = true;
        this.fires.push({ deck: graph.node(e.a).deck, node: e.a, x: e.door.x, y: e.door.y, scale: 0.9 });
      }
      for (const a of this.agents) {
        for (const f of this.fires) {
          if (a.deck !== f.deck) continue;
          const R = this.P.fire.radiusM * f.scale;
          const dx = a.x - f.x, dy = a.y - f.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R) continue;
          if (a.faction === FACTION.CORPSE) {
            a.damage = 100;
            continue;
          }
          const d = Math.sqrt(d2) || 1e-3;
          const room = graph.node(a.node);
          const hw = Math.max(0.4, room.w / 2 - 0.3), hd = Math.max(0.4, room.d / 2 - 0.3);
          a.x = Math.max(room.x - hw, Math.min(room.x + hw, f.x + dx / d * (R + 0.6)));
          a.y = Math.max(room.y - hd, Math.min(room.y + hd, f.y + dy / d * (R + 0.6)));
        }
      }
    }
    this.hive = new Hive(this);
    assignFirstSweep(this);
    this._refreshOccupancy();
    this._computeInfluence();
    this.log("init", `seed "${this.seed}" — breach at ${graph.node(graph.breachNode).name}, ${agents.filter(isLivingHuman).length} souls aboard · flood ${this.P.flood.initialInfectionForms}i/${this.P.flood.initialCombatForms}c/${this.P.flood.initialCarriers}k · marines ${this.P.marines.squads}×${this.P.marines.squadSize} + ${this.P.marines.patrols} patrols + ${this.P.marines.garrison} garrison · ${this.P.crew.civilians} civ / ${this.P.crew.armedCrew} armed · ${this.P.bodies.eventCorpses} bodies`);
    this.writeBuffer();
  }
  // --- sensing precomputation: locks are fixed for the whole run ---
  _precomputeSensing() {
    const g = this.graph;
    this.visCache = [];
    this.senseCache = [];
    this.hear2 = [];
    this.hear3 = [];
    this.near1 = [];
    for (let i = 0; i < g.n; i++) {
      const vis = [i];
      const sense = [i];
      for (const { to, link } of g.neighbors(i, ["std"], () => true)) {
        if (!link.locked) vis.push(to);
        if (!sense.includes(to)) sense.push(to);
      }
      for (const { to } of g.neighbors(i, ["vent"], () => true)) {
        if (!sense.includes(to)) sense.push(to);
      }
      this.visCache.push(vis);
      this.senseCache.push(sense);
      this.hear2.push(g.nodesWithin(i, this.P.sensor.hearingHops, ["std"], () => true));
      this.hear3.push(g.nodesWithin(i, this.P.sensor.gunfireHops, ["std"], () => true));
      this.near1.push(g.nodesWithin(i, 1, ["std"], (l) => !l.locked));
    }
    for (const s of g.stairwells) {
      if (!this.visCache[s.upper].includes(s.lower)) this.visCache[s.upper].push(s.lower);
      if (!this.visCache[s.lower].includes(s.upper)) this.visCache[s.lower].push(s.upper);
      if (!this.senseCache[s.upper].includes(s.lower)) this.senseCache[s.upper].push(s.lower);
      if (!this.senseCache[s.lower].includes(s.upper)) this.senseCache[s.lower].push(s.upper);
    }
  }
  visibleNodes(node) {
    return this.visCache[node];
  }
  // the flood's life-sense reach (self + every adjacent room, lock or no lock).
  // Targeting/belief code uses this; the crew keep visibleNodes.
  floodSenses(node) {
    return this.senseCache[node];
  }
  nodesNear(node, hops) {
    return hops <= 1 ? this.near1[node] : this.graph.nodesWithin(node, hops, ["std"], (l) => !l.locked);
  }
  occupants(node) {
    return this._occ[node];
  }
  occupantsNear(node, hops) {
    const out = [];
    for (const n of this.nodesNear(node, hops)) out.push(...this._occ[n]);
    return out;
  }
  floodStrengthAt(node) {
    return this._floodAt[node];
  }
  panickedAt(node) {
    return this._panicked[node] === 1;
  }
  heardGunfire(node) {
    return this.hear3[node].some((n) => this.tickCount - this.gunfireTick[n] < 30);
  }
  heardScreams(node) {
    return this.hear2[node].some((n) => this.tickCount - this.screamTick[n] < 30);
  }
  gunfireAt(node) {
    this.gunfireTick[node] = this.tickCount;
  }
  // Commander entry point (companion spec §0). Stamps the command
  // inputDelayTicks into the future so in multiplayer it reaches every peer
  // before its execution tick; in single-player that's ~1 tick, invisible.
  issue(cmd, peerId = 0) {
    this.commands.enqueue(cmd, this.tickCount + this.P.net.inputDelayTicks, peerId);
  }
  // THE PLAYER (3D slice): a real agent in the sim — the flood can see,
  // hunt, grab and convert them; marines and civilians treat them as crew.
  // Position is driven externally by the game each tick, so strict lockstep
  // determinism pauses while a live player is attached (their movement is an
  // input stream; the multiplayer path feeds it through the command queue).
  attachPlayer(nodeIdx, opts = {}) {
    const a = makeAgent(opts.odst ? FACTION.ARMED : FACTION.CIVILIAN, nodeIdx, this.graph);
    a.hp = a.maxHp = opts.odst ? 45 : this.P.combat.civilian.hp;
    a.isPlayer = true;
    a.hasRadio = true;
    this.spawn(a);
    this.log("radio", opts.odst ? "an ODST hits the deck, MA5 hot (you)" : "a lone survivor is moving through the ship (you)");
    return a;
  }
  // the ODST's squad (game rule): marines who form on the player and follow
  // via the standing escort order — they fight anything on contact, and the
  // usual morale rules apply
  attachPlayerSquad(playerAgent, size = 3) {
    const squad = {
      id: this.squads.length,
      members: [],
      objective: null,
      morale: 1,
      respondingTo: null,
      phase1: false,
      order: { kind: "order:escort", entityId: playerAgent.id }
    };
    for (let i = 0; i < size; i++) {
      const m = makeAgent(FACTION.MARINE, playerAgent.node, this.graph);
      m.hp = m.maxHp = this.P.combat.marine.hp;
      m.hasRadio = true;
      m.squad = squad.id;
      m.escort = true;
      squad.members.push(m.id);
      this.spawn(m);
    }
    squad.size0 = size;
    this.squads.push(squad);
    this.log("radio", `your fireteam forms up — ${size} marines on you`);
    return squad;
  }
  // the player takes up a rifle — from the armory rack or from a corpse
  // that died holding one (game rule: the survivor can fight back)
  playerArm(a, corpse = null) {
    if (corpse) corpse.wasArmed = false;
    else this.armoryStock = Math.max(0, this.armoryStock - 1);
    a.faction = FACTION.ARMED;
    a.hp = a.maxHp = Math.max(a.hp, this.P.combat.armed.hp);
    this.log("combat", corpse ? "the survivor takes a rifle from the dead (you)" : `the survivor arms up at the armory (you — ${this.armoryStock} rifles left)`);
  }
  emitCall(agent) {
    const call = { id: this.callSeq++, node: agent.node, t: this.t, faction: agent.faction, byId: agent.id, rolled: /* @__PURE__ */ new Set() };
    this.calls.push(call);
    this.stats.distressCalls++;
    this.floodKnown = true;
    this.log("radio", `distress call from ${this.graph.node(agent.node).name}`, agent.node);
  }
  log(type, msg, node = -1) {
    this.events.push({ t: this.t, type, msg, node });
    if (this.events.length > 1600) this.events.splice(0, 200);
  }
  spawn(a) {
    this.agents.push(a);
    this.byId.set(a.id, a);
  }
  removeAgent(a) {
    a.dead = true;
    if (a.inShaftAmbush !== void 0) {
      this.graph.shafts[a.inShaftAmbush]?.ambushers?.delete(a.id);
    }
  }
  hurtHuman(a, dmg, by = -1) {
    if (a.hp <= 0 || a.dead) return;
    if (by >= 0 && dmg > 0) {
      a.lastHurtBy = by;
      a.lastHurtTick = this.tickCount;
    }
    a.hp -= dmg;
    if (a.hp <= 0) {
      this.stats.humansDead++;
      if (a.faction === FACTION.MARINE) {
        const squad = this.squads[a.squad];
        this.log("combat", `a marine falls in ${this.graph.node(a.node).name}`, a.node);
        if (squad) squad.calledContact = false;
      }
      this.screamTick[a.node] = this.tickCount;
      humanDeathToCorpse(this, a);
    }
  }
  // --- pathing helpers used by all AI ---
  setPath(a, steps) {
    const norm = [];
    let cur = a.node;
    for (const s of steps) {
      if (typeof s === "number") {
        let found = null;
        for (const { to, link } of this.graph.neighbors(cur, ["std"], () => true)) {
          if (to === s) {
            found = { to, link, layer: "std" };
            break;
          }
        }
        if (!found) return false;
        norm.push(found);
        cur = s;
      } else {
        norm.push(s);
        cur = s.to;
      }
    }
    a.path = norm;
    return true;
  }
  setPathTo(a, target, layers, passFn) {
    const path = this.graph.path(a.node, target, layers, passFn);
    if (!path) return false;
    a.path = path;
    return true;
  }
  // ======================= main tick =======================
  tick() {
    const dt = this.dt;
    this.buffer.beginTick();
    this.tickCount++;
    this.t = this.tickCount * dt;
    this._refreshOccupancy();
    for (const entry of this.commands.collect(this.tickCount)) {
      applyCommand(this, entry);
    }
    if (this.tickCount % this.strategicEvery === 0) {
      this._computeInfluence();
      this.hive.strategicTick();
      strategicSquads(this);
      this._checkSelfArming();
      this._checkLastStand();
      this._lastStandStragglers();
      this._armoryWatch();
      this.stats.conversionsRound = 0;
      this._expireCalls();
    }
    updateHumansTick(this, dt);
    updateFloodTick(this, dt);
    this._advanceMovement(dt);
    this._separate(dt);
    this._fireAvoid(dt);
    this._fireDamage(dt);
    this._refreshOccupancy();
    this._advanceDarkness(dt);
    resolveCombat(this, dt);
    for (const a of this.agents) {
      if (a.dead) continue;
      if (a.panicked && a.hp > 0) this.screamTick[a.node] = this.tickCount;
      if (a.state === STATE.GRABBING) this.screamTick[a.node] = this.tickCount;
    }
    this._reap();
    this._checkOutcome();
    this.writeBuffer();
  }
  // LAST STAND (user note): once most of the squad marines are dead, the word
  // goes out — fall back behind the garrison line on the top deck. Officers
  // step out into the corridor to thicken the line. Radios are damaged and
  // people are scattered, so each survivor only HEARS the call on a roll.
  _checkLastStand() {
    if (this.lastStand || this.initialSquadMarines === 0) return;
    const alive = this.agents.reduce((n, a) => n + (!a.dead && a.hp > 0 && a.faction === FACTION.MARINE && !a.garrison ? 1 : 0), 0);
    if (alive > Math.ceil(this.initialSquadMarines * this.P.lastStand.marineFraction)) return;
    this.lastStand = true;
    this.lastStandAt = this.t;
    const g = this.graph;
    const line = g.byId.get("d1corr");
    const shelters = [g.byId.get("officer"), g.byId.get("cic"), g.byId.get("signal"), g.byId.get("bridge")];
    this.log("radio", `FALL BACK — all remaining hands to the command deck (${alive} marines left)`);
    for (const squad of this.squads) {
      const members = squad.members.map((id) => this.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (!members.length) continue;
      if (!squad.broken && this.rng.chance(this.P.lastStand.hearChance)) squad.lastStandBound = true;
      else if (squad.broken) {
        for (const m of members) if (this.rng.chance(this.P.lastStand.hearChance)) m.fallbackNode = line;
      }
    }
    let heard = 0, missed = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.helpless || a.garrison) continue;
      if (a.faction !== FACTION.CIVILIAN && a.faction !== FACTION.ARMED) continue;
      if (!this.rng.chance(this.P.lastStand.hearChance)) {
        missed++;
        continue;
      }
      heard++;
      if (a.stayPut) {
        if (this.rng.chance(this.P.lastStand.officerJoinChance)) a.fallbackNode = line;
      } else if (a.faction === FACTION.ARMED) {
        if (this.rng.chance(this.P.lastStand.armedJoinFraction)) {
          a.fallbackNode = line;
          a.stayPut = true;
        } else a.fallbackNode = shelters[a.id % shelters.length];
      } else {
        a.fallbackNode = shelters[a.id % shelters.length];
      }
    }
    this.log("radio", `${heard} souls heard the call; ${missed} are still out there`);
  }
  // A minute after the call, whoever missed it works it out on their own —
  // the ship has gone quiet and everyone left alive heads for the line
  // (user note).
  _lastStandStragglers() {
    if (!this.lastStand || this._stragglersDone) return;
    if (this.t < this.lastStandAt + 60) return;
    this._stragglersDone = true;
    const g = this.graph;
    const line = g.byId.get("d1corr");
    const shelters = [g.byId.get("officer"), g.byId.get("cic"), g.byId.get("signal"), g.byId.get("bridge")];
    let n = 0;
    for (const squad of this.squads) {
      if (!squad.broken && !squad.lastStandBound && squad.members.some((id) => {
        const m = this.byId.get(id);
        return m && !m.dead && m.hp > 0;
      })) {
        squad.lastStandBound = true;
        n++;
      }
    }
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.helpless || a.garrison || a.fallbackNode !== void 0) continue;
      if (a.faction === FACTION.MARINE) {
        if (this.squads[a.squad]?.broken) {
          a.fallbackNode = line;
          n++;
        }
      } else if (a.faction === FACTION.ARMED && !a.stayPut) {
        a.fallbackNode = this.rng.chance(this.P.lastStand.armedJoinFraction) ? line : shelters[a.id % shelters.length];
        if (a.fallbackNode === line) a.stayPut = true;
        n++;
      } else if (a.faction === FACTION.CIVILIAN && !a.stayPut) {
        a.fallbackNode = shelters[a.id % shelters.length];
        n++;
      }
    }
    if (n) this.log("radio", `the stragglers get the word — ${n} more fall back on their own`);
  }
  // Once panic breaks out shipwide (before any last stand), some unarmed
  // civilians make a run for the armory and arm themselves — first come,
  // first served on the remaining rifles (user note).
  // THE SEAL RELEASES (user rule): once the hive fields enough combat forms
  // AND the marine line has worn thin, the armory blastdoor unlocks and the
  // ODST reserve deploys — racks, grenades and the flamethrower behind them
  // suddenly in play for whoever lives to reach them.
  _armoryWatch() {
    if (!this.armoryLocked) return;
    let combat = 0, marines = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0) continue;
      if (a.faction === FACTION.COMBAT && !a.downed) combat++;
      else if (a.faction === FACTION.MARINE && !a.downed && !a.odst) marines++;
    }
    if (combat < this.P.armory.unlockCombatForms || marines > this.P.armory.unlockMarinesLeft) return;
    this.armoryLocked = false;
    const armoryIdx = this.graph.byId.get("armory");
    for (const e of this.graph.edges) {
      if ((e.a === armoryIdx || e.b === armoryIdx) && e.locked) e.locked = false;
    }
    this.log("radio", "ARMORY SEAL RELEASED — ODST reserve deploying. Racks are open.");
  }
  _checkSelfArming() {
    if (this._armingRolled || !this.floodKnown) return;
    if (this.armoryLocked) return;
    this._armingRolled = true;
    const armory = this.graph.byId.get("armory");
    let n = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.faction !== FACTION.CIVILIAN) continue;
      if (a.helpless || a.stayPut) continue;
      if (!this.rng.chance(this.P.armory.selfArmChance)) continue;
      a.armingUp = armory;
      n++;
    }
    if (n) this.log("radio", `word of the outbreak spreads — ${n} civilians make for the armory`);
  }
  _expireCalls() {
    this.calls = this.calls.filter((c) => this.t - c.t < this.P.radio.callFadeSec * 2);
  }
  // REAL SPACE LOGIC (user note): occupancy — who is IN a room for sensing,
  // reactions and combat — is decided by an agent's physical coordinates,
  // not by the node its pathfinder is bound to. A form ten meters into the
  // hangar IS in the hangar, even if its "move" hasn't completed yet.
  _refreshOccupancy() {
    const g = this.graph;
    this._occ = Array.from({ length: g.n }, () => []);
    this._floodAt.fill(0);
    this._humanAt.fill(0);
    this._panicked.fill(0);
    for (const a of this.agents) {
      if (a.dead) continue;
      a.pnode = this._pnodeOf(a);
      this._occ[a.pnode].push(a);
      if (isActiveFloodForm(a) || a.faction === FACTION.CARRIER && a.hp > 0) {
        this._floodAt[a.pnode] += W_FLOOD[a.faction];
      }
      if (a.hp > 0 && !a.dead && (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE)) {
        this._humanAt[a.pnode]++;
      }
      if (a.panicked && a.hp > 0) this._panicked[a.pnode] = 1;
    }
  }
  // A mover inside ducting or a cross-deck crawlway is physically inside the
  // ship's structure, not in any room — those keep their logical anchor (and
  // combat.js resolves them in their own shaft/vent groups).
  _physAnchored(a) {
    if (!a.move || a.move.layer === "std") return true;
    if (a.move.layer === "vent") return false;
    const l = a.move.link;
    return this.graph.node(l.a).deck === this.graph.node(l.b).deck;
  }
  // Which room rect actually contains this body. Prefers the current logical
  // node (cheap, and stable at shared-wall boundaries), then scans the deck.
  _pnodeOf(a) {
    if (!this._physAnchored(a)) return a.node;
    const inRect = (n) => n.deck === a.deck && Math.abs(a.x - n.x) <= n.w / 2 + 0.4 && Math.abs(a.y - n.y) <= n.d / 2 + 0.4;
    if (inRect(this.graph.node(a.node))) return a.node;
    for (const n of this._deckRooms[a.deck] ?? []) if (inRect(n)) return n.idx;
    return a.node;
  }
  _computeInfluence() {
    const g = this.graph;
    const { floodStr, humanStr, hardness } = this.influence;
    floodStr.fill(0);
    humanStr.fill(0);
    hardness.fill(0);
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0) continue;
      const n = a.pnode ?? a.node;
      if (isActiveFloodForm(a) || a.faction === FACTION.CARRIER) floodStr[n] += W_FLOOD[a.faction];
      else if (isLivingHuman(a)) {
        humanStr[n] += W_HUMAN[a.faction];
        if (a.faction === FACTION.MARINE) hardness[n] += 1;
      }
    }
    const pass = (l) => l.kind === "std" ? !l.locked : l.kind === "vent" ? !l.blocked : true;
    for (let pass_i = 0; pass_i < 2; pass_i++) {
      for (const arr of [floodStr, humanStr, hardness]) {
        const next = Float32Array.from(arr);
        for (let i = 0; i < g.n; i++) {
          for (const { to } of g.neighbors(i, ["std", "shaft", "vent"], pass)) {
            next[to] += arr[i] * 0.18;
          }
        }
        arr.set(next);
      }
    }
  }
  // REAL-DISTANCE travel (user note): seconds to cross a link = its measured
  // meters over the mover's speed, plus door/lift mechanics. Crawling through
  // shafts and ducting is pace-limited by the space, not the crawler.
  travelSec(link, mult) {
    const M = this.P.movement;
    const run = link.horizM + link.vertM;
    if (link.kind === "shaft") return run * M.crawlWindingFactor / M.shaftMps;
    if (link.kind === "vent") return run * M.crawlWindingFactor / M.ventMps;
    const mps = M.baseMps * Math.max(0.2, mult);
    if (link.type === "lift") return link.horizM / mps + M.liftSec;
    if (link.type === "ladder") return 1 + link.vertM / M.ladderClimbMps;
    return run / mps + (M.doorDelaySec[link.type] ?? 0);
  }
  _speedMult(a) {
    const S = this.P.speed;
    switch (a.faction) {
      case FACTION.CIVILIAN:
        return a.state === STATE.FLEE || a.panicked ? S.civilianFlee : S.civilian;
      case FACTION.ARMED:
        return a.state === STATE.FLEE ? S.civilianFlee : S.armed;
      // your fireteam keeps YOUR pace (user: they were terrible at following) —
      // sim marines walk at 1.4 m/s but you move 5.6-7.6, so an escort marine
      // moves ~4x to stay on you; a posted/patrol marine walks normally.
      case FACTION.MARINE:
        return a.escort ? 5.4 : S.marine;
      case FACTION.INFECTION:
        return S.infection;
      case FACTION.COMBAT:
        return a.dragging !== -1 ? S.drag : S.combatForm;
      case FACTION.CARRIER:
        return S.carrier;
      default:
        return 1;
    }
  }
  _advanceMovement(dt) {
    const g = this.graph;
    for (const a of this.agents) {
      a.hoverY = 0;
      if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) continue;
      if (a.isPlayer) {
        a.animTime += dt;
        continue;
      }
      if (a.closeFollow) {
        a.animTime += dt;
        continue;
      }
      if (a.held === this.tickCount) {
        a.move = null;
        if (!a.isPlayer && (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE)) {
          a.panicked = true;
          a.heading += dt * 4.6;
          const mps = this.P.movement.baseMps * 1.15;
          a.x += Math.cos(a.heading) * mps * dt;
          a.y += Math.sin(a.heading) * mps * dt;
          const room = this.graph.node(a.pnode ?? a.node);
          const hw = Math.max(0.4, room.w / 2 - 0.4), hd = Math.max(0.4, room.d / 2 - 0.4);
          a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x));
          a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y));
          a.animTime += dt;
          if ((this.tickCount + a.id) % 15 === 0) this.screamTick[a.node] = this.tickCount;
        }
        continue;
      }
      if (this._spatialSteer(a, dt)) continue;
      if (a.state === STATE.FIGHT || a.state === STATE.GRABBING || a.state === STATE.COWER || a.state === STATE.AMBUSHING) {
        if (!a.move) {
          if (a.state === STATE.COWER) this._parkDrift(a, dt);
          else if (a.state === STATE.FIGHT && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED)) this._firingDrift(a, dt);
          else a.animTime += dt;
          continue;
        }
      }
      if ((a.task?.kind === TASK.CONVERT || a.task?.kind === TASK.REANIMATE) && !a.move && !a.path.length) {
        a.animTime += dt;
        continue;
      }
      if (a.move) {
        a.move.t += dt / a.move.travelSec;
        const from = g.node(a.move.from), to = g.node(a.move.to);
        const k = Math.min(1, a.move.t);
        const link = a.move.link;
        if (a.move.layer === "std" && link.door && from.deck === to.deck) {
          const fwd = a.move.from === link.a;
          const flipT = a.move.flipT2 ?? (fwd ? link.flipT : 1 - link.flipT);
          const d = link.door;
          if (k < flipT) {
            const kk = k / flipT;
            const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
            a.x = sx + (d.x - sx) * kk;
            a.y = sy + (d.y - sy) * kk;
            a.heading = Math.atan2(d.y - sy, d.x - sx);
          } else {
            const kk = (k - flipT) / Math.max(1e-6, 1 - flipT);
            const tx = a.move.tx ?? to.x, ty = a.move.ty ?? to.y;
            a.x = d.x + (tx - d.x) * kk;
            a.y = d.y + (ty - d.y) * kk;
            a.heading = Math.atan2(ty - d.y, tx - d.x);
            if (a.node !== a.move.to) {
              a.node = a.move.to;
              a.deck = to.deck;
            }
          }
        } else if (a.move.layer === "std" && from.deck !== to.deck && link.type === "stairwell") {
          const upper = from.deck < to.deck ? from : to;
          const descending = from === upper;
          const wp = this._stairWaypoints(upper);
          const A = descending ? wp.top : wp.foot;
          const B = descending ? wp.foot : wp.top;
          const flipT = 0.82;
          const appT = a.move.appT ?? 0.15;
          const handT = appT + (1 - appT) * flipT;
          const px0 = a.x, py0 = a.y;
          if (k < appT) {
            const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
            const mouthX = descending ? A.x : Math.max(from.x - from.w / 2 + 1, Math.min(from.x + from.w / 2 - 1, wp.foot.x));
            const mouthY = descending ? A.y : from.y;
            const kk = appT > 1e-6 ? k / appT : 1;
            a.x = sx + (mouthX - sx) * kk;
            a.y = sy + (mouthY - sy) * kk;
          } else if (k < handT) {
            if (a.deck !== upper.deck) a.deck = upper.deck;
            const kk = (k - appT) / Math.max(1e-6, handT - appT);
            if (kk < 0.5) {
              const u = kk / 0.5;
              a.x = A.x + (wp.mid.x - A.x) * u;
              a.y = A.y + (wp.mid.y - A.y) * u;
            } else {
              const u = (kk - 0.5) / 0.5;
              a.x = wp.mid.x + (B.x - wp.mid.x) * u;
              a.y = wp.mid.y + (B.y - wp.mid.y) * u;
            }
          } else {
            const [tx, ty] = this._parkSlot(a, to);
            a.x = tx;
            a.y = ty;
            if (a.node !== a.move.to) {
              a.node = a.move.to;
              a.deck = to.deck;
            }
          }
          a.heading = Math.atan2(a.y - py0, a.x - px0) || a.heading;
        } else if (a.move.layer === "std" && from.deck !== to.deck) {
          const padX = (n, other) => Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x));
          const flipT = link.flipT ?? 0.5;
          const appT = a.move.appT ?? 0.15;
          const handT = appT + (1 - appT) * flipT;
          if (k < appT) {
            const px = padX(from, to), py = from.y;
            const sx = a.move.sx ?? px, sy = a.move.sy ?? py;
            const kk = k / appT;
            a.x = sx + (px - sx) * kk;
            a.y = sy + (py - sy) * kk;
            a.heading = Math.atan2(py - sy, px - sx);
          } else if (k < handT) {
            a.x = padX(from, to);
            a.y = from.y;
          } else {
            a.x = padX(to, from);
            a.y = to.y;
            if (a.node !== a.move.to) {
              a.node = a.move.to;
              a.deck = to.deck;
            }
          }
          a.heading = Math.atan2(to.y - from.y, to.x - from.x);
        } else {
          const appT = a.move.appT ?? 0, exitT = a.move.exitT ?? 0;
          const eFromX = a.move.eFromX ?? from.x, eFromY = a.move.eFromY ?? from.y;
          const eToX = a.move.eToX ?? to.x, eToY = a.move.eToY ?? to.y;
          if (k < appT) {
            const kk = appT > 1e-6 ? k / appT : 1;
            const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
            a.x = sx + (eFromX - sx) * kk;
            a.y = sy + (eFromY - sy) * kk;
            a.heading = Math.atan2(eFromY - sy, eFromX - sx);
            a.move.hidden = false;
          } else if (k > 1 - exitT) {
            const kk = exitT > 1e-6 ? (k - (1 - exitT)) / exitT : 1;
            const tx = a.move.tx ?? to.x, ty = a.move.ty ?? to.y;
            a.x = eToX + (tx - eToX) * kk;
            a.y = eToY + (ty - eToY) * kk;
            a.heading = Math.atan2(ty - eToY, tx - eToX);
            a.move.hidden = false;
            if (a.node !== a.move.to) {
              a.node = a.move.to;
              a.deck = to.deck;
            }
          } else {
            a.x = eFromX;
            a.y = eFromY;
            a.move.hidden = true;
          }
        }
        if (a.move.layer === "std" && from.deck === to.deck) {
          const dr = a.move.link.door;
          const laneScale = dr ? Math.min(1, Math.hypot(a.x - dr.x, a.y - dr.y) / 2.2) : 1;
          if (a.faction === FACTION.INFECTION) {
            const w = Math.sin(this.t * 6 + a.id * 2.09) * 0.55 * laneScale;
            a.x += Math.cos(a.heading + Math.PI / 2) * w;
            a.y += Math.sin(a.heading + Math.PI / 2) * w;
          } else {
            const lane = (a.id * 7919 % 100 / 100 - 0.5) * 1.5 * laneScale;
            a.x += Math.cos(a.heading + Math.PI / 2) * lane;
            a.y += Math.sin(a.heading + Math.PI / 2) * lane;
          }
          this._clampToRoom(a, this.graph.node(a.node));
        }
        a.animTime += dt;
        if (a.move.t >= 1) {
          if (a.move.link.occupiedBy === a.id) a.move.link.occupiedBy = void 0;
          a.node = a.move.to;
          a.deck = to.deck;
          a.move = null;
          a.charging = false;
          a.firstStruckIn = void 0;
          if (a.state === STATE.MOVE) a.state = a.path.length ? STATE.MOVE : STATE.IDLE;
        }
        continue;
      }
      if (a.path.length) {
        const step = a.path[0];
        const link = step.link;
        let passable = true;
        if (link.kind === "std" && link.locked) passable = false;
        if (link.kind === "vent" && link.blocked) passable = false;
        const flood = a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER;
        if (flood && this.graph.burningUntil[step.to] > this.t) passable = false;
        if (!passable) {
          if (flood && (link.kind !== "std" || link.locked)) this.hive.observeBlocked(link);
          a.path = [];
          continue;
        }
        const committedInto = a.faction === FACTION.INFECTION && this._committedInfectNode(a) === step.to;
        if (a.faction === FACTION.INFECTION && !committedInto && link.kind === "std" && (this.hive.lastScarcity ?? 3) > 0.8 && (a.doorBalks = (a.doorBalks ?? 0) + 1) <= 12 && this._occ[step.to].some((h) => h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED))) {
          a.path = [];
          continue;
        }
        if (a.faction === FACTION.INFECTION && !committedInto && link.kind === "std" && a.path.length === 1) {
          let guns = 0;
          for (const h of this._occ[step.to]) {
            if (h.hp <= 0 || h.dead) continue;
            if (h.faction === FACTION.MARINE) guns += 1;
            else if (h.faction === FACTION.ARMED) guns += 0.6;
          }
          if (guns > 0 && !this.hive.allIn) {
            const pack = this._floodAt[a.node] + this._floodAt[step.to];
            if (pack < guns * this.P.swarm.killRatio) {
              a.doorHold = (a.doorHold ?? 0) + 1;
              if (a.doorHold > 45 * this.P.sim.tickHz) {
                a.doorHold = 0;
                a.path = [];
                a.task = null;
              }
              continue;
            }
          }
          a.doorHold = 0;
        }
        const ladder = link.kind === "std" && link.type === "ladder" && this.graph.node(step.to).deck !== this.graph.node(a.node).deck;
        const queues = ladder && a.faction !== FACTION.INFECTION;
        if (queues && (this.vertBusy(link, a.id) || this.vertReserved(link, a.id))) continue;
        a.doorBalks = 0;
        a.path.shift();
        let mult = this._speedMult(a);
        a.charging = false;
        if (a.faction === FACTION.COMBAT && a.dragging === -1 && link.kind === "std" && this._occ[step.to].some((h) => isLivingHuman(h))) {
          mult *= this.P.speed.chargeMult;
          a.charging = true;
        }
        if (a.faction === FACTION.INFECTION && a.task?.kind === TASK.GRAB && link.kind === "std") {
          mult *= this.P.speed.infectionLunge;
          a.charging = true;
        }
        const paceHash = (a.id * 2654435761 >>> 0) / 4294967296;
        const pace = a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT ? 1 + (paceHash - 0.5) * 0.5 : 1 + (a.id % 7 - 3) * 0.012;
        a.move = {
          from: a.node,
          to: step.to,
          link,
          layer: link.kind,
          t: 0,
          sx: a.x,
          sy: a.y,
          travelSec: this.travelSec(link, mult) * pace
        };
        a.firePost = null;
        if ((link.kind === "vent" || link.kind === "shaft") && this.t - (link._ductLogAt ?? -99) > 12) {
          link._ductLogAt = this.t;
          const A = this.graph.node(link.a), B = this.graph.node(link.b);
          this.log(
            "duct",
            A.deck === B.deck ? `something scuttles through the ducts near ${A.name}` : `noises in the ducts between decks ${Math.min(A.deck, B.deck)} and ${Math.max(A.deck, B.deck)}`,
            a.node
          );
        }
        if (link.kind === "std") {
          const fromN = this.graph.node(a.node), toN = this.graph.node(step.to);
          if (fromN.deck !== toN.deck) {
            let px, py;
            if (link.type === "stairwell") {
              const upper = fromN.deck < toN.deck ? fromN : toN;
              const wp = this._stairWaypoints(upper);
              const mouth = fromN === upper ? wp.top : wp.foot;
              px = fromN === upper ? mouth.x : Math.max(fromN.x - fromN.w / 2 + 1, Math.min(fromN.x + fromN.w / 2 - 1, mouth.x));
              py = fromN === upper ? mouth.y : fromN.y;
            } else {
              px = Math.max(fromN.x - fromN.w / 2 + 1.2, Math.min(fromN.x + fromN.w / 2 - 1.2, toN.x));
              py = fromN.y;
            }
            const appSec = Math.hypot(px - a.x, py - a.y) / Math.max(0.5, this.P.movement.baseMps * mult);
            a.move.appT = appSec / (appSec + a.move.travelSec);
            a.move.travelSec += appSec;
          } else if (link.door) {
            const [tx, ty] = this._parkSlot(a, toN);
            const d1 = Math.hypot(link.door.x - a.x, link.door.y - a.y);
            const d2 = Math.hypot(tx - link.door.x, ty - link.door.y);
            const mps = Math.max(0.5, this.P.movement.baseMps * mult);
            a.move.tx = tx;
            a.move.ty = ty;
            a.move.travelSec = Math.max(0.2, (d1 + d2) / mps * pace);
            a.move.flipT2 = d1 / Math.max(0.1, d1 + d2);
          }
        } else if (link.kind === "vent" || link.kind === "shaft") {
          const fromN = this.graph.node(a.node), toN = this.graph.node(step.to);
          const eFrom = (a.node === link.a ? link.doorA : link.doorB) ?? link.door ?? { x: fromN.x, y: fromN.y };
          const eTo = (a.node === link.a ? link.doorB : link.doorA) ?? link.door ?? { x: toN.x, y: toN.y };
          const [tx, ty] = this._parkSlot(a, toN);
          const mps = Math.max(0.5, this.P.movement.baseMps * mult);
          const appSec = Math.hypot(eFrom.x - a.x, eFrom.y - a.y) / mps;
          const exitSec = Math.hypot(tx - eTo.x, ty - eTo.y) / mps;
          a.move.eFromX = eFrom.x;
          a.move.eFromY = eFrom.y;
          a.move.eToX = eTo.x;
          a.move.eToY = eTo.y;
          a.move.tx = tx;
          a.move.ty = ty;
          a.move.travelSec += appSec + exitSec;
          a.move.appT = appSec / a.move.travelSec;
          a.move.exitT = exitSec / a.move.travelSec;
        }
        if (queues) link.occupiedBy = a.id;
        if (a.state === STATE.IDLE) a.state = STATE.MOVE;
      } else {
        this._parkDrift(a, dt);
      }
    }
  }
  // REAL SPACE COMBAT (user note): an enemy is engaged where it physically
  // IS, the moment both bodies share an open space — inside a room that's
  // immediate (rooms are convex; nothing blocks the sightline), not when a
  // pathfinding "move" happens to complete at the room's center. A combat
  // form abandons its track and runs straight AT its victim's live position;
  // an infection form with a grab order closes the last meters the same way.
  // combat.js gates claws/grabs on these same real distances.
  _spatialSteer(a, dt) {
    const P = this.P;
    if (a.isPlayer || a.state === STATE.GRABBING || a.state === STATE.AMBUSHING) return false;
    if (!this._physAnchored(a)) return false;
    const pn = a.pnode ?? a.node;
    let target = null, stopAt = 0, mps = 0;
    if (a.faction === FACTION.COMBAT) {
      if (a.downed || a.hp <= 0 || a.dragging !== -1) return false;
      const k = a.task?.kind;
      if (k === TASK.TRANSFORM || k === TASK.DECOY || k === TASK.BAIT) return false;
      let best = null, bestD = Infinity, bestScore = Infinity;
      for (const h of this._occ[pn]) {
        if (h.dead || h.hp <= 0) continue;
        if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
        const d = Math.hypot(h.x - a.x, h.y - a.y);
        const grudge = h.id === a.lastHurtBy && d < 8 && this.tickCount - (a.lastHurtTick ?? -999) < 30 ? -6 : 0;
        const score = d + grudge;
        if (score < bestScore - 1e-9 || Math.abs(score - bestScore) <= 1e-9 && h.id < (best?.id ?? Infinity)) {
          bestScore = score;
          bestD = d;
          best = h;
        }
      }
      if (!best) {
        const hunting = a.state === STATE.FIGHT || a.charging || a.task?.kind === TASK.ATTACK;
        if (hunting) {
          let pn2 = -1, pd = Infinity;
          for (const n of this.floodSenses(pn)) {
            if (n === pn) continue;
            for (const h of this._occ[n]) {
              if (h.dead || h.hp <= 0) continue;
              if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
              const d = Math.hypot(h.x - a.x, h.y - a.y) - (h.id === a.chargeTargetId ? 4 : 0);
              if (d < pd) {
                pd = d;
                pn2 = n;
              }
            }
          }
          if (pn2 >= 0 && (this.setPathTo(a, pn2, ["std"], (l) => !l.locked) || this.setPathTo(a, pn2, ["std", "vent"], (l) => l.kind === "std" ? !l.locked : !l.blocked))) {
            a.charging = true;
            a.state = STATE.MOVE;
            return false;
          }
        }
        a.chargeTargetId = -1;
        if (a.state === STATE.FIGHT) {
          a.state = STATE.IDLE;
          a.charging = false;
        }
        return false;
      }
      target = best;
      a.chargeTargetId = best.id;
      stopAt = P.combat.meleeRangeM * 0.6;
      a.charging = bestD > P.combat.meleeRangeM;
      mps = P.movement.baseMps * this._speedMult(a) * (a.charging ? P.speed.chargeMult : 1) * (a.leaping ? 1.2 : 1);
      a.state = STATE.FIGHT;
    } else if (a.faction === FACTION.INFECTION) {
      if (a.task?.kind !== TASK.GRAB || a.hp <= 0) return false;
      const t = this.byId.get(a.task.targetId);
      if (!t || t.dead || t.hp <= 0 || t.deck !== a.deck || (t.pnode ?? t.node) !== pn) return false;
      if (Math.hypot(t.x - a.x, t.y - a.y) <= P.combat.grabRangeM) return false;
      target = t;
      stopAt = P.combat.grabRangeM * 0.6;
      mps = P.movement.baseMps * this._speedMult(a) * P.speed.infectionLunge;
      a.charging = true;
    } else return false;
    a.move = null;
    if (a.path.length) a.path = [];
    const room = this.graph.node(pn);
    if (a.node !== pn) {
      a.node = pn;
      a.deck = room.deck;
    }
    const LEAP_MIN = 5, PEAK_FRAC = 0.25;
    const clearH = clearHeightOf(room);
    const canLeap = a.faction === FACTION.COMBAT && a.charging && clearH > CLEAR_H + 0.5;
    const gap = Math.hypot(target.x - a.x, target.y - a.y);
    if (canLeap && !a.leaping && gap > LEAP_MIN) {
      a.leaping = true;
      a.leapDist0 = gap;
      a.leapTX = target.x;
      a.leapTY = target.y;
    } else if (a.leaping && !canLeap) {
      a.leaping = false;
      a.leapDist0 = 0;
    }
    const aimX = a.leaping ? a.leapTX : target.x;
    const aimY = a.leaping ? a.leapTY : target.y;
    const hold = a.leaping ? 0 : stopAt;
    const dx = aimX - a.x, dy = aimY - a.y;
    const dist = Math.hypot(dx, dy);
    a.heading = Math.atan2(dy, dx);
    if (dist > hold) {
      const step = Math.min(dist - hold, mps * dt);
      a.x += dx / dist * step;
      a.y += dy / dist * step;
      this._clampToRoom(a, room);
    }
    if (a.leaping) {
      const rem = Math.hypot(a.leapTX - a.x, a.leapTY - a.y);
      const p = Math.max(0, Math.min(1, 1 - rem / Math.max(0.5, a.leapDist0)));
      a.hoverY = Math.min(a.leapDist0 * PEAK_FRAC, clearH - 2.2) * 4 * p * (1 - p);
      if (rem <= 0.35) {
        a.leaping = false;
        a.leapDist0 = 0;
      }
    }
    a.animTime += dt;
    return true;
  }
  // PERSONAL SPACE (user rule): every body is SOLID — two agents can never
  // occupy the same patch of deck. A soft separation pass each tick pushes
  // apart any pair sharing a room that sit closer than their summed body
  // radii. Movers mid-link are excluded (formation lanes + pace jitter
  // already stagger them, and their position is re-derived from the link
  // next tick anyway); a latched grabber and its pinned victim stay put;
  // the player's body is game-driven, so it never gets shoved — everyone
  // else steps around it.
  _bodyRadius(a) {
    switch (a.faction) {
      case FACTION.CARRIER:
        return 0.75;
      case FACTION.COMBAT:
        return 0.48;
      case FACTION.INFECTION:
        return 0.32;
      default:
        return 0.4;
    }
  }
  // a form seated ON a body to burrow (CONVERT) or raise it (REANIMATE) is
  // clamped to the body by floodExec — the separation pass must leave it there
  // (else it drifts off the corpse it's rising from).
  _rootingBody(a) {
    return (a.task?.kind === TASK.CONVERT || a.task?.kind === TASK.REANIMATE) && !a.move && a.path.length === 0;
  }
  // clamp a body so its whole RADIUS stays inside the room's walls (user
  // report: NPCs clipping through hallway walls when crowded — the old fixed
  // 0.3 m margin was smaller than a body radius, so a shoved body poked
  // through). In a corridor thinner than a body, at least pin to centerline.
  _clampToRoom(a, room) {
    const r = this._bodyRadius(a);
    const hw = Math.max(0, room.w / 2 - r), hd = Math.max(0, room.d / 2 - r);
    a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x));
    a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y));
  }
  _separate(dt) {
    const relax = Math.min(1, dt * 10);
    for (let n = 0; n < this.graph.n; n++) {
      const occ = this._occ[n];
      if (!occ || occ.length < 2) continue;
      const room = this.graph.node(n);
      const along = room.w >= room.d ? 0 : 1;
      const narrow = Math.min(room.w, room.d) < 6;
      for (let i = 0; i < occ.length; i++) {
        const a = occ[i];
        if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.move || this._rootingBody(a)) continue;
        for (let j = i + 1; j < occ.length; j++) {
          const b = occ[j];
          if (b.dead || b.faction === FACTION.CORPSE || b.downed || b.move || this._rootingBody(b)) continue;
          const need = this._bodyRadius(a) + this._bodyRadius(b);
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= need * need) continue;
          const dist = Math.sqrt(d2);
          if (dist < 1e-6) {
            const ang = (a.id * 31 + b.id * 17) % 628 / 100;
            dx = Math.cos(ang);
            dy = Math.sin(ang);
          } else {
            dx /= dist;
            dy /= dist;
          }
          if (narrow) {
            if (along === 0 && Math.abs(dx) < 0.5) {
              dx = dx < 0 ? -1 : 1;
              dy = 0;
            } else if (along === 1 && Math.abs(dy) < 0.5) {
              dy = dy < 0 ? -1 : 1;
              dx = 0;
            }
          }
          const aMoves = !a.isPlayer && a.held !== this.tickCount;
          const bMoves = !b.isPlayer && b.held !== this.tickCount;
          if (!aMoves && !bMoves) continue;
          const push = (need - dist) * relax * (aMoves && bMoves ? 0.5 : 1);
          if (aMoves) {
            a.x -= dx * push;
            a.y -= dy * push;
            this._clampToRoom(a, room);
          }
          if (bMoves) {
            b.x += dx * push;
            b.y += dy * push;
            this._clampToRoom(b, room);
          }
        }
      }
    }
    for (const a of this.agents) {
      if (a.dead || a.state !== STATE.GRABBING || a.task?.kind !== TASK.GRAB) continue;
      const v = this.byId.get(a.task.targetId);
      if (!v || v.dead) continue;
      const d = Math.hypot(a.x - v.x, a.y - v.y);
      const max = this.P.combat.grabRangeM * 0.9;
      if (d > max && d > 1e-6) {
        const k = max / d;
        a.x = v.x + (a.x - v.x) * k;
        a.y = v.y + (a.y - v.y) * k;
      }
    }
  }
  // FLOOD DARKNESS (user rule): a room held by the flood ALONE accumulates
  // hold time — 60 s kills the lights (overgrown fixtures), 120 s fills it
  // with spore fog. Contested rooms hold their clock; rooms with no flood
  // recover at double speed (the crew's systems fight back). Deterministic:
  // a pure function of occupancy.
  _advanceDarkness(dt) {
    const D = this.P.darkness;
    for (let n = 0; n < this.graph.n; n++) {
      const was = this.floodHoldSec[n];
      if (this._floodAt[n] > 0 && this._humanAt[n] === 0) {
        this.floodHoldSec[n] = Math.min(D.maxHoldSec, was + dt);
      } else if (this._floodAt[n] === 0 && this._humanAt[n] > 0) {
        this.floodHoldSec[n] = Math.max(0, was - dt * 2);
      }
      const now = this.floodHoldSec[n];
      if (was < D.soloDarkSec && now >= D.soloDarkSec) {
        this.log("hive", `the lights die in ${this.graph.node(n).name} — the growth has taken the room`, n);
      } else if (was < D.fogSec && now >= D.fogSec) {
        this.log("hive", `spore fog thickens in ${this.graph.node(n).name}`, n);
      } else if (was >= D.soloDarkSec && now < D.soloDarkSec) {
        this.log("radio", `power flickers back on in ${this.graph.node(n).name}`, n);
      }
    }
  }
  darkAt(node) {
    return this.floodHoldSec[node] >= this.P.darkness.soloDarkSec;
  }
  fogAt(node) {
    return this.floodHoldSec[node] >= this.P.darkness.fogSec;
  }
  // GRENADES (game layer): a radial blast at a real point. Damage falls off
  // toward the edge, walls contain the burst (same physical room only), the
  // ship hears it, and corpses caught in it are shredded out of the hive's
  // economy. `by` feeds the hit-feedback/retargeting path.
  explodeAt(deck, x, y, radius, dmg, by = -1) {
    let node = -1;
    for (const n of this._deckRooms[deck] ?? []) {
      if (Math.abs(x - n.x) <= n.w / 2 + 0.4 && Math.abs(y - n.y) <= n.d / 2 + 0.4) {
        node = n.idx;
        break;
      }
    }
    if (node === -1) return 0;
    this.gunfireAt(node);
    let hits = 0;
    for (const a of this.agents) {
      if (a.dead || a.deck !== deck) continue;
      if ((a.pnode ?? a.node) !== node) continue;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d > radius) continue;
      const k = dmg * (1 - d / radius * 0.7);
      if (a.faction === FACTION.CORPSE) {
        a.damage = Math.min(100, a.damage + k);
        continue;
      }
      if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
        hurtFloodForm(this, a, k, false, by);
        hits++;
      } else if (a.hp > 0 && !a.isPlayer) {
        this.hurtHuman(a, k, by);
        hits++;
      } else if (a.isPlayer && a.hp > 0) {
        this.hurtHuman(a, k * 0.5, by);
        hits++;
      }
    }
    return hits;
  }
  // ONE BODY ON THE LADDER (user rule): is this cross-deck link held by a
  // live climber other than `selfId`? Stale claims (holder died, or was
  // yanked off the move by combat) self-heal — a claim only counts while
  // the holder is genuinely in transit on this link.
  vertBusy(link, selfId = -1) {
    const id = link.occupiedBy;
    if (id === void 0 || id === selfId) return false;
    const h = this.byId.get(id);
    if (!h || h.dead) return false;
    if (h.isPlayer) return h.climbingLink === link;
    return !!(h.move && h.move.link === link);
  }
  // next-in-line reservation (player queueing): while the reserver lives,
  // NPCs yield the next slot on this ladder. Self-heals if they die.
  vertReserved(link, selfId = -1) {
    const id = link.reservedBy;
    if (id === void 0 || id === selfId) return false;
    const h = this.byId.get(id);
    return !!(h && !h.dead);
  }
  // Parked agents each claim their OWN patch of floor (user note: no stacked
  // dots): a golden-angle spiral slot ranked by id among the room's living
  // occupants gives ~0.7 m spacing, clamped to the room's real footprint.
  _parkDrift(a, dt) {
    const nd = this.graph.node(a.node);
    const [tx, ty] = this._parkSlot(a, nd);
    a.x += (tx - a.x) * Math.min(1, dt * 3);
    a.y += (ty - a.y) * Math.min(1, dt * 3);
    a.animTime += dt;
  }
  // STABLE SLOTS (user note: jerky movement): each body's parking spot is
  // a pure hash of its OWN id — ranking against the room's other occupants
  // meant every arrival/death/departure reshuffled the whole room's
  // targets and everyone drifted to new points mid-fight. Collisions are
  // _separate's job. Move legs LAND here too, so arrivals never converge
  // on the room's center point.
  _parkSlot(a, nd) {
    const h1 = (a.id * 2654435761 >>> 0) / 4294967296;
    const h2 = ((a.id + 7907) * 1597334677 >>> 0) / 4294967296;
    const hw = Math.max(0.7, nd.w / 2 - 1), hd = Math.max(0.7, nd.d / 2 - 1);
    const ang = h1 * Math.PI * 2 + nd.idx * 0.7;
    const u = Math.sqrt(h2);
    return [nd.x + Math.cos(ang) * u * hw, nd.y + Math.sin(ang) * u * hd];
  }
  // GRAND STAIRWELL WELL (user: flood get stuck on the staircase walls). The
  // switchback well the 3D renderer cuts into the stairwell room, expressed in
  // this room's own sim coords — MUST mirror world.js _stairGeom so the walked
  // path lands on the visible treads (world X == sim X; the renderer drops the
  // feet with groundHeightAt as the body crosses the well). Returns the three
  // waypoints of the dog-leg: top of the upper flight, the mid landing, and the
  // foot of the lower flight.
  _stairWaypoints(U) {
    const wx = U.x + U.w / 2 * 0.12, wy = U.y;
    const hx = Math.min(6.5, U.w / 2 * 0.42), hy = Math.min(6, U.d / 2 * 0.34);
    return {
      top: { x: wx - hx * 0.45, y: wy - hy * 0.82 },
      // upper flight, front-left
      mid: { x: wx, y: wy + hy * 0.72 },
      // landing, back-centre
      foot: { x: wx + hx * 0.45, y: wy - hy * 0.82 }
      // lower flight, front-right
    };
  }
  // COMMITTED INFECTION target (user rule): the physical node of the body a
  // form has committed to infect — a corpse it will burrow (CONVERT/DRAG), a
  // downed form it will raise (REANIMATE), or a live host it will latch
  // (GRAB) — or -1 if the form isn't on such an errand. Used to wave a
  // committed form through the doorway balk + pod muster so it can never be
  // turned back at the threshold of the room its target stands in.
  _committedInfectNode(a) {
    const t = a.task;
    if (!t) return -1;
    let id;
    if (t.kind === TASK.CONVERT || t.kind === TASK.DRAG) id = t.corpseId;
    else if (t.kind === TASK.GRAB || t.kind === TASK.REANIMATE) id = t.targetId;
    else return -1;
    const b = this.byId.get(id);
    if (!b || b.dead) return -1;
    return b.pnode ?? b.node;
  }
  // FIRING LINE (user note: marines clump in the doorway when a room goes hot —
  // spread out for wider lines of fire). A marine/armed in FIGHT holds a line
  // facing the room's Flood. Two stable per-id hashes place each shooter: one
  // LATERAL (across the line) and one in DEPTH (staggered ranks back from the
  // front). why: in a long thin artery the line runs athwartships across only
  // ~4 m, so lateral spread alone just re-made the clump at the junction (user
  // report: every game they pile at Main Corridor Fore). Staggering the squad
  // in depth down the corridor's long axis reads as a defensive LANE held back
  // from the threat, not a knot at the doorway. Both offsets are clamped to the
  // room's real reach along each axis; _separate resolves hash collisions.
  // Returns [x, y, fx, fy] (slot + unit facing toward the threat) or null when
  // there is no Flood in the room.
  _firingSlot(a, room) {
    const occ = this._occ[a.pnode ?? a.node];
    if (!occ) return null;
    let tx = 0, ty = 0, tn = 0, nShoot = 0;
    for (const o of occ) {
      const f = o.faction;
      if (f === FACTION.COMBAT || f === FACTION.CARRIER || f === FACTION.INFECTION) {
        tx += o.x;
        ty += o.y;
        tn++;
      } else if (f === FACTION.MARINE || f === FACTION.ARMED) nShoot++;
    }
    if (tn === 0) return null;
    tx /= tn;
    ty /= tn;
    if (!a.firePost) a.firePost = [a.x, a.y];
    let hx = a.firePost[0], hy = a.firePost[1];
    const dx = tx - hx, dy = ty - hy;
    const td = Math.hypot(dx, dy) || 1;
    const fx = dx / td, fy = dy / td;
    const MIN = this.P.combat.meleeRangeM + 1.5;
    if (td < MIN) {
      hx -= fx * (MIN - td);
      hy -= fy * (MIN - td);
      a.firePost[0] = hx;
      a.firePost[1] = hy;
    }
    const px = -fy, py = fx;
    const hw = Math.max(0.7, room.w / 2 - 1), hd = Math.max(0.7, room.d / 2 - 1);
    const latCap = Math.abs(px) * hw + Math.abs(py) * hd;
    const h1 = (a.id * 2654435761 >>> 0) / 4294967296;
    const off = (h1 - 0.5) * Math.min(0.9 * Math.max(1, nShoot), Math.max(0, 2 * latCap - 0.4));
    return [hx + px * off, hy + py * off, fx, fy];
  }
  _firingDrift(a, dt) {
    const room = this.graph.node(a.pnode ?? a.node);
    const slot = this._firingSlot(a, room);
    if (!slot) {
      a.animTime += dt;
      return;
    }
    a.x += (slot[0] - a.x) * Math.min(1, dt * 2.2);
    a.y += (slot[1] - a.y) * Math.min(1, dt * 2.2);
    this._clampToRoom(a, room);
    a.heading = Math.atan2(slot[3], slot[2]);
    a.animTime += dt;
  }
  // FIRE IS REAL (user rule): standing in a fire hurts — humans and flood
  // alike, the player included. Flame damage counts as fire for the flood
  // economy (burned husks don't convert).
  _fireDamage(dt) {
    const F = this.P.fire;
    for (const f of this.fires) {
      for (const a of this.agents) {
        if (a.dead || a.deck !== f.deck) continue;
        const dx = a.x - f.x, dy = a.y - f.y;
        const r = F.radiusM * f.scale;
        if (dx * dx + dy * dy > r * r) continue;
        if (a.faction === FACTION.CORPSE) {
          if (a.damage < 100) {
            a.damage = Math.min(100, a.damage + F.dps * dt * 2);
            if (a.damage >= 100) this.stats.corpsesBurned++;
          }
        } else if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
          hurtFloodForm(this, a, F.dps * dt, true);
        } else if (a.hp > 0) {
          this.hurtHuman(a, F.dps * dt);
        }
      }
    }
  }
  // ...and every NPC gives it a wide berth: a steady push out of the hot
  // zone that overrides parking and steering (movers passing near the
  // breach blaze take their lumps from _fireDamage instead)
  _fireAvoid(dt) {
    const F = this.P.fire;
    for (const f of this.fires) {
      const R = F.radiusM * f.scale + 1;
      for (const a of this.agents) {
        if (a.dead || a.isPlayer || a.deck !== f.deck || a.faction === FACTION.CORPSE) continue;
        if (a.held === this.tickCount) continue;
        const dx = a.x - f.x, dy = a.y - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (R - d) * Math.min(1, dt * 6);
        const room = this.graph.node(a.pnode ?? a.node);
        const hw = Math.max(0.4, room.w / 2 - 0.3), hd = Math.max(0.4, room.d / 2 - 0.3);
        a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x + dx / d * push));
        a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y + dy / d * push));
      }
    }
  }
  _reap() {
    let changed = false;
    for (const a of this.agents) {
      if (!a.dead) continue;
      changed = true;
      const t = a.task;
      if (t) {
        if (t.corpseId !== void 0) {
          const b = this.byId.get(t.corpseId);
          if (b && !b.dead) b.claimed = false;
        }
        if (t.targetId !== void 0) {
          const d = this.byId.get(t.targetId);
          if (d && !d.dead && d.claimed) d.claimed = false;
        }
      }
      this.byId.delete(a.id);
    }
    if (changed) this.agents = this.agents.filter((a) => !a.dead);
  }
  _checkOutcome() {
    if (this.outcome) return;
    const anyFlood = this.agents.some((a) => !a.dead && (isActiveFloodForm(a) || a.faction === FACTION.CARRIER || a.faction === FACTION.COMBAT && a.downed && a.damage < 100));
    const anyHuman = this.agents.some((a) => !a.dead && isLivingHuman(a));
    if (!anyFlood) {
      this.outcome = "contained";
      this.log("end", `OUTBREAK CONTAINED at ${fmtTime(this.t)} — the ship survives`);
    } else if (!anyHuman) {
      this.outcome = "lost";
      this.log("end", `SHIP LOST at ${fmtTime(this.t)} — the Flood owns the Saturn Devouring`);
    }
  }
  // --- the one shared boundary (§2.2) ---
  writeBuffer() {
    const b = this.buffer;
    let i = 0;
    for (const a of this.agents) {
      if (a.dead || i >= b.capacity) continue;
      b.id[i] = a.id;
      b.faction[i] = a.faction;
      b.state[i] = a.state;
      b.nodeId[i] = a.node;
      b.posX[i] = a.x;
      b.posY[i] = a.y;
      b.posZ[i] = a.deck;
      b.hoverY[i] = a.hoverY || 0;
      b.headingR[i] = a.heading;
      b.animClip[i] = this._clipFor(a);
      b.animTime[i] = a.animTime;
      b.integrity[i] = a.hp;
      b.damage[i] = a.damage;
      b.tint[i] = TINT[a.faction];
      let flags = 0;
      if (a.hasRadio) flags |= FLAG.HAS_RADIO;
      if (a.helpless) flags |= FLAG.HELPLESS;
      if (a.downed && a.damage < 100) flags |= FLAG.REANIMATABLE;
      if (a.downed) flags |= FLAG.DOWNED;
      if (a.panicked) flags |= FLAG.PANICKED;
      if (a.move && a.move.layer === "vent" && a.move.hidden) flags |= FLAG.EXPOSED;
      if (a.inShaftAmbush !== void 0) flags |= FLAG.AMBUSH;
      if (a.damage >= 100) flags |= FLAG.BURNED;
      if (a.flamer) flags |= FLAG.FLAMER;
      if (a.odst) flags |= FLAG.ODST;
      if (a.move && a.move.layer === "shaft" && a.move.hidden) flags |= FLAG.IN_SHAFT;
      if (a.hostArmed || a.faction === FACTION.CORPSE && a.wasArmed && a.damage < 100) flags |= FLAG.ARMED_HOST;
      if (a.charging) flags |= FLAG.CHARGING;
      if (a.hoverY > 0.05) flags |= FLAG.LEAPING;
      if (a.lastHurtTick !== void 0 && this.tickCount - a.lastHurtTick < 4) flags |= FLAG.FLINCH;
      b.flags[i] = flags;
      i++;
    }
    b.count = i;
  }
  _clipFor(a) {
    if (a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) return CLIP.DEATH;
    if (a.state === STATE.GRABBING || a.state === STATE.FIGHT) return CLIP.ATTACK;
    if (a.faction === FACTION.INFECTION) return a.move ? CLIP.RUN : CLIP.WRITHE;
    if (a.move) return this._speedMult(a) > 1.2 ? CLIP.RUN : CLIP.WALK;
    return CLIP.IDLE;
  }
  getStats() {
    const alive = { civ: 0, armed: 0, marine: 0, infection: 0, combat: 0, combatDowned: 0, carrier: 0, corpses: 0, burnedHusks: 0 };
    for (const a of this.agents) {
      if (a.dead) continue;
      switch (a.faction) {
        case FACTION.CIVILIAN:
          if (a.hp > 0) alive.civ++;
          break;
        case FACTION.ARMED:
          if (a.hp > 0) alive.armed++;
          break;
        case FACTION.MARINE:
          if (a.hp > 0) alive.marine++;
          break;
        case FACTION.INFECTION:
          alive.infection++;
          break;
        case FACTION.COMBAT:
          a.downed ? alive.combatDowned++ : alive.combat++;
          break;
        case FACTION.CARRIER:
          alive.carrier++;
          break;
        case FACTION.CORPSE:
          a.damage >= 100 ? alive.burnedHusks++ : alive.corpses++;
          break;
      }
    }
    let floodNodes = 0;
    for (let n = 0; n < this.graph.n; n++) {
      if (this.influence.floodStr[n] > this.influence.humanStr[n] && this.influence.floodStr[n] > 0.5) floodNodes++;
    }
    const gestating = this.agents.reduce((s, a) => s + (!a.dead && a.faction === FACTION.CARRIER ? a.held ?? 0 : 0), 0);
    return {
      t: this.t,
      tick: this.tickCount,
      outcome: this.outcome,
      scarcity: this.hive.lastScarcity ?? this.hive.scarcity(this.P.flood.initialInfectionForms),
      opening: this.hive.opening,
      floodControlled: floodNodes,
      gestating,
      ...alive,
      ...this.stats
    };
  }
  // deterministic fingerprint for the seed-replay check (§2.1)
  hashState() {
    let h = 2166136261 >>> 0;
    const mix = (v) => {
      h ^= v & 65535;
      h = Math.imul(h, 16777619);
      h ^= v >>> 16 & 65535;
      h = Math.imul(h, 16777619);
    };
    for (const a of this.agents) {
      mix(a.id);
      mix(a.faction);
      mix(a.node);
      mix(Math.round(a.x * 16));
      mix(Math.round(a.y * 16));
      mix(Math.round(a.hp * 16));
      mix(Math.round(a.damage * 16));
    }
    mix(this.tickCount);
    return h >>> 0;
  }
};
function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k]) deepMerge(dst[k], src[k]);
    else dst[k] = src[k];
  }
}

// sim/viz.js
var FACTION_COLOR = {
  [FACTION.CIVILIAN]: "#f2f2f2",
  [FACTION.ARMED]: "#e8c840",
  [FACTION.MARINE]: "#4d8ef0",
  [FACTION.INFECTION]: "#51ff6a",
  [FACTION.COMBAT]: "#c0392b",
  [FACTION.CARRIER]: "#b15fd9",
  [FACTION.CORPSE]: "#777777"
};
var Viz = class {
  constructor(canvas2, sim2) {
    this.canvas = canvas2;
    this.ctx = canvas2.getContext("2d");
    this.sim = sim2;
    this.deckFilter = 0;
    this.overlays = { influence: true, shafts: true, vents: true, calls: true, tracker: false, beliefs: false, labels: true, conns: false, fire: true };
    this.callRings = [];
    this.lastCallCount = 0;
    this.cam = { x: sim2.graph.width / 2, y: sim2.graph.height / 2, zoom: 1 };
    this.s = 1;
    this.focusBreach();
    this.rpos = /* @__PURE__ */ new Map();
  }
  setSim(sim2) {
    this.sim = sim2;
    this.callRings = [];
    this.lastCallCount = 0;
    this.rpos = /* @__PURE__ */ new Map();
    this.focusBreach();
  }
  // start CLOSE on the action (user note: much bigger view) — the camera
  // opens over the breach; scroll to zoom, drag to pan, double-click to fit
  focusBreach() {
    const n = this.sim.graph.node(this.sim.graph.breachNode);
    this.cam = { x: n.x, y: n.y, zoom: 2.6 };
  }
  fitShip() {
    this.cam = { x: this.sim.graph.width / 2, y: this.sim.graph.height / 2, zoom: 1 };
  }
  zoomAt(px, py, factor) {
    const W = this.canvas.width, H = this.canvas.height;
    const wx = this.cam.x + (px - W / 2) / this.s;
    const wy = this.cam.y + (py - H / 2) / this.s;
    this.cam.zoom = Math.min(16, Math.max(0.85, this.cam.zoom * factor));
    const fit = Math.min(W / this.sim.graph.width, H / this.sim.graph.height);
    const s2 = fit * this.cam.zoom;
    this.cam.x = wx - (px - W / 2) / s2;
    this.cam.y = wy - (py - H / 2) / s2;
  }
  pan(dxPx, dyPx) {
    this.cam.x -= dxPx / this.s;
    this.cam.y -= dyPx / this.s;
  }
  draw(dt = 0.016) {
    const { ctx, sim: sim2 } = this;
    const g = sim2.graph;
    const W = this.canvas.width, H = this.canvas.height;
    const fit = Math.min(W / g.width, H / g.height);
    const s = fit * this.cam.zoom;
    this.s = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#07090c";
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, W / 2 - this.cam.x * s, H / 2 - this.cam.y * s);
    while (this.lastCallCount < sim2.calls.length) {
      const c = sim2.calls[this.lastCallCount];
      this.callRings.push({ node: c.node, t0: sim2.t, byId: c.byId, faction: c.faction });
      this.lastCallCount++;
    }
    this._deckBands(g);
    if (this.overlays.vents) this._vents(g);
    this._edges(g);
    if (this.overlays.shafts) this._shafts(g);
    this._rooms(g);
    this._edgeMarkers(g);
    if (this.overlays.calls) this._callRings(g);
    if (this.overlays.tracker) this._tracker(g);
    if (this.overlays.beliefs) this._beliefs(g);
    this._agents(dt);
    this._combatFx(g);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  _lw(px) {
    return px / this.s;
  }
  // constant on-screen line width
  // constant on-screen font size: scale by the canvas's device-pixel ratio,
  // or hidpi screens render text at half the intended size (user note:
  // room names were unreadable)
  _font(px) {
    const dpr = this.canvas.clientWidth ? this.canvas.width / this.canvas.clientWidth : 1;
    return `${px * dpr / this.s}px monospace`;
  }
  _visible(nodeIdx) {
    return this.deckFilter === 0 || this.sim.graph.node(nodeIdx).deck === this.deckFilter;
  }
  _deckBands(g) {
    const { ctx } = this;
    ctx.font = this._font(11);
    for (let d = 1; d <= 5; d++) {
      const band = g.deckBands[d - 1];
      ctx.fillStyle = this.deckFilter && this.deckFilter !== d ? "#0b0e12" : d % 2 ? "#11151c" : "#0e1218";
      ctx.fillRect(0, band.y0, g.width, band.y1 - band.y0);
      const deckNodes = g.nodes.filter((n) => n.deck === d);
      if (deckNodes.length && (!this.deckFilter || this.deckFilter === d)) {
        const x0 = Math.min(...deckNodes.map((n) => n.x - n.w / 2)) - 1.6;
        const x1 = Math.max(...deckNodes.map((n) => n.x + n.w / 2)) + 1.6;
        const yy0 = Math.min(...deckNodes.map((n) => n.y - n.d / 2)) - 1.6;
        const yy1 = Math.max(...deckNodes.map((n) => n.y + n.d / 2)) + 1.6;
        ctx.fillStyle = "#151b26";
        ctx.strokeStyle = "#28324a";
        ctx.lineWidth = this._lw(1.6);
        ctx.beginPath();
        ctx.roundRect(x0, yy0, x1 - x0, yy1 - yy0, 3);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = "#3a4556";
      ctx.fillText(`DECK ${d} — ${["COMMAND", "HABITATION", "OPERATIONS", "ENGINEERING", "FLIGHT"][d - 1]}`, 3, band.y0 + 14 / this.s);
    }
    ctx.fillStyle = "#232b38";
    ctx.fillText("BOW ◄", 3, g.deckBands[0].y0 - 4 / this.s);
    ctx.fillText("► STERN", g.width - 60 / this.s, g.deckBands[0].y0 - 4 / this.s);
  }
  // Connector throats for the few spaces that don't share a wall: drawn as
  // small filled passages (walkable floor), UNDER the rooms
  _edges(g) {
    const { ctx } = this;
    for (const e of g.edges) {
      if (!this._visible(e.a) && !this._visible(e.b)) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck !== b.deck || e.shared || !e.doorA) continue;
      const dx = e.doorB.x - e.doorA.x, dy = e.doorB.y - e.doorA.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.1) continue;
      ctx.save();
      ctx.translate((e.doorA.x + e.doorB.x) / 2, (e.doorA.y + e.doorB.y) / 2);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = "#1c2330";
      ctx.strokeStyle = "#3a4a61";
      ctx.lineWidth = this._lw(1);
      ctx.fillRect(-len / 2 - 0.3, -0.9, len + 0.6, 1.8);
      ctx.strokeRect(-len / 2 - 0.3, -0.9, len + 0.6, 1.8);
      ctx.restore();
    }
  }
  // DOORS (user note: a real plan, no abstract lines): every same-deck
  // connection is an opening drawn on the actual shared wall — a light slot
  // when open, glowing red when locked. Cross-deck lifts/ladders are round
  // pads inside the rooms they serve, matching the 3D world.
  _edgeMarkers(g) {
    const { ctx } = this;
    const DOOR_W = 1.7;
    for (const e of g.edges) {
      if (!this._visible(e.a) && !this._visible(e.b)) continue;
      const a = g.node(e.a), b = g.node(e.b);
      if (a.deck === b.deck && e.door) {
        const xov = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const yov = Math.min(a.y + a.d / 2, b.y + b.d / 2) - Math.max(a.y - a.d / 2, b.y - b.d / 2);
        const horizWall = xov >= yov;
        const wl = DOOR_W / 2, wt = 0.55;
        ctx.fillStyle = e.locked ? "#c0392b" : "#9fb4d4";
        if (horizWall) ctx.fillRect(e.door.x - wl, e.door.y - wt / 2, DOOR_W, wt);
        else ctx.fillRect(e.door.x - wt / 2, e.door.y - wl, wt, DOOR_W);
        if (e.type === "blastdoor") {
          ctx.strokeStyle = e.locked ? "#ff8877" : "#5a708f";
          ctx.lineWidth = this._lw(1.6);
          if (horizWall) ctx.strokeRect(e.door.x - wl - 0.3, e.door.y - wt / 2 - 0.25, DOOR_W + 0.6, wt + 0.5);
          else ctx.strokeRect(e.door.x - wt / 2 - 0.25, e.door.y - wl - 0.3, wt + 0.5, DOOR_W + 0.6);
        }
        if (this.overlays.conns) this._connLabel(e.door.x, e.door.y, e.label, e.locked ? "#e06a5a" : "#5a708f");
      } else if (a.deck !== b.deck) {
        for (const [n, other] of [[a, b], [b, a]]) {
          if (!this._visible(n.idx)) continue;
          const px = Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x));
          const lift = e.type === "lift";
          ctx.fillStyle = lift ? "#173a42" : "#3d3117";
          ctx.strokeStyle = lift ? "#2fd7f0" : "#f0a52f";
          ctx.lineWidth = this._lw(1.4);
          ctx.beginPath();
          ctx.arc(px, n.y, 1.05, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = lift ? "#7fe3f2" : "#f0c264";
          ctx.font = this._font(9);
          ctx.textAlign = "center";
          ctx.fillText(lift ? "L" : "K", px, n.y + this._lw(3));
          ctx.textAlign = "left";
          if (this.overlays.conns) this._connLabel(px, n.y - 2, e.label, "#5a708f");
        }
      }
    }
    for (const s of g.shafts) {
      if (!this._visible(s.a) && !this._visible(s.b)) continue;
      const a = g.node(s.a), b = g.node(s.b);
      if (this.overlays.conns) this._connLabel((a.x + b.x) / 2, (a.y + b.y) / 2, s.label, "#b39a4a");
    }
    for (const v of g.vents) {
      if (!this._visible(v.a) && !this._visible(v.b)) continue;
      const a = g.node(v.a), b = g.node(v.b);
      if (this.overlays.conns) this._connLabel((a.x + b.x) / 2, (a.y + b.y) / 2, v.label, v.blocked ? "#39424c" : "#3f8a5e");
    }
  }
  // strict connection designation drawn at the edge midpoint (user note)
  _connLabel(mx, my, text, color) {
    if (!text) return;
    const { ctx } = this;
    ctx.font = this._font(8);
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(7,9,12,0.82)";
    ctx.fillRect(mx - w / 2 - this._lw(2), my - this._lw(5.5), w + this._lw(4), this._lw(10));
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(text, mx, my + this._lw(2.5));
    ctx.textAlign = "left";
  }
  _shafts(g) {
    const { ctx } = this;
    for (const s of g.shafts) {
      if (!this._visible(s.a) && !this._visible(s.b)) continue;
      const a = g.node(s.a), b = g.node(s.b);
      ctx.strokeStyle = "#7a6a2f";
      ctx.lineWidth = this._lw(3.5);
      ctx.setLineDash([this._lw(7), this._lw(5)]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const occupied = s.ambushers && s.ambushers.size > 0;
      for (const k of [0.25, 0.75]) {
        const mx = a.x + (b.x - a.x) * k, my = a.y + (b.y - a.y) * k;
        const r = this._lw(4);
        ctx.fillStyle = occupied ? "#ffd23f" : "#4d4526";
        ctx.beginPath();
        ctx.moveTo(mx, my - r);
        ctx.lineTo(mx + r, my);
        ctx.lineTo(mx, my + r);
        ctx.lineTo(mx - r, my);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  _vents(g) {
    const { ctx } = this;
    for (const v of g.vents) {
      if (!this._visible(v.a) && !this._visible(v.b)) continue;
      const a = g.node(v.a), b = g.node(v.b);
      ctx.strokeStyle = v.blocked ? "#2a2f36" : "#2f6b46";
      ctx.lineWidth = this._lw(1);
      ctx.setLineDash([this._lw(2), this._lw(4)]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // rooms at their real footprint: rect w × d meters, heat-filled
  _rooms(g) {
    const { ctx, sim: sim2 } = this;
    for (const n of g.nodes) {
      if (!this._visible(n.idx)) continue;
      const flood = sim2.influence.floodStr[n.idx];
      const human = sim2.influence.humanStr[n.idx];
      let fill = n.type === "corridor" ? "#141920" : "#161b23";
      if (this.overlays.influence && (flood > 0.05 || human > 0.05)) {
        const total = flood + human;
        const k = flood / total;
        const alpha = Math.min(0.55, total * 0.12 + 0.12);
        fill = `rgba(${Math.round(30 + k * 40)}, ${Math.round(70 + k * 140)}, ${Math.round(170 - k * 110)}, ${alpha})`;
      }
      const x0 = n.x - n.w / 2, y0 = n.y - n.d / 2;
      ctx.fillStyle = fill;
      ctx.strokeStyle = sim2.graph.burningUntil[n.idx] > sim2.t ? "#ff7733" : g.unpowered[n.idx] ? "#3d3d4d" : "#3a4a61";
      ctx.lineWidth = n.idx === g.breachNode ? this._lw(2.5) : this._lw(1.2);
      if (n.idx === g.breachNode) ctx.strokeStyle = "#ff5533";
      ctx.fillRect(x0, y0, n.w, n.d);
      ctx.strokeRect(x0, y0, n.w, n.d);
      if (g.unpowered[n.idx]) {
        ctx.fillStyle = "rgba(20,20,30,0.45)";
        ctx.fillRect(x0, y0, n.w, n.d);
      }
      if (this.overlays.labels && (this.s >= 2.4 || n.w >= 22)) {
        ctx.fillStyle = "#7e90aa";
        ctx.font = this._font(12);
        ctx.textAlign = "center";
        const above = n.type === "corridor" ? n.y + this._lw(3) : y0 - this._lw(3);
        ctx.fillText(n.name, n.x, above);
        ctx.textAlign = "left";
      }
    }
  }
  _callRings(g) {
    const { ctx, sim: sim2 } = this;
    this.callRings = this.callRings.filter((r) => sim2.t - r.t0 < 6);
    for (const r of this.callRings) {
      const caller = r.byId ? sim2.byId.get(r.byId) : null;
      let cx, cy, node;
      if (caller && !caller.dead) {
        cx = caller.x;
        cy = caller.y;
        node = caller.node;
      } else {
        node = r.node;
        const n = g.node(node);
        cx = n.x;
        cy = n.y;
      }
      if (!this._visible(node)) continue;
      const age = sim2.t - r.t0;
      const rad = 2 + age * 5;
      const marine = r.faction === FACTION.MARINE;
      const a = Math.max(0, 0.8 - age * 0.13);
      ctx.strokeStyle = marine ? `rgba(90, 150, 240, ${a})` : `rgba(240, 150, 60, ${a})`;
      ctx.lineWidth = this._lw(1.6);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      if (age < 3) {
        ctx.fillStyle = marine ? "#5a96f0" : "#f0963c";
        ctx.beginPath();
        ctx.arc(cx, cy, this._lw(3.4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const squad of sim2.squads) {
      if (squad.broken || squad.objective?.kind !== "distress") continue;
      const leader = sim2.byId.get(squad.members[0]);
      if (!leader || leader.dead) continue;
      const t = g.node(squad.objective.node);
      if (!this._visible(leader.node) && !this._visible(squad.objective.node)) continue;
      ctx.strokeStyle = "rgba(77, 142, 240, 0.35)";
      ctx.lineWidth = this._lw(1);
      ctx.setLineDash([this._lw(4), this._lw(4)]);
      ctx.beginPath();
      ctx.moveTo(leader.x, leader.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  _tracker(g) {
    const { ctx, sim: sim2 } = this;
    const buf = sim2.buffer;
    for (let i = 0; i < buf.count; i++) {
      if (buf.faction[i] !== FACTION.MARINE || buf.integrity[i] <= 0) continue;
      const node = buf.nodeId[i];
      if (!this._visible(node)) continue;
      ctx.strokeStyle = "rgba(80, 160, 255, 0.18)";
      ctx.lineWidth = this._lw(1);
      ctx.beginPath();
      ctx.arc(buf.posX[i], buf.posY[i], 16, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  _beliefs(g) {
    const { ctx, sim: sim2 } = this;
    const bel = sim2.hive.believedHumanStr;
    for (const n of g.nodes) {
      if (!this._visible(n.idx) || bel[n.idx] < 0.05) continue;
      ctx.strokeStyle = `rgba(255, 120, 200, ${Math.min(0.8, bel[n.idx] * 0.5)})`;
      ctx.lineWidth = this._lw(1.5);
      ctx.setLineDash([this._lw(3), this._lw(3)]);
      ctx.strokeRect(n.x - n.w / 2 - 1, n.y - n.d / 2 - 1, n.w + 2, n.d + 2);
      ctx.setLineDash([]);
    }
  }
  _agents(dt) {
    const { ctx, sim: sim2 } = this;
    const buf = sim2.buffer;
    const k = Math.min(1, dt * 16);
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      seen.add(id);
      const tx = buf.posX[i], ty = buf.posY[i];
      let rp = this.rpos.get(id);
      if (!rp) {
        rp = { x: tx, y: ty };
        this.rpos.set(id, rp);
      } else {
        rp.x += (tx - rp.x) * k;
        rp.y += (ty - rp.y) * k;
      }
    }
    if (this.rpos.size > buf.count * 2) {
      for (const id of this.rpos.keys()) if (!seen.has(id)) this.rpos.delete(id);
    }
    for (const a of sim2.agents) {
      if (a.dead || !a.task || a.taskProgress <= 0) continue;
      if (a.task.kind !== TASK.CONVERT && a.task.kind !== TASK.REANIMATE) continue;
      const body = sim2.byId.get(a.task.corpseId ?? a.task.targetId);
      if (!body || body.dead) continue;
      const rp = this.rpos.get(a.id), bp = this.rpos.get(body.id);
      if (rp) {
        rp.x = body.x;
        rp.y = body.y;
      }
      if (bp) {
        bp.x = body.x;
        bp.y = body.y;
      }
    }
    const rr = (m, px) => Math.max(m, px / this.s);
    for (let i = 0; i < buf.count; i++) {
      if (buf.faction[i] !== FACTION.CORPSE) continue;
      if (!this._visible(buf.nodeId[i])) continue;
      const rp = this.rpos.get(buf.id[i]);
      const burned = buf.flags[i] & FLAG.BURNED;
      this._corpseGlyph(rp.x, rp.y, buf.id[i], burned ? "#181818" : "#6d6d6d");
    }
    for (let i = 0; i < buf.count; i++) {
      const node = buf.nodeId[i];
      const f = buf.faction[i];
      if (f === FACTION.CORPSE || !this._visible(node)) continue;
      const rp = this.rpos.get(buf.id[i]);
      const x = rp.x, y = rp.y;
      const flags = buf.flags[i];
      const burned = flags & FLAG.BURNED;
      const downed = flags & FLAG.DOWNED;
      const color = FACTION_COLOR[f];
      const heading = buf.headingR[i];
      const detailed = this.s >= 5;
      if (burned) {
        ctx.fillStyle = "#111";
        ctx.beginPath();
        ctx.arc(x, y, rr(0.5, 2), 0, Math.PI * 2);
        ctx.fill();
      } else if (downed) {
        ctx.strokeStyle = color;
        ctx.lineWidth = this._lw(1.2);
        ctx.beginPath();
        ctx.arc(x, y, rr(0.55, 3), 0, Math.PI * 2);
        ctx.stroke();
      } else if (f === FACTION.MARINE) {
        this._marineGlyph(x, y, heading, rr(0.55, 2.8), detailed);
      } else if (f === FACTION.ARMED) {
        this._armedGlyph(x, y, heading, rr(0.45, 2.3), detailed);
      } else if (f === FACTION.CIVILIAN) {
        const r = rr(0.42, 2.2);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (detailed) {
          ctx.fillStyle = "#b9bec6";
          ctx.beginPath();
          ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (f === FACTION.INFECTION) {
        this._infectionGlyph(x, y, rr(0.3, 1.8), buf.id[i], detailed);
      } else if (f === FACTION.COMBAT) {
        this._combatGlyph(x, y, heading, rr(0.65, 3.2), flags, detailed);
      } else if (f === FACTION.CARRIER) {
        const held = sim2.byId.get(buf.id[i])?.held ?? 0;
        this._carrierGlyph(x, y, rr(0.85, 4), held / sim2.P.carrier.maxInfectionForms, detailed);
      }
      if (flags & FLAG.EXPOSED && Math.floor(sim2.t * 6) % 2 === 0) {
        ctx.strokeStyle = "#aaffbb";
        ctx.lineWidth = this._lw(1.4);
        ctx.beginPath();
        ctx.arc(x, y, rr(0.6, 4), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (flags & FLAG.AMBUSH) {
        ctx.strokeStyle = "#ffd23f";
        ctx.lineWidth = this._lw(1);
        ctx.beginPath();
        ctx.arc(x, y, rr(0.7, 4.5), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (flags & FLAG.FLAMER) {
        ctx.fillStyle = "#ff7733";
        const r = this._lw(1.4);
        ctx.fillRect(x - r, y - rr(0.9, 5) - r * 2, r * 2, r * 2);
      }
      if (flags & FLAG.PANICKED) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        const r = this._lw(0.9);
        ctx.fillRect(x - r, y - rr(0.8, 5), r * 2, r * 2);
      }
    }
  }
  // ---- lore-styled NPC glyphs (user note: icons, not just colored dots) ----
  // marine: armored shoulders + helmet with a visor slit + rifle, facing
  // their heading — reads instantly as a soldier
  _marineGlyph(x, y, h, r, detailed) {
    const { ctx } = this;
    if (!detailed) {
      ctx.fillStyle = FACTION_COLOR[FACTION.MARINE];
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(h);
    ctx.fillStyle = "#33619f";
    ctx.fillRect(-r * 0.5, -r, r * 1, r * 2);
    ctx.strokeStyle = "#c9d4e2";
    ctx.lineWidth = r * 0.28;
    ctx.beginPath();
    ctx.moveTo(r * 0.1, r * 0.45);
    ctx.lineTo(r * 1.9, r * 0.45);
    ctx.stroke();
    ctx.fillStyle = "#4d8ef0";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0c1a30";
    ctx.lineWidth = r * 0.22;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.4, -0.7, 0.7);
    ctx.stroke();
    ctx.restore();
  }
  // armed crew: a person with a sidearm out — circle body, short pistol line
  _armedGlyph(x, y, h, r, detailed) {
    const { ctx } = this;
    ctx.fillStyle = FACTION_COLOR[FACTION.ARMED];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (!detailed) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(h);
    ctx.strokeStyle = "#c9d4e2";
    ctx.lineWidth = r * 0.3;
    ctx.beginPath();
    ctx.moveTo(r * 0.3, r * 0.35);
    ctx.lineTo(r * 1.5, r * 0.35);
    ctx.stroke();
    ctx.fillStyle = "#8a7726";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // infection form: a taut pod on wriggling tentacles (they writhe in place)
  _infectionGlyph(x, y, r, id, detailed) {
    const { ctx, sim: sim2 } = this;
    if (detailed) {
      ctx.strokeStyle = "#2e9946";
      ctx.lineWidth = r * 0.35;
      for (let k = 0; k < 6; k++) {
        const a = k / 6 * Math.PI * 2 + id;
        const wig = Math.sin(sim2.t * 6 + id + k * 1.7) * 0.35;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6);
        ctx.lineTo(x + Math.cos(a + wig) * r * 1.7, y + Math.sin(a + wig) * r * 1.7);
        ctx.stroke();
      }
    }
    ctx.fillStyle = FACTION_COLOR[FACTION.INFECTION];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (detailed) {
      ctx.fillStyle = "#bfffcb";
      ctx.beginPath();
      ctx.arc(x, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // combat form: hunched, spined mass with a whip arm — and the host's gun
  // if it died holding one. Charging forms trail a motion streak.
  _combatGlyph(x, y, h, r, flags, detailed) {
    const { ctx } = this;
    if (flags & FLAG.CHARGING) {
      ctx.strokeStyle = "rgba(192,57,43,0.4)";
      ctx.lineWidth = this._lw(2);
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(h) * r * 3.2, y - Math.sin(h) * r * 3.2);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    if (!detailed) {
      ctx.fillStyle = FACTION_COLOR[FACTION.COMBAT];
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.9, y + r * 0.8);
      ctx.lineTo(x - r * 0.9, y + r * 0.8);
      ctx.closePath();
      ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(h);
    ctx.fillStyle = "#8f2c22";
    ctx.beginPath();
    ctx.moveTo(r * 0.9, 0);
    ctx.lineTo(r * 0.2, -r * 0.75);
    ctx.lineTo(-r * 0.45, -r * 0.95);
    ctx.lineTo(-r * 0.35, -r * 0.4);
    ctx.lineTo(-r * 1, -r * 0.35);
    ctx.lineTo(-r * 0.6, 0);
    ctx.lineTo(-r * 1, r * 0.5);
    ctx.lineTo(-r * 0.3, r * 0.55);
    ctx.lineTo(r * 0.3, r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = FACTION_COLOR[FACTION.COMBAT];
    ctx.beginPath();
    ctx.arc(r * 0.1, 0, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#d8654f";
    ctx.lineWidth = r * 0.22;
    ctx.beginPath();
    ctx.moveTo(r * 0.4, -r * 0.3);
    ctx.quadraticCurveTo(r * 1.3, -r * 0.8, r * 1.8, -r * 0.25);
    ctx.stroke();
    if (flags & FLAG.ARMED_HOST) {
      ctx.strokeStyle = "#c9d4e2";
      ctx.lineWidth = r * 0.24;
      ctx.beginPath();
      ctx.moveTo(r * 0.2, r * 0.45);
      ctx.lineTo(r * 1.7, r * 0.45);
      ctx.stroke();
    }
    ctx.restore();
  }
  // carrier: bulbous two-lobed sack on stubby legs; the belly lobe swells
  // with the payload and strains as it nears the rupture point
  _carrierGlyph(x, y, r, fill01, detailed) {
    const { ctx, sim: sim2 } = this;
    const swell = r * (0.75 + fill01 * 0.9);
    if (detailed) {
      ctx.strokeStyle = "#6d4a7e";
      ctx.lineWidth = r * 0.3;
      for (const k of [-0.8, -0.3, 0.3, 0.8]) {
        ctx.beginPath();
        ctx.moveTo(x + k * r * 0.7, y + r * 0.4);
        ctx.lineTo(x + k * r, y + r * 1.05);
        ctx.stroke();
      }
    }
    const throb = fill01 > 0.6 ? 1 + Math.sin(sim2.t * 5) * 0.05 : 1;
    ctx.fillStyle = "#9a68b8";
    ctx.beginPath();
    ctx.arc(x, y - swell * 0.35, swell * throb, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FACTION_COLOR[FACTION.CARRIER];
    ctx.beginPath();
    ctx.arc(x, y + r * 0.25, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    if (detailed && fill01 > 0) {
      ctx.strokeStyle = "rgba(230, 200, 255, 0.55)";
      ctx.lineWidth = r * 0.12;
      ctx.beginPath();
      ctx.arc(x, y - swell * 0.35, swell * 0.6, -2.2, -0.9);
      ctx.stroke();
    }
  }
  // a body lying where it fell: short slab + head dot, angle fixed per id
  _corpseGlyph(x, y, id, color) {
    const { ctx } = this;
    const ang = id * 2.399963 % (Math.PI * 2);
    const len = Math.max(0.9, 3 / this.s);
    const dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.32, 1.6 / this.s);
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + dx * 1.25, y + dy * 1.25, Math.max(0.18, 0.9 / this.s), 0, Math.PI * 2);
    ctx.fill();
  }
  // the fight INSIDE the room (user note): tracers + muzzle flashes while a
  // node exchanges fire, grab tethers while a form takes someone, progress
  // arcs over bodies being converted and combat forms rooting into carriers
  _combatFx(g) {
    const { ctx, sim: sim2 } = this;
    if (this.overlays.fire) for (let n = 0; n < g.n; n++) {
      if (sim2.tickCount - sim2.gunfireTick[n] > 2 || !this._visible(n)) continue;
      const occ = sim2.occupants(n);
      const shooters = occ.filter((a) => a.hp > 0 && !a.dead && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED && a.state === STATE.FIGHT));
      const targets = occ.filter((a) => !a.dead && a.hp > 0 && !a.downed && (a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER || a.faction === FACTION.INFECTION));
      if (!shooters.length || !targets.length) continue;
      for (const sh of shooters) {
        const t = targets[(sh.id + (sim2.tickCount >> 1)) % targets.length];
        const sp = this.rpos.get(sh.id) ?? sh, tp = this.rpos.get(t.id) ?? t;
        const flick = (sh.id + sim2.tickCount) % 3;
        if (flick === 0) continue;
        const dx = tp.x - sp.x, dy = tp.y - sp.y, dl = Math.hypot(dx, dy) || 1;
        const mx = sp.x + dx / dl * 0.8, my = sp.y + dy / dl * 0.8;
        ctx.strokeStyle = `rgba(255, 224, 140, ${flick === 1 ? 0.55 : 0.3})`;
        ctx.lineWidth = Math.max(0.08, 1 / this.s);
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(tp.x, tp.y);
        ctx.stroke();
        this._muzzleFlash(mx, my, Math.atan2(dy, dx), flick === 1);
      }
    }
    for (const a of sim2.agents) {
      if (a.dead || !this._visible(a.node)) continue;
      const ap = this.rpos.get(a.id) ?? a;
      if (a.state === STATE.GRABBING && a.task?.targetId !== void 0) {
        const v = sim2.byId.get(a.task.targetId);
        if (v && !v.dead) {
          const vp = this.rpos.get(v.id) ?? v;
          const pulse = 0.45 + 0.3 * Math.sin(sim2.t * 9);
          ctx.strokeStyle = `rgba(90, 255, 120, ${pulse})`;
          ctx.lineWidth = Math.max(0.14, 1.4 / this.s);
          ctx.beginPath();
          ctx.moveTo(ap.x, ap.y);
          ctx.lineTo(vp.x, vp.y);
          ctx.stroke();
          const need = v.faction === FACTION.CIVILIAN ? sim2.P.combat.civilianGrabSec : sim2.P.combat.infectionGrabSec;
          this._progressArc(vp.x, vp.y, (a.grabTimer ?? 0) / need, "#51ff6a");
        }
      } else if (a.task?.kind === TASK.CONVERT && a.taskProgress > 0) {
        const body = sim2.byId.get(a.task.corpseId);
        if (body && !body.dead) {
          const bp = this.rpos.get(body.id) ?? body;
          this._progressArc(bp.x, bp.y, a.taskProgress / sim2.P.combat.corpseConvertSec, "#51ff6a");
        }
      } else if (a.task?.kind === TASK.TRANSFORM && a.taskProgress > 0) {
        this._progressArc(ap.x, ap.y, a.taskProgress / sim2.P.carrier.transformSec, "#b15fd9");
      }
    }
  }
  // four-point star + hot core + faint glow, oriented along the shot
  _muzzleFlash(x, y, ang, bright) {
    const { ctx } = this;
    const r = Math.max(0.45, 3.2 / this.s) * (bright ? 1 : 0.7);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = `rgba(255, 190, 90, ${bright ? 0.28 : 0.16})`;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 240, 190, ${bright ? 0.95 : 0.7})`;
    ctx.lineWidth = Math.max(0.1, 1.2 / this.s);
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r * 1.5, 0);
    ctx.moveTo(0, -r * 0.7);
    ctx.lineTo(0, r * 0.7);
    ctx.stroke();
    ctx.fillStyle = "#fff6dc";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  _progressArc(x, y, frac, color) {
    const { ctx } = this;
    const r = Math.max(0.9, 5 / this.s);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.16, 1.6 / this.s);
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frac) * Math.PI * 2);
    ctx.stroke();
  }
};
function renderStats(sim2, el) {
  const s = sim2.getStats();
  const rows = [
    ["time", fmtTime(s.t) + (s.outcome ? ` — ${s.outcome.toUpperCase()}` : "")],
    ["phase", s.opening ? "OPENING (racing first sweep)" : "steady state"],
    ["scarcity", s.scarcity.toFixed(2) + (s.scarcity > 2 ? " (hoarding)" : s.scarcity <= 0.75 ? " (spending freely)" : "")],
    ["—", "—"],
    ["civilians", s.civ],
    ["armed crew", s.armed],
    ["marines", s.marine],
    ["—", "—"],
    ["infection pool", s.infection],
    ["combat forms", `${s.combat} (+${s.combatDowned} downed)`],
    ["carriers", s.carrier],
    ["gestating inside", s.gestating],
    ["—", "—"],
    ["bodies left", s.corpses],
    ["bodies burned", s.corpsesBurned],
    ["flood-held nodes", s.floodControlled],
    ["conversions", s.conversions + (s.conversionsRound ? ` (+${s.conversionsRound} this round)` : "")],
    ["carriers seated", s.carriersSeated],
    ["forms released", s.formsMinted],
    ["distress calls", s.distressCalls]
  ];
  el.innerHTML = rows.map(([k, v]) => k === "—" ? '<div class="sep"></div>' : `<div class="row"><span>${k}</span><b>${v}</b></div>`).join("");
}
function renderLog(sim2, el, maxLines = 300) {
  const stamp = sim2.events.length + ":" + (sim2.events[sim2.events.length - 1]?.t ?? 0);
  if (el._stamp === stamp) return;
  el._stamp = stamp;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const prevTop = el.scrollTop;
  const events = sim2.events.slice(-maxLines);
  el.innerHTML = events.map(
    (e) => `<div class="ev ev-${e.type}"><span class="t">${fmtTime(e.t)}</span> ${escapeHtml(e.msg)}</div>`
  ).join("");
  el.scrollTop = atBottom ? el.scrollHeight : prevTop;
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// sim/main.js
var canvas = document.getElementById("canvas");
var statsEl = document.getElementById("stats");
var logEl = document.getElementById("log");
var SCENARIO_IDS = [
  "startInf",
  "startCf",
  "startCar",
  "inSquads",
  "inSquadSize",
  "inPatrols",
  "inGarrison",
  "inCivilians",
  "inArmed",
  "inMaint",
  "inBodies",
  "inBreachBodies"
];
function swarmOverrides() {
  const num = (id, lo, hi, dflt) => {
    const v = Number(document.getElementById(id).value);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
  };
  return {
    flood: {
      initialInfectionForms: num("startInf", 0, 60, 20),
      initialCombatForms: num("startCf", 0, 20, 4),
      initialCarriers: num("startCar", 0, 6, 0)
    },
    marines: {
      squads: num("inSquads", 0, 8, 4),
      squadSize: num("inSquadSize", 1, 8, 4),
      patrols: num("inPatrols", 0, 6, 3),
      garrison: num("inGarrison", 0, 12, 6)
    },
    crew: {
      civilians: num("inCivilians", 0, 200, 96),
      armedCrew: num("inArmed", 0, 60, 21),
      lowerMaintenance: num("inMaint", 0, 30, 10)
    },
    bodies: {
      eventCorpses: num("inBodies", 0, 400, 150),
      breachCorpses: num("inBreachBodies", 0, 40, 10)
    }
  };
}
var sim = new Sim(document.getElementById("seed").value, swarmOverrides());
var viz = new Viz(canvas, sim);
var paused = false;
var speed = 1;
var acc = 0;
var last = performance.now();
function applyDials() {
  const lambda = Number(document.getElementById("dialLambda").value);
  const q = Number(document.getElementById("dialQ").value);
  const radio = Number(document.getElementById("dialRadio").value);
  sim.P.belief.decayRatePerSec = lambda;
  sim.P.belief.predictionQuality = q;
  sim.P.radio.marineCallReliability = radio;
  document.getElementById("dialLambdaV").textContent = lambda.toFixed(2);
  document.getElementById("dialQV").textContent = q.toFixed(2);
  document.getElementById("dialRadioV").textContent = radio.toFixed(2);
}
function restart() {
  sim = new Sim(document.getElementById("seed").value.trim() || "charon-1", swarmOverrides());
  applyDials();
  viz.setSim(sim);
  acc = 0;
  populateCommandUI();
}
function populateCommandUI() {
  const nodeSel = document.getElementById("cmdNode");
  const doorSel = document.getElementById("cmdDoor");
  const squadSel = document.getElementById("cmdSquad");
  nodeSel.innerHTML = sim.graph.nodes.map((n) => `<option value="${n.idx}">${n.name}</option>`).join("");
  doorSel.innerHTML = sim.graph.edges.map((e, i) => e.lockable ? `<option value="${i}">${sim.graph.node(e.a).name}↔${sim.graph.node(e.b).name}</option>` : "").join("");
  squadSel.innerHTML = sim.squads.map((s) => `<option value="${s.id}">squad ${s.id + 1}</option>`).join("");
}
function wireCommandUI() {
  document.getElementById("cmdIssue").addEventListener("click", () => {
    const squadId = Number(document.getElementById("cmdSquad").value);
    const node = Number(document.getElementById("cmdNode").value);
    const type = document.getElementById("cmdType").value;
    if (type === "RELEASE") sim.issue({ type: CMD.RELEASE, squadId });
    else if (type === "SET_CALL_POLICY") sim.issue({ type: CMD.SET_CALL_POLICY, squadId, policy: "ignore" });
    else if (type === "PATROL") {
      const deck = sim.graph.node(node).deck;
      const route = sim.graph.nodes.filter((n) => n.deck === deck).map((n) => n.idx);
      sim.issue({ type: CMD.PATROL, squadId, route });
    } else sim.issue({ type: CMD[type], squadId, node });
  });
  document.getElementById("cmdSeal").addEventListener("click", () => sim.issue({ type: CMD.SET_DOOR, edgeIdx: Number(document.getElementById("cmdDoor").value), locked: true }));
  document.getElementById("cmdOpen").addEventListener("click", () => sim.issue({ type: CMD.SET_DOOR, edgeIdx: Number(document.getElementById("cmdDoor").value), locked: false }));
  document.getElementById("cmdBurn").addEventListener("click", () => sim.issue({ type: CMD.DESIGNATE_BURN, node: Number(document.getElementById("cmdNode").value) }));
}
function resize() {
  const wrap = document.getElementById("canvasWrap");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
}
window.addEventListener("resize", resize);
resize();
{
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    viz.zoomAt((e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr(), Math.exp(-e.deltaY * 14e-4));
  }, { passive: false });
  let drag = null;
  canvas.addEventListener("mousedown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    viz.pan((e.clientX - drag.x) * dpr(), (e.clientY - drag.y) * dpr());
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mouseup", () => {
    drag = null;
  });
  canvas.addEventListener("dblclick", () => viz.fitShip());
}
document.getElementById("restart").addEventListener("click", restart);
document.getElementById("randomSeed").addEventListener("click", () => {
  document.getElementById("seed").value = "run-" + Math.random().toString(36).slice(2, 8);
  restart();
});
document.getElementById("pause").addEventListener("click", (e) => {
  paused = !paused;
  e.target.textContent = paused ? "run ▶" : "pause ⏸";
});
document.getElementById("step").addEventListener("click", () => {
  paused = true;
  document.getElementById("pause").textContent = "run ▶";
  const target = sim.tickCount + sim.strategicEvery;
  while (sim.tickCount < target) sim.tick();
});
document.getElementById("speed").addEventListener("input", (e) => {
  speed = Math.pow(2, Number(e.target.value));
  document.getElementById("speedVal").textContent = speed >= 1 ? `${speed}×` : `${speed.toFixed(2)}×`;
});
document.getElementById("seed").addEventListener("keydown", (e) => {
  if (e.key === "Enter") restart();
});
for (const id of SCENARIO_IDS) {
  const el = document.getElementById(id);
  el.addEventListener("focus", () => el.select());
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") restart();
  });
}
document.getElementById("legendToggle").addEventListener("click", (e) => {
  const hidden = document.getElementById("legend").classList.toggle("hidden");
  e.target.classList.toggle("active", !hidden);
});
for (const d of document.querySelectorAll("#deckBtns button")) {
  d.addEventListener("click", () => {
    document.querySelectorAll("#deckBtns button").forEach((b) => b.classList.remove("active"));
    d.classList.add("active");
    viz.deckFilter = Number(d.dataset.deck);
  });
}
var ov = (id, key) => document.getElementById(id).addEventListener("change", (e) => {
  viz.overlays[key] = e.target.checked;
});
ov("ovInfluence", "influence");
ov("ovShafts", "shafts");
ov("ovVents", "vents");
ov("ovCalls", "calls");
ov("ovTracker", "tracker");
ov("ovBeliefs", "beliefs");
ov("ovLabels", "labels");
ov("ovConns", "conns");
ov("ovFire", "fire");
for (const id of ["dialLambda", "dialQ", "dialRadio"]) {
  document.getElementById(id).addEventListener("input", applyDials);
}
applyDials();
populateCommandUI();
wireCommandUI();
window.__viz = () => viz;
window.__sim = () => sim;
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1e3);
  last = now;
  if (!paused) {
    acc += dtReal * speed;
    const tickDt = sim.dt;
    let guard = 0;
    while (acc >= tickDt && guard++ < 240) {
      sim.tick();
      acc -= tickDt;
    }
    if (guard >= 240) acc = 0;
  }
  viz.draw(dtReal * (paused ? 0.4 : Math.max(1, speed)));
  renderStats(sim, statsEl);
  renderLog(sim, logEl);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
