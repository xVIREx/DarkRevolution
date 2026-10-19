//! Groups (DO "Gruppe"): up to 8 pilots. The leader invites/kicks and can hand over the lead;
//! anyone can leave. Members can't shoot each other, and in the season alien rewards are split
//! evenly between members on the same map who hit an alien within the last 20 s (darkorbitwiki
//! "Group": shared uridium/credits/EP/honor, ~20 s inactivity cut-off), plus a small group bonus.

use super::World;
use crate::protocol::{GroupMember, GroupMsg, ServerMsg};
use std::collections::BTreeMap;
use tracing::info;

pub const MAX_MEMBERS: usize = 8;
/// A member must have hit an alien this recently to get a share of the group's kills.
pub const ACTIVE_SECS: f64 = 20.0;
/// Extra reward pot per additional sharing member (+5% each).
pub const SHARE_BONUS: f64 = 0.05;
const INVITE_SECS: f64 = 60.0;
const STATE_EVERY: f64 = 1.0;

pub struct Group {
    pub leader: u32,
    pub members: Vec<u32>,
}

#[derive(Default)]
pub struct Groups {
    pub list: BTreeMap<u32, Group>,
    next: u32,
    /// invitee -> (inviter, expires at world time)
    invites: BTreeMap<u32, (u32, f64)>,
    timer: f64,
}

impl World {
    pub(super) fn group_of(&self, id: u32) -> Option<u32> {
        self.groups.list.iter().find(|(_, g)| g.members.contains(&id)).map(|(k, _)| *k)
    }

    pub(super) fn same_group(&self, a: u32, b: u32) -> bool {
        self.group_of(a).is_some_and(|g| self.group_of(b) == Some(g))
    }

    /// Members sharing a kill by `killer`: the killer plus active members on the same map.
    pub(super) fn share_targets(&self, killer: u32) -> Vec<u32> {
        let mut out = vec![killer];
        let (Some(gid), Some(k)) = (self.group_of(killer), self.ents.get(&killer)) else { return out };
        for &m in &self.groups.list[&gid].members {
            if m == killer {
                continue;
            }
            let Some(e) = self.ents.get(&m) else { continue };
            let active = e.player().is_some_and(|p| !p.dead && self.time - p.last_alien_hit <= ACTIVE_SECS);
            if e.map == k.map && active {
                out.push(m);
            }
        }
        out
    }

    pub(super) fn handle_group(&mut self, id: u32, action: &str, name: Option<String>, target: Option<u32>) {
        match action {
            "invite" => self.group_invite(id, name, target),
            "accept" => self.group_accept(id),
            "decline" => {
                if let Some((from, _)) = self.groups.invites.remove(&id) {
                    let who = self.name_of(id);
                    self.send_log(from, &format!("{} declined your group invitation", who));
                }
            }
            "leave" => {
                if self.group_of(id).is_some() {
                    self.send_log(id, "You left the group");
                    self.group_leave(id);
                }
            }
            "kick" | "lead" => {
                let Some(gid) = self.group_of(id) else { return };
                let Some(t) = target.filter(|t| *t != id && self.groups.list[&gid].members.contains(t)) else { return };
                if self.groups.list[&gid].leader != id {
                    self.send_log(id, "Only the group leader can do that");
                    return;
                }
                if action == "kick" {
                    self.send_log(t, "You were removed from the group");
                    self.group_leave(t);
                } else {
                    self.groups.list.get_mut(&gid).unwrap().leader = t;
                    let n = self.name_of(t);
                    self.group_log(gid, &format!("{} is now the group leader", n));
                    self.send_group(gid);
                }
            }
            _ => {}
        }
    }

    fn name_of(&self, id: u32) -> String {
        self.ents.get(&id).map(|e| e.name.clone()).unwrap_or_default()
    }

    fn group_invite(&mut self, id: u32, name: Option<String>, target: Option<u32>) {
        let connected = |w: &World, t: u32| w.ents.get(&t).and_then(|e| e.player()).is_some_and(|p| !p.tx.is_closed());
        let t = target.filter(|t| connected(self, *t)).or_else(|| {
            let n = name.as_deref()?.trim().to_lowercase();
            self.ents.values().find(|e| e.name.to_lowercase() == n && connected(self, e.id)).map(|e| e.id)
        });
        let Some(t) = t else {
            self.send_log(id, "No pilot with that name is online");
            return;
        };
        if t == id {
            return;
        }
        if let Some(gid) = self.group_of(id) {
            let g = &self.groups.list[&gid];
            if g.leader != id {
                self.send_log(id, "Only the group leader can invite");
                return;
            }
            if g.members.len() >= MAX_MEMBERS {
                self.send_log(id, &format!("The group is full ({} pilots)", MAX_MEMBERS));
                return;
            }
        }
        let tname = self.name_of(t);
        if self.group_of(t).is_some() {
            self.send_log(id, &format!("{} is already in a group", tname));
            return;
        }
        self.groups.invites.insert(t, (id, self.time + INVITE_SECS));
        let from = self.name_of(id);
        if let Some(e) = self.ents.get(&t) {
            e.send(&ServerMsg::GroupInvite { from: from.clone(), id });
        }
        self.send_log(t, &format!("{} invites you to a group", from));
        self.send_log(id, &format!("Group invitation sent to {}", tname));
    }

    fn group_accept(&mut self, id: u32) {
        let Some((from, until)) = self.groups.invites.remove(&id) else { return };
        if until < self.time || !self.ents.contains_key(&from) {
            self.send_log(id, "That invitation has expired");
            return;
        }
        if self.group_of(id).is_some() {
            return;
        }
        let gid = match self.group_of(from) {
            Some(g) => {
                if self.groups.list[&g].members.len() >= MAX_MEMBERS {
                    self.send_log(id, "The group is full");
                    return;
                }
                self.groups.list.get_mut(&g).unwrap().members.push(id);
                g
            }
            None => {
                self.groups.next += 1;
                let g = self.groups.next;
                self.groups.list.insert(g, Group { leader: from, members: vec![from, id] });
                g
            }
        };
        let who = self.name_of(id);
        info!("player {} '{}' joined group {}", id, who, gid);
        self.group_log(gid, &format!("{} joined the group", who));
        self.send_group(gid);
    }

    /// Remove `id` from its group (leaving, kicked or disconnected).
    pub(super) fn group_leave(&mut self, id: u32) {
        self.groups.invites.remove(&id);
        let Some(gid) = self.group_of(id) else { return };
        let g = self.groups.list.get_mut(&gid).unwrap();
        g.members.retain(|m| *m != id);
        if g.leader == id {
            g.leader = g.members.first().copied().unwrap_or(0);
        }
        let left = g.members.clone();
        self.send_no_group(id);
        let who = self.name_of(id);
        if left.len() < 2 {
            self.groups.list.remove(&gid);
            for m in left {
                self.send_log(m, "The group was disbanded");
                self.send_no_group(m);
            }
        } else {
            self.group_log(gid, &format!("{} left the group", who));
            self.send_group(gid);
        }
    }

    fn group_log(&self, gid: u32, text: &str) {
        for m in &self.groups.list[&gid].members {
            self.send_log(*m, text);
        }
    }

    fn send_no_group(&self, id: u32) {
        if let Some(e) = self.ents.get(&id) {
            e.send(&ServerMsg::Group(&GroupMsg { id: 0, leader: 0, members: vec![] }));
        }
    }

    fn send_group(&self, gid: u32) {
        let Some(g) = self.groups.list.get(&gid) else { return };
        let members: Vec<GroupMember> = g
            .members
            .iter()
            .filter_map(|m| self.ents.get(m))
            .map(|e| {
                let p = e.player();
                GroupMember {
                    id: e.id,
                    n: e.name.clone(),
                    f: e.faction.clone(),
                    map: e.map,
                    x: e.x.round(),
                    y: e.y.round(),
                    hp: e.hp.max(0.0).round(),
                    mhp: e.mhp.round(),
                    sh: e.sh.max(0.0).round(),
                    msh: e.msh.round(),
                    lvl: p.map_or(1, |p| crate::combat::level_for_exp(p.exp)),
                    ship: p.map(|p| p.ship.clone()).unwrap_or_default(),
                    dead: p.is_some_and(|p| p.dead),
                    active: p.is_some_and(|p| self.time - p.last_alien_hit <= ACTIVE_SECS),
                }
            })
            .collect();
        let msg = ServerMsg::Group(&GroupMsg { id: gid, leader: g.leader, members }).json();
        for m in &g.members {
            if let Some(e) = self.ents.get(m) {
                e.send_raw(&msg);
            }
        }
    }

    /// Every tick: expire invitations, refresh member states once a second.
    pub(super) fn groups_step(&mut self, dt: f64) {
        let now = self.time;
        self.groups.invites.retain(|_, (_, until)| *until >= now);
        self.groups.timer += dt;
        if self.groups.timer >= STATE_EVERY {
            self.groups.timer = 0.0;
            let ids: Vec<u32> = self.groups.list.keys().copied().collect();
            for g in ids {
                self.send_group(g);
            }
        }
    }
}
