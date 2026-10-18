# Research notes: DarkOrbit server-side data

Output files (all JSON arrays/objects, UTF-8):

| file | contents |
|---|---|
| `ships.json` | 13 classic player ships (Phoenix through Spearhead) with classic-era stats, designs (sheet guess and boosts), and 27 modern ships (wiki stats only) |
| `npcs.json` | 93 NPCs: classic aliens, Boss and Uber variants, pirates (5-x), event NPCs, and some wiki-only aliens. Each entry has chosen values plus a `by_source` breakdown |
| `maps.json` | 33 maps (1-1 to 4-5, 5-1 to 5-3, ???). Each map has portals with exact x/y, target map and target x/y, stations, NPC spawn counts (plus alternatives), the wiki alien list and wiki spawn spots |
| `equipment.json` | lasers, ammo multipliers and cooldowns, rockets (damage and range), shield gens (strength and absorption), speed gens |
| `conflicts.json` | every value that differs between sources (NPC fields) and the portal reciprocity fixes |
| `_build/` | the scripts that produced the JSON (SQL INSERT parser, wiki infobox parser, merger). The raw downloads were in a scratch directory, so the input paths in `build.py` need adjusting before a re-run |

IDs and names follow the sources. NPC `id` is a slug of the base name. `name` uses the classic in-game form `-=[ Streuner ]=-`, `..::{ Boss X }::..` or `<-o( Uber X )o->`.
**NPC `gfx` is the DarkOrbit ship-type id, and `sheet` = `ship<gfx>`.** I checked each one against `extracted/sheets/index.json`; all of them exist there. The CONTRACT example `"sheet": "ship2"` for Streuner is wrong: Streuner is `ship84`, Lordakia is `ship71`, and so on.
Ship `sheet` / design `sheet` values are guesses matched against the sheet index (`ship_goliath-bastion` etc.). `null` means no match was found.

## Sources

Emulator database dumps were fetched with `gh api` or raw.githubusercontent:

1. **Kalaazu** (manulaiko): `Persistence/database/{ships,npcs,rewards,rewards_npcs,maps,maps_npcs,maps_portals,maps_stations,items}/dump.sql`
   https://github.com/manulaiko/Kalaazu/tree/develop/Persistence/database
   This is the most complete source: per-map NPC counts including bosses, portals for all maps including 4-5 and 5-x, stations, and item cooldowns.
2. **BorjaSanchidrian/DarkOrbitServer** `db/darkorbit_userBorja.sql`. Its `ships` table holds 117 rows covering player ships and NPCs, with hp/shield/damage min-max/speed/neutral flag/rewards. It also has `portals` (61 rows) and `maps` (portal JSON and NPC JSON).
   https://github.com/BorjaSanchidrian/DarkOrbitServer/blob/master/db/darkorbit_userBorja.sql
3. **MuffinMario/Old-Darkorbit-Project-2009-Cpp** `database/olddorps.sql`. Values from around 2009: `naves`, `npcs` (with speed and AI), `maps` (portals and NPCs), `portales`, `objetos` (lasers, ammo, gens with effect codes), and `rockets` (damage and range).
4. **klukarkata/DarkOrbit** `WEBCODE/database fix/do_es.sql`. Has NPCs including Boss and Uber variants, damage ranges, AI and cargo drops. It shares lineage with Muffin.
5. **zeta-arts/DoPs** `darkorbitDB2.sql` (a few NPC rows and 3 maps).
6. **yusufsahinhamza/darkorbit-cms** `server.sql`: 4-1 to 4-4 portals, 4-x stations and 4-x NPC lists.
7. **designated-life/EpicOrbit-Private-Server** `Shared/EpicOrbit.Shared/Items/*.cs`: shield gens (strength, absorption, regen), speed gens, lasers, ammo multipliers, rockets, and ship and design boosts.

Wiki: DarkOrbit Fandom raw wikitext, fetched through the MediaWiki API (`api.php?action=query&prop=revisions`):
- 136 alien pages, i.e. every page that uses `Template:Alien`. The `{{Alien}}` infobox gives hp/shields/damage/speed/ep/honor/credits/uridium, and `{{CargoDrop}}` gives cargo.
- 80 ship pages, i.e. every page that uses `Template:Ship`.
- Map pages 1-1 to 5-4, plus `Location of aliens`, which has a spawn-spot table in minimap coordinates.
- Equipment pages: LF-x, MP-1, Prometheus Laser, ammo, rockets, SG3N/FS, G3N, Shield generator, Speed generator.

Base URL: https://darkorbit.fandom.com/wiki/<Title>. Every JSON entry has a `source` URL list.

## Merge policy

- **NPCs:** the wiki value is used first. The exception is when two or more independent emulator dumps agree on a different value and outnumber the wiki side. In that case the emulator ("classic") value wins, and the wiki value is kept under `current_wiki`.
  - Kalaazu's rows were clearly copied from Borja (they share typos such as Boss Sibelon credits 408600), so the two count as a single vote.
  - Event placeholder rows (hp 1000, shield 0) are never trusted.
  - `field_source` records which source won for each field.
- **Ships:** I hand-picked classic stats (around 2010–2013) by cross-checking Kalaazu, Borja, Muffin and EpicOrbit against the current wiki. Current wiki HP is about classic + 100,000 for almost every ship (Goliath 356k vs 256k), so it is stored separately as `hp_current_wiki`.
- **Portals:** values are chosen by majority vote across 7 portal lists. The 4-4 links prefer Borja and Yusuf, because Kalaazu and Muffin put 4-4 gates at small-map coordinates even though 4-4 is 41600x25600. After the vote, each portal's arrival point (`tx`,`ty`) is set to the return gate's position on the target map, as in the real game. The original value is kept in `tx_src`/`ty_src` when it differed. The losing options are kept in `alternatives`, and `agree` lists the sources that back the chosen value.

## Confidence

**High: three or more sources agree.**
- Core aliens (Streuner, Lordakia, Saimon, Mordon, Devolarium, Sibelon, Sibelonit, Lordakium, Kristallin, Kristallon, Cubikon): HP, shield, EP, honor, credits and uridium are identical in the wiki, Borja, Kluk and Muffin. Boss = 4x base, Uber = 8x base.
- Lasers (classic): LF-1 40, MP-1 60, LF-2 100, LF-3 150, LF-4 200.
- Ammo: x1/x2/x3/x4, RSB x6 with a 3000 ms cooldown (Kalaazu `items.cooldown`), SAB drains shield.
- Rockets: R-310 1000, PLT-2026 2000, PLT-2021 4000, PLT-3030 6000. Ranges 400/550/600 come from Muffin only.
- Speed gens: G3N-1010 +2, 2010 +3, 3210 +4, 3310 +5, 6900 +7, 7900 +10.
- Shield gens (classic): A01 1000/40%, A02 2000/50%, A03 5000/60%, B01 4000/70%, B02 10000/80%. The current wiki gives B01 9500 and adds B00, B03 and FS-01..03.
- Portal network for X-1 to X-8: 63 of the 95 map-pairs agree exactly across all sources.
- Goliath: 256000 HP, speed 300, 15 lasers, 15 gens, 3 extras, 1500 cargo.

**Medium:**
- Other classic ships (see conflicts below).
- NPC speed. The wiki and Borja mostly agree; Kalaazu has no real speed values (all 300).
- NPC damage. Sources give ranges that differ by about 20%. `damage` = max of the chosen range; `damage_min` is included.
- Aggressiveness. See below.
- Station positions (Kalaazu): 1-1 (1000,1000), 2-1 (19000,1000), 3-1 (19000,12000), 1-8 (1000,6000), 2-8 (10000,1000), 3-8 (19000,6000). The 4-x stations come from Yusuf. EpicOrbit puts the 1-1 base at (2000,2000).
- 4-4 gate coordinates (Borja, with Yusuf matching for 4-1/4-2/4-3): 4-1 gate (19200,13400), 4-2 gate (21900,11900), 4-3 gate (21800,14500), 1-5 gate (7000,13500), 2-5 gate (28000,1300), 3-5 gate (28000,25100).
- 4-5 and 5-x portals come from Kalaazu only.

**Low:**
- **NPC spawn counts per map.** The real server values were never public, so every emulator made up its own numbers:
  - Kalaazu, used as `npcs`: 1-1 has 80 Streuner; 1-2 has 40 Streuner, 40 Lordakia and 4 of each boss; and so on.
  - Borja (in `npcs_alt.borja`) is smaller: 50 Streuner on 1-1.
  - The relative mix is consistent across sources and matches the wiki alien lists.
- Wiki `spawn_spots_wiki`. The table is in minimap units; I multiplied by 100, which assumes a 208x130 grid on a 20800x12800 map. Only 1-x is well populated.
- Pirate NPCs (Interceptor, Barracuda, ...). The wiki gives current values; only Borja/Kalaazu (one lineage) provide classic values.

## Conflicts found

- **Map size.** All emulators use 20800x12800 (big maps 41600x25600). CONTRACT says 21000x13100 / 42000x26200. These are probably the client maps-config bounds; keep the client values for rendering. Portal coordinates were authored for the 20800x12800 space.
- **Streuner sheet/gfx.** Kluk, Borja and Kalaazu use gfx 84; Muffin (2009) uses gfx 2. `ship84` exists in the sheet index.
- **Streuner speed.** Wiki and Muffin say 280; Borja and Zeta say 270. Chose 280.
- **StreuneR (1-8 alien).** Classic stats are 20000/10000 with 3200 EP and 6400 credits (4 dumps agree). The current wiki has a buffed version (40000/30000, 6000 EP, 12000 credits) and says it is now aggressive. Classic was passive. Chose classic.
- **Protegit.** Emulators say 50000/40000 (4 agree); the wiki says 60000/50000. Speed varies: 380 (Borja), 420 (Muffin), about 500 (wiki).
- **Battleray.** Wiki 330000/260000 (current); Borja/Kalaazu 500000/400000.
  - Several other pirates have different rewards in the wiki and the emulators. Pirates follow the wiki, because Borja/Kalaazu count as one vote.
- **Century Falcon.** Wiki 36M/27M (current); Borja 4M/3M.
- **UFO.** Wiki 10M/10M; Borja/Kalaazu 3.2M/2.4M. Chose emulator.
- **Boss rewards typos in Borja/Kalaazu.** Boss Kristallon 1634400 vs 1638400; Boss Sibelon 408600 vs 409600; Uber Kristallon 3268800 vs 3276800. Corrected to the wiki/Kluk value.
- **Boss Mordon credits.** Borja 51200; wiki and Kluk 25600. Chose 25600.
- **Aggressiveness.** Sources disagree. Kalaazu `ai` (1 = passive, 2 = aggressive), Borja `isNeutral`, Muffin/Kluk `IA` and Yusuf `aggressive` were combined with the wiki text, giving this classic set:
  - Passive: Streuner, Lordakium, Kristallon, Cubikon, StreuneR.
  - Aggressive: Lordakia, Saimon, Mordon, Devolarium, Sibelon, Sibelonit, Kristallin, Protegit.
  - Boss and Uber variants inherit the base alien's setting.
  - Muffin marks Mordon passive, but Borja, Kalaazu and Kluk mark it aggressive.
  - All votes are in `aggressive_votes`.
- **Ships, classic vs 2009 vs current.** Chosen values are hp / speed / lasers / gens / extras / cargo:

  | ship | chosen | conflict |
  |---|---|---|
  | Leonov | 64000 / 360 / 6 / 6 / 1 / 500 | Muffin 160000 HP; Kalaazu 2 extras |
  | Liberator | 16000 / 330 / 4 / 6 / 2 / 400 | Borja speed 300 |
  | Piranha | 64000 / 360 / 6 / 8 / 2 / 600 | Borja and Muffin say 5 lasers / 7 gens |
  | Nostromo | 120000 / 340 / 7 / 10 / 3 / 700 | Borja and Muffin say 6 / 8 |
  | BigBoy | 160000 / 260 / 8 / 15 / 3 / 700 | Kalaazu and Muffin 128000 HP / 7 lasers |
  | Citadel | cargo 4000 | Kalaazu 3000 |
  | Yamato, Defcom | classic small ships (Yamato 8000 / 340 / 2 / 2) | the current wiki has reworked versions (Yamato 260k / 8 lasers / 12 gens) |
- **Laser damage in the CONTRACT.** `laserDamage: 175` is the *current* LF-3 value (the wiki says it has +15% vs NPCs). Classic LF-3 is 150 and LF-4 is 200. `equipment.json.contractMapping` notes this.
- **Shield gen count in the CONTRACT.** Shield = gens × 10000 corresponds to SG3N-B02 (80% absorption). Speed +10 per gen corresponds to G3N-7900. Both match.
- **Portal oddities.**
  - Kalaazu has a self-portal on 4-3; it was dropped.
  - 3-4 → 3-2 has arrival (2000,7000) in Kalaazu but (2000,2000) elsewhere; normalised to the return gate.
  - 5-3 → 1-8 / 2-8 / 3-8 have no return portal in any source (one-way).
  - Map 52 (GG Beta) → 1-1 was skipped.

## Not found or not covered

- Laser range (700 in CONTRACT) and NPC aggro radius: not stated in any source I fetched.
- NPC respawn time: not in the dumps.
- Exact real-server NPC counts and spawn areas: never published (see the Low confidence section).
- Shield regen rate: EpicOrbit uses 4% per tick for SG3N and 4.25% for FS. This is an emulator choice and not confirmed.
- Planet and background data: not in these sources; use the client's maps-config.
