# Export sprite-set MonoBehaviours (ships/npcs/drones/pets) from shiptexture2d as baked
# sprite sheets. The sprites are tile-packed: each frame is a mesh of axis-aligned quads
# whose UVs point into scattered atlas tiles, so we reassemble every frame from its quads.
# Cells are centered on the sprite origin (pivot) so all frames share one anchor.
import sys, os, json, math, UnityPy
from PIL import Image
from UnityPy.helpers.MeshHelper import MeshHandler
src, out = sys.argv[1], sys.argv[2]
only = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else None
os.makedirs(out, exist_ok=True)
env = UnityPy.load(src)
objs = {o.path_id: o for o in env.objects}
textures = {}
def texture(path_id):
    if path_id not in textures:
        textures[path_id] = objs[path_id].read().image.convert('RGBA')
    return textures[path_id]
def frame_quads(so):
    s = so.read()
    mesh = MeshHandler(s.m_RD, so.version)
    mesh.process()
    ppu, tex = s.m_PixelsToUnits, texture(s.m_RD.texture.path_id)
    verts, uvs, quads = mesh.m_Vertices, mesh.m_UV0, []
    for q in range(0, len(verts) - 3, 4):
        px = [verts[q + k][0] * ppu for k in range(4)]; py = [verts[q + k][1] * ppu for k in range(4)]
        us = [uvs[q + k][0] for k in range(4)]; vs = [uvs[q + k][1] for k in range(4)]
        quads.append((tex, min(px), max(px), min(py), max(py), min(us), max(us), min(vs), max(vs)))
    return quads
index = {}
for o in env.objects:
    if o.type.name != 'MonoBehaviour':
        continue
    tt = o.read_typetree()
    name, sprites = tt.get('m_Name'), tt.get('sprites') or []
    if not name or not sprites or (only and name not in only):
        continue
    try:
        frames = [frame_quads(objs[r['m_PathID']]) for r in sprites if r['m_PathID'] in objs]
    except Exception as e:
        print('skip', name, e); continue
    frames = [f for f in frames if f]
    if not frames:
        continue
    hw = math.ceil(max(max(abs(q[1]), abs(q[2])) for f in frames for q in f))
    hh = math.ceil(max(max(abs(q[3]), abs(q[4])) for f in frames for q in f))
    cw, ch = hw * 2, hh * 2
    cols = min(8, len(frames)); rows = math.ceil(len(frames) / cols)
    sheet = Image.new('RGBA', (cw * cols, ch * rows))
    for n, f in enumerate(frames):
        ox, oy = (n % cols) * cw + hw, (n // cols) * ch + hh
        for tex, x0, x1, y0, y1, u0, u1, v0, v1 in f:
            W, H = tex.size
            tile = tex.crop((round(u0 * W), round((1 - v1) * H), round(u1 * W), round((1 - v0) * H)))
            size = (max(1, round(x1 - x0)), max(1, round(y1 - y0)))
            if tile.size != size:
                tile = tile.resize(size)
            sheet.alpha_composite(tile, (ox + round(x0), oy - round(y1)))
    sheet.save(os.path.join(out, name + '.png'))
    index[name] = {'frames': len(frames), 'cols': cols, 'cw': cw, 'ch': ch}
    textures.clear()
json.dump(index, open(os.path.join(out, 'index.json'), 'w'))
print('exported', len(index))
