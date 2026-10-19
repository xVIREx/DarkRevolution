//! Daily season glue: identity, shop purchases, rewards, PvP rules, leaderboard, persistence
//! and the 00:00 UTC reset. The economy itself is in crate::season.

use super::{Entity, Kind, PlayerData, World};
use crate::combat::{self, dist};
use crate::data::Data;
use crate::equipment::{self, Loadout};
use crate::protocol::{ClientMsg, FactionRow, ServerMsg, TopMsg};
use crate::season::{
    big, day_of, display_name, now_secs, valid_token, Eco, Profile, SaveFile, TopRow, DAY_SECS,
};
use rand::distributions::Alphanumeric;
use rand::Rng;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tracing::{info, warn};

const FACTIONS: [&str; 3] = ["mmo", "eic", "vru"];
const BOARD_EVERY: f64 = 5.0;
const SAVE_EVERY: f64 = 30.0;
const TOP_ROWS: usize = 10;
const SHARE_PCT: f64 = super::group::SHARE_BONUS * 100.0;

pub struct SeasonState {
    /// Current UTC day (days since the epoch).
    pub day: u64,
    /// Saved pilots of today, by token (offline ones; online ones are snapshotted on save).
    pub profiles: HashMap<String, Profile>,
    /// Top 3 of the previous day.
    pub champions: Vec<TopRow>,
    /// Reward bonus per company (underdog bonus), refreshed with the leaderboard.
    bonus: BTreeMap<String, f64>,
    save_path: Option<PathBuf>,
    save_timer: f64,
    board_timer: f64,
    dirty: bool,
    /// Added to the wall clock (tests).
    pub clock_offset: f64,
}

impl SeasonState {
    pub fn new(save_path: Option<PathBuf>) -> SeasonState {
        SeasonState {
            day: day_of(now_secs()),
            profiles: HashMap::new(),
            champions: vec![],
            bonus: BTreeMap::new(),
            save_path,
            save_timer: 0.0,
            board_timer: 0.0,
            dirty: false,
            clock_offset: 0.0,
        }
    }

    /// Season on when data/shop.json enables it and SEASON != 0. Progress is saved to
    /// SEASON_SAVE (default ./season-save.json) so restarts within the day keep it.
    pub fn from_env(data: &Data) -> Option<SeasonState> {
        if !data.shop.enabled || std::env::var("SEASON").is_ok_and(|v| v == "0") {
            return None;
        }
        let path = std::env::var("SEASON_SAVE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("season-save.json"));
        let mut s = SeasonState::new(Some(path));
        s.load();
        info!("daily season on: day {}, {} saved pilots, save file {:?}", s.day, s.profiles.len(), s.save_path);
        Some(s)
    }

    fn now(&self) -> f64 {
        now_secs() + self.clock_offset
    }

    pub fn reset_at_ms(&self) -> u64 {
        (self.day + 1) * DAY_SECS * 1000
    }

    fn load(&mut self) {
        let Some(path) = &self.save_path else { return };
        let Ok(text) = std::fs::read_to_string(path) else { return };
        match serde_json::from_str::<SaveFile>(&text) {
            Ok(f) if f.day == self.day => {
                self.profiles = f.profiles;
                self.champions = f.champions;
            }
            Ok(f) if f.day + 1 == self.day => {
                // the server was down over midnight: yesterday's save decides the champions
                let mut rows: Vec<TopRow> = f.profiles.values().map(|p| row_of(p, false)).collect();
                sort_rows(&mut rows);
                self.champions = rows.into_iter().filter(|r| r.ep > 0.0).take(3).collect();
            }
            Ok(_) => {}
            Err(e) => warn!("{}: {}", path.display(), e),
        }
    }
}

fn row_of(p: &Profile, on: bool) -> TopRow {
    TopRow {
        n: p.name.clone(),
        f: p.faction.clone(),
        lvl: combat::level_for_exp(p.exp),
        ep: p.exp.floor(),
        hon: p.honor.floor(),
        k: p.eco.stats.npc_kills,
        pk: p.eco.stats.pvp_kills,
        on,
    }
}

fn sort_rows(rows: &mut [TopRow]) {
    rows.sort_by(|a, b| b.ep.total_cmp(&a.ep).then_with(|| a.n.cmp(&b.n)));
}

fn profile_of(e: &Entity) -> Option<(String, Profile)> {
    let p = e.player()?;
    let eco = p.eco.as_ref()?;
    Some((
        eco.token.clone(),
        Profile {
            name: e.name.clone(),
            faction: e.faction.clone(),
            exp: p.exp,
            honor: p.honor,
            ship: p.ship.clone(),
            design: p.design.clone(),
            configs: p.configs.clone(),
            cfg: p.cfg,
            formation: p.loadout.formation.clone(),
            boosters: p.loadout.boosters.clone(),
            ammo: p.ammo.clone(),
            rocket: p.rocket.clone(),
            eco: (**eco).clone(),
        },
    ))
}

/// What a purchase changes besides the wallet.
enum Effect {
    None,
    AutoEquip,
    Ship(String),
    Loadout,
    Levels,
}

fn start_ship(data: &Data) -> String {
    let s = &data.shop.start.ship;
    if data.ship(s).is_some() {
        return s.clone();
    }
    data.ships.iter().min_by(|a, b| a.hp.total_cmp(&b.hp)).map(|s| s.id.clone()).unwrap_or_default()
}

/// Fresh season pilot state (new login or the daily reset).
fn reset_player(data: &Data, p: &mut PlayerData, token: &str) {
    let eco = Eco::new(&data.shop, token);
    p.ship = start_ship(data);
    p.design = None;
    p.exp = 0.0;
    p.honor = 0.0;
    p.loadout = Loadout::bare();
    p.ammo = data.lasers.ammo[0].id.clone();
    p.rocket = data.lasers.rockets[0].id.clone();
    p.cfg = 0;
    p.cfg_cd = 0.0;
    p.god = false;
    p.dmg_mult = 1.0;
    let ship = World::ship_of(data, p);
    p.configs = eco.auto_configs(&data.items, equipment::slots(ship, &data.items));
    p.eco = Some(Box::new(eco));
}

/// Apply one purchase to a pilot. Ok(log text, effect) or Err(reason).
fn buy(data: &Data, p: &mut PlayerData, kind: &str, id: &str, qty: u32) -> Result<(String, Effect), String> {
    let shop = &data.shop;
    let items = &data.items;
    let eco = p.eco.as_mut().ok_or("Not available")?;
    let qty = qty.clamp(1, 100);
    let not_sold = || "That is not sold in the shop".to_string();
    let charge = |eco: &mut Eco, c: f64, u: f64| -> Result<String, String> {
        if !eco.can_pay(c, u) {
            let need = match (c > eco.credits, u > eco.uridium) {
                (true, true) => format!("{} credits and {} uridium", big(c - eco.credits), big(u - eco.uridium)),
                (true, false) => format!("{} more credits", big(c - eco.credits)),
                _ => format!("{} more uridium", big(u - eco.uridium)),
            };
            return Err(format!("Not enough - you need {}", need));
        }
        eco.pay(c, u);
        Ok(match (c > 0.0, u > 0.0) {
            (true, true) => format!("{} credits + {} uridium", big(c), big(u)),
            (false, true) => format!("{} uridium", big(u)),
            _ => format!("{} credits", big(c)),
        })
    };
    let unlock = |eco: &mut Eco, key: String, price: Option<&crate::season::Price>, what: &str| -> Result<String, String> {
        let price = price.ok_or_else(not_sold)?;
        if eco.unlocks.contains(&key) {
            return Err(format!("You already own {}", what));
        }
        let paid = charge(eco, price.c, price.u)?;
        eco.unlocks.insert(key);
        Ok(format!("Bought {} for {}", what, paid))
    };
    match kind {
        "ship" => {
            let price = shop.ships.get(id).ok_or_else(not_sold)?;
            let ship = data.ship(id).ok_or_else(not_sold)?;
            if eco.ships.contains(id) {
                return Err(format!("You already own the {}", ship.name));
            }
            let paid = charge(eco, price.c, price.u)?;
            eco.ships.insert(id.to_string());
            Ok((format!("Bought the {} for {}", ship.name, paid), Effect::Ship(id.to_string())))
        }
        "item" => {
            let price = shop.items.get(id).ok_or_else(not_sold)?;
            let name = display_name(items, id);
            let have = eco.owns(id);
            let (cap, what) = if items.extra(id).is_some() {
                (1, "of each extra")
            } else if items.drone(id).is_some() {
                let drones: u32 = items.drones.iter().map(|d| eco.owns(&d.id)).sum();
                (items.max_drones.saturating_sub(drones) + have, "drones")
            } else {
                (60, "of one item")
            };
            if have + qty > cap {
                return Err(format!("You can own at most {} {}", cap.max(1), what));
            }
            let (c, u) = price.times(qty);
            let paid = charge(eco, c, u)?;
            *eco.items.entry(id.to_string()).or_default() += qty;
            Ok((format!("Bought {} × {} for {}", qty, name, paid), Effect::AutoEquip))
        }
        "design" => {
            let name = items.drone_design(id).map(|d| d.name.clone()).ok_or_else(not_sold)?;
            let msg = unlock(eco, format!("design:{}", id), shop.designs.get(id), &format!("the {} drone design", name))?;
            Ok((msg, Effect::AutoEquip))
        }
        "ammo" | "rocket" => {
            let (price, name) = if kind == "ammo" {
                (shop.ammo.get(id), data.ammo(id).map(|a| a.name.clone()))
            } else {
                (shop.rockets.get(id), data.rocket(id).map(|r| r.name.clone()))
            };
            let (price, name) = price.zip(name).ok_or_else(not_sold)?;
            let (c, u) = price.times(qty);
            let paid = charge(eco, c, u)?;
            let rounds = price.pack.max(1) * qty as u64;
            *eco.ammo.entry(id.to_string()).or_default() += rounds;
            Ok((format!("Bought {} × {} for {}", big(rounds as f64), name, paid), Effect::None))
        }
        "formation" => {
            let f = items.formation(id).ok_or_else(not_sold)?;
            let msg = unlock(eco, format!("formation:{}", id), shop.formations.get(id), &format!("the {} formation", f.name))?;
            p.loadout.formation = id.to_string();
            Ok((msg, Effect::Loadout))
        }
        "booster" => {
            let b = items.booster(id).ok_or_else(not_sold)?;
            let msg = unlock(eco, format!("booster:{}", id), shop.boosters.get(id), &b.name)?;
            if !p.loadout.boosters.iter().any(|x| x == id) {
                p.loadout.boosters.push(id.to_string());
            }
            Ok((msg, Effect::Loadout))
        }
        "tech" => {
            let price = shop.tech.get(id).ok_or_else(not_sold)?;
            let name = match id {
                "pet" => "the P.E.T.",
                "refining" => "Seprom refining",
                "skills" => "the pilot skill tree",
                _ => id,
            };
            let msg = unlock(eco, format!("tech:{}", id), Some(price), name)?;
            Ok((msg, Effect::Loadout))
        }
        "upgrade" => {
            if eco.owns(id) == 0 {
                return Err("You don't own that item".into());
            }
            let max = if items.drone(id).is_some() {
                16
            } else if items.speed_gen(id).is_some() {
                0
            } else {
                items.max_level(id)
            };
            if max == 0 || shop.upgrade_cost(id, 0).is_none() {
                return Err(format!("{} can't be upgraded", display_name(items, id)));
            }
            let from = eco.level(id);
            if from >= max {
                return Err(format!("{} is already at the max level {}", display_name(items, id), max));
            }
            let to = (from as u32 + qty).min(max as u32) as u8;
            let cost: f64 = (from..to).filter_map(|l| shop.upgrade_cost(id, l)).sum();
            let paid = charge(eco, cost, 0.0)?;
            eco.levels.insert(id.to_string(), to);
            Ok((format!("Upgraded {} to level {} for {}", display_name(items, id), to, paid), Effect::Levels))
        }
        _ => Err(format!("Unknown shop category '{}'", kind)),
    }
}

impl World {
    fn season_now(&self) -> f64 {
        self.season.as_ref().map_or(0.0, |s| s.now())
    }

    /// Token and saved profile for a connecting pilot (None outside the season). A pilot that
    /// is still online with the same token (second tab, stale connection) is logged out first.
    pub(super) fn season_identity(&mut self, token: Option<&str>) -> Option<(String, Option<Profile>)> {
        self.season.as_ref()?;
        let tok = token
            .filter(|t| valid_token(t))
            .map(String::from)
            .unwrap_or_else(|| (&mut self.rng).sample_iter(&Alphanumeric).take(24).map(char::from).collect());
        let dup = self.ents.values().find(|e| e.player().and_then(|p| p.eco.as_ref()).is_some_and(|x| x.token == tok)).map(|e| e.id);
        if let Some(old) = dup {
            self.send_log(old, "You logged in from another window.");
            self.remove(old);
        }
        let profile = self.season.as_ref()?.profiles.get(&tok).cloned();
        Some((tok, profile))
    }

    /// Turn a fresh player entity into a season pilot (new or restored).
    pub(super) fn season_setup(&mut self, e: &mut Entity, tok: String, profile: Option<Profile>) {
        let data = self.data.clone();
        let Kind::Player(p) = &mut e.kind else { return };
        match profile {
            None => reset_player(&data, p, &tok),
            Some(pr) => {
                let mut eco = pr.eco;
                eco.token = tok;
                p.exp = pr.exp;
                p.honor = pr.honor;
                p.ship = if data.ship(&pr.ship).is_some() && eco.ships.contains(&pr.ship) { pr.ship } else { start_ship(&data) };
                p.design = pr.design;
                p.configs = pr.configs;
                p.cfg = pr.cfg.min(1);
                p.loadout = Loadout { formation: pr.formation, boosters: pr.boosters, ..Loadout::bare() };
                if data.ammo(&pr.ammo).is_some() {
                    p.ammo = pr.ammo;
                }
                if data.rocket(&pr.rocket).is_some() {
                    p.rocket = pr.rocket;
                }
                // the catalogue may have changed since the save: re-check the configs
                let ship = World::ship_of(&data, p);
                let bad = p.configs.iter().any(|c| {
                    eco.check_owned(&data.items, c).is_err() || equipment::validate(ship, &data.items, c).is_err()
                });
                if bad {
                    p.configs = eco.auto_configs(&data.items, equipment::slots(ship, &data.items));
                } else {
                    p.configs.iter_mut().for_each(|c| eco.apply_levels(&data.items, c));
                }
                p.eco = Some(Box::new(eco));
            }
        }
        let eco = p.eco.as_ref().unwrap();
        eco.apply_unlocks(&mut p.loadout);
        self.season_refresh_bonus();
    }

    pub(super) fn season_welcome(&mut self, id: u32) {
        let Some(e) = self.ents.get(&id) else { return };
        let Some(eco) = e.player().and_then(|p| p.eco.as_ref()) else { return };
        let returning = eco.stats.online > 0.0 || eco.stats.npc_kills > 0;
        let bonus = self.season.as_ref().and_then(|s| s.bonus.get(&e.faction).copied()).unwrap_or(0.0);
        if returning {
            self.send_log(id, "Welcome back! Your progress today is saved.");
        } else {
            self.send_log(id, "DAILY SEASON: everyone starts in a Phoenix. Kill aliens for credits and uridium,");
            self.send_log(id, "buy ships, lasers, shields, drones and ammo in the Hangar [H] > Shop. Resets at 00:00 UTC.");
            self.send_log(id, "Tip: buy a Yamato and a second LF-1 right away, and shoot with MCB-25 (key 2) for double damage.");
        }
        if bonus > 0.0 {
            self.send_log(id, &format!("Your company is outnumbered today: +{}% rewards!", (bonus * 100.0).round()));
        }
        self.season_board();
    }

    /// Remember a leaving pilot's progress.
    pub(super) fn season_store(&mut self, e: &Entity) {
        let Some(s) = self.season.as_mut() else { return };
        if let Some((tok, prof)) = profile_of(e) {
            s.profiles.insert(tok, prof);
            s.dirty = true;
        }
    }

    /// (reset time, company bonus, PvP-free spot) for `you.season`.
    pub(super) fn season_you_ctx(&self, id: u32) -> Option<(u64, f64, bool)> {
        let s = self.season.as_ref()?;
        let e = self.ents.get(&id)?;
        e.player()?.eco.as_ref()?;
        let safe = self.protected_map(e.map) || self.in_safe_zone(e);
        Some((s.reset_at_ms(), s.bonus.get(&e.faction).copied().unwrap_or(0.0), safe))
    }

    fn protected_map(&self, map: u32) -> bool {
        self.data.map(map).is_some_and(|m| self.data.shop.protected_maps.contains(&m.name))
    }

    fn in_safe_zone(&self, e: &Entity) -> bool {
        let Some(m) = self.data.map(e.map) else { return false };
        let r = &self.data.shop.safe_radius;
        m.portals.iter().any(|p| dist(e.x, e.y, p.x, p.y) <= r.portal)
            || m.stations.iter().any(|s| dist(e.x, e.y, s.x, s.y) <= r.station)
    }

    fn near_station(&self, e: &Entity) -> bool {
        let r = self.data.shop.safe_radius.station.max(1000.0);
        self.data.map(e.map).is_some_and(|m| m.stations.iter().any(|s| dist(e.x, e.y, s.x, s.y) <= r))
    }

    /// Why player `a` may not shoot player `t` right now (season rules), if it may not.
    pub(super) fn pvp_block(&self, a: u32, t: u32) -> Option<&'static str> {
        if self.same_group(a, t) {
            return Some("You can't attack members of your group");
        }
        self.season.as_ref()?;
        let (a, t) = (self.ents.get(&a)?, self.ents.get(&t)?);
        if !a.is_player() || !t.is_player() {
            return None;
        }
        if a.faction == t.faction {
            Some("You can't attack pilots of your own company")
        } else if self.protected_map(a.map) {
            Some("PvP is disabled on the x-1 and x-2 maps")
        } else if self.in_safe_zone(a) || self.in_safe_zone(t) {
            Some("No fighting near portals and stations (safe zone)")
        } else {
            None
        }
    }

    /// Stop an attack the season rules forbid (logs why). True if refused.
    pub(super) fn pvp_refused(&mut self, id: u32, tid: u32) -> bool {
        let Some(why) = self.pvp_block(id, tid) else { return false };
        if let Some(e) = self.ents.get_mut(&id) {
            e.attacking = false;
        }
        self.send_log(id, why);
        true
    }

    /// Out of the selected laser ammo: fall back to the unlimited x1.
    pub(super) fn season_ammo_fallback(&mut self, id: u32) {
        let data = self.data.clone();
        let Some(p) = self.ents.get_mut(&id).and_then(|e| e.player_mut()) else { return };
        if !p.eco.as_ref().is_some_and(|x| x.stock(&p.ammo) == Some(0)) {
            return;
        }
        let name = data.ammo(&p.ammo).map_or_else(|| p.ammo.clone(), |a| a.name.clone());
        p.ammo = data.lasers.ammo[0].id.clone();
        self.send_log(id, &format!("Out of {} - switched to {}. Buy ammo in the Shop.", name, data.lasers.ammo[0].name));
    }

    /// Handle season-only messages and refuse what the season forbids. True = consumed.
    pub(super) fn season_gate(&mut self, id: u32, msg: &ClientMsg) -> bool {
        if self.season.is_none() {
            return false;
        }
        let data = self.data.clone();
        let Some(e) = self.ents.get(&id) else { return false };
        let Some(p) = e.player() else { return false };
        let Some(eco) = p.eco.as_ref() else { return false };
        let refuse = |w: &Self, text: String| {
            w.send_log(id, &text);
            true
        };
        match msg {
            ClientMsg::Warp { .. } => refuse(self, "The Jump CPU is disabled in the daily season - fly through the portals [J]".into()),
            ClientMsg::Cheat { .. } => true,
            ClientMsg::Upgrade { .. } => refuse(self, "Upgrades are bought per item type in the Shop".into()),
            ClientMsg::Ammo { id: a } if eco.stock(a) == Some(0) => {
                let name = data.ammo(a).map_or_else(|| a.clone(), |x| x.name.clone());
                refuse(self, format!("No {} left - buy more in the Shop", name))
            }
            ClientMsg::Rocket { id: Some(r) } if eco.stock(r) == Some(0) => {
                let name = data.rocket(r).map_or_else(|| r.clone(), |x| x.name.clone());
                refuse(self, format!("No {} left - buy more in the Shop", name))
            }
            ClientMsg::Formation { id: f } if f != "standard" && !eco.unlocked("formation", f) => {
                refuse(self, "Buy that formation in the Shop first".into())
            }
            ClientMsg::Booster { id: b, on: true } if !eco.unlocked("booster", b) => refuse(self, "Buy that booster in the Shop first".into()),
            ClientMsg::Attack { on: true } => match e.target.and_then(|t| self.pvp_block(id, t)) {
                Some(why) => {
                    self.ents.get_mut(&id).unwrap().attacking = false;
                    refuse(self, why.into())
                }
                None => false,
            },
            ClientMsg::Ship { ship, design } => {
                self.season_ship(id, ship, design.clone());
                true
            }
            ClientMsg::Buy { kind, id: item, qty } => {
                self.season_buy(id, kind, item, *qty);
                true
            }
            ClientMsg::AutoEquip => {
                self.season_auto_equip(id);
                self.send_log(id, "Equipped the best gear you own");
                true
            }
            _ => false,
        }
    }

    fn season_ship(&mut self, id: u32, ship: &str, design: Option<String>) {
        let data = self.data.clone();
        let Some(s) = data.ship(ship) else {
            self.send_log(id, &format!("Unknown ship '{}'", ship));
            return;
        };
        let design = design.filter(|d| !d.is_empty() && d != &s.id);
        if design.as_ref().is_some_and(|d| !s.designs.iter().any(|x| &x.id == d)) {
            self.send_log(id, "Unknown design");
            return;
        }
        let e = &self.ents[&id];
        let owned = e.player().and_then(|p| p.eco.as_ref()).is_some_and(|x| x.ships.contains(ship));
        if !owned {
            self.send_log(id, &format!("You don't own the {} - buy it in the Shop", s.name));
            return;
        }
        if !self.near_station(e) {
            self.send_log(id, "Ships can only be changed at a space station");
            return;
        }
        let e = self.ents.get_mut(&id).unwrap();
        let p = e.player_mut().unwrap();
        let changed = p.ship != ship;
        p.ship = ship.to_string();
        p.design = design;
        if changed {
            let eco = p.eco.as_ref().unwrap();
            p.configs = eco.auto_configs(&data.items, equipment::slots(s, &data.items));
            info!("player {} switched to {}", id, s.name);
        }
        Self::apply_ship(&data, e, changed);
        self.send_you(id, true);
    }

    pub(super) fn season_auto_equip(&mut self, id: u32) {
        let data = self.data.clone();
        let Some(e) = self.ents.get_mut(&id) else { return };
        let Some(p) = e.player_mut() else { return };
        let Some(eco) = p.eco.as_ref() else { return };
        let ship = World::ship_of(&data, p);
        p.configs = eco.auto_configs(&data.items, equipment::slots(ship, &data.items));
        Self::apply_ship(&data, e, false);
        self.send_you(id, true);
    }

    fn season_buy(&mut self, id: u32, kind: &str, item: &str, qty: u32) {
        let data = self.data.clone();
        let Some(e) = self.ents.get_mut(&id) else { return };
        let name = e.name.clone();
        let Some(p) = e.player_mut() else { return };
        match buy(&data, p, kind, item, qty) {
            Err(why) => self.send_log(id, &why),
            Ok((text, effect)) => {
                info!("player {} '{}' {}", id, name, text.to_lowercase());
                match effect {
                    Effect::None => {}
                    Effect::AutoEquip => {
                        let eco = p.eco.as_ref().unwrap();
                        let ship = World::ship_of(&data, p);
                        p.configs = eco.auto_configs(&data.items, equipment::slots(ship, &data.items));
                        Self::apply_ship(&data, e, false);
                    }
                    Effect::Loadout => {
                        p.eco.as_ref().unwrap().apply_unlocks(&mut p.loadout);
                        Self::apply_ship(&data, e, false);
                    }
                    Effect::Levels => {
                        let eco = p.eco.as_ref().unwrap();
                        p.configs.iter_mut().for_each(|c| eco.apply_levels(&data.items, c));
                        Self::apply_ship(&data, e, false);
                    }
                    Effect::Ship(ship) => {
                        self.send_log(id, &text);
                        let docked = self.near_station(&self.ents[&id]);
                        if docked {
                            self.season_ship(id, &ship, None);
                        } else {
                            self.send_log(id, "Fly to a space station to switch to it (Hangar > Ships)");
                        }
                        self.season_mark_dirty();
                        self.send_you(id, true);
                        return;
                    }
                }
                self.send_log(id, &text);
                self.season_mark_dirty();
            }
        }
        self.send_you(id, true);
    }

    fn season_mark_dirty(&mut self) {
        if let Some(s) = self.season.as_mut() {
            s.dirty = true;
        }
    }

    /// Season NPC kill rewards (credits/uridium/EP/honor with multipliers and the company
    /// bonus). False if the killer is not a season pilot (sandbox reward path runs instead).
    pub(super) fn season_reward(&mut self, killer: u32, def: usize) -> bool {
        let data = self.data.clone();
        let Some(s) = self.season.as_ref() else { return false };
        let Some(k) = self.ents.get(&killer) else { return false };
        if !k.player().is_some_and(|p| p.eco.is_some()) {
            return false;
        }
        let d = &data.npcs[def];
        let m = &data.shop.reward_mult;
        let killer_name = k.name.clone();
        // group: split between the killer and active members on the map, with a small bonus pot
        let share: Vec<u32> = self
            .share_targets(killer)
            .into_iter()
            .filter(|id| self.ents.get(id).and_then(|e| e.player()).is_some_and(|p| p.eco.is_some()))
            .collect();
        let n = share.len().max(1) as f64;
        let pot = (1.0 + super::group::SHARE_BONUS * (n - 1.0)) / n;
        let mut info_line = None;
        for &r in &share {
            let e = self.ents.get_mut(&r).unwrap();
            let f = (1.0 + s.bonus.get(&e.faction).copied().unwrap_or(0.0)) * pot;
            let (ep, hon, cr, uri) = (d.exp * m.exp * f, d.honor * m.honor * f, d.credits * m.credits * f, d.uridium * m.uridium * f);
            let p = e.player_mut().unwrap();
            p.exp += ep;
            p.honor += hon;
            let eco = p.eco.as_mut().unwrap();
            eco.credits += cr;
            eco.uridium += uri;
            eco.stats.earned_c += cr;
            eco.stats.earned_u += uri;
            let mut lines = vec![];
            if r == killer {
                eco.stats.npc_kills += 1;
                if d.exp > eco.stats.best_kill_ep {
                    eco.stats.best_kill_ep = d.exp;
                    eco.stats.best_kill = d.name.clone();
                }
                info_line = Some((ep, hon, cr, uri));
                lines.push(format!("You destroyed {}", d.name));
            } else {
                lines.push(format!("Group: {} destroyed {}", killer_name, d.name));
            }
            for (v, what) in [(cr, "credits"), (uri, "uridium"), (ep, "EP"), (hon, "honor")] {
                if v > 0.0 {
                    lines.push(format!("You received {} {}", big(v), what));
                }
            }
            if r == killer && n > 1.0 {
                lines.push(format!("(shared with {} group member{}, +{}% group bonus)", n - 1.0, if n > 2.0 { "s" } else { "" }, ((n - 1.0) * SHARE_PCT).round()));
            }
            if s.bonus.get(&self.ents[&r].faction).copied().unwrap_or(0.0) > 0.0 && r == killer {
                lines.push(format!("(+{}% outnumbered-company bonus)", (s.bonus[&self.ents[&r].faction] * 100.0).round()));
            }
            for l in lines {
                self.send_log(r, &l);
            }
        }
        if let Some((ep, hon, cr, uri)) = info_line {
            let shared = if n > 1.0 { format!(", shared x{}", n) } else { String::new() };
            info!("player {} destroyed {} (+{} EP, +{} honor, +{} C, +{} U{})", killer, d.name, ep.round(), hon.round(), cr.round(), uri.round(), shared);
        }
        true
    }

    /// A player died to `killer`: count it and pay the PvP bounty (once per victim per cooldown).
    pub(super) fn season_pvp_kill(&mut self, killer: u32, victim: u32) {
        if self.season.is_none() {
            return;
        }
        let data = self.data.clone();
        let now = self.time;
        let Some(v) = self.ents.get_mut(&victim) else { return };
        let (v_name, v_faction, v_level) = (v.name.clone(), v.faction.clone(), v.player().map_or(1, |p| combat::level_for_exp(p.exp)));
        let Some(v_eco) = v.player_mut().and_then(|p| p.eco.as_mut()) else { return };
        v_eco.stats.deaths += 1;
        let v_token = v_eco.token.clone();
        let Some(k) = self.ents.get_mut(&killer) else { return };
        if k.faction == v_faction {
            return;
        }
        let k_name = k.name.clone();
        let Some(p) = k.player_mut() else { return };
        let Some(eco) = p.eco.as_mut() else { return };
        eco.stats.pvp_kills += 1;
        let pvp = &data.shop.pvp;
        if eco.pvp_paid.get(&v_token).is_some_and(|t| now - t < pvp.cooldown) {
            self.send_log(killer, &format!("You destroyed {} again - no bounty for repeat kills yet", v_name));
            return;
        }
        eco.pvp_paid.insert(v_token, now);
        let lvl = v_level as f64;
        let (ep, hon, uri) = (pvp.exp * lvl, pvp.honor * lvl, pvp.uridium * lvl);
        eco.uridium += uri;
        eco.stats.earned_u += uri;
        p.exp += ep;
        p.honor += hon;
        info!("player {} '{}' defeated '{}' (+{} EP, +{} honor, +{} U)", killer, k_name, v_name, ep, hon, uri);
        self.send_log(killer, &format!("You destroyed {} (level {})!", v_name, v_level));
        self.send_log(killer, &format!("Bounty: {} uridium, {} EP, {} honor", big(uri), big(ep), big(hon)));
    }

    /// Every tick: daily reset, online time, leaderboard and periodic save.
    pub(super) fn season_step(&mut self, dt: f64) {
        let Some(s) = self.season.as_ref() else { return };
        let today = day_of(s.now());
        if today != s.day {
            self.daily_reset(today);
        }
        for e in self.ents.values_mut() {
            if let Some(p) = e.player_mut().filter(|p| !p.tx.is_closed()) {
                if let Some(eco) = p.eco.as_mut() {
                    eco.stats.online += dt;
                }
            }
        }
        let s = self.season.as_mut().unwrap();
        s.board_timer += dt;
        s.save_timer += dt;
        if s.board_timer >= BOARD_EVERY {
            s.board_timer = 0.0;
            self.season_board();
        }
        let s = self.season.as_mut().unwrap();
        if s.save_timer >= SAVE_EVERY {
            s.save_timer = 0.0;
            let online = self.ents.values().any(|e| e.player().is_some_and(|p| p.eco.is_some()));
            if online || self.season.as_ref().unwrap().dirty {
                self.season_save();
            }
        }
    }

    /// Today's pilots (offline profiles + online players), best first, and per-company totals.
    fn standings(&self) -> (Vec<(String, TopRow)>, BTreeMap<String, FactionRow>) {
        let Some(s) = self.season.as_ref() else { return (vec![], BTreeMap::new()) };
        let mut rows: HashMap<String, TopRow> = s.profiles.iter().map(|(t, p)| (t.clone(), row_of(p, false))).collect();
        for e in self.ents.values() {
            if let Some((tok, prof)) = profile_of(e) {
                let on = e.player().is_some_and(|p| !p.tx.is_closed());
                rows.insert(tok, row_of(&prof, on));
            }
        }
        let mut rows: Vec<(String, TopRow)> = rows.into_iter().collect();
        rows.sort_by(|a, b| b.1.ep.total_cmp(&a.1.ep).then_with(|| a.1.n.cmp(&b.1.n)));
        let mut factions: BTreeMap<String, FactionRow> = FACTIONS.iter().map(|f| (f.to_string(), FactionRow::default())).collect();
        for (_, r) in &rows {
            if let Some(f) = factions.get_mut(&r.f) {
                f.pilots += 1;
                f.online += r.on as u32;
                f.ep += r.ep;
            }
        }
        // underdog bonus: the company (or companies) with the fewest pilots today
        let min = factions.values().map(|f| f.pilots).min().unwrap_or(0);
        let max = factions.values().map(|f| f.pilots).max().unwrap_or(0);
        for f in factions.values_mut() {
            f.bonus = if f.pilots == min && min < max { self.data.shop.underdog_bonus } else { 0.0 };
        }
        (rows, factions)
    }

    fn season_refresh_bonus(&mut self) {
        let (_, factions) = self.standings();
        if let Some(s) = self.season.as_mut() {
            s.bonus = factions.into_iter().map(|(k, f)| (k, f.bonus)).collect();
        }
    }

    /// Recompute ranks/bonuses and send everyone the leaderboard.
    pub(super) fn season_board(&mut self) {
        let (rows, factions) = self.standings();
        let Some(s) = self.season.as_mut() else { return };
        s.bonus = factions.iter().map(|(k, f)| (k.clone(), f.bonus)).collect();
        let champions = s.champions.clone();
        let rank: HashMap<&str, u32> = rows.iter().enumerate().map(|(i, (t, _))| (t.as_str(), i as u32 + 1)).collect();
        let top: Vec<TopRow> = rows.iter().take(TOP_ROWS).map(|(_, r)| r.clone()).collect();
        let mut msg = TopMsg { rows: top, factions, champions, rank: 0, pilots: rows.len() as u32 };
        for e in self.ents.values_mut() {
            let Some(p) = e.player_mut() else { continue };
            let Some(eco) = p.eco.as_mut() else { continue };
            eco.rank = rank.get(eco.token.as_str()).copied().unwrap_or(0);
            msg.rank = eco.rank;
            let _ = p.tx.try_send(ServerMsg::Top(&msg).json());
        }
    }

    /// 00:00 UTC: crown yesterday's top 3 and send everyone back to the start.
    fn daily_reset(&mut self, today: u64) {
        let (rows, _) = self.standings();
        let champions: Vec<TopRow> = rows.iter().filter(|r| r.1.ep > 0.0).take(3).map(|r| r.1.clone()).collect();
        let text = if champions.is_empty() {
            "A new day begins! Everyone starts from scratch.".to_string()
        } else {
            let list: Vec<String> = champions.iter().enumerate().map(|(i, c)| format!("{}. {} ({} EP)", i + 1, c.n, big(c.ep))).collect();
            format!("The day is over! Champions: {}. A new day begins - everyone starts from scratch.", list.join(", "))
        };
        info!("season reset (day {}): {}", today, text);
        if let Some(s) = self.season.as_mut() {
            s.day = today;
            s.profiles.clear();
            s.champions = champions;
            s.dirty = true;
        }
        let ids: Vec<u32> = self.ents.values().filter(|e| e.player().is_some_and(|p| p.eco.is_some())).map(|e| e.id).collect();
        for id in ids {
            self.season_reset_pilot(id);
            if let Some(e) = self.ents.get(&id) {
                e.send(&ServerMsg::Chat { from: "SEASON".into(), text: text.clone() });
            }
        }
        self.season_board();
    }

    fn season_reset_pilot(&mut self, id: u32) {
        let data = self.data.clone();
        let faction = self.ents[&id].faction.clone();
        let (map, x, y) = self.home(&faction);
        let e = self.ents.get_mut(&id).unwrap();
        let p = e.player_mut().unwrap();
        let token = p.eco.as_ref().map(|x| x.token.clone()).unwrap_or_default();
        reset_player(&data, p, &token);
        p.dead = false;
        (e.map, e.x, e.y) = (map, x, y);
        e.dest = None;
        e.target = None;
        e.attacking = false;
        e.since_hit = 999.0;
        Self::apply_ship(&data, e, true);
        let e = &self.ents[&id];
        self.send_map(e);
        self.clear_targeting(id);
        self.send_you(id, true);
        self.send_log(id, "New day: back in the Phoenix. Good luck, pilot!");
    }

    fn season_save(&mut self) {
        let online: Vec<(String, Profile)> = self.ents.values().filter_map(profile_of).collect();
        let Some(s) = self.season.as_mut() else { return };
        s.dirty = false;
        let Some(path) = s.save_path.clone() else { return };
        let mut profiles = s.profiles.clone();
        profiles.extend(online);
        let file = SaveFile { day: s.day, profiles, champions: s.champions.clone() };
        let tmp = path.with_extension("tmp");
        let res = serde_json::to_vec(&file)
            .map_err(|e| e.to_string())
            .and_then(|b| std::fs::write(&tmp, b).map_err(|e| e.to_string()))
            .and_then(|_| std::fs::rename(&tmp, &path).map_err(|e| e.to_string()));
        if let Err(e) = res {
            warn!("season save to {} failed: {}", path.display(), e);
        }
    }

    /// Public season summary for the login screen (`/api/season`).
    pub fn season_info(&self, token: Option<&str>) -> serde_json::Value {
        let Some(s) = self.season.as_ref() else { return serde_json::json!({ "enabled": false }) };
        let (rows, factions) = self.standings();
        let me = token.and_then(|t| rows.iter().find(|(k, _)| k == t)).map(|(_, r)| r);
        serde_json::json!({
            "enabled": true,
            "now": (self.season_now() * 1000.0) as u64,
            "resetAt": s.reset_at_ms(),
            "factions": factions,
            "locked": me.map(|r| r.f.clone()),
            "name": me.map(|r| r.n.clone()),
            "level": me.map(|r| r.lvl),
            "champions": s.champions,
            "top": rows.iter().take(5).map(|(_, r)| r).collect::<Vec<_>>(),
            "pilots": rows.len(),
            "bonus": self.data.shop.underdog_bonus,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    fn ship(id: &str, hp: f64, lasers: f64, gens: f64) -> Ship {
        Ship { id: id.into(), name: id.into(), hp, speed: 300.0, lasers, generators: gens, extras: 1.0, sheet: id.into(), ..Default::default() }
    }

    fn data() -> Arc<Data> {
        let ships = vec![ship("ship_phoenix", 4000.0, 1.0, 1.0), ship("ship_liberator", 16000.0, 4.0, 6.0)];
        let npcs = vec![NpcDef { id: "streuner".into(), name: "Streuner".into(), hp: 800.0, shield: 400.0, exp: 400.0, honor: 2.0, credits: 400.0, uridium: 1.0, ..Default::default() }];
        let mut home = MapDef {
            id: 1,
            name: "1-1".into(),
            faction: "mmo".into(),
            w: 20000.0,
            h: 20000.0,
            stations: vec![Station { faction: "mmo".into(), x: 1000.0, y: 1000.0 }],
            portals: vec![Portal { id: serde_json::json!(1), x: 15000.0, y: 15000.0, to: 2, tx: 1000.0, ty: 1000.0 }],
            npcs: vec![MapNpc { id: "streuner".into(), count: 1 }],
            ..Default::default()
        };
        home.raw = serde_json::json!({"id":1});
        let mut eic = home.clone();
        (eic.id, eic.name, eic.faction) = (3, "2-1".into(), "eic".into());
        eic.stations = vec![Station { faction: "eic".into(), x: 1000.0, y: 1000.0 }];
        eic.npcs = vec![];
        let mut open = home.clone();
        (open.id, open.name, open.faction) = (2, "4-1".into(), "none".into());
        open.stations = vec![];
        open.npcs = vec![];
        let mut d = Data::from_parts(ships, npcs, vec![home, open, eic], Lasers::default());
        d.shop = serde_json::from_str(include_str!("../../../data/shop.json")).unwrap();
        d.shop.protected_maps = vec!["1-1".into(), "2-1".into()];
        Arc::new(d)
    }

    fn world() -> World {
        let mut w = World::new(data());
        w.season = Some(SeasonState::new(None));
        w
    }

    fn join(w: &mut World, tok: &str, faction: &str) -> (u32, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(100_000);
        (w.login_token(tx, "pilot", faction, Some(tok)), rx)
    }

    fn eco(w: &World, id: u32) -> &Eco {
        w.ents[&id].player().unwrap().eco.as_ref().unwrap()
    }

    fn logs(rx: &mut mpsc::Receiver<String>) -> String {
        let mut s = String::new();
        while let Ok(m) = rx.try_recv() {
            s.push_str(&m);
            s.push('\n');
        }
        s
    }

    #[test]
    fn start_buy_equip_and_restore() {
        let mut w = world();
        let (id, mut rx) = join(&mut w, "token-aaaa", "mmo");
        let p = w.ents[&id].player().unwrap();
        assert_eq!(p.ship, "ship_phoenix");
        assert_eq!(p.configs[0].lasers, vec!["lf1"]);
        assert!(!p.loadout.pet && !p.loadout.refining && !p.loadout.skills);
        assert_eq!(eco(&w, id).credits, 15000.0);
        let dmg0 = p.stats.damage;
        assert!(dmg0 > 50.0 && dmg0 < 100.0, "bare LF-1: {}", dmg0);

        // cheats and the jump CPU are refused, unowned gear is rejected
        w.handle(id, ClientMsg::Cheat { god: Some(true), dmg_mult: Some(100.0) });
        w.handle(id, ClientMsg::Warp { map: 2 });
        assert!(!w.ents[&id].player().unwrap().god);
        assert_eq!(w.ents[&id].map, 1);
        w.handle(id, ClientMsg::Equip { config: 1, lasers: Some(vec!["lf4".into()]), gens: None, extras: None, drones: None, drone_design: None, laser_lvls: None, gen_lvls: None });
        assert_eq!(w.ents[&id].player().unwrap().configs[0].lasers, vec!["lf1"]);
        assert!(logs(&mut rx).contains("Equipment rejected"));

        // buy a Liberator (too expensive), then credits arrive and it works; docked = switch
        w.handle(id, ClientMsg::Buy { kind: "ship".into(), id: "ship_liberator".into(), qty: 1 });
        assert!(logs(&mut rx).contains("Not enough"));
        w.ents.get_mut(&id).unwrap().player_mut().unwrap().eco.as_mut().unwrap().credits = 100_000.0;
        w.handle(id, ClientMsg::Buy { kind: "ship".into(), id: "ship_liberator".into(), qty: 1 });
        w.handle(id, ClientMsg::Buy { kind: "item".into(), id: "lf2".into(), qty: 2 });
        let p = w.ents[&id].player().unwrap();
        assert_eq!(p.ship, "ship_liberator");
        assert_eq!(p.configs[0].lasers, vec!["lf2", "lf2", "lf1"]);
        assert_eq!(eco(&w, id).credits, 100_000.0 - 30_000.0 - 40_000.0);
        // upgrades are per item type
        w.handle(id, ClientMsg::Buy { kind: "upgrade".into(), id: "lf2".into(), qty: 3 });
        assert_eq!(w.ents[&id].player().unwrap().configs[0].laser_lvls, vec![3, 3, 0]);

        // leave and come back with another company: progress restored, company locked
        w.remove(id);
        let (id2, _rx2) = join(&mut w, "token-aaaa", "vru");
        let e = &w.ents[&id2];
        assert_eq!(e.faction, "mmo");
        assert_eq!(e.player().unwrap().ship, "ship_liberator");
        assert_eq!(eco(&w, id2).level("lf2"), 3);
        // a second window with the same token takes over
        let (id3, _rx3) = join(&mut w, "token-aaaa", "mmo");
        assert!(!w.ents.contains_key(&id2));
        assert_eq!(eco(&w, id3).owns("lf2"), 2);
    }

    #[test]
    fn kills_pay_and_ammo_runs_out() {
        let mut w = world();
        let (id, mut rx) = join(&mut w, "token-bbbb", "mmo");
        let npc = *w.ents.keys().find(|k| **k != id).unwrap();
        w.reward(id, w.ents[&npc].npc().unwrap().def);
        let e = eco(&w, id);
        // eic and vru have no pilots yet, so mmo gets no underdog bonus
        assert_eq!(e.credits, 15_400.0);
        assert_eq!(e.uridium, 5.0);
        assert_eq!(e.stats.npc_kills, 1);
        assert!(logs(&mut rx).contains("You received 400 credits"));

        // x2 runs dry -> back to x1
        w.ents.get_mut(&id).unwrap().player_mut().unwrap().eco.as_mut().unwrap().ammo.insert("x2".into(), 1);
        w.handle(id, ClientMsg::Ammo { id: "x2".into() });
        {
            let e = w.ents.get_mut(&id).unwrap();
            e.target = Some(npc);
            e.attacking = true;
            let n = w.ents.get_mut(&npc).unwrap();
            (n.x, n.y) = (1100.0, 1000.0);
        }
        w.try_laser(id);
        assert_eq!(eco(&w, id).stock("x2"), Some(0));
        w.ents.get_mut(&id).unwrap().laser_cd = 0.0;
        w.try_laser(id);
        assert_eq!(w.ents[&id].player().unwrap().ammo, "x1");
        w.handle(id, ClientMsg::Ammo { id: "x2".into() });
        assert_eq!(w.ents[&id].player().unwrap().ammo, "x1");
    }

    #[test]
    fn pvp_rules_and_bounty() {
        let mut w = world();
        let (a, mut rx) = join(&mut w, "token-mmo1", "mmo");
        let (b, _) = join(&mut w, "token-eic1", "eic");
        let (c, _) = join(&mut w, "token-mmo2", "mmo");
        let place = |w: &mut World, id: u32, map: u32, x: f64| {
            let e = w.ents.get_mut(&id).unwrap();
            (e.map, e.x, e.y) = (map, x, 5000.0);
        };
        // protected home map
        place(&mut w, a, 1, 5000.0);
        place(&mut w, b, 1, 5300.0);
        assert!(w.pvp_block(a, b).is_some());
        // open map: allowed vs the enemy, never vs your own company, not at the portal
        place(&mut w, a, 2, 5000.0);
        place(&mut w, b, 2, 5300.0);
        place(&mut w, c, 2, 5200.0);
        assert!(w.pvp_block(a, b).is_none());
        assert!(w.pvp_block(a, c).is_some());
        place(&mut w, b, 2, 14800.0);
        w.ents.get_mut(&b).unwrap().y = 14900.0;
        assert!(w.pvp_block(a, b).is_some(), "portal safe zone");
        w.ents.get_mut(&a).unwrap().target = Some(b);
        w.handle(a, ClientMsg::Attack { on: true });
        assert!(!w.ents[&a].attacking);
        assert!(logs(&mut rx).contains("safe zone"));

        // bounty once, then not again within the cooldown
        w.kill(b, a);
        let u = eco(&w, a).uridium;
        assert_eq!(u, 25.0);
        assert_eq!(eco(&w, b).stats.deaths, 1);
        w.handle(b, ClientMsg::Revive);
        w.kill(b, a);
        assert_eq!(eco(&w, a).uridium, u);
        assert_eq!(eco(&w, a).stats.pvp_kills, 2);
    }

    #[test]
    fn underdog_bonus_and_daily_reset() {
        let mut w = world();
        let (a, _) = join(&mut w, "token-mmo1", "mmo");
        let (_b, _) = join(&mut w, "token-mmo2", "mmo");
        let (v, mut rxv) = join(&mut w, "token-vru1", "vru");
        w.season_board();
        // eic has nobody -> eic gets the bonus; vru (1) and mmo (2) don't
        let s = w.season.as_ref().unwrap();
        assert_eq!(s.bonus["eic"], 0.25);
        assert_eq!(s.bonus["vru"], 0.0);
        let info = w.season_info(Some("token-vru1"));
        assert_eq!(info["locked"], "vru");
        assert_eq!(info["factions"]["mmo"]["pilots"], 2);
        assert!(logs(&mut rxv).contains("\"t\":\"top\""));

        w.ents.get_mut(&a).unwrap().player_mut().unwrap().exp = 50_000.0;
        w.ents.get_mut(&a).unwrap().player_mut().unwrap().eco.as_mut().unwrap().credits = 1e9;
        w.ents.get_mut(&a).unwrap().map = 2;
        // next day
        w.season.as_mut().unwrap().clock_offset = DAY_SECS as f64;
        w.step(0.05);
        let s = w.season.as_ref().unwrap();
        assert_eq!(s.champions[0].n, "pilot");
        assert_eq!(s.champions[0].ep, 50_000.0);
        let e = &w.ents[&a];
        assert_eq!(e.map, 1, "sent home");
        assert_eq!(e.player().unwrap().exp, 0.0);
        assert_eq!(eco(&w, a).credits, 15_000.0);
        assert!(logs(&mut rxv).contains("Champions"));
        let _ = v;
    }

    fn grp(action: &str, name: Option<&str>, id: Option<u32>) -> ClientMsg {
        ClientMsg::Group { action: action.into(), name: name.map(String::from), id }
    }

    #[test]
    fn groups_invite_share_and_protect() {
        let mut w = world();
        let (a, mut rxa) = join(&mut w, "token-grp-a", "mmo");
        let (b, mut rxb) = join(&mut w, "token-grp-b", "eic");
        let (c, _rxc) = join(&mut w, "token-grp-c", "vru");
        w.ents.get_mut(&b).unwrap().name = "Bob".into();
        // invite by name, accept -> group of 2 led by a
        w.handle(a, grp("invite", Some("bob"), None));
        assert!(logs(&mut rxb).contains("groupInvite"));
        w.handle(b, grp("accept", None, None));
        assert!(w.same_group(a, b));
        assert!(logs(&mut rxa).contains("\"t\":\"group\""));
        // only the leader invites
        w.handle(b, grp("invite", None, Some(c)));
        assert!(logs(&mut rxb).contains("Only the group leader"));

        // group members never fight, even across companies on an open map
        for id in [a, b] {
            let e = w.ents.get_mut(&id).unwrap();
            (e.map, e.x, e.y) = (2, 5000.0, 5000.0);
        }
        assert!(w.pvp_block(a, b).is_some());

        // kill share: b inactive -> a gets everything; b active on the same map -> split + 5%
        let npc = *w.ents.keys().find(|k| w.ents[k].npc().is_some()).unwrap();
        let def = w.ents[&npc].npc().unwrap().def;
        w.reward(a, def);
        assert_eq!(eco(&w, a).credits, 15_400.0);
        assert_eq!(eco(&w, b).credits, 15_000.0);
        w.ents.get_mut(&b).unwrap().player_mut().unwrap().last_alien_hit = w.time;
        w.reward(a, def);
        assert_eq!(eco(&w, a).credits, 15_400.0 + 210.0);
        assert_eq!(eco(&w, b).credits, 15_000.0 + 210.0);
        assert_eq!(eco(&w, a).stats.npc_kills, 2);
        assert_eq!(eco(&w, b).stats.npc_kills, 0);
        // different map: no share
        w.ents.get_mut(&b).unwrap().map = 1;
        w.reward(a, def);
        assert_eq!(eco(&w, b).credits, 15_210.0);

        // leaving a 2-pilot group disbands it; disconnecting also leaves
        w.handle(b, grp("leave", None, None));
        assert!(!w.same_group(a, b) && w.group_of(a).is_none());
        w.handle(a, grp("invite", None, Some(c)));
        w.handle(c, grp("accept", None, None));
        assert!(w.same_group(a, c));
        w.remove(a);
        assert!(w.group_of(c).is_none());
    }
}
