//! WebSocket connection handling: one reader loop + one writer task per client.

use crate::protocol::ClientMsg;
use crate::SharedWorld;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Outbound queue per client; when full (slow client) messages are dropped.
const OUTBOX: usize = 512;

pub async fn ws_handler(ws: WebSocketUpgrade, State(world): State<SharedWorld>) -> Response {
    ws.on_upgrade(move |socket| client(socket, world))
}

async fn client(socket: WebSocket, world: SharedWorld) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(OUTBOX);
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut me: Option<u32> = None;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let parsed: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                debug!("bad client message {:?}: {}", text.as_str(), e);
                continue;
            }
        };
        let mut w = world.lock().unwrap();
        match (me, parsed) {
            (None, ClientMsg::Login { name, faction }) => me = Some(w.login(tx.clone(), &name, &faction)),
            (None, _) => {}
            (Some(id), m) => w.handle(id, m),
        }
    }

    if let Some(id) = me {
        world.lock().unwrap().remove(id);
    } else {
        info!("connection closed before login");
    }
    drop(tx);
    writer.abort();
}
