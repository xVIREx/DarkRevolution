import sys, os, UnityPy
env = UnityPy.load(sys.argv[1]); out = sys.argv[2]
for o in env.objects:
    if o.type.name == 'TextAsset':
        d = o.read()
        name = d.m_Name
        data = d.m_Script
        if isinstance(data, str): data = data.encode('utf-8', 'surrogateescape')
        open(os.path.join(out, name if '.' in name else name + '.txt'), 'wb').write(data)
