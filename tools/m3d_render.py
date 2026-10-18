"""Tiny GLB preview renderer (painter's algorithm, flat shaded, diffuse sampled at face centroid).

  m3d_render.py out.png model_key [model_key ...]   (keys from manifest3d.json models; also 'portal', 'station:mmo')
Top-down view = camera above (+Y) looking down; image right = +X, image down = +Z (= game +y).
Next to each render the 2D sheet frame 16 (faces +x) is drawn for comparison.
"""
import os
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import json, struct, sys, os, math
import numpy as np
from PIL import Image, ImageDraw

A3 = REPO + '/client/public/assets3d'
A2 = REPO + '/client/public/assets'


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def load_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])
    binoff = 20 + jl + 8
    data = b[binoff:]

    def acc(i):
        a = j['accessors'][i]
        v = j['bufferViews'][a['bufferView']]
        dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a['componentType']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        return np.frombuffer(data, dt, a['count'] * n, v['byteOffset']).reshape(a['count'], n) if n > 1 else \
            np.frombuffer(data, dt, a['count'], v['byteOffset'])
    tris = []  # (world verts 3x3, uv 3x2 or None, material name)

    def walk(ni, M):
        nd = j['nodes'][ni]
        L = np.eye(4)
        L[:3, :3] = qmat(nd.get('rotation', [0, 0, 0, 1])) * np.array(nd.get('scale', [1, 1, 1]))[None, :]
        L[:3, 3] = nd.get('translation', [0, 0, 0])
        W = M @ L
        if 'mesh' in nd:
            for p in j['meshes'][nd['mesh']]['primitives']:
                P = acc(p['attributes']['POSITION'])
                P = (W[:3, :3] @ P.T).T + W[:3, 3]
                UV = acc(p['attributes']['TEXCOORD_0']) if 'TEXCOORD_0' in p['attributes'] else None
                I = acc(p['indices']).reshape(-1, 3)
                mat = j['materials'][p['material']]['name'] if 'material' in p else None
                tris.append((P[I], None if UV is None else UV[I], mat))
        for c in nd.get('children', []):
            walk(c, W)
    walk(0, np.eye(4))
    return tris


def render(glb, tex=None, view='top', size=320, span=None, mats_tex=None, rot=None):
    tris = load_glb(glb)
    if rot:  # euler XYZ radians applied to model root (three.js order 'XYZ': R = Rx*Ry*Rz)
        cx, cy, cz = [math.cos(a) for a in rot]
        sx_, sy_, sz_ = [math.sin(a) for a in rot]
        Rx = np.array([[1, 0, 0], [0, cx, -sx_], [0, sx_, cx]])
        Ry = np.array([[cy, 0, sy_], [0, 1, 0], [-sy_, 0, cy]])
        Rz = np.array([[cz, -sz_, 0], [sz_, cz, 0], [0, 0, 1]])
        R = Rx @ Ry @ Rz
        tris = [((R @ P.reshape(-1, 3).T).T.reshape(P.shape), UV, m) for P, UV, m in tris]
    allP = np.concatenate([t[0].reshape(-1, 3) for t in tris])
    if view == 'top':      # look down -Y: screen x = X, screen y = Z, depth = Y (higher drawn later)
        proj = lambda P: (P[..., 0], P[..., 2], P[..., 1])
        L = np.array([0.3, 1.0, -0.4])
    elif view == 'side':   # look from +Z toward -Z... screen x = X, screen y = -Y, depth = Z
        proj = lambda P: (P[..., 0], -P[..., 1], P[..., 2])
        L = np.array([0.3, 0.6, 1.0])
    else:                  # front: look from +X toward -X: screen x = -Z, screen y = -Y
        proj = lambda P: (-P[..., 2], -P[..., 1], P[..., 0])
        L = np.array([1.0, 0.6, 0.3])
    L = L / np.linalg.norm(L)
    sx, sy, _ = proj(allP)
    c = np.array([(sx.min() + sx.max()) / 2, (sy.min() + sy.max()) / 2])
    ext = span or max(sx.max() - sx.min(), sy.max() - sy.min()) * 1.1
    img = Image.new('RGB', (size, size), (20, 24, 32))
    d = ImageDraw.Draw(img)
    texcache = {}

    def tx(mat):
        p = (mats_tex or {}).get(mat) or tex
        if p and p not in texcache:
            texcache[p] = np.asarray(Image.open(p).convert('RGB')).astype(np.float32) if os.path.exists(p) else None
        return texcache.get(p)
    faces = []
    for P, UV, mat in tris:
        x, y, z = proj(P)
        n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        nl = np.linalg.norm(n, axis=1, keepdims=True)
        nl[nl == 0] = 1
        n = n / nl
        shade = np.clip(np.abs(n @ L), 0.15, 1.0)
        T = tx(mat)
        if T is not None and UV is not None:
            uv = UV.mean(1)
            h, w = T.shape[:2]
            cols = T[np.clip((uv[:, 1] % 1) * h, 0, h - 1).astype(int), np.clip((uv[:, 0] % 1) * w, 0, w - 1).astype(int)]
        else:
            cols = np.full((len(P), 3), 170.0)
        cols = cols * shade[:, None] * 1.1 + 15
        depth = z.mean(1)
        for i in range(len(P)):
            faces.append((depth[i], [((x[i, k] - c[0]) / ext * size + size / 2, (y[i, k] - c[1]) / ext * size + size / 2) for k in range(3)],
                          tuple(int(v) for v in np.clip(cols[i], 0, 255))))
    faces.sort(key=lambda f: f[0])
    for _, pts, col in faces:
        d.polygon(pts, fill=col)
    return img, ext


def sheet_frame(sheet, frame=16, size=320):
    man = json.load(open(f'{A2}/manifest.json'))['sheets'].get(sheet)
    if not man:
        return None
    im = Image.open(f'{A2}/{man["url"]}')
    f = frame * man['frames'] // 32
    cx, cy = f % man['cols'], f // man['cols']
    fr = im.crop((cx * man['cw'], cy * man['ch'], (cx + 1) * man['cw'], (cy + 1) * man['ch'])).convert('RGBA')
    bg = Image.new('RGBA', fr.size, (20, 24, 32, 255))
    bg.alpha_composite(fr)
    s = size / max(fr.size)
    return bg.convert('RGB').resize((int(fr.size[0] * s), int(fr.size[1] * s))), max(fr.size)


if __name__ == '__main__':
    out, keys = sys.argv[1], sys.argv[2:]
    views = os.environ.get('VIEWS', 'top').split(',')
    man = json.load(open(f'{A3}/manifest3d.json'))
    S = 256
    rows = []
    for k in keys:
        if k.startswith('station:'):
            m = man['stations'][k.split(':')[1]]
        elif k == 'portal':
            m = man['portal']
        else:
            m = man['models'][k]
        mt = {x['name']: f'{A3}/{x["tex"]["diffuse"]}' for x in m.get('materials', []) if x['tex'].get('diffuse')}
        if m.get('mainMaterial') and m['tex'].get('diffuse'):
            mt[m['mainMaterial']] = f'{A3}/{m["tex"]["diffuse"]}'
        tiles = []
        for v in views:
            im, ext = render(f'{A3}/{m["glb"]}', None, v, S, mats_tex=mt, rot=m.get('rot'))
            ImageDraw.Draw(im).text((4, 4), f'{k} {v} span={ext:.0f}', fill=(255, 255, 0))
            tiles.append(im)
        sf = sheet_frame(k, int(os.environ.get('FRAME', 16)), S)
        if sf:
            im2, fs = sf
            ImageDraw.Draw(im2).text((4, 4), f'2D f16 {fs}px', fill=(255, 255, 0))
            tiles.append(im2)
        rows.append(tiles)
    W = max(sum(t.size[0] for t in r) for r in rows)
    H = sum(max(t.size[1] for t in r) for r in rows)
    canvas = Image.new('RGB', (W, H), (0, 0, 0))
    y = 0
    for r in rows:
        x = 0
        for t in r:
            canvas.paste(t, (x, y))
            x += t.size[0]
        y += max(t.size[1] for t in r)
    canvas.save(out)
    print(out, canvas.size)
