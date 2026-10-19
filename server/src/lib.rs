//! DarkOrbit recreation server: static files + websocket + authoritative simulation.

pub mod ai;
pub mod combat;
pub mod data;
pub mod equipment;
pub mod limits;
pub mod net;
pub mod protocol;
pub mod season;
pub mod world;

use axum::middleware;
use axum::routing::get;
use axum::Router;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower_http::services::{ServeDir, ServeFile};
use world::World;

pub type SharedWorld = Arc<Mutex<World>>;

/// Paths relative to the crate dir (so `cargo run` works from `server/`).
pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn router(world: SharedWorld, dist_dir: &Path, data_dir: &Path) -> Router {
    let spa = ServeDir::new(dist_dir).fallback(ServeFile::new(dist_dir.join("index.html")));
    Router::new()
        .route("/ws", get(net::ws_handler))
        .route("/api/season", get(net::season_api))
        .with_state(world)
        .merge(
            Router::new()
                .nest_service("/data", ServeDir::new(data_dir))
                .fallback_service(spa)
                .layer(middleware::from_fn(limits::egress_guard)),
        )
}

/// Run the fixed-rate simulation loop forever.
pub fn spawn_sim(world: SharedWorld) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let dt = 1.0 / world::TICK_HZ;
        let mut iv = tokio::time::interval(Duration::from_secs_f64(dt));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            world.lock().unwrap().step(dt);
        }
    })
}
