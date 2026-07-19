# Lore Audit — sim vs. Halo canon

Checked against Halopedia/Halo Alpha material on the Charon-class light
frigate and Flood gameplay behavior across the rendered games. Each row
says what the sim does, what canon says, and what (if anything) was changed.

## 1. The ship

| Topic | Canon | Sim | Verdict |
|---|---|---|---|
| Class dimensions | Charon-class: **489.7 m** long × 155.6 m wide × 139.2 m tall (e.g. UNSC *Forward Unto Dawn*, FFG-201) | Playable interior 220 m × 5 decks | **OK** — the sim models the pressurized crew section of the forward/mid hull, roughly the dorsal half of the ship. The full hull is mostly hangar volume, MAC shaft, reactor plant and fuel. Documented in `ship.js`. |
| Complement | Up to **782** max complement (crew + embarked troops); a frigate running light carries far fewer | ~160 souls | **OK** — deliberately "running light" post-portal-event; explicit counts are now scenario inputs. |
| Bridge position | Bridge sits **atop the dorsal midship superstructure near the MAC shaft**, not in the bow; ~4 stations (Nav/Ops/Weapons/Comms) + captain | Was at foreAft 0.05 (bow) | **FIXED** — command deck moved to foreAft 0.30–0.50, riding above the habitation deck's fore section, matching the exterior silhouette. |
| Hangar | The Charon-class boasts **one of the largest hangar bays by volume of any frigate**, ventral mid-aft | Two 34×20 m bays + control room + vehicle bay on deck 4, mid-aft | **OK** — largest interior volumes in the sim, positioned mid-aft. |
| ODST / lifeboats | Up to 12 SOEIV drop-pod bays near the rear; Bumblebee lifeboats | Barracks carries the `odst` role; two Lifepod bays on deck 3 | **OK** for POC scope. |
| Cryo | Cryo storage aboard (the *Dawn*'s cryo bay) | Cryo Bay, deck 2, corpse cache | **OK**. |

## 2. Unit speeds

The sim runs at real-world scale (meters, 1.4 m/s purposeful walk), not
game-feel scale — Halo's rendered speeds are inflated (a Spartan sprints
~7–10 m/s). What must survive translation is the **ordering and the
bursts**, which now match:

| Unit | Canon behavior | Sim |
|---|---|---|
| Marine | Tactical, deliberate movement | 1.0× base (1.4 m/s) |
| Civilian crew | Walk; flat sprint when fleeing | 1.0× / 1.5× fleeing |
| Combat form | **Faster than humans; sprints and leaps to close** — "capable of leaping large distances", "will charge recklessly" | 1.25× cruise, **×1.8 CHARGE burst** when entering a space that holds living prey (new). Renderer gets `FLAG.CHARGING` for the sprint/lunge animation. |
| Infection form | Small, quick, skittering swarm | 0.9× (small strides), swarms in packs, vent-capable |
| Carrier | "Slow and blundering", waddling — underestimated | **0.55× (slowed from 0.8 — was too fast for canon)** |

## 3. Flood behavior

| Behavior | Canon | Sim |
|---|---|---|
| Combat forms wield host weapons | "Combat Forms retain the host's previous attributes, therefore they can wield weapons" — they fire wildly | **ADDED** — corpses and grabbed victims record whether the host was armed; forms raised from armed hosts carry the weapon (`FLAG.ARMED_HOST`, +5 dps ranged contribution, rendered with the gun). |
| Unarmed forms rush | "Unarmed attacker forms will rush the player by default" | Matches — the charge burst applies to all combat forms closing on prey. |
| Infection form pop/convert | Latch on, burrow, convert; swarm together | 7 s conversion (user-set), pack rally + escorts, opportunistic same-room grabs. |
| Carrier | Accumulates forms inside; **ruptures when shot or full**, spilling infection forms; waddles toward prey so the pop lands on someone | Matches (previous round) — swell → rupture on fire or at the 8-form limit. |
| Reanimation | Downed combat forms get back up; infection forms can reanimate them | Matches — self-revive roll + infection-form reanimation; marines "make sure" of downed forms. |
| Coordination | The Gravemind/hive coordinates; forms are limbs | Matches — one hive brain, forms as dumb actuators, muster doctrine. |

## 4. Known deliberate deviations

- **Absolute speeds** are realistic-human rather than game-feel; the 3D
  layer can multiply the render clock without touching sim determinism.
- **One flamethrower** aboard is a POC economy lever, not canon loadout.
- **Vents/shafts** as infection-only / crawl-only layers are a design
  simplification of the ship's actual ducting.
- Tank/ranged/stalker **pure forms** (Halo 3) are out of scope for the POC;
  the economy stops at infection/combat/carrier.
