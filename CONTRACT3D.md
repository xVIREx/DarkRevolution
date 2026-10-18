# Modern (3D) look — contract

Goal: look like the modern Unity DarkOrbit client (its 3D mode), not the classic 2D sprites.
The 2D path stays as a fallback (toggle in settings). Server/protocol unchanged (see CONTRACT.md).

Source of truth in the client data:
- `extracted/xml/lib_ships.txt` — per asset `display3D > mesh geometry=… texture=… scale=… visualSize=…`, shader refs
  (rimLight/outline), particles; assets correspond 1:1 to the 2D `display2D srcKey` (= sheet id used in data/*.json).
- `extracted/xml/lib_maps.txt` — per map `display3D`: `cameraZone`, `plane` (resKey, sphericalPhi/Theta/R, scale, rotation,
  blendMode, alphaBlending), `mesh` (geometry, texture, x/y/z, scale, rotation), `lensFlare`, particles.
- `extracted/xml/maps-config.txt` — per map `display3D templateId` + `light color diffuse specular ambientColor ambient tilt pan`, starfield.
- `extracted/xml/lib_assets.txt`, `lib_portals.txt`, `lib_battlestation.txt`, `lib_collectables.txt`, `lib_drones.txt`.
- Bundles: ship_assets (65 ship materials/meshes), npc_assets, drone_assets, pet_assets, building_assets, portals_assets,
  collects_assets, mapassetbackgrounds, map_assets, background_assets (skybox), 3dtexture (9.5k textures
  `<name>_{diffuse,normal,specular,glow,alpha}_{128,256,512,1024}`), shader_assets, laser_assets, billboard_assets,
  infoeffect_assets, ui_assets.

## Files (all under `client/public/assets3d/`, served at `/assets3d/`)

```
models/<geometry>.glb          geometry only (+ named child nodes such as laserpoint_*, engine_*), Y-up, meters = DO units
tex/<texture>_<kind>.webp      kind ∈ diffuse|normal|specular|glow|alpha, 512 px preferred (fallback 256/128)
scene/<file>                   map scene textures/meshes
manifest3d.json
```

`manifest3d.json`:
```jsonc
{
  "forward": "+x",                // model axis that is the ship's nose after applying `rot` below
  "models": {                      // KEYED BY THE 2D SHEET ID used in data/ships.json (design.sheet) and data/npcs.json (sheet)
    "ship_goliath": { "glb": "models/goliath.glb", "scale": 0.7, "visualSize": 1.4,
                      "tex": { "diffuse": "tex/goliath_diffuse.webp", "normal": "...", "specular": "...", "glow": "..." },
                      "rim": { "color": "#ff0000", "strength": 2, "power": 1 },   // optional, from lib_ships <shader>
                      "rot": [0, 0, 0] }                                          // optional euler fix (radians)
  },
  "maps": {                        // keyed by map id (string)
    "1": { "light": { "color": "#a3ffff", "diffuse": 0.8, "specular": 1.1, "ambientColor": "#ff855c", "ambient": 0.5, "tilt": 100, "pan": 35 },
           "skybox": { "stars": "scene/skybox_stars.webp", "nebula": "...", "tint": "#..." },
           "planes": [ { "tex": "scene/background1.webp", "phi": -90, "theta": 30, "r": 50010, "scale": 50000, "rotX": 45, "blend": "add", "alpha": false } ],
           "meshes": [ { "glb": "scene/asset-mmo-phobos.glb", "tex": {...}, "x": 16520, "y": -4000, "z": 2000, "scale": 1, "rot": [55,0,0] } ],
           "lensflares": [ { "x": 34000, "y": 48000, "z": 26000, "type": 6 } ] }
  },
  "stations": { "mmo": { "glb": "...", "tex": {...}, "scale": 1 } , "eic": …, "vru": … },
  "portal":   { "glb": "...", "tex": {...}, "scale": 1 },
  "box":      { "glb": "...", "tex": {...} },
  "lasers":   { "red": "tex/…", … },     // 3D laser beam textures (additive)
  "fx":       { "engineTrail": "...", "explosion": "...", "shieldHit": "..." }
}
```
World mapping: game (x, y) with +y down → three.js (x, 0, y) on the XZ plane (Y is up). Heading angle a = atan2(dy,dx)
rotates around −Y... renderer agent defines the exact sign and documents it in client/src/render3d/README.md.

## Ownership
- models agent: `client/public/assets3d/models|tex`, `manifest3d.json` keys `forward`, `models`, `stations`, `portal`, `box`; scripts `tools/m3d_*`.
- scene agent: `client/public/assets3d/scene/`, writes `client/public/assets3d/manifest3d.maps.json` (+ `lasers`, `fx` keys in it);
  the renderer merges both manifests. Scripts `tools/scene_*`.
- ui agent: `client/public/assets/ui/`, `client/src/hud/**`, `client/src/style.css`, `client/src/hangar.ts`; scripts `tools/ui_*`.
- renderer agent: `client/src/render3d/**`, and the minimal glue in `world.ts`/`entities.ts`/`effects.ts`/`main.ts` to switch renderers.
