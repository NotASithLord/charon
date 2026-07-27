// The held MA5 — ported from first-strike's HeldWeapon (js/weapons.js):
// data-driven auto hitscan with bloom, reload, dry-click, melee. Pure
// mechanics: emits events; main routes 'fire'/'melee_swing' into the sim's
// damage model.

const DEG = Math.PI / 180;

export class HeldWeapon {
  constructor(def) {
    this.def = def;
    this.meleeDuration = 0.52;
    this.reset();
  }

  reset() {
    this.mag = this.def.mag;
    this.reserve = this.def.reserve;
    this.spreadDeg = this.def.spreadBaseDeg;
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.meleeCd = 0;
    this.meleeT = 0;
    this.meleeHitDone = false;
    this.recoil = 0;
    this.triggerWasDown = false;
  }

  startReload(events) {
    if (this.reloading || this.reserve <= 0 || this.mag >= this.def.mag) return;
    this.reloading = true;
    this.reloadT = this.def.reloadS;
    events.push({ t: 'reload_start' });
  }

  // input: { fireHeld, reloadPressed, meleePressed }
  step(dt, input, events, rng = Math.random) {
    const d = this.def;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    this.meleeT = Math.max(0, this.meleeT - dt);
    this.recoil *= Math.exp(-10 * dt);
    this.spreadDeg = Math.max(d.spreadBaseDeg, this.spreadDeg - d.spreadDecayDegS * dt);

    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const take = Math.min(d.mag - this.mag, this.reserve);
        this.mag += take;
        this.reserve -= take;
        this.reloading = false;
        events.push({ t: 'reload_end' });
      }
    }
    if (input.reloadPressed) this.startReload(events);

    // melee connects a beat into the swing
    if (this.meleeT > 0 && !this.meleeHitDone && this.meleeDuration - this.meleeT >= 0.2) {
      this.meleeHitDone = true;
      events.push({ t: 'melee_hit' });
    }
    if (input.meleePressed && this.meleeCd <= 0) {
      this.meleeCd = d.meleeCooldownS;
      this.meleeT = this.meleeDuration;
      this.meleeHitDone = false;
      this.reloading = false;
      events.push({ t: 'melee' });
    }

    const canFire = !this.reloading && this.cooldown <= 0 && this.meleeT <= 0;
    if (input.fireHeld && canFire) {
      if (this.mag <= 0) {
        if (!this.triggerWasDown) { events.push({ t: 'dry' }); this.startReload(events); }
        this.cooldown = 0.25;
      } else {
        this.cooldown = 60 / d.rpm;
        this.mag--;
        this.spreadDeg = Math.min(d.spreadMaxDeg, this.spreadDeg + d.bloomPerShotDeg);
        this.recoil += d.kickDeg * DEG;
        // uniform disc sample inside the current bloom cone
        const ang = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * Math.tan(this.spreadDeg * DEG);
        events.push({ t: 'fire', offAng: ang, offRad: rad });
      }
    }
    this.triggerWasDown = input.fireHeld;
  }
}

// --- the flamethrower ------------------------------------------------------
// Deliberately NOT a HeldWeapon subclass. Every mechanic HeldWeapon exists to
// model — a magazine, a reload, per-shot bloom that grows and decays, discrete
// cooldown-gated shots — is absent here, and inheriting them would leave a
// class whose entire body is overrides that turn the parent off.
//
// What this has instead: one continuous resource, an igniter that has to catch
// before the stream is live, and a trigger whose state matters (the roar has
// to start and stop, and the damage is per-second rather than per-shot).
//
// It emits the same shape of event stream as HeldWeapon so main.js routes it
// through the identical path:
//   flame_on   trigger down and the igniter has caught — start the roar
//   flame      one frame of live stream; `dt` is the burn to apply
//   flame_off  stream ended (trigger up, or the tank ran dry)
//   dry        trigger pulled on an empty tank — one click, no roar
export class FlameThrower {
  constructor(def) {
    this.def = def;
    this.fuel = 0;
    this.live = false;    // stream is out and burning
    this.ignite = 0;      // seconds the trigger has been held this pull
    this.triggerWasDown = false;
    this.dryClicked = false;
  }

  get empty() { return this.fuel <= 0; }
  // 0..1 for the HUD gauge
  get frac() { return this.def.tankUnits > 0 ? this.fuel / this.def.tankUnits : 0; }

  // input: { fireHeld }
  step(dt, input, events) {
    const d = this.def;
    const want = !!input.fireHeld;

    if (!want || this.fuel <= 0) {
      // trigger up, or the tank just ran out mid-burn — either way the stream
      // dies. Report it once, on the transition, so the roar stops once.
      if (this.live) { this.live = false; events.push({ t: 'flame_off' }); }
      this.ignite = 0;
      // a dry pull clicks ONCE per pull, not every frame you hold it
      if (want && this.fuel <= 0 && !this.dryClicked) {
        this.dryClicked = true;
        events.push({ t: 'dry' });
      }
      if (!want) this.dryClicked = false;
      this.triggerWasDown = want;
      return;
    }

    // igniter: fuel is being pushed through from the instant you pull, so it
    // is spent during the catch — you just don't get a stream out of it yet
    this.ignite += dt;
    const burn = Math.min(this.fuel, d.fuelPerSec * dt);
    this.fuel -= burn;
    if (this.ignite < d.ignhitS) { this.triggerWasDown = want; return; }

    if (!this.live) { this.live = true; events.push({ t: 'flame_on' }); }
    events.push({ t: 'flame', dt });
    this.triggerWasDown = want;
  }
}
