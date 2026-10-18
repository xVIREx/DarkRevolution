"""Resolve '@pathid:N' texture placeholders in manifest3d.maps.json from the 3dtexture bundle
(scene prop textures: <name>_{diffuse,normal,specular,glow,alpha}_<size>). Writes scene/tex/<name>.webp (<=1024)."""
import os, sys, json
import UnityPy
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.path.expanduser('~/darkorbit-client/extracted/DarkOrbit_Version0.1.4/DarkOrbit_Data/StreamingAssets/aa/BuildTarget/')
B3 = BT + '3dtexture_assets_all_3ca7252dec85d5460acc085f94136f0b.bundle'
OUT = os.path.join(ROOT, 'client/public/assets3d')
MAN = os.path.join(OUT, 'manifest3d.maps.json')

def walk(o, fn):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str) and v.startswith('@pathid:'): o[k] = fn(int(v[8:]))
            else: walk(v, fn)
    elif isinstance(o, list):
        for v in o: walk(v, fn)

def main():
    man = json.load(open(MAN))
    need = set()
    walk(man, lambda pid: (need.add(pid), f'@pathid:{pid}')[1])
    print('need', len(need))
    if not need: return
    env = UnityPy.load(B3)
    found = {}
    for o in env.objects:
        if o.path_id in need and o.type.name == 'Texture2D':
            t = o.read(); name = t.m_Name.replace(' ', '_')
            rel = f'scene/tex/{name}.webp'; path = os.path.join(OUT, rel)
            if not os.path.exists(path):
                im = t.image
                if max(im.size) > 1024: im = im.resize((1024, int(1024 * im.height / im.width)), Image.LANCZOS)
                im.convert('RGBA').save(path, 'WEBP', quality=88, method=5)
            found[o.path_id] = rel
            print(' ', name, t.m_Width)
    walk(man, lambda pid: found.get(pid, f'@pathid:{pid}'))
    json.dump(man, open(MAN, 'w'), indent=1)
    print('resolved', len(found), 'of', len(need))

if __name__ == '__main__':
    main()
