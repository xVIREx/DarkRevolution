//! Game data loaded from `data/*.json` (see CONTRACT.md). All structs are lenient:
//! unknown fields are ignored, missing ones take defaults, and entries that fail to
//! parse are skipped with a warning instead of aborting startup.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Accept a number (int or float) or a numeric string as u32.
pub fn lenient_u32<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match &v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0) as u32,
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0) as u32,
        _ => 0,
    })
}

/// Accept a number or a string, stored as String.
fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ShipDesign {
    pub id: String,
    pub name: String,
    pub sheet: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Ship {
    pub id: String,
    pub name: String,
    pub hp: f64,
    pub speed: f64,
    pub lasers: f64,
    pub generators: f64,
    pub extras: f64,
    pub cargo: f64,
    pub sheet: String,
    pub designs: Vec<ShipDesign>,
}

impl Default for Ship {
    fn default() -> Self {
        Ship {
            id: String::new(),
            name: String::new(),
            hp: 100000.0,
            speed: 300.0,
            lasers: 10.0,
            generators: 10.0,
            extras: 0.0,
            cargo: 0.0,
            sheet: String::new(),
            designs: vec![],
        }
    }
}

impl Ship {
    pub fn sheet_for(&self, design: Option<&str>) -> String {
        let s = design
            .and_then(|d| self.designs.iter().find(|x| x.id == d))
            .map(|d| if d.sheet.is_empty() { d.id.clone() } else { d.sheet.clone() });
        s.unwrap_or_else(|| if self.sheet.is_empty() { self.id.clone() } else { self.sheet.clone() })
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct NpcDef {
    pub id: String,
    pub name: String,
    pub sheet: String,
    pub hp: f64,
    pub shield: f64,
    pub damage: f64,
    pub speed: f64,
    pub aggressive: bool,
    pub exp: f64,
    pub honor: f64,
    pub credits: f64,
    pub uridium: f64,
    /// Per-shot damage range (used instead of `damage` × 0.8..1.2 when both > 0).
    pub damage_min: f64,
    pub damage_max: f64,
    /// Shield absorption, as a fraction (0.8) or percent (80). 0 = default 0.8.
    pub shield_absorption: f64,
    /// Special behaviour; from npcs.json (`behavior` object or string flag) and/or
    /// data/npc_behaviors.json (merged on top, keyed by npc id).
    #[serde(deserialize_with = "lenient_behavior")]
    pub behavior: Behavior,
}

impl NpcDef {
    pub fn absorb(&self) -> f64 {
        let a = self.shield_absorption;
        if a <= 0.0 {
            0.8
        } else if a > 1.0 {
            (a / 100.0).min(1.0)
        } else {
            a
        }
    }
}

/// Accept a behaviour object, a flag string ("stationary"), or anything else (ignored).
fn lenient_behavior<'de, D: Deserializer<'de>>(d: D) -> Result<Behavior, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Object(_) => serde_json::from_value(v).unwrap_or_default(),
        Value::String(s) => Behavior::from_flags(&s),
        _ => Behavior::default(),
    })
}

/// Data-driven NPC behaviour (see fixtures/npc_behaviors.json for documented examples).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Behavior {
    /// Never moves.
    pub stationary: bool,
    /// Never shoots.
    #[serde(rename = "noAttack")]
    pub no_attack: bool,
    /// Releases minions (e.g. Cubikon -> Protegits).
    pub spawns: Option<SpawnRule>,
    /// Spawns together with a group of escorts that follow and defend it.
    pub escorts: Option<EscortRule>,
    /// Takes no damage while any of its minions/escorts are alive (insta-shield).
    #[serde(rename = "invulnerableWithMinions")]
    pub invulnerable_with_minions: bool,
    pub regen: Option<RegenRule>,
    /// When attacked, NPCs of the same type within this radius join the fight.
    pub assist: f64,
    /// Its hits slow the target (Saboteur slowdown).
    #[serde(rename = "slowOnHit")]
    pub slow_on_hit: Option<SlowRule>,
    /// Self-destructs near the target at low HP (Barracuda).
    pub kamikaze: Option<KamikazeRule>,
}

impl Behavior {
    fn from_flags(s: &str) -> Behavior {
        let mut b = Behavior::default();
        for f in s.split([',', ' ', '|']).map(str::trim) {
            match f {
                "stationary" => b.stationary = true,
                "noAttack" | "passive_noattack" => b.no_attack = true,
                _ => {}
            }
        }
        b
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct SpawnRule {
    pub npc: String,
    /// "attacked" (only while being attacked) or "always".
    pub trigger: String,
    /// Time in combat before the first release.
    #[serde(rename = "delayMs")]
    pub delay_ms: f64,
    /// Time between releases.
    #[serde(rename = "everyMs")]
    pub every_ms: f64,
    /// Minions per release (topped up to `max`).
    pub count: u32,
    /// Max minions alive at once.
    pub max: u32,
    /// Distance at which minions circle the mother.
    pub radius: f64,
    /// Minions disappear after this long without combat (when the mother is idle or dead).
    #[serde(rename = "despawnIdleMs")]
    pub despawn_idle_ms: f64,
}

impl Default for SpawnRule {
    fn default() -> Self {
        SpawnRule {
            npc: String::new(),
            trigger: "attacked".into(),
            delay_ms: 2000.0,
            every_ms: 5000.0,
            count: 20,
            max: 20,
            radius: 550.0,
            despawn_idle_ms: 30000.0,
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct EscortRule {
    pub npc: String,
    pub count: u32,
    /// Formation radius around the leader.
    pub radius: f64,
    /// Orphaned escorts (leader dead) disappear after this long without combat.
    #[serde(rename = "despawnIdleMs")]
    pub despawn_idle_ms: f64,
}

impl Default for EscortRule {
    fn default() -> Self {
        EscortRule { npc: String::new(), count: 3, radius: 350.0, despawn_idle_ms: 30000.0 }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RegenRule {
    #[serde(rename = "hpPerSec")]
    pub hp_per_sec: f64,
    #[serde(rename = "shieldPerSec")]
    pub shield_per_sec: f64,
    /// Only after this long without taking damage (0 = always).
    #[serde(rename = "afterMs")]
    pub after_ms: f64,
    /// Only while it has minions alive (Battleray repair).
    #[serde(rename = "whileMinions")]
    pub while_minions: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SlowRule {
    /// Speed cap applied to the target.
    pub speed: f64,
    pub ms: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct KamikazeRule {
    /// HP fraction that arms the self-destruct.
    #[serde(rename = "atHp")]
    pub at_hp: f64,
    /// Stand-still time before detonation.
    #[serde(rename = "delayMs")]
    pub delay_ms: f64,
    pub radius: f64,
    pub damage: f64,
}

impl Default for KamikazeRule {
    fn default() -> Self {
        KamikazeRule { at_hp: 0.2, delay_ms: 5000.0, radius: 500.0, damage: 20000.0 }
    }
}

impl Default for NpcDef {
    fn default() -> Self {
        NpcDef {
            id: String::new(),
            name: String::new(),
            sheet: String::new(),
            hp: 1000.0,
            shield: 0.0,
            damage: 20.0,
            speed: 250.0,
            aggressive: false,
            exp: 0.0,
            honor: 0.0,
            credits: 0.0,
            uridium: 0.0,
            damage_min: 0.0,
            damage_max: 0.0,
            shield_absorption: 0.0,
            behavior: Behavior::default(),
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Portal {
    pub id: Value,
    pub x: f64,
    pub y: f64,
    #[serde(deserialize_with = "lenient_u32")]
    pub to: u32,
    pub tx: f64,
    pub ty: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Station {
    pub faction: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct MapNpc {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(deserialize_with = "lenient_u32")]
    pub count: u32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct MapDef {
    #[serde(deserialize_with = "lenient_u32")]
    pub id: u32,
    #[serde(deserialize_with = "lenient_string")]
    pub name: String,
    pub faction: String,
    pub w: f64,
    pub h: f64,
    pub portals: Vec<Portal>,
    pub stations: Vec<Station>,
    pub npcs: Vec<MapNpc>,
    /// The original JSON entry, forwarded verbatim in the `map` message.
    #[serde(skip)]
    pub raw: Value,
}

impl Default for MapDef {
    fn default() -> Self {
        MapDef {
            id: 0,
            name: String::new(),
            faction: String::new(),
            w: 21000.0,
            h: 13100.0,
            portals: vec![],
            stations: vec![],
            npcs: vec![],
            raw: Value::Null,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Ammo {
    pub id: String,
    pub name: String,
    pub mult: f64,
    pub color: String,
    /// Seconds between shots with this ammo (0 = normal 1 s laser cycle). RSB defaults to 3.
    pub cooldown: f64,
    /// SAB-style ammo: drains the target's shield into the attacker's.
    #[serde(rename = "shieldDrain")]
    pub shield_drain: bool,
    /// Alternative to `cooldown`, in milliseconds.
    pub cooldown_ms: f64,
    /// Optional multiplier overrides vs aliens / vs players (JOB-100: 3.5 / 2).
    #[serde(rename = "multPve")]
    pub mult_pve: Option<f64>,
    #[serde(rename = "multPvp")]
    pub mult_pvp: Option<f64>,
    /// Multiplier vs specific NPC ids (prefix match), e.g. RB-214 `{"demaner": 8}`.
    #[serde(rename = "multVs")]
    pub mult_vs: std::collections::HashMap<String, f64>,
    /// Extra shield drain (×x1 damage) on top of normal damage (CBO-100 = 1, half of SAB).
    pub drain: f64,
    /// Ramping ammo (IDB-125): ×`step` per hit up to `max`, reset after `resetMs` idle.
    pub ramp: Option<Ramp>,
    /// Infects players (PIB-100).
    pub infect: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Ramp {
    pub step: f64,
    pub max: f64,
    #[serde(rename = "resetMs")]
    pub reset_ms: f64,
}

impl Ammo {
    pub fn is_sab(&self) -> bool {
        self.shield_drain || self.id == "sab"
    }
    /// Damage multiplier against a target (`npc` = NPC id, `None` = player).
    pub fn mult_for(&self, npc: Option<&str>) -> f64 {
        match npc {
            Some(id) => self
                .mult_vs
                .iter()
                .find(|(k, _)| id.starts_with(k.as_str()))
                .map(|(_, v)| *v)
                .or(self.mult_pve)
                .unwrap_or(self.mult),
            None => self.mult_pvp.unwrap_or(self.mult),
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RocketDef {
    pub id: String,
    pub name: String,
    pub damage: f64,
    /// Max range (0 = default rocket range).
    pub range: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Lasers {
    pub ammo: Vec<Ammo>,
    #[serde(rename = "laserDamage")]
    pub laser_damage: f64,
    pub rockets: Vec<RocketDef>,
}

impl Default for Lasers {
    fn default() -> Self {
        let a = |id: &str, name: &str, mult: f64, color: &str| Ammo {
            id: id.into(),
            name: name.into(),
            mult,
            color: color.into(),
            cooldown: if id == "rsb" { 3.0 } else { 0.0 },
            shield_drain: id == "sab",
            cooldown_ms: 0.0,
            ..Default::default()
        };
        let r = |id: &str, damage: f64| RocketDef { id: id.into(), name: id.to_uppercase(), damage, range: 0.0 };
        Lasers {
            ammo: vec![
                a("x1", "LCB-10", 1.0, "red"),
                a("x2", "MCB-25", 2.0, "blue"),
                a("x3", "MCB-50", 3.0, "green"),
                a("x4", "UCB-100", 4.0, "white"),
                a("sab", "SAB-50", 2.0, "sab"),
                a("rsb", "RSB-75", 6.0, "rsb"),
            ],
            laser_damage: 175.0,
            rockets: vec![r("r310", 1000.0), r("plt2026", 2000.0), r("plt2021", 4000.0)],
        }
    }
}

// ---------------------------------------------------------------- equipment items

fn d_upg() -> f64 {
    0.00375 // +6% at level 16 (board-en 2014 / wiki "Maximum LF-4 Damage": LF-4 200 -> 212)
}
fn d_max_lvl() -> u8 {
    16
}

#[derive(Deserialize, Clone, Debug)]
pub struct LaserItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub damage: f64,
    /// Extra damage on overdrive rounds (every `damageModel.overdriveMs`), Prometheus 200.
    #[serde(default)]
    pub overdrive: f64,
    /// Fractional damage bonus per upgrade level.
    #[serde(default = "d_upg", rename = "upgradePerLevel")]
    pub upgrade_per_level: f64,
    #[serde(default = "d_max_lvl", rename = "maxLevel")]
    pub max_level: u8,
    /// Fractional bonus vs aliens / players (LF-3 +15% PvE).
    #[serde(default)]
    pub pve: f64,
    #[serde(default)]
    pub pvp: f64,
    /// Flat damage per laser added after the ammo multiplier (LF-4-PD/MD +5).
    #[serde(default, rename = "flatPve")]
    pub flat_pve: f64,
    #[serde(default, rename = "flatPvp")]
    pub flat_pvp: f64,
    /// Max HP bonus per equipped laser (LF-4-HP +0.5%).
    #[serde(default, rename = "hpPerLaser")]
    pub hp_per_laser: f64,
    /// Only for the P.E.T. (LF-P01) / only on the ship (LF-5-AL).
    #[serde(default, rename = "petOnly")]
    pub pet_only: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ShieldGen {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub shield: f64,
    #[serde(default, alias = "absorption")]
    pub absorb: f64,
    #[serde(default = "d_upg", rename = "upgradePerLevel")]
    pub upgrade_per_level: f64,
    #[serde(default = "d_max_lvl", rename = "maxLevel")]
    pub max_level: u8,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SpeedGen {
    pub id: String,
    pub name: String,
    pub speed: f64,
    /// Speed gens are not part of item upgrading (archive wiki "Item upgrading"): 0.
    #[serde(rename = "upgradePerLevel")]
    pub upgrade_per_level: f64,
    #[serde(rename = "maxLevel")]
    pub max_level: u8,
}

/// Drone formation (wiki "Drone formation" table). All values are fractions.
#[derive(Deserialize, Clone, Debug, Default, serde::Serialize)]
#[serde(default)]
pub struct Formation {
    pub id: String,
    pub name: String,
    pub laser: f64,
    pub rocket: f64,
    pub pve: f64,
    pub pvp: f64,
    pub shield: f64,
    pub hp: f64,
    pub speed: f64,
    pub absorb: f64,
    pub penetration: f64,
    /// Shield regen / drain, fraction of max shield per second.
    #[serde(rename = "shieldRegen")]
    pub shield_regen: f64,
    #[serde(rename = "shieldDrain")]
    pub shield_drain: f64,
    #[serde(rename = "rocketCooldown")]
    pub rocket_cooldown: f64,
    pub desc: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Booster {
    pub id: String,
    pub name: String,
    pub damage: f64,
    pub shield: f64,
    pub hp: f64,
    pub repair: f64,
}

/// Skill tree (pilot sheet), maxed. Fractions unless noted.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Skills {
    #[serde(rename = "alienHunter")]
    pub alien_hunter: f64,
    #[serde(rename = "bountyHunter")]
    pub bounty_hunter: f64,
    #[serde(rename = "rocketFusion")]
    pub rocket_fusion: f64,
    #[serde(rename = "shieldEngineering")]
    pub shield_engineering: f64,
    #[serde(rename = "shipHull")]
    pub ship_hull: f64,
    pub engineering: f64,
    #[serde(rename = "electroOptics")]
    pub electro_optics: f64,
}

/// Refining with prime ores (wiki "Refining Upgrade"): Seprom +60% lasers/rockets, +40% shields,
/// Promerium +20% speed.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Refining {
    pub laser: f64,
    pub rocket: f64,
    pub shield: f64,
    pub speed: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ShipBonus {
    pub damage: f64,
    pub pve: f64,
    pub pvp: f64,
    pub shield: f64,
    pub hp: f64,
    pub speed: f64,
    pub penetration: f64,
    /// Ship upgrade module bonus that is fitted by default (e.g. DMG-SG01 +5% on Goliath).
    #[serde(rename = "moduleDamage")]
    pub module_damage: f64,
    pub module: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct PetDef {
    pub lasers: u32,
    pub laser: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct DamageModel {
    /// Rolls land in [1 - variance, 1] × max (wiki "Laser Damage Charts": 75-100%).
    pub variance: f64,
    #[serde(rename = "overdriveMs")]
    pub overdrive_ms: f64,
    /// Drone XP level 6 bonus (wiki "Drone": 10% lasers / 20% generators).
    #[serde(rename = "droneLevelLaser")]
    pub drone_level_laser: f64,
    #[serde(rename = "droneLevelGen")]
    pub drone_level_gen: f64,
    /// Drone item-upgrade bonus per level (lvl 16 = +6%).
    #[serde(rename = "droneUpgradePerLevel")]
    pub drone_upgrade_per_level: f64,
    /// Max total booster bonus per stat (wiki "Booster": 50%).
    #[serde(rename = "boosterCap")]
    pub booster_cap: f64,
}

impl Default for DamageModel {
    fn default() -> Self {
        DamageModel {
            variance: 0.25,
            overdrive_ms: 5000.0,
            drone_level_laser: 0.10,
            drone_level_gen: 0.20,
            drone_upgrade_per_level: 0.00375,
            booster_cap: 0.5,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ExtraItem {
    pub id: String,
    pub name: String,
    /// Hull repair in HP/s while out of combat.
    pub repair: f64,
    /// Multiplier on laser miss chance (lowest equipped wins).
    #[serde(rename = "missMult")]
    pub miss_mult: Option<f64>,
    /// Fire rockets automatically while attacking.
    #[serde(rename = "autoRocket")]
    pub auto_rocket: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct DroneType {
    pub id: String,
    pub name: String,
    pub slots: u32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct DroneDesign {
    pub id: String,
    pub name: String,
    /// Fractional bonuses (0.1 = +10%), active with at least `minDrones` drones.
    pub damage: f64,
    pub shield: f64,
    pub hp: f64,
    #[serde(rename = "minDrones")]
    pub min_drones: u32,
}

impl Default for DroneDesign {
    fn default() -> Self {
        DroneDesign { id: String::new(), name: String::new(), damage: 0.0, shield: 0.0, hp: 0.0, min_drones: 10 }
    }
}

/// Field-level defaults only (the container `Default` parses the built-in file).
#[derive(Deserialize, Clone, Debug)]
pub struct Items {
    #[serde(default)]
    pub lasers: Vec<LaserItem>,
    #[serde(default, rename = "shieldGens")]
    pub shield_gens: Vec<ShieldGen>,
    #[serde(default, rename = "speedGens")]
    pub speed_gens: Vec<SpeedGen>,
    #[serde(default)]
    pub extras: Vec<ExtraItem>,
    #[serde(default)]
    pub drones: Vec<DroneType>,
    #[serde(default, rename = "droneDesigns")]
    pub drone_designs: Vec<DroneDesign>,
    #[serde(default, rename = "maxDrones")]
    pub max_drones: u32,
    #[serde(default)]
    pub formations: Vec<Formation>,
    #[serde(default)]
    pub boosters: Vec<Booster>,
    #[serde(default)]
    pub skills: Skills,
    #[serde(default)]
    pub refining: Refining,
    #[serde(default, rename = "shipBonuses")]
    pub ship_bonuses: std::collections::HashMap<String, ShipBonus>,
    #[serde(default)]
    pub pet: PetDef,
    #[serde(default, rename = "damageModel")]
    pub damage_model: DamageModel,
}

/// Built-in copy of fixtures/items.json, used when data/items.json is missing.
const BUILTIN_ITEMS: &str = include_str!("../fixtures/items.json");

impl Default for Items {
    fn default() -> Self {
        let mut i: Items = serde_json::from_str(BUILTIN_ITEMS).expect("fixtures/items.json is valid");
        i.normalize();
        i
    }
}

impl Items {
    fn normalize(&mut self) {
        if self.max_drones == 0 {
            self.max_drones = 10;
        }
    }
    pub fn laser(&self, id: &str) -> Option<&LaserItem> {
        self.lasers.iter().find(|x| x.id == id)
    }
    pub fn shield_gen(&self, id: &str) -> Option<&ShieldGen> {
        self.shield_gens.iter().find(|x| x.id == id)
    }
    pub fn speed_gen(&self, id: &str) -> Option<&SpeedGen> {
        self.speed_gens.iter().find(|x| x.id == id)
    }
    pub fn extra(&self, id: &str) -> Option<&ExtraItem> {
        self.extras.iter().find(|x| x.id == id)
    }
    pub fn drone(&self, id: &str) -> Option<&DroneType> {
        self.drones.iter().find(|x| x.id == id)
    }
    pub fn drone_design(&self, id: &str) -> Option<&DroneDesign> {
        self.drone_designs.iter().find(|x| x.id == id)
    }
    pub fn formation(&self, id: &str) -> Option<&Formation> {
        self.formations.iter().find(|x| x.id == id)
    }
    pub fn booster(&self, id: &str) -> Option<&Booster> {
        self.boosters.iter().find(|x| x.id == id)
    }
    /// Max upgrade level of any upgradable item id (0 if not upgradable / unknown).
    pub fn max_level(&self, id: &str) -> u8 {
        if let Some(l) = self.laser(id) {
            l.max_level
        } else if let Some(g) = self.shield_gen(id) {
            g.max_level
        } else if let Some(g) = self.speed_gen(id) {
            g.max_level
        } else {
            0
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Data {
    pub ships: Vec<Ship>,
    pub npcs: Vec<NpcDef>,
    pub maps: Vec<MapDef>,
    pub lasers: Lasers,
    pub items: Items,
    /// Daily season catalogue (data/shop.json); disabled when missing.
    pub shop: crate::season::Shop,
}

impl Data {
    pub fn ship(&self, id: &str) -> Option<&Ship> {
        self.ships.iter().find(|s| s.id == id)
    }
    pub fn npc_index(&self, id: &str) -> Option<usize> {
        self.npcs.iter().position(|n| n.id == id)
    }
    pub fn map(&self, id: u32) -> Option<&MapDef> {
        self.maps.iter().find(|m| m.id == id)
    }
    pub fn ammo(&self, id: &str) -> Option<&Ammo> {
        self.lasers.ammo.iter().find(|a| a.id == id)
    }
    pub fn rocket(&self, id: &str) -> Option<&RocketDef> {
        self.lasers.rockets.iter().find(|r| r.id == id)
    }

    /// Load from `data_dir`, falling back per file to `fixtures_dir` (with a warning).
    pub fn load(data_dir: &Path, fixtures_dir: &Path) -> Data {
        let ships: Vec<Ship> = load_list(&pick(data_dir, fixtures_dir, "ships.json"));
        let mut npcs: Vec<NpcDef> = load_list(&pick(data_dir, fixtures_dir, "npcs.json"));
        apply_behaviors(&mut npcs, &pick(data_dir, fixtures_dir, "npc_behaviors.json"));
        let maps = load_maps(&pick(data_dir, fixtures_dir, "maps.json"));
        let lasers = load_lasers(&pick(data_dir, fixtures_dir, "lasers.json"));
        let items = load_items(&pick(data_dir, fixtures_dir, "items.json"));
        let mut d = Data::from_parts(ships, npcs, maps, lasers);
        d.items = items;
        d.shop = load_shop(&data_dir.join("shop.json"));
        d
    }

    pub fn from_parts(ships: Vec<Ship>, npcs: Vec<NpcDef>, maps: Vec<MapDef>, mut lasers: Lasers) -> Data {
        if lasers.ammo.is_empty() {
            lasers.ammo = Lasers::default().ammo;
        }
        if lasers.rockets.is_empty() {
            lasers.rockets = Lasers::default().rockets;
        }
        if lasers.laser_damage <= 0.0 {
            lasers.laser_damage = 175.0;
        }
        for a in &mut lasers.ammo {
            if a.mult <= 0.0 {
                a.mult = 1.0;
            }
            if a.cooldown <= 0.0 && a.cooldown_ms > 0.0 {
                a.cooldown = a.cooldown_ms / 1000.0;
            }
            if a.cooldown <= 0.0 && a.id == "rsb" {
                a.cooldown = 3.0;
            }
        }
        let mut ships: Vec<Ship> = ships.into_iter().filter(|s| !s.id.is_empty()).collect();
        if ships.is_empty() {
            warn!("no ships loaded; using a built-in Goliath");
            ships.push(Ship {
                id: "ship_goliath".into(),
                name: "Goliath".into(),
                hp: 256000.0,
                speed: 300.0,
                lasers: 15.0,
                generators: 15.0,
                sheet: "ship_goliath".into(),
                ..Default::default()
            });
        }
        let mut maps = maps;
        if maps.is_empty() {
            warn!("no maps loaded; using a built-in empty map 1-1");
            let mut m = MapDef { id: 1, name: "1-1".into(), faction: "mmo".into(), ..Default::default() };
            m.raw = serde_json::json!({"id":1,"name":"1-1","faction":"mmo","w":m.w,"h":m.h});
            maps.push(m);
        }
        for m in &mut maps {
            if m.w <= 0.0 {
                m.w = 21000.0;
            }
            if m.h <= 0.0 {
                m.h = 13100.0;
            }
        }
        info!(
            "data: {} ships, {} npcs, {} maps, {} ammo types, {} rockets",
            ships.len(),
            npcs.len(),
            maps.len(),
            lasers.ammo.len(),
            lasers.rockets.len()
        );
        Data { ships, npcs, maps, lasers, items: Items::default(), shop: Default::default() }
    }
}

fn pick(data_dir: &Path, fixtures_dir: &Path, file: &str) -> PathBuf {
    let p = data_dir.join(file);
    if p.exists() {
        p
    } else {
        warn!("{} missing, falling back to fixtures/{}", p.display(), file);
        fixtures_dir.join(file)
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            warn!("cannot read {}: {}", path.display(), e);
            return None;
        }
    };
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("invalid JSON in {}: {}", path.display(), e);
            None
        }
    }
}

/// Extract an array from either a bare array or an object wrapping one (e.g. `{"ships":[...]}`).
fn as_array(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        Value::Object(o) => o.into_iter().find_map(|(_, v)| match v {
            Value::Array(a) => Some(a),
            _ => None,
        })
        .unwrap_or_default(),
        _ => vec![],
    }
}

fn load_list<T: DeserializeOwned>(path: &Path) -> Vec<T> {
    let Some(v) = read_json(path) else { return vec![] };
    as_array(v)
        .into_iter()
        .filter_map(|e| match serde_json::from_value::<T>(e) {
            Ok(x) => Some(x),
            Err(err) => {
                warn!("{}: skipping entry: {}", path.display(), err);
                None
            }
        })
        .collect()
}

fn load_maps(path: &Path) -> Vec<MapDef> {
    let Some(v) = read_json(path) else { return vec![] };
    as_array(v)
        .into_iter()
        .filter_map(|e| match serde_json::from_value::<MapDef>(e.clone()) {
            Ok(mut m) => {
                m.raw = e;
                Some(m)
            }
            Err(err) => {
                warn!("{}: skipping map: {}", path.display(), err);
                None
            }
        })
        .collect()
}

fn load_lasers(path: &Path) -> Lasers {
    read_json(path)
        .and_then(|v| match serde_json::from_value::<Lasers>(v) {
            Ok(l) => Some(l),
            Err(e) => {
                warn!("{}: {}", path.display(), e);
                None
            }
        })
        .unwrap_or_default()
}

fn load_shop(path: &Path) -> crate::season::Shop {
    if !path.exists() {
        info!("no {}: daily season disabled (sandbox mode)", path.display());
        return Default::default();
    }
    read_json(path)
        .and_then(|v| match serde_json::from_value::<crate::season::Shop>(v) {
            Ok(s) => Some(s),
            Err(e) => {
                warn!("{}: {} (daily season disabled)", path.display(), e);
                None
            }
        })
        .unwrap_or_default()
}

fn load_items(path: &Path) -> Items {
    let loaded = read_json(path).and_then(|v| match serde_json::from_value::<Items>(v) {
        Ok(i) => Some(i),
        Err(e) => {
            warn!("{}: {}", path.display(), e);
            None
        }
    });
    let builtin = Items::default();
    let Some(f) = loaded else { return builtin };
    // categories missing from the file fall back to the built-in set
    fn or<T>(a: Vec<T>, b: Vec<T>) -> Vec<T> {
        if a.is_empty() {
            b
        } else {
            a
        }
    }
    let mut items = Items {
        lasers: or(f.lasers, builtin.lasers),
        shield_gens: or(f.shield_gens, builtin.shield_gens),
        speed_gens: or(f.speed_gens, builtin.speed_gens),
        extras: or(f.extras, builtin.extras),
        drones: or(f.drones, builtin.drones),
        drone_designs: or(f.drone_designs, builtin.drone_designs),
        max_drones: f.max_drones,
        formations: or(f.formations, builtin.formations),
        boosters: or(f.boosters, builtin.boosters),
        skills: f.skills,
        refining: f.refining,
        ship_bonuses: if f.ship_bonuses.is_empty() { builtin.ship_bonuses } else { f.ship_bonuses },
        pet: f.pet,
        damage_model: f.damage_model,
    };
    items.normalize();
    info!(
        "items: {} lasers, {} shield gens, {} speed gens, {} extras, {} drones, {} drone designs",
        items.lasers.len(),
        items.shield_gens.len(),
        items.speed_gens.len(),
        items.extras.len(),
        items.drones.len(),
        items.drone_designs.len()
    );
    items
}

/// Merge `npc_behaviors.json` (`{ "<npc id>": { behaviour }, ... }`) onto the NPC list.
/// Keys starting with `_` are comments.
fn apply_behaviors(npcs: &mut [NpcDef], path: &Path) {
    let Some(Value::Object(map)) = read_json(path) else { return };
    let mut n = 0;
    for (id, v) in map {
        if id.starts_with('_') {
            continue;
        }
        let Some(npc) = npcs.iter_mut().find(|x| x.id == id) else {
            warn!("{}: unknown npc '{}'", path.display(), id);
            continue;
        };
        match serde_json::from_value::<Behavior>(v) {
            Ok(b) => {
                npc.behavior = b;
                n += 1;
            }
            Err(e) => warn!("{}: {}: {}", path.display(), id, e),
        }
    }
    info!("npc behaviours: {} special NPCs", n);
}
