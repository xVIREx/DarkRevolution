//! Authoritative world state and the 20 Hz simulation step.

use crate::ai::{self, PlayerPos};
use crate::combat::{self, dist};
use crate::data::{Data, Ship};
use crate::equipment::{self, EquipConfig, Loadout, Stats};
use crate::protocol::{ClientMsg, EntState, SeasonYou, ServerMsg, YouMsg};
use crate::season::Eco;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info};

mod behavior;
mod bots;
mod objectives;
mod season;
mod upgrades;

pub use season::SeasonState;

pub const TICK_HZ: f64 = 20.0;
/// Max distance at which entities are included in a player's state snapshot
/// (the client's farthest zoom on a wide screen sees ~5000 units).
pub const VIEW_RADIUS: f64 = 6000.0;
pub const INFINITE: f64 = 1e15;
const YOU_INTERVAL: f64 = 1.0;
const REGEN_DELAY: f64 = 5.0;
const SHIELD_REGEN: f64 = 0.05; // fraction of max per second
const PLAYER_MISS: f64 = 0.05;
const NPC_MISS: f64 = 0.15;
/// PIB-100 infection (wiki Plague debuff): +10% damage taken, -10% speed, 15 min.
const INFECTION_DAMAGE: f64 = 0.10;
const INFECTION_SPEED: f64 = 0.10;
const INFECTION_TIME: f64 = 900.0;

pub type Tx = mpsc::Sender<String>;

pub struct PlayerData {
    pub tx: Tx,
    pub ship: String,
    pub design: Option<String>,
    pub ammo: String,
    pub rocket: String,
    pub exp: f64,
    pub honor: f64,
    pub god: bool,
    pub dmg_mult: f64,
    pub dead: bool,
    pub configs: [EquipConfig; 2],
    /// Active config index (0 = config 1).
    pub cfg: usize,
    pub cfg_cd: f64,
    pub stats: Stats,
    /// Active drone formation and boosters.
    pub loadout: Loadout,
    /// Seconds until the next overdrive round (Prometheus-type lasers).
    pub od_timer: f64,
    /// IDB-125 ramp multiplier and idle time.
    pub idb_mult: f64,
    pub idb_idle: f64,
    pub rsb_cd: f64,
    /// Daily season wallet/inventory; `None` = sandbox player (everything free) or bot.
    pub eco: Option<Box<Eco>>,
    /// World time of the last hit on an alien (company kill shares need recent activity).
    pub last_alien_hit: f64,
    /// World time this player last fired (lasers or rockets); shooting ends DMZ protection.
    pub last_shot: f64,
    /// World time the Upgrades panel last asked for options (pushes stop once it closes).
    pub upgrades_req: f64,
    last_you: Option<YouMsg>,
    you_timer: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Normal,
    /// Released by a mothership (`spawns`); circles it and attacks its top attacker.
    Minion,
    /// Spawned with a leader (`escorts`); follows it and defends it.
    Escort,
}

pub struct NpcData {
    pub def: usize,
    pub home: (f64, f64),
    pub wander_timer: f64,
    pub damage: f64,
    pub damage_min: f64,
    pub damage_max: f64,
    pub aggressive: bool,
    pub calm: f64,
    pub stationary: bool,
    pub no_attack: bool,
    pub role: Role,
    /// Mothership / leader id while it is alive.
    pub owner: Option<u32>,
    /// Was spawned as part of a group (minion/escort): never respawns on its own.
    pub respawns: bool,
    /// Damage taken per player (for "top attacker" targeting); cleared when out of combat.
    pub attackers: HashMap<u32, f64>,
    /// Continuous time in combat (for spawn triggers).
    pub combat_time: f64,
    pub spawn_cd: f64,
    /// Kamikaze countdown once armed.
    pub kamikaze: Option<f64>,
    /// Formation / orbit angle around the owner.
    pub orbit: f64,
}

impl NpcData {
    pub fn top_attacker(&self) -> Option<u32> {
        self.attackers.iter().max_by(|a, b| a.1.total_cmp(b.1)).map(|(id, _)| *id)
    }
}

pub enum Kind {
    Player(Box<PlayerData>),
    Npc(NpcData),
}

pub struct Entity {
    pub id: u32,
    pub name: String,
    pub sheet: String,
    pub faction: String,
    pub map: u32,
    pub x: f64,
    pub y: f64,
    pub a: f64,
    pub hp: f64,
    pub mhp: f64,
    pub sh: f64,
    pub msh: f64,
    /// Fraction of damage the shield absorbs.
    pub absorb: f64,
    pub speed: f64,
    pub target: Option<u32>,
    pub attacking: bool,
    pub dest: Option<(f64, f64)>,
    pub laser_cd: f64,
    pub rocket_cd: f64,
    /// Seconds since this entity last took damage.
    pub since_hit: f64,
    /// Remaining slow debuff (seconds) and the speed cap while it lasts.
    pub slow_left: f64,
    pub slow_speed: f64,
    /// PIB-100 infection (players only): seconds left.
    pub infected_left: f64,
    pub kind: Kind,
}

impl Entity {
    pub fn is_player(&self) -> bool {
        matches!(self.kind, Kind::Player(_))
    }
    pub fn alive(&self) -> bool {
        match &self.kind {
            Kind::Player(p) => !p.dead,
            Kind::Npc(_) => self.hp > 0.0,
        }
    }
    fn player(&self) -> Option<&PlayerData> {
        match &self.kind {
            Kind::Player(p) => Some(p),
            _ => None,
        }
    }
    fn player_mut(&mut self) -> Option<&mut PlayerData> {
        match &mut self.kind {
            Kind::Player(p) => Some(p),
            _ => None,
        }
    }
    pub fn npc(&self) -> Option<&NpcData> {
        match &self.kind {
            Kind::Npc(n) => Some(n),
            _ => None,
        }
    }
    fn npc_mut(&mut self) -> Option<&mut NpcData> {
        match &mut self.kind {
            Kind::Npc(n) => Some(n),
            _ => None,
        }
    }
    /// Effective movement speed (slow debuffs applied).
    fn move_speed(&self) -> f64 {
        let s = if self.infected_left > 0.0 { self.speed * (1.0 - INFECTION_SPEED) } else { self.speed };
        if self.slow_left > 0.0 {
            s.min(self.slow_speed)
        } else {
            s
        }
    }
    fn send(&self, msg: &ServerMsg) {
        if let Some(p) = self.player() {
            let _ = p.tx.try_send(msg.json());
        }
    }
    fn send_raw(&self, json: &str) {
        if let Some(p) = self.player() {
            let _ = p.tx.try_send(json.to_owned());
        }
    }
    fn to_state(&self) -> EntState {
        EntState {
            id: self.id,
            k: if self.is_player() { "p" } else { "n" },
            n: self.name.clone(),
            s: self.sheet.clone(),
            x: round1(self.x),
            y: round1(self.y),
            a: (self.a * 1000.0).round() / 1000.0,
            hp: self.hp.max(0.0).round(),
            mhp: self.mhp.round(),
            sh: self.sh.max(0.0).round(),
            msh: self.msh.round(),
            f: self.faction.clone(),
            tg: self.target,
            atk: self.attacking,
            dr: self
                .player()
                .map(|p| p.configs[p.cfg].drones.iter().map(|d| d.kind.clone()).collect())
                .unwrap_or_default(),
            dd: self.player().and_then(|p| {
                let c = &p.configs[p.cfg];
                c.drone_design.clone().filter(|_| !c.drones.is_empty())
            }),
            fm: self
                .player()
                .filter(|p| !p.configs[p.cfg].drones.is_empty())
                .map(|p| p.loadout.formation.clone()),
        }
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Per-round side effects of special ammo.
#[derive(Default)]
struct RoundExtra {
    overdrive: bool,
    drain: f64,
    infect: bool,
    ramp: Option<(f64, f64)>,
}

struct Respawn {
    at: f64,
    map: u32,
    def: usize,
}

pub struct World {
    pub data: Arc<Data>,
    pub ents: BTreeMap<u32, Entity>,
    pub tick: u64,
    next_id: u32,
    time: f64,
    respawns: Vec<Respawn>,
    rng: StdRng,
    bots: Vec<bots::Bot>,
    /// Map-wide broadcasts queued during this tick / message handling.
    pending: Vec<(u32, String)>,
    /// Daily season (data/shop.json); `None` = free sandbox.
    pub season: Option<SeasonState>,
}

impl World {
    pub fn new(data: Arc<Data>) -> World {
        let mut w = World {
            data,
            ents: BTreeMap::new(),
            tick: 0,
            next_id: 1,
            time: 0.0,
            respawns: vec![],
            rng: StdRng::from_entropy(),
            bots: vec![],
            pending: vec![],
            season: None,
        };
        w.season = SeasonState::from_env(&w.data);
        let data = w.data.clone();
        let mut total = 0;
        for m in &data.maps {
            for spawn in &m.npcs {
                let Some(def) = data.npc_index(&spawn.id) else {
                    debug!("map {}: unknown npc '{}'", m.name, spawn.id);
                    continue;
                };
                for _ in 0..spawn.count {
                    w.spawn_npc(m.id, def);
                    total += 1;
                }
            }
        }
        info!("spawned {} NPCs on {} maps", total, data.maps.len());
        w
    }

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Spawn a free NPC at a random position (plus its escorts, if it has any).
    fn spawn_npc(&mut self, map: u32, def: usize) -> Option<u32> {
        let m = self.data.map(map)?;
        let margin = 300.0_f64.min(m.w / 4.0).min(m.h / 4.0);
        let (w, h) = (m.w, m.h);
        let x = self.rng.gen_range(margin..(w - margin).max(margin + 1.0));
        let y = self.rng.gen_range(margin..(h - margin).max(margin + 1.0));
        let id = self.spawn_npc_at(map, def, x, y, Role::Normal, None)?;
        self.spawn_escorts(id);
        Some(id)
    }

    fn spawn_npc_at(&mut self, map: u32, def: usize, x: f64, y: f64, role: Role, owner: Option<u32>) -> Option<u32> {
        let data = self.data.clone();
        let d = data.npcs.get(def)?;
        let (w, h) = data.map(map).map(|m| (m.w, m.h))?;
        let (x, y) = (x.clamp(0.0, w), y.clamp(0.0, h));
        let id = self.alloc_id();
        let wander = self.rng.gen_range(0.0..5.0);
        let orbit = self.rng.gen_range(0.0..std::f64::consts::TAU);
        let b = &d.behavior;
        self.ents.insert(
            id,
            Entity {
                id,
                name: d.name.clone(),
                sheet: d.sheet.clone(),
                faction: "npc".into(),
                map,
                x,
                y,
                a: self.rng.gen_range(0.0..std::f64::consts::TAU),
                hp: d.hp.max(1.0),
                mhp: d.hp.max(1.0),
                sh: d.shield.max(0.0),
                msh: d.shield.max(0.0),
                absorb: d.absorb(),
                speed: if b.stationary { 0.0 } else { d.speed.max(0.0) },
                target: None,
                attacking: false,
                dest: None,
                laser_cd: 0.0,
                rocket_cd: 0.0,
                since_hit: 999.0,
                slow_left: 0.0,
                slow_speed: 0.0,
                infected_left: 0.0,
                kind: Kind::Npc(NpcData {
                    def,
                    home: (x, y),
                    wander_timer: wander,
                    damage: d.damage,
                    damage_min: d.damage_min,
                    damage_max: d.damage_max,
                    aggressive: d.aggressive,
                    calm: 0.0,
                    stationary: b.stationary,
                    no_attack: b.no_attack || (d.damage <= 0.0 && d.damage_max <= 0.0),
                    role,
                    owner,
                    respawns: role == Role::Normal,
                    attackers: HashMap::new(),
                    combat_time: 0.0,
                    spawn_cd: 0.0,
                    kamikaze: None,
                    orbit,
                }),
            },
        );
        Some(id)
    }

    /// Faction home: the faction's `x-1` map (or any map it owns), at its station.
    pub fn home(&self, faction: &str) -> (u32, f64, f64) {
        let maps = &self.data.maps;
        let has_station = |m: &&crate::data::MapDef| m.stations.iter().any(|s| s.faction == faction);
        let m = maps
            .iter()
            .filter(|m| m.faction == faction && m.name.ends_with("-1"))
            .find(has_station)
            .or_else(|| maps.iter().filter(|m| m.faction == faction).find(has_station))
            .or_else(|| maps.iter().find(|m| m.faction == faction))
            .or_else(|| maps.iter().find(has_station))
            .unwrap_or(&maps[0]);
        let (x, y) = m
            .stations
            .iter()
            .find(|s| s.faction == faction)
            .or(m.stations.first())
            .map(|s| (s.x, s.y))
            .unwrap_or((m.w / 2.0, m.h / 2.0));
        (m.id, x, y)
    }

    fn default_ship(&self) -> String {
        // best all-round ship (top-tier damage with the most HP/shield of the high-damage ships)
        self.data
            .ship("ship_hecate-plus")
            .or_else(|| self.data.ship("ship_goliath"))
            .unwrap_or(&self.data.ships[0])
            .id
            .clone()
    }

    fn ship_of<'a>(data: &'a Data, p: &PlayerData) -> &'a Ship {
        data.ship(&p.ship).unwrap_or(&data.ships[0])
    }

    /// Recompute equipment-derived stats of the active config. `full` refills hp and shield;
    /// otherwise hp is clamped and the shield keeps its fill ratio.
    fn apply_ship(data: &Data, e: &mut Entity, full: bool) {
        let Kind::Player(p) = &mut e.kind else { return };
        let ship = Self::ship_of(data, p);
        let mut stats = equipment::compute_stats(ship, &data.items, &p.configs[p.cfg], &p.loadout);
        equipment::fill_ammo_rows(&mut stats, &data.lasers.ammo);
        e.sheet = ship.sheet_for(p.design.as_deref());
        let sh_ratio = if e.msh > 0.0 { e.sh / e.msh } else { 1.0 };
        e.mhp = stats.hp;
        e.msh = stats.shield;
        e.absorb = stats.absorb;
        e.speed = stats.speed;
        p.stats = stats;
        if full {
            e.hp = e.mhp;
            e.sh = e.msh;
        } else {
            e.hp = e.hp.min(e.mhp);
            e.sh = (e.msh * sh_ratio).min(e.msh);
        }
    }

    /// Fraction of generator slots holding speed generators (legacy `you.speedGens`).
    fn speed_gen_fraction(data: &Data, p: &PlayerData) -> f64 {
        let gens = &p.configs[p.cfg].gens;
        if gens.is_empty() {
            return 0.0;
        }
        gens.iter().filter(|g| data.items.speed_gen(g).is_some()).count() as f64 / gens.len() as f64
    }

    pub fn login(&mut self, tx: Tx, name: &str, faction: &str) -> u32 {
        self.login_token(tx, name, faction, None)
    }

    /// Log in; in the daily season `token` identifies the pilot's saved progress (bots and
    /// sandbox players ignore it).
    pub fn login_token(&mut self, tx: Tx, name: &str, faction: &str, token: Option<&str>) -> u32 {
        let connected = !tx.is_closed(); // bots log in with a dead outbox
        let mut faction = match faction.to_lowercase().as_str() {
            f @ ("mmo" | "eic" | "vru") => f.to_string(),
            _ => "mmo".to_string(),
        };
        let season = if connected { self.season_identity(token) } else { None };
        if let Some((_, Some(p))) = &season {
            faction = p.faction.clone(); // one company per day
        }
        let id = self.alloc_id();
        let mut name: String = name.trim().chars().filter(|c| !c.is_control()).take(20).collect();
        if name.is_empty() {
            name = format!("Pilot{}", id);
        }
        let (map, x, y) = self.home(&faction);
        let ammo = self.data.lasers.ammo[0].id.clone();
        let rocket = self.data.lasers.rockets[0].id.clone();
        let ship_id = self.default_ship();
        let configs = equipment::default_configs(self.data.ship(&ship_id).unwrap(), &self.data.items);
        let mut e = Entity {
            id,
            name: name.clone(),
            sheet: String::new(),
            faction: faction.clone(),
            map,
            x,
            y,
            a: 0.0,
            hp: 1.0,
            mhp: 1.0,
            sh: 0.0,
            msh: 0.0,
            absorb: combat::SHIELD_ABSORB,
            speed: 0.0,
            target: None,
            attacking: false,
            dest: None,
            laser_cd: 0.0,
            rocket_cd: 0.0,
            since_hit: 999.0,
            slow_left: 0.0,
            slow_speed: 0.0,
            infected_left: 0.0,
            kind: Kind::Player(Box::new(PlayerData {
                tx,
                ship: ship_id,
                design: None,
                ammo,
                rocket,
                exp: 0.0,
                honor: 0.0,
                god: false,
                dmg_mult: 1.0,
                dead: false,
                configs,
                cfg: 0,
                cfg_cd: 0.0,
                stats: Stats::default(),
                loadout: Loadout::best(&self.data.items),
                od_timer: 0.0,
                idb_mult: 1.0,
                idb_idle: 0.0,
                rsb_cd: 0.0,
                eco: None,
                last_alien_hit: -1e9,
                last_shot: -1e9,
                upgrades_req: -1e9,
                last_you: None,
                you_timer: 0.0,
            })),
        };
        if let Some((tok, profile)) = season {
            self.season_setup(&mut e, tok, profile);
        }
        Self::apply_ship(&self.data, &mut e, true);
        e.send(&ServerMsg::Welcome { id });
        self.send_map(&e);
        self.ents.insert(id, e);
        self.send_you(id, true);
        if connected {
            info!("player {} '{}' ({}) joined map {}", id, name, faction, map);
        }
        self.send_log(id, &format!("Welcome, {}!", name));
        self.season_welcome(id);
        id
    }

    pub fn remove(&mut self, id: u32) {
        if let Some(e) = self.ents.remove(&id) {
            info!("player {} '{}' left", id, e.name);
            self.season_store(&e);
            self.clear_targeting(id);
        }
    }

    /// Player inside a portal/station DMZ who hasn't fired recently: aliens can't attack them
    /// (arriving through a portal or warping lands you in one).
    pub(crate) fn alien_proof(&self, e: &Entity) -> bool {
        let Some(p) = e.player() else { return false };
        if self.time - p.last_shot < combat::DMZ_CALM {
            return false;
        }
        let Some(m) = self.data.map(e.map) else { return false };
        m.portals.iter().any(|q| dist(e.x, e.y, q.x, q.y) <= combat::PORTAL_DMZ)
            || m.stations.iter().any(|s| dist(e.x, e.y, s.x, s.y) <= combat::STATION_DMZ)
    }

    fn clear_targeting(&mut self, id: u32) {
        for e in self.ents.values_mut() {
            if e.target == Some(id) {
                e.target = None;
                e.attacking = false;
            }
        }
    }

    fn send_map(&self, e: &Entity) {
        if let Some(m) = self.data.map(e.map) {
            e.send(&ServerMsg::Map { map: &m.raw });
        }
    }

    fn send_log(&self, id: u32, text: &str) {
        if let Some(e) = self.ents.get(&id) {
            e.send(&ServerMsg::Log { text: text.to_string() });
        }
    }

    fn you_of(data: &Data, e: &Entity, ctx: Option<(u64, f64, bool, f64)>, protected: bool) -> Option<YouMsg> {
        let p = e.player()?;
        let ship = Self::ship_of(data, p);
        let season = p.eco.as_ref().zip(ctx).map(|(eco, (reset_at, bonus, safe, now))| SeasonYou {
            reset_at,
            bonus,
            ships: eco.ships.iter().cloned().collect(),
            items: eco.items.clone(),
            levels: eco.levels.clone(),
            unlocks: eco.unlocks.iter().cloned().collect(),
            ammo: eco.ammo.clone(),
            pilot: crate::season::pilot_view(&eco.stats),
            rank: eco.rank,
            safe,
            affordable: eco.affordable,
            round_minutes: (data.shop.round_secs() / 60) as f64,
            visited: eco.visited.iter().copied().collect(),
            warp_cd: (eco.warp_ready - now).max(0.0).ceil(),
        });
        Some(YouMsg {
            ship: p.ship.clone(),
            design: p.design.clone(),
            speed: e.speed,
            ammo: p.ammo.clone(),
            credits: p.eco.as_ref().map_or(INFINITE, |x| x.credits.floor()),
            uridium: p.eco.as_ref().map_or(INFINITE, |x| x.uridium.floor()),
            exp: p.exp,
            honor: p.honor,
            level: combat::level_for_exp(p.exp),
            god: p.god,
            dmg_mult: p.dmg_mult,
            speed_gens: Self::speed_gen_fraction(data, p),
            id: e.id,
            map: e.map,
            rocket: p.rocket.clone(),
            dead: p.dead,
            cfg: p.cfg as u8 + 1,
            configs: p.configs.clone(),
            slots: equipment::slots(ship, &data.items),
            stats: p.stats.clone(),
            cfg_cd: p.cfg_cd.ceil(),
            protected,
            faction: e.faction.clone(),
            season,
        })
    }

    /// Send `you` if it changed (or `force`).
    fn send_you(&mut self, id: u32, force: bool) {
        let ctx = self.season_you_ctx(id);
        let protected = self.ents.get(&id).is_some_and(|e| self.alien_proof(e));
        let Some(e) = self.ents.get_mut(&id) else { return };
        let Some(you) = Self::you_of(&self.data, e, ctx, protected) else { return };
        let p = e.player_mut().unwrap();
        if force || p.last_you.as_ref() != Some(&you) || p.you_timer >= YOU_INTERVAL {
            let _ = p.tx.try_send(ServerMsg::You(&you).json());
            p.last_you = Some(you);
            p.you_timer = 0.0;
        }
    }

    fn broadcast(&mut self, map: u32, msg: &ServerMsg) {
        self.pending.push((map, msg.json()));
    }

    // ------------------------------------------------------------------ messages

    pub fn handle(&mut self, id: u32, msg: ClientMsg) {
        let data = self.data.clone();
        if self.season_gate(id, &msg) {
            self.send_you(id, false);
            return;
        }
        let Some(e) = self.ents.get_mut(&id) else { return };
        let dead = e.player().map(|p| p.dead).unwrap_or(true);
        match msg {
            ClientMsg::Login { .. } | ClientMsg::Buy { .. } | ClientMsg::AutoEquip | ClientMsg::Upgrades => {}
            ClientMsg::Move { x, y } => {
                if dead || !x.is_finite() || !y.is_finite() {
                    return;
                }
                let m = data.map(e.map);
                let (w, h) = m.map(|m| (m.w, m.h)).unwrap_or((21000.0, 13100.0));
                e.dest = Some((x.clamp(0.0, w), y.clamp(0.0, h)));
            }
            ClientMsg::Select { id: tid } => {
                let valid = tid.filter(|t| {
                    *t != id && self.ents.get(t).map(|o| o.alive() && o.map == self.ents[&id].map).unwrap_or(false)
                });
                let e = self.ents.get_mut(&id).unwrap();
                if e.target != valid {
                    e.attacking = false;
                }
                e.target = valid;
            }
            ClientMsg::Attack { on } => {
                e.attacking = on && e.target.is_some() && !dead;
            }
            ClientMsg::Ammo { id: ammo } => {
                if data.ammo(&ammo).is_some() {
                    e.player_mut().unwrap().ammo = ammo;
                }
            }
            ClientMsg::Rocket { id: rocket } => {
                if let Some(r) = rocket.filter(|r| data.rocket(r).is_some()) {
                    e.player_mut().unwrap().rocket = r;
                }
                if !dead {
                    self.fire_rocket(id, false);
                }
            }
            ClientMsg::Ship { ship, design } => {
                let Some(s) = data.ship(&ship) else {
                    self.send_log(id, &format!("Unknown ship '{}'", ship));
                    return;
                };
                let design = design.filter(|d| !d.is_empty() && *d != s.id);
                if let Some(d) = &design {
                    if !s.designs.iter().any(|x| &x.id == d) {
                        self.send_log(id, &format!("Unknown design '{}' for {}", d, s.name));
                        return;
                    }
                }
                let p = e.player_mut().unwrap();
                if p.ship != ship {
                    p.configs = equipment::default_configs(s, &data.items);
                }
                p.ship = ship;
                p.design = design;
                Self::apply_ship(&data, e, true);
            }
            ClientMsg::Config { .. } => {
                // Deprecated: speed/shield now come from equipped generators (`equip`).
                self.send_log(id, "Use the equipment window to change generators");
            }
            ClientMsg::Equip { config, lasers, gens, extras, drones, drone_design, laser_lvls, gen_lvls } => {
                if !(1..=2).contains(&config) {
                    self.send_log(id, "Config must be 1 or 2");
                    return;
                }
                let p = e.player_mut().unwrap();
                let idx = config as usize - 1;
                let mut c = p.configs[idx].clone();
                // new items without explicit levels start at their max level (normalize fills them),
                // instead of inheriting whatever level the old item in that slot had
                if let Some(v) = lasers {
                    if laser_lvls.is_none() && v != c.lasers {
                        c.laser_lvls.clear();
                    }
                    c.lasers = v;
                }
                if let Some(v) = gens {
                    if gen_lvls.is_none() && v != c.gens {
                        c.gen_lvls.clear();
                    }
                    c.gens = v;
                }
                if let Some(v) = extras {
                    c.extras = v;
                }
                if let Some(v) = drones {
                    c.drones = v;
                }
                if let Some(v) = drone_design {
                    c.drone_design = v.filter(|d| !d.is_empty());
                }
                if let Some(v) = laser_lvls {
                    c.laser_lvls = v;
                }
                if let Some(v) = gen_lvls {
                    c.gen_lvls = v;
                }
                equipment::normalize(&data.items, &mut c);
                if let Some(eco) = &p.eco {
                    if let Err(err) = eco.check_owned(&data.items, &c) {
                        self.send_log(id, &format!("Equipment rejected: {}", err));
                        return;
                    }
                    eco.apply_levels(&data.items, &mut c);
                }
                let ship = Self::ship_of(&data, p);
                if let Err(err) = equipment::validate(ship, &data.items, &c) {
                    self.send_log(id, &format!("Equipment rejected: {}", err));
                    return;
                }
                p.configs[idx] = c;
                if p.cfg == idx {
                    Self::apply_ship(&data, e, false);
                }
            }
            ClientMsg::Upgrade { config, target, slot, level } => {
                let p = e.player_mut().unwrap();
                let Some(idx) = (1..=2).contains(&config).then(|| config as usize - 1) else {
                    self.send_log(id, "Config must be 1 or 2");
                    return;
                };
                let c = &mut p.configs[idx];
                let all = slot.as_str() == Some("all");
                let slot_n = slot.as_u64().map(|v| v as usize);
                let pick = |i: usize| all || slot_n == Some(i);
                let mut hit = 0;
                match target.as_str() {
                    "laser" => {
                        for (_, l) in c.laser_lvls.iter_mut().enumerate().filter(|(i, _)| pick(*i)) {
                            *l = level;
                            hit += 1;
                        }
                    }
                    "gen" => {
                        for (_, l) in c.gen_lvls.iter_mut().enumerate().filter(|(i, _)| pick(*i)) {
                            *l = level;
                            hit += 1;
                        }
                    }
                    "drone" => {
                        for (_, d) in c.drones.iter_mut().enumerate().filter(|(i, _)| pick(*i)) {
                            d.lvl = level;
                            d.item_lvls.iter_mut().for_each(|l| *l = level);
                            hit += 1;
                        }
                    }
                    _ => {}
                }
                if hit == 0 {
                    self.send_log(id, "Upgrade: nothing matched (target laser|gen|drone, slot index or \"all\")");
                    return;
                }
                equipment::normalize(&data.items, c);
                if p.cfg == idx {
                    Self::apply_ship(&data, e, false);
                }
            }
            ClientMsg::Formation { id: fid } => {
                if data.items.formation(&fid).is_none() {
                    self.send_log(id, &format!("Unknown formation '{}'", fid));
                    return;
                }
                let name = data.items.formation(&fid).map_or_else(|| fid.clone(), |f| f.name.clone());
                e.player_mut().unwrap().loadout.formation = fid;
                Self::apply_ship(&data, e, false);
                self.send_log(id, &format!("Drone formation: {}", name));
            }
            ClientMsg::Booster { id: bid, on } => {
                if data.items.booster(&bid).is_none() {
                    self.send_log(id, &format!("Unknown booster '{}'", bid));
                    return;
                }
                let lo = &mut e.player_mut().unwrap().loadout;
                lo.boosters.retain(|b| *b != bid);
                if on {
                    lo.boosters.push(bid);
                }
                Self::apply_ship(&data, e, false);
            }
            ClientMsg::Cfg { n } => {
                let p = e.player_mut().unwrap();
                if !(1..=2).contains(&n) {
                    return;
                }
                let idx = n as usize - 1;
                if p.cfg == idx {
                    return;
                }
                if p.cfg_cd > 0.0 {
                    let wait = p.cfg_cd.ceil();
                    self.send_log(id, &format!("Config switch available in {} s", wait));
                    return;
                }
                p.cfg = idx;
                p.cfg_cd = combat::CONFIG_SWITCH_COOLDOWN;
                Self::apply_ship(&data, e, false);
                self.send_log(id, &format!("Switched to config {}", n));
            }
            ClientMsg::Jump => {
                if !dead {
                    self.jump(id);
                }
            }
            ClientMsg::Warp { map } => {
                if !dead {
                    self.warp(id, map);
                }
            }
            ClientMsg::Revive => {
                if dead {
                    self.revive(id);
                }
            }
            ClientMsg::Cheat { god, dmg_mult } => {
                let p = e.player_mut().unwrap();
                if let Some(g) = god {
                    p.god = g;
                }
                if let Some(m) = dmg_mult.filter(|m| m.is_finite() && *m >= 0.0) {
                    p.dmg_mult = m.min(1e6);
                }
            }
            ClientMsg::Chat { text } => {
                let text: String = text.trim().chars().filter(|c| !c.is_control()).take(200).collect();
                if !text.is_empty() {
                    let (map, from) = (e.map, e.name.clone());
                    info!("[chat map {}] {}: {}", map, from, text);
                    self.broadcast(map, &ServerMsg::Chat { from, text });
                }
            }
        }
        self.send_you(id, false);
    }

    fn jump(&mut self, id: u32) {
        let data = self.data.clone();
        let e = &self.ents[&id];
        let Some(m) = data.map(e.map) else { return };
        let portal = m
            .portals
            .iter()
            .map(|p| (p, dist(e.x, e.y, p.x, p.y)))
            .filter(|(_, d)| *d <= combat::PORTAL_RANGE)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(p, _)| p);
        let Some(portal) = portal else {
            self.send_log(id, "No portal in range");
            return;
        };
        let Some(dest) = data.map(portal.to) else {
            self.send_log(id, "This portal leads nowhere");
            return;
        };
        let e = self.ents.get_mut(&id).unwrap();
        e.map = dest.id;
        e.x = portal.tx.clamp(0.0, dest.w);
        e.y = portal.ty.clamp(0.0, dest.h);
        e.dest = None;
        e.target = None;
        e.attacking = false;
        info!("player {} jumped {} -> {}", id, m.name, dest.name);
        let e = &self.ents[&id];
        self.send_map(e);
        self.clear_targeting(id);
        self.send_you(id, true);
    }

    fn warp(&mut self, id: u32, map: u32) {
        let data = self.data.clone();
        let Some(dest) = data.map(map) else {
            self.send_log(id, "Unknown map");
            return;
        };
        // your company's station if the map has one (also within the current map), else a random spot
        let e = &self.ents[&id];
        let same = e.map == dest.id;
        let (x, y) = match dest.stations.iter().find(|s| s.faction == e.faction) {
            Some(s) => (s.x, s.y),
            None => (self.rng.gen_range(dest.w * 0.1..dest.w * 0.9), self.rng.gen_range(dest.h * 0.1..dest.h * 0.9)),
        };
        let e = &self.ents[&id];
        let from = data.map(e.map).map_or_else(String::new, |m| m.name.clone());
        let e = self.ents.get_mut(&id).unwrap();
        e.map = dest.id;
        e.x = x.clamp(0.0, dest.w);
        e.y = y.clamp(0.0, dest.h);
        e.dest = None;
        e.target = None;
        e.attacking = false;
        info!("player {} warped {} -> {}", id, from, dest.name);
        let e = &self.ents[&id];
        if !same {
            self.send_map(e);
        }
        self.clear_targeting(id);
        self.send_you(id, true);
        self.send_log(id, &format!("Warped to {}", dest.name));
    }

    fn revive(&mut self, id: u32) {
        let faction = self.ents[&id].faction.clone();
        let (map, x, y) = self.home(&faction);
        let data = self.data.clone();
        let e = self.ents.get_mut(&id).unwrap();
        e.map = map;
        e.x = x;
        e.y = y;
        e.dest = None;
        e.target = None;
        e.attacking = false;
        e.since_hit = 999.0;
        e.player_mut().unwrap().dead = false;
        Self::apply_ship(&data, e, true);
        let e = &self.ents[&id];
        self.send_map(e);
        self.send_you(id, true);
        self.send_log(id, "Your ship has been repaired.");
    }

    // ------------------------------------------------------------------ combat

    /// Returns the target if it is valid (alive, same map) and within `range`.
    fn target_in_range(&self, id: u32, range: f64) -> Option<u32> {
        let e = self.ents.get(&id)?;
        let t = self.ents.get(&e.target?)?;
        (t.alive() && t.map == e.map && dist(e.x, e.y, t.x, t.y) <= range).then_some(t.id)
    }

    /// Fire the selected rocket at the target. `quiet` suppresses the out-of-range log (auto rockets).
    fn fire_rocket(&mut self, id: u32, quiet: bool) {
        let data = self.data.clone();
        let e = &self.ents[&id];
        if e.rocket_cd > 0.0 {
            return;
        }
        let p = e.player().unwrap();
        let rocket = data.rocket(&p.rocket).unwrap_or(&data.lasers.rockets[0]);
        if p.eco.as_ref().is_some_and(|x| x.stock(&rocket.id) == Some(0)) {
            if !quiet {
                self.send_log(id, &format!("Out of {} rockets - buy more in the shop", rocket.name));
            }
            return;
        }
        let range = if rocket.range > 0.0 { rocket.range } else { combat::ROCKET_RANGE };
        let Some(tid) = self.target_in_range(id, range) else {
            if !quiet {
                self.send_log(id, "No target in range");
            }
            return;
        };
        let dmg = rocket.damage * p.stats.rocket_mult * p.dmg_mult;
        let cd = combat::ROCKET_COOLDOWN * p.stats.rocket_cd_mult;
        let rid = rocket.id.clone();
        if self.pvp_refused(id, tid) {
            return;
        }
        let now = self.time;
        let e = self.ents.get_mut(&id).unwrap();
        e.rocket_cd = cd;
        if let Some(p) = e.player_mut() {
            p.last_shot = now;
            if let Some(eco) = p.eco.as_mut() {
                eco.consume(&rid);
            }
        }
        let miss = self.rng.gen_bool(PLAYER_MISS);
        self.apply_hit(id, tid, dmg, "rocket", rid, false, miss);
    }

    /// Laser fire for one entity, if its cycle is ready.
    fn try_laser(&mut self, id: u32) {
        let data = self.data.clone();
        let e = &self.ents[&id];
        if !e.attacking || e.laser_cd > 0.0 || !e.alive() {
            return;
        }
        let range = if e.is_player() { combat::LASER_RANGE } else { combat::NPC_RANGE };
        let Some(tid) = self.target_in_range(id, range) else { return };
        if self.pvp_refused(id, tid) {
            return;
        }
        if !self.ents[&id].is_player() && self.alien_proof(&self.ents[&tid]) {
            // the pilot is resting in a portal/station DMZ: aliens give up on them
            let n = self.ents.get_mut(&id).unwrap();
            n.target = None;
            n.attacking = false;
            return;
        }
        self.season_ammo_fallback(id);
        let e = &self.ents[&id];
        let roll = self.rng.gen_range(0.8..1.2);
        let t = &self.ents[&tid];
        let t_npc: Option<String> = t.npc().map(|n| data.npcs[n.def].id.clone());
        let mut extra = RoundExtra::default();
        let (dmg, ammo, sab, miss_chance, ammo_cd) = match &e.kind {
            Kind::Player(p) => {
                let ammo = data.ammo(&p.ammo).unwrap_or(&data.lasers.ammo[0]);
                let special_cd = if ammo.cooldown > combat::LASER_CYCLE { ammo.cooldown } else { 0.0 };
                if special_cd > 0.0 && p.rsb_cd > 0.0 {
                    return; // e.g. RSB still recharging
                }
                // modern damage model (equipment.rs): per-round max × ammo × variance roll
                let st = &p.stats;
                let pvp = t_npc.is_none();
                let mut base = if pvp { st.damage_pvp } else { st.damage };
                extra.overdrive = p.od_timer <= 0.0 && st.overdrive_pve > 0.0;
                if extra.overdrive {
                    base += if pvp { st.overdrive_pvp } else { st.overdrive_pve };
                }
                if base <= 0.0 {
                    return; // no lasers equipped
                }
                let mult = if ammo.is_sab() { ammo.mult } else { ammo.mult_for(t_npc.as_deref()) };
                let ramp = if ammo.ramp.is_some() { p.idb_mult } else { 1.0 };
                let v = st.variance.clamp(0.0, 0.99);
                let roll = self.rng.gen_range((1.0 - v)..=1.0);
                let flat = if pvp { st.flat_pvp } else { st.flat_pve };
                extra.drain = base * ammo.drain * roll * p.dmg_mult;
                extra.infect = ammo.infect && pvp;
                extra.ramp = ammo.ramp.as_ref().map(|r| (r.step, r.max));
                let dmg = (base * mult * ramp * roll + flat) * p.dmg_mult;
                (dmg, ammo.id.clone(), ammo.is_sab(), PLAYER_MISS * st.miss_mult, special_cd)
            }
            Kind::Npc(n) => {
                if n.no_attack || n.kamikaze.is_some() {
                    return;
                }
                let dmg = if n.damage_max > 0.0 && n.damage_min > 0.0 && n.damage_max >= n.damage_min {
                    self.rng.gen_range(n.damage_min..=n.damage_max)
                } else {
                    n.damage * roll
                };
                (dmg, "x1".to_string(), false, NPC_MISS, 0.0)
            }
        };
        let od_ms = data.items.damage_model.overdrive_ms;
        let e = self.ents.get_mut(&id).unwrap();
        e.laser_cd = combat::LASER_CYCLE;
        if let Some(p) = e.player_mut() {
            p.last_shot = self.time;
            if let Some(eco) = p.eco.as_mut() {
                eco.consume(&ammo);
            }
            if ammo_cd > 0.0 {
                p.rsb_cd = ammo_cd;
            }
            if extra.overdrive {
                p.od_timer = od_ms / 1000.0;
            }
            if let Some((step, max)) = extra.ramp {
                p.idb_mult = (p.idb_mult * step).min(max);
                p.idb_idle = 0.0;
            }
        }
        let miss = self.rng.gen_bool(miss_chance.clamp(0.0, 1.0));
        self.apply_hit(id, tid, dmg, "laser", ammo.clone(), sab, miss);
        if !miss {
            if extra.drain > 0.0 && self.ents.contains_key(&tid) {
                self.apply_hit(id, tid, extra.drain, "laser", ammo, true, false);
            }
            if extra.infect {
                if let Some(t) = self.ents.get_mut(&tid) {
                    t.infected_left = INFECTION_TIME;
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_hit(&mut self, from: u32, to: u32, dmg: f64, kind: &'static str, ammo: String, sab: bool, miss: bool) {
        let shielded = self.has_minions_shield(to);
        let pen = self.ents.get(&from).and_then(|a| a.player()).map(|p| p.stats.penetration).unwrap_or(0.0);
        let Some(t) = self.ents.get_mut(&to) else { return };
        let dmg = if t.infected_left > 0.0 { dmg * (1.0 + INFECTION_DAMAGE) } else { dmg };
        let map = t.map;
        let god = t.player().map(|p| p.god).unwrap_or(false) || shielded;
        let hit = if miss || god {
            combat::Hit { dmg: 0.0, shd: 0.0, hull: 0.0 }
        } else if sab {
            combat::sab_drain(dmg, t.sh)
        } else {
            combat::split_damage(dmg, t.sh, (t.absorb - pen).clamp(0.0, 1.0))
        };
        t.sh -= hit.shd;
        t.hp -= hit.hull;
        t.since_hit = 0.0;
        let mut npc_hit = false;
        if let Kind::Npc(n) = &mut t.kind {
            npc_hit = true;
            *n.attackers.entry(from).or_default() += hit.dmg.max(1.0);
            if t.target.is_none() && n.calm <= 0.0 && !n.no_attack {
                t.target = Some(from);
                t.attacking = true;
            }
        }
        let killed = t.hp <= 0.0;
        if npc_hit && !miss {
            if let Some(p) = self.ents.get_mut(&from).and_then(|a| a.player_mut()) {
                p.last_alien_hit = self.time;
            }
        }
        if npc_hit && !killed {
            self.call_for_help(to, from);
        }
        if !miss && hit.dmg > 0.0 {
            self.on_hit_effects(from, to);
        }
        if sab && hit.shd > 0.0 {
            if let Some(a) = self.ents.get_mut(&from) {
                a.sh = (a.sh + hit.shd).min(a.msh);
            }
        }
        self.broadcast(
            map,
            &ServerMsg::Shot {
                from,
                to,
                kind,
                ammo,
                dmg: hit.dmg.round(),
                shd: hit.shd.round(),
                miss,
            },
        );
        if killed {
            self.kill(to, from);
        }
    }

    fn kill(&mut self, id: u32, killer: u32) {
        let killer_name = self.ents.get(&killer).map(|k| k.name.clone()).unwrap_or_default();
        if self.ents.get(&id).is_some_and(|e| e.is_player()) {
            self.season_pvp_kill(killer, id);
        }
        let Some(e) = self.ents.get_mut(&id) else { return };
        let (map, x, y) = (e.map, e.x, e.y);
        self.pending.push((map, ServerMsg::Boom { id, x: round1(x), y: round1(y) }.json()));
        match &mut e.kind {
            Kind::Player(p) => {
                p.dead = true;
                e.hp = 0.0;
                e.target = None;
                e.attacking = false;
                e.dest = None;
                info!("player {} '{}' destroyed by {}", id, e.name, killer_name);
                e.send(&ServerMsg::Dead { by: killer_name });
                self.send_you(id, true);
            }
            Kind::Npc(n) => {
                let (def, respawns) = (n.def, n.respawns);
                self.ents.remove(&id);
                if respawns {
                    self.respawns.push(Respawn { at: self.time + combat::NPC_RESPAWN, map, def });
                }
                self.reward(killer, def);
            }
        }
        self.clear_targeting(id);
    }

    fn reward(&mut self, killer: u32, def: usize) {
        if self.season_reward(killer, def) {
            return;
        }
        let d = self.data.npcs[def].clone();
        let Some(k) = self.ents.get_mut(&killer) else { return };
        let Some(p) = k.player_mut() else { return };
        p.exp += d.exp;
        p.honor += d.honor;
        info!("player {} destroyed {} (+{} EP, +{} honor)", killer, d.name, d.exp, d.honor);
        let mut lines = vec![format!("You destroyed {}", d.name)];
        for (v, what) in [(d.exp, "EP"), (d.honor, "honor"), (d.credits, "credits"), (d.uridium, "uridium")] {
            if v > 0.0 {
                lines.push(format!("You received {} {}", v, what));
            }
        }
        for l in lines {
            self.send_log(killer, &l);
        }
    }

    // ------------------------------------------------------------------ tick

    pub fn step(&mut self, dt: f64) {
        self.tick += 1;
        self.time += dt;
        let data = self.data.clone();
        self.season_step(dt);
        self.objectives_step(dt);

        // respawns
        let now = self.time;
        let due: Vec<Respawn> = {
            let (due, keep) = std::mem::take(&mut self.respawns).into_iter().partition(|r| r.at <= now);
            self.respawns = keep;
            due
        };
        for r in due {
            self.spawn_npc(r.map, r.def);
        }
        self.step_bots();

        // cooldowns, regen, timers
        for e in self.ents.values_mut() {
            e.laser_cd = (e.laser_cd - dt).max(0.0);
            e.rocket_cd = (e.rocket_cd - dt).max(0.0);
            e.since_hit += dt;
            e.slow_left = (e.slow_left - dt).max(0.0);
            e.infected_left = (e.infected_left - dt).max(0.0);
            let alive = e.alive();
            let mut repair = 0.0;
            let mut regen_drain = 0.0;
            if let Some(p) = e.player_mut() {
                p.rsb_cd = (p.rsb_cd - dt).max(0.0);
                p.cfg_cd = (p.cfg_cd - dt).max(0.0);
                p.od_timer = (p.od_timer - dt).max(0.0);
                p.idb_idle += dt;
                if p.idb_idle > 3.0 {
                    p.idb_mult = 1.0;
                }
                p.you_timer += dt;
                repair = p.stats.repair;
                regen_drain = p.stats.shield_regen - p.stats.shield_drain;
            }
            if alive && regen_drain != 0.0 {
                // formation shield regen (Diamond/Dome) / drain (Moth/Wheel)
                e.sh = (e.sh + e.msh * regen_drain * dt).clamp(0.0, e.msh);
            }
            if alive && e.since_hit >= REGEN_DELAY {
                e.sh = (e.sh + e.msh * SHIELD_REGEN * dt).min(e.msh);
                e.hp = (e.hp + repair * dt).min(e.mhp);
            }
        }

        // special behaviours: minion release, regen, kamikaze, despawn
        self.npc_behaviors(dt);

        // NPC AI
        let players: Vec<PlayerPos> = self
            .ents
            .values()
            .filter(|e| e.is_player() && e.alive() && !self.alien_proof(e))
            .map(|e| PlayerPos { id: e.id, map: e.map, x: e.x, y: e.y })
            .collect();
        let leaders = self.leader_infos();
        for e in self.ents.values_mut() {
            if let Some(n) = e.npc() {
                let def = &data.npcs[n.def];
                let (w, h) = data.map(e.map).map(|m| (m.w, m.h)).unwrap_or((21000.0, 13100.0));
                let spawns_radius = match n.role {
                    Role::Minion => n.owner.and_then(|o| leaders.get(&o)).map(|l| l.minion_radius),
                    Role::Escort => n.owner.and_then(|o| leaders.get(&o)).map(|l| l.escort_radius),
                    Role::Normal => None,
                };
                let ctx = ai::Ctx {
                    players: &players,
                    leaders: &leaders,
                    behavior: &def.behavior,
                    formation_radius: spawns_radius.unwrap_or(400.0),
                    dt,
                    w,
                    h,
                };
                ai::think(e, &ctx, &mut self.rng);
            }
        }

        // movement + facing
        let pos: HashMap<u32, (u32, f64, f64)> = self.ents.values().map(|e| (e.id, (e.map, e.x, e.y))).collect();
        for e in self.ents.values_mut() {
            if !e.alive() {
                continue;
            }
            let mut facing = None;
            if let Some((tx, ty)) = e.dest {
                let (dx, dy) = (tx - e.x, ty - e.y);
                let d = (dx * dx + dy * dy).sqrt();
                let step = e.move_speed() * dt;
                if d <= step || d < 1e-6 {
                    e.x = tx;
                    e.y = ty;
                    e.dest = None;
                } else {
                    e.x += dx / d * step;
                    e.y += dy / d * step;
                }
                if d > 1e-6 {
                    facing = Some(dy.atan2(dx));
                }
            }
            if e.attacking {
                if let Some(&(m, tx, ty)) = e.target.and_then(|t| pos.get(&t)) {
                    if m == e.map && dist(e.x, e.y, tx, ty) <= combat::LASER_RANGE + 300.0 {
                        facing = Some((ty - e.y).atan2(tx - e.x));
                    }
                }
            }
            if let Some(a) = facing {
                e.a = a;
            }
        }

        // lasers
        let ids: Vec<u32> = self.ents.keys().copied().collect();
        for id in ids {
            if self.ents.contains_key(&id) {
                self.try_laser(id);
            }
            let auto = self.ents.get(&id).is_some_and(|e| {
                e.attacking && e.rocket_cd <= 0.0 && e.alive() && e.player().is_some_and(|p| p.stats.auto_rocket)
            });
            if auto {
                self.fire_rocket(id, true);
            }
        }

        self.flush();
    }

    /// Send queued events, per-map state snapshots, and `you` updates.
    fn flush(&mut self) {
        let mut by_map: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for e in self.ents.values().filter(|e| e.player().is_some_and(|p| !p.tx.is_closed())) {
            by_map.entry(e.map).or_default().push(e.id);
        }
        let pending = std::mem::take(&mut self.pending);
        for (map, json) in &pending {
            for pid in by_map.get(map).into_iter().flatten() {
                self.ents[pid].send_raw(json);
            }
        }
        // Interest management: each player only gets entities within VIEW_RADIUS (plus
        // itself and its target); whole-map snapshots cost ~260 KB/s per player.
        for (map, pids) in &by_map {
            let mut ents: Vec<EntState> = self
                .ents
                .values()
                .filter(|e| e.map == *map && e.alive())
                .map(|e| e.to_state())
                .collect();
            ents.extend(self.box_states(*map));
            for pid in pids {
                let me = &self.ents[pid];
                let (mx, my, tg) = (me.x, me.y, me.target);
                let near: Vec<EntState> = ents
                    .iter()
                    .filter(|e| e.id == *pid || Some(e.id) == tg || (e.x - mx).hypot(e.y - my) <= VIEW_RADIUS)
                    .cloned()
                    .collect();
                let json = ServerMsg::State { tick: self.tick, ents: &near }.json();
                self.ents[pid].send_raw(&json);
            }
        }
        let pids: Vec<u32> = by_map.values().flatten().copied().collect();
        for pid in pids {
            self.send_you(pid, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::*;

    fn test_data() -> Arc<Data> {
        let ships = vec![Ship {
            id: "ship_goliath".into(),
            hp: 256000.0,
            speed: 300.0,
            lasers: 15.0,
            generators: 15.0,
            sheet: "ship_goliath".into(),
            ..Default::default()
        }];
        let npcs = vec![NpcDef {
            id: "streuner".into(),
            name: "Streuner".into(),
            hp: 800.0,
            shield: 400.0,
            exp: 400.0,
            honor: 2.0,
            ..Default::default()
        }];
        let mut map = MapDef {
            id: 1,
            name: "1-1".into(),
            faction: "mmo".into(),
            w: 2000.0,
            h: 2000.0,
            stations: vec![Station { faction: "mmo".into(), x: 1000.0, y: 1000.0 }],
            npcs: vec![MapNpc { id: "streuner".into(), count: 1 }],
            ..Default::default()
        };
        map.raw = serde_json::json!({"id":1});
        Arc::new(Data::from_parts(ships, npcs, vec![map], Lasers::default()))
    }

    #[test]
    fn kill_npc_gives_rewards_and_respawns() {
        let mut w = World::new(test_data());
        let (tx, mut rx) = mpsc::channel(10000);
        let pid = w.login(tx, "tester", "mmo");
        let npc = *w.ents.keys().find(|k| **k != pid).unwrap();
        // place npc next to the player
        let n = w.ents.get_mut(&npc).unwrap();
        n.x = 1100.0;
        n.y = 1000.0;
        w.handle(pid, ClientMsg::Cheat { god: Some(true), dmg_mult: Some(100.0) });
        w.handle(pid, ClientMsg::Select { id: Some(npc) });
        w.handle(pid, ClientMsg::Attack { on: true });
        let mut boomed = false;
        for _ in 0..200 {
            w.step(0.05);
            while let Ok(m) = rx.try_recv() {
                if m.contains("\"t\":\"boom\"") && m.contains(&format!("\"id\":{}", npc)) {
                    boomed = true;
                }
            }
            if boomed {
                break;
            }
        }
        assert!(boomed, "npc should die");
        assert!(!w.ents.contains_key(&npc));
        if let Kind::Player(p) = &w.ents[&pid].kind {
            assert_eq!(p.exp, 400.0);
            assert_eq!(p.honor, 2.0);
        }
        for _ in 0..(11 * 20) {
            w.step(0.05);
        }
        assert_eq!(w.ents.values().filter(|e| !e.is_player()).count(), 1, "npc respawned");
    }

    #[test]
    fn player_death_and_revive() {
        let mut w = World::new(test_data());
        let (tx, mut rx) = mpsc::channel(10000);
        let pid = w.login(tx, "victim", "eic"); // no eic map -> falls back to station map
        let npc = *w.ents.keys().find(|k| **k != pid).unwrap();
        {
            let p = w.ents.get_mut(&pid).unwrap();
            p.hp = 10.0;
            p.sh = 0.0;
        }
        w.apply_hit(npc, pid, 100.0, "laser", "x1".into(), false, false);
        assert!(!w.ents[&pid].alive());
        let mut got_dead = false;
        while let Ok(m) = rx.try_recv() {
            got_dead |= m.contains("\"t\":\"dead\"");
        }
        assert!(got_dead);
        w.handle(pid, ClientMsg::Revive);
        let p = &w.ents[&pid];
        assert!(p.alive());
        assert_eq!(p.hp, p.mhp);
        assert_eq!((p.x, p.y), (1000.0, 1000.0));
    }

    #[test]
    fn warp_to_any_map_lands_at_station() {
        let data = test_data();
        let mut maps = data.maps.clone();
        let mut m2 = maps[0].clone();
        m2.id = 2;
        m2.name = "1-2".into();
        m2.stations = vec![
            Station { faction: "eic".into(), x: 300.0, y: 300.0 },
            Station { faction: "mmo".into(), x: 1500.0, y: 500.0 },
        ];
        maps.push(m2);
        let data = Arc::new(Data::from_parts(data.ships.clone(), data.npcs.clone(), maps, Lasers::default()));
        let mut w = World::new(data);
        let (tx, mut rx) = mpsc::channel(10000);
        let pid = w.login(tx, "warper", "mmo");
        w.handle(pid, ClientMsg::Warp { map: 2 });
        let e = &w.ents[&pid];
        assert_eq!((e.map, e.x, e.y), (2, 1500.0, 500.0));
        let mut got_map = false;
        while let Ok(m) = rx.try_recv() {
            got_map |= m.contains("\"t\":\"map\"");
        }
        assert!(got_map, "warp sends the new map");
        w.handle(pid, ClientMsg::Warp { map: 99 });
        assert_eq!(w.ents[&pid].map, 2, "unknown map is ignored");
    }

    #[test]
    fn god_mode_takes_no_damage() {
        let mut w = World::new(test_data());
        let (tx, _rx) = mpsc::channel(10000);
        let pid = w.login(tx, "god", "mmo");
        w.handle(pid, ClientMsg::Cheat { god: Some(true), dmg_mult: None });
        let before = (w.ents[&pid].hp, w.ents[&pid].sh);
        w.apply_hit(0, pid, 1e9, "laser", "x1".into(), false, false);
        assert_eq!((w.ents[&pid].hp, w.ents[&pid].sh), before);
    }

    #[test]
    fn sab_transfers_shield() {
        let mut w = World::new(test_data());
        let (tx, _rx) = mpsc::channel(10000);
        let pid = w.login(tx, "sab", "mmo");
        w.handle(pid, ClientMsg::Cfg { n: 2 }); // shield config, so SAB has room to fill
        let npc = *w.ents.keys().find(|k| **k != pid).unwrap();
        w.ents.get_mut(&pid).unwrap().sh = 0.0;
        w.apply_hit(pid, npc, 300.0, "laser", "sab".into(), true, false);
        assert_eq!(w.ents[&npc].sh, 100.0);
        assert_eq!(w.ents[&npc].hp, 800.0);
        assert_eq!(w.ents[&pid].sh, 300.0);
    }

    #[test]
    fn ship_switch_validates() {
        let mut w = World::new(test_data());
        let (tx, _rx) = mpsc::channel(10000);
        let pid = w.login(tx, "s", "mmo");
        w.handle(pid, ClientMsg::Ship { ship: "nope".into(), design: None });
        assert_eq!(w.ents[&pid].player().unwrap().ship, "ship_goliath");
        // default equipment: config 1 (speed) of a Goliath
        let e = &w.ents[&pid];
        // 300 + 15 × G3N-7900 × 1.2 (Promerium), × 0.95 Drill
        assert!((e.speed - (300.0 + 15.0 * 12.0) * 0.95).abs() < 0.01);
        assert_eq!(e.msh, 0.0);
        // config 2 (shield): 15 × SG3N-B03 lvl16 × Seprom 1.4 × boosters 1.5 (cap) × Shield Engineering 1.25
        w.handle(pid, ClientMsg::Cfg { n: 2 });
        let e = &w.ents[&pid];
        assert!((e.msh - 15.0 * 11450.0 * 1.06 * 1.4 * 1.5 * 1.25).abs() < 0.5);
        assert_eq!(e.absorb, 0.8);
        assert_eq!(e.speed, 300.0 * 0.95);
    }

    fn equip(config: u8, lasers: Option<Vec<&str>>, gens: Option<Vec<&str>>) -> ClientMsg {
        ClientMsg::Equip {
            config,
            lasers: lasers.map(|v| v.into_iter().map(String::from).collect()),
            gens: gens.map(|v| v.into_iter().map(String::from).collect()),
            extras: None,
            drones: Some(vec![]),
            drone_design: None,
            laser_lvls: None,
            gen_lvls: None,
        }
    }

    #[test]
    fn equip_and_switch_configs() {
        let mut w = World::new(test_data());
        let (tx, mut rx) = mpsc::channel(10000);
        let pid = w.login(tx, "eq", "mmo");
        // valid: 2 LF-1 + 1 shield gen, no drones
        w.handle(pid, equip(1, Some(vec!["lf1", "lf1"]), Some(vec!["sg3n-a01"])));
        let p = w.ents[&pid].player().unwrap();
        let dmg = p.stats.damage;
        assert_eq!(p.configs[0].laser_lvls, vec![16, 16], "levels default to max");
        assert!((p.stats.shield - 1000.0 * 1.06 * 1.4 * 1.5 * 1.25).abs() < 0.01);
        assert_eq!(w.ents[&pid].absorb, 0.4);
        assert_eq!(w.ents[&pid].speed, 300.0 * 0.95);
        // invalid: too many lasers -> rejected, unchanged
        w.handle(pid, equip(1, Some(vec!["lf4"; 16]), None));
        assert_eq!(w.ents[&pid].player().unwrap().stats.damage, dmg);
        // upgrade levels: lvl 0 lowers damage, formation/booster toggles change it
        w.handle(pid, ClientMsg::Upgrade { config: 1, target: "laser".into(), slot: serde_json::json!("all"), level: 0 });
        let d0 = w.ents[&pid].player().unwrap().stats.damage;
        assert!(d0 < dmg);
        assert_eq!(w.ents[&pid].player().unwrap().configs[0].laser_lvls, vec![0, 0]);
        w.handle(pid, ClientMsg::Formation { id: "standard".into() });
        assert!(w.ents[&pid].player().unwrap().stats.damage < d0);
        w.handle(pid, ClientMsg::Booster { id: "dmg-b01".into(), on: false });
        let p = w.ents[&pid].player().unwrap();
        assert!(!p.stats.boosters.contains(&"dmg-b01".to_string()));
        assert_eq!(p.stats.formation, "standard");
        let mut rejected = false;
        while let Ok(m) = rx.try_recv() {
            rejected |= m.contains("Equipment rejected");
        }
        assert!(rejected);
        // switch to config 2 (defaults: all shields), then cooldown blocks switching back
        w.handle(pid, ClientMsg::Cfg { n: 2 });
        assert_eq!(w.ents[&pid].player().unwrap().cfg, 1);
        assert!(w.ents[&pid].msh > 400_000.0, "config 2 = all shield gens");
        w.handle(pid, ClientMsg::Cfg { n: 1 });
        assert_eq!(w.ents[&pid].player().unwrap().cfg, 1, "cooldown");
        for _ in 0..(5 * 20 + 1) {
            w.step(0.05);
        }
        w.handle(pid, ClientMsg::Cfg { n: 1 });
        assert_eq!(w.ents[&pid].player().unwrap().cfg, 0);
        // state snapshot carries drones of the active config (config 1 now has none)
        w.handle(pid, ClientMsg::Cfg { n: 2 });
        let st = w.ents[&pid].to_state();
        assert!(st.dr.is_empty());
    }

    #[test]
    fn state_and_you_include_equipment() {
        let mut w = World::new(test_data());
        let (tx, mut rx) = mpsc::channel(10000);
        let pid = w.login(tx, "st", "mmo");
        w.step(0.05);
        let (mut state, mut you) = (None, None);
        while let Ok(m) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&m).unwrap();
            match v["t"].as_str() {
                Some("state") => state = Some(v),
                Some("you") => you = Some(v),
                _ => {}
            }
        }
        let st = state.unwrap();
        let me = st["ents"].as_array().unwrap().iter().find(|e| e["id"] == pid).unwrap().clone();
        assert_eq!(me["dr"].as_array().unwrap().len(), 10);
        assert_eq!(me["dd"], "spartan");
        assert_eq!(me["fm"], "drill");
        let you = you.unwrap();
        assert_eq!(you["cfg"], 1);
        assert_eq!(you["configs"].as_array().unwrap().len(), 2);
        assert_eq!(you["slots"]["lasers"], 15);
        assert_eq!(you["slots"]["drones"], 10);
        let dmg = you["stats"]["damage"].as_f64().unwrap();
        assert!(dmg > 30000.0, "maxed end-game build: {}", dmg);
        let bd = &you["stats"]["damageBreakdown"];
        assert_eq!(bd["groups"].as_array().unwrap().len(), 3);
        assert_eq!(you["stats"]["formation"], "drill");
        assert!(you["stats"]["boosters"].as_array().unwrap().len() >= 3);
        assert_eq!(you["configs"][0]["laserLvls"][0], 20);
        assert_eq!(you["configs"][0]["drones"][0]["lvl"], 16);
    }
}
