// The agent buffer (§2.2) — the ONLY structure that crosses the sim/render
// boundary. The sim writes it every movement tick; renderers (debug view or
// VAT harness) only ever read it. Structure-of-arrays, typed arrays.

export const FACTION = {
  CIVILIAN: 0, ARMED: 1, MARINE: 2,
  INFECTION: 3, COMBAT: 4, CARRIER: 5, CORPSE: 6,
};

export const FLAG = {
  HAS_RADIO: 1 << 0,
  HELPLESS: 1 << 1,
  REANIMATABLE: 1 << 2,
  DOWNED: 1 << 3,
  PANICKED: 1 << 4,
  EXPOSED: 1 << 5,   // infection form currently transiting a vent
  AMBUSH: 1 << 6,    // stationary in a shaft ambush corner
  BURNED: 1 << 7,    // damage >= 100 (permanently out of the economy)
  FLAMER: 1 << 8,    // carries the ship's one flamethrower
  IN_SHAFT: 1 << 9,
};

// Anim clip table (§9). Index = animClip in the buffer.
export const CLIPS = ['idle', 'walk', 'run', 'attack', 'death', 'infect_writhe'];
export const CLIP = { IDLE: 0, WALK: 1, RUN: 2, ATTACK: 3, DEATH: 4, WRITHE: 5 };

export class AgentBuffer {
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
    // previous-tick positions so the renderer can interpolate between the
    // last two sim states (§2.3)
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
    // roll current positions into prev before the sim writes new ones
    this.prevX.set(this.posX);
    this.prevY.set(this.posY);
    this.prevZ.set(this.posZ);
  }
}
