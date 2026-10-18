import sys, UnityPy, collections
for p in sys.argv[1:]:
    env = UnityPy.load(p)
    c = collections.Counter(o.type.name for o in env.objects)
    print(p.split('/')[-1], dict(c))
    names = collections.defaultdict(list)
    for o in env.objects:
        if o.type.name in ('Mesh','Material','Texture2D','GameObject','Shader'):
            try: names[o.type.name].append(o.peek_name())
            except Exception: pass
    for k,v in names.items(): print(' ',k, len(v), sorted(set(v))[:80])
    print(' containers', list(env.container.keys())[:60])
