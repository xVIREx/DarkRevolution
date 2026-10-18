//! Sanity check against the real data/ files (skipped if they are missing):
//! everything loads, special behaviours resolve, and a tick stays well under 50 ms.

use do_server::{crate_dir, data::Data, world::World};
use std::sync::Arc;
use std::time::Instant;

#[test]
fn real_data_loads_and_ticks_fast() {
    let dir = crate_dir().join("../data");
    if !dir.join("npcs.json").exists() {
        eprintln!("no data/ yet, skipping");
        return;
    }
    let data = Data::load(&dir, &crate_dir().join("fixtures"));
    let cub = data.npcs.iter().find(|n| n.id == "cubikon").expect("cubikon in npcs.json");
    assert!(cub.behavior.stationary && cub.behavior.spawns.is_some(), "npc_behaviors.json applied");
    for n in &data.npcs {
        if let Some(s) = &n.behavior.spawns {
            assert!(data.npc_index(&s.npc).is_some(), "{} spawns unknown {}", n.id, s.npc);
        }
        if let Some(s) = &n.behavior.escorts {
            assert!(data.npc_index(&s.npc).is_some(), "{} escorts unknown {}", n.id, s.npc);
        }
    }
    let mut w = World::new(Arc::new(data));
    let start = Instant::now();
    for _ in 0..100 {
        w.step(0.05);
    }
    let per_tick = start.elapsed().as_secs_f64() / 100.0;
    eprintln!("{} entities, {:.2} ms/tick", w.ents.len(), per_tick * 1000.0);
    // release build must fit in one 50 ms tick; debug builds are ~10x slower
    let budget = if cfg!(debug_assertions) { 0.5 } else { 0.05 };
    assert!(per_tick < budget);
}
