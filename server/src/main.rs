use do_server::{crate_dir, data::Data, router, spawn_sim, world::World};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let root = crate_dir();
    let data_dir = std::env::var("DATA_DIR").map(Into::into).unwrap_or_else(|_| root.join("../data"));
    let dist_dir = std::env::var("DIST_DIR").map(Into::into).unwrap_or_else(|_| root.join("../client/dist"));
    let data = Arc::new(Data::load(&data_dir, &root.join("fixtures")));
    if !dist_dir.join("index.html").exists() {
        warn!("{} has no index.html yet (build the client)", dist_dir.display());
    }

    let mut world = World::new(data);
    world.spawn_bots(std::env::var("BOTS").ok().and_then(|n| n.parse().ok()).unwrap_or(6));
    let world = Arc::new(Mutex::new(world));
    spawn_sim(world.clone());

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    info!("listening on http://{}  (client: {}, data: {})", addr, dist_dir.display(), data_dir.display());
    axum::serve(listener, router(world, &dist_dir, &data_dir)).await.expect("server");
}
