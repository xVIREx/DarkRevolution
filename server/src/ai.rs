//! NPC behaviour: wander around the spawn point, aggro (aggressive NPCs), chase,
//! orbit-and-shoot, leash back home, and group roles (mothership minions, escorts).

use crate::combat::{dist, NPC_RANGE};
use crate::data::Behavior;
use crate::world::{Entity, Kind, Role};
use rand::rngs::StdRng;
use rand::Rng;
use std::collections::HashMap;

pub const AGGRO_RANGE: f64 = 600.0;
/// Drop the target when it gets this far away.
pub const LEASH_TARGET: f64 = 2000.0;
/// Drop the target when the NPC strays this far from its spawn point.
pub const LEASH_HOME: f64 = 4000.0;
/// After leashing, ignore retaliation for this many seconds.
pub const CALM_TIME: f64 = 5.0;
const WANDER_RADIUS: f64 = 1500.0;
const ORBIT_RADIUS: f64 = 320.0;
/// Minions circle their mothership at this angular speed (rad/s).
const MINION_ORBIT_SPEED: f64 = 0.6;

#[derive(Debug, Clone, Copy)]
pub struct PlayerPos {
    pub id: u32,
    pub map: u32,
    pub x: f64,
    pub y: f64,
}

/// What a group member needs to know about its (alive) leader / mothership.
#[derive(Debug, Clone, Copy)]
pub struct LeaderInfo {
    pub map: u32,
    pub x: f64,
    pub y: f64,
    pub target: Option<u32>,
    /// Player that dealt the most damage to it recently.
    pub top_attacker: Option<u32>,
    pub minion_radius: f64,
    pub escort_radius: f64,
}

pub struct Ctx<'a> {
    pub players: &'a [PlayerPos],
    pub leaders: &'a HashMap<u32, LeaderInfo>,
    pub behavior: &'a Behavior,
    /// Orbit (minion) / formation (escort) radius around the owner.
    pub formation_radius: f64,
    pub dt: f64,
    pub w: f64,
    pub h: f64,
}

/// Decide target / destination / attack state for one NPC this tick.
pub fn think(e: &mut Entity, ctx: &Ctx, rng: &mut StdRng) {
    let Kind::Npc(npc) = &mut e.kind else { return };
    let dt = ctx.dt;
    npc.calm = (npc.calm - dt).max(0.0);
    let (w, h) = (ctx.w, ctx.h);
    let clampp = |x: f64, y: f64| (x.clamp(0.0, w), y.clamp(0.0, h));

    // armed kamikaze: stand still
    if npc.kamikaze.is_some() {
        e.dest = None;
        e.attacking = false;
        return;
    }

    // group members: follow the owner and take over its fights
    let leader = npc.owner.and_then(|o| ctx.leaders.get(&o).copied()).filter(|l| l.map == e.map);
    if npc.owner.is_some() && leader.is_none() {
        // owner died: become a free (aggressive-if-it-was) roamer around here
        npc.owner = None;
        npc.home = (e.x, e.y);
    }
    if let Some(l) = leader {
        npc.home = (l.x, l.y); // leash relative to the leader
        let on_map = |id: u32| ctx.players.iter().any(|p| p.id == id && p.map == e.map);
        let wanted = match npc.role {
            Role::Minion => l.top_attacker.or(l.target),
            _ => l.target.or(l.top_attacker),
        }
        .filter(|t| on_map(*t));
        if let Some(t) = wanted {
            if e.target != Some(t) && (e.target.is_none() || npc.role == Role::Minion) {
                e.target = Some(t);
            }
        }
        if e.target.is_none() {
            e.attacking = false;
            let r = ctx.formation_radius;
            match npc.role {
                Role::Minion => {
                    npc.orbit += MINION_ORBIT_SPEED * dt;
                    e.dest = Some(clampp(l.x + r * npc.orbit.cos(), l.y + r * npc.orbit.sin()));
                }
                _ => {
                    let slot = clampp(l.x + r * npc.orbit.cos(), l.y + r * npc.orbit.sin());
                    if dist(e.x, e.y, slot.0, slot.1) > 60.0 {
                        e.dest = Some(slot);
                    }
                }
            }
            return;
        }
    }

    if ctx.behavior.stationary || npc.no_attack {
        // never moves (stationary) / never fights (no attack): keep the target only as info
        if ctx.behavior.stationary {
            e.dest = None;
        }
        if npc.no_attack {
            e.target = None;
            e.attacking = false;
        }
        if ctx.behavior.stationary {
            if let Some(t) = e.target {
                let ok = ctx.players.iter().any(|p| p.id == t && p.map == e.map && dist(e.x, e.y, p.x, p.y) <= LEASH_TARGET);
                if !ok {
                    e.target = None;
                    e.attacking = false;
                } else {
                    e.attacking = true;
                }
            } else if npc.aggressive && !npc.no_attack {
                if let Some(p) = nearest(e.map, e.x, e.y, ctx.players, AGGRO_RANGE) {
                    e.target = Some(p.id);
                    e.attacking = true;
                }
            }
            return;
        }
    }

    if let Some(t) = e.target {
        match ctx.players.iter().find(|p| p.id == t && p.map == e.map) {
            None => {
                e.target = None;
                e.attacking = false;
            }
            Some(p) => {
                let d = dist(e.x, e.y, p.x, p.y);
                let from_home = dist(e.x, e.y, npc.home.0, npc.home.1);
                if d > LEASH_TARGET || from_home > LEASH_HOME {
                    e.target = None;
                    e.attacking = false;
                    e.dest = Some(npc.home);
                    npc.wander_timer = 6.0;
                    npc.calm = CALM_TIME;
                    return;
                }
                e.attacking = true;
                if d > NPC_RANGE * 0.8 {
                    e.dest = Some((p.x, p.y));
                } else {
                    // circle around the target like the original NPCs do
                    let ang = (e.y - p.y).atan2(e.x - p.x) + 0.6;
                    e.dest = Some(clampp(p.x + ORBIT_RADIUS * ang.cos(), p.y + ORBIT_RADIUS * ang.sin()));
                }
                return;
            }
        }
    }

    if npc.aggressive && npc.calm <= 0.0 && !npc.no_attack {
        if let Some(p) = nearest(e.map, e.x, e.y, ctx.players, AGGRO_RANGE) {
            e.target = Some(p.id);
            e.attacking = true;
            return;
        }
    }

    npc.wander_timer -= dt;
    if npc.wander_timer <= 0.0 {
        let ang = rng.gen_range(0.0..std::f64::consts::TAU);
        let r = rng.gen_range(200.0..WANDER_RADIUS);
        e.dest = Some(clampp(npc.home.0 + r * ang.cos(), npc.home.1 + r * ang.sin()));
        npc.wander_timer = rng.gen_range(4.0..10.0);
    }
}

fn nearest(map: u32, x: f64, y: f64, players: &[PlayerPos], range: f64) -> Option<&PlayerPos> {
    players
        .iter()
        .filter(|p| p.map == map)
        .map(|p| (p, dist(x, y, p.x, p.y)))
        .filter(|(_, d)| *d <= range)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(p, _)| p)
}
