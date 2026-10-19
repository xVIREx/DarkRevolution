//! Data-driven special NPC behaviours (data/npc_behaviors.json): motherships releasing
//! minions, escorts, insta-shields, regeneration, call-for-help, slowdown and kamikaze.

use super::{Role, World};
use crate::ai::LeaderInfo;
use crate::combat::dist;
use crate::protocol::ServerMsg;
use rand::Rng;
use std::collections::HashMap;
use tracing::debug;

/// An NPC counts as "in combat" (for spawn triggers) while hit within this window.
const COMBAT_WINDOW: f64 = 2.0;
/// Attacker bookkeeping is cleared after this long without being hit.
const ATTACKERS_FORGET: f64 = 10.0;

impl World {
    /// Living minions/escorts of `owner`.
    pub(super) fn group_count(&self, owner: u32, role: Option<Role>) -> usize {
        self.ents
            .values()
            .filter_map(|e| e.npc())
            .filter(|n| n.owner == Some(owner) && role.is_none_or(|r| n.role == r))
            .count()
    }

    /// Insta-shield: invulnerable while its minions/escorts live.
    pub(super) fn has_minions_shield(&self, id: u32) -> bool {
        let Some(n) = self.ents.get(&id).and_then(|e| e.npc()) else { return false };
        self.data.npcs[n.def].behavior.invulnerable_with_minions && self.group_count(id, None) > 0
    }

    /// Spawn the escort group of a freshly spawned leader.
    pub(super) fn spawn_escorts(&mut self, leader: u32) {
        let data = self.data.clone();
        let Some(e) = self.ents.get(&leader) else { return };
        let Some(n) = e.npc() else { return };
        let Some(rule) = &data.npcs[n.def].behavior.escorts else { return };
        let Some(def) = data.npc_index(&rule.npc) else {
            debug!("escort npc '{}' unknown", rule.npc);
            return;
        };
        let (map, x, y) = (e.map, e.x, e.y);
        for i in 0..rule.count {
            let ang = i as f64 / rule.count.max(1) as f64 * std::f64::consts::TAU;
            let (ex, ey) = (x + rule.radius * ang.cos(), y + rule.radius * ang.sin());
            if let Some(id) = self.spawn_npc_at(map, def, ex, ey, Role::Escort, Some(leader)) {
                if let Some(n) = self.ents.get_mut(&id).and_then(|e| e.npc_mut()) {
                    n.orbit = ang;
                }
            }
        }
    }

    /// Release up to `count` minions (capped at `max` alive) around a mothership.
    fn release_minions(&mut self, mother: u32) {
        let data = self.data.clone();
        let Some(e) = self.ents.get(&mother) else { return };
        let Some(n) = e.npc() else { return };
        let Some(rule) = &data.npcs[n.def].behavior.spawns else { return };
        let Some(def) = data.npc_index(&rule.npc) else {
            debug!("minion npc '{}' unknown", rule.npc);
            return;
        };
        let (map, x, y) = (e.map, e.x, e.y);
        let alive = self.group_count(mother, Some(Role::Minion)) as u32;
        let n_new = rule.count.min(rule.max.saturating_sub(alive));
        for _ in 0..n_new {
            let ang = self.rng.gen_range(0.0..std::f64::consts::TAU);
            let r = self.rng.gen_range(50.0..150.0);
            if let Some(id) = self.spawn_npc_at(map, def, x + r * ang.cos(), y + r * ang.sin(), Role::Minion, Some(mother)) {
                if let Some(n) = self.ents.get_mut(&id).and_then(|e| e.npc_mut()) {
                    n.orbit = ang;
                }
            }
        }
        if n_new > 0 {
            debug!("npc {} released {} minions ({} alive)", mother, n_new, alive + n_new);
        }
    }

    /// Group members and same-type neighbours (`assist`) join the fight against `attacker`.
    pub(super) fn call_for_help(&mut self, victim: u32, attacker: u32) {
        if !self.ents.get(&attacker).is_some_and(|a| a.is_player()) {
            return;
        }
        let Some(v) = self.ents.get(&victim) else { return };
        let Some(vn) = v.npc() else { return };
        let (map, x, y, def) = (v.map, v.x, v.y, vn.def);
        let group = vn.owner.unwrap_or(victim);
        let assist = self.data.npcs[def].behavior.assist;
        for e in self.ents.values_mut() {
            if e.id == victim || e.map != map || e.target.is_some() {
                continue;
            }
            let (eid, ex, ey) = (e.id, e.x, e.y);
            let Some(n) = e.npc() else { continue };
            if n.no_attack || n.calm > 0.0 {
                continue;
            }
            let same_group = eid == group || n.owner == Some(group);
            let assisting = assist > 0.0 && n.def == def && dist(x, y, ex, ey) <= assist;
            if same_group || assisting {
                e.target = Some(attacker);
                e.attacking = true;
            }
        }
    }

    /// Effects of a landed hit by `from` on `to` (Saboteur slowdown).
    pub(super) fn on_hit_effects(&mut self, from: u32, to: u32) {
        let Some(def) = self.ents.get(&from).and_then(|e| e.npc()).map(|n| n.def) else { return };
        let Some(slow) = self.data.npcs[def].behavior.slow_on_hit.clone() else { return };
        if let Some(t) = self.ents.get_mut(&to).filter(|t| t.is_player()) {
            t.slow_left = slow.ms / 1000.0;
            t.slow_speed = slow.speed;
        }
    }

    /// Info about every NPC that leads a group, for the AI of its members.
    pub(super) fn leader_infos(&self) -> HashMap<u32, LeaderInfo> {
        let owners: std::collections::HashSet<u32> =
            self.ents.values().filter_map(|e| e.npc()).filter_map(|n| n.owner).collect();
        owners
            .into_iter()
            .filter_map(|o| {
                let e = self.ents.get(&o)?;
                let n = e.npc()?;
                let b = &self.data.npcs[n.def].behavior;
                let top = n.top_attacker().filter(|a| self.ents.get(a).is_some_and(|p| p.is_player() && p.alive()));
                Some((
                    o,
                    LeaderInfo {
                        map: e.map,
                        x: e.x,
                        y: e.y,
                        target: e.target,
                        top_attacker: top,
                        minion_radius: b.spawns.as_ref().map(|s| s.radius).unwrap_or(500.0),
                        escort_radius: b.escorts.as_ref().map(|s| s.radius).unwrap_or(350.0),
                    },
                ))
            })
            .collect()
    }

    /// Per-tick special behaviours.
    pub(super) fn npc_behaviors(&mut self, dt: f64) {
        let data = self.data.clone();
        let mut release = vec![];
        let mut despawn = vec![];
        let mut detonate = vec![];
        let mut group_sizes: HashMap<u32, usize> = HashMap::new();
        for n in self.ents.values().filter_map(|e| e.npc()) {
            if let Some(o) = n.owner {
                *group_sizes.entry(o).or_default() += 1;
            }
        }
        let ids: Vec<u32> = self.ents.keys().copied().collect();
        for id in ids {
            let minions = group_sizes.get(&id).copied().unwrap_or(0);
            let owner_idle = |w: &World, owner: Option<u32>, idle: f64| {
                owner.and_then(|o| w.ents.get(&o)).is_none_or(|o| o.since_hit > idle)
            };
            let Some(e) = self.ents.get(&id) else { continue };
            let Some(n) = e.npc() else { continue };
            let b = &data.npcs[n.def].behavior;
            let (since_hit, role, owner, has_target) = (e.since_hit, n.role, n.owner, e.target.is_some());

            // minions / orphaned escorts disappear after a while without combat
            let idle = match role {
                Role::Minion => Some(
                    owner
                        .and_then(|o| self.ents.get(&o))
                        .and_then(|o| o.npc())
                        .and_then(|on| data.npcs[on.def].behavior.spawns.as_ref())
                        .map(|s| s.despawn_idle_ms / 1000.0)
                        .unwrap_or(30.0),
                ),
                Role::Escort if owner.is_none() => Some(30.0),
                _ => None,
            };
            if let Some(idle) = idle {
                if since_hit > idle && !has_target && owner_idle(self, owner, idle) {
                    despawn.push(id);
                    continue;
                }
            }

            let e = self.ents.get_mut(&id).unwrap();
            let (hp_frac, alive) = (e.hp / e.mhp.max(1.0), e.alive());
            let n = e.npc_mut().unwrap();
            if since_hit > ATTACKERS_FORGET {
                n.attackers.clear();
            }
            n.combat_time = if since_hit < COMBAT_WINDOW { n.combat_time + dt } else { 0.0 };
            n.spawn_cd = (n.spawn_cd - dt).max(0.0);

            if let Some(rule) = &b.spawns {
                let triggered = match rule.trigger.as_str() {
                    "always" => true,
                    _ => n.combat_time * 1000.0 >= rule.delay_ms,
                };
                if triggered && n.spawn_cd <= 0.0 {
                    n.spawn_cd = rule.every_ms / 1000.0;
                    release.push(id);
                }
            }

            if let Some(k) = &b.kamikaze {
                match n.kamikaze.as_mut() {
                    None if alive && hp_frac <= k.at_hp => n.kamikaze = Some(k.delay_ms / 1000.0),
                    Some(t) => {
                        *t -= dt;
                        if *t <= 0.0 {
                            detonate.push(id);
                        }
                    }
                    None => {}
                }
            }

            if let Some(r) = &b.regen {
                let ok_time = since_hit * 1000.0 >= r.after_ms;
                let ok_minions = !r.while_minions || minions > 0;
                if ok_time && ok_minions {
                    e.hp = (e.hp + r.hp_per_sec * dt).min(e.mhp);
                    e.sh = (e.sh + r.shield_per_sec * dt).min(e.msh);
                }
            }
        }

        for id in despawn {
            self.ents.remove(&id);
            self.clear_targeting(id);
        }
        for id in release {
            self.release_minions(id);
        }
        for id in detonate {
            self.detonate(id);
        }
    }

    /// Kamikaze: damage every player in radius, then die without rewards.
    fn detonate(&mut self, id: u32) {
        let Some(e) = self.ents.get(&id) else { return };
        let Some(n) = e.npc() else { return };
        let Some(k) = self.data.npcs[n.def].behavior.kamikaze.clone() else { return };
        let (map, x, y, def, respawns) = (e.map, e.x, e.y, n.def, n.respawns);
        let victims: Vec<u32> = self
            .ents
            .values()
            .filter(|p| p.is_player() && p.alive() && p.map == map && dist(x, y, p.x, p.y) <= k.radius && !self.alien_proof(p))
            .map(|p| p.id)
            .collect();
        for v in victims {
            self.apply_hit(id, v, k.damage, "kamikaze", "x1".into(), false, false);
        }
        if self.ents.remove(&id).is_some() {
            self.pending.push((map, ServerMsg::Boom { id, x: super::round1(x), y: super::round1(y) }.json()));
            if respawns {
                self.respawns.push(super::Respawn { at: self.time + crate::combat::NPC_RESPAWN, map, def });
            }
            self.clear_targeting(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::data::*;

    fn npc(id: &str, hp: f64, damage: f64, speed: f64, aggressive: bool, behavior: Behavior) -> NpcDef {
        NpcDef { id: id.into(), name: id.into(), hp, shield: 0.0, damage, speed, aggressive, behavior, ..Default::default() }
    }

    /// One 20000x20000 map with nothing spawned; tests place NPCs by hand.
    fn world() -> World {
        let ships = vec![Ship {
            id: "ship_goliath".into(),
            hp: 256000.0,
            speed: 300.0,
            lasers: 15.0,
            generators: 15.0,
            ..Default::default()
        }];
        let cubikon = Behavior {
            stationary: true,
            no_attack: true,
            spawns: Some(SpawnRule { npc: "protegit".into(), ..Default::default() }),
            ..Default::default()
        };
        let leader = Behavior {
            escorts: Some(EscortRule { npc: "kristallin".into(), count: 3, ..Default::default() }),
            invulnerable_with_minions: true,
            ..Default::default()
        };
        let npcs = vec![
            npc("cubikon", 1_600_000.0, 0.0, 30.0, false, cubikon),
            npc("protegit", 50000.0, 1500.0, 500.0, true, Behavior::default()),
            npc("kristallon", 400000.0, 5000.0, 250.0, false, leader),
            npc("kristallin", 50000.0, 1200.0, 320.0, true, Behavior::default()),
            npc(
                "barracuda",
                1000.0,
                10.0,
                400.0,
                false,
                Behavior { kamikaze: Some(KamikazeRule { damage: 5000.0, ..Default::default() }), ..Default::default() },
            ),
            npc(
                "saboteur",
                1000.0,
                10.0,
                400.0,
                false,
                Behavior { slow_on_hit: Some(SlowRule { speed: 200.0, ms: 5000.0 }), ..Default::default() },
            ),
        ];
        let mut map = MapDef {
            id: 1,
            name: "1-1".into(),
            faction: "mmo".into(),
            w: 20000.0,
            h: 20000.0,
            stations: vec![Station { faction: "mmo".into(), x: 1000.0, y: 1000.0 }],
            ..Default::default()
        };
        map.raw = serde_json::json!({"id":1});
        World::new(Arc::new(Data::from_parts(ships, npcs, vec![map], Lasers::default())))
    }

    fn player(w: &mut World, x: f64, y: f64) -> (u32, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(100000);
        let id = w.login(tx, "p", "mmo");
        w.handle(id, ClientMsg::Cheat { god: Some(true), dmg_mult: Some(0.01) });
        let e = w.ents.get_mut(&id).unwrap();
        e.x = x;
        e.y = y;
        (id, rx)
    }

    fn spawn(w: &mut World, id: &str, x: f64, y: f64) -> u32 {
        let def = w.data.npc_index(id).unwrap();
        let nid = w.spawn_npc_at(1, def, x, y, Role::Normal, None).unwrap();
        w.spawn_escorts(nid);
        nid
    }

    fn minions_of(w: &World, owner: u32) -> Vec<u32> {
        w.ents.values().filter(|e| e.npc().is_some_and(|n| n.owner == Some(owner))).map(|e| e.id).collect()
    }

    #[test]
    fn cubikon_is_stationary_and_spawns_only_when_attacked() {
        let mut w = world();
        let cube = spawn(&mut w, "cubikon", 10000.0, 10000.0);
        // a player sits nearby but does not attack: nothing happens for 20 s
        let (pid, mut rx) = player(&mut w, 10400.0, 10000.0);
        for _ in 0..400 {
            w.step(0.05);
        }
        assert_eq!((w.ents[&cube].x, w.ents[&cube].y), (10000.0, 10000.0), "never moves");
        assert!(minions_of(&w, cube).is_empty(), "no Protegits without being attacked");

        // attack it for 3 s
        w.handle(pid, ClientMsg::Select { id: Some(cube) });
        w.handle(pid, ClientMsg::Attack { on: true });
        for _ in 0..60 {
            w.step(0.05);
        }
        let minions = minions_of(&w, cube);
        assert_eq!(minions.len(), 20, "released a full wave of 20 Protegits");
        assert_eq!((w.ents[&cube].x, w.ents[&cube].y), (10000.0, 10000.0), "still never moves");
        // more attacking does not exceed the cap
        for _ in 0..200 {
            w.step(0.05);
        }
        assert!(minions_of(&w, cube).len() <= 20);
        // Protegits go for the attacker; the Cubikon itself never shoots
        assert!(minions_of(&w, cube).iter().all(|m| w.ents[m].target == Some(pid)));
        let mut cube_shot = false;
        while let Ok(m) = rx.try_recv() {
            cube_shot |= m.contains(&format!("\"t\":\"shot\",\"from\":{},", cube));
        }
        assert!(!cube_shot, "Cubikon has no attack");
        assert!(w.ents[&cube].target.is_none());
    }

    #[test]
    fn protegits_roam_after_cubikon_dies_then_despawn() {
        let mut w = world();
        let cube = spawn(&mut w, "cubikon", 10000.0, 10000.0);
        let (pid, _rx) = player(&mut w, 10300.0, 10000.0);
        for _ in 0..60 {
            w.apply_hit(pid, cube, 1.0, "laser", "x1".into(), false, false);
            w.step(0.05);
        }
        assert_eq!(minions_of(&w, cube).len(), 20);
        let protegits: Vec<u32> = minions_of(&w, cube);
        w.apply_hit(pid, cube, 1e9, "laser", "x1".into(), false, false);
        assert!(!w.ents.contains_key(&cube));
        // player leaves to the station; Protegits stay for a while, then disappear
        w.ents.get_mut(&pid).unwrap().x = 1000.0;
        w.ents.get_mut(&pid).unwrap().y = 1000.0;
        w.step(0.05);
        assert!(protegits.iter().all(|p| w.ents.contains_key(p)), "they stay after the Cubikon dies");
        assert!(protegits.iter().all(|p| w.ents[p].npc().unwrap().owner.is_none()));
        for _ in 0..(35 * 20) {
            w.step(0.05);
        }
        assert!(protegits.iter().all(|p| !w.ents.contains_key(p)), "despawned after being idle");
    }

    #[test]
    fn escorts_follow_defend_and_shield_their_leader() {
        let mut w = world();
        let lon = spawn(&mut w, "kristallon", 10000.0, 10000.0);
        let escorts = minions_of(&w, lon);
        assert_eq!(escorts.len(), 3);
        // leader moves away: escorts follow
        w.ents.get_mut(&lon).unwrap().x = 12000.0;
        for _ in 0..200 {
            w.step(0.05);
        }
        let lx = w.ents[&lon].x;
        assert!(escorts.iter().all(|e| dist(w.ents[e].x, w.ents[e].y, lx, w.ents[&lon].y) < 800.0));
        // attacking the leader: escorts defend, leader is insta-shielded while they live
        let ly = w.ents[&lon].y;
        let (pid, _rx) = player(&mut w, lx + 300.0, ly);
        let hp0 = w.ents[&lon].hp;
        w.apply_hit(pid, lon, 1000.0, "laser", "x1".into(), false, false);
        assert_eq!(w.ents[&lon].hp, hp0, "invulnerable while escorts live");
        assert!(escorts.iter().all(|e| w.ents[e].target == Some(pid)));
        for e in &escorts {
            w.apply_hit(pid, *e, 1e9, "laser", "x1".into(), false, false);
        }
        w.apply_hit(pid, lon, 1000.0, "laser", "x1".into(), false, false);
        assert!(w.ents[&lon].hp < hp0, "vulnerable once the escorts are dead");
    }

    #[test]
    fn kamikaze_and_slowdown() {
        let mut w = world();
        let b = spawn(&mut w, "barracuda", 10000.0, 10000.0);
        let s = spawn(&mut w, "saboteur", 15000.0, 15000.0);
        let (pid, mut rx) = player(&mut w, 10200.0, 10000.0);
        w.handle(pid, ClientMsg::Cheat { god: Some(false), dmg_mult: None });
        w.ents.get_mut(&b).unwrap().hp = 150.0; // below 20%
        w.step(0.05);
        assert!(w.ents[&b].npc().unwrap().kamikaze.is_some(), "armed");
        let pos = (w.ents[&b].x, w.ents[&b].y);
        for _ in 0..(4 * 20) {
            w.step(0.05);
        }
        assert_eq!((w.ents[&b].x, w.ents[&b].y), pos, "stands still while armed");
        let hp_before = w.ents[&pid].hp + w.ents[&pid].sh;
        for _ in 0..(2 * 20) {
            w.step(0.05);
        }
        assert!(!w.ents.contains_key(&b), "exploded");
        assert!(w.ents[&pid].hp + w.ents[&pid].sh < hp_before, "blast damaged the player");
        let mut kamikaze_shot = false;
        while let Ok(m) = rx.try_recv() {
            kamikaze_shot |= m.contains("\"kind\":\"kamikaze\"");
        }
        assert!(kamikaze_shot);

        w.apply_hit(s, pid, 10.0, "laser", "x1".into(), false, false);
        assert!(w.ents[&pid].slow_left > 0.0);
        assert_eq!(w.ents[&pid].move_speed(), 200.0);
    }
}
