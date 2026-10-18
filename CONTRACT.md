# DarkOrbit recreation — shared contract

Local-only recreation of DarkOrbit with assets reverse-engineered from the Unity client
(`~/darkorbit-client/extracted/DarkOrbit_Version0.1.4`, v0.1.4, IL2CPP). Classic 2D look.
The player has infinite resources: every ship/design is free to switch to at any time.

## Layout

```
tools/            Python asset/RE scripts (run with .venv/bin/python)
extracted/        raw dumps from the bundles (gitignored; regenerate with tools/)
  xml/            239 game-definition text assets (lib_ships, maps-config, spacemap-config, ...)
  sheets/         1020 baked rotation sprite sheets (ships/npcs/drones/pets) + index.json
  map2d/ laser/ rocket/ portal2d/ building2d/ collects2d/ effect2d/ minimap/   Texture2D|Sprite PNGs
data/             game data JSON (owned by the data agent), served by the server at /data/*
client/           three.js + Vite + TypeScript (owned by the client agent)
  public/assets/  curated, web-ready assets + manifest.json (owned by the assets agent)
server/           Rust (tokio + axum websockets), authoritative sim (owned by the server agent)
```

Run: `cd server && cargo run --release` → http://localhost:8080 serves `client/dist` at `/`,
`data/` at `/data/`, `client/public/assets` via dist, and the websocket at `/ws`.

## Coordinates & units

- World units = DarkOrbit map units. Normal map 21000 x 13100; big maps (4-4, 4-5, 5-x) 42000 x 26200.
- +x right, +y **down** (screen-like, as in the original). Angles in radians, `atan2(dy, dx)`, 0 = facing +x.
- Speeds in units/second (Goliath base 300). Laser range 700. Server tick 20 Hz.
- Rendering scale: 1 world unit = 1 pixel at zoom 1 (sprite sizes in the sheets are native).

## client/public/assets/manifest.json (assets agent → client)

```jsonc
{
  "sheets": {                      // rotation sheets, one per ship/npc/drone design
    "ship_goliath": { "url": "sheets/ship_goliath.png", "frames": 32, "cols": 8, "cw": 338, "ch": 300 }
  },
  "rotation": { "frame0": 0.0, "dir": 1 },   // angle(frame i) = frame0 + dir * i * 2π/frames
                                              // (verified visually; same for all sheets)
  "backgrounds": { "1": "bg/background1.jpg" },   // keyed by maps-config background typeID (isMain)
  "planets":     { "114": "planets/114.png" },
  "lasers":      { "red": "lasers/laser0.png", "blue": "...", "green": "...", "white": "...", "sab": "...", "rsb": "..." },
  "rockets":     { "r310": "rockets/rocket1.png", ... },
  "portal":      { "url": "fx/portal.png", "frames": N, "cols": C, "cw": W, "ch": H, "fps": 24 },
  "stations":    { "mmo": "stations/mmo.png", "eic": "...", "vru": "..." },
  "explosion":   { "url": "fx/explosion.png", "frames": N, "cols": C, "cw": W, "ch": H, "fps": 30 },
  "box":         { "bonus": "...", "cargo": "..." },
  "minimaps":    { "1": "minimap/1.png" }
}
```

## data/*.json (data agent → server + client)

- `ships.json` — array of
  `{ "id": "ship_goliath", "name": "Goliath", "hp": 256000, "speed": 300, "lasers": 15, "generators": 15,
     "extras": 3, "cargo": 1500, "sheet": "ship_goliath", "designs": [{ "id": "ship_goliath-phantasm", "name": "Goliath Phantasm", "sheet": "ship_goliath-phantasm" }] }`
  Only entries whose `sheet`s exist in `extracted/sheets/index.json`.
- `npcs.json` — array of
  `{ "id": "streuner", "name": "-=[ Streuner ]=-", "sheet": "ship2", "hp": 800, "shield": 400, "damage": 20,
     "speed": 280, "aggressive": false, "exp": 400, "honor": 2, "credits": 400, "uridium": 1 }`
- `maps.json` — array of
  `{ "id": 1, "name": "1-1", "faction": "mmo", "w": 21000, "h": 13100, "background": "1",
     "planets": [{ "type": "114", "x": 1110, "y": 1100, "p": 9 }],   // maps-config coords (2048x1276 region space) + pFactor
     "portals": [{ "id": 1, "x": 18500, "y": 11500, "to": 2, "tx": 2000, "ty": 2000 }],
     "stations": [{ "faction": "mmo", "x": 1600, "y": 1600 }],
     "npcs": [{ "id": "streuner", "count": 30 }] }`
- `lasers.json` — `{ "ammo": [{ "id": "x1", "name": "LCB-10", "mult": 1, "color": "red" }, ... x2, x3, x4, sab (shield drain), rsb (x6, 3s cooldown)],
  "laserDamage": 175, "rockets": [{ "id": "r310", "damage": 1000 }, { "id": "plt2026", "damage": 2000 }, { "id": "plt2021", "damage": 4000 }] }`
- `items.json` (owned by the server agent; equipment catalogue + modern damage model, all items free/unlimited; see
  research/damage_model.md). Besides the lists below it has `formations` [{id,name,laser,rocket,pve,pvp,shield,hp,speed,absorb,
  penetration,shieldRegen,shieldDrain,rocketCooldown,desc}], `boosters` [{id,name,damage,shield,hp,repair}], `skills`, `refining`,
  `pet` {lasers, laser}, `damageModel`, `shipBonuses` {shipId: {damage,pve,pvp,shield,hp,speed,penetration,module,moduleDamage}}.
  Lasers have `damage`, `overdrive`, `upgradePerLevel`, `maxLevel` (16; LF-5 20), `pve`, `pvp`, `flatPve`, `flatPvp`, `hpPerLaser`, `petOnly`;
  shield gens have `upgradePerLevel`/`maxLevel`. Old summary —
  `{ "lasers": [{ "id": "lf4", "name": "LF-4", "damage": 200 }, ...],
     "shieldGens": [{ "id": "sg3n-b02", "name": "SG3N-B02", "shield": 10000, "absorb": 0.8 }, ...],
     "speedGens": [{ "id": "g3n-7900", "name": "G3N-7900", "speed": 10 }, ...],
     "extras": [{ "id": "rep-4", "name": "REP-4", "repair": 5000, "desc": "..." }, { "id": "aim-02", "missMult": 0 }, { "id": "arol-x", "autoRocket": true }],
     "drones": [{ "id": "iris", "name": "Iris", "slots": 2 }, ...],          // flax 1, iris/apis/zeus 2
     "droneDesigns": [{ "id": "havoc", "damage": 0.10, "shield": 0, "hp": 0, "minDrones": 10 }, { "id": "hercules", "shield": 0.20, "hp": 0.15, ... }],
     "maxDrones": 10 }`
- `npc_behaviors.json` (owned by the server agent) — `{ "<npc id>": behaviour }` merged onto npcs.json (an inline
  `behavior` object/flag string in npcs.json also works). Behaviour fields: `stationary`, `noAttack`,
  `spawns: { npc, trigger: "attacked"|"always", delayMs, everyMs, count, max, radius, despawnIdleMs }` (mothership minions),
  `escorts: { npc, count, radius, despawnIdleMs }` (group spawned with the leader), `invulnerableWithMinions` (insta-shield),
  `regen: { hpPerSec, shieldPerSec, afterMs, whileMinions }`, `assist` (radius: same-type NPCs join), `slowOnHit: { speed, ms }`,
  `kamikaze: { atHp, delayMs, radius, damage }`. Server also uses npcs.json `damage_min`/`damage_max` and `shield_absorption` (%).

## WebSocket protocol (`/ws`, JSON text frames, `t` = type)

Client → server
| t | fields | meaning |
|---|---|---|
| `login` | `name`, `faction` ("mmo"/"eic"/"vru") | join on the faction home map at the station |
| `move` | `x`, `y` | fly to world point |
| `select` | `id` (or null) | lock a target |
| `attack` | `on` (bool) | start/stop lasers on the selected target (auto-approach not required) |
| `ammo` | `id` | switch laser ammo (`x1..x4,sab,rsb`) |
| `rocket` | `id` | fire one rocket at the target (cooldown 1 s) |
| `ship` | `ship`, `design` (optional) | switch ship/design instantly (free); full HP/shield |
| `config` | `speedGens` (0..1) | **deprecated** (accepted, no effect, replies with a `log`); use `equip` |
| `jump` | — | jump if within 500 units of a portal |
| `revive` | — | respawn at home station after death |
| `cheat` | `god` (bool), `dmgMult` (number) | test toggles |
| `chat` | `text` | broadcast on the map |
| `equip` | `config` (1\|2), optional `lasers: [id]`, `gens: [id]` (shield or speed gens), `extras: [id]`, `drones: [{ type, items: [id] }]` (laser or shield gen per drone slot), `droneDesign` (id or null) | set a config's equipment; omitted fields are kept. Validated against items.json + slots (≤ ship.lasers / generators / extras, ≤ 10 drones, ≤ drone slots); rejected with a `log` "Equipment rejected: …" |
| `cfg` | `n` (1\|2) | switch active config (DO "C" key), 5 s cooldown; keeps HP, shield keeps its fill ratio |
| `equip` (extra fields) | optional `laserLvls: [lvl]`, `genLvls: [lvl]` (parallel to `lasers`/`gens`); drones may carry `itemLvls: [lvl]` and `lvl` (drone upgrade 0..16) | missing levels default to the item's max (16; LF-5 20) |
| `upgrade` | `config` (1\|2), `target` ("laser"\|"gen"\|"drone"), `slot` (index or "all", default "all"), `level` | set upgrade level (clamped to item max). "drone" sets the drone's `lvl` and all its items' levels. Speed gens accept a level but it has no effect |
| `formation` | `id` (items.json `formations`: standard, drill, pincer, heart, turtle, arrow, star, double_arrow, diamond, chevron, moth, crab, barrage, bat, dome, ring, veteran, wheel) | switch drone formation (default `drill`) |
| `booster` | `id`, `on` (bool) | toggle a booster (all on by default, free) |

Server → client
| t | fields |
|---|---|
| `welcome` | `id` (your entity id) |
| `map` | `map` (the maps.json entry for the map you are on) |
| `state` | `tick`, `ents`: `[{ id, k: "p"/"n", n: name, s: sheet, x, y, a, hp, mhp, sh, msh, f: faction, tg: targetId|null, atk: bool, dr?: [droneTypeId], dd?: droneDesignId }]` — full snapshot of the current map, 20 Hz (`dr`/`dd` only for players with drones in the active config) |
| `you` | `ship`, `design`, `speed`, `ammo`, `credits`, `uridium` (both `1e15`), `exp`, `honor`, `level`, `god`, `dmgMult`, `speedGens` (now = fraction of gen slots holding speed gens), plus `id`, `map`, `rocket` (selected rocket id), `dead`, `cfg` (active 1\|2), `cfgCd` (s until switch allowed), `configs`: [cfg1, cfg2] each `{ lasers, laserLvls, gens, genLvls, extras, drones: [{type, items, itemLvls, lvl}], droneDesign }` (levels are **parallel arrays**), `slots`: `{ lasers, gens, extras, drones, pet }`, `stats` (active config): `{ damage` (x1 per round vs aliens, max roll), `damagePvp, overdrivePve, overdrivePvp, flatPve, flatPvp, rocketMult, rocketCdMult, shield, absorb, penetration, speed, hp, repair, shieldRegen, shieldDrain, missMult, autoRocket, variance, formation, boosters: [id], damageBreakdown: { groups: [{name, lasers, basePve, basePvp, factors: [{label, pve, pvp}], totalPve, totalPvp}], x1Pve, x1Pvp, overdrivePve, flatPve, flatPvp, perAmmo: [{id, mult, pve, pvp}], variance, rocket: [factors] } }`. Sent on change and at least every 1 s |
| `shot` | `from`, `to`, `kind` ("laser"/"rocket"/"kamikaze" = Barracuda self-destruct blast), `ammo`, `dmg`, `shd` (shield part), `miss` (bool). `dmg: 0` also when the target is god-moded or insta-shielded |
| `boom` | `id`, `x`, `y` (entity destroyed) |
| `dead` | `by` (killer name) |
| `log` | `text` (reward lines etc. e.g. "You received 400 EP") |
| `chat` | `from`, `text` |

Combat basics (server): lasers fire once per second, one shot = whole round of ship + drone + P.E.T. lasers:
damage = (stats.damage|damagePvp [+ overdrive every 5 s]) × ammo mult (vs that target) × rand(1−variance..1, i.e. 0.75..1) × dmgMult + flat.
The modern damage model (upgrade levels, Seprom, boosters, ship passive/module, formation, drone level/upgrade/design, skills) is
documented in research/damage_model.md and `damageBreakdown`; defaults are a maxed end-game build (LF-5 lvl 20 everywhere,
10 Iris + Havoc, Drill, all boosters) — Goliath ≈ 33.6k x1 / 134k x4 / 201k RSB per round vs aliens. Extra ammo ids in
lasers.json: `cbo` (x3 + half SAB), `abl` (x4, x8 vs Mindfire/Invoke), `pib` (x4, infects players: +10% dmg taken, −10% speed),
`idb` (×1.25 per hit up to x6), `job` (x3.5 PvE / x2 PvP), `rb214` (x4, x8 vs Demaner), `rcb` (x7). The paragraph below about
gens/LF-4 defaults is superseded. Shield absorbs `stats.absorb` minus the attacker's `penetration`
(shield-weighted average of equipped shield gens; NPCs 0.8) while it lasts (shot `shd`). SAB: drains shield to the attacker
instead of damage. RSB: x6 with 3 s cooldown. Shield = Σ shield gens (ship + drones) × (1 + design shield bonus);
speed = ship.speed + Σ speed gens (no cap); hp = ship.hp × (1 + design hp bonus). Design bonuses need 10 drones.
Repair bots heal `repair` HP/s and shields regen 5%/s after 5 s without damage. Rocket range = rocket `range` (default 700).
Default loadout on login / ship switch: config 1 = LF-4 in every laser slot, ⌈gens/2⌉ SG3N-B02 + rest G3N-7900, extras
REP-4/AIM-02/AROL-X, 10 Iris with 2×LF-4, Havoc; config 2 = same lasers/extras, all SG3N-B02 (ship + drones), Hercules.
NPCs wander, aggressive ones attack players within 600 units, passive ones fight back; respawn 10 s after death.
Special NPCs (npc_behaviors.json): Cubikon never moves or shoots; after 2 s under attack it releases Protegits (top-up to
20 alive, every 5 s) that circle it and attack its top-damage attacker; after its death they roam, and minions despawn
silently (no `boom`, just gone from `state`) after 30 s idle. Kristallon/Lordakium (+Boss/Uber) spawn with escorts that
follow and defend them; Boss Kucurbium / Hitac 2.0 escorts give an insta-shield; Battlerays release Interceptors (insta-shield
+ repair while alive); Ice Meteoroids → Icy, Century Falcon → Vagrants; Mordons call nearby Mordons; Saboteur hits slow you to
200 for 5 s; Barracuda at 20% HP stops 5 s then explodes (radius 500). Minions/escorts don't respawn on their own.
Players never lose resources.
