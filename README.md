# DarkRevolution

A from-scratch fan recreation of a classic browser space MMO: a Rust game server and a three.js 3D client that runs in the browser.

**Play:** https://darkrevolution.fly.dev

> **Disclaimer.** DarkRevolution is an unofficial, non-commercial fan project. It is not affiliated with, endorsed by, or connected to Bigpoint GmbH. DarkOrbit is a trademark of Bigpoint GmbH; all original game assets belong to their respective owners. No game assets are included in this repository. If you are a rights holder and want something removed, open an issue and it will be taken down promptly.

## Layout

- `server/`: Rust (axum + tokio) authoritative game server; serves the client and a WebSocket at `/ws`
- `client/`: TypeScript + three.js client (Vite)
- `data/`: game data (ships, lasers, NPCs, maps)
- `tools/`: scripts that convert assets from your own installed copy of the game client into `client/public/assets*`

## Running locally

Assets are not in the repo. Generate them from your own copy of the game client with the scripts in `tools/` (they expect the client under `~/darkorbit-client/extracted/`), then:

```sh
cd client && npm ci && npm run build
cd ../server && cargo run --release
# open http://localhost:8080
```

For development, run the server and `npm run dev` in `client/` (Vite proxies `/ws` and `/data` to `localhost:8080`).
