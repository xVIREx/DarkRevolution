//! Season mode (Starblast/diep-style rounds): everyone starts in a Phoenix with an LF-1, earns
//! credits/uridium from kills and boxes and buys ships, equipment, ammo, upgrades and account
//! bonuses from the shop (data/shop.json) or with the one-key "next upgrade". Rounds last
//! `roundMinutes` (aligned to UTC); progress is kept per browser token until the round ends.
//!
//! This module is the pure economy (catalogue, inventory, pricing, auto-equip); the world
//! glue (messages, rewards, PvP rules, the daily reset) lives in world/season.rs.

use crate::data::Items;
use crate::equipment::{self, DroneCfg, EquipConfig, Loadout};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const DAY_SECS: u64 = 86_400;
/// One recommended purchase (`you.season.next`, bought with `buy` kind "next").
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NextBuy {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub c: f64,
    pub u: f64,
    /// Affordable right now.
    pub ok: bool,
}
/// Unlock ids for the account-wide bonuses (`tech` in shop.json).
pub const TECH_PET: &str = "tech:pet";
pub const TECH_REFINING: &str = "tech:refining";
pub const TECH_SKILLS: &str = "tech:skills";

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Price {
    pub c: f64,
    pub u: f64,
    /// Rounds per pack (ammo / rockets).
    pub pack: u64,
}

impl Price {
    pub fn times(&self, n: u32) -> (f64, f64) {
        (self.c * n as f64, self.u * n as f64)
    }
    pub fn text(&self, n: u32) -> String {
        let (c, u) = self.times(n);
        match (c > 0.0, u > 0.0) {
            (true, true) => format!("{} credits + {} uridium", big(c), big(u)),
            (false, true) => format!("{} uridium", big(u)),
            _ => format!("{} credits", big(c)),
        }
    }
}

pub fn big(v: f64) -> String {
    let s = format!("{}", v.round() as i64);
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 && ch != '-' {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct StartKit {
    pub ship: String,
    pub credits: f64,
    pub uridium: f64,
    pub items: BTreeMap<String, u32>,
    pub ammo: BTreeMap<String, u64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct RewardMult {
    pub credits: f64,
    pub uridium: f64,
    pub exp: f64,
    pub honor: f64,
}

impl Default for RewardMult {
    fn default() -> Self {
        RewardMult { credits: 1.0, uridium: 1.0, exp: 1.0, honor: 1.0 }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SafeRadius {
    pub portal: f64,
    pub station: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct PvpRule {
    /// Rewards per victim level.
    pub exp: f64,
    pub honor: f64,
    pub uridium: f64,
    /// Seconds before killing the same pilot pays again.
    pub cooldown: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct UpgradeRule {
    #[serde(rename = "perLevel")]
    pub per_level: f64,
    #[serde(rename = "uriValue")]
    pub uri_value: f64,
}

impl Default for UpgradeRule {
    fn default() -> Self {
        UpgradeRule { per_level: 0.02, uri_value: 400.0 }
    }
}

/// Random DO bonus boxes on maps: value × map tier (x-1 = 1 ... 5-x = 7).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct BonusBoxRule {
    #[serde(rename = "perMap")]
    pub per_map: u32,
    pub credits: f64,
    pub uridium: f64,
    /// MCB-25 rounds in an ammo box.
    pub ammo: u64,
    /// Seconds until a collected box reappears elsewhere.
    pub respawn: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Shop {
    pub enabled: bool,
    /// Round length in minutes (rounds start at multiples of it since the epoch, UTC). 1440 = daily.
    #[serde(rename = "roundMinutes")]
    pub round_minutes: f64,
    /// Fraction of unspent credits/uridium dropped in a cargo box on death.
    #[serde(rename = "deathDrop")]
    pub death_drop: f64,
    /// Seconds a dropped cargo box stays.
    #[serde(rename = "cargoLife")]
    pub cargo_life: f64,
    #[serde(rename = "bonusBoxes")]
    pub bonus_boxes: BonusBoxRule,
    /// Company objective: control beacons on the neutral maps.
    pub objectives: ObjectiveRule,
    pub start: StartKit,
    #[serde(rename = "rewardMult")]
    pub reward_mult: RewardMult,
    #[serde(rename = "underdogBonus")]
    pub underdog_bonus: f64,
    #[serde(rename = "protectedMaps")]
    pub protected_maps: Vec<String>,
    #[serde(rename = "safeRadius")]
    pub safe_radius: SafeRadius,
    pub pvp: PvpRule,
    pub upgrade: UpgradeRule,
    pub ships: BTreeMap<String, Price>,
    pub items: BTreeMap<String, Price>,
    pub designs: BTreeMap<String, Price>,
    pub ammo: BTreeMap<String, Price>,
    pub rockets: BTreeMap<String, Price>,
    pub formations: BTreeMap<String, Price>,
    pub boosters: BTreeMap<String, Price>,
    pub tech: BTreeMap<String, Price>,
}

impl Shop {
    pub fn round_secs(&self) -> u64 {
        if self.round_minutes >= 1.0 {
            (self.round_minutes * 60.0) as u64
        } else {
            DAY_SECS
        }
    }

    /// Credits needed to raise item type `id` from `lvl` to `lvl + 1`.
    pub fn upgrade_cost(&self, id: &str, lvl: u8) -> Option<f64> {
        let p = self.items.get(id)?;
        let value = p.c + p.u * self.upgrade.uri_value;
        Some((value * self.upgrade.per_level * (lvl as f64 + 1.0)).max(100.0).round())
    }
}

/// Per-pilot counters shown in the stats window and the leaderboard.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct PilotStats {
    #[serde(rename = "npcKills")]
    pub npc_kills: u32,
    #[serde(rename = "pvpKills")]
    pub pvp_kills: u32,
    pub deaths: u32,
    #[serde(rename = "earnedC")]
    pub earned_c: f64,
    #[serde(rename = "earnedU")]
    pub earned_u: f64,
    /// Biggest alien destroyed today (by EP).
    #[serde(rename = "bestKill")]
    pub best_kill: String,
    #[serde(rename = "bestKillEp")]
    pub best_kill_ep: f64,
    /// Seconds online today.
    pub online: f64,
}

/// A season pilot's wallet and inventory (the economy part of a player).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Eco {
    pub token: String,
    pub credits: f64,
    pub uridium: f64,
    pub ships: BTreeSet<String>,
    /// Owned item counts (lasers, generators, extras, drones).
    pub items: BTreeMap<String, u32>,
    /// Upgrade level per item type (applies to every unit of that type).
    pub levels: BTreeMap<String, u8>,
    /// `design:x`, `formation:x`, `booster:x`, `tech:x`.
    pub unlocks: BTreeSet<String>,
    /// Laser ammo and rocket stock (x1 and R-310 are unlimited and not listed).
    pub ammo: BTreeMap<String, u64>,
    pub stats: PilotStats,
    /// Victim token -> season time of the last paid PvP kill.
    #[serde(skip)]
    pub pvp_paid: HashMap<String, f64>,
    /// Leaderboard rank (1-based, 0 = unranked); refreshed with the leaderboard.
    #[serde(skip)]
    pub rank: u32,
    /// World time when the Jump CPU is ready again.
    #[serde(skip)]
    pub warp_ready: f64,
    /// Maps reached this round; the Jump CPU only goes to these (keeps the tier progression).
    pub visited: BTreeSet<u32>,
    /// Beacon map -> world time of the last paid capture (rewards have a cooldown per beacon).
    #[serde(skip)]
    pub capture_paid: HashMap<u32, f64>,
}

impl Eco {
    pub fn new(shop: &Shop, token: &str) -> Eco {
        let mut e = Eco {
            token: token.to_string(),
            credits: shop.start.credits,
            uridium: shop.start.uridium,
            items: shop.start.items.clone(),
            ammo: shop.start.ammo.clone(),
            ..Default::default()
        };
        e.ships.insert(shop.start.ship.clone());
        e
    }

    pub fn owns(&self, id: &str) -> u32 {
        self.items.get(id).copied().unwrap_or(0)
    }

    pub fn level(&self, id: &str) -> u8 {
        self.levels.get(id).copied().unwrap_or(0)
    }

    pub fn unlocked(&self, kind: &str, id: &str) -> bool {
        self.unlocks.contains(&format!("{}:{}", kind, id))
    }

    pub fn can_pay(&self, c: f64, u: f64) -> bool {
        self.credits + 1e-6 >= c && self.uridium + 1e-6 >= u
    }

    pub fn pay(&mut self, c: f64, u: f64) {
        self.credits = (self.credits - c).max(0.0);
        self.uridium = (self.uridium - u).max(0.0);
    }

    /// Rounds left of a laser ammo / rocket; `None` = unlimited.
    pub fn stock(&self, id: &str) -> Option<u64> {
        if id == "x1" || id == "r310" {
            None
        } else {
            Some(self.ammo.get(id).copied().unwrap_or(0))
        }
    }

    /// Use one round; false if none are left.
    pub fn consume(&mut self, id: &str) -> bool {
        match self.stock(id) {
            None => true,
            Some(0) => false,
            Some(_) => {
                *self.ammo.entry(id.to_string()).or_default() -= 1;
                true
            }
        }
    }

    /// Season loadout flags from the unlocks (formation/boosters are kept as chosen).
    pub fn apply_unlocks(&self, lo: &mut Loadout) {
        lo.pet = self.unlocks.contains(TECH_PET);
        lo.refining = self.unlocks.contains(TECH_REFINING);
        lo.skills = self.unlocks.contains(TECH_SKILLS);
        lo.boosters.retain(|b| self.unlocked("booster", b));
        if lo.formation != "standard" && !self.unlocked("formation", &lo.formation) {
            lo.formation = "standard".into();
        }
    }

    /// Every item id used by a config, counted (drone types included).
    fn usage(cfg: &EquipConfig) -> BTreeMap<String, u32> {
        let mut n: BTreeMap<String, u32> = BTreeMap::new();
        let all = cfg.lasers.iter().chain(&cfg.gens).chain(&cfg.extras);
        for id in all.chain(cfg.drones.iter().flat_map(|d| d.items.iter())) {
            *n.entry(id.clone()).or_default() += 1;
        }
        for d in &cfg.drones {
            *n.entry(d.kind.clone()).or_default() += 1;
        }
        n
    }

    /// A config may only use items the pilot owns (both configs share the same items, as in DO).
    pub fn check_owned(&self, items: &Items, cfg: &EquipConfig) -> Result<(), String> {
        for (id, n) in Self::usage(cfg) {
            let have = self.owns(&id);
            if n > have {
                let name = item_name(items, &id);
                return Err(if have == 0 { format!("you don't own {}", name) } else { format!("you own only {} × {}", have, name) });
            }
        }
        if let Some(d) = &cfg.drone_design {
            if !self.unlocked("design", d) {
                return Err(format!("you don't own the {} design", d));
            }
        }
        if cfg.extras.iter().collect::<BTreeSet<_>>().len() < cfg.extras.len() {
            return Err("each extra can only be fitted once".into());
        }
        Ok(())
    }

    /// Force the upgrade levels of a config to the pilot's per-type levels.
    pub fn apply_levels(&self, items: &Items, cfg: &mut EquipConfig) {
        equipment::normalize(items, cfg);
        let lv = |id: &String| self.level(id).min(items.max_level(id));
        cfg.laser_lvls = cfg.lasers.iter().map(lv).collect();
        cfg.gen_lvls = cfg.gens.iter().map(lv).collect();
        for d in &mut cfg.drones {
            d.item_lvls = d.items.iter().map(lv).collect();
            d.lvl = self.level(&d.kind).min(16);
        }
    }

    /// Best gear the pilot owns for `ship`. Config 1 favours shields, config 2 speed; lasers
    /// go into the ship first, then the drones; leftover shield gens fill remaining drone slots.
    pub fn auto_configs(&self, items: &Items, slots: equipment::Slots) -> [EquipConfig; 2] {
        let lvl = |id: &str| self.level(id) as f64;
        let mut lasers: Vec<(String, f64)> = items
            .lasers
            .iter()
            .filter(|l| !l.pet_only && self.owns(&l.id) > 0)
            .map(|l| (l.id.clone(), l.damage * (1.0 + l.pve) * (1.0 + lvl(&l.id) * l.upgrade_per_level)))
            .collect();
        lasers.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut shields: Vec<(String, f64)> = items
            .shield_gens
            .iter()
            .filter(|g| self.owns(&g.id) > 0)
            .map(|g| (g.id.clone(), g.shield * g.absorb.max(0.1) * (1.0 + lvl(&g.id) * g.upgrade_per_level)))
            .collect();
        shields.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut speeds: Vec<(String, f64)> =
            items.speed_gens.iter().filter(|g| self.owns(&g.id) > 0).map(|g| (g.id.clone(), g.speed)).collect();
        speeds.sort_by(|a, b| b.1.total_cmp(&a.1));
        let expand = |list: &[(String, f64)]| -> Vec<String> {
            list.iter().flat_map(|(id, _)| std::iter::repeat_n(id.clone(), self.owns(id) as usize)).collect()
        };
        let laser_pool = expand(&lasers);
        let shield_pool = expand(&shields);
        let speed_pool = expand(&speeds);

        let mut extras: Vec<String> = vec![];
        let best_extra = |f: &dyn Fn(&crate::data::ExtraItem) -> f64| {
            items
                .extras
                .iter()
                .filter(|e| self.owns(&e.id) > 0 && f(e) > 0.0)
                .max_by(|a, b| f(a).total_cmp(&f(b)))
                .map(|e| e.id.clone())
        };
        extras.extend(best_extra(&|e| e.repair));
        extras.extend(best_extra(&|e| e.miss_mult.map_or(0.0, |m| 1.0 - m + 0.01)));
        extras.extend(best_extra(&|e| if e.auto_rocket { 1.0 } else { 0.0 }));
        extras.truncate(slots.extras as usize);

        let mut drone_types: Vec<(String, u32)> =
            items.drones.iter().filter(|d| self.owns(&d.id) > 0).map(|d| (d.id.clone(), d.slots)).collect();
        drone_types.sort_by(|a, b| b.1.cmp(&a.1));
        let drones: Vec<(String, u32)> = drone_types
            .iter()
            .flat_map(|(id, s)| std::iter::repeat_n((id.clone(), *s), self.owns(id) as usize))
            .take(slots.drones as usize)
            .collect();

        let design = |pref: &[&str]| pref.iter().find(|d| self.unlocked("design", d)).map(|d| d.to_string());
        let mk = |gens_first: &[String], gens_then: &[String], design: Option<String>| -> EquipConfig {
            let lasers: Vec<String> = laser_pool.iter().take(slots.lasers as usize).cloned().collect();
            let mut gens: Vec<String> = gens_first.iter().chain(gens_then).take(slots.gens as usize).cloned().collect();
            gens.truncate(slots.gens as usize);
            let used_shields = gens.iter().filter(|g| items.shield_gen(g).is_some()).count();
            let mut spare = laser_pool.iter().skip(lasers.len()).chain(shield_pool.iter().skip(used_shields));
            let drones: Vec<DroneCfg> = drones
                .iter()
                .map(|(kind, n)| DroneCfg {
                    kind: kind.clone(),
                    items: (0..*n).filter_map(|_| spare.next().cloned()).collect(),
                    item_lvls: vec![],
                    lvl: 0,
                })
                .collect();
            let mut c = EquipConfig { lasers, gens, extras: extras.clone(), drones, drone_design: design, ..Default::default() };
            self.apply_levels(items, &mut c);
            c
        };
        [
            mk(&shield_pool, &speed_pool, design(&["spartan", "hercules", "havoc"])),
            mk(&speed_pool, &shield_pool, design(&["spartan", "havoc", "hercules"])),
        ]
    }
}

fn item_name(items: &Items, id: &str) -> String {
    let n = items
        .laser(id)
        .map(|x| x.name.clone())
        .or_else(|| items.shield_gen(id).map(|x| x.name.clone()))
        .or_else(|| items.speed_gen(id).map(|x| x.name.clone()))
        .or_else(|| items.extra(id).map(|x| x.name.clone()))
        .or_else(|| items.drone(id).map(|x| x.name.clone()))
        .unwrap_or_default();
    if n.is_empty() {
        id.to_uppercase()
    } else {
        n
    }
}

pub fn display_name(items: &Items, id: &str) -> String {
    item_name(items, id)
}

/// Stats as sent to the client: rounded so `you` only changes when something visible does.
pub fn pilot_view(s: &PilotStats) -> PilotStats {
    PilotStats {
        earned_c: s.earned_c.floor(),
        earned_u: s.earned_u.floor(),
        online: (s.online / 60.0).floor() * 60.0,
        ..s.clone()
    }
}

// ---------------------------------------------------------------- company objective (beacons)

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct BeaconDef {
    pub map: String,
    pub x: f64,
    pub y: f64,
    /// Points multiplier (the central 4-5 beacon counts double).
    pub weight: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ObjectiveRule {
    pub radius: f64,
    #[serde(rename = "captureSecs")]
    pub capture_secs: f64,
    #[serde(rename = "pointsPerSec")]
    pub points_per_sec: f64,
    /// Paid to every pilot of the capturing company inside the radius.
    #[serde(rename = "captureExp")]
    pub capture_exp: f64,
    #[serde(rename = "captureUridium")]
    pub capture_uridium: f64,
    /// Reward bonus for the winning company's pilots during the next round.
    #[serde(rename = "winBonus")]
    pub win_bonus: f64,
    pub beacons: Vec<BeaconDef>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Beacon {
    pub map: u32,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub weight: f64,
    /// Company holding it (scores points).
    pub owner: Option<String>,
    /// Company the progress belongs to and its fill (0..1). owner == side at 1.
    pub side: Option<String>,
    pub cap: f64,
    /// More than one company inside: frozen.
    #[serde(skip)]
    pub contested: bool,
}

/// Beacons and company scores of the current round (saved with the season).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Objectives {
    pub beacons: Vec<Beacon>,
    pub score: BTreeMap<String, f64>,
    /// Winner of the previous round (gets `winBonus`).
    #[serde(rename = "lastWinner")]
    pub last_winner: Option<String>,
    #[serde(skip)]
    pub timer: f64,
}

impl Objectives {
    pub fn from_rule(rule: &ObjectiveRule, data: &crate::data::Data) -> Objectives {
        let beacons = rule
            .beacons
            .iter()
            .filter_map(|b| {
                let m = data.maps.iter().find(|m| m.name == b.map)?;
                Some(Beacon {
                    map: m.id,
                    name: m.name.clone(),
                    x: b.x.clamp(0.0, m.w),
                    y: b.y.clamp(0.0, m.h),
                    weight: if b.weight > 0.0 { b.weight } else { 1.0 },
                    ..Default::default()
                })
            })
            .collect();
        Objectives { beacons, ..Default::default() }
    }

    /// New round: neutral beacons, zero scores (the winner is decided by the caller).
    pub fn reset(&mut self) {
        for b in &mut self.beacons {
            b.owner = None;
            b.side = None;
            b.cap = 0.0;
            b.contested = false;
        }
        self.score.clear();
    }

    /// Company with the most points (None on a tie or with no points).
    pub fn leader(&self) -> Option<String> {
        let mut v: Vec<(&String, &f64)> = self.score.iter().filter(|(_, s)| **s > 0.0).collect();
        v.sort_by(|a, b| b.1.total_cmp(a.1));
        match v.as_slice() {
            [] => None,
            [(f, _)] => Some((*f).clone()),
            [(f, a), (_, b), ..] if a > b => Some((*f).clone()),
            _ => None,
        }
    }

    /// Restore owners/scores from a save, but only if the beacon layout is unchanged (same maps,
    /// positions and weights); otherwise the round's objective starts over. The last winner is kept.
    pub fn restore(&mut self, saved: &Objectives) {
        self.last_winner = saved.last_winner.clone();
        let same = saved.beacons.len() == self.beacons.len()
            && self.beacons.iter().zip(&saved.beacons).all(|(a, b)| a.map == b.map && a.x == b.x && a.y == b.y && a.weight == b.weight);
        if !same {
            return;
        }
        for (b, s) in self.beacons.iter_mut().zip(&saved.beacons) {
            b.owner = s.owner.clone();
            b.side = s.side.clone();
            b.cap = s.cap.clamp(0.0, 1.0);
        }
        self.score = saved.score.clone();
    }
}

/// Everything needed to bring a pilot back after a reconnect or a server restart.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Profile {
    pub name: String,
    pub faction: String,
    pub exp: f64,
    pub honor: f64,
    pub ship: String,
    pub design: Option<String>,
    pub configs: [EquipConfig; 2],
    pub cfg: usize,
    pub formation: String,
    pub boosters: Vec<String>,
    pub ammo: String,
    pub rocket: String,
    pub eco: Eco,
}

/// One leaderboard row (also the champions of the previous day).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct TopRow {
    pub n: String,
    pub f: String,
    pub lvl: u32,
    pub ep: f64,
    pub hon: f64,
    /// NPC kills / PvP kills.
    pub k: u32,
    pub pk: u32,
    /// Currently online.
    pub on: bool,
}

/// Saved season state (SEASON_SAVE file).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SaveFile {
    #[serde(alias = "day")]
    pub round: u64,
    pub profiles: HashMap<String, Profile>,
    pub champions: Vec<TopRow>,
    pub obj: Objectives,
}

/// Bots play the season too but never appear in rankings or saves.
pub fn is_bot_token(t: &str) -> bool {
    t.starts_with("bot:")
}

/// Index of the round containing `secs` (rounds of `period` seconds since the Unix epoch).
pub fn round_of(secs: f64, period: u64) -> u64 {
    (secs.max(0.0) as u64) / period.max(1)
}

/// Map tier for box values: x-1..x-8 -> 1..8 capped at 4 for x-1..x-4 home sectors, 4-x -> 5, 5-x -> 7.
pub fn map_tier(name: &str) -> f64 {
    let mut it = name.split('-');
    let (a, b) = (it.next().and_then(|x| x.parse::<u32>().ok()), it.next().and_then(|x| x.parse::<u32>().ok()));
    match (a, b) {
        (Some(5), _) => 7.0,
        (Some(4), _) => 5.0,
        (Some(_), Some(n)) if n >= 5 => 6.0,
        (Some(_), Some(n)) => n as f64,
        _ => 1.0,
    }
}

pub fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// A token from the client: 8..64 url-safe characters.
pub fn valid_token(t: &str) -> bool {
    (8..=64).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{Items, Ship};
    use crate::equipment::slots;

    fn shop() -> Shop {
        serde_json::from_str(include_str!("../../data/shop.json")).unwrap()
    }

    #[test]
    fn shop_json_is_consistent_with_items() {
        let s = shop();
        let items = Items::default();
        assert!(s.enabled);
        for id in s.items.keys() {
            assert!(
                items.laser(id).is_some()
                    || items.shield_gen(id).is_some()
                    || items.speed_gen(id).is_some()
                    || items.extra(id).is_some()
                    || items.drone(id).is_some(),
                "unknown shop item {}",
                id
            );
        }
        for id in s.designs.keys() {
            assert!(items.drone_design(id).is_some(), "{}", id);
        }
        for id in s.formations.keys() {
            assert!(items.formation(id).is_some(), "{}", id);
        }
        for id in s.boosters.keys() {
            assert!(items.booster(id).is_some(), "{}", id);
        }
        for p in s.ammo.values().chain(s.rockets.values()) {
            assert!(p.pack > 0);
        }
        // beacons sit on real maps, clear of portal/station safe zones
        let maps: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../data/maps.json")).unwrap();
        assert_eq!(s.objectives.beacons.len(), 5);
        for b in &s.objectives.beacons {
            let m = maps.iter().find(|m| m["name"] == b.map.as_str()).unwrap_or_else(|| panic!("no map {}", b.map));
            let pts = m["portals"].as_array().unwrap().iter().chain(m["stations"].as_array().unwrap());
            for p in pts {
                let d = ((p["x"].as_f64().unwrap() - b.x).powi(2) + (p["y"].as_f64().unwrap() - b.y).powi(2)).sqrt();
                assert!(d >= s.objectives.radius + s.safe_radius.station.max(s.safe_radius.portal), "beacon {} too close ({})", b.map, d);
            }
        }
        let ships: Vec<Ship> = serde_json::from_str(include_str!("../../data/ships.json")).unwrap();
        for id in s.ships.keys().chain(std::iter::once(&s.start.ship)) {
            assert!(ships.iter().any(|x| &x.id == id), "unknown ship {}", id);
        }
    }

    #[test]
    fn ownership_levels_and_auto_equip() {
        let s = shop();
        let items = Items::default();
        let mut e = Eco::new(&s, "tok12345");
        let g = Ship { id: "g".into(), lasers: 3.0, generators: 2.0, extras: 2.0, ..Default::default() };
        let sl = slots(&g, &items);
        e.items.insert("lf2".into(), 2);
        e.items.insert("flax".into(), 1);
        e.levels.insert("lf2".into(), 5);
        let [c1, c2] = e.auto_configs(&items, sl);
        // best lasers first (2× LF-2, then the LF-1), shield in config 1, no speed gens owned
        assert_eq!(c1.lasers, vec!["lf2", "lf2", "lf1"]);
        assert_eq!(c1.laser_lvls, vec![5, 5, 0]);
        assert_eq!(c1.gens, vec!["sg3n-a01"]);
        assert_eq!(c2.gens, vec!["sg3n-a01"]);
        // the Flax stays empty: no spare lasers, the only shield gen is in the ship
        assert_eq!(c1.drones.len(), 1);
        assert!(c1.drones[0].items.is_empty());
        assert!(e.check_owned(&items, &c1).is_ok());
        let mut bad = c1.clone();
        bad.lasers.push("lf2".into());
        assert!(e.check_owned(&items, &bad).is_err());
        bad = c1.clone();
        bad.drone_design = Some("havoc".into());
        assert!(e.check_owned(&items, &bad).is_err());
    }

    #[test]
    fn ammo_stock_and_prices() {
        let s = shop();
        let mut e = Eco::new(&s, "tok12345");
        assert_eq!(e.stock("x1"), None);
        assert_eq!(e.stock("x2"), Some(500));
        assert!(e.consume("x2"));
        assert_eq!(e.stock("x2"), Some(499));
        assert!(!e.consume("x4"));
        assert_eq!(s.upgrade_cost("lf4", 0), Some(5000.0));
        assert_eq!(s.upgrade_cost("lf4", 15), Some(80000.0));
        assert_eq!(big(1234567.0), "1,234,567");
        assert_eq!(round_of(86_399.0, DAY_SECS), 0);
        assert_eq!(round_of(86_400.0, DAY_SECS), 1);
        assert_eq!(round_of(3_599.0, 1800), 1);
        assert_eq!(map_tier("1-1"), 1.0);
        assert_eq!(map_tier("3-7"), 6.0);
        assert_eq!(map_tier("4-5"), 5.0);
        assert_eq!(map_tier("5-2"), 7.0);
        assert!(valid_token("abcDEF12_-"));
        assert!(!valid_token("short"));
    }
}
