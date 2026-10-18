# render3d — modern (Unity-style) 3D renderer

Default renderer. `?r=2d` (or `localStorage['do.renderer']='2d'`, or `setRendererMode('2d')` from `mode.ts`,
also `window.__setRenderer('2d')`) switches back to the classic sprite renderer; `?r=3d` forces 3D.
Browsers without WebGL2 fall back to 2D.

## Wiring

- `World` (world.ts) owns the `WebGLRenderer`; in 3D mode it creates `Renderer3D` (`world.r3d`) and forwards
  `resize / setMap / update / render / screenToWorld / worldToScreen / nearestPortal`. The 2D scene is not built.
- `EntityManager` still does snapshot interpolation; in 3D mode views are "lite" (no 2D sprites/labels).
  `Entities3D.sync()` reads `ents.views` every frame (x, y, a, snap) and writes `view.radius` from the model bounds
  so the existing `ents.pick()` picking keeps working.
- `Effects.laser/rocket/explosion` delegate to `Fx3D`; damage numbers stay HTML, projected with `world.worldToScreen`.
- Picking hooks for input: `world.screenToWorld(sx, sy)` (ray ∩ plane y=0) and `world.pickEntity(sx, sy)`
  (ray vs entity bounding spheres, excludes own ship). Debug handle: `window.__r3d` (`__r3d.stats()`).

## Coordinates

- Game (x, y), +y **down** → three.js `(x, 0, y)`: the game plane is XZ, **Y is up**, game +y = three +z.
  Same convention as the scene agent (`manifest3d.maps.json` `coords`), whose pos/quat values are used verbatim.
- Camera: target `(camX, 0, camY)`, positioned south (+z) and above: `pos = target + (0, sin(p)·d, cos(p)·d)`,
  `lookAt(target)`. Screen-up = world −y (north), as in 2D. fov / pitch / distance from
  `manifest.camera` (`fov`, `pitchDeg`, `distance`; Unity: fov 30 vertical, 45°, 1739.5), defaults fov 40 / 58°.
  `d = distance / zoom` when `distance` is known (zoom 1 = Unity framing), else `d` is chosen so that
  `zoom` = screen px per world unit at the target (2D meaning).
- Heading: server angle `a = atan2(dy, dx)` (0 = +x, increasing clockwise on screen). Models have their nose on
  local **+x**; `yaw.rotation.y = −a` maps +x to `(cos a, 0, sin a)`. Banking: `bank.rotation.x = k · da/dt`
  (turning right on screen rolls the right wing, local +z, down), clamped ±0.55 rad, smoothed.
  Node hierarchy per entity: `root (position) → yaw → bank (+bob) → model`.
- Light: `dir` from the maps manifest if present, else +z rotated by `tilt` about X then `pan` about Y (Away3D);
  DirectionalLight intensity `diffuse·π`, AmbientLight `ambient·π` (three's Lambert divides by π);
  Phong specular colour = `specular/diffuse` × (1 with a specular map, 0.25 without).
- Legacy (contract-style) planes without `pos/quat`: spherical around the map centre, θ from straight down (−Y),
  φ around Y (−90° = −z / north), quad looks at the centre.

## Materials / colour

Phong (`makeDoMaterial`): diffuse (sRGB), normal (linear, OpenGL +Y, derivative tangents), specular mask (linear),
glow → `emissiveMap` (sRGB, ×1.6 so bloom picks it up), alpha → `alphaMap` + alphaTest, rim light injected via
`onBeforeCompile` (`pow(1−N·V, power)·strength·color`). Textures are loaded with `flipY=false` (glTF UVs);
scene planes/flares use `flipY=true` (Unity quads, UV origin bottom-left). Render: HalfFloat MSAA target →
RenderPass → UnrealBloomPass (0.55 / 0.45 / threshold 0.82) → OutputPass (sRGB, no tone mapping);
`?aa=fxaa` adds FXAA. Labels/HP bars and lens flares are an orthographic pixel-space overlay drawn after post.

## Asset fallback order

Ships / NPCs / drones (keyed by the 2D sheet id `snap.s`; drones by `drone_<type>_0`, `drone_<type>`, …):
1. `manifest3d.json models[sheet]` → `models[lower-case]` → `models[base]` (design suffix after `-` stripped)
   — glb in world units (`bounds` present: raw scale, pivot kept); otherwise normalised to `size`,
   `visualSize × 105`, or the 2D sheet size. Textures: `mainMaterial` gets `tex`; other materials use
   `materials[]` by name, then the texture names in glTF material extras.
2. While loading / if missing: the 2D rotation sheet as a camera-facing billboard (frame from heading).
3. No sheet either: a coloured placeholder cone.

Map scene (`manifest3d.maps.json maps[id]`, rebuilt live when a manifest changes — polled every 8 s while a file is
missing, 30 s otherwise): `backgrounds` + `planes` (pos/quat quads), `meshes` (glb, pos/quat/scale, anim spins,
randomRotYDeg), `tileLayers` (flat cloud tiles from an atlas, one merged mesh per layer), `lensflares`
(sprite quad + Unity flare atlas elements in screen space), `starfield` colour, `light`. Without backgrounds/planes/
skybox: the 2D background image and 2D planets as far camera-facing billboards at depth `d·(pFactor−1)` (same
parallax as 2D), plus 2D lens-flare points. Dust particles are always on (wrapping volume around the camera target).

Stations: `stations[faction].parts` (hq, hangar, repair, trade, mission, turrets) placed with an **approximate**
home-base layout (`STATION_LAYOUT` in scene3d.ts — DO sends the real layout from the server) → `stations[f].glb` →
2D station image billboard. Portal: `portal` glb → animated 2D portal sheet billboard.

Backdrop: items with `backdrop: true` (or listed in `maps[id].backdrop.members`) follow the scene agent's rule
`pos' = pivot + (pos − pivot)·fitScale + follow·(camTarget − mapCentre)`, `scale' = scale·fitScale` every frame;
backgrounds use `uvRect`. Background quads live in a separate `bgScene` drawn first (depth cleared before the main
scene), sorted deepest first.

Lasers: `lasers[color]` with `size` = flat quads on the plane (u=0 = head), ~0.3 s flight → beam texture without
size (tinted) → 2D laser sprite → procedural beam; fired from `laserpoint_*` nodes (alternating), else two nose
offsets; drones fire small bolts with their owner. Rockets: `rockets[id]` {tex,size} = two crossed sprites
(flat + vertical) + `rockets.trail` ribbon (0.5 s, width 10, orange) + `fx.rocketTrailSmoke` particles; impact
`fx.impactHullRocket` → (glb rocket → 2D rocket sprite, own smoke, small explosion). Explosions: `fx.explosion` /
`fx.explosionLarge` particle prefabs (particles.ts plays the simplified Shuriken emitters) → `fx.explosion` sheet →
2D `explosion`/`explosionSmall` billboard + burst; always a pooled point-light flash. Laser impacts:
`fx.impactHullLaser` / `fx.impactShield`; shield hits (`shot.shd > 0`) also get a fresnel bubble.
Engine trails start at the `EngineTrail` nodes (else `engine_N`, else the rear), `fx.engineTrail` width/time.
Drones (`snap.dr`): DO "standard" formation from game.txt (`<formation id="0">`, scale 0.75), heading = owner's.

## Performance

Shared geometry/materials (template clones), texture/glTF caches, fixed point-light pool (no shader recompiles),
entities beyond ~1.3× the view footprint are hidden and skip trails/drones/labels, trails only within 2600 units.
