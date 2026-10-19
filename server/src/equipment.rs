//! Ship equipment (DarkOrbit "Config 1/2"): lasers, generators, extras, drones, upgrade levels,
//! drone formations, boosters, P.E.T. — and the modern damage model built from them.
//! Everything is free. All numbers come from data/items.json (sources in research/damage_model.md).
//!
//! Damage per round (max roll, x1 ammo), community model from the DarkOrbit wiki pages
//! "Maximum LF-4 Damage" / "Maximum Prometheus Damage" (sequential multiplicative stacking):
//!
//! ```text
//! per laser   = base × (1 + lvl × upgradePerLevel) × (1 + item pve|pvp)
//! ship group  = Σ per laser                                   (ship slots)
//! drone group = Σ per laser × (1 + droneLevel) × (1 + droneUpgrade) × (1 + design dmg)
//! pet group   = Σ per laser                                   (P.E.T. lasers)
//! common      = (1 + refining) × (1 + Σ dmg boosters, cap 50%) × (1 + skill hunter)
//! ship+drones also × (1 + ship passive) × (1 + module) × (1 + formation laser + formation pve|pvp)
//! round       = (ship + drones + pet [+ overdrive]) × ammo mult × variance roll × dmgMult + flat
//! ```

use crate::data::{Items, Ship};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct DroneCfg {
    #[serde(rename = "type")]
    pub kind: String,
    /// One laser or shield-generator id per drone slot.
    #[serde(default)]
    pub items: Vec<String>,
    /// Upgrade level of each item (parallel to `items`).
    #[serde(default, rename = "itemLvls")]
    pub item_lvls: Vec<u8>,
    /// Drone upgrade level (0..16).
    #[serde(default = "max16")]
    pub lvl: u8,
}

fn max16() -> u8 {
    16
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct EquipConfig {
    pub lasers: Vec<String>,
    /// Upgrade level per laser slot (parallel to `lasers`).
    #[serde(default, rename = "laserLvls")]
    pub laser_lvls: Vec<u8>,
    /// Shield and/or speed generator ids.
    pub gens: Vec<String>,
    #[serde(default, rename = "genLvls")]
    pub gen_lvls: Vec<u8>,
    pub extras: Vec<String>,
    pub drones: Vec<DroneCfg>,
    #[serde(rename = "droneDesign")]
    pub drone_design: Option<String>,
}

/// Make the level arrays match the item arrays; missing levels default to the item's max.
pub fn normalize(items: &Items, cfg: &mut EquipConfig) {
    fn fix(items: &Items, ids: &[String], lvls: &mut Vec<u8>) {
        lvls.truncate(ids.len());
        while lvls.len() < ids.len() {
            lvls.push(items.max_level(&ids[lvls.len()]));
        }
        for (l, id) in lvls.iter_mut().zip(ids) {
            *l = (*l).min(items.max_level(id));
        }
    }
    fix(items, &cfg.lasers, &mut cfg.laser_lvls);
    fix(items, &cfg.gens, &mut cfg.gen_lvls);
    for d in &mut cfg.drones {
        fix(items, &d.items, &mut d.item_lvls);
        d.lvl = d.lvl.min(16);
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Slots {
    pub lasers: u32,
    pub gens: u32,
    pub extras: u32,
    pub drones: u32,
    pub pet: u32,
}

pub fn slots(ship: &Ship, items: &Items) -> Slots {
    Slots {
        lasers: ship.lasers.max(0.0) as u32,
        gens: ship.generators.max(0.0) as u32,
        extras: ship.extras.max(0.0) as u32,
        drones: items.max_drones,
        pet: items.pet.lasers,
    }
}

/// Non-config loadout state: active formation and boosters, plus the account-wide bonuses
/// (skill tree, Seprom refining, P.E.T.) that the daily season sells and sandbox gives away.
#[derive(Clone, Debug, PartialEq)]
pub struct Loadout {
    pub formation: String,
    pub boosters: Vec<String>,
    pub skills: bool,
    pub refining: bool,
    pub pet: bool,
}

impl Loadout {
    /// Best end-game default: Drill formation, every booster on.
    pub fn best(items: &Items) -> Loadout {
        Loadout {
            formation: if items.formation("drill").is_some() { "drill".into() } else { "standard".into() },
            boosters: items.boosters.iter().map(|b| b.id.clone()).collect(),
            skills: true,
            refining: true,
            pet: true,
        }
    }

    /// Fresh season pilot: Standard formation, nothing unlocked.
    pub fn bare() -> Loadout {
        Loadout { formation: "standard".into(), boosters: vec![], skills: false, refining: false, pet: false }
    }
}

/// One multiplier in the damage chain (`pve`/`pvp` are the factor values, e.g. 1.6).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Factor {
    pub label: String,
    pub pve: f64,
    pub pvp: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Group {
    pub name: String,
    pub lasers: u32,
    /// Σ laser base damage incl. upgrade levels and item PvE/PvP bonuses.
    #[serde(rename = "basePve")]
    pub base_pve: f64,
    #[serde(rename = "basePvp")]
    pub base_pvp: f64,
    pub factors: Vec<Factor>,
    /// Group total per round at x1 (max roll).
    #[serde(rename = "totalPve")]
    pub total_pve: f64,
    #[serde(rename = "totalPvp")]
    pub total_pvp: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AmmoRow {
    pub id: String,
    pub mult: f64,
    pub pve: f64,
    pub pvp: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Breakdown {
    pub groups: Vec<Group>,
    #[serde(rename = "x1Pve")]
    pub x1_pve: f64,
    #[serde(rename = "x1Pvp")]
    pub x1_pvp: f64,
    /// Extra x1 damage on overdrive rounds (Prometheus/Caucasus), every `overdriveMs`.
    #[serde(rename = "overdrivePve")]
    pub overdrive_pve: f64,
    #[serde(rename = "flatPve")]
    pub flat_pve: f64,
    #[serde(rename = "flatPvp")]
    pub flat_pvp: f64,
    /// Max per-round damage for each ammo (filled in by the caller with lasers.json).
    #[serde(rename = "perAmmo")]
    pub per_ammo: Vec<AmmoRow>,
    /// Rolls land in [1 - variance, 1] × these numbers.
    pub variance: f64,
    pub rocket: Vec<Factor>,
}

/// Derived stats of a config (also sent to the client in `you.stats`).
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Stats {
    /// Laser damage per round at x1 vs aliens (max roll, no overdrive).
    pub damage: f64,
    #[serde(rename = "damagePvp")]
    pub damage_pvp: f64,
    #[serde(rename = "overdrivePve")]
    pub overdrive_pve: f64,
    #[serde(rename = "overdrivePvp")]
    pub overdrive_pvp: f64,
    #[serde(rename = "flatPve")]
    pub flat_pve: f64,
    #[serde(rename = "flatPvp")]
    pub flat_pvp: f64,
    /// Multiplier on rocket base damage.
    #[serde(rename = "rocketMult")]
    pub rocket_mult: f64,
    #[serde(rename = "rocketCdMult")]
    pub rocket_cd_mult: f64,
    pub shield: f64,
    /// Fraction of incoming damage the shield absorbs.
    pub absorb: f64,
    /// Reduces the target's absorption by this fraction.
    pub penetration: f64,
    pub speed: f64,
    pub hp: f64,
    /// Hull repair HP/s out of combat (best repair bot).
    pub repair: f64,
    #[serde(rename = "shieldRegen")]
    pub shield_regen: f64,
    #[serde(rename = "shieldDrain")]
    pub shield_drain: f64,
    #[serde(rename = "missMult")]
    pub miss_mult: f64,
    #[serde(rename = "autoRocket")]
    pub auto_rocket: bool,
    pub variance: f64,
    pub formation: String,
    pub boosters: Vec<String>,
    #[serde(rename = "damageBreakdown")]
    pub damage_breakdown: Breakdown,
}

fn f(label: impl Into<String>, pve: f64, pvp: f64) -> Factor {
    Factor { label: label.into(), pve, pvp }
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Laser sums (pve, pvp, overdrive, flat_pve, flat_pvp, hp bonus) of a list of items with levels.
fn laser_sum(items: &Items, ids: &[String], lvls: &[u8]) -> (f64, f64, f64, f64, f64, f64, u32) {
    let (mut pve, mut pvp, mut od, mut fpve, mut fpvp, mut hp, mut n) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0);
    for (i, id) in ids.iter().enumerate() {
        let Some(l) = items.laser(id) else { continue };
        let lvl = lvls.get(i).copied().unwrap_or(l.max_level).min(l.max_level) as f64;
        let up = 1.0 + lvl * l.upgrade_per_level;
        pve += l.damage * up * (1.0 + l.pve);
        pvp += l.damage * up * (1.0 + l.pvp);
        od += l.overdrive * up;
        fpve += l.flat_pve;
        fpvp += l.flat_pvp;
        hp += l.hp_per_laser;
        n += 1;
    }
    (pve, pvp, od, fpve, fpvp, hp, n)
}

pub fn compute_stats(ship: &Ship, items: &Items, cfg: &EquipConfig, lo: &Loadout) -> Stats {
    let dm = &items.damage_model;
    let none = crate::data::ShipBonus::default();
    let sb = items.ship_bonuses.get(&ship.id).unwrap_or(&none);
    let std_f = crate::data::Formation::default();
    let form = items.formation(&lo.formation).unwrap_or(&std_f);
    let boosters: Vec<&crate::data::Booster> = lo.boosters.iter().filter_map(|b| items.booster(b)).collect();
    let cap = |v: f64| v.min(dm.booster_cap);
    let b_dmg = cap(boosters.iter().map(|b| b.damage).sum());
    let b_shd = cap(boosters.iter().map(|b| b.shield).sum());
    let b_hp = cap(boosters.iter().map(|b| b.hp).sum());
    let b_rep = cap(boosters.iter().map(|b| b.repair).sum());
    let (no_sk, no_rf) = (crate::data::Skills::default(), crate::data::Refining::default());
    let sk = if lo.skills { &items.skills } else { &no_sk };
    let rf = if lo.refining { &items.refining } else { &no_rf };
    let design = cfg
        .drone_design
        .as_deref()
        .and_then(|d| items.drone_design(d))
        .filter(|d| !cfg.drones.is_empty() && cfg.drones.len() as u32 >= d.min_drones);

    // ---- lasers
    let (s_pve, s_pvp, s_od, s_fpve, s_fpvp, s_hp, s_n) = laser_sum(items, &cfg.lasers, &cfg.laser_lvls);
    let (mut d_pve, mut d_pvp, mut d_od, mut d_fpve, mut d_fpvp, mut d_n) = (0.0, 0.0, 0.0, 0.0, 0.0, 0);
    for d in &cfg.drones {
        let (pve, pvp, od, fpve, fpvp, _, n) = laser_sum(items, &d.items, &d.item_lvls);
        let up = 1.0 + d.lvl as f64 * dm.drone_upgrade_per_level;
        d_pve += pve * up;
        d_pvp += pvp * up;
        d_od += od * up;
        d_fpve += fpve;
        d_fpvp += fpvp;
        d_n += n;
    }
    let pet_n = if lo.pet { items.pet.lasers } else { 0 };
    let pet_ids: Vec<String> = (0..pet_n).map(|_| items.pet.laser.clone()).collect();
    let (p_pve, p_pvp, p_od, _, _, _, p_n) = laser_sum(items, &pet_ids, &[]);

    let common = vec![
        f("Refining (Seprom)", 1.0 + rf.laser, 1.0 + rf.laser),
        f("Boosters", 1.0 + b_dmg, 1.0 + b_dmg),
        f("Skill: Alien Hunter / Bounty Hunter", 1.0 + sk.alien_hunter, 1.0 + sk.bounty_hunter),
    ];
    let mut ship_f = vec![];
    if sb.damage != 0.0 || sb.pve != 0.0 || sb.pvp != 0.0 {
        ship_f.push(f("Ship passive", 1.0 + sb.damage + sb.pve, 1.0 + sb.damage + sb.pvp));
    }
    if sb.module_damage != 0.0 {
        ship_f.push(f(format!("Module {}", sb.module), 1.0 + sb.module_damage, 1.0 + sb.module_damage));
    }
    ship_f.push(f(
        format!("Formation {}", if form.name.is_empty() { "Standard" } else { &form.name }),
        1.0 + form.laser + form.pve,
        1.0 + form.laser + form.pvp,
    ));
    let mut drone_f = vec![
        f("Drone level 6", 1.0 + dm.drone_level_laser, 1.0 + dm.drone_level_laser),
        f("Drone upgrade (avg, in base)", 1.0, 1.0),
    ];
    if let Some(dd) = design {
        drone_f.push(f(format!("Design {}", dd.name), 1.0 + dd.damage, 1.0 + dd.damage));
    }
    let prod = |fs: &[Factor]| -> (f64, f64) { fs.iter().fold((1.0, 1.0), |(a, b), x| (a * x.pve, b * x.pvp)) };
    let mut groups = vec![];
    let mut mk = |name: &str, n: u32, pve: f64, pvp: f64, fs: Vec<Factor>| -> (f64, f64, f64, f64) {
        let (mpve, mpvp) = prod(&fs);
        let g = Group {
            name: name.into(),
            lasers: n,
            base_pve: r2(pve),
            base_pvp: r2(pvp),
            total_pve: r2(pve * mpve),
            total_pvp: r2(pvp * mpvp),
            factors: fs,
        };
        groups.push(g);
        (pve * mpve, pvp * mpvp, mpve, mpvp)
    };
    let ship_all: Vec<Factor> = ship_f.iter().cloned().chain(common.iter().cloned()).collect();
    let drone_all: Vec<Factor> = drone_f.iter().cloned().chain(ship_f.iter().cloned()).chain(common.iter().cloned()).collect();
    let (sp, sv, sm, _) = mk("Ship", s_n, s_pve, s_pvp, ship_all);
    let (dp, dv, dmul, _) = mk("Drones", d_n, d_pve, d_pvp, drone_all);
    let (pp, pv, pm, _) = mk("P.E.T.", p_n, p_pve, p_pvp, common.clone());
    let od_pve = s_od * sm + d_od * dmul + p_od * pm;
    let od_pvp = od_pve; // overdrive gets the same chain (wiki Overdrive Mechanism)

    // ---- rockets: refining × boosters × formation × Rocket Fusion
    let rocket = vec![
        f("Refining (Seprom)", 1.0 + rf.rocket, 1.0 + rf.rocket),
        f("Boosters", 1.0 + b_dmg, 1.0 + b_dmg),
        f("Formation", 1.0 + form.rocket, 1.0 + form.rocket),
        f("Skill: Rocket Fusion", 1.0 + sk.rocket_fusion, 1.0 + sk.rocket_fusion),
    ];
    let rocket_mult = prod(&rocket).0;

    // ---- shields: ship gens + drone gens
    let (mut shield, mut absorbed) = (0.0, 0.0);
    let mut speed_gens = 0.0;
    for (i, id) in cfg.gens.iter().enumerate() {
        if let Some(g) = items.shield_gen(id) {
            let lvl = cfg.gen_lvls.get(i).copied().unwrap_or(g.max_level).min(g.max_level) as f64;
            let v = g.shield * (1.0 + lvl * g.upgrade_per_level);
            shield += v;
            absorbed += v * g.absorb;
        } else if let Some(g) = items.speed_gen(id) {
            let lvl = cfg.gen_lvls.get(i).copied().unwrap_or(0) as f64;
            speed_gens += g.speed * (1.0 + lvl * g.upgrade_per_level);
        }
    }
    for d in &cfg.drones {
        let up = 1.0 + d.lvl as f64 * dm.drone_upgrade_per_level;
        for (i, id) in d.items.iter().enumerate() {
            if let Some(g) = items.shield_gen(id) {
                let lvl = d.item_lvls.get(i).copied().unwrap_or(g.max_level).min(g.max_level) as f64;
                let v = g.shield
                    * (1.0 + lvl * g.upgrade_per_level)
                    * up
                    * (1.0 + dm.drone_level_gen)
                    * (1.0 + design.map(|d| d.shield).unwrap_or(0.0));
                shield += v;
                absorbed += v * g.absorb;
            }
        }
    }
    let absorb = if shield > 0.0 { (absorbed / shield * (1.0 + form.absorb)).clamp(0.0, 1.0) } else { 0.0 };
    let shield = shield
        * (1.0 + rf.shield)
        * (1.0 + b_shd)
        * (1.0 + sb.shield)
        * (1.0 + form.shield)
        * (1.0 + sk.shield_engineering);
    let hp = (ship.hp.max(1.0) + sk.ship_hull)
        * (1.0 + b_hp)
        * (1.0 + sb.hp)
        * (1.0 + design.map(|d| d.hp).unwrap_or(0.0))
        * (1.0 + form.hp)
        * (1.0 + s_hp);
    let speed = (ship.speed + speed_gens * (1.0 + rf.speed)) * (1.0 + form.speed) * (1.0 + sb.speed);

    let mut repair: f64 = 0.0;
    let mut miss_mult: f64 = 1.0 - sk.electro_optics;
    let mut auto_rocket = false;
    for e in cfg.extras.iter().filter_map(|id| items.extra(id)) {
        repair = repair.max(e.repair);
        if let Some(m) = e.miss_mult {
            miss_mult = miss_mult.min(m);
        }
        auto_rocket |= e.auto_rocket;
    }
    repair *= (1.0 + sk.engineering) * (1.0 + b_rep);

    let x1_pve = sp + dp + pp;
    let x1_pvp = sv + dv + pv;
    Stats {
        damage: r2(x1_pve),
        damage_pvp: r2(x1_pvp),
        overdrive_pve: r2(od_pve),
        overdrive_pvp: r2(od_pvp),
        flat_pve: s_fpve + d_fpve,
        flat_pvp: s_fpvp + d_fpvp,
        rocket_mult: (rocket_mult * 10000.0).round() / 10000.0,
        rocket_cd_mult: (1.0 + form.rocket_cooldown).max(0.1),
        shield: r2(shield),
        absorb: (absorb * 10000.0).round() / 10000.0,
        penetration: (sb.penetration + form.penetration).max(-1.0),
        speed: r2(speed),
        hp: r2(hp),
        repair: r2(repair),
        shield_regen: form.shield_regen,
        shield_drain: form.shield_drain,
        miss_mult: miss_mult.max(0.0),
        auto_rocket,
        variance: dm.variance,
        formation: lo.formation.clone(),
        boosters: lo.boosters.clone(),
        damage_breakdown: Breakdown {
            groups,
            x1_pve: r2(x1_pve),
            x1_pvp: r2(x1_pvp),
            overdrive_pve: r2(od_pve),
            flat_pve: s_fpve + d_fpve,
            flat_pvp: s_fpvp + d_fpvp,
            per_ammo: vec![],
            variance: dm.variance,
            rocket,
        },
    }
}

/// Fill `perAmmo` rows of the breakdown (max per round, no overdrive) for each ammo.
pub fn fill_ammo_rows(stats: &mut Stats, ammo: &[crate::data::Ammo]) {
    stats.damage_breakdown.per_ammo = ammo
        .iter()
        .map(|a| {
            let (mpve, mpvp) = if a.is_sab() { (0.0, 0.0) } else { (a.mult_for(Some("")), a.mult_for(None)) };
            let top = a.ramp.as_ref().map(|r| r.max).unwrap_or(1.0);
            AmmoRow {
                id: a.id.clone(),
                mult: a.mult,
                pve: r2(stats.damage * mpve * top + stats.flat_pve),
                pvp: r2(stats.damage_pvp * mpvp * top + stats.flat_pvp),
            }
        })
        .collect();
}

/// Validate a config against the item catalogue and the ship's slots.
pub fn validate(ship: &Ship, items: &Items, cfg: &EquipConfig) -> Result<(), String> {
    let s = slots(ship, items);
    if cfg.lasers.len() as u32 > s.lasers {
        return Err(format!("{} has only {} laser slots", ship.name, s.lasers));
    }
    if cfg.gens.len() as u32 > s.gens {
        return Err(format!("{} has only {} generator slots", ship.name, s.gens));
    }
    if cfg.extras.len() as u32 > s.extras {
        return Err(format!("{} has only {} extra slots", ship.name, s.extras));
    }
    if cfg.drones.len() as u32 > s.drones {
        return Err(format!("At most {} drones", s.drones));
    }
    if let Some(id) = cfg.lasers.iter().find(|id| items.laser(id).is_none_or(|l| l.pet_only)) {
        return Err(format!("'{}' is not a ship laser", id));
    }
    if let Some(id) = cfg.gens.iter().find(|id| items.shield_gen(id).is_none() && items.speed_gen(id).is_none()) {
        return Err(format!("'{}' is not a generator", id));
    }
    if let Some(id) = cfg.extras.iter().find(|id| items.extra(id).is_none()) {
        return Err(format!("'{}' is not an extra", id));
    }
    for d in &cfg.drones {
        let Some(t) = items.drone(&d.kind) else {
            return Err(format!("'{}' is not a drone", d.kind));
        };
        if d.items.len() as u32 > t.slots {
            return Err(format!("{} has only {} slot(s)", t.name, t.slots));
        }
        if let Some(id) = d
            .items
            .iter()
            .find(|id| items.laser(id).is_none_or(|l| l.pet_only || id.as_str() == "lf5-al") && items.shield_gen(id).is_none())
        {
            return Err(format!("'{}' cannot be equipped on a drone", id));
        }
    }
    if let Some(dd) = &cfg.drone_design {
        if items.drone_design(dd).is_none() {
            return Err(format!("'{}' is not a drone design", dd));
        }
    }
    Ok(())
}

fn first_of(items: &Items, ids: &[&str], exists: impl Fn(&Items, &str) -> bool) -> Option<String> {
    ids.iter().find(|id| exists(items, id)).map(|s| s.to_string())
}

/// Maxed end-game loadouts, every item at its max upgrade level. Both configs: LF-5 (lvl 20) in
/// every laser slot, 10 Iris with 2×LF-5, Spartan, so damage is identical. Config 1 = speed
/// (all G3N-7900), config 2 = shield (all SG3N-B03).
pub fn default_configs(ship: &Ship, items: &Items) -> [EquipConfig; 2] {
    let s = slots(ship, items);
    let laser = first_of(items, &["lf5", "prometheus", "lf4"], |i, x| i.laser(x).is_some())
        .or_else(|| items.lasers.iter().filter(|l| !l.pet_only).max_by(|a, b| a.damage.total_cmp(&b.damage)).map(|l| l.id.clone()));
    let shield = first_of(items, &["sg3n-b03", "sg3n-b02"], |i, x| i.shield_gen(x).is_some())
        .or_else(|| items.shield_gens.first().map(|g| g.id.clone()));
    let speed = first_of(items, &["g3n-7900"], |i, x| i.speed_gen(x).is_some()).or_else(|| items.speed_gens.last().map(|g| g.id.clone()));
    let drone = first_of(items, &["iris"], |i, x| i.drone(x).is_some()).or_else(|| items.drones.first().map(|d| d.id.clone()));
    let design = |id: &str| items.drone_design(id).map(|d| d.id.clone());

    let lasers: Vec<String> = laser.iter().cycle().take(s.lasers as usize).cloned().collect();
    let mut extras_pool: Vec<String> = vec![];
    if let Some(r) = items.extras.iter().filter(|e| e.repair > 0.0).max_by(|a, b| a.repair.total_cmp(&b.repair)) {
        extras_pool.push(r.id.clone());
    }
    for pick in ["aim-02", "arol-x"] {
        if items.extra(pick).is_some() {
            extras_pool.push(pick.into());
        }
    }
    let extras: Vec<String> = extras_pool.into_iter().take(s.extras as usize).collect();

    let gens1: Vec<String> = (0..s.gens as usize).filter_map(|_| speed.clone().or(shield.clone())).collect();
    let gens2: Vec<String> = (0..s.gens as usize).filter_map(|_| shield.clone().or(speed.clone())).collect();

    let drone_slots = drone.as_deref().and_then(|d| items.drone(d)).map(|d| d.slots).unwrap_or(0) as usize;
    let mk_drones = |item: &Option<String>| -> Vec<DroneCfg> {
        match &drone {
            None => vec![],
            Some(kind) => (0..s.drones)
                .map(|_| DroneCfg {
                    kind: kind.clone(),
                    items: item.iter().cycle().take(drone_slots).cloned().collect(),
                    item_lvls: vec![],
                    lvl: 16,
                })
                .collect(),
        }
    };
    let mut c = [
        EquipConfig {
            lasers: lasers.clone(),
            gens: gens1,
            extras: extras.clone(),
            drones: mk_drones(&laser),
            drone_design: design("spartan").or_else(|| design("havoc")),
            ..Default::default()
        },
        EquipConfig {
            lasers,
            gens: gens2,
            extras,
            drones: mk_drones(&laser),
            drone_design: design("spartan").or_else(|| design("havoc")),
            ..Default::default()
        },
    ];
    for cfg in &mut c {
        normalize(items, cfg);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ship(id: &str, lasers: f64, gens: f64) -> Ship {
        Ship {
            id: id.into(),
            name: id.into(),
            hp: 256000.0,
            speed: 300.0,
            lasers,
            generators: gens,
            extras: 3.0,
            ..Default::default()
        }
    }
    fn goliath() -> Ship {
        ship("ship_goliath", 15.0, 15.0)
    }
    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    /// Worked example (research/damage_model.md): maxed Goliath, x1 vs aliens, max roll.
    /// per ship LF-5 = 245 × 1.10 (lvl 20) × 1.05 (DMG-SG01) × 1.20 (Drill) × 1.60 (Seprom)
    ///               × 1.25 (DMG-B01+B02+MUL-B03) × 1.12 (Alien Hunter) = 760.64
    /// ship 15 × 760.64 = 11,409.6; drones 20 × 760.64 × 1.10 × 1.06 × 1.10 = 19,512.0;
    /// P.E.T. 4 × 280 × 1.06 × 1.6 × 1.25 × 1.12 = 2,659.3  → x1 33,580.9
    #[test]
    fn worked_example_goliath() {
        let items = Items::default();
        let [c1, _] = default_configs(&goliath(), &items);
        let s = compute_stats(&goliath(), &items, &c1, &Loadout::best(&items));
        let per = 245.0 * 1.10 * 1.05 * 1.20 * 1.60 * 1.25 * 1.12;
        assert!(close(per, 760.64, 0.01));
        let ship_g = 15.0 * per;
        let drones = 20.0 * per * 1.10 * 1.06 * 1.10;
        let pet = 4.0 * 280.0 * 1.06 * 1.60 * 1.25 * 1.12;
        assert!(close(s.damage, ship_g + drones + pet, 0.05), "{} vs {}", s.damage, ship_g + drones + pet);
        assert!(close(s.damage, 33580.9, 1.0));
        // x4 ≈ 134k, RSB (x6) ≈ 201k per round
        assert!(close(s.damage * 4.0, 134_323.0, 5.0));
        assert!(close(s.damage * 6.0, 201_485.0, 8.0));
        // PvP swaps Alien Hunter 12% for Bounty Hunter 16%
        assert!(close(s.damage_pvp / s.damage, 1.16 / 1.12, 1e-6));
    }

    #[test]
    fn cyborg_has_more_slots_and_passive() {
        let items = Items::default();
        let cy = ship("ship_cyborg", 16.0, 16.0);
        let [c1, _] = default_configs(&cy, &items);
        let s = compute_stats(&cy, &items, &c1, &Loadout::best(&items));
        let per = 245.0 * 1.10 * 1.10 * 1.20 * 1.60 * 1.25 * 1.12;
        let expect = 16.0 * per + 20.0 * per * 1.10 * 1.06 * 1.10 + 4.0 * 280.0 * 1.06 * 1.60 * 1.25 * 1.12;
        assert!(close(s.damage, expect, 0.05));
        assert!(s.damage * 6.0 > 210_000.0);
    }

    #[test]
    fn upgrade_levels_and_formation_matter() {
        let items = Items::default();
        let g = goliath();
        let lo = Loadout { formation: "standard".into(), boosters: vec![], skills: true, refining: true, pet: true };
        let mut cfg = EquipConfig { lasers: vec!["lf4".into()], ..Default::default() };
        normalize(&items, &mut cfg);
        assert_eq!(cfg.laser_lvls, vec![16]);
        let base = 200.0 * 1.06 * 1.05 * 1.60 * 1.12; // lvl16, module, seprom, alien hunter
        let pet = 4.0 * 280.0 * 1.06 * 1.60 * 1.12;
        assert!(close(compute_stats(&g, &items, &cfg, &lo).damage, base + pet, 0.05));
        cfg.laser_lvls = vec![0];
        assert!(close(compute_stats(&g, &items, &cfg, &lo).damage, base / 1.06 + pet, 0.05));
        let drill = Loadout { formation: "drill".into(), boosters: vec![], skills: true, refining: true, pet: true };
        let d = compute_stats(&g, &items, &cfg, &drill);
        assert!(close(d.damage, base / 1.06 * 1.2 + pet, 0.05));
        assert!(d.speed < compute_stats(&g, &items, &cfg, &lo).speed);
        let heart = Loadout { formation: "heart".into(), boosters: vec![], skills: true, refining: true, pet: true };
        let h = compute_stats(&g, &items, &cfg, &heart);
        assert!(close(h.hp, (256000.0 + 50000.0) * 1.2, 0.5));
    }

    #[test]
    fn boosters_are_additive_and_capped() {
        let items = Items::default();
        let lo = Loadout::best(&items);
        let s = compute_stats(&goliath(), &items, &EquipConfig::default(), &lo);
        // only the P.E.T. shoots: boosters 10+10+5 = 25%
        assert!(close(s.damage, 4.0 * 280.0 * 1.06 * 1.6 * 1.25 * 1.12, 0.05));
        // SHD-B01 + SHD-B02 + MUL-B03 = 55% -> capped at 50%: no shield gens => 0 anyway
        assert_eq!(s.shield, 0.0);
    }

    #[test]
    fn shields_and_absorb() {
        let items = Items::default();
        let lo = Loadout { formation: "standard".into(), boosters: vec![], skills: true, refining: true, pet: true };
        let mut cfg = EquipConfig { gens: vec!["sg3n-a01".into(), "sg3n-b02".into()], gen_lvls: vec![0, 0], ..Default::default() };
        normalize(&items, &mut cfg);
        let s = compute_stats(&goliath(), &items, &cfg, &lo);
        assert!(close(s.shield, 11000.0 * 1.4 * 1.25, 0.01));
        assert!(close(s.absorb, (1000.0 * 0.4 + 10000.0 * 0.8) / 11000.0, 1e-4));
        cfg.gen_lvls = vec![16, 16];
        assert!(close(compute_stats(&goliath(), &items, &cfg, &lo).shield, 11000.0 * 1.06 * 1.4 * 1.25, 0.01));
    }

    #[test]
    fn default_build_is_maxed() {
        let items = Items::default();
        let [c1, c2] = default_configs(&goliath(), &items);
        validate(&goliath(), &items, &c1).unwrap();
        validate(&goliath(), &items, &c2).unwrap();
        assert_eq!(c1.lasers, vec!["lf5".to_string(); 15]);
        assert_eq!(c1.laser_lvls, vec![20; 15]);
        assert_eq!(c1.drones.len(), 10);
        assert!(c1.drones.iter().all(|d| d.lvl == 16 && d.item_lvls == vec![20, 20]));
        let s2 = compute_stats(&goliath(), &items, &c2, &Loadout::best(&items));
        let s1 = compute_stats(&goliath(), &items, &c1, &Loadout::best(&items));
        // config 1 = speed, config 2 = shield; drones carry lasers in both, so damage is equal
        assert!(s2.shield > s1.shield && s1.speed > s2.speed);
        assert_eq!(s1.damage, s2.damage);
    }

    #[test]
    fn validation_rejects() {
        let items = Items::default();
        let g = goliath();
        let too_many = EquipConfig { lasers: vec!["lf4".into(); 16], ..Default::default() };
        assert!(validate(&g, &items, &too_many).is_err());
        let wrong = EquipConfig { gens: vec!["lf4".into()], ..Default::default() };
        assert!(validate(&g, &items, &wrong).is_err());
        let pet_laser = EquipConfig { lasers: vec!["lf-p01".into()], ..Default::default() };
        assert!(validate(&g, &items, &pet_laser).is_err());
        let flax = EquipConfig {
            drones: vec![DroneCfg { kind: "flax".into(), items: vec!["lf4".into(), "lf4".into()], ..Default::default() }],
            ..Default::default()
        };
        assert!(validate(&g, &items, &flax).is_err());
        let eleven = EquipConfig { drones: vec![DroneCfg { kind: "iris".into(), ..Default::default() }; 11], ..Default::default() };
        assert!(validate(&g, &items, &eleven).is_err());
        let bad_design = EquipConfig { drone_design: Some("nope".into()), ..Default::default() };
        assert!(validate(&g, &items, &bad_design).is_err());
    }
}
