"""Export DarkOrbit Unity 3D models + textures for the three.js client.

  .venv/bin/python tools/m3d_export.py            # everything
Outputs client/public/assets3d/{models,tex}/ and manifest3d.json (keys forward/models/stations/portal/box).
"""
import os
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import glob, json, math, os, re, sys, collections
from multiprocessing import Pool

import numpy as np
import UnityPy

sys.path.insert(0, os.path.dirname(__file__))
from m3d_xml import Lib
from m3d_glb import export_prefab, comps, GLB, FWD_Q

ROOT = REPO
BT = os.path.expanduser('~/darkorbit-client/extracted/DarkOrbit_Version0.1.4/DarkOrbit_Data/StreamingAssets/aa/BuildTarget/')
OUT = f'{ROOT}/client/public/assets3d'
CACHE = f'{ROOT}/extracted/m3d'
KINDS = ('diffuse', 'normal', 'specular', 'glow', 'alpha')
BUNDLES = {k: sorted(glob.glob(BT + k + '_all_*.bundle'))[-1] for k in
           ('ship_assets', 'npc_assets', 'drone_assets', 'pet_assets', 'building_assets', 'portals_assets',
            'collects_assets', 'infoeffect_assets', '3dtexture_assets', 'shader_assets')}
TEXPROP = {'_Diffuse': 'diffuse', '_MainTex': 'diffuse', '_Normal': 'normal', '_BumpMap': 'normal',
           '_Specular': 'specular', '_Glow': 'glow', '_EmissionMap': 'glow', '_Alpha': 'alpha'}
TEXRE = re.compile(r'^(.*)_(diffuse|normal|specular|glow|alpha)_(\d+)$')


def slug(s):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', s)


# ---------------------------------------------------------------- indices (cached)
def tex_index():
    p = f'{CACHE}/texindex.json'
    if os.path.exists(p):
        return json.load(open(p))
    env = UnityPy.load(BUNDLES['3dtexture_assets'])
    d = {o.peek_name(): o.path_id for o in env.objects if o.type.name == 'Texture2D'}
    json.dump(d, open(p, 'w'))
    return d


def shader_index():
    p = f'{CACHE}/shaders.json'
    if os.path.exists(p):
        return {int(k): v for k, v in json.load(open(p)).items()}
    d = {}
    for b in glob.glob(BT + 'shader_assets_all_*.bundle') + glob.glob(BT + '*unitybuiltinshaders*.bundle'):
        env = UnityPy.load(b)
        for o in env.objects:
            if o.type.name == 'Shader':
                try:
                    d[o.path_id] = o.read().m_ParsedForm.m_Name
                except Exception:
                    d[o.path_id] = o.peek_name()
    json.dump(d, open(p, 'w'))
    return d


def prefab_index():
    p = f'{CACHE}/prefabs.json'
    if os.path.exists(p):
        return json.load(open(p))
    d = {}
    for key in ('ship_assets', 'npc_assets', 'drone_assets', 'pet_assets', 'building_assets', 'portals_assets',
                'collects_assets', 'infoeffect_assets'):
        env = UnityPy.load(BUNDLES[key])
        for o in env.objects:
            if o.type.name != 'GameObject':
                continue
            g = o.read()
            t = comps(g)[0]
            if not t.m_Father.path_id:
                d.setdefault(g.m_Name, [key, t.object_reader.path_id])
    json.dump(d, open(p, 'w'))
    return d


# ---------------------------------------------------------------- workers
_W = {}


def _env(key):
    if key not in _W:
        _W[key] = UnityPy.load(BUNDLES[key])
        _W[key + '_objs'] = {o.path_id: o for o in _W[key].objects}
    return _W[key], _W[key + '_objs']


def _mat_info_factory(texinv, shaders, local_tex):
    def mat_info(m):
        ex = {'tex': {}}
        try:
            ex['shader'] = shaders.get(m.m_Shader.path_id, str(m.m_Shader.path_id))
        except Exception:
            pass
        for k, v in m.m_SavedProperties.m_TexEnvs:
            kind = TEXPROP.get(k)
            if not kind or not v.m_Texture.path_id:
                continue
            nm = texinv.get(str(v.m_Texture.path_id)) if v.m_Texture.file_id else None
            if nm:
                mm = TEXRE.match(nm)
                ex['tex'][kind] = mm[1] if mm else nm
            elif v.m_Texture.file_id == 0:  # texture inside the same bundle
                try:
                    t = v.m_Texture.read()
                    ex['tex'][kind] = '@' + t.m_Name
                    local_tex[t.m_Name] = t
                except Exception:
                    pass
        cols = {k: [round(c.r, 3), round(c.g, 3), round(c.b, 3), round(c.a, 3)] for k, c in m.m_SavedProperties.m_Colors
                if k in ('_Color', '_TintColor', '_EmissionColor', '_RimColor')}
        if cols:
            ex['colors'] = cols
        return ex
    return mat_info


def save_webp(img, path, kind):
    from PIL import Image
    img = img.convert('RGBA')
    if kind == 'normal':
        a = np.asarray(img).astype(np.float32) / 255.0
        if a[..., 0].mean() > 0.95 and a[..., 3].std() > 0.01:  # DXT5nm / AG-swizzled
            x, y = a[..., 3] * 2 - 1, a[..., 1] * 2 - 1
        else:
            x, y = a[..., 0] * 2 - 1, a[..., 1] * 2 - 1
        z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
        rgb = np.stack([x, y, z], -1) * 0.5 + 0.5
        img = Image.fromarray((rgb * 255 + 0.5).astype(np.uint8), 'RGB')
        img.save(path, 'WEBP', quality=90, method=4)
        return
    a = np.asarray(img)
    if kind in ('specular', 'glow') or a[..., 3].min() >= 250:
        img = img.convert('RGB')
    img.save(path, 'WEBP', quality=88, method=4)


def job_prefab(args):
    name, bkey, pid, static = args
    texinv, shaders = _W['texinv'], _W['shaders']
    env, objs = _env(bkey)
    tr = objs[pid].read()
    local = {}
    out = f'{OUT}/models/{slug(name)}.glb'
    info = export_prefab(tr, out, _mat_info_factory(texinv, shaders, local), static=static)
    # textures embedded in the source bundle (fx etc.)
    for tn, t in local.items():
        p = f'{OUT}/tex/{slug(tn)}.webp'
        if not os.path.exists(p):
            try:
                save_webp(t.image, p, 'diffuse')
            except Exception as e:
                print('localtex fail', tn, e)
    info['size'] = os.path.getsize(out)
    return name, info


def job_tex(batch):
    env, objs = _env('3dtexture_assets')
    res = []
    for src, dst, kind in batch:
        try:
            save_webp(objs[src].read().image, dst, kind)
            res.append((dst, True))
        except Exception as e:
            res.append((dst, str(e)))
    return res


def _init(texinv, shaders):
    _W['texinv'] = texinv
    _W['shaders'] = shaders


# ---------------------------------------------------------------- model selection
def pick_prefab(geometry, npc, pref, kind='ship'):
    n = geometry.replace('-', '_')
    if kind == 'drone':
        cands = [geometry + '_3D', 'drone_' + geometry + '_3D', n + '_3D', 'drone_' + n + '_3D']
    elif kind == 'building':
        cands = [geometry, geometry + '_3D']
    else:
        a = ['npc_' + n + '_3D', 'npc_' + geometry + '_3D']
        b = ['ship_' + n + '_3D', 'ship_' + geometry + '_3D']
        cands = (a + b if npc else b + a) + [geometry + '_3D', n + '_3D', geometry, 'pet_' + n + '_3D']
    for c in cands:
        if c in pref:
            return c
    low = {k.lower(): k for k in pref}
    for c in cands:
        if c.lower() in low:
            return low[c.lower()]
    return None


def tex_set(mesh, texbases, fallback=None):
    """XML mesh attrs -> {kind: base} using DO rules: texture=<base> provides all kinds, per-kind attrs override, 'none' removes."""
    base = mesh.get('texture') or mesh['geometry']
    out = {}
    for k in KINDS:
        v = mesh.get(k)
        if v == 'none':
            continue
        for cand in ([v] if v else []) + [base]:
            if cand and (cand, k) in texbases:
                out[k] = cand
                break
        else:
            if fallback and fallback.get(k) and not fallback[k].startswith('@') and (fallback[k], k) in texbases:
                out[k] = fallback[k]
    return out


def rim_of(r):
    if not r:
        return None
    c = r.get('color', '0xffffff').replace('0x', '#').lower()
    return {'color': c, 'strength': float(r.get('strength', 1)), 'power': float(r.get('power', 1))}


def main():
    os.makedirs(f'{OUT}/models', exist_ok=True)
    os.makedirs(f'{OUT}/tex', exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    texidx = tex_index()
    texinv = {str(v): k for k, v in texidx.items()}
    texsizes = collections.defaultdict(dict)  # (base,kind) -> {size: path_id}
    for k, pid in texidx.items():
        m = TEXRE.match(k)
        if m:
            texsizes[(m[1], m[2])][int(m[3])] = pid
    shaders = shader_index()
    pref = prefab_index()
    print('prefabs', len(pref), 'tex', len(texidx), 'shaders', len(shaders))

    ships = json.load(open(f'{ROOT}/data/ships.json'))
    npcs = json.load(open(f'{ROOT}/data/npcs.json'))
    sheets2d = json.load(open(f'{ROOT}/client/public/assets/manifest.json'))['sheets']
    ship_assets = {}
    for s in ships:
        ship_assets[s['sheet']] = s['id']
        for d in s.get('designs', []):
            ship_assets[d['sheet']] = d.get('asset') or d['id']
    npc_ids = {n['sheet']: str(n.get('libId', '')) for n in npcs}

    recs = Lib('lib_ships.txt').resolve()
    by = collections.defaultdict(list)
    for r in recs:
        if r['mesh'] and r['d2'].get('srcKey'):
            by[r['d2']['srcKey']].append(r)

    entries = {}   # key -> dict(prefab, mesh(xml), rim, kind, asset)
    missing = []
    for sheet in sorted(set(ship_assets) | set(npc_ids)):
        rs = by.get(sheet, [])
        if not rs:
            missing.append(sheet)
            continue
        want = npc_ids.get(sheet) or ship_assets.get(sheet)
        r = next((x for x in rs if x['id'] == want), rs[0])
        isnpc = sheet in npc_ids or r['d2'].get('replacement', '').startswith('npc_') or bool(re.match(r'ship\d+$', sheet))
        p = pick_prefab(r['mesh']['geometry'], isnpc, pref)
        if not p:
            missing.append(sheet + ' (no prefab for ' + r['mesh']['geometry'] + ')')
            continue
        entries[sheet] = dict(prefab=p, mesh=r['mesh'], rim=r['rim'], kind='npc' if isnpc else 'ship', asset=r['id'])
    # drones: keyed by 2D sheet (resKey preferred)
    for r in Lib('lib_drones.txt').resolve():
        if not r['mesh']:
            continue
        key = next((k for k in (r['d2'].get('resKey'), r['d2'].get('replacement')) if k and k in sheets2d), None)
        if not key or key in entries:
            continue
        p = pick_prefab(r['mesh']['geometry'], False, pref, 'drone')
        if p:
            entries[key] = dict(prefab=p, mesh=r['mesh'], rim=r['rim'], kind='drone', asset=r['id'])
    # stations / portal
    la = {r['id']: r for r in Lib('lib_assets.txt').resolve()}
    station_parts = {}
    for fi, f in ((1, 'mmo'), (2, 'eic'), (3, 'vru')):
        for part, aid in (('hq', f'headquarters_home_{f}'), ('hangar', f'hangar_home_{fi}'), ('repair', f'repairstation_home_{fi}'),
                          ('trade', f'refinery_home_{fi}'), ('mission', {'mmo': 'questgiver_3', 'eic': 'questgiver_6', 'vru': 'questgiver_9'}[f]),
                          ('turretSmall', f'turret_55_{fi},turret_56_{fi}'), ('turretLarge', f'turret_57_{fi},turret_58_{fi}')):
            r = la.get(aid)
            if not r or not r['mesh']:
                print('station part missing', f, part, aid)
                continue
            p = pick_prefab(r['mesh']['geometry'], False, pref, 'building')
            if p:
                k = f'station:{f}:{part}'
                entries[k] = dict(prefab=p, mesh=r['mesh'], rim=None, kind='building', asset=aid)
                station_parts.setdefault(f, {})[part] = k
    lp = Lib('lib_portals.txt').resolve()
    pr = next(r for r in lp if r['id'] == '1')
    entries['portal'] = dict(prefab='Portal_1', mesh=pr['mesh'], rim=None, kind='portal', asset='1')

    # ---- export prefabs
    jobs = sorted({e['prefab'] for e in entries.values()})
    static = {e['prefab'] for e in entries.values() if e['kind'] in ('building', 'portal')}
    jobs = [(n, *pref[n], n in static) for n in jobs]
    jobs.sort(key=lambda j: j[1])
    print('prefabs to export', len(jobs))
    with Pool(8, initializer=_init, initargs=(texinv, shaders)) as pool:
        infos = dict(pool.map(job_prefab, jobs, chunksize=4))
    box_info = export_boxes(texinv, shaders)

    # ---- textures
    texbases = set(texsizes)
    need = set()
    tex_of = {}
    for k, e in entries.items():
        inf = infos[e['prefab']]
        main = main_material(inf)
        fb = main['tex'] if main else {}
        ts = tex_set(e['mesh'], texbases, fb)
        tex_of[k] = ts
        need |= {(b, kk) for kk, b in ts.items()}
        for m in inf['materials']:
            for kk, b in m['tex'].items():
                if not b.startswith('@') and (b, kk) in texbases:
                    need.add((b, kk))
    tasks = []
    for b, kk in sorted(need):
        sz = texsizes[(b, kk)]
        s = 512 if 512 in sz else max([x for x in sz if x < 512] or [min(sz)])
        dst = f'{OUT}/tex/{slug(b)}_{kk}.webp'
        if not os.path.exists(dst):
            tasks.append((sz[s], dst, kk))
    print('textures', len(need), 'to write', len(tasks))
    if tasks:
        nb = 2
        batches = [tasks[i::nb] for i in range(nb)]
        with Pool(nb) as pool:
            for res in pool.imap_unordered(job_tex, batches):
                for dst, ok in res:
                    if ok is not True:
                        print('tex fail', dst, ok)

    def texurls(ts):
        return {kk: f'tex/{slug(b)}_{kk}.webp' for kk, b in ts.items() if os.path.exists(f'{OUT}/tex/{slug(b)}_{kk}.webp')}

    def matlist(inf):
        out = []
        for m in inf['materials']:
            t = {}
            for kk, b in m['tex'].items():
                p = f'tex/{slug(b[1:])}.webp' if b.startswith('@') else f'tex/{slug(b)}_{kk}.webp'
                if os.path.exists(f'{OUT}/{p}'):
                    t[kk] = p
            out.append({'name': m['name'], 'shader': m.get('shader'), 'tex': t, **({'colors': m['colors']} if 'colors' in m else {})})
        return out

    # orientation/scale overrides produced by tools/m3d_verify.py --write-overrides (2D-sheet silhouette comparison)
    ovr = json.load(open(f'{CACHE}/overrides.json')) if os.path.exists(f'{CACHE}/overrides.json') else {}
    models = {}
    for k, e in entries.items():
        inf = infos[e['prefab']]
        m = e['mesh']
        mm = main_material(inf)
        rec = {'glb': f'models/{slug(e["prefab"])}.glb', 'scale': 1,
               'xmlScale': float(m['scale']) if m.get('scale') else 1.0,
               'visualSize': float(m['visualSize']) if m.get('visualSize') else None,
               'tex': texurls(tex_of[k]), 'mainMaterial': mm['name'] if mm else None,
               'materials': matlist(inf), 'kind': e['kind'], 'asset': e['asset'], 'geometry': m['geometry'],
               'bounds': inf.get('bounds')}
        if inf['skinned']:
            rec['skinned'] = True
        r = rim_of(e['rim'])
        if r:
            rec['rim'] = r
        if m.get('engineTrailColor'):
            rec['engineTrailColor'] = m['engineTrailColor'].replace('0x', '#')
        o = ovr.get(k, {})
        rec['rot'] = o.get('rot', [0, math.pi, 0] if e['kind'] == 'drone' else [0, 0, 0])
        rec['scale'] = o.get('scale', 1)
        rec['scaleSource'] = o.get('scaleSource', 'prefab')
        if not rec['visualSize']:
            del rec['visualSize']
        models[k] = rec

    stations = {}
    for f, parts in station_parts.items():
        st = {kk: models.pop(v) for kk, v in parts.items()}
        hq = st['hq']
        stations[f] = {'glb': hq['glb'], 'tex': hq['tex'], 'scale': 1, 'materials': hq['materials'], 'bounds': hq['bounds'],
                       'parts': st}
    portal = models.pop('portal')
    man_path = f'{OUT}/manifest3d.json'
    man = json.load(open(man_path)) if os.path.exists(man_path) else {}
    man.update({
        'forward': '+x',
        'up': '+y',
        'note': ('GLBs are Y-up, 1 unit = 1 DarkOrbit world unit (3D x-span is ~0.92x the 2D sprite width). Wrapper node m3d_root '
                 'already turns the Unity prefab so that a ship nose (Unity +Z) points glTF +X. Per model: apply `rot` (Euler XYZ, '
                 'radians, three.js order) and uniform `scale` to the loaded GLB scene, then the heading yaw; after that the nose is '
                 '`forward` (+x = game heading 0). Ships: rot 0. Drones: authored nose -Z, rot [0,pi,0]. A few NPC/drone GLBs have an '
                 'extra 90deg yaw found by matching the 2D frame-16 silhouette. Prefab transforms are baked into the GLB; `scale` is 1 '
                 'unless the XML <mesh scale> differs from the prefab (then scale = xmlScale / prefab mesh scale, scaleSource=xml). '
                 'xmlScale/visualSize are informational. tex = the design textures for mainMaterial; materials[] = every Unity material '
                 'in the prefab with its default textures (secondary parts, fx quads: see shader). Normal maps are standard RGB '
                 'tangent-space (+Y green, OpenGL); GLBs have no tangents (three.js derives them). glow = additive emissive map, '
                 'specular = grayscale specular mask, alpha = opacity mask. rim = rim-light from lib_ships <shader>. '
                 'stations/portal/box GLBs are static props already in three.js world orientation (Unity (x,y,z) -> three '
                 '(x,y,-z), same as manifest3d.maps.json coords; their m3d_root holds the 180deg yaw): place at (x, 0, y) '
                 'with no extra rotation. Station prefabs include the XML offsets (e.g. HQ y=-400 below the play plane).'),
        'models': models, 'stations': stations, 'portal': portal, 'box': box_info,
    })
    json.dump(man, open(man_path, 'w'), indent=1)
    json.dump({'infos': infos, 'missing': missing}, open(f'{CACHE}/export_report.json', 'w'), indent=1)
    print('models', len(models), 'missing', missing)


def main_material(inf):
    """material with most vertices"""
    cnt = collections.Counter()
    for mn in inf['meshNodes']:
        for m in mn['materials'][:1]:
            cnt[m] += mn['verts']
    if not cnt:
        return None
    best = cnt.most_common(1)[0][0]
    return next(m for m in inf['materials'] if m['name'] == best)


def export_boxes(texinv, shaders):
    """bonus/cargo boxes are particle-system prefabs (infoeffect_assets box_2 / box_1 / box_0). Mesh-mode particles are exported as
    meshes; billboard layers are listed with their texture."""
    env = UnityPy.load(BUNDLES['infoeffect_assets'])
    roots = {}
    for o in env.objects:
        if o.type.name == 'GameObject':
            g = o.read()
            if g.m_Name in ('box_0', 'box_1', 'box_2'):
                t = comps(g)[0]
                if not t.m_Father.path_id:
                    roots[g.m_Name] = t
    out = {}
    local = {}
    mi = _mat_info_factory(texinv, shaders, local)
    for name, kind in (('box_2', 'bonus'), ('box_1', 'cargo'), ('box_0', 'blocked')):
        root = roots[name]
        g = GLB()
        g.j['nodes'].append({'name': 'm3d_root', 'children': [], 'rotation': [0.0, 1.0, 0.0, 0.0]})
        layers = []

        def walk(tr, parent):
            go = tr.m_GameObject.read()
            p, q, s = tr.m_LocalPosition, tr.m_LocalRotation, tr.m_LocalScale
            node = {'name': go.m_Name, 'translation': [-p.x, p.y, p.z], 'rotation': [q.x, -q.y, -q.z, q.w],
                    'scale': [s.x, s.y, s.z]}
            idx = len(g.j['nodes'])
            g.j['nodes'].append(node)
            g.j['nodes'][parent].setdefault('children', []).append(idx)
            ps = psr = None
            for c in comps(go):
                tn = c.object_reader.type.name
                if tn == 'ParticleSystem':
                    ps = c.object_reader.read_typetree()
                elif tn == 'ParticleSystemRenderer':
                    psr = c
            if psr is not None:
                d = psr.object_reader.read_typetree()
                mats = [m.read() for m in psr.m_Materials if m.path_id]
                ex = mi(mats[0]) if mats else {'tex': {}}
                tex = {kk: (f'tex/{slug(b[1:])}.webp' if b.startswith('@') else f'tex/{slug(b)}_{kk}.webp') for kk, b in ex['tex'].items()}
                size = None
                col = None
                try:
                    im = ps['InitialModule']
                    size = im['startSize']['scalar']
                    sc = im['startColor']['maxColor']
                    col = [round(sc['r'], 3), round(sc['g'], 3), round(sc['b'], 3), round(sc['a'], 3)]
                except Exception:
                    pass
                lay = {'node': go.m_Name, 'mode': 'mesh' if d.get('m_RenderMode') == 4 else 'billboard', 'tex': tex,
                       'shader': ex.get('shader'), 'startSize': size, 'color': col,
                       'pos': node['translation']}
                if d.get('m_RenderMode') == 4 and psr.m_Mesh.path_id:
                    mid = g.material(mats[0].m_Name if mats else 'box', {'tex': tex})
                    mesh_idx, st = g.mesh(psr.m_Mesh.read(), [mid])
                    if mesh_idx is not None:
                        child = {'name': go.m_Name + '_mesh', 'mesh': mesh_idx}
                        if size:
                            child['scale'] = [size] * 3
                        g.j['nodes'].append(child)
                        node.setdefault('children', []).append(len(g.j['nodes']) - 1)
                layers.append(lay)
            for ch in tr.m_Children:
                walk(ch.read(), idx)

        walk(root, 0)
        path = f'{OUT}/models/{name}.glb'
        g.save(path)
        out[kind] = {'glb': f'models/{name}.glb', 'layers': layers,
                     'note': 'particle-system prefab; *_mesh nodes are mesh particles (scaled by startSize), billboard layers are sprites'}
    for tn, t in local.items():
        p = f'{OUT}/tex/{slug(tn)}.webp'
        if not os.path.exists(p):
            save_webp(t.image, p, 'diffuse')
    out['glb'] = out['bonus']['glb']
    return out


if __name__ == '__main__':
    main()
