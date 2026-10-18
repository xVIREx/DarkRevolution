"""Export lasers, rockets, NPC shots and particle FX from the Unity client into
client/public/assets3d/scene/{lasers,rockets,fx}/ and merge "lasers", "rockets", "npcShots", "fx" into
client/public/assets3d/manifest3d.maps.json.

What the Unity client actually does (v0.1.4):
  * lasers  = LaserBase prefab: one SpriteRenderer lying flat on the gameplay plane (facing +Y), sprite PPU = 1
              so sprite pixels == world units (laser0 = 78 x 12 units). Sprite pivot is (1, 0.5) = its right edge;
              the sprite's +X axis points BACKWARD (Unity -Z), so the sprite extends from the pivot towards the
              travel direction and the texture's LEFT edge (u=0) is the head of the bolt.
  * rockets = RocketBase prefab: the same flat sprite ("Model") plus a second copy rotated 90 deg about the
              travel axis ("Model2", vertical) -> a cross-billboard, + TrailRenderer (rocket1..5 prefabs in
              laser_assets: width 10 -> 0.6, 0.5 s, orange -> transparent white). There is NO 3D rocket mesh.
  * explosions / impacts / engine thrusters = Shuriken ParticleSystems (simplified by tools/scene_ps.py).
Coordinates are three.js (z negated vs Unity, quats (-x,-y,z,w)). Unity shapes emit along local +Z, which is
local -Z in three.js after conversion.
"""
import os, sys, json, math
import numpy as np
import UnityPy
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
import scene_ps, scene_glb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.path.expanduser('~/darkorbit-client/extracted/DarkOrbit_Version0.1.4/DarkOrbit_Data/StreamingAssets/aa/BuildTarget/')
B = {
    'laser': BT + 'laser_assets_all_3e8b6fab459a02cf231f6d40ffbb9a56.bundle',
    'rocket': BT + 'rocket_assets_all_8deaf8e82681c8ea19f8510c4220216c.bundle',
    'info': BT + 'infoeffect_assets_all_be1d778e05502a74778fff1f48fa1514.bundle',
    'ship': BT + 'ship_assets_all_e0a5af739b6ee61c579327599dd20173.bundle',
}
SHADERB = [BT + 'shader_assets_all_2ff9c3b6abb7dbd21da01381f5bbadb8.bundle',
           BT + '60c4f45ba9e505496029dec1211f2b48_unitybuiltinshaders_e0b30e589ac1ab03f272ca55a25da4d5.bundle',
           BT + 'atlas_assets_all_98e15d33c1d8c95a67788e7140e5a376.bundle']   # sprite atlases
OUT = os.path.join(ROOT, 'client/public/assets3d')
MAN = os.path.join(OUT, 'manifest3d.maps.json')

def comps(go):
    r = []
    for c in go.m_Components:
        p = c.component if hasattr(c, 'component') else c
        try: r.append(p.read())
        except Exception: pass
    return r
def ct(c): return c.object_reader.type.name
def shader_name(m):
    try: return m.m_Shader.deref().read().m_ParsedForm.m_Name
    except Exception: return None

_saved = {}
def save_img(im, rel):
    if rel in _saved: return rel
    p = os.path.join(OUT, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    im.convert('RGBA').save(p, 'WEBP', quality=90, method=5); _saved[rel] = 1
    return rel
def save_tex(t, sub, maxs=512):
    rel = f'scene/{sub}/{t.m_Name.replace(" ", "_")}.webp'
    if rel in _saved: return rel
    im = t.image
    if max(im.size) > maxs:
        f = maxs / max(im.size); im = im.resize((max(1, int(im.width*f)), max(1, int(im.height*f))), Image.LANCZOS)
    return save_img(im, rel)
def save_sprite(sp, sub):
    nm = sp.m_Name.replace(" ", "_")
    if nm.isdigit(): nm = f'{sub}_{nm}'
    rel = f'scene/{sub}/{nm}.webp'
    return save_img(sp.image, rel)

def trs(tr):
    p, q, s = tr.m_LocalPosition, tr.m_LocalRotation, tr.m_LocalScale
    return {"pos": [round(p.x, 3), round(p.y, 3), round(-p.z, 3)], "quat": [round(-q.x, 5), round(-q.y, 5), round(q.z, 5), round(q.w, 5)],
            "scale": [round(s.x, 4), round(s.y, 4), round(s.z, 4)]}

def mat_info(m):
    tex = None; tint = None
    for k, v in m.m_SavedProperties.m_TexEnvs:
        if k == '_MainTex' and v.m_Texture.path_id:
            try: tex = save_tex(v.m_Texture.read(), 'fx', 512)
            except Exception: tex = None
    for k, c in m.m_SavedProperties.m_Colors:
        if k in ('_TintColor', '_Color'):
            col = [round(c.r, 3), round(c.g, 3), round(c.b, 3), round(c.a, 3)]
            if k == '_TintColor' or tint is None: tint = col
    return tex, tint

def trail_info(tr_comp):
    t = tr_comp.object_reader.read_typetree(); p = t['m_Parameters']
    mat = tr_comp.m_Materials[0].read() if tr_comp.m_Materials else None
    tex, tint = mat_info(mat) if mat else (None, None)
    return {"time": round(t['m_Time'], 3), "minVertexDistance": round(t.get('m_MinVertexDistance', 0.1), 3),
            "width": round(p['widthMultiplier'], 3), "widthCurve": scene_ps.sample(p['widthCurve']['m_Curve'], 6, 1.0),
            "gradient": scene_ps.gradient(p['colorGradient']), "textureMode": p.get('textureMode', 0),
            "tex": tex, "material": mat.m_Name if mat else None, "shader": shader_name(mat) if mat else None,
            "blend": scene_ps.blend_of(shader_name(mat)) if mat else 'alpha', "tint": tint,
            "note": "Unity TrailRenderer: ribbon facing the camera, width = width*widthCurve(t along trail 0=head..1=tail), colour = gradient(t), points expire after `time` s"}

def export_prefab(env, key, sub='fx', meshes=True):
    """Particle prefab -> {emitters:[...], meshes:[...], sprites:[...]} (transforms relative to prefab root)."""
    root = None
    for p, o in env.container.items():
        if p.endswith('/' + key + '.prefab'): root = o.read(); break
    if root is None: return None
    out = {"emitters": [], "meshes": [], "sprites": [], "trails": []}
    subrefs = {}
    def walk(go, path, depth):
        cs = comps(go)
        tr = next(c for c in cs if ct(c) in ('Transform', 'RectTransform'))
        node = {"name": go.m_Name, "path": path, **trs(tr)}
        if not go.m_IsActive: return
        ps = next((c for c in cs if ct(c) == 'ParticleSystem'), None)
        if ps is not None:
            t = ps.object_reader.read_typetree()
            pr = next((c for c in cs if ct(c) == 'ParticleSystemRenderer'), None)
            rt = pr.object_reader.read_typetree() if pr else None
            mat = pr.m_Materials[0].read() if pr and pr.m_Materials and pr.m_Materials[0].path_id else None
            tex, tint = mat_info(mat) if mat else (None, None)
            em = scene_ps.simplify(t, rt, tex, shader_name(mat) if mat else None, tint)
            if rt and em.get('render') == 'mesh':
                try:
                    mh = pr.m_Mesh.read(); em['mesh'] = save_mesh(mh)
                except Exception: em['mesh'] = None
            if t['SubModule']['enabled']:
                for se in t['SubModule']['subEmitters']:
                    subrefs[se['emitter']['m_PathID']] = {"of": path, "type": ["birth", "collision", "death", "trigger", "manual"][se.get('type', 0)] if se.get('type', 0) < 5 else se.get('type')}
            out['emitters'].append({**node, "pid": ps.object_reader.path_id, "emitter": em})
        mf = next((c for c in cs if ct(c) == 'MeshFilter'), None); mr = next((c for c in cs if ct(c) == 'MeshRenderer'), None)
        if meshes and mf is not None and mr is not None:
            try:
                mh = mf.m_Mesh.read(); mat = mr.m_Materials[0].read(); tex, tint = mat_info(mat)
                out['meshes'].append({**node, "glb": save_mesh(mh), "tex": tex, "tint": tint, "shader": shader_name(mat), "blend": scene_ps.blend_of(shader_name(mat))})
            except Exception as e: pass
        sr = next((c for c in cs if ct(c) == 'SpriteRenderer'), None)
        if sr is not None:
            try:
                sp = sr.m_Sprite.read()
                col = sr.object_reader.read_typetree().get('m_Color')
                out['sprites'].append({**node, "tex": save_sprite(sp, sub), "size": [round(sp.m_Rect.width / sp.m_PixelsToUnits, 3), round(sp.m_Rect.height / sp.m_PixelsToUnits, 3)],
                                       "pivot": [round(sp.m_Pivot.x, 3), round(sp.m_Pivot.y, 3)], "color": scene_ps.col(col) if col else None})
            except Exception: pass
        trc = next((c for c in cs if ct(c) == 'TrailRenderer'), None)
        if trc is not None: out['trails'].append({**node, **trail_info(trc)})
        for ch in tr.m_Children:
            cg = ch.read().m_GameObject.read(); walk(cg, path + '/' + cg.m_Name, depth + 1)
    walk(root, root.m_Name, 0)
    for e in out['emitters']:
        if e['pid'] in subrefs: e['subEmitter'] = subrefs[e['pid']]
        del e['pid']
    for k in list(out):
        if not out[k]: del out[k]
    durs = [e['emitter']['duration'] + max(e['emitter']['lifetime']) for e in out.get('emitters', []) if not e['emitter']['loop']]
    if durs: out['totalTime'] = round(max(durs), 3)
    out['loop'] = any(e['emitter']['loop'] for e in out.get('emitters', []))
    return out

_glbs = {}
def save_mesh(mesh):
    rel = f'scene/fx/{mesh.m_Name}.glb'
    if rel in _glbs: return rel
    p = os.path.join(OUT, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    pos, nrm, uv, subs = scene_glb.to_three(*scene_glb.unity_mesh_arrays(mesh))
    scene_glb.write_glb(p, [{"name": mesh.m_Name, "pos": pos, "nrm": nrm, "uv": uv, "subs": subs}]); _glbs[rel] = 1
    return rel

def sprites_by_name(env):
    d = {}
    for o in env.objects:
        if o.type.name == 'Sprite':
            s = o.read(); d.setdefault(s.m_Name, s)
    return d

def main():
    man = json.load(open(MAN)) if os.path.exists(MAN) else {}
    # ---------------- lasers ----------------
    env = UnityPy.load(B['laser'], *SHADERB)
    spr = sprites_by_name(env)
    LZ = {"red": "laser0", "blue": "laser1", "green": "laser2", "white": "laser3", "sab": "laser4", "rsb": "laser5"}
    lasers = {"layout": {"plane": "flat on the gameplay plane (y=0 at the laser point height), facing +Y",
                         "lengthAxis": "sprite width runs along the travel direction; texture u=0 (left edge) is the HEAD",
                         "pivot": "sprite pivot (1,0.5) = right edge = TAIL: place the tail at the bolt position and extend `size[0]` units forward",
                         "units": "PPU=1: size is in world units", "blend": "Sprites/Default (alpha, straight); additive looks closer to the in-game glow",
                         "speed": "not in data; Unity client flies bolts from laser point to target in ~0.3 s"}}
    for k, n in LZ.items():
        s = spr[n]
        lasers[k] = {"tex": save_sprite(s, 'lasers'), "size": [s.m_Rect.width / s.m_PixelsToUnits, s.m_Rect.height / s.m_PixelsToUnits],
                     "pivot": [s.m_Pivot.x, s.m_Pivot.y], "sprite": n}
    lasers['extra'] = {}
    for n in ('laser6', 'skillLaser0', 'skillLaser1', 'skillLaser2', 'skillLaser3', 'skillLaser4', 'skillLaser5', 'skillLaser6', 'laser7_sar01', 'laser7_sar02', 'dronelaser0'):
        if n in spr:
            s = spr[n]; lasers['extra'][n] = {"tex": save_sprite(s, 'lasers'), "size": [s.m_Rect.width, s.m_Rect.height], "pivot": [s.m_Pivot.x, s.m_Pivot.y]}
    # rocket trail + NPC shots from laser_assets
    rp = export_prefab(env, 'rocket1', 'rockets')
    trail = rp['trails'][0] if rp and rp.get('trails') else None
    npc = {}
    for k in ('sibelonShot', 'devolariumShot'):
        p = export_prefab(env, k, 'npcshots')
        frames = sorted({save_sprite(s, 'npcshots') for n, s in spr.items() if n.lower().startswith(k.lower())})
        if p:
            sp = p.get('sprites', [{}])[0]
            npc[k] = {"sprite": frames[0] if frames else sp.get('tex'), "size": sp.get('size'), "pivot": sp.get('pivot'), "quat": sp.get('quat'),
                      "frames": frames, "fps": 12, "note": "SpriteRenderer rotated 90deg about X (lies flat, facing up), Animator cycles frames at 12 fps"}
    # ---------------- rockets ----------------
    env2 = UnityPy.load(B['rocket'], *SHADERB)
    spr2 = sprites_by_name(env2)
    base = export_prefab(env2, 'RocketBase', 'rockets')
    rockets = {"layout": {"parts": base.get('sprites') if base else None,
                          "note": "RocketBase: 'Model' = flat sprite (facing +Y) and 'Model2' = same sprite rotated 90deg about the travel axis (vertical) -> cross billboard. "
                                  "Same axis/pivot convention as lasers (u=0 = nose, pivot = tail). Trail child sits 26 units behind the nose-pivot. "
                                  "No 3D rocket mesh exists in the client.",
                          "heatSeekingMarker": "_heatSeeking: red dot sprites 25 units ahead (only for homing rockets)"},
               "trail": trail}
    for k, n in {"r310": "rocket1", "plt2026": "rocket2", "plt2021": "rocket3", "plt3030": "rocket4"}.items():
        s = spr2[n]
        rockets[k] = {"tex": save_sprite(s, 'rockets'), "size": [s.m_Rect.width / s.m_PixelsToUnits, s.m_Rect.height / s.m_PixelsToUnits],
                      "pivot": [s.m_Pivot.x, s.m_Pivot.y], "sprite": n, "glb": None, "scale": 1, "trail": "rockets.trail"}
    # ---------------- particle FX ----------------
    env3 = UnityPy.load(B['info'], *SHADERB)
    fx = {"note": "Particle effects simplified from Unity Shuriken (see tools/scene_ps.py for field meanings). Ranges are [min,max]; "
                  "*OverLife curves are [[t,v]..] over normalised particle age; gradients {color:[[t,r,g,b]..], alpha:[[t,a]..]}. "
                  "Emitters marked subEmitter should be spawned by their parent (birth/death) rather than at t=0. "
                  "scale: prefab-local; effects are authored around ship size (~100-200 units)."}
    want = {"explosion": "explosion0", "explosionSmall": "explosion1", "explosionLarge": "explosion2",
            "impactHullLaser": "impact_hull_laser", "impactHullRocket": "impact_hull_rocket", "impactShield": "impact_shield",
            "rocketDamage": "rocketDamage1", "rocketTrailSmoke": "rocket_trail_1", "shield": "shield", "gateJump": "gate_jump",
            "warpShip": "warp_ship", "thruster": "thruster"}
    for i in range(10): want[f"explosion_{i}"] = f"explosion{i}"
    for k, n in want.items():
        p = export_prefab(env3, n, 'fx')
        if p: fx[k] = {"prefab": n, **p}
        else: print('missing fx', n)
    rockets['impact'] = "fx.impactHullRocket"
    fx['shieldHit'] = "fx.impactShield"
    # engine thruster + trail from the Goliath ship prefab
    env4 = UnityPy.load(B['ship'], *SHADERB)
    g = export_prefab(env4, 'ship_goliath_3D', 'fx', meshes=False)
    if g:
        em = [e for e in g.get('emitters', []) if 'engine_0' in e['path']]
        tr = [t for t in g.get('trails', []) if 'engine_0' in t['path']]
        fx['engineThruster'] = {"source": "ship_goliath_3D/engine_0/BlueThruster", "emitter": em[0]['emitter'] if em else None,
                                "note": "attach at each model engine_* node; Unity engine_* nodes are rotated 180deg about Y so particles stream backward"}
        fx['engineTrail'] = {"source": "ship_goliath_3D/engine_0/EngineTrail", **({k: v for k, v in tr[0].items() if k not in ('name', 'path')} if tr else {}),
                             "offset": "18 units behind the engine node", "colorFromShip": "lib_ships display3D engineTrailColor (e.g. 0x5ac3d8) tints the trail when present"}
    # ---------------- skybox (background_assets ScenePrefab) ----------------
    env5 = UnityPy.load(BT + 'background_assets_all_2eae3f2cb07d3b25da31348e79df5320.bundle', *SHADERB)
    sky = {}
    for o in env5.objects:
        if o.type.name == 'Mesh' and o.peek_name() == 'pCube1':
            me = o.read(); rel = 'scene/skybox/skybox_cube.glb'; pth = os.path.join(OUT, rel); os.makedirs(os.path.dirname(pth), exist_ok=True)
            pos, nrm, uv, subs = scene_glb.to_three(*scene_glb.unity_mesh_arrays(me))
            scene_glb.write_glb(pth, [{"name": "skybox", "pos": pos, "nrm": nrm, "uv": uv, "subs": subs}]); sky['glb'] = rel
        if o.type.name == 'Texture2D' and o.peek_name().startswith('skybox'):
            t = o.read(); sky[t.m_Name.replace('skybox_', '')] = save_tex(t, 'skybox', 1024)
        if o.type.name == 'Material' and o.peek_name() == 'ScrollingSkybox':
            m = o.read(); c = dict((k, [round(v.r, 4), round(v.g, 4), round(v.b, 4), round(v.a, 4)]) for k, v in m.m_SavedProperties.m_Colors)
            f = dict(m.m_SavedProperties.m_Floats)
            sky['shader'] = 'ScrollingSkybox'; sky['speed1'] = round(f.get('_Speed1', 0), 4); sky['speed2'] = c.get('_Speed2'); sky['tint'] = c.get('_TintColor')
    sky['scale'] = 200000
    sky['note'] = ("Unity ScenePrefab/skybox_geometry: inward-viewed subdivided cube (0.85 units) scaled 200000 around the origin, "
                   "ScrollingSkybox shader = stars texture modulated by two scrolling mask lookups (_Speed1 / _Speed2 uv scroll per second). "
                   "It lies beyond the map camera far plane (80000), so in map view it is effectively unused; the per-map background quads are the real backdrop. "
                   "Optional: render as a camera-centred starfield sphere with depthWrite off for extra depth.")
    man['skybox'] = sky
    for M in man.get('maps', {}).values():
        M['skybox'] = {"ref": "skybox", "clearColor": "#000000", "used": False}
    man['lasers'] = lasers; man['rockets'] = rockets; man['npcShots'] = npc; man['fx'] = fx
    json.dump(man, open(MAN, 'w'), indent=1)
    print('fx keys', list(fx)); print('ok')

if __name__ == '__main__':
    main()
