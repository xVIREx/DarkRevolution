//! End-to-end: start the server in-process, connect over a websocket, log in,
//! fly to an NPC, select it and attack until a `boom` arrives. Also jumps a portal.

use do_server::{crate_dir, data::Data, router, spawn_sim, world::World};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn login_move_attack_kill_jump() {
    let fx = crate_dir().join("fixtures");
    let mut data = Data::load(&fx, &fx);
    // shrink map 1 so NPCs are close to the station
    for m in &mut data.maps {
        if m.id == 1 {
            m.w = 4000.0;
            m.h = 4000.0;
            m.portals[0].x = 2300.0;
            m.portals[0].y = 2000.0;
        }
    }
    let world = Arc::new(Mutex::new(World::new(Arc::new(data))));
    spawn_sim(world.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(world, &crate_dir().join("../client/dist"), &fx);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", addr)).await.unwrap();
    let send = |v: Value| Message::Text(v.to_string().into());
    ws.send(send(json!({"t":"login","name":"e2e","faction":"mmo"}))).await.unwrap();
    ws.send(send(json!({"t":"cheat","god":true,"dmgMult":5}))).await.unwrap();

    let mut me = None;
    let mut target: Option<u64> = None;
    let mut got_map = false;
    let mut got_you = false;
    let mut shots = 0;
    let mut boomed = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !boomed {
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await else {
            panic!("no message from server");
        };
        let v: Value = serde_json::from_str(&t).unwrap();
        match v["t"].as_str().unwrap() {
            "welcome" => me = v["id"].as_u64(),
            "map" => got_map = v["map"]["name"] == "1-1",
            "you" => got_you = v["credits"].as_f64() == Some(1e15),
            "shot" if v["from"].as_u64() == me => shots += 1,
            "boom" if v["id"].as_u64() == target && target.is_some() => boomed = true,
            "state" => {
                let ents = v["ents"].as_array().unwrap();
                let pos = |id: u64| ents.iter().find(|e| e["id"].as_u64() == Some(id));
                let Some(p) = me.and_then(pos) else { continue };
                let (px, py) = (p["x"].as_f64().unwrap(), p["y"].as_f64().unwrap());
                if target.is_none() {
                    let nearest = ents
                        .iter()
                        .filter(|e| e["k"] == "n")
                        .min_by(|a, b| {
                            let d = |e: &Value| (e["x"].as_f64().unwrap() - px).hypot(e["y"].as_f64().unwrap() - py);
                            d(a).total_cmp(&d(b))
                        })
                        .expect("npcs on map");
                    target = nearest["id"].as_u64();
                    ws.send(send(json!({"t":"select","id":target}))).await.unwrap();
                    ws.send(send(json!({"t":"attack","on":true}))).await.unwrap();
                }
                if let Some(n) = target.and_then(pos) {
                    if v["tick"].as_u64().unwrap() % 10 == 0 {
                        ws.send(send(json!({"t":"move","x":n["x"],"y":n["y"]}))).await.unwrap();
                    }
                }
            }
            _ => {}
        }
    }
    assert!(got_map && got_you, "map/you received");
    assert!(shots > 0, "fired lasers");
    assert!(boomed, "target destroyed");

    // equipment: an invalid equip is rejected with a log, a config switch shows up in `you`
    ws.send(send(json!({"t":"equip","config":1,"lasers":["sg3n-b02"]}))).await.unwrap();
    ws.send(send(json!({"t":"cfg","n":2}))).await.unwrap();
    let (mut rejected, mut switched) = (false, false);
    let end = Instant::now() + Duration::from_secs(5);
    while !(rejected && switched) {
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(end.into(), ws.next()).await else { break };
        let v: Value = serde_json::from_str(&t).unwrap();
        rejected |= v["t"] == "log" && v["text"].as_str().unwrap().contains("rejected");
        switched |= v["t"] == "you" && v["cfg"] == 2 && v["stats"]["speed"].as_f64() == Some(285.0) /* no speed gens, Drill -5% */;
    }
    assert!(rejected, "invalid equip rejected");
    assert!(switched, "switched to config 2");

    // portal jump: fly to the portal and jump
    ws.send(send(json!({"t":"move","x":2300,"y":2000}))).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut jumped = false;
    while Instant::now() < deadline && !jumped {
        ws.send(send(json!({"t":"jump"}))).await.unwrap();
        let end = Instant::now() + Duration::from_millis(500);
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(end.into(), ws.next()).await {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["t"] == "map" && v["map"]["name"] == "1-2" {
                jumped = true;
                break;
            }
        }
    }
    assert!(jumped, "jumped to 1-2");
}
