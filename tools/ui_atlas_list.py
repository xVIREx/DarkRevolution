# List SpriteAtlas contents: atlas name -> packed sprite names (json)
import sys, json, UnityPy
env = UnityPy.load(sys.argv[1])
out = {}
for o in env.objects:
    if o.type.name == 'SpriteAtlas':
        a = o.read()
        out[a.m_Name] = sorted(set(a.m_PackedSpriteNamesToIndex))
json.dump(out, open(sys.argv[2], 'w'), indent=0)
for k, v in sorted(out.items(), key=lambda kv: -len(kv[1])): print(k, len(v), v[:12])
