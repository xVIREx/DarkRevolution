# List root prefabs (GameObjects whose RectTransform/Transform has no father) with child counts.
import sys, UnityPy
env = UnityPy.load(sys.argv[1])
objs = {o.path_id: o for o in env.objects}
roots = []
for o in env.objects:
    if o.type.name in ('RectTransform', 'Transform'):
        t = o.read()
        if not t.m_Father or t.m_Father.path_id == 0:
            go = t.m_GameObject.read()
            def count(tr):
                return 1 + sum(count(c.read()) for c in tr.m_Children)
            roots.append((go.m_Name, count(t), o.path_id))
for n, c, p in sorted(roots): print(f'{c:6d} {p} {n}')
