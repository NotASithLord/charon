// FPS mechanics constants — ported from the first-strike vertical slice
// (js/data.js), tuned for the Charon. Decoupling contract preserved:
// mechanics read these rows, nothing hardcodes a name.

export const MA5 = {
  name: 'MA5 ASSAULT RIFLE', // what every marine aboard carries
  rpm: 900,
  damage: 8,
  mag: 60,
  reserve: 240,
  reloadS: 2.3,
  spreadBaseDeg: 1.35,
  spreadMaxDeg: 6.2,
  bloomPerShotDeg: 0.38,
  spreadDecayDegS: 4.4,
  kickDeg: 0.2,
  meleeDamage: 45,
  meleeRange: 2.2,
  meleeCooldownS: 0.9,
};

export const ODST = {
  // "an ODST with extra life": ballistic armor over meat — the armor layer
  // soaks damage and recovers when you break contact; the health under it
  // does not.
  armor: 50,
  health: 45,
  armorDelayS: 4.2,
  armorRegenPerS: 22,
  // movement (first-strike player feel — the old 2.4 m/s walk read as mud)
  walkSpeed: 5.6,
  sprintSpeed: 7.6,
  accel: 14,
  airControl: 0.35,
  gravity: 24,
  jumpVel: 8.2,
  eyeHeight: 1.62,
  climbSpeed: 2.6,
};

export const DOORS = {
  openRadius: 2.6,   // any body this close slides the door open
  slideSpeed: 4.5,   // m/s of panel travel
};
