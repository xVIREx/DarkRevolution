//! Daily season glue: identity, shop purchases, rewards, PvP rules, leaderboard, persistence
//! and the 00:00 UTC reset. The economy itself is in crate::season.

use super::{Entity, Kind, PlayerData, World};
use crate::combat::{self, dist};
use crate::data::Data;
use crate::equipment::{self, Loadout};
use crate::protocol::{ClientMsg, EntState, FactionRow, ServerMsg, TopMsg};
use crate::season::{
    big, display_name, is_bot_token, map_tier, Objectives, now_secs, round_of, valid_token, Eco, Profile, SaveFile, TopRow,
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
/// Ship changes need this long without taking damage.
const SWITCH_COMBAT_SECS: f64 = 10.0;
/// Jump CPU in the season: cooldown and "not under fire" window.
pub const WARP_COOLDOWN_SECS: f64 = 30.0;
const WARP_COMBAT_SECS: f64 = 10.0;
/// Alien loot split: the killing blow takes this jackpot; the rest is split equally between
/// everyone who shot it and the killer's active company mates around it. Alone = 100%.
const KILLER_SHARE: f64 = 0.7;
const SHARE_RADIUS: f64 = 2000.0;
/// A mate must have fired or been hit this recently to get a share (no AFK leeching).
const SHARE_ACTIVE_SECS: f64 = 60.0;
/// Round length of the old fixed UTC schedule (saves without an `end`).
const LEGACY_PERIOD: u64 = 1800;

pub struct SeasonState {
    /// Current round number.
    pub round: u64,
    /// Round length in seconds (the most a round lasts).
    pub period: u64,
    /// Unix seconds the current round ends - after `period`, or earlier when a company reaches
    /// the objective's `winScore`.
    pub round_end: f64,
    /// Saved pilots of this round, by token (offline ones; online ones are snapshotted on save).
    pub profiles: HashMap<String, Profile>,
    /// Top 3 of the previous round.
    pub champions: Vec<TopRow>,
    /// Bonus boxes and dropped cargo boxes lying around.
    pub boxes: Vec<LootBox>,
    /// Bonus boxes waiting to respawn: (map, at world time).
    box_respawn: Vec<(u32, f64)>,
    /// Company objective: beacons and company scores.
    pub obj: Objectives,
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
    pub fn new(save_path: Option<PathBuf>, period: u64) -> SeasonState {
        SeasonState {
            round: round_of(now_secs(), period),
            period,
            round_end: now_secs() + period as f64,
            profiles: HashMap::new(),
            champions: vec![],
            boxes: vec![],
            box_respawn: vec![],
            obj: Objectives::default(),
            bonus: BTreeMap::new(),
            save_path,
            save_timer: 0.0,
            board_timer: 0.0,
            dirty: false,
            clock_offset: 0.0,
        }
    }

    /// Season on when data/shop.json enables it and SEASON != 0. Progress is saved to
    /// SEASON_SAVE (default ./season-save.json) so restarts within a round keep it.
    pub fn from_env(data: &Data) -> Option<SeasonState> {
        if !data.shop.enabled || std::env::var("SEASON").is_ok_and(|v| v == "0") {
            return None;
        }
        let path = std::env::var("SEASON_SAVE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("season-save.json"));
        let mut s = SeasonState::new(Some(path), data.shop.round_secs());
        s.obj = Objectives::from_rule(&data.shop.objectives, data);
        s.load();
        info!("season on: {} min rounds, round {}, {} saved pilots, save file {:?}", s.period / 60, s.round, s.profiles.len(), s.save_path);
        Some(s)
    }

    fn now(&self) -> f64 {
        now_secs() + self.clock_offset
    }

    pub fn reset_at_ms(&self) -> u64 {
        (self.round_end.max(0.0) * 1000.0) as u64
    }

    fn load(&mut self) {
        let Some(path) = &self.save_path else { return };
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let now = self.now();
        match serde_json::from_str::<SaveFile>(&text) {
            Ok(f) => {
                // saves from the fixed UTC schedule (30 min rounds) carry no end: that round
                // started at round * 1800 and now runs the full current length
                let end = if f.end > 0.0 { f.end } else { (f.round * LEGACY_PERIOD) as f64 + self.period as f64 };
                if end > now {
                    self.round = f.round;
                    self.round_end = end;
                    self.profiles = f.profiles;
                    self.champions = f.champions;
                    self.obj.restore(&f.obj);
                } else if end > now - self.period as f64 {
                    // the server was down over the round change: the last save decides the champions
                    let mut rows: Vec<TopRow> = f.profiles.values().map(|p| row_of(p, false)).collect();
                    sort_rows(&mut rows);
                    self.champions = rows.into_iter().filter(|r| r.ep > 0.0).take(3).collect();
                    self.obj.last_winner = f.obj.leader();
                    self.round = f.round + 1;
                }
            }
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
            self.send_log(id, "Welcome back! Your progress this round is saved.");
        } else {
            let mins = self.season.as_ref().map_or(30, |s| s.period / 60);
            self.send_log(id, &format!("{}-MINUTE ROUNDS: everyone starts in a Phoenix. Kill aliens and grab boxes for credits and uridium.", mins));
            self.send_log(id, "Press U to buy the next upgrade (or browse the Hangar [H] > Shop). Dying drops part of your unspent loot!");
            self.send_log(id, "Tip: press U right away - your first upgrade is a Yamato. Shoot with MCB-25 (key 2) for double damage.");
        }
        if bonus > 0.0 {
            self.send_log(id, &format!("Your company gets +{}% rewards this round!", (bonus * 100.0).round()));
        }
        if !returning {
            self.send_log(id, "Company goal: capture and hold the beacons on the 4-x maps. Most beacon points at the end wins the round.");
        }
        self.season_board();
        self.send_objectives();
    }

    /// Remember a leaving pilot's progress.
    pub(super) fn season_store(&mut self, e: &Entity) {
        let Some(s) = self.season.as_mut() else { return };
        if let Some((tok, prof)) = profile_of(e).filter(|(t, _)| !is_bot_token(t)) {
            s.profiles.insert(tok, prof);
            s.dirty = true;
        }
    }

    /// (reset time, company bonus, PvP-free spot, next upgrade) for `you.season`.
    pub(super) fn season_you_ctx(&self, id: u32) -> Option<(u64, f64, bool, f64)> {
        let s = self.season.as_ref()?;
        let e = self.ents.get(&id)?;
        e.player()?.eco.as_ref()?;
        let safe = self.protected_map(e.map) || self.in_safe_zone(e);
        Some((s.reset_at_ms(), s.bonus.get(&e.faction).copied().unwrap_or(0.0), safe, self.time))
    }

    /// Season bots carry a `bot:` token (never the outbox state: a stalled human connection
    /// also has a closed outbox).
    pub(super) fn is_bot(&self, id: u32) -> bool {
        self.ents.get(&id).and_then(|e| e.player()).and_then(|p| p.eco.as_ref()).is_some_and(|x| is_bot_token(&x.token))
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

    /// Why player `a` may not shoot player `t` right now (season rules), if it may not.
    pub(super) fn pvp_block(&self, a: u32, t: u32) -> Option<&'static str> {
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
            ClientMsg::Warp { map } => {
                // Jump CPU: free, but not under fire and with a cooldown, so it saves travel
                // time without being an escape button
                let (ready, since_hit) = (eco.warp_ready, e.since_hit);
                if p.dead {
                    true
                } else if !eco.visited.contains(map) {
                    refuse(self, "The Jump CPU only reaches maps you've already flown to this round - use the portals [J]".into())
                } else if since_hit < WARP_COMBAT_SECS {
                    refuse(self, "The Jump CPU can't be used while under fire".into())
                } else if ready > self.time {
                    refuse(self, format!("The Jump CPU is recharging: {} s", (ready - self.time).ceil()))
                } else if data.map(*map).is_none() {
                    refuse(self, "Unknown map".into())
                } else {
                    let now = self.time;
                    if let Some(eco) = self.ents.get_mut(&id).and_then(|e| e.player_mut()).and_then(|p| p.eco.as_mut()) {
                        eco.warp_ready = now + WARP_COOLDOWN_SECS;
                    }
                    self.warp(id, *map);
                    true
                }
            }
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
            ClientMsg::Buy { kind, id: item, .. } if kind == "switch" => {
                self.season_ship(id, item, None);
                self.send_upgrades(id);
                true
            }
            ClientMsg::Upgrades => {
                if let Some(p) = self.ents.get_mut(&id).and_then(|e| e.player_mut()) {
                    p.upgrades_req = self.time;
                }
                self.send_upgrades(id);
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
        // anywhere, but not mid-fight; hp/shield keep their fill ratio (no free heal)
        if e.since_hit < SWITCH_COMBAT_SECS && !self.is_bot(id) {
            self.send_log(id, "You can't change ships while under fire");
            return;
        }
        let e = self.ents.get_mut(&id).unwrap();
        let hp_ratio = if e.mhp > 0.0 { (e.hp / e.mhp).clamp(0.0, 1.0) } else { 1.0 };
        let p = e.player_mut().unwrap();
        let changed = p.ship != ship;
        p.ship = ship.to_string();
        p.design = design;
        if let Some(eco) = p.eco.as_mut() {
            eco.pending_ship = None;
        }
        if changed {
            let eco = p.eco.as_ref().unwrap();
            p.configs = eco.auto_configs(&data.items, equipment::slots(s, &data.items));
            info!("player {} switched to {}", id, s.name);
        }
        Self::apply_ship(&data, e, false);
        if changed && !e.player().is_some_and(|p| p.dead) {
            e.hp = (e.mhp * hp_ratio).max(1.0);
        }
        self.send_you(id, true);
        if changed {
            self.send_log(id, &format!("You are now flying the {}", s.name));
        }
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
                        let busy = self.ents.get(&id).is_some_and(|e| e.since_hit < SWITCH_COMBAT_SECS) && !self.is_bot(id);
                        if busy {
                            if let Some(eco) = self.ents.get_mut(&id).and_then(|e| e.player_mut()).and_then(|p| p.eco.as_mut()) {
                                eco.pending_ship = Some(ship);
                            }
                            self.send_log(id, "You'll switch to it as soon as you're out of combat");
                        } else {
                            self.season_ship(id, &ship, None);
                        }
                        self.season_mark_dirty();
                        self.send_you(id, true);
                        self.send_upgrades(id);
                        return;
                    }
                }
                self.send_log(id, &text);
                if !self.is_bot(id) {
                    self.season_mark_dirty();
                    self.send_upgrades(id);
                }
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
    pub(super) fn season_reward(&mut self, killer: u32, def: usize, at: (u32, f64, f64), dmg: &HashMap<u32, f64>) -> bool {
        let data = self.data.clone();
        let Some(s) = self.season.as_ref() else { return false };
        let Some(k) = self.ents.get(&killer) else { return false };
        if !k.player().is_some_and(|p| p.eco.is_some()) {
            return false;
        }
        let d = &data.npcs[def];
        let m = &data.shop.reward_mult;
        let killer_name = k.name.clone();
        let share = self.kill_share(killer, at, dmg);
        let mates = share.len() - 1;
        let helpers = share.iter().filter(|x| x.2 && x.0 != killer).count();
        let mut info_line = None;
        for &(r, frac, shot) in &share {
            let e = self.ents.get_mut(&r).unwrap();
            let f = (1.0 + s.bonus.get(&e.faction).copied().unwrap_or(0.0)) * frac;
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
            } else if shot {
                lines.push(format!("{} got the killing blow on {} - your share for helping:", killer_name, d.name));
            } else {
                lines.push(format!("Company share: {} destroyed {} nearby", killer_name, d.name));
            }
            for (v, what) in [(cr, "credits"), (uri, "uridium"), (ep, "EP"), (hon, "honor")] {
                if v > 0.0 {
                    lines.push(format!("You received {} {}", big(v), what));
                }
            }
            if r == killer && mates > 0 {
                lines.push(format!(
                    "(killing blow: {}%; {}% split between {} pilots{} - hunt alone to keep it all)",
                    (KILLER_SHARE * 100.0).round(),
                    ((1.0 - KILLER_SHARE) * 100.0).round(),
                    share.len(),
                    if helpers > 0 { format!(", {} helped shoot it", helpers) } else { String::new() }
                ));
            }
            if s.bonus.get(&self.ents[&r].faction).copied().unwrap_or(0.0) > 0.0 && r == killer {
                lines.push(format!("(+{}% company bonus)", (s.bonus[&self.ents[&r].faction] * 100.0).round()));
            }
            for l in lines {
                self.send_log(r, &l);
            }
        }
        if let Some((ep, hon, cr, uri)) = info_line {
            let shared = if mates > 0 { format!(", shared with {}", mates) } else { String::new() };
            info!("player {} destroyed {} (+{} EP, +{} honor, +{} C, +{} U{})", killer, d.name, ep.round(), hon.round(), cr.round(), uri.round(), shared);
        }
        true
    }

    /// Who gets a cut of an alien kill, as (pilot, fraction of the loot, helped = shot it).
    /// The killing blow takes KILLER_SHARE (racing for the last hit is part of the game); the
    /// rest is split equally between the killer, everyone else who shot it (any company) and the
    /// killer's active company mates within SHARE_RADIUS - the company is one big party, and
    /// late joiners flying with veterans catch up. Bots only get a slice for shooting.
    pub(super) fn kill_share(&self, killer: u32, at: (u32, f64, f64), dmg: &HashMap<u32, f64>) -> Vec<(u32, f64, bool)> {
        let Some(k) = self.ents.get(&killer).filter(|e| e.player().is_some_and(|p| p.eco.is_some())) else { return vec![] };
        let (map, x, y) = at;
        let mut slice: Vec<(u32, bool)> = self
            .ents
            .iter()
            .filter(|(id, e)| **id != killer && e.player().is_some_and(|p| p.eco.is_some()))
            .filter_map(|(id, e)| {
                let p = e.player()?;
                let shot = dmg.get(id).is_some_and(|v| *v > 0.0);
                let mate = e.faction == k.faction
                    && e.map == map
                    && dist(e.x, e.y, x, y) <= SHARE_RADIUS
                    && !p.dead
                    && p.eco.as_ref().is_some_and(|x| !is_bot_token(&x.token))
                    && self.time - p.last_shot.max(p.last_alien_hit) <= SHARE_ACTIVE_SECS;
                (shot || mate).then_some((*id, shot))
            })
            .collect();
        if slice.is_empty() {
            return vec![(killer, 1.0, true)];
        }
        slice.push((killer, true));
        let each = (1.0 - KILLER_SHARE) / slice.len() as f64;
        slice.into_iter().map(|(id, shot)| (id, each + if id == killer { KILLER_SHARE } else { 0.0 }, shot)).collect()
    }

    /// A player died to `killer`: count it and pay the PvP bounty (once per victim per cooldown).
    pub(super) fn season_pvp_kill(&mut self, killer: u32, victim: u32) {
        if self.season.is_none() {
            return;
        }
        let data = self.data.clone();
        let now = self.time;
        let drop_frac = data.shop.death_drop.clamp(0.0, 1.0);
        let Some(v) = self.ents.get_mut(&victim) else { return };
        let (v_name, v_faction, v_level) = (v.name.clone(), v.faction.clone(), v.player().map_or(1, |p| combat::level_for_exp(p.exp)));
        let (v_map, v_x, v_y) = (v.map, v.x, v.y);
        let Some(v_eco) = v.player_mut().and_then(|p| p.eco.as_mut()) else { return };
        v_eco.stats.deaths += 1;
        let v_token = v_eco.token.clone();
        // Starblast-style: dying spills part of your unspent loot for others to grab
        let (dc, du) = ((v_eco.credits * drop_frac).floor(), (v_eco.uridium * drop_frac).floor());
        if dc + du > 0.0 {
            v_eco.pay(dc, du);
            self.spawn_box(v_map, v_x, v_y, BoxKind::Cargo, dc, du, 0, data.shop.cargo_life.max(10.0));
            self.send_log(victim, &format!("You dropped {} credits and {} uridium in a cargo box where you died", big(dc), big(du)));
        }
        let Some(_) = self.ents.get(&victim) else { return };
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
        let target = self.data.shop.objectives.win_score;
        let won = target > 0.0 && s.obj.score.values().any(|v| *v >= target);
        if won || s.now() >= s.round_end {
            self.round_reset(s.round + 1);
        }
        self.boxes_step();
        for e in self.ents.values_mut() {
            let map = e.map;
            if let Some(eco) = e.player_mut().and_then(|p| p.eco.as_mut()) {
                eco.visited.insert(map);
            }
            if let Some(p) = e.player_mut().filter(|p| !p.tx.is_closed()) {
                if let Some(eco) = p.eco.as_mut() {
                    eco.stats.online += dt;
                }
            }
        }
        if self.tick % 20 == 0 {
            let ids: Vec<u32> = self.ents.values().filter(|e| e.player().is_some_and(|p| p.eco.is_some())).map(|e| e.id).collect();
            for id in ids {
                // bots never see the badge
                let n = if self.is_bot(id) { 0 } else { self.affordable_upgrades(id) };
                let pending = self.ents.get(&id).and_then(|e| {
                    let p = e.player()?;
                    (e.since_hit >= SWITCH_COMBAT_SECS && !p.dead).then(|| p.eco.as_ref()?.pending_ship.clone()).flatten()
                });
                if let Some(eco) = self.ents.get_mut(&id).and_then(|e| e.player_mut()).and_then(|p| p.eco.as_mut()) {
                    eco.affordable = n;
                }
                if let Some(ship) = pending {
                    self.season_ship(id, &ship, None);
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
            let online = self.ents.values().any(|e| e.player().and_then(|p| p.eco.as_ref()).is_some_and(|x| !is_bot_token(&x.token)));
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
            if let Some((tok, prof)) = profile_of(e).filter(|(t, _)| !is_bot_token(t)) {
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
        let winner = s.obj.last_winner.clone();
        let win_bonus = self.data.shop.objectives.win_bonus;
        for (k, f) in factions.iter_mut() {
            f.bonus = if f.pilots == min && min < max { self.data.shop.underdog_bonus } else { 0.0 };
            // last round's winning company keeps a small edge
            if winner.as_deref() == Some(k.as_str()) {
                f.bonus += win_bonus;
            }
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
    fn round_reset(&mut self, round: u64) {
        let (rows, _) = self.standings();
        let (company, scores) = self.objectives_round_end();
        let top: Vec<TopRow> = rows.iter().take(10).map(|r| r.1.clone()).collect();
        for e in self.ents.values() {
            let Some(eco) = e.player().and_then(|p| p.eco.as_ref()) else { continue };
            let rank = rows.iter().position(|r| r.0 == eco.token).map_or(0, |i| i as u32 + 1);
            let ep = rows.get(rank.saturating_sub(1) as usize).map_or(0.0, |r| r.1.ep);
            e.send(&ServerMsg::RoundEnd { rows: top.clone(), rank, pilots: rows.len() as u32, ep, company: company.clone(), scores: scores.clone() });
        }
        let champions: Vec<TopRow> = rows.iter().filter(|r| r.1.ep > 0.0).take(3).map(|r| r.1.clone()).collect();
        let text = if champions.is_empty() {
            "A new round begins! Everyone starts from scratch.".to_string()
        } else {
            let list: Vec<String> = champions.iter().enumerate().map(|(i, c)| format!("{}. {} ({} EP)", i + 1, c.n, big(c.ep))).collect();
            format!("Round over! Winners: {}. A new round begins - everyone starts from scratch.", list.join(", "))
        };
        let target = self.data.shop.objectives.win_score;
        let text = match &company {
            Some(c) if target > 0.0 && scores.get(c).is_some_and(|v| *v >= target) => {
                format!("{} reached {} beacon points and wins the round! {}", c.to_uppercase(), big(target), text)
            }
            Some(c) => format!("{} wins the round on beacon control! {}", c.to_uppercase(), text),
            None => text,
        };
        info!("season reset (round {}): {}", round, text);
        if let Some(s) = self.season.as_mut() {
            s.round = round;
            s.round_end = s.now() + s.period as f64;
            s.profiles.clear();
            s.champions = champions;
            s.boxes.retain(|b| b.kind == BoxKind::Bonus);
            s.dirty = true;
        }
        let ids: Vec<u32> = self.ents.values().filter(|e| e.player().is_some_and(|p| p.eco.is_some())).map(|e| e.id).collect();
        for id in ids {
            self.season_reset_pilot(id);
            if let Some(e) = self.ents.get(&id) {
                e.send(&ServerMsg::Chat { from: "SEASON".into(), text: text.clone() });
            }
        }
        // bots: scatter again instead of stacking on the station with every respawned human
        for i in 0..self.bots.len() {
            let (id, home) = (self.bots[i].id, self.bots[i].home);
            let Some(map) = self.ents.get(&id).map(|e| e.map) else { continue };
            let (x, y) = self.roam_point(map, home);
            if let Some(e) = self.ents.get_mut(&id) {
                (e.x, e.y) = (x, y);
            }
        }
        self.season_board();
        self.send_objectives();
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
        self.send_log(id, "New round: back in the Phoenix. Good luck, pilot!");
    }

    fn season_save(&mut self) {
        let online: Vec<(String, Profile)> = self.ents.values().filter_map(profile_of).filter(|(t, _)| !is_bot_token(t)).collect();
        let Some(s) = self.season.as_mut() else { return };
        s.dirty = false;
        let Some(path) = s.save_path.clone() else { return };
        let mut profiles = s.profiles.clone();
        profiles.extend(online);
        let file = SaveFile { round: s.round, end: s.round_end, profiles, champions: s.champions.clone(), obj: s.obj.clone() };
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
        d.shop.bonus_boxes.per_map = 0;
        d.shop.tiers = vec![
            crate::season::Tier { name: "Starter".into(), ships: vec!["ship_phoenix".into()] },
            crate::season::Tier { name: "Tier 2".into(), ships: vec!["ship_liberator".into()] },
        ];
        Arc::new(d)
    }

    fn world() -> World {
        let mut w = World::new(data());
        w.season = Some(SeasonState::new(None, 1800));
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

        // cheats are refused, the jump CPU too while under fire, unowned gear is rejected
        w.handle(id, ClientMsg::Cheat { god: Some(true), dmg_mult: Some(100.0) });
        w.ents.get_mut(&id).unwrap().since_hit = 0.0;
        w.handle(id, ClientMsg::Warp { map: 2 });
        assert!(!w.ents[&id].player().unwrap().god);
        assert_eq!(w.ents[&id].map, 1);
        w.handle(id, ClientMsg::Equip { config: 1, lasers: Some(vec!["lf4".into()]), gens: None, extras: None, drones: None, drone_design: None, laser_lvls: None, gen_lvls: None });
        assert_eq!(w.ents[&id].player().unwrap().configs[0].lasers, vec!["lf1"]);
        assert!(logs(&mut rx).contains("Equipment rejected"));

        // buy a Liberator (too expensive), then credits arrive and it works; out of combat = switch
        w.ents.get_mut(&id).unwrap().since_hit = 999.0;
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
        let def = w.ents[&npc].npc().unwrap().def;
        solo_kill(&mut w, id, def);
        let e = eco(&w, id);
        // eic and vru have no pilots yet, so mmo gets no underdog bonus
        assert_eq!(e.credits, 15_000.0 + 400.0 * 20.0);
        assert_eq!(e.uridium, 100.0);
        assert_eq!(e.stats.npc_kills, 1);
        assert!(logs(&mut rx).contains("You received 8,000 credits"));

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
        assert_eq!(u, 300.0);
        // the victim spilled 30% of its unspent credits into a cargo box
        assert_eq!(eco(&w, b).credits, 15_000.0 * 0.7);
        assert_eq!(w.season.as_ref().unwrap().boxes.len(), 1);
        assert_eq!(eco(&w, b).stats.deaths, 1);
        w.handle(b, ClientMsg::Revive);
        w.kill(b, a);
        assert_eq!(eco(&w, a).uridium, u);
        assert_eq!(eco(&w, a).stats.pvp_kills, 2);
    }

    #[test]
    fn underdog_bonus_and_round_reset() {
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
        // next round
        w.season.as_mut().unwrap().clock_offset = 1800.0;
        w.step(0.05);
        let s = w.season.as_ref().unwrap();
        assert_eq!(s.champions[0].n, "pilot");
        assert_eq!(s.champions[0].ep, 50_000.0);
        let e = &w.ents[&a];
        assert_eq!(e.map, 1, "sent home");
        assert_eq!(e.player().unwrap().exp, 0.0);
        assert_eq!(eco(&w, a).credits, 15_000.0);
        let l = logs(&mut rxv);
        assert!(l.contains("Winners") && l.contains("roundEnd"));
        let _ = v;
    }

    /// The pilot killed an alien alone, where it stands.
    fn solo_kill(w: &mut World, id: u32, def: usize) {
        let e = &w.ents[&id];
        let at = (e.map, e.x, e.y);
        w.reward(id, def, at, &HashMap::new());
    }

    #[test]
    fn company_kill_share() {
        let mut w = world();
        let (a, mut rxa) = join(&mut w, "token-share-a", "mmo");
        let (b, mut rxb) = join(&mut w, "token-share-b", "mmo");
        let (c, mut rxc) = join(&mut w, "token-share-c", "eic");
        let (d, _rxd) = join(&mut w, "token-share-d", "mmo");
        for (id, x) in [(a, 5000.0), (b, 5500.0), (c, 5200.0), (d, 9000.0)] {
            let e = w.ents.get_mut(&id).unwrap();
            (e.map, e.x, e.y) = (2, x, 5000.0);
        }
        let npc = *w.ents.keys().find(|k| w.ents[k].npc().is_some()).unwrap();
        let def = w.ents[&npc].npc().unwrap().def;
        let at = (2, 5000.0, 5000.0);
        // alone (b idle, c other company, d too far): the killer keeps everything
        solo_kill(&mut w, a, def);
        assert_eq!(eco(&w, a).credits, 23_000.0);
        assert_eq!(eco(&w, b).credits, 15_000.0);
        // b active nearby: a 70% + 15%, b 15%
        w.ents.get_mut(&b).unwrap().player_mut().unwrap().last_shot = w.time;
        solo_kill(&mut w, a, def);
        assert_eq!(eco(&w, a).credits, 23_000.0 + 6_800.0);
        assert_eq!(eco(&w, b).credits, 15_000.0 + 1_200.0);
        assert_eq!(eco(&w, c).credits, 15_000.0);
        assert_eq!(eco(&w, b).stats.npc_kills, 0);
        assert!(logs(&mut rxa).contains("hunt alone"));
        assert!(logs(&mut rxb).contains("Company share"));
        assert!(w.pvp_block(a, b).is_some());

        // c (other company) shot it too but a got the killing blow: a 70% + 10%, b and c 10% each
        let dmg = HashMap::from([(a, 300.0), (c, 100.0)]);
        let sh = w.kill_share(a, at, &dmg);
        let get = |id| sh.iter().find(|x| x.0 == id).map_or(0.0, |x| x.1);
        assert!((sh.iter().map(|x| x.1).sum::<f64>() - 1.0).abs() < 1e-9);
        assert!((get(a) - 0.8).abs() < 1e-9);
        assert!((get(b) - 0.1).abs() < 1e-9 && (get(c) - 0.1).abs() < 1e-9);
        assert_eq!(get(d), 0.0, "too far away");
        w.reward(a, def, at, &dmg);
        assert!(logs(&mut rxc).contains("killing blow"));
        assert_eq!(eco(&w, c).stats.npc_kills, 0);
        assert_eq!(eco(&w, a).stats.npc_kills, 3);

        // bots never take an area cut, only a slice for shooting
        {
            let e = w.ents.get_mut(&d).unwrap();
            e.x = 5300.0;
            let p = e.player_mut().unwrap();
            p.last_shot = w.time;
            p.eco.as_mut().unwrap().token = "bot:x".into();
        }
        assert!(w.kill_share(a, at, &dmg).iter().all(|x| x.0 != d));
    }

    #[test]
    fn jump_cpu_cooldown() {
        let mut w = world();
        let (id, mut rx) = join(&mut w, "token-warp1", "mmo");
        w.step(0.05);
        // never been to 4-1: refused
        w.handle(id, ClientMsg::Warp { map: 2 });
        assert_eq!(w.ents[&id].map, 1);
        assert!(logs(&mut rx).contains("already flown to"));
        // reached via the portal -> remembered
        {
            let e = w.ents.get_mut(&id).unwrap();
            (e.x, e.y) = (15000.0, 15000.0);
        }
        w.handle(id, ClientMsg::Jump);
        assert_eq!(w.ents[&id].map, 2);
        w.step(0.05);
        w.handle(id, ClientMsg::Warp { map: 1 });
        assert_eq!(w.ents[&id].map, 1);
        w.handle(id, ClientMsg::Warp { map: 2 });
        assert_eq!(w.ents[&id].map, 1, "cooldown");
        assert!(logs(&mut rx).contains("recharging"));
        w.time += WARP_COOLDOWN_SECS + 1.0;
        w.handle(id, ClientMsg::Warp { map: 2 });
        assert_eq!(w.ents[&id].map, 2);
        // dead pilots can't jump
        w.time += WARP_COOLDOWN_SECS + 1.0;
        w.ents.get_mut(&id).unwrap().player_mut().unwrap().dead = true;
        w.handle(id, ClientMsg::Warp { map: 1 });
        assert_eq!(w.ents[&id].map, 2);
    }

    #[test]
    fn bots_play_the_season_but_stay_off_the_board() {
        let mut w = world();
        w.spawn_bots(2);
        let bot = w.bots[0].id;
        let p = w.ents[&bot].player().unwrap();
        assert_eq!(p.ship, "ship_phoenix");
        assert!(p.eco.as_ref().unwrap().token.starts_with("bot:"));
        assert!(w.is_bot(bot));
        // once it can afford the next ship (here the Liberator) it buys it without docking
        w.bot_auto_upgrade(bot);
        assert_eq!(w.ents[&bot].player().unwrap().ship, "ship_phoenix", "can't afford 30k yet");
        // with money it buys the best-value upgrades and gets to the next ship along the way
        w.ents.get_mut(&bot).unwrap().player_mut().unwrap().eco.as_mut().unwrap().credits = 200_000.0;
        for _ in 0..15 {
            w.bot_auto_upgrade(bot);
        }
        assert_eq!(w.ents[&bot].player().unwrap().ship, "ship_liberator");
        let (rows, factions) = w.standings();
        assert!(rows.is_empty());
        assert_eq!(factions.values().map(|f| f.pilots).sum::<u32>(), 0);
    }

    #[test]
    fn beacons_capture_contest_and_win() {
        let mut w = world();
        let rule = crate::season::ObjectiveRule {
            radius: 1000.0,
            capture_secs: 10.0,
            points_per_sec: 1.0,
            capture_exp: 500.0,
            capture_uridium: 100.0,
            win_bonus: 0.1,
            win_score: 0.0,
            beacons: vec![crate::season::BeaconDef { map: "4-1".into(), x: 5000.0, y: 5000.0, weight: 2.0 }],
        };
        let data = w.data.clone();
        w.season.as_mut().unwrap().obj = Objectives::from_rule(&rule, &data);
        let mut d = (*w.data).clone();
        d.shop.objectives = rule;
        w.data = std::sync::Arc::new(d);
        let (a, _) = join(&mut w, "token-beac-a", "mmo");
        let (b, _) = join(&mut w, "token-beac-b", "eic");
        let put = |w: &mut World, id: u32, x: f64| {
            let e = w.ents.get_mut(&id).unwrap();
            (e.map, e.x, e.y) = (2, x, 5000.0);
        };
        let run = |w: &mut World, secs: f64| {
            for _ in 0..(secs * 20.0) as u32 {
                w.objectives_step(0.05);
            }
        };
        put(&mut w, a, 5200.0);
        run(&mut w, 10.5);
        let bc = &w.season.as_ref().unwrap().obj.beacons[0];
        assert_eq!(bc.owner.as_deref(), Some("mmo"));
        assert_eq!(w.ents[&a].player().unwrap().exp, 500.0, "capture reward");
        // contested: nothing moves, mmo keeps scoring (weight 2)
        put(&mut w, b, 4800.0);
        let before = w.season.as_ref().unwrap().obj.score["mmo"];
        run(&mut w, 5.0);
        let o = &w.season.as_ref().unwrap().obj;
        assert!(o.beacons[0].contested && o.beacons[0].cap == 1.0);
        assert!((o.score["mmo"] - before - 10.0).abs() < 0.2);
        // mmo leaves: eic drains it to neutral, then captures
        put(&mut w, a, 15000.0);
        run(&mut w, 10.5);
        assert_eq!(w.season.as_ref().unwrap().obj.beacons[0].owner, None);
        run(&mut w, 10.5);
        assert_eq!(w.season.as_ref().unwrap().obj.beacons[0].owner.as_deref(), Some("eic"));
        // mmo takes it back right away: owner changes, but no second reward within the cooldown
        put(&mut w, b, 15000.0);
        put(&mut w, a, 5200.0);
        run(&mut w, 21.0);
        assert_eq!(w.season.as_ref().unwrap().obj.beacons[0].owner.as_deref(), Some("mmo"));
        assert_eq!(w.ents[&a].player().unwrap().exp, 500.0, "capture reward cooldown");
        // a save with a different beacon layout doesn't carry scores over
        let mut moved = w.season.as_ref().unwrap().obj.clone();
        moved.beacons[0].x += 1.0;
        let mut fresh = Objectives::from_rule(&w.data.shop.objectives, &w.data);
        fresh.restore(&moved);
        assert!(fresh.score.is_empty() && fresh.beacons[0].owner.is_none());
        fresh.restore(&w.season.as_ref().unwrap().obj);
        assert_eq!(fresh.beacons[0].owner.as_deref(), Some("mmo"));
        // round end: the leader wins and gets the bonus next round; beacons reset
        let (win, scores) = w.objectives_round_end();
        assert_eq!(win.as_deref(), Some("mmo"));
        assert!(scores["mmo"] > scores.get("eic").copied().unwrap_or(0.0));
        let o = &w.season.as_ref().unwrap().obj;
        assert!(o.beacons[0].owner.is_none() && o.score.is_empty());
        let (_, factions) = w.standings();
        assert!(factions["mmo"].bonus >= 0.1);

        // reaching winScore ends the round on the spot, the next one runs the full length again
        let mut d = (*w.data).clone();
        d.shop.objectives.win_score = 100.0;
        w.data = std::sync::Arc::new(d);
        let (round, end) = (w.season.as_ref().unwrap().round, w.season.as_ref().unwrap().round_end);
        w.season.as_mut().unwrap().obj.score.insert("eic".into(), 100.0);
        w.step(0.05);
        let s = w.season.as_ref().unwrap();
        assert_eq!(s.round, round + 1);
        assert!(s.round_end >= end && s.obj.score.is_empty());
        assert_eq!(s.obj.last_winner.as_deref(), Some("eic"));
    }

    #[test]
    fn legacy_save_round_keeps_running_at_the_new_length() {
        let dir = std::env::temp_dir().join(format!("season-legacy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("save.json");
        // a save of the running 30 min UTC round, from before saves had an end time
        let round = round_of(now_secs(), LEGACY_PERIOD);
        std::fs::write(&path, format!(r#"{{"round":{},"profiles":{{}},"champions":[{{"n":"x","f":"mmo","ep":5.0}}],"obj":{{}}}}"#, round)).unwrap();
        let mut s = SeasonState::new(Some(path.clone()), 3600);
        s.load();
        assert_eq!(s.round, round);
        assert_eq!(s.round_end, (round * LEGACY_PERIOD + 3600) as f64);
        assert_eq!(s.champions.len(), 1, "same round: carried over");
        // a round that ended while the server was down: next round, full length
        std::fs::write(&path, format!(r#"{{"round":7,"end":{},"profiles":{{}},"champions":[],"obj":{{}}}}"#, now_secs() - 10.0)).unwrap();
        let mut s = SeasonState::new(Some(path), 3600);
        s.load();
        assert_eq!(s.round, 8);
        assert!(s.round_end > now_secs() + 3500.0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn upgrade_options_show_real_effects() {
        let mut w = world();
        let (id, _rx) = join(&mut w, "token-upg-1", "mmo");
        let opts = w.upgrade_options(id);
        // next tier ship, with its slots compared to the current ship
        let ship = opts.iter().find(|o| o.cat == "ship").expect("ship option");
        assert_eq!((ship.kind.as_str(), ship.id.as_str()), ("ship", "ship_liberator"));
        assert!(ship.desc.contains("4 lasers") && ship.hp > 0.0);
        // a better laser replaces the LF-1: positive damage, priced
        let laser = opts.iter().find(|o| o.cat == "laser").expect("laser option");
        assert!(laser.dmg > 0.0 && laser.c > 0.0);
        // tech is listed (P.E.T. adds damage)
        assert!(opts.iter().any(|o| o.cat == "tech" && o.id == "pet" && o.dmg > 0.0));
        // speed gens are offered and show their gain on the speed config
        if let Some(sp) = opts.iter().find(|o| o.cat == "speed") {
            assert!(sp.spd > 0.0 && sp.value > 0.0, "{:?}", sp);
        }
        w.ents.get_mut(&id).unwrap().player_mut().unwrap().eco.as_mut().unwrap().credits = 1e6;
        assert!(w.affordable_upgrades(id) > 0);
    }

    #[test]
    fn ship_switch_anywhere_but_not_under_fire() {
        let mut w = world();
        let (id, mut rx) = join(&mut w, "token-sw-1", "mmo");
        {
            let e = w.ents.get_mut(&id).unwrap();
            (e.map, e.x, e.y) = (2, 8000.0, 8000.0); // far from any station
            e.hp = e.mhp / 2.0;
            e.player_mut().unwrap().eco.as_mut().unwrap().credits = 1e6;
            e.since_hit = 0.0; // under fire
        }
        w.handle(id, ClientMsg::Buy { kind: "ship".into(), id: "ship_liberator".into(), qty: 1 });
        assert_eq!(w.ents[&id].player().unwrap().ship, "ship_phoenix", "not mid-fight");
        assert!(logs(&mut rx).contains("out of combat"));
        // out of combat: the pending switch happens, hp keeps its ratio (no free heal)
        w.ents.get_mut(&id).unwrap().since_hit = 20.0;
        w.tick = 19;
        w.step(0.05);
        let e = &w.ents[&id];
        assert_eq!(e.player().unwrap().ship, "ship_liberator");
        assert!((e.hp / e.mhp - 0.5).abs() < 0.01, "hp ratio kept: {}/{}", e.hp, e.mhp);
    }

    #[test]
    fn dmz_keeps_aliens_off_resting_pilots() {
        let mut w = world();
        let (id, _rx) = join(&mut w, "token-dmz-1", "mmo");
        let npc = *w.ents.keys().find(|k| w.ents[k].npc().is_some()).unwrap();
        // pilot at the 1-1 portal, alien right next to it and locked on
        {
            let e = w.ents.get_mut(&id).unwrap();
            (e.map, e.x, e.y) = (1, 15000.0, 15200.0);
            let n = w.ents.get_mut(&npc).unwrap();
            (n.map, n.x, n.y) = (1, 15100.0, 15200.0);
            n.target = Some(id);
            n.attacking = true;
        }
        let hp = (w.ents[&id].hp, w.ents[&id].sh);
        w.try_laser(npc);
        assert_eq!((w.ents[&id].hp, w.ents[&id].sh), hp, "protected in the DMZ");
        assert!(!w.ents[&npc].attacking, "alien gives up");
        // shooting from the DMZ ends the protection
        w.ents.get_mut(&id).unwrap().player_mut().unwrap().last_shot = w.time;
        assert!(!w.alien_proof(&w.ents[&id]));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoxKind {
    /// Random DO bonus box (respawns).
    Bonus,
    /// Loot spilled by a destroyed pilot (expires).
    Cargo,
}

pub struct LootBox {
    pub id: u32,
    pub map: u32,
    pub x: f64,
    pub y: f64,
    pub kind: BoxKind,
    pub credits: f64,
    pub uridium: f64,
    /// MCB-25 (x2) rounds.
    pub ammo: u64,
    /// Expires at this world time (cargo); bonus boxes live forever.
    pub until: f64,
}

/// The ship has to be on top of a box to collect it (DarkOrbit).
const PICKUP_RANGE: f64 = 60.0;

impl World {
    #[allow(clippy::too_many_arguments)]
    fn spawn_box(&mut self, map: u32, x: f64, y: f64, kind: BoxKind, credits: f64, uridium: f64, ammo: u64, life: f64) {
        let id = self.alloc_id();
        let until = if kind == BoxKind::Cargo { self.time + life } else { f64::INFINITY };
        if let Some(s) = self.season.as_mut() {
            s.boxes.push(LootBox { id, map, x, y, kind, credits, uridium, ammo, until });
        }
    }

    /// Keep each map stocked with bonus boxes, expire cargo, hand boxes to pilots flying over them.
    pub(super) fn boxes_step(&mut self) {
        let data = self.data.clone();
        let rule = &data.shop.bonus_boxes;
        let now = self.time;
        let Some(s) = self.season.as_mut() else { return };
        s.boxes.retain(|b| b.until > now);
        // refill bonus boxes (once per second is plenty)
        if self.tick % 20 == 0 && rule.per_map > 0 {
            s.box_respawn.retain(|(_, at)| *at > now);
            let mut want: Vec<(u32, u32)> = vec![];
            for m in &data.maps {
                if m.npcs.is_empty() {
                    continue;
                }
                let have = s.boxes.iter().filter(|b| b.map == m.id && b.kind == BoxKind::Bonus).count() as u32;
                let pending = s.box_respawn.iter().filter(|(mm, _)| *mm == m.id).count() as u32;
                let n = rule.per_map.saturating_sub(have + pending);
                if n > 0 {
                    want.push((m.id, n));
                }
            }
            for (map, n) in want {
                let Some(m) = data.map(map) else { continue };
                let tier = map_tier(&m.name);
                for _ in 0..n {
                    let (x, y) = (self.rng.gen_range(m.w * 0.05..m.w * 0.95), self.rng.gen_range(m.h * 0.05..m.h * 0.95));
                    let roll: f64 = self.rng.gen();
                    let k = self.rng.gen_range(0.6..1.4) * tier;
                    let (c, u, a) = if roll < 0.6 {
                        ((rule.credits * k).round(), 0.0, 0)
                    } else if roll < 0.85 {
                        (0.0, (rule.uridium * k).round(), 0)
                    } else {
                        (0.0, 0.0, (rule.ammo as f64 * k).round() as u64)
                    };
                    self.spawn_box(map, x, y, BoxKind::Bonus, c, u, a, 0.0);
                }
            }
        }
        // pickups
        let s = self.season.as_ref().unwrap();
        let pilots: Vec<(u32, u32, f64, f64)> = self
            .ents
            .values()
            // bots don't take boxes: they roam the starter maps where newcomers spawn
            .filter(|e| e.alive() && e.player().and_then(|p| p.eco.as_ref()).is_some_and(|x| !is_bot_token(&x.token)))
            .map(|e| (e.id, e.map, e.x, e.y))
            .collect();
        let mut taken: Vec<(usize, u32)> = vec![];
        if !pilots.is_empty() {
            for (i, b) in s.boxes.iter().enumerate() {
                let who = pilots.iter().find(|(_, m, x, y)| *m == b.map && dist(*x, *y, b.x, b.y) <= PICKUP_RANGE);
                if let Some((w, ..)) = who {
                    taken.push((i, *w));
                }
            }
        }
        for (i, who) in taken.into_iter().rev() {
            let s = self.season.as_mut().unwrap();
            let b = s.boxes.remove(i);
            if b.kind == BoxKind::Bonus {
                s.box_respawn.push((b.map, now + rule.respawn.max(5.0)));
            }
            self.broadcast(b.map, &ServerMsg::Pickup { x: b.x.round(), y: b.y.round(), by: who, cargo: b.kind == BoxKind::Cargo });
            let mut b = b;
            let jackpot = b.kind == BoxKind::Bonus && rule.jackpot_mult > 1.0 && self.rng.gen_bool(rule.jackpot.clamp(0.0, 1.0));
            if jackpot {
                (b.credits, b.uridium) = ((b.credits * rule.jackpot_mult).round(), (b.uridium * rule.jackpot_mult).round());
                b.ammo = (b.ammo as f64 * rule.jackpot_mult) as u64;
            }
            let Some(eco) = self.ents.get_mut(&who).and_then(|e| e.player_mut()).and_then(|p| p.eco.as_mut()) else { continue };
            eco.credits += b.credits;
            eco.uridium += b.uridium;
            eco.stats.earned_c += b.credits;
            eco.stats.earned_u += b.uridium;
            if b.ammo > 0 {
                *eco.ammo.entry("x2".into()).or_default() += b.ammo;
            }
            let what = [(b.credits, "credits"), (b.uridium, "uridium")]
                .iter()
                .filter(|(v, _)| *v > 0.0)
                .map(|(v, w)| format!("{} {}", big(*v), w))
                .chain((b.ammo > 0).then(|| format!("{} MCB-25", big(b.ammo as f64))))
                .collect::<Vec<_>>()
                .join(" + ");
            let label = if b.kind == BoxKind::Cargo { "cargo box" } else { "bonus box" };
            self.send_log(who, &format!("{}You collected a {}: {}", if jackpot { "JACKPOT! " } else { "" }, label, what));
            if b.kind == BoxKind::Cargo {
                info!("player {} picked up a cargo box ({})", who, what);
            }
        }
    }

    /// Boxes on `map` as state entities (`k: "b"`).
    pub(super) fn box_states(&self, map: u32) -> Vec<EntState> {
        let Some(s) = self.season.as_ref() else { return vec![] };
        s.boxes
            .iter()
            .filter(|b| b.map == map)
            .map(|b| EntState {
                id: b.id,
                k: "b",
                n: if b.kind == BoxKind::Cargo { "Cargo".into() } else { String::new() },
                s: if b.kind == BoxKind::Cargo { "box_cargo".into() } else { "box_bonus".into() },
                x: b.x.round(),
                y: b.y.round(),
                a: 0.0,
                hp: 0.0,
                mhp: 0.0,
                sh: 0.0,
                msh: 0.0,
                f: String::new(),
                tg: None,
                atk: false,
                dr: vec![],
                dd: None,
                fm: None,
            })
            .collect()
    }

}

impl World {
    /// Season bots: same start and rules as players (so they don't out-gear newcomers on the
    /// starter maps); they buy their next upgrade on their own.
    pub(super) fn season_bot_setup(&mut self, id: u32) {
        let data = self.data.clone();
        let Some(e) = self.ents.get_mut(&id) else { return };
        let token = format!("bot:{}:{}", id, e.name);
        let Some(p) = e.player_mut() else { return };
        reset_player(&data, p, &token);
        Self::apply_ship(&data, e, true);
    }

    pub(super) fn bot_auto_upgrade(&mut self, id: u32) {
        if !self.ents.get(&id).is_some_and(|e| e.alive()) {
            return;
        }
        let Some(o) = self.bot_pick_upgrade(id) else { return };
        if o.kind == "switch" {
            self.season_ship(id, &o.id, None);
        } else {
            self.season_buy(id, &o.kind, &o.id, 1);
        }
    }
}
