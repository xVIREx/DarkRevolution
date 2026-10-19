//! WebSocket message types (JSON text frames, discriminated by `t`). See CONTRACT.md.

use crate::equipment::{DroneCfg, EquipConfig, Slots, Stats};
use serde::{Deserialize, Serialize};
use crate::season::{NextBuy, PilotStats, TopRow};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMsg {
    Login {
        #[serde(default)]
        name: String,
        #[serde(default)]
        faction: String,
        /// Season identity (random string kept in the browser).
        #[serde(default)]
        token: Option<String>,
    },
    Move {
        x: f64,
        y: f64,
    },
    Select {
        #[serde(default)]
        id: Option<u32>,
    },
    Attack {
        #[serde(default)]
        on: bool,
    },
    Ammo {
        id: String,
    },
    Rocket {
        #[serde(default)]
        id: Option<String>,
    },
    Ship {
        ship: String,
        #[serde(default)]
        design: Option<String>,
    },
    Config {
        #[serde(default, rename = "speedGens")]
        speed_gens: Option<f64>,
    },
    Jump,
    /// Additive: instant warp to any map (jump CPU). Arrives at the own-faction station if the
    /// map has one, else any station, else the map centre.
    Warp {
        #[serde(deserialize_with = "crate::data::lenient_u32")]
        map: u32,
    },
    Revive,
    Cheat {
        #[serde(default)]
        god: Option<bool>,
        #[serde(default, rename = "dmgMult")]
        dmg_mult: Option<f64>,
    },
    Chat {
        #[serde(default)]
        text: String,
    },
    /// Additive: set equipment of config 1 or 2. Omitted fields keep their current value.
    Equip {
        #[serde(default = "one")]
        config: u8,
        #[serde(default)]
        lasers: Option<Vec<String>>,
        #[serde(default)]
        gens: Option<Vec<String>>,
        #[serde(default)]
        extras: Option<Vec<String>>,
        #[serde(default)]
        drones: Option<Vec<DroneCfg>>,
        /// `null`/"" removes the design; omitted keeps it.
        #[serde(default, rename = "droneDesign", deserialize_with = "some_opt")]
        drone_design: Option<Option<String>>,
        /// Upgrade levels parallel to `lasers` / `gens` (missing = item max).
        #[serde(default, rename = "laserLvls")]
        laser_lvls: Option<Vec<u8>>,
        #[serde(default, rename = "genLvls")]
        gen_lvls: Option<Vec<u8>>,
    },
    /// Additive: set upgrade levels. `target` "laser"|"gen"|"drone", `slot` index or "all".
    Upgrade {
        #[serde(default = "one")]
        config: u8,
        target: String,
        #[serde(default = "all")]
        slot: serde_json::Value,
        level: u8,
    },
    /// Additive: switch drone formation.
    Formation {
        id: String,
    },
    /// Additive: toggle a booster.
    Booster {
        id: String,
        on: bool,
    },
    /// Additive: switch the active config (5 s cooldown).
    Cfg {
        n: u8,
    },
    /// Season: buy from the shop. `kind` ship|item|design|ammo|rocket|formation|booster|tech|upgrade;
    /// `qty` = units (items) or packs (ammo/rockets).
    Buy {
        kind: String,
        id: String,
        #[serde(default = "one32")]
        qty: u32,
    },
    /// Season: fill both configs with the best owned gear.
    #[serde(rename = "autoequip")]
    AutoEquip,
    /// Groups: `action` invite (by `name` or `id`) | accept | decline | leave | kick (`id`) | lead (`id`).
    Group {
        action: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        id: Option<u32>,
    },
}

fn one32() -> u32 {
    1
}

fn one() -> u8 {
    1
}

fn all() -> Value {
    Value::String("all".into())
}

/// Distinguish "field missing" (None) from "field null" (Some(None)).
fn some_opt<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

#[derive(Serialize, Debug, Clone)]
pub struct EntState {
    pub id: u32,
    pub k: &'static str,
    pub n: String,
    pub s: String,
    pub x: f64,
    pub y: f64,
    pub a: f64,
    pub hp: f64,
    pub mhp: f64,
    pub sh: f64,
    pub msh: f64,
    pub f: String,
    pub tg: Option<u32>,
    pub atk: bool,
    /// Additive: drone type ids (players only; omitted when none).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dr: Vec<String>,
    /// Additive: active drone design id (omitted when none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dd: Option<String>,
    /// Additive: active drone formation id (players with drones only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fm: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMsg<'a> {
    Welcome {
        id: u32,
    },
    Map {
        map: &'a Value,
    },
    State {
        tick: u64,
        ents: &'a [EntState],
    },
    You(&'a YouMsg),
    Top(&'a TopMsg),
    /// Your group (id 0 / no members = not in a group); sent on change and every second.
    Group(&'a GroupMsg),
    /// Someone invites you: answer with `group` accept/decline.
    #[serde(rename = "groupInvite")]
    GroupInvite {
        from: String,
        id: u32,
    },
    /// The round is over: final standings and your place (sent just before the reset).
    #[serde(rename = "roundEnd")]
    RoundEnd {
        rows: Vec<TopRow>,
        rank: u32,
        pilots: u32,
        ep: f64,
    },
    Shot {
        from: u32,
        to: u32,
        kind: &'static str,
        ammo: String,
        dmg: f64,
        shd: f64,
        miss: bool,
    },
    Boom {
        id: u32,
        x: f64,
        y: f64,
    },
    Dead {
        by: String,
    },
    Log {
        text: String,
    },
    Chat {
        from: String,
        text: String,
    },
}

impl ServerMsg<'_> {
    pub fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct YouMsg {
    pub ship: String,
    pub design: Option<String>,
    pub speed: f64,
    pub ammo: String,
    pub credits: f64,
    pub uridium: f64,
    pub exp: f64,
    pub honor: f64,
    pub level: u32,
    pub god: bool,
    #[serde(rename = "dmgMult")]
    pub dmg_mult: f64,
    #[serde(rename = "speedGens")]
    pub speed_gens: f64,
    // --- additive fields (not in the original contract) ---
    /// Your entity id (same as `welcome.id`).
    pub id: u32,
    /// Current map id.
    pub map: u32,
    /// Selected rocket id (last fired / default).
    pub rocket: String,
    /// Whether you are currently dead (waiting for `revive`).
    pub dead: bool,
    /// Active config (1 or 2).
    pub cfg: u8,
    /// Both configs (index 0 = config 1).
    pub configs: [EquipConfig; 2],
    pub slots: Slots,
    /// Stats of the active config.
    pub stats: Stats,
    /// Seconds until `cfg` can switch again.
    #[serde(rename = "cfgCd")]
    pub cfg_cd: f64,
    pub faction: String,
    /// Daily season state (absent in sandbox mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<SeasonYou>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SeasonYou {
    /// Unix ms of the next reset (00:00 UTC).
    #[serde(rename = "resetAt")]
    pub reset_at: u64,
    /// Reward bonus your company currently gets (0.25 = +25%), 0 if none.
    pub bonus: f64,
    pub ships: Vec<String>,
    pub items: BTreeMap<String, u32>,
    pub levels: BTreeMap<String, u8>,
    pub unlocks: Vec<String>,
    pub ammo: BTreeMap<String, u64>,
    pub pilot: PilotStats,
    pub rank: u32,
    /// PvP is impossible here (protected map / safe zone) — shown on the HUD.
    pub safe: bool,
    /// The one-key upgrade (U).
    pub next: Option<NextBuy>,
    /// Round length in minutes.
    #[serde(rename = "roundMinutes")]
    pub round_minutes: f64,
}

/// Leaderboard broadcast (season only, every few seconds).
#[derive(Serialize, Debug, Clone)]
pub struct TopMsg {
    pub rows: Vec<TopRow>,
    pub factions: BTreeMap<String, FactionRow>,
    pub champions: Vec<TopRow>,
    pub rank: u32,
    pub pilots: u32,
}

#[derive(Serialize, Debug, Clone)]
pub struct GroupMsg {
    pub id: u32,
    pub leader: u32,
    pub members: Vec<GroupMember>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GroupMember {
    pub id: u32,
    pub n: String,
    pub f: String,
    pub map: u32,
    pub x: f64,
    pub y: f64,
    pub hp: f64,
    pub mhp: f64,
    pub sh: f64,
    pub msh: f64,
    pub lvl: u32,
    pub ship: String,
    pub dead: bool,
    /// Hit an alien within the sharing window (gets a share of group kills).
    pub active: bool,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct FactionRow {
    pub pilots: u32,
    pub online: u32,
    pub ep: f64,
    pub bonus: f64,
}
