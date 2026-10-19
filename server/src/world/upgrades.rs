//! Upgrades panel (U): the concrete next steps a pilot can buy, each with its real effect.
//! Ships follow the tier ladder in shop.json; gear options are "the next better one" and "the
//! best you can afford"; every option is simulated (auto-equipped best fit before vs after) so
//! the panel shows e.g. "+38% damage" instead of a hidden recommendation.

use super::World;
use crate::data::Data;
use crate::equipment::{self, Loadout, Stats};
use crate::season::{big, display_name, Eco, Price, UpgradeOption};

/// What buying a candidate changes, for the simulation.
enum Sim {
    Ship(String),
    Item(String),
    Unlock(String),
    Formation(String),
    Booster(String),
    Level(String),
}

struct Cand {
    cat: &'static str,
    kind: &'static str,
    id: String,
    label: String,
    desc: String,
    price: Price,
    sim: Sim,
}

fn price(c: f64, u: f64) -> Price {
    Price { c, u, ..Default::default() }
}

/// Stats of the best fit for `ship` with this inventory and loadout.
/// Stats of auto-fitted config `which` (0 = shields first, 1 = speed gens first).
fn best_fit(data: &Data, eco: &Eco, lo: &Loadout, ship: &str, which: usize) -> Stats {
    let ship = data.ship(ship).unwrap_or(&data.ships[0]);
    let cfg = eco.auto_configs(&data.items, equipment::slots(ship, &data.items));
    let mut lo = lo.clone();
    eco.apply_unlocks(&mut lo);
    equipment::compute_stats(ship, &data.items, &cfg[which], &lo)
}

fn pct(after: f64, before: f64) -> f64 {
    if before <= 0.0 {
        if after > 0.0 {
            100.0
        } else {
            0.0
        }
    } else {
        ((after - before) / before * 1000.0).round() / 10.0
    }
}

impl World {
    /// Candidate purchases (no simulation yet). Empty for non-season pilots.
    fn upgrade_cands(&self, id: u32) -> Vec<Cand> {
        let data = &self.data;
        let (shop, items) = (&data.shop, &data.items);
        let Some(p) = self.ents.get(&id).and_then(|e| e.player()) else { return vec![] };
        let Some(eco) = p.eco.as_ref() else { return vec![] };
        let cur = World::ship_of(data, p);
        let mut out: Vec<Cand> = vec![];

        // ---- ships: the next tier above the best ship you own; owned better ships to fly
        let top = eco.ships.iter().map(|s| shop.tier_of(s)).max().unwrap_or(0);
        let cur_tier = shop.tier_of(&cur.id);
        for (ti, t) in shop.tiers.iter().enumerate() {
            for sid in &t.ships {
                let Some(s) = data.ship(sid) else { continue };
                let desc = format!(
                    "{} · {} lasers · {} gens · {} HP (now {} · {} · {})",
                    t.name,
                    s.lasers,
                    s.generators,
                    big(s.hp),
                    cur.lasers,
                    cur.generators,
                    big(cur.hp)
                );
                if eco.ships.contains(sid) {
                    if ti > cur_tier && sid != &cur.id {
                        out.push(Cand { cat: "ship", kind: "switch", id: sid.clone(), label: format!("Fly the {}", s.name), desc, price: price(0.0, 0.0), sim: Sim::Ship(sid.clone()) });
                    }
                } else if ti > top && ti <= top + 3 {
                    // the next tiers, so saving up to skip one is a visible choice
                    if let Some(pr) = shop.ships.get(sid) {
                        out.push(Cand { cat: "ship", kind: "ship", id: sid.clone(), label: s.name.clone(), desc, price: pr.clone(), sim: Sim::Ship(sid.clone()) });
                    }
                }
            }
        }

        // ---- lasers / shields: the next better one, and the best you can afford
        let slots = equipment::slots(cur, items);
        // only as many drones as the ship carries count, biggest first (as auto_configs fits them)
        let mut owned_drones: Vec<u32> = items.drones.iter().flat_map(|d| std::iter::repeat_n(d.slots, eco.owns(&d.id) as usize)).collect();
        owned_drones.sort_unstable_by(|a, b| b.cmp(a));
        let drone_slots: u32 = owned_drones.iter().take(slots.drones as usize).sum();
        let mut lasers: Vec<(&crate::data::LaserItem, &Price)> =
            items.lasers.iter().filter(|l| !l.pet_only).filter_map(|l| shop.items.get(&l.id).map(|p| (l, p))).collect();
        lasers.sort_by(|a, b| a.0.damage.total_cmp(&b.0.damage));
        let owned_l: u32 = lasers.iter().map(|(l, _)| eco.owns(&l.id)).sum();
        let room_l = owned_l < slots.lasers + drone_slots;
        let weakest_l = if room_l { 0.0 } else { lasers.iter().filter(|(l, _)| eco.owns(&l.id) > 0).map(|(l, _)| l.damage).fold(f64::INFINITY, f64::min) };
        let better_l: Vec<_> = lasers.iter().filter(|(l, _)| l.damage > weakest_l).collect();
        let what_l = if room_l { "fills an empty laser slot" } else { "replaces your weakest laser" };
        let mut push_l = |l: &crate::data::LaserItem, pr: &Price| {
            if !out.iter().any(|c| c.id == l.id) {
                out.push(Cand { cat: "laser", kind: "item", id: l.id.clone(), label: format!("{} laser", l.name), desc: format!("{} damage · {}", l.damage, what_l), price: pr.clone(), sim: Sim::Item(l.id.clone()) });
            }
        };
        // every better laser type: skipping straight to a higher one is often the better deal
        for (l, pr) in &better_l {
            push_l(l, pr);
        }
        let mut shields: Vec<(&crate::data::ShieldGen, &Price)> =
            items.shield_gens.iter().filter_map(|g| shop.items.get(&g.id).map(|p| (g, p))).collect();
        let sv = |g: &crate::data::ShieldGen| g.shield * g.absorb;
        shields.sort_by(|a, b| sv(a.0).total_cmp(&sv(b.0)));
        let owned_g: u32 = shields.iter().map(|(g, _)| eco.owns(&g.id)).sum::<u32>() + items.speed_gens.iter().map(|g| eco.owns(&g.id)).sum::<u32>();
        // the defensive config also puts shields into drone slots
        let room_g = owned_g < slots.gens + drone_slots;
        let weakest_g = if room_g { 0.0 } else { shields.iter().filter(|(g, _)| eco.owns(&g.id) > 0).map(|(g, _)| sv(g)).fold(f64::INFINITY, f64::min) };
        // slots full of speed gens only: any shield is an improvement
        let weakest_g = if weakest_g.is_finite() { weakest_g } else { 0.0 };
        let better_g: Vec<_> = shields.iter().filter(|(g, _)| sv(g) > weakest_g).collect();
        let what_g = if room_g { "fills an empty slot" } else { "replaces your weakest shield" };
        let mut push_g = |g: &crate::data::ShieldGen, pr: &Price| {
            if !out.iter().any(|c| c.id == g.id) {
                out.push(Cand { cat: "shield", kind: "item", id: g.id.clone(), label: format!("{} shield", g.name), desc: format!("{} shield, {}% absorb · {}", big(g.shield), (g.absorb * 100.0).round(), what_g), price: pr.clone(), sim: Sim::Item(g.id.clone()) });
            }
        };
        for (g, pr) in &better_g {
            push_g(g, pr);
        }
        // speed gens: they go first in config 2 (speed config), so they're compared there
        let mut speeds: Vec<(&crate::data::SpeedGen, &Price)> =
            items.speed_gens.iter().filter_map(|g| shop.items.get(&g.id).map(|p| (g, p))).collect();
        speeds.sort_by(|a, b| a.0.speed.total_cmp(&b.0.speed));
        let owned_s: u32 = speeds.iter().map(|(g, _)| eco.owns(&g.id)).sum();
        let room_s = owned_s < slots.gens;
        let slowest = if room_s { 0.0 } else { speeds.iter().filter(|(g, _)| eco.owns(&g.id) > 0).map(|(g, _)| g.speed).fold(f64::INFINITY, f64::min) };
        let what_s = if room_s { "fills a generator slot in config 2 (speed)" } else { "replaces your slowest speed gen" };
        for (g, pr) in speeds.iter().filter(|(g, _)| g.speed > slowest) {
            if !out.iter().any(|c| c.id == g.id) {
                out.push(Cand { cat: "speed", kind: "item", id: g.id.clone(), label: format!("{} speed gen", g.name), desc: format!("+{} speed · {}", g.speed, what_s), price: (*pr).clone(), sim: Sim::Item(g.id.clone()) });
            }
        }

        // ---- drones (up to 10), each carries more lasers
        let drones: u32 = items.drones.iter().map(|d| eco.owns(&d.id)).sum();
        if drones < items.max_drones {
            for d in &items.drones {
                if let Some(pr) = shop.items.get(&d.id) {
                    out.push(Cand { cat: "drone", kind: "item", id: d.id.clone(), label: format!("{} drone ({}/{})", d.name, drones + 1, items.max_drones), desc: format!("{} slot(s) for lasers or shields", d.slots), price: pr.clone(), sim: Sim::Item(d.id.clone()) });
                }
            }
        }

        // ---- extras: next better repair bot, targeting CPU, auto rockets
        let groups: [(&str, fn(&crate::data::ExtraItem) -> f64); 3] = [
            ("repair", |e| e.repair),
            ("aim", |e| e.miss_mult.map_or(0.0, |m| 1.01 - m)),
            ("rocket", |e| if e.auto_rocket { 1.0 } else { 0.0 }),
        ];
        for (_, f) in groups {
            let have = items.extras.iter().filter(|e| eco.owns(&e.id) > 0).map(|e| f(e)).fold(0.0, f64::max);
            if let Some(e) = items.extras.iter().filter(|e| f(e) > have && shop.items.contains_key(&e.id)).min_by(|a, b| f(a).total_cmp(&f(b))) {
                let desc = items.extras.iter().find(|x| x.id == e.id).map(|_| match f(e) {
                    v if e.repair > 0.0 => format!("repairs {} HP/s out of combat", big(v)),
                    _ if e.auto_rocket => "fires rockets automatically".to_string(),
                    _ => "fewer laser misses".to_string(),
                });
                out.push(Cand { cat: "extra", kind: "item", id: e.id.clone(), label: e.name.clone(), desc: desc.unwrap_or_default(), price: shop.items[&e.id].clone(), sim: Sim::Item(e.id.clone()) });
            }
        }

        // ---- drone design (needs 10 drones), formation (needs drones)
        if drones >= items.max_drones {
            for d in &items.drone_designs {
                if let (false, Some(pr)) = (eco.unlocked("design", &d.id), shop.designs.get(&d.id)) {
                    out.push(Cand { cat: "design", kind: "design", id: d.id.clone(), label: format!("{} drone design", d.name), desc: "bonus with 10 drones".into(), price: pr.clone(), sim: Sim::Unlock(format!("design:{}", d.id)) });
                }
            }
        }
        if drones > 0 {
            for (fid, pr) in &shop.formations {
                if let Some(f) = items.formation(fid) {
                    if !eco.unlocked("formation", fid) {
                        out.push(Cand { cat: "formation", kind: "formation", id: fid.clone(), label: format!("{} formation", f.name), desc: f.desc.clone(), price: pr.clone(), sim: Sim::Formation(fid.clone()) });
                    }
                }
            }
        }

        // ---- boosters and account tech
        for b in &items.boosters {
            if let (false, Some(pr)) = (eco.unlocked("booster", &b.id), shop.boosters.get(&b.id)) {
                out.push(Cand { cat: "booster", kind: "booster", id: b.id.clone(), label: b.name.clone(), desc: "until the round ends".into(), price: pr.clone(), sim: Sim::Booster(b.id.clone()) });
            }
        }
        for (tid, pr) in &shop.tech {
            if !eco.unlocked("tech", tid) {
                out.push(Cand { cat: "tech", kind: "tech", id: tid.clone(), label: pr.name.clone().unwrap_or_else(|| tid.clone()), desc: pr.desc.clone().unwrap_or_default(), price: pr.clone(), sim: Sim::Unlock(format!("tech:{}", tid)) });
            }
        }

        // ---- upgrade levels: lowest-level owned laser / shield type
        for list in [
            lasers.iter().map(|(l, _)| (l.id.as_str(), l.max_level)).collect::<Vec<_>>(),
            shields.iter().map(|(g, _)| (g.id.as_str(), g.max_level)).collect::<Vec<_>>(),
        ] {
            if let Some((uid, lvl)) = list.into_iter().filter(|(i, m)| eco.owns(i) > 0 && eco.level(i) < *m).map(|(i, _)| (i, eco.level(i))).min_by_key(|(_, l)| *l) {
                if let Some(cost) = shop.upgrade_cost(uid, lvl) {
                    out.push(Cand { cat: "level", kind: "upgrade", id: uid.into(), label: format!("{} level {} → {}", display_name(items, uid), lvl, lvl + 1), desc: "upgrades every unit of this type".into(), price: price(cost, 0.0), sim: Sim::Level(uid.into()) });
                }
            }
        }
        out
    }

    /// Options with simulated effects, for the panel.
    pub(super) fn upgrade_options(&self, id: u32) -> Vec<UpgradeOption> {
        let data = &self.data;
        let Some(p) = self.ents.get(&id).and_then(|e| e.player()) else { return vec![] };
        let Some(eco) = p.eco.as_ref() else { return vec![] };
        let before = [best_fit(data, eco, &p.loadout, &p.ship, 0), best_fit(data, eco, &p.loadout, &p.ship, 1)];
        self.upgrade_cands(id)
            .into_iter()
            .map(|c| {
                let mut e2 = (**eco).clone();
                let mut lo = p.loadout.clone();
                let mut ship = p.ship.clone();
                match &c.sim {
                    Sim::Ship(s) => ship = s.clone(),
                    Sim::Item(i) => *e2.items.entry(i.clone()).or_default() += 1,
                    Sim::Unlock(k) => {
                        e2.unlocks.insert(k.clone());
                    }
                    Sim::Formation(f) => {
                        e2.unlocks.insert(format!("formation:{}", f));
                        lo.formation = f.clone();
                    }
                    Sim::Booster(b) => {
                        e2.unlocks.insert(format!("booster:{}", b));
                        lo.boosters.push(b.clone());
                    }
                    Sim::Level(i) => {
                        let l = e2.level(i);
                        e2.levels.insert(i.clone(), l + 1);
                    }
                }
                // damage/shield/HP on config 1; speed gens show their speed on config 2 (speed config)
                let after = best_fit(data, &e2, &lo, &ship, 0);
                let after_spd = if c.cat == "speed" { best_fit(data, &e2, &lo, &ship, 1).speed } else { after.speed };
                let before_spd = if c.cat == "speed" { before[1].speed } else { before[0].speed };
                let before = &before[0];
                let (dmg, shd, hp) = (pct(after.damage, before.damage), pct(after.shield, before.shield), pct(after.hp, before.hp));
                let cost = c.price.c + c.price.u * data.shop.upgrade.uri_value;
                let spd = pct(after_spd, before_spd);
                UpgradeOption {
                    value: if cost > 0.0 { ((dmg + 0.5 * shd + 0.3 * hp + 0.5 * spd) / (cost / 10_000.0) * 10.0).round() / 10.0 } else { 0.0 },
                    cat: c.cat.into(),
                    kind: c.kind.into(),
                    id: c.id,
                    label: c.label,
                    desc: c.desc,
                    c: c.price.c,
                    u: c.price.u,
                    ok: eco.can_pay(c.price.c, c.price.u),
                    dmg,
                    shd,
                    hp,
                    spd,
                }
            })
            .collect()
    }

    /// How many options are affordable right now (HUD badge; no simulation).
    pub(super) fn affordable_upgrades(&self, id: u32) -> u32 {
        let Some(eco) = self.ents.get(&id).and_then(|e| e.player()).and_then(|p| p.eco.as_ref()) else { return 0 };
        self.upgrade_cands(id).iter().filter(|c| c.kind != "switch" && eco.can_pay(c.price.c, c.price.u)).count() as u32
    }

    /// Push fresh options, but only to a pilot whose panel is open (it polls every 3 s).
    pub(super) fn send_upgrades(&self, id: u32) {
        let open = |p: &super::PlayerData| self.time - p.upgrades_req <= 5.0;
        if let Some(e) = self.ents.get(&id).filter(|e| e.player().is_some_and(open) && !self.is_bot(id)) {
            let options = self.upgrade_options(id);
            e.send(&crate::protocol::ServerMsg::Upgrades { options });
        }
    }

    /// Bots: fly an owned better ship, else buy the affordable option with the biggest gain per
    /// credit (ships count their HP gain; they unlock slots).
    pub(super) fn bot_pick_upgrade(&self, id: u32) -> Option<UpgradeOption> {
        let opts = self.upgrade_options(id);
        if let Some(s) = opts.iter().find(|o| o.kind == "switch") {
            return Some(s.clone());
        }
        let uri = self.data.shop.upgrade.uri_value;
        opts.into_iter()
            .filter(|o| o.ok)
            .map(|o| {
                let gain = o.dmg + 0.5 * o.shd + 0.3 * o.hp + if o.cat == "ship" { 50.0 } else { 0.0 };
                (gain / (o.c + o.u * uri + 1.0), o)
            })
            .filter(|(v, _)| *v > 0.0)
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, o)| o)
    }
}
