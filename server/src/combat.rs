//! Pure combat / stat math (unit-tested).

pub const LASER_RANGE: f64 = 700.0;
pub const ROCKET_RANGE: f64 = 700.0;
pub const NPC_RANGE: f64 = 500.0;
pub const LASER_CYCLE: f64 = 1.0;
pub const ROCKET_COOLDOWN: f64 = 1.0;
/// Default shield absorption (NPCs; players use their equipment's weighted absorb).
pub const SHIELD_ABSORB: f64 = 0.8;
/// Minimum time between `cfg` switches.
pub const CONFIG_SWITCH_COOLDOWN: f64 = 5.0;
pub const PORTAL_RANGE: f64 = 500.0;
/// DMZ (DarkOrbit's demilitarised zone around portals and stations): aliens can't attack a
/// player inside it who hasn't fired for `DMZ_CALM` seconds.
pub const PORTAL_DMZ: f64 = 900.0;
pub const STATION_DMZ: f64 = 1600.0;
pub const DMZ_CALM: f64 = 3.0;
pub const NPC_RESPAWN: f64 = 10.0;

/// Laser damage before randomness: equipment damage × ammo mult × dmgMult.
pub fn laser_base(equip_damage: f64, ammo_mult: f64, dmg_mult: f64) -> f64 {
    equip_damage.max(0.0) * ammo_mult * dmg_mult
}

/// Result of applying damage to a target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    /// Total damage dealt (hp + shield).
    pub dmg: f64,
    /// Part absorbed by the shield.
    pub shd: f64,
    /// Part dealt to hull.
    pub hull: f64,
}

/// Normal damage: the shield absorbs `absorb` (e.g. 0.8) of the damage while it lasts,
/// the rest goes to hull.
pub fn split_damage(dmg: f64, shield: f64, absorb: f64) -> Hit {
    let dmg = dmg.max(0.0);
    let shd = (dmg * absorb.clamp(0.0, 1.0)).min(shield.max(0.0));
    Hit { dmg, shd, hull: dmg - shd }
}

/// SAB: drains shield only (returned as `shd`, which also goes to the attacker's shield).
pub fn sab_drain(dmg: f64, shield: f64) -> Hit {
    let shd = dmg.max(0.0).min(shield.max(0.0));
    Hit { dmg: shd, shd, hull: 0.0 }
}

/// DarkOrbit level curve: level 2 at 10 000 EP, doubling every level.
pub fn level_for_exp(exp: f64) -> u32 {
    let mut level = 1;
    let mut need = 10000.0;
    while exp >= need && level < 100 {
        level += 1;
        need *= 2.0;
    }
    level
}

pub fn dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laser_damage() {
        assert_eq!(laser_base(7700.0, 1.0, 1.0), 7700.0);
        assert_eq!(laser_base(3000.0, 4.0, 2.0), 24000.0);
        assert_eq!(laser_base(-5.0, 1.0, 1.0), 0.0);
    }

    #[test]
    fn shield_absorbs_80_percent() {
        let h = split_damage(1000.0, 10000.0, 0.8);
        assert_eq!(h.shd, 800.0);
        assert_eq!(h.hull, 200.0);
        assert_eq!(h.dmg, 1000.0);
    }

    #[test]
    fn shield_exhausted() {
        let h = split_damage(1000.0, 300.0, 0.8);
        assert_eq!(h.shd, 300.0);
        assert_eq!(h.hull, 700.0);
        let h = split_damage(1000.0, 0.0, 0.8);
        assert_eq!(h.shd, 0.0);
        assert_eq!(h.hull, 1000.0);
    }

    #[test]
    fn sab_only_drains_shield() {
        let h = sab_drain(1000.0, 400.0);
        assert_eq!(h, Hit { dmg: 400.0, shd: 400.0, hull: 0.0 });
        let h = sab_drain(1000.0, 5000.0);
        assert_eq!(h.shd, 1000.0);
        assert_eq!(h.hull, 0.0);
    }

    #[test]
    fn partial_absorption() {
        let h = split_damage(1000.0, 10000.0, 0.4);
        assert_eq!(h.shd, 400.0);
        assert_eq!(h.hull, 600.0);
        assert_eq!(split_damage(1000.0, 10000.0, 0.0).hull, 1000.0);
    }

    #[test]
    fn levels() {
        assert_eq!(level_for_exp(0.0), 1);
        assert_eq!(level_for_exp(9999.0), 1);
        assert_eq!(level_for_exp(10000.0), 2);
        assert_eq!(level_for_exp(20000.0), 3);
        assert_eq!(level_for_exp(39999.0), 3);
    }
}
