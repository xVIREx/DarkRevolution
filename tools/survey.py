import sys, glob, os, collections, UnityPy
root = sys.argv[1]
for f in sorted(glob.glob(os.path.join(root, '**/*.bundle'), recursive=True)):
    try:
        env = UnityPy.load(f)
        c = collections.Counter(o.type.name for o in env.objects)
        print(f"{os.path.basename(f)[:45]:45} {os.path.getsize(f)//1048576:5}MB", dict(c.most_common(6)))
    except Exception as e:
        print(os.path.basename(f), "ERR", e)
