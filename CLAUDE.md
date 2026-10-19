# DarkRevolution: notes for Claude

Fan recreation of DarkOrbit. Live at https://darkrevolution.fly.dev (Fly app `darkrevolution`, region fra).

## Layout

- `server/`: Rust (axum + tokio), authoritative 20 Hz sim. `world.rs` is the core; `world/` holds the
  season (`season.rs`), upgrades panel (`upgrades.rs`), company beacons (`objectives.rs`), bots and alien AI
  (`behavior.rs`). `season.rs` (crate root) has the economy types (Shop, Eco, Profile, SaveFile).
- `client/`: TypeScript + three.js (Vite). `game.ts` wires messages to the HUD in `hud/`; the 3D renderer is in
  `render3d/` (`world.r3d` set), and the 2D fallback is in `world.ts`/`effects.ts`/`entities.ts`.
- `data/`: game data. `shop.json` drives the season (prices, `roundMinutes`, boxes, beacons, tiers);
  `npc_behaviors.json` sets alien escorts and spawns.
- `tools/`: asset pipeline from the extracted game client (`extracted/`, gitignored). `assets_build.py` writes
  `client/public/assets/` and `manifest.json` (gitignored, but deployed: `fly deploy` uploads the local build context).
- `video/`: trailer capture scripts (outputs gitignored).
- `CONTRACT.md` (protocol, season rules) and `CONTRACT3D.md`: keep them updated when messages or rules change.

## Commands

```sh
cd server && cargo test --release      # ~41 unit tests + real_data + ws_e2e; keep them green
cd client && npx tsc --noEmit && npm run build
```

Local server: `SEASON_SAVE=<scratch>/s.json PORT=8096 BOTS=0 ./server/target/release/do-server`.
Quick protocol checks: a small Node script using the global `WebSocket` against that port (login `{t:'login', name,
faction, token}`). Stop the process by PID afterwards; `pkill -f` matching your own shell kills it.

## Ship flow

1. commit on branch `release`
2. `git push public release:main` (remote `public` = github.com/xVIREx/DarkRevolution)
3. `fly deploy --app darkrevolution`, then check `fly logs --no-tail` for `season on:` and `curl /api/season`

Push and deploy only when the user asks for it (each time). The server saves the season on SIGINT/SIGTERM, so
deploys keep progress; players need F5 for new client code.

## Season / game rules worth knowing

- A round lasts `roundMinutes` (60) or ends when a company reaches `objectives.winScore`. The save
  (`/data/season-save.json` on the Fly volume) holds `round` and `end`. `SEASON_ROUND_END=<round>:<unix secs>`
  moves one round's end (one-off, then remove it from `fly.toml`).
- Alien loot: killing blow 70%, the rest split equally between the other shooters and active company mates within
  2000 units. There are no custom groups: the company is the party.
- Pilots are locked to a company for the round once they have earned or spent something.
- Bots (`bot:` tokens) play the season but stay off the leaderboard, saves and boxes.

## Working preferences

- The user works on a laptop: prefer cheap verification (unit tests, headless WS scripts, offline renders) over
  long browser sessions; close tabs and stop local servers afterwards.
- Never ship copyrighted assets in the repo (README disclaimer); assets stay gitignored.
- Don't geolocate or look up players from logs or connection data.
