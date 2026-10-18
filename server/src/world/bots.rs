//! Bot pilots so the universe never feels empty: ordinary players whose outbox goes
//! nowhere, driven by issuing the same ClientMsgs a browser would. They stay on their
//! faction's home map, hunt NPCs, retreat when hurt and revive after dying. BOTS=n
//! (default 6) sets how many; they never target players or chat.

use super::World;
use crate::combat::{dist, LASER_RANGE};
use crate::protocol::ClientMsg;
use rand::seq::SliceRandom;
use rand::Rng;
use tokio::sync::mpsc;
use tracing::info;

const NAMES: &[&str] = &[
    "xXSlayerXx", "Nightfall", "KampfKeks", "VoidRunner", "M4ster0fOrbit", "Rexo", "StarWolf",
    "Gr1mReaper", "Lunatic", "Zer0Gravity", "OldSchool09", "Phoenix_88", "Kristallo", "DeadEye",
    "Nebulon", "SirLaser", "ToxicTurtle", "Hydra", "Blitzkrieg", "Vortex", "silentshot", "Orion",
];
const SHIPS: &[&str] = &[
    "ship_goliath", "ship_vengeance", "ship_leonov", "ship_bigboy", "ship_piranha", "ship_nostromo",
    "ship_aegis", "ship_citadel", "ship_spearhead", "ship_v-lightning", "ship_g-surgeon", "ship_hammerclaw",
];
const FACTIONS: &[&str] = &["mmo", "eic", "vru"];
/// How far a bot looks for something to shoot.
const HUNT_RADIUS: f64 = 3500.0;
/// Bots roam within this distance of their home station, where new players appear.
const ROAM_RADIUS: f64 = 4500.0;
/// Below this hp fraction a bot breaks off and runs.
const FLEE_HP: f64 = 0.3;

pub(super) struct Bot {
    id: u32,
    home: (f64, f64),
    think_at: f64,
    revive_at: Option<f64>,
    flee_until: f64,
    /// After a kill the bot cruises around for a bit instead of chain-killing.
    rest_until: f64,
    had_target: bool,
}

impl World {
    pub fn spawn_bots(&mut self, count: usize) {
        let mut names: Vec<&str> = NAMES.to_vec();
        names.shuffle(&mut self.rng);
        for i in 0..count {
            let name = names.get(i).copied().unwrap_or("Pilot");
            let faction = FACTIONS[i % FACTIONS.len()];
            let (tx, _) = mpsc::channel(1); // receiver dropped: everything sent is discarded
            let id = self.login(tx, name, faction);
            let ship = SHIPS.choose(&mut self.rng).copied().unwrap_or("ship_goliath");
            if self.data.ship(ship).is_some() {
                self.handle(id, ClientMsg::Ship { ship: ship.to_string(), design: None });
            }
            // scatter them over the map instead of stacking on the station
            let (map, hx, hy) = self.home(faction);
            let (x, y) = self.roam_point(map, (hx, hy));
            if let Some(e) = self.ents.get_mut(&id) {
                (e.x, e.y) = (x, y);
            }
            let think_at = self.time + self.rng.gen_range(0.0..2.0);
            self.bots.push(Bot { id, home: (hx, hy), think_at, revive_at: None, flee_until: 0.0, rest_until: 0.0, had_target: false });
        }
        if count > 0 {
            info!("spawned {} bot pilots", count);
        }
    }

    /// Random point within ROAM_RADIUS of `home`, kept inside the map.
    fn roam_point(&mut self, map: u32, home: (f64, f64)) -> (f64, f64) {
        let (w, h) = self.data.map(map).map(|m| (m.w, m.h)).unwrap_or((10000.0, 10000.0));
        let a = self.rng.gen_range(0.0..std::f64::consts::TAU);
        let r = ROAM_RADIUS * self.rng.gen::<f64>().sqrt();
        ((home.0 + a.cos() * r).clamp(w * 0.05, w * 0.95), (home.1 + a.sin() * r).clamp(h * 0.05, h * 0.95))
    }

    pub(super) fn step_bots(&mut self) {
        let now = self.time;
        for i in 0..self.bots.len() {
            if self.bots[i].think_at > now {
                continue;
            }
            self.bots[i].think_at = now + self.rng.gen_range(0.4..1.2);
            self.think(i);
        }
    }

    fn think(&mut self, i: usize) {
        let (id, now, home) = (self.bots[i].id, self.time, self.bots[i].home);
        let Some(e) = self.ents.get(&id) else { return };
        let (map, x, y, target, has_dest) = (e.map, e.x, e.y, e.target, e.dest.is_some());

        if !e.alive() {
            match self.bots[i].revive_at {
                None => self.bots[i].revive_at = Some(now + self.rng.gen_range(4.0..10.0)),
                Some(t) if now >= t => {
                    self.bots[i].revive_at = None;
                    self.handle(id, ClientMsg::Revive);
                }
                _ => {}
            }
            return;
        }

        if e.hp < e.mhp * FLEE_HP && self.bots[i].flee_until < now {
            self.bots[i].flee_until = now + 8.0;
            self.handle(id, ClientMsg::Attack { on: false });
            self.handle(id, ClientMsg::Select { id: None });
            let (fx, fy) = self.roam_point(map, home);
            self.handle(id, ClientMsg::Move { x: fx, y: fy });
            return;
        }
        if self.bots[i].flee_until > now {
            return;
        }

        let target = target.and_then(|t| self.ents.get(&t)).filter(|t| t.alive() && t.npc().is_some());
        match target {
            Some(t) => {
                let (tx, ty) = (t.x, t.y);
                let d = dist(x, y, tx, ty);
                // keep at laser range, drifting around the target like a human kiting
                if d > LASER_RANGE * 0.8 || self.rng.gen_bool(0.25) {
                    let a = self.rng.gen_range(0.0..std::f64::consts::TAU);
                    let r = self.rng.gen_range(300.0..LASER_RANGE * 0.7);
                    self.handle(id, ClientMsg::Move { x: tx + a.cos() * r, y: ty + a.sin() * r });
                }
            }
            None if self.bots[i].had_target || self.bots[i].rest_until > now => {
                if self.bots[i].had_target {
                    self.bots[i].had_target = false;
                    self.bots[i].rest_until = now + self.rng.gen_range(4.0..15.0);
                }
                if !has_dest {
                    let (rx, ry) = self.roam_point(map, home);
                    self.handle(id, ClientMsg::Move { x: rx, y: ry });
                }
            }
            None => {
                // leave alone anything a real (connected) player is already shooting
                let taken: Vec<u32> = self
                    .ents
                    .values()
                    .filter(|o| o.player().is_some_and(|p| !p.tx.is_closed()))
                    .filter_map(|o| o.target)
                    .collect();
                let prey = self
                    .ents
                    .values()
                    .filter(|o| o.map == map && o.alive() && o.npc().is_some() && !taken.contains(&o.id))
                    .map(|o| (o.id, dist(x, y, o.x, o.y)))
                    .filter(|(_, d)| *d <= HUNT_RADIUS)
                    .min_by(|a, b| a.1.total_cmp(&b.1));
                if let Some((pid, _)) = prey {
                    self.handle(id, ClientMsg::Select { id: Some(pid) });
                    self.handle(id, ClientMsg::Attack { on: true });
                    self.bots[i].had_target = true;
                } else if !has_dest {
                    let (rx, ry) = self.roam_point(map, home);
                    self.handle(id, ClientMsg::Move { x: rx, y: ry });
                }
            }
        }
    }
}
