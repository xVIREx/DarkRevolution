//! Bandwidth / connection guards so a hosted instance can't be used to run up the
//! egress bill. All counters are in-memory and reset at UTC midnight (or restart).
//! Static files and WebSocket traffic share the same budgets.
//! Tunable via env: EGRESS_GB_PER_DAY, EGRESS_GB_PER_IP, WS_PER_IP, WS_TOTAL.

use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

const GB: u64 = 1 << 30;

struct Limits {
    egress_total: u64,
    egress_per_ip: u64,
    ws_per_ip: usize,
    ws_total: usize,
}

#[derive(Default)]
struct Counters {
    day: u64,
    egress: u64,
    egress_by_ip: HashMap<IpAddr, u64>,
    ws_by_ip: HashMap<IpAddr, usize>,
    ws: usize,
}

fn env_or(key: &str, default: f64) -> f64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

static LIMITS: LazyLock<Limits> = LazyLock::new(|| Limits {
    egress_total: (env_or("EGRESS_GB_PER_DAY", 100.0) * GB as f64) as u64,
    egress_per_ip: (env_or("EGRESS_GB_PER_IP", 2.0) * GB as f64) as u64,
    ws_per_ip: env_or("WS_PER_IP", 4.0) as usize,
    ws_total: env_or("WS_TOTAL", 300.0) as usize,
});

static COUNTERS: LazyLock<Mutex<Counters>> = LazyLock::new(Default::default);

fn today() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

fn counters() -> std::sync::MutexGuard<'static, Counters> {
    let mut c = COUNTERS.lock().unwrap();
    let day = today();
    if c.day != day {
        c.day = day;
        c.egress = 0;
        c.egress_by_ip.clear();
    }
    c
}

/// Real client IP: Fly's edge proxy sets Fly-Client-IP; locally everyone shares one bucket.
pub fn client_ip(headers: &HeaderMap) -> IpAddr {
    headers
        .get("fly-client-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// Middleware for static files: refuse once the daily budget (global or per-IP) is spent,
/// otherwise charge the response's Content-Length.
pub async fn egress_guard(req: Request, next: Next) -> Response {
    let ip = client_ip(req.headers());
    {
        let c = counters();
        if c.egress >= LIMITS.egress_total {
            return (StatusCode::SERVICE_UNAVAILABLE, "Daily bandwidth budget reached, try again tomorrow.").into_response();
        }
        if c.egress_by_ip.get(&ip).copied().unwrap_or(0) >= LIMITS.egress_per_ip {
            return (StatusCode::TOO_MANY_REQUESTS, "Download limit reached for today.").into_response();
        }
    }
    let res = next.run(req).await;
    let len = res
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if len > 0 {
        let mut c = counters();
        c.egress += len;
        *c.egress_by_ip.entry(ip).or_default() += len;
        if c.egress >= LIMITS.egress_total {
            warn!("daily egress budget reached ({} bytes)", c.egress);
        }
    }
    res
}

/// Charge `bytes` of egress to `ip`; false once the global or per-IP budget is spent.
pub fn charge(ip: IpAddr, bytes: u64) -> bool {
    let mut c = counters();
    c.egress += bytes;
    let mine = c.egress_by_ip.entry(ip).or_default();
    *mine += bytes;
    *mine < LIMITS.egress_per_ip && c.egress < LIMITS.egress_total
}

/// Holds one WebSocket slot; released on drop.
pub struct WsSlot(pub IpAddr);

impl WsSlot {
    pub fn acquire(ip: IpAddr) -> Option<WsSlot> {
        let mut c = counters();
        let mine = c.ws_by_ip.get(&ip).copied().unwrap_or(0);
        if c.ws >= LIMITS.ws_total || mine >= LIMITS.ws_per_ip {
            return None;
        }
        c.ws += 1;
        c.ws_by_ip.insert(ip, mine + 1);
        Some(WsSlot(ip))
    }
}

impl Drop for WsSlot {
    fn drop(&mut self) {
        let mut c = COUNTERS.lock().unwrap();
        c.ws = c.ws.saturating_sub(1);
        if let Some(n) = c.ws_by_ip.get_mut(&self.0) {
            *n -= 1;
            if *n == 0 {
                c.ws_by_ip.remove(&self.0);
            }
        }
    }
}
