//! Company objective (Starblast team-mode style): control beacons on the neutral 4-x maps.
//! A beacon is captured while pilots of exactly one company are within `radius`; another
//! company first drains it back to neutral. Every held beacon scores points for its company
//! each second; the company with the most points when the round ends wins and gets a reward
//! bonus during the next round. Capturing pays the pilots who took part.

use super::World;
use crate::combat::dist;
use crate::protocol::{BeaconState, ObjMsg, ServerMsg};
use crate::season::{big, is_bot_token};
use std::collections::BTreeMap;
use tracing::info;

/// Seconds before capturing the same beacon pays the same pilot again.
pub const CAPTURE_REWARD_COOLDOWN: f64 = 300.0;

/// Capture radius actually used (also what the client draws).
fn effective_radius(rule: &crate::season::ObjectiveRule) -> f64 {
    rule.radius.max(100.0)
}

enum Event {
    Captured(usize, String, Vec<u32>),
    Lost(usize, String),
}

impl World {
    pub(super) fn objectives_step(&mut self, dt: f64) {
        let rule = &self.data.shop.objectives;
        let Some(s) = self.season.as_ref() else { return };
        if s.obj.beacons.is_empty() {
            return;
        }
        let (radius, secs, pps) = (effective_radius(rule), rule.capture_secs.max(1.0), rule.points_per_sec);
        // pilots per beacon by company (dead pilots don't count; bots never leave home)
        let mut present: Vec<BTreeMap<String, Vec<u32>>> = vec![BTreeMap::new(); s.obj.beacons.len()];
        for e in self.ents.values() {
            if !e.alive() || !e.player().and_then(|p| p.eco.as_ref()).is_some_and(|x| !is_bot_token(&x.token)) {
                continue;
            }
            for (i, b) in s.obj.beacons.iter().enumerate() {
                if b.map == e.map && dist(e.x, e.y, b.x, b.y) <= radius {
                    present[i].entry(e.faction.clone()).or_default().push(e.id);
                }
            }
        }
        let mut events = vec![];
        let s = self.season.as_mut().unwrap();
        for (i, b) in s.obj.beacons.iter_mut().enumerate() {
            b.contested = present[i].len() > 1;
            if present[i].len() == 1 {
                let (f, ids) = present[i].iter().next().unwrap();
                // more pilots capture faster (up to 2x)
                let rate = dt / secs * (1.0 + 0.25 * (ids.len() as f64 - 1.0)).min(2.0);
                if b.side.as_deref() == Some(f.as_str()) || b.side.is_none() {
                    b.side = Some(f.clone());
                    b.cap = (b.cap + rate).min(1.0);
                    if b.cap >= 1.0 && b.owner.as_deref() != Some(f.as_str()) {
                        b.owner = Some(f.clone());
                        events.push(Event::Captured(i, f.clone(), ids.clone()));
                    }
                } else {
                    b.cap -= rate;
                    if b.cap <= 0.0 {
                        b.cap = 0.0;
                        b.side = None;
                        if let Some(old) = b.owner.take() {
                            events.push(Event::Lost(i, old));
                        }
                    }
                }
            }
            if let Some(o) = &b.owner {
                *s.obj.score.entry(o.clone()).or_default() += pps * b.weight * dt;
            }
        }
        for ev in events {
            self.objective_event(ev);
        }
        let s = self.season.as_mut().unwrap();
        s.obj.timer += dt;
        if s.obj.timer >= 1.0 {
            s.obj.timer = 0.0;
            self.send_objectives();
        }
    }

    fn objective_event(&mut self, ev: Event) {
        let (exp, uri) = (self.data.shop.objectives.capture_exp, self.data.shop.objectives.capture_uridium);
        let now = self.time;
        let s = self.season.as_ref().unwrap();
        let text = match &ev {
            Event::Captured(i, f, _) => format!("{} captured the beacon on {}!", f.to_uppercase(), s.obj.beacons[*i].name),
            Event::Lost(i, f) => format!("{} lost the beacon on {}", f.to_uppercase(), s.obj.beacons[*i].name),
        };
        info!("objective: {}", text);
        if let Event::Captured(i, _, ids) = &ev {
            let map = s.obj.beacons[*i].map;
            for id in ids {
                let Some(p) = self.ents.get_mut(id).and_then(|e| e.player_mut()) else { continue };
                let Some(eco) = p.eco.as_mut() else { continue };
                // once per pilot per beacon per cooldown: drain-and-recapture loops don't pay
                if eco.capture_paid.get(&map).is_some_and(|t| now - t < CAPTURE_REWARD_COOLDOWN) {
                    self.send_log(*id, "Beacon captured! (no reward: you were paid for this beacon recently)");
                    continue;
                }
                eco.capture_paid.insert(map, now);
                eco.uridium += uri;
                eco.stats.earned_u += uri;
                p.exp += exp;
                self.send_log(*id, &format!("Beacon captured! +{} EP, +{} uridium", big(exp), big(uri)));
            }
        }
        let ids: Vec<u32> = self.ents.values().filter(|e| e.player().is_some_and(|p| p.eco.is_some())).map(|e| e.id).collect();
        for id in ids {
            self.send_log(id, &text);
        }
        self.send_objectives();
    }

    pub(super) fn send_objectives(&self) {
        let Some(s) = self.season.as_ref() else { return };
        if s.obj.beacons.is_empty() {
            return;
        }
        let msg = ObjMsg {
            beacons: s
                .obj
                .beacons
                .iter()
                .map(|b| BeaconState {
                    map: b.map,
                    name: b.name.clone(),
                    x: b.x,
                    y: b.y,
                    r: effective_radius(&self.data.shop.objectives),
                    owner: b.owner.clone(),
                    side: b.side.clone(),
                    cap: (b.cap * 100.0).round() / 100.0,
                    contested: b.contested,
                    weight: b.weight,
                })
                .collect(),
            score: s.obj.score.iter().map(|(k, v)| (k.clone(), v.floor())).collect(),
            last_winner: s.obj.last_winner.clone(),
            target: self.data.shop.objectives.win_score,
        };
        let json = ServerMsg::Objectives(&msg).json();
        for e in self.ents.values() {
            if e.player().is_some_and(|p| p.eco.is_some()) {
                e.send_raw(&json);
            }
        }
    }

    /// Round over: decide the company winner, reset beacons. Returns (winner, final scores).
    pub(super) fn objectives_round_end(&mut self) -> (Option<String>, BTreeMap<String, f64>) {
        let Some(s) = self.season.as_mut() else { return (None, BTreeMap::new()) };
        let winner = s.obj.leader();
        let scores = s.obj.score.iter().map(|(k, v)| (k.clone(), v.floor())).collect();
        s.obj.last_winner = winner.clone();
        s.obj.reset();
        (winner, scores)
    }

}
