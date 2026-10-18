# Export Sprites from a bundle as PNGs: <out>/<atlas-or-'ui'>/<name>.png plus index.json
# {pathId: {name, atlas, w, h, border:[l,b,r,t], file}}. Optional atlas filter (comma list).
import sys, os, json, UnityPy
src, out = sys.argv[1], sys.argv[2]
only = set(sys.argv[3].split(',')) if len(sys.argv) > 3 and sys.argv[3] else None
env = UnityPy.load(src)
objs = {o.path_id: o for o in env.objects}
atlas_of = {}
for o in env.objects:
    if o.type.name == 'SpriteAtlas':
        a = o.read()
        for p in a.m_PackedSprites:
            atlas_of[p.path_id] = a.m_Name
index = {}
os.makedirs(out, exist_ok=True)
seen = {}
for o in env.objects:
    if o.type.name != 'Sprite': continue
    at = atlas_of.get(o.path_id, 'ui')
    if only and at not in only: continue
    try:
        s = o.read()
        img = s.image
    except Exception as e:
        print('fail', o.path_id, e); continue
    name = s.m_Name
    d = os.path.join(out, at); os.makedirs(d, exist_ok=True)
    fn = name.replace('/', '_')
    k = (at, fn)
    if k in seen:
        seen[k] += 1; fn = f'{fn}__{seen[k]}'
    else: seen[k] = 0
    img.save(os.path.join(d, fn + '.png'))
    b = s.m_Border
    index[str(o.path_id)] = {'name': name, 'atlas': at, 'w': img.width, 'h': img.height,
                             'border': [round(b.x), round(b.y), round(b.z), round(b.w)], 'file': f'{at}/{fn}.png'}
json.dump(index, open(os.path.join(out, 'index.json'), 'w'), indent=0)
print('exported', len(index))
