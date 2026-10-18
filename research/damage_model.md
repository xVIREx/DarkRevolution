# Modern DarkOrbit damage model (as implemented by the server)

Implemented in `server/src/equipment.rs`. The numbers are in `data/items.json`, and the ammo in `data/lasers.json`.
Bigpoint has never published the formula. The model below is the community one from the DarkOrbit wiki pages
"Maximum LF-4 Damage", "Maximum Prometheus Damage in PvP" and "…vs Mindfire Behemoths". Those pages stack the bonuses one after another, multiplying each in turn.
It agrees with the wiki's "Laser Damage Charts" (2012) to within about 10%.

## Formula (per laser round, max roll, x1)

```
per laser   = base × (1 + lvl × upgradePerLevel) × (1 + item PvE|PvP bonus)
ship        = Σ per laser(ship slots)                × (1 + ship passive) × (1 + module) × (1 + formation laser [+pve|pvp])
drones      = Σ per laser(drone slots) × (1 + drone upgrade lvl) × (1 + drone level 6) × (1 + design dmg) × ship/module/formation
pet         = Σ per laser(P.E.T.)
all groups  × (1 + Seprom refining 0.60) × (1 + Σ damage boosters, cap 0.50) × (1 + Alien Hunter 0.12 | Bounty Hunter 0.16)
round       = (ship + drones + pet [+ overdrive every 5 s]) × ammo mult × roll[0.75..1.0] × dmgMult + flat (LF-4-PD/MD)
```

Boosters of the same stat add to each other (wiki Booster: "DMG-B01 + DMG-B02 = 20%", 50% max). Every other bonus multiplies.
Shield penetration (Moth, Double Arrow, Pincer, Mimesis) lowers the target's absorption.
Rockets: damage × Seprom 1.6 × boosters × formation rocket × Rocket Fusion 1.15.

## Worked example (default maxed build, vs aliens, max roll)

The build has 15 or 16 LF-5 at lvl 20 (+10%), Seprom, DMG-B01, DMG-B02 and MUL-B03 (+25%), Drill (+20%), Alien Hunter (+12%),
10 Iris with 2 LF-5 each (drone lvl 6 +10%, drone upgrade lvl 16 +6%, Havoc +10%), and a P.E.T. with 4 LF-P01.

| ship | per ship laser | x1 | x4 | RSB-75 (x6) | RB-214 (x4; x8 vs Demaner) |
|---|---|---|---|---|---|
| Goliath (DMG-SG01 module +5%) | 760.6 | 33,581 | 134,323 | 201,484 | 134,323 / 268,646 |
| Cyborg (16 lasers, +10% passive) | 796.9 | 35,850 | 143,400 | 215,100 | 143,400 / 286,800 |

PvP swaps Alien Hunter for Bounty Hunter, which adds about 3.6% (Goliath RSB 208,680).
An average roll is about 87.5% of these figures. The "200k–300k per hit" numbers players see are RSB rounds, or
x4 + RSB "combo damage": the wiki "Combo Damage" page explains that two hits are sometimes shown as one number.
The wiki's own peak builds fit this. "Maximum LF-4 Damage" gives the Diminisher 191,940 with RSB and about 320k with a combo.
"Maximum Prometheus Damage" gives about 270k–350k with RSB.

## Sources and confidence

| item | value | source | confidence |
|---|---|---|---|
| LF-1/MP-1/LF-2/LF-3/LF-4 | 65/75/140/175 (+15% PvE)/200 | wiki Laser cannon | high |
| LF-4 MD/PD/HP, Unstable | 230 (+5 flat PvP/PvE), 225 (+0.5% HP), 128–220 | wiki | high |
| LF-5 / LF-5-AL | 245, lvl 20, +0.5%/lvl; AL PvP up to +22–25% with 16–18 equipped | board-en "FAQ – new lasers LF-5 and LF-5 Anchorlock" | high (AL scaling simplified to a flat 22%) |
| Prometheus | 210 + 200 overdrive every 5 s | wiki Prometheus Laser, Overdrive Mechanism | high |
| Laser upgrade lvl 16 | +6% (0.375%/lvl); Prometheus +7.5% | board-en 2014 thread, wiki Maximum LF-4/Prometheus Damage | medium (per-level steps assumed linear) |
| Shield gen upgrade lvl 16 | +6% (same as lasers) | archive wiki Item upgrading (says shields upgrade; no %) | low (guess) |
| Speed gen upgrade | none | archive wiki: only lasers, rocket launchers, shields and drones upgrade | medium |
| Seprom | +60% laser/rocket, +40% shield; Promerium +20% speed | wiki Refining Upgrade | high |
| DMG-B01/B02, MUL-B03 | +10/+10/+5% (additive, cap 50%) | wiki DMG-B01, DMG-B02, KAPPA-B01, Booster | high |
| SHD-B01, HP-B01 | +25% shield, +10% HP; B02 assumed equal | wiki | medium |
| Drone level 6 | +10% lasers / +20% gens | wiki Drone / Iris | high |
| Drone upgrade lvl 16 | +6% | wiki Maximum Prometheus Damage | medium |
| Havoc / Hercules / Spartan | +10% drone dmg / +15% drone shield, +20% HP / +10% dmg, +10% shield, +15% HP | wiki | medium (the wiki's set texts are confusing) |
| Formations (Drill, Pincer, Heart, Turtle, Arrow, Star, Double Arrow, Diamond, Chevron, Moth, Crab, Barrage, Bat, Dome, Ring, Veteran, Wheel) | see items.json | wiki Drone formation table | high |
| Skill tree | Alien Hunter 12%, Bounty Hunter I+II 16%, Rocket Fusion 15%, Shield Engineering 25%, Ship Hull +50,000 HP, Engineering +30% repair, Electro-Optics +25% accuracy | wiki Skill tree / Bounty Hunter / Ship Hull | high (but the real game caps points at 50, so not every skill can be maxed) |
| Ship passives | Enforcer/Diminisher/Venom +5%, Cyborg +10%, Hecate +7% dmg +10% shield, Surgeon +6%, Vanquisher etc. +7% PvP, Spectrum +25% shield … | wiki Designs and ship pages | high |
| Modules | DMG-SG01 +5% (Goliath), DMG-VP01 +10% (Vengeance), DMG-T02 +12% (Tartarus), DMG-MS01 +10% (Mimesis), DMG-NPC01 +15% PvE, Centurion UC-DMG2 +12% | wiki Ship Upgrade Modules | medium (which ships can use which module is simplified) |
| P.E.T. | 4 × LF-P01 (280), gets refining, boosters and skills but not ship, formation or drone bonuses | wiki LF-P01 / DMG-B01 ("affects P.E.T.") | low (slot count and which bonuses apply are guesses) |
| Ammo | x1–x4, RSB x6 (3 s), SAB drain x2, CBO x3 + half SAB, A-BL x4 (x8 Mindfire/Invoke), PIB x4 + infection (+10% dmg taken, −10% speed), IDB ×1.25 per hit up to x6 (reset after 3 s), JOB x3.5 PvE / x2 PvP, RB-214 x4 (x8 Demaner), RCB-140 x7 | wiki ammo pages | high (IDB step multiplicative is medium) |
| Variance | rolls land at 75–100% of max | wiki Laser Damage Charts | medium |

Not modelled: ship active abilities (Diminisher Weaken Shields +50%, Venom/Cyborg Singularity DoT, Spectrum, Solace heal),
Odysseus crits, Asmodeus fervor stacks (only its +25% set bonus is modelled), Tartarus/Hecate abilities,
P.E.T. gears, CBS damage module, premium (which gives no damage).
