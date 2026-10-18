"""Dump the sprite-name order of every sprite-set MonoBehaviour (as baked by export_shipsheets.py).
Sprite names are 1-based frame numbers but stored lexicographically ('1','10','11',...,'2',...),
so baked sheets need reordering. Output: {sheet: [names in stored order]}."""
import sys, json, UnityPy
src, out = sys.argv[1], sys.argv[2]
env = UnityPy.load(src); objs = {o.path_id: o for o in env.objects}
res = {}
for o in env.objects:
    if o.type.name != 'MonoBehaviour': continue
    tt = o.read_typetree(); name, sprites = tt.get('m_Name'), tt.get('sprites') or []
    if not name or not sprites: continue
    res[name] = [objs[r['m_PathID']].read().m_Name for r in sprites if r['m_PathID'] in objs]
json.dump(res, open(out, 'w'))
print(len(res))
