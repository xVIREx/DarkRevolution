import sys, UnityPy, collections
env = UnityPy.load(sys.argv[1])
names = collections.defaultdict(list)
for o in env.objects:
    if o.type.name in ('Mesh','Material','Shader','Texture2D'):
        names[o.type.name].append(o.peek_name())
for k,v in names.items(): print(k, len(v), v[:25])
