"""Orientation check: top-down silhouette of each GLB vs 2D sheet frame 16 (faces +x).
For each model computes IoU for yaw 0/90/180/270 (+ mirrored) and reports the best; also size ratio (3D span / 2D sprite span).
  m3d_verify.py [--write-overrides]
"""
import os
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import json, sys, os
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from m3d_render import load_glb, A3, A2

N = 96


def mask_from_pts(polys, ext_c, ext):
    im = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(im)
    for p in polys:
        d.polygon([((x - ext_c[0]) / ext * N + N / 2, (y - ext_c[1]) / ext * N + N / 2) for x, y in p], fill=255)
    return np.asarray(im) > 0


def norm_mask(m):
    """crop to bbox, pad to square, resize to N"""
    ys, xs = np.nonzero(m)
    if not len(xs):
        return m, 0
    c = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    s = max(c.shape)
    sq = np.zeros((s, s), bool)
    sq[(s - c.shape[0]) // 2:(s - c.shape[0]) // 2 + c.shape[0], (s - c.shape[1]) // 2:(s - c.shape[1]) // 2 + c.shape[1]] = c
    return np.asarray(Image.fromarray(sq.astype(np.uint8) * 255).resize((N, N))) > 127, s


def sprite_mask(sheet):
    man = json.load(open(f'{A2}/manifest.json'))['sheets'].get(sheet)
    if not man:
        return None, None
    im = Image.open(f'{A2}/{man["url"]}').convert('RGBA')
    f = 16 * man['frames'] // 32
    cx, cy = f % man['cols'], f // man['cols']
    a = np.asarray(im.crop((cx * man['cw'], cy * man['ch'], (cx + 1) * man['cw'], (cy + 1) * man['ch'])))[..., 3] > 40
    m, s = norm_mask(a)
    ys, xs = np.nonzero(a)
    return m, (xs.max() - xs.min() + 1 if len(xs) else 0)


def check(args):
    key, glb = args
    sm, sw = sprite_mask(key)
    if sm is None:
        return key, None
    tris = load_glb(f'{A3}/{glb}')
    P = np.concatenate([t[0] for t in tris])  # (n,3,3)
    xz = P[..., [0, 2]]
    flat = xz.reshape(-1, 2)
    c = (flat.min(0) + flat.max(0)) / 2
    ext = (flat.max(0) - flat.min(0)).max() * 1.05
    big = Image.new('L', (256, 256), 0)
    d = ImageDraw.Draw(big)
    for t in xz:
        d.polygon([((x - c[0]) / ext * 256 + 128, (y - c[1]) / ext * 256 + 128) for x, y in t], fill=255)
    m3, _ = norm_mask(np.asarray(big) > 0)
    res = {}
    for mir in (False, True):
        b = m3[::-1] if mir else m3   # mirror across the x axis (left/right of the ship)
        for k in range(4):
            r = np.rot90(b, -k)        # -k: clockwise on screen = yaw by +k*90 deg in game angle convention
            res[(k * 90, mir)] = float((r & sm).sum() / max(1, (r | sm).sum()))
    best = max(res, key=res.get)
    span3 = float(flat[:, 0].max() - flat[:, 0].min())
    return key, {'all': {f'{a}{"m" if m else ""}': round(v, 3) for (a, m), v in res.items()}, 'best': best, 'iou': res[best], 'iou0': res[(0, False)], 'iou0m': res[(0, True)], 'span3d_x': span3,
                 'sprite_w': int(sw), 'ratio': span3 / sw if sw else None}


if __name__ == '__main__':
    man = json.load(open(f'{A3}/manifest3d.json'))
    jobs = [(k, m['glb']) for k, m in man['models'].items()]
    with Pool(8) as p:
        out = dict(p.map(check, jobs, chunksize=4))
    bad = {k: v for k, v in out.items() if v and v['best'] != (0, False)}
    ok = [v for v in out.values() if v and v['best'] == (0, False)]
    print('checked', sum(1 for v in out.values() if v), 'best=identity', len(ok), 'other', len(bad))
    for k, v in sorted(bad.items(), key=lambda kv: kv[1]['iou'] - kv[1]['iou0']):
        print(f"{k:40s} best={v['best']} iou={v['iou']:.2f} iou0={v['iou0']:.2f} mirror0={v['iou0m']:.2f}")
    rat = np.array([v['ratio'] for v in out.values() if v and v['ratio']])
    print('3D x-span / sprite width: median %.2f p10 %.2f p90 %.2f' % (np.median(rat), np.percentile(rat, 10), np.percentile(rat, 90)))
    json.dump({k: v and {**v, 'best': list(v['best'])} for k, v in out.items()},
              open(REPO + '/extracted/m3d/verify.json', 'w'), indent=1)


def mesh_node_scale(glb):
    import struct
    b = open(f'{A3}/{glb}', 'rb').read()
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])

    def walk(i, acc):
        n = j['nodes'][i]
        s = n.get('scale', [1, 1, 1])[0] * acc
        if 'mesh' in n:
            return s
        for c in n.get('children', []):
            r = walk(c, s)
            if r:
                return r
    return walk(0, 1.0) or 1.0


def write_overrides():
    """rot: drones are authored nose -Z (Unity) -> base yaw pi; any model whose silhouette clearly matches the 2D frame-16 sprite
    better at another 90deg step (mean IoU gain > 0.08 over all designs sharing the GLB) gets that yaw.
    scale: GLB bakes the prefab scale; for ships/NPCs the XML <mesh scale> is used instead of the prefab mesh-node scale when it
    brings the 3D/2D size ratio closer to the median of the models where both agree (Unity applies the XML scale)."""
    import collections, math
    man = json.load(open(f'{A3}/manifest3d.json'))['models']
    v = json.load(open(REPO + '/extracted/m3d/verify.json'))
    agg = collections.defaultdict(lambda: collections.defaultdict(list))
    for k, m in man.items():
        if v.get(k):
            for a, x in v[k]['all'].items():
                agg[m['glb']][a].append(x)
    rot = {}
    for g, d in agg.items():
        kind = next(m['kind'] for m in man.values() if m['glb'] == g)
        base = 180 if kind == 'drone' else 0
        cand = {a: float(np.mean(d[str(a)])) for a in (0, 90, 180, 270)}
        best = max(cand, key=cand.get)
        a = best if (best != base and cand[best] - cand[base] > 0.08) else base
        y = -a * math.pi / 180
        y = math.atan2(math.sin(y), math.cos(y))
        rot[g] = [0, round(y, 6), 0]
    nodesc = {g: mesh_node_scale(g) for g in {m['glb'] for m in man.values()}}
    med = {}
    for kind in ('ship', 'npc'):
        r = [v[k]['ratio'] for k, m in man.items() if m['kind'] == kind and v.get(k) and v[k]['ratio']
             and abs(m['xmlScale'] - nodesc[m['glb']]) < 1e-3]
        med[kind] = float(np.median(r))
    out = {}
    for k, m in man.items():
        o = {'rot': rot.get(m['glb'], [0, 0, 0]), 'scale': 1, 'scaleSource': 'prefab'}
        if m['kind'] in med and abs(m['xmlScale'] - nodesc[m['glb']]) > 1e-3 and v.get(k) and v[k]['ratio']:
            f = m['xmlScale'] / nodesc[m['glb']]
            r0 = v[k]['ratio']
            if abs(math.log(r0 * f / med[m['kind']])) < abs(math.log(r0 / med[m['kind']])):
                o.update(scale=round(f, 5), scaleSource='xml')
        out[k] = o
    json.dump(out, open(REPO + '/extracted/m3d/overrides.json', 'w'), indent=1)
    nz = {g: r for g, r in rot.items() if r[1] != 0}
    print('rot overrides', len(nz), 'scale from xml', sum(1 for o in out.values() if o['scaleSource'] == 'xml'), 'medians', med)
    for g, r in sorted(nz.items()):
        if 'drone' not in g or abs(abs(r[1]) - math.pi) > 1e-3:
            print('  ', g, r)


if '--write-overrides' in sys.argv:
    write_overrides()
