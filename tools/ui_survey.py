# Survey a Unity bundle: count object types and dump names per type to a text file.
import sys, collections, UnityPy
src, out = sys.argv[1], sys.argv[2]
env = UnityPy.load(src)
by = collections.defaultdict(list)
for o in env.objects:
    t = o.type.name
    try:
        if t in ('Sprite', 'Texture2D', 'GameObject', 'Font', 'SpriteAtlas', 'Material', 'TextAsset'):
            by[t].append(o.read().m_Name)
        else:
            by[t].append('')
    except Exception as e:
        by[t].append('ERR ' + str(e)[:40])
with open(out, 'w') as f:
    for t, names in sorted(by.items()):
        f.write(f'== {t} {len(names)}\n')
        for n in names:
            if n: f.write(f'  {n}\n')
print({t: len(n) for t, n in by.items()})
