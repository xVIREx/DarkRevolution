# Dump every Texture2D (and optionally Sprite) of a bundle to <out>/<kind>/<name>.png.
import sys, os, UnityPy
src, out = sys.argv[1], sys.argv[2]
kinds = sys.argv[3].split(',') if len(sys.argv) > 3 else ['Texture2D']
env = UnityPy.load(src)
n = 0
for o in env.objects:
    if o.type.name not in kinds:
        continue
    try:
        d = o.read()
        path = os.path.join(out, o.type.name, d.m_Name.replace('/', '_') + '.png')
        if os.path.exists(path):
            path = path[:-4] + f'_{o.path_id & 0xffff:04x}.png'
        os.makedirs(os.path.dirname(path), exist_ok=True)
        d.image.save(path); n += 1
    except Exception as e:
        print('skip', o.type.name, e)
print(src.split('/')[-1], n)
