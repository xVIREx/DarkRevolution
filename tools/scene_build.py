"""Build 3D map scenes from the Unity client's map prefabs (map_assets bundle).

Output: client/public/assets3d/scene/** and client/public/assets3d/manifest3d.maps.json ("maps" + "camera").
Lasers/rockets/fx are added by tools/scene_fx.py (it merges into the same manifest).

Coordinates: Unity scene units == DarkOrbit world units. Unity is left-handed, y up, and the
gameplay plane is y=0 with unity.x = gameX, unity.z = -gameY.  three.js = (unity.x, unity.y, -unity.z)
= (gameX, height, gameY).  Quaternions: three = (-qx, -qy, qz, qw).  All values in the manifest are three.js.

usage: .venv/bin/python tools/scene_build.py [mapname ...]
"""
import os, sys, json, math, random, glob
import numpy as np
import UnityPy
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
import scene_ps, scene_glb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.path.expanduser('~/darkorbit-client/extracted/DarkOrbit_Version0.1.4/DarkOrbit_Data/StreamingAssets/aa/BuildTarget/')
MAPB = BT + 'map_assets_all_270c5f4881554d47620c1f3fbb8c9e10.bundle'
SHADERB = [BT + 'shader_assets_all_2ff9c3b6abb7dbd21da01381f5bbadb8.bundle',
           BT + '60c4f45ba9e505496029dec1211f2b48_unitybuiltinshaders_e0b30e589ac1ab03f272ca55a25da4d5.bundle']
OUT = os.path.join(ROOT, 'client/public/assets3d')
SCN = os.path.join(OUT, 'scene')
MANIFEST = os.path.join(OUT, 'manifest3d.maps.json')
CAM_H = 1230.0   # Main Camera local pos (0,1230,-1230), pitch 45 deg (level0)

def comp_list(go):
    out = []
    for c in go.m_Components:
        p = c.component if hasattr(c, 'component') else c
        try: out.append(p.read())
        except Exception: pass
    return out

def ctype(co): return co.object_reader.type.name
def mbname(co):
    try: return co.m_Script.read().m_ClassName
    except Exception: return '?'

def shader_name(m):
    try: return m.m_Shader.deref().read().m_ParsedForm.m_Name
    except Exception: return None

def blend_of(sh):
    s = (sh or '').lower()
    if 'additive' in s: return 'add'
    if 'blinnphong' in s: return 'opaque'
    return 'alpha'

# ---------------- transforms (Unity space) -----------------
def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return (aw*bx + ax*bw + ay*bz - az*by, aw*by - ax*bz + ay*bw + az*bx, aw*bz + ax*by - ay*bx + az*bw, aw*bw - ax*bx - ay*by - az*bz)
def qrot(q, v):
    x, y, z, w = q; vx, vy, vz = v
    ix = w*vx + y*vz - z*vy; iy = w*vy + z*vx - x*vz; iz = w*vz + x*vy - y*vx; iw = -x*vx - y*vy - z*vz
    return (ix*w + iw*-x + iy*-z - iz*-y, iy*w + iw*-y + iz*-x - ix*-z, iz*w + iw*-z + ix*-y - iy*-x)
def compose(parent, local):
    (pp, pq, ps), (lp, lq, ls) = parent, local
    sp = (lp[0]*ps[0], lp[1]*ps[1], lp[2]*ps[2])
    r = qrot(pq, sp)
    return ((pp[0]+r[0], pp[1]+r[1], pp[2]+r[2]), qmul(pq, lq), (ps[0]*ls[0], ps[1]*ls[1], ps[2]*ls[2]))
def trs(tr):
    p, q, s = tr.m_LocalPosition, tr.m_LocalRotation, tr.m_LocalScale
    return ((p.x, p.y, p.z), (q.x, q.y, q.z, q.w), (s.x, s.y, s.z))
def T3(w):
    """Unity world TRS -> three.js dict"""
    (p, q, s) = w
    return {"pos": [round(p[0], 2), round(p[1], 2), round(-p[2], 2)],
            "quat": [round(-q[0], 6), round(-q[1], 6), round(q[2], 6), round(q[3], 6)],
            "scale": [round(s[0], 4), round(s[1], 4), round(s[2], 4)]}

# ---------------- textures -----------------
_saved = {}
def save_tex(tex, sub='tex', maxsize=2048, alpha=True, quality=88):
    """Texture2D -> scene/<sub>/<name>.webp ; returns manifest-relative path."""
    name = tex.m_Name.replace(' ', '_')
    rel = f'scene/{sub}/{name}.webp'
    if rel in _saved: return rel
    path = os.path.join(OUT, rel); os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        im = tex.image
        if max(im.size) > maxsize:
            f = maxsize / max(im.size); im = im.resize((max(1, int(im.width*f)), max(1, int(im.height*f))), Image.LANCZOS)
        im = im.convert('RGBA') if alpha else im.convert('RGB')
        im.save(path, 'WEBP', quality=quality, method=5)
    _saved[rel] = tex.m_Name
    return rel

def mat_main(m):
    for k, v in m.m_SavedProperties.m_TexEnvs:
        if k == '_MainTex' and v.m_Texture.path_id:
            try: return v.m_Texture.read()
            except Exception: return None
    return None

def mat_color(m, key='_Color'):
    for k, c in m.m_SavedProperties.m_Colors:
        if k == key: return [round(c.r, 3), round(c.g, 3), round(c.b, 3), round(c.a, 3)]
    return None

EXT_TEX = {}   # (pathid) -> list of (manifest dict, key)  resolved by scene_tex3d.py
def mat_ext_textures(m):
    out = {}
    for k, v in m.m_SavedProperties.m_TexEnvs:
        if not v.m_Texture.path_id: continue
        kind = {'_Diffuse': 'diffuse', '_Normal': 'normal', '_Specular': 'specular', '_Glow': 'glow', '_AlphaMask': 'alpha', '_MainTex': 'diffuse'}.get(k)
        if not kind: continue
        try:
            t = v.m_Texture.read(); out[kind] = save_tex(t, 'tex', 1024)
        except Exception:
            out[kind] = f'@pathid:{v.m_Texture.path_id}'   # resolved later from 3dtexture bundle
    return out

def mat_floats(m, keys):
    return {k: round(v, 3) for k, v in m.m_SavedProperties.m_Floats if k in keys}

# ---------------- meshes -----------------
_glbs = {}
def save_mesh(mesh):
    name = mesh.m_Name
    rel = f'scene/models/{name}.glb'
    if rel in _glbs: return rel
    path = os.path.join(OUT, rel); os.makedirs(os.path.dirname(path), exist_ok=True)
    pos, nrm, uv, subs = scene_glb.unity_mesh_arrays(mesh)
    pos, nrm, uv, subs = scene_glb.to_three(pos, nrm, uv, subs)
    scene_glb.write_glb(path, [{"name": name, "pos": pos, "nrm": nrm, "uv": uv, "subs": subs, "matname": name}])
    _glbs[rel] = {"verts": int(len(pos)), "bbox": [pos.min(0).round(2).tolist(), pos.max(0).round(2).tolist()]}
    return rel

def randspec(r):
    v = r.get('values', []); t = r.get('randomType', 0)
    if not v: return None
    if t == 1 and len(v) >= 2: return [round(min(v[0], v[1]), 3), round(max(v[0], v[1]), 3)]
    return [round(v[0], 3), round(v[0], 3)]

# ---------------- tile layers (StarlingTileMap) -----------------
def build_tilelayer(mb, mat, go_name, mapw, maph, seed):
    """Reconstruct the Flash-Starling style tiled cloud/asteroid layer.  The mesh is generated at runtime in the
    Unity client (IL2CPP code not decompiled) so placement here is an approximation:
      - grid over the map, cell = tileWidth*tileScale (1536) units
      - a cell receives a random atlas piece with probability 4*mean(mask alpha over cell) (mask 210x131 = map/100)
      - piece world size = atlas px * tileScale/2 (isFixedSizedTiles -> fit to 1.2 cells), random jitter
      - orientation 1 -> random rotation
    Parallax: the layer is placed as a horizontal sheet D=(mapScale-1)*cameraHeight below the plane and scaled
    by mapScale around the map centre, which reproduces a 2D parallax factor of 1/mapScale with our camera."""
    rnd = random.Random(seed)
    atlas = mb['texture']; maskp = mb['backgroundMask']
    tex = mat_main(mat)
    if tex is None: return None
    atlas_rel = save_tex(tex, 'tex', 1024)
    aw, ah = tex.m_Width, tex.m_Height
    rects = [[r['x'], r['y'], r['width'], r['height']] for r in mb['textureXMLData']]
    mask = None
    try:
        mtex = None
        for o in ENV.objects:
            if o.path_id == maskp['m_PathID'] and o.type.name == 'Texture2D': mtex = o.read(); break
        if mtex is not None:
            mask = np.array(mtex.image.convert('RGBA'))[..., 3].astype(np.float32) / 255.0
            mask_name = mtex.m_Name
    except Exception as e:
        print('  mask err', e)
    s = float(mb['mapScale']); D = (s - 1.0) * CAM_H
    cell = float(mb['tileWidth'] * mb['tileScale'])   # 256*6 = 1536 world units
    fixed = bool(mb['isFixedSizedTiles']); orient = int(mb['tilemapOrientation'])
    tiles = []
    mx, my = mapw / 2, maph / 2
    nx = int(math.ceil(mapw * 1.2 / cell)) + 1; ny = int(math.ceil(maph * 1.2 / cell)) + 1
    for j in range(-1, ny):
        for i in range(-1, nx):
            gx = (i + 0.5) * cell - mapw * 0.1; gy = (j + 0.5) * cell - maph * 0.1
            if mask is not None:
                mh, mw = mask.shape
                x0 = int(np.clip((gx - cell/2) / mapw * mw, 0, mw - 1)); x1 = int(np.clip((gx + cell/2) / mapw * mw, 1, mw))
                y0 = int(np.clip((gy - cell/2) / maph * mh, 0, mh - 1)); y1 = int(np.clip((gy + cell/2) / maph * mh, 1, mh))
                blk = mask[y0:max(y1, y0+1), x0:max(x1, x0+1)]
                a = float(blk.mean())
                if blk.max() < 0.5 or rnd.random() > min(1.0, a * 4): continue
            else:
                a = 1.0
            ri = rnd.randrange(len(rects)); r = rects[ri]
            if fixed:
                k = cell * 1.2 / max(r[2], r[3]); w, h = r[2]*k, r[3]*k
            else:
                k = mb['tileScale'] / 2.0; w, h = r[2]*k, r[3]*k
            jx = (rnd.random() - 0.5) * cell * 0.5; jy = (rnd.random() - 0.5) * cell * 0.5
            rot = rnd.random() * 2 * math.pi if orient == 1 else 0.0
            px = mx + (gx + jx - mx) * s; pz = (my - D) + (gy + jy - my) * s
            tiles.append([round(px, 1), round(pz, 1), ri, round(w * s, 1), round(h * s, 1), round(rot, 3), round(min(1.0, a * 1.5), 2)])
    sh = shader_name(mat)
    return {"name": go_name, "atlas": atlas_rel, "atlasSize": [aw, ah], "rects": rects, "y": round(-D, 1),
            "mapScale": round(s, 3), "layerIndex": mb['layerIndex'], "blend": blend_of(sh),
            "tileFields": ["x", "z", "rect", "w", "h", "rotY", "alpha"], "tiles": tiles,
            "mask": mask_name if mask is not None else None}


# ---------------- backdrop fit -----------------
def _qrot3(q, v):  # three.js quaternion rotate
    return qrot(tuple(q), v)

def content_rows(texpath):
    """fraction of the texture height (from the top) that has content (Flash 2048x1276 images padded to 2048^2)."""
    a = np.array(Image.open(os.path.join(OUT, texpath)).convert('RGB')).astype(int).sum(2)
    rows = np.where(a.max(1) > 8)[0]
    return (rows.max() + 1) / a.shape[0] if len(rows) else 1.0

def backdrop_fit(bg, follow, mapw, maph, aspect=2.0, fov=30.0):
    """Minimal uniform scale (about the cropped bg centre) so that, with the backdrop following the camera by
    `follow`, the frustum (vertical fov, given aspect) never sees past the background content anywhere on the map."""
    Pc = np.array(bg['pos'], float); S = bg['scale'][0]; ch = bg['contentFrac']
    ux = np.array(_qrot3(bg['quat'], (1, 0, 0))); uy = np.array(_qrot3(bg['quat'], (0, 1, 0))); n = np.array(_qrot3(bg['quat'], (0, 0, 1)))
    Pcc = Pc + uy * S * (0.5 - ch / 2)
    t = math.tan(math.radians(fov / 2)); fwd = np.array([0, -1, -1]) / math.sqrt(2); up = np.array([0, 1, -1]) / math.sqrt(2); rt = np.array([1, 0, 0])
    need = 0.0
    for hx in np.linspace(0, mapw, 5):
        for hy in np.linspace(0, maph, 5):
            C = np.array([hx, CAM_H, hy + CAM_H])
            off = follow * np.array([hx - mapw / 2, 0, hy - maph / 2])
            O = Pcc + off
            for sx in (-1, 1):
                for sy in (-1, 1):
                    d = fwd + rt * t * aspect * sx + up * t * sy
                    den = d.dot(n)
                    if abs(den) < 1e-9: continue
                    k = (O - C).dot(n) / den
                    if k <= 0: continue
                    hit = C + d * k - O
                    need = max(need, 2 * abs(hit.dot(ux)) / S, 2 * abs(hit.dot(uy)) / (S * ch))
    return need, Pcc.tolist()

# ---------------- per map -----------------
def build_map(name, mapcfg):
    root = CONT[name].read()
    rtr = [c for c in comp_list(root) if ctype(c) == 'Transform'][0]
    mapasset = [c for c in comp_list(root) if ctype(c) == 'MonoBehaviour']
    sw, shh = 21000, 13500
    for c in mapasset:
        t = c.object_reader.read_typetree()
        sw, shh = t.get('seriousWidth', sw), t.get('seriousHeight', shh)
    M = {"name": name, "unityMapSize": [sw, shh], "backgrounds": [], "planes": [], "meshes": [], "tileLayers": [],
         "lensflares": [], "starfield": None}
    seed = sum(map(ord, name))
    star_emitters = []

    def visit(tr, parent_w, parent_anim, depth):
        go = tr.m_GameObject.read()
        if not go.m_IsActive: return
        w = compose(parent_w, trs(tr))
        comps = comp_list(go)
        types = {ctype(c) for c in comps}
        mbs = {mbname(c): c for c in comps if ctype(c) == 'MonoBehaviour'}
        rend = next((c for c in comps if ctype(c) == 'MeshRenderer'), None)
        mf = next((c for c in comps if ctype(c) == 'MeshFilter'), None)
        anim = list(parent_anim)
        if 'BgAssetRotation' in mbs:
            t = mbs['BgAssetRotation'].object_reader.read_typetree()
            a = {"degPerSec": not bool(t['isYoyo']), "x": randspec(t['targetX']), "y": randspec(t['targetY']), "z": randspec(t['targetZ']),
                 "yoyo": bool(t['isYoyo']), "duration": randspec(t['duration'])}
            # convert rotation axes to three.js: rotation about x and y flip sign, about z keeps sign
            for k in ('x', 'y'):
                if a[k]: a[k] = sorted([-a[k][0], -a[k][1]])
            if a['yoyo']: a['note'] = 'tween: rotate by (x,y,z) degrees over duration seconds, yoyo, quad.easeInOut, repeat forever'
            else: a['note'] = 'continuous spin: pick a random rate in each range, degrees/second'
            anim.append({"node": go.m_Name, **a})
        if 'StarlingTileMap' in mbs and rend is not None:
            mb = mbs['StarlingTileMap'].object_reader.read_typetree()
            L = build_tilelayer(mb, rend.m_Materials[0].read(), go.m_Name, sw, shh, seed + len(M['tileLayers']))
            if L: M['tileLayers'].append(L)
            return
        if ('MapBackground' in mbs or 'MapPlanet' in mbs or 'AdvancedMapAssetPositioning' in mbs) and rend is not None and mf is not None and 'PoiBackgroundAsset' not in mbs:
            if 'MapBackground' not in mbs and max(trs(tr)[2]) < 10 and max(w[2]) < 10:
                return   # never positioned by the editor (e.g. 1-1 planet115/116): invisible in Unity too
            mat = rend.m_Materials[0].read(); tex = mat_main(mat); sh = shader_name(mat)
            if tex is None: return
            e = {"name": go.m_Name, **T3(w), "blend": blend_of(sh), "geometry": "quad",
                 "tex": save_tex(tex, 'tex', 2048, alpha=(blend_of(sh) != 'add')), "texSize": [tex.m_Width, tex.m_Height]}
            col = mat_color(mat)
            if col and col != [1, 1, 1, 1]: e['color'] = col
            if 'MapBackground' in mbs:
                t = mbs['MapBackground'].object_reader.read_typetree(); e['pFactor'] = t['pFactor']
                M['backgrounds'].append(e)
            else:
                if 'AdvancedMapAssetPositioning' in mbs:
                    t = mbs['AdvancedMapAssetPositioning'].object_reader.read_typetree()
                    e['design'] = {"gameX": t['x'], "gameY": -t['z'], "pFactor": t['pFactor']}
                if max(e['scale']) < 10:   # never positioned by the editor (e.g. 1-1 planet115/116): invisible in Unity too
                    return
                M['planes'].append(e)
            return
        if mf is not None and rend is not None and ('PoiBackgroundAsset' in mbs or 'BgAssetTransformController' in mbs or 'BgAssetRotation' in mbs or depth > 0):
            try: mesh = mf.m_Mesh.read()
            except Exception: mesh = None
            if mesh is not None and mesh.m_Name not in ('Quad',):
                mat = rend.m_Materials[0].read(); sh = shader_name(mat)
                e = {"name": go.m_Name, "glb": save_mesh(mesh), **T3(w), "shader": sh,
                     "tex": mat_ext_textures(mat),
                     "material": {**mat_floats(mat, ('_Glossiness', '_GlowAmount', '_Alpha', '_Shininess')),
                                  "doubleSided": 'CullOff' in (sh or ''), "alphaMask": 'Masked' in (sh or '')}}
                if 'BgAssetTransformController' in mbs:
                    t = mbs['BgAssetTransformController'].object_reader.read_typetree()
                    if depth == 0:   # runtime applies these (they are the lib_maps.xml values) instead of the baked transform
                        v = lambda k: (t[k]['values'] or [0])[0]
                        ex, ey, ez = (math.radians(v('rotX')), math.radians(v('rotY')), math.radians(v('rotZ')))
                        qx = (math.sin(ex/2), 0, 0, math.cos(ex/2)); qy = (0, math.sin(ey/2), 0, math.cos(ey/2)); qz = (0, 0, math.sin(ez/2), math.cos(ez/2))
                        q = qmul(qmul(qy, qx), qz)   # Unity euler order Z, X, Y
                        sc = v('scale')
                        e.update(T3(((v('posX'), v('posY'), v('posZ')), q, (sc, sc, sc))))
                    rr = randspec(t['rotY'])
                    if rr and rr[0] != rr[1]: e['randomRotYDeg'] = rr   # XML rotationY="random(360)"
                if anim: e['anim'] = anim
                M['meshes'].append(e)
        if 'SpriteRenderer' in types and 'Animator' in types and go.m_Name.startswith('lensflare'):
            sr = next(c for c in comps if ctype(c) == 'SpriteRenderer')
            try:
                sp = sr.m_Sprite.read(); st = sp.m_RD.texture.read()
                e = {"name": go.m_Name, **T3(w), "sprite": save_tex(st, 'tex', 512), "spriteSize": [sp.m_Rect.width / sp.m_PixelsToUnits, sp.m_Rect.height / sp.m_PixelsToUnits],
                     "blend": "add", "billboard": False, "note": "sprite quad (size*scale world units) facing the camera pitch; Animator 'lensflare' clip flickers it"}
                for ch in tr.m_Children:
                    cg = ch.read().m_GameObject.read()
                    for c in comp_list(cg):
                        if ctype(c) == 'LensFlare':
                            f = c.m_Flare.read(); ft = f.object_reader.read_typetree(); lt = c.object_reader.read_typetree()
                            e['flare'] = {"texture": save_tex(f.m_FlareTexture.read(), 'tex', 1024), "layout": ft['m_TextureLayout'],
                                          "layoutNote": "Unity Flare layout 1 = '1 large 2 medium 8 small' (large: top half; 2 medium: next quarter row; 8 small)",
                                          "color": scene_ps.col(lt['m_Color']), "brightness": round(lt['m_Brightness'], 3), "fadeSpeed": round(lt['m_FadeSpeed'], 3),
                                          "elements": [{"image": el['m_ImageIndex'], "pos": round(el['m_Position'], 3), "size": round(el['m_Size'], 2),
                                                        "color": scene_ps.col(el['m_Color']), "useLightColor": bool(el['m_UseLightColor']),
                                                        "rotate": bool(el['m_Rotate']), "zoom": bool(el['m_Zoom']), "fade": bool(el['m_Fade'])} for el in ft['m_Elements']]}
                M['lensflares'].append(e)
            except Exception as ex:
                print('  lensflare err', ex)
            return
        if 'LensFlare' in types and depth == 0:
            c = next(c for c in comps if ctype(c) == 'LensFlare')
            f = c.m_Flare.read(); ft = f.object_reader.read_typetree(); lt = c.object_reader.read_typetree()
            M['lensflares'].append({"name": go.m_Name, **T3(w), "flare": {"texture": save_tex(f.m_FlareTexture.read(), 'tex', 1024), "layout": ft['m_TextureLayout'],
                                    "color": scene_ps.col(lt['m_Color']), "brightness": round(lt['m_Brightness'], 3),
                                    "elements": [{"image": el['m_ImageIndex'], "pos": round(el['m_Position'], 3), "size": round(el['m_Size'], 2), "color": scene_ps.col(el['m_Color']),
                                                  "useLightColor": bool(el['m_UseLightColor']), "rotate": bool(el['m_Rotate']), "zoom": bool(el['m_Zoom']), "fade": bool(el['m_Fade'])} for el in ft['m_Elements']]}})
            return
        if 'ParticleSystem' in types:
            ps = next(c for c in comps if ctype(c) == 'ParticleSystem')
            pr = next((c for c in comps if ctype(c) == 'ParticleSystemRenderer'), None)
            if go.m_Name.startswith('star_dust'):
                star_emitters.append((w, ps, pr, go.m_Name))
                return
        for ch in tr.m_Children:
            visit(ch.read(), w, anim, depth + 1)

    ident = ((0, 0, 0), (0, 0, 0, 1), (1, 1, 1))
    for ch in rtr.m_Children:
        visit(ch.read(), ident, [], 0)

    if star_emitters:
        w, ps, pr, nm = star_emitters[0]
        tt = ps.object_reader.read_typetree(); rt = pr.object_reader.read_typetree() if pr else None
        mat = pr.m_Materials[0].read() if pr else None
        tex = mat_main(mat) if mat else None
        em = scene_ps.simplify(tt, rt, save_tex(tex, 'fx', 256) if tex else None, shader_name(mat) if mat else None)
        M['starfield'] = {"emitter": em, "name": nm,
                          "centers": [[round(e[0][0][0]), round(e[0][0][1]), round(-e[0][0][2])] for e in star_emitters],
                          "note": "one emitter per centre (box 2000x2000 horizontal x 500 tall); ~750 tiny additive dust particles each. Can be approximated by a static THREE.Points cloud with slow drift."}
    if mapcfg: M['light'] = mapcfg.get('light'); M['starfieldType'] = mapcfg.get('starfield')
    # ---- backdrop group: the deep background quad (+ planets/flare at similar depth) ----
    if M['backgrounds']:
        bg = M['backgrounds'][0]
        ch = round(content_rows(bg['tex']), 4); bg['contentFrac'] = ch
        follow = round(1 - 1 / max(1.0, bg.get('pFactor', 10)), 4)
        sc, pivot = backdrop_fit(bg, follow, sw, shh)
        sc = round(max(1.0, sc) * 1.02, 4)
        # crop the quad to the content rect (top `ch` of the texture)
        uy = np.array(_qrot3(bg['quat'], (0, 1, 0))); S = bg['scale'][0]
        bg['pos'] = [round(v, 2) for v in (np.array(bg['pos']) + uy * S * (0.5 - ch / 2)).tolist()]
        bg['scale'] = [S, round(S * ch, 2), S]; bg['uvRect'] = [0, round(1 - ch, 4), 1, 1]
        deep = bg['pos'][1] * 0.6
        members = [bg['name']] + [p['name'] for p in M['planes'] if p['pos'][1] < deep] + [f['name'] for f in M['lensflares'] if f['pos'][1] < deep]
        for p in M['planes'] + M['lensflares']:
            p['backdrop'] = p['name'] in members
        bg['backdrop'] = True
        M['backdrop'] = {"pivot": [round(v, 2) for v in pivot], "fitScale": sc, "follow": follow, "fitAspect": 2.0, "members": members,
                         "rule": "for every item with backdrop=true: pos' = pivot + (pos - pivot)*fitScale + follow*(camTarget - mapCentre) (y unchanged), scale' = scale*fitScale. "
                                 "camTarget = hero (gameX,0,gameY), mapCentre = (unityMapSize/2) -> (10500,0,6750). Emulates the Unity MapBackground pFactor parallax "
                                 "and guarantees the cropped background always fills a 30deg-vFOV frustum up to aspect 2:1."}
    return M

# ---------------- maps-config (light) -----------------
def read_maps_config():
    import xml.etree.ElementTree as ET
    txt = open(os.path.join(ROOT, 'extracted/xml/maps-config.txt'), encoding='utf-8-sig').read()
    root = ET.fromstring(txt)
    out = {}
    for m in root.iter('map'):
        nm = m.get('name'); d3 = m.find('display3D')
        if nm is None: continue
        e = {"id": m.get('id'), "starfield": m.get('starfield'), "templateId": d3.get('templateId') if d3 is not None else None}
        L = d3.find('light') if d3 is not None else None
        if L is not None:
            def hx(v): v = (v or '0xffffff').lower().replace('0x', '#'); return v
            tilt = float(L.get('tilt', 0)); pan = float(L.get('pan', 0))
            # Unity light euler = (tilt, pan + 100, 0) reproduces level0's light for 1-1 (tilt 100, pan 35) exactly.
            ex, ey = math.radians(tilt), math.radians(pan + 100)
            fx, fy, fz = math.sin(ey) * math.cos(ex), -math.sin(ex), math.cos(ey) * math.cos(ex)
            e['light'] = {"color": hx(L.get('color')), "diffuse": float(L.get('diffuse', 1)), "specular": float(L.get('specular', 1)),
                          "ambientColor": hx(L.get('ambientColor')), "ambient": float(L.get('ambient', 0)), "tilt": tilt, "pan": pan,
                          "dir": [round(fx, 4), round(fy, 4), round(-fz, 4)]}
        out[nm] = e
    return out

def main():
    global ENV, CONT
    ENV = UnityPy.load(MAPB, *SHADERB)
    CONT = {p.split('/')[-1][4:-7]: o for p, o in ENV.container.items() if '/Map/map_' in p}
    maps = json.load(open(os.path.join(ROOT, 'data/maps.json')))
    want = sys.argv[1:]
    cfg = read_maps_config()
    man = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {}
    man.setdefault('maps', {})
    for m in maps:
        if want and m['name'] not in want: continue
        print('map', m['name'])
        M = build_map(m['name'], cfg.get(m['name']))
        M['gameSize'] = [m['w'], m['h']]
        man['maps'][str(m['id'])] = M
    man['camera'] = {"fov": 30, "fovAxis": "vertical", "pitchDeg": 45, "height": CAM_H, "back": CAM_H,
                     "distance": round(CAM_H * math.sqrt(2), 1), "near": 10, "far": 80000, "clearColor": "#000000",
                     "note": "Unity Main Camera (level0): perspective, vertical FOV 30, local pos (0,1230,-1230) rotated 45deg about X. "
                             "In three.js: camera.position = (heroX, 1230, heroY + 1230), lookAt(heroX, 0, heroY)."}
    man['coords'] = ("three.js = (gameX, height, gameY); 1 unit = 1 DO world unit. Unity prefab (x,y,z) -> three (x, y, -z); "
                     "Unity quaternion (x,y,z,w) -> three (-x,-y,z,w). Gameplay plane y=0. Background/planet quads sit far below "
                     "(y ~ -12000..-43000) so they parallax naturally with the perspective camera. Unity maps are 21000x13100 (data uses 20800x12800): "
                     "no rescale applied, the 1-2% difference is invisible.")
    man['quad'] = "geometry 'quad' = Unity built-in Quad: 1x1 in local XY plane centred at origin, front face toward Unity -Z (three +Z), UV (0,0) bottom-left. After the given quaternion it faces up/back toward the camera. Multiply by scale."
    man['meshesNote'] = ("Scene props: GLB geometry only, already in three.js handedness. Materials are BlinnPhong (diffuse/normal/specular[/glow][/alpha] in tex) "
                         "lit by the map light. '@pathid:N' entries are unresolved (should not remain after scene_tex3d.py).")
    man['_doc'] = {
        "source": "Unity client v0.1.4 map prefabs (map_assets bundle: Assets/Res/Prefabs/Map/map_<name>.prefab). They are the Unity port of lib_maps.xml display3D "
                  "(identical numbers: e.g. 1-1 plane background1 sphericalPhi=-90 theta=30 R=50010 x=10000 scale=50000 rotX=45 -> prefab pos (10000,-43310,25005), 45deg) "
                  "plus Unity-only layers (StarlingTileMap cloud/asteroid layers, star-dust particle grid). Light from maps-config.xml.",
        "build": "tools/scene_build.py -> tools/scene_tex3d.py -> tools/scene_fx.py (fx adds lasers/rockets/npcShots/fx/skybox and maps[].skybox). Preview: tools/scene_preview.html via tools/scene_shot.sh",
        "maps[]": {"backgrounds": "deep additive quad (crop uvRect to its content), part of backdrop", "planes": "planet/asteroid/station billboards (alpha quads, fixed in 3D, natural perspective parallax; backdrop=true ones follow the backdrop rule)",
                   "meshes": "3D props (GLB + BlinnPhong textures), anim = spins", "tileLayers": "instanced flat atlas quads lying in a horizontal plane at y (below the gameplay plane)",
                   "lensflares": "flare sprite quad (+ Unity Flare elements for a screen-space flare)", "starfield": "dust particle grid near y=0", "light": "directional (dir = direction light travels, three.js) + ambient",
                   "backdrop": "parallax rule for backdrop=true items"},
        "renderOrder": "draw backdrop/planes far->near (depthWrite off), then tileLayers by layerIndex, then meshes (depth on), then entities; dust additive last."}
    os.makedirs(OUT, exist_ok=True)
    json.dump(man, open(MANIFEST, 'w'), indent=1)
    json.dump({k: v for k, v in _glbs.items()}, open(os.path.join(SCN, 'models_index.json'), 'w'), indent=1)
    print('written', MANIFEST)

if __name__ == '__main__':
    main()
