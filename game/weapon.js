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
